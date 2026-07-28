import debounce from 'lodash.debounce';

import {
    AcousticAnalysis,
    AnalysisOptions,
    PitchAlgorithm,
} from './analysis';
import { AURORA_GRADIENT } from './color-util';
import initialiseControlsUi from './controls-ui';
import {
    CursorSnapshot,
    LayerDisplayOptions,
    LiveSnapshot,
    SpectrogramMode,
    UiController,
} from './controls-ui/App';
import { Circular2DBuffer, clamp, hzToMel, melToHz } from './math-util';
import {
    RenderParameters,
    SpectrogramGPURenderer,
} from './spectrogram-render';
import { offThreadGenerateSpectrogram } from './worker-util';

const AUDIO_CHUNK_SIZE = 1024;
const SPECTROGRAM_HEIGHT = 512;
const HISTORY_SECONDS = 8;
const PITCH_FLOOR_HZ = 75;
const PITCH_CEILING_HZ = 500;
const INTENSITY_FLOOR_DB_SPL = 50;
const INTENSITY_CEILING_DB_SPL = 100;

interface ModeConfiguration {
    windowSize: number;
    fftSize: number;
    hopSize: number;
    historyCapacity: number;
}

interface AnalysisPoint extends AcousticAnalysis {
    timeSeconds: number;
}

interface ProcessRequest {
    samples: Float32Array;
    sampleRate: number;
    newSamples: number;
    endTimeSeconds: number;
}

interface SessionStatistics {
    totalFrames: number;
    voicedFrames: number;
    pitchSum: number;
    pitchMin: number;
    pitchMax: number;
    intensityPowerSum: number;
}

function nextPowerOfTwo(value: number) {
    return 2 ** Math.ceil(Math.log2(value));
}

function modeConfiguration(
    mode: SpectrogramMode,
    sampleRate: number
): ModeConfiguration {
    const durationSeconds = mode === 'broadband' ? 0.005 : 0.03;
    const windowSize = Math.max(32, Math.round(sampleRate * durationSeconds));
    const hopSize = mode === 'broadband' ? 128 : 256;
    return {
        windowSize,
        fftSize: nextPowerOfTwo(windowSize),
        hopSize,
        historyCapacity: Math.ceil((HISTORY_SECONDS * sampleRate) / hopSize),
    };
}

function emptyStatistics(): SessionStatistics {
    return {
        totalFrames: 0,
        voicedFrames: 0,
        pitchSum: 0,
        pitchMin: Number.POSITIVE_INFINITY,
        pitchMax: Number.NEGATIVE_INFINITY,
        intensityPowerSum: 0,
    };
}

class SpectroEngine {
    private readonly ui: UiController;

    private readonly canvas: HTMLCanvasElement;

    private readonly overlay: HTMLCanvasElement;

    private readonly stage: HTMLElement;

    private renderer: SpectrogramGPURenderer;

    private spectrogramBuffer: Circular2DBuffer<Float32Array>;

    private analysisHistory: AnalysisPoint[] = [];

    private mode: SpectrogramMode = 'broadband';

    private pitchAlgorithm: PitchAlgorithm = 'yin';

    private sampleRate = 48000;

    private renderParameters: Partial<RenderParameters> = {
        sensitivity: 10 ** (0.54 * 3) - 1,
        contrast: 10 ** (0.56 * 5) - 1,
        zoom: 1,
        timeOffset: 0,
        minFrequencyHz: 0,
        maxFrequencyHz: 5500,
        scale: 'linear',
        gradient: AURORA_GRADIENT,
    };

    private analysisOptions: AnalysisOptions = {
        pitchAlgorithm: 'yin',
        minPitchHz: 75,
        maxPitchHz: 500,
        voicingThreshold: 0.6,
        formantCeilingHz: 5500,
        maximumFormants: 5,
        formantWindowLengthSeconds: 0.025,
        preEmphasisFromHz: 50,
        intensityPitchFloorHz: 75,
        splCalibrationDb: 0,
    };

    private layerDisplayOptions: LayerDisplayOptions = {
        pitchFloorHz: PITCH_FLOOR_HZ,
        pitchCeilingHz: PITCH_CEILING_HZ,
        pitchLineWidth: 2.5,
        formantsToDisplay: 5,
        formantDynamicRangeDb: 30,
        formantDotSize: 2.4,
        intensityFloorDbSpl: INTENSITY_FLOOR_DB_SPL,
        intensityCeilingDbSpl: INTENSITY_CEILING_DB_SPL,
        intensityLineWidth: 2.5,
    };

    private showPitch = true;

    private showFormants = true;

    private showIntensity = true;

    private timeOffset = 0;

    private overlayDirty = true;

    private processing = false;

    private pendingRequest: ProcessRequest | null = null;

    private stopActiveSource: (() => void) | null = null;

    private statistics: SessionStatistics = emptyStatistics();

    private sessionElapsedSeconds = 0;

    private lastUiUpdate = 0;

    private inspector: { x: number; y: number } | null = null;

    private maximumSessionIntensityDbSpl = Number.NEGATIVE_INFINITY;

    constructor(ui: UiController) {
        const canvas = document.querySelector('#spectrogramCanvas');
        const overlay = document.querySelector('#analysisOverlay');
        const stage = document.querySelector('#spectrogramStage');
        if (
            !(canvas instanceof HTMLCanvasElement) ||
            !(overlay instanceof HTMLCanvasElement) ||
            !(stage instanceof HTMLElement)
        ) {
            throw new Error('Unable to initialise the Spectro Pro display');
        }
        this.ui = ui;
        this.canvas = canvas;
        this.overlay = overlay;
        this.stage = stage;

        const config = modeConfiguration(this.mode, this.sampleRate);
        this.spectrogramBuffer = new Circular2DBuffer(
            Float32Array,
            config.historyCapacity,
            SPECTROGRAM_HEIGHT,
            1
        );
        this.renderer = new SpectrogramGPURenderer(
            this.canvas,
            this.spectrogramBuffer.width,
            this.spectrogramBuffer.height
        );
        this.renderer.updateParameters({
            ...this.renderParameters,
            sampleRate: this.sampleRate,
            windowSize: config.fftSize,
        });

        this.resize();
        const resize = debounce(() => this.resize(), 150);
        window.addEventListener('resize', resize);
        requestAnimationFrame(() => this.renderLoop());
    }

    updateDisplay(parameters: Partial<RenderParameters>) {
        this.renderParameters = { ...this.renderParameters, ...parameters };
        if (parameters.timeOffset !== undefined) {
            this.timeOffset = parameters.timeOffset;
        }
        this.renderer.updateParameters(parameters);
        this.overlayDirty = true;
    }

    setMode(mode: SpectrogramMode) {
        this.mode = mode;
        const config = modeConfiguration(mode, this.sampleRate);
        this.spectrogramBuffer.resizeWidth(config.historyCapacity);
        this.renderer.updateParameters({
            sampleRate: this.sampleRate,
            windowSize: config.fftSize,
            maxFrequencyHz: mode === 'broadband' ? 5500 : 1200,
            scale: 'linear',
            timeOffset: 0,
        });
        this.timeOffset = 0;
        this.clearVisualHistory();
    }

    setPitchAlgorithm(algorithm: PitchAlgorithm) {
        this.pitchAlgorithm = algorithm;
        this.analysisOptions = {
            ...this.analysisOptions,
            pitchAlgorithm: algorithm,
        };
    }

    updateAnalysis(parameters: Partial<AnalysisOptions>) {
        this.analysisOptions = { ...this.analysisOptions, ...parameters };
        if (parameters.pitchAlgorithm !== undefined) {
            this.pitchAlgorithm = parameters.pitchAlgorithm;
        }
    }

    updateLayerDisplay(parameters: Partial<LayerDisplayOptions>) {
        this.layerDisplayOptions = {
            ...this.layerDisplayOptions,
            ...parameters,
        };
        this.overlayDirty = true;
    }

    setOverlays(pitch: boolean, formants: boolean, intensity: boolean) {
        this.showPitch = pitch;
        this.showFormants = formants;
        this.showIntensity = intensity;
        this.overlayDirty = true;
    }

    async startMicrophone() {
        this.stop();
        this.resetSession();
        this.ui.setPlayState('loading-mic', '麦克风', '正在请求麦克风权限…');

        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false,
                },
                video: false,
            });
            const audioCtx = this.createAudioContext();
            const source = audioCtx.createMediaStreamSource(stream);
            const processor = audioCtx.createScriptProcessor(
                AUDIO_CHUNK_SIZE,
                Math.min(2, source.channelCount || 1),
                1
            );
            this.setSampleRate(audioCtx.sampleRate);

            const rollingCapacity = Math.ceil(audioCtx.sampleRate * 0.18);
            const rolling = new Float32Array(rollingCapacity);
            let rollingLength = 0;
            let receivedSamples = 0;

            processor.addEventListener('audioprocess', (event) => {
                const input = event.inputBuffer;
                const chunk = new Float32Array(input.length);
                for (let channel = 0; channel < input.numberOfChannels; channel += 1) {
                    const channelData = input.getChannelData(channel);
                    for (let i = 0; i < chunk.length; i += 1) {
                        chunk[i] += channelData[i] / input.numberOfChannels;
                    }
                }

                if (rollingLength + chunk.length > rolling.length) {
                    const discard = rollingLength + chunk.length - rolling.length;
                    rolling.copyWithin(0, discard, rollingLength);
                    rollingLength -= discard;
                }
                rolling.set(chunk, rollingLength);
                rollingLength += chunk.length;
                receivedSamples += chunk.length;
                this.sessionElapsedSeconds = receivedSamples / audioCtx.sampleRate;

                if (rollingLength >= Math.round(audioCtx.sampleRate * 0.085)) {
                    this.queueProcessing({
                        samples: new Float32Array(rolling.subarray(0, rollingLength)),
                        sampleRate: audioCtx.sampleRate,
                        newSamples: chunk.length,
                        endTimeSeconds: this.sessionElapsedSeconds,
                    });
                }
            });

            source.connect(processor);
            processor.connect(audioCtx.destination);
            audioCtx.resume();

            this.stopActiveSource = () => {
                processor.disconnect();
                source.disconnect();
                stream.getTracks().forEach((track) => track.stop());
            };
            this.ui.setPlayState('playing', '麦克风', '实时分析中');
        } catch (error) {
            this.ui.setPlayState(
                'stopped',
                '麦克风不可用',
                error instanceof Error ? error.message : '无法打开麦克风'
            );
        }
    }

    async startFile(arrayBuffer: ArrayBuffer, name: string) {
        this.stop();
        this.resetSession();
        this.ui.setPlayState('loading-file', name, '正在解码音频…');

        try {
            const audioCtx = this.createAudioContext();
            const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
            this.setSampleRate(audioBuffer.sampleRate);
            const mono = new Float32Array(audioBuffer.length);
            for (let channel = 0; channel < audioBuffer.numberOfChannels; channel += 1) {
                const channelData = audioBuffer.getChannelData(channel);
                for (let i = 0; i < mono.length; i += 1) {
                    mono[i] += channelData[i] / audioBuffer.numberOfChannels;
                }
            }

            const source = audioCtx.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(audioCtx.destination);
            const startedAt = audioCtx.currentTime;
            let lastProcessedSample = 0;
            let stopped = false;

            const tick = () => {
                if (stopped) {
                    return;
                }
                const currentSample = Math.min(
                    mono.length,
                    Math.floor((audioCtx.currentTime - startedAt) * audioBuffer.sampleRate)
                );
                const available = currentSample - lastProcessedSample;
                if (
                    available >= AUDIO_CHUNK_SIZE &&
                    currentSample >= Math.round(audioBuffer.sampleRate * 0.085)
                ) {
                    const processEnd =
                        lastProcessedSample +
                        Math.floor(available / AUDIO_CHUNK_SIZE) * AUDIO_CHUNK_SIZE;
                    const start = Math.max(
                        0,
                        processEnd - Math.ceil(audioBuffer.sampleRate * 0.18)
                    );
                    this.sessionElapsedSeconds = processEnd / audioBuffer.sampleRate;
                    this.queueProcessing({
                        samples: new Float32Array(mono.subarray(start, processEnd)),
                        sampleRate: audioBuffer.sampleRate,
                        newSamples: processEnd - lastProcessedSample,
                        endTimeSeconds: this.sessionElapsedSeconds,
                    });
                    lastProcessedSample = processEnd;
                }
            };

            const timer = window.setInterval(tick, 16);
            source.addEventListener('ended', () => {
                tick();
                window.clearInterval(timer);
                if (!stopped) {
                    this.ui.setPlayState('stopped', name, '播放与分析完成');
                    this.stopActiveSource = null;
                }
            });
            this.stopActiveSource = () => {
                stopped = true;
                window.clearInterval(timer);
                try {
                    source.stop();
                } catch {
                    // The source may already have ended.
                }
                source.disconnect();
            };
            source.start();
            audioCtx.resume();
            this.ui.setPlayState('playing', name, '播放并实时分析中');
        } catch (error) {
            this.ui.setPlayState(
                'stopped',
                name,
                error instanceof Error ? error.message : '无法读取此音频'
            );
        }
    }

    stop() {
        if (this.stopActiveSource !== null) {
            const stop = this.stopActiveSource;
            this.stopActiveSource = null;
            stop();
        }
        this.pendingRequest = null;
    }

    clear() {
        this.resetSession();
    }

    navigate(amount: number) {
        const nextOffset = clamp(this.timeOffset + amount, 0, 0.9);
        this.timeOffset = nextOffset;
        this.renderer.updateParameters({ timeOffset: nextOffset });
        this.ui.updateTimeOffset(nextOffset);
        this.overlayDirty = true;
    }

    inspect(x: number, y: number) {
        if (x < 0 || y < 0) {
            this.inspector = null;
            this.ui.updateCursor(null);
            this.overlayDirty = true;
            return;
        }
        this.inspector = { x, y };
        const visible = this.visibleHistoryRange();
        const index = clamp(
            Math.floor(visible.start + x * (visible.end - visible.start)),
            0,
            Math.max(0, this.analysisHistory.length - 1)
        );
        const point = this.analysisHistory[index];
        if (!point) {
            this.ui.updateCursor(null);
            return;
        }
        const minFrequency = this.renderParameters.minFrequencyHz || 0;
        const maxFrequency = this.renderParameters.maxFrequencyHz || 5500;
        const frequency =
            this.renderParameters.scale === 'mel'
                ? melToHz(
                      hzToMel(minFrequency) +
                          (1 - y) *
                              (hzToMel(maxFrequency) - hzToMel(minFrequency))
                  )
                : minFrequency + (1 - y) * (maxFrequency - minFrequency);
        const snapshot: CursorSnapshot = {
            x,
            y,
            timeSeconds: point.timeSeconds,
            frequencyHz: frequency,
            pitchHz: point.pitchHz,
            intensityDbSpl: point.intensityDbSpl,
            formantsHz: point.formantsHz,
        };
        this.ui.updateCursor(snapshot);
        this.overlayDirty = true;
    }

    exportImage() {
        this.renderer.render();
        this.drawOverlay();
        const width = this.canvas.width;
        const height = this.canvas.height;
        const exportCanvas = document.createElement('canvas');
        exportCanvas.width = width;
        exportCanvas.height = height;
        const ctx = exportCanvas.getContext('2d');
        if (!ctx) {
            return;
        }
        ctx.drawImage(this.canvas, 0, 0);
        ctx.drawImage(this.overlay, 0, 0);
        ctx.fillStyle = 'rgba(4, 7, 18, 0.72)';
        ctx.fillRect(18, 18, 250, 48);
        ctx.fillStyle = '#ffffff';
        ctx.font = '600 22px Arial, sans-serif';
        ctx.fillText('SPECTRO PRO', 32, 49);
        ctx.fillStyle = '#9aa7bc';
        ctx.font = '12px Arial, sans-serif';
        ctx.fillText(
            this.mode === 'broadband' ? '宽带 · 5 ms' : '窄带 · 30 ms',
            176,
            48
        );
        exportCanvas.toBlob((blob) => {
            if (!blob) {
                return;
            }
            const link = document.createElement('a');
            link.download = `spectro-pro-${new Date()
                .toISOString()
                .replace(/[:.]/g, '-')}.png`;
            link.href = URL.createObjectURL(blob);
            link.click();
            URL.revokeObjectURL(link.href);
        }, 'image/png');
    }

    private createAudioContext() {
        return new (window.AudioContext || window.webkitAudioContext)();
    }

    private setSampleRate(sampleRate: number) {
        if (this.sampleRate === sampleRate) {
            return;
        }
        this.sampleRate = sampleRate;
        const config = modeConfiguration(this.mode, sampleRate);
        this.spectrogramBuffer.resizeWidth(config.historyCapacity);
        this.renderer.updateParameters({
            sampleRate,
            windowSize: config.fftSize,
        });
        this.clearVisualHistory();
    }

    private queueProcessing(request: ProcessRequest) {
        if (this.processing) {
            this.pendingRequest = request;
            return;
        }
        this.processRequest(request);
    }

    private async processRequest(request: ProcessRequest) {
        this.processing = true;
        try {
            const config = modeConfiguration(this.mode, request.sampleRate);
            const maximumFrames = Math.floor(request.newSamples / config.hopSize);
            const availableFrames =
                Math.floor(
                    (request.samples.length - config.windowSize) / config.hopSize
                ) + 1;
            const frameCount = Math.max(1, Math.min(maximumFrames, availableFrames));
            const samplesLength =
                config.windowSize + (frameCount - 1) * config.hopSize;
            const samplesStart = request.samples.length - samplesLength;
            const analysisLength = Math.min(
                request.samples.length,
                Math.round(request.sampleRate * 0.085)
            );
            const result = await offThreadGenerateSpectrogram(
                request.samples,
                samplesStart,
                samplesLength,
                {
                    windowSize: config.windowSize,
                    fftSize: config.fftSize,
                    windowStepSize: config.hopSize,
                    sampleRate: request.sampleRate,
                    scaleSize: SPECTROGRAM_HEIGHT,
                },
                request.samples.length - analysisLength,
                analysisLength,
                this.analysisOptions
            );

            this.renderer.updateParameters({
                sampleRate: request.sampleRate,
                windowSize: config.fftSize,
            });
            this.spectrogramBuffer.enqueue(result.spectrogram);
            this.renderer.updateSpectrogram(this.spectrogramBuffer);
            this.pushAnalysis(
                result.analysis,
                result.windowCount,
                request.endTimeSeconds,
                config.hopSize,
                request.sampleRate
            );
        } catch (error) {
            // Keep the live stream running if a single analysis frame fails.
            console.warn('Unable to analyse audio frame', error);
        } finally {
            this.processing = false;
            const next = this.pendingRequest;
            this.pendingRequest = null;
            if (next !== null) {
                this.processRequest(next);
            }
        }
    }

    private pushAnalysis(
        analysis: AcousticAnalysis,
        count: number,
        endTime: number,
        hopSize: number,
        sampleRate: number
    ) {
        for (let i = count - 1; i >= 0; i -= 1) {
            this.analysisHistory.push({
                ...analysis,
                timeSeconds: endTime - (i * hopSize) / sampleRate,
            });
        }
        if (this.analysisHistory.length > this.spectrogramBuffer.width) {
            this.analysisHistory.splice(
                0,
                this.analysisHistory.length - this.spectrogramBuffer.width
            );
        }

        this.statistics.totalFrames += 1;
        this.maximumSessionIntensityDbSpl = Math.max(
            this.maximumSessionIntensityDbSpl,
            analysis.intensityDbSpl
        );
        this.statistics.intensityPowerSum += 10 ** (analysis.intensityDbSpl / 10);
        if (analysis.pitchHz !== null) {
            this.statistics.voicedFrames += 1;
            this.statistics.pitchSum += analysis.pitchHz;
            this.statistics.pitchMin = Math.min(
                this.statistics.pitchMin,
                analysis.pitchHz
            );
            this.statistics.pitchMax = Math.max(
                this.statistics.pitchMax,
                analysis.pitchHz
            );
        }
        this.overlayDirty = true;
        this.updateUiSnapshot(analysis);
    }

    private updateUiSnapshot(analysis: AcousticAnalysis) {
        const now = performance.now();
        if (now - this.lastUiUpdate < 90) {
            return;
        }
        this.lastUiUpdate = now;
        const voiced = this.statistics.voicedFrames;
        const total = this.statistics.totalFrames;
        const snapshot: LiveSnapshot = {
            elapsedSeconds: this.sessionElapsedSeconds,
            pitchHz: analysis.pitchHz,
            intensityDbSpl: analysis.intensityDbSpl,
            formantsHz: analysis.formantsHz,
            meanPitchHz: voiced ? this.statistics.pitchSum / voiced : null,
            minPitchHz: voiced ? this.statistics.pitchMin : null,
            maxPitchHz: voiced ? this.statistics.pitchMax : null,
            meanIntensityDbSpl: total
                ? 10 * Math.log10(this.statistics.intensityPowerSum / total)
                : null,
            voicedPercent: total ? (100 * voiced) / total : 0,
            sampleRate: this.sampleRate,
        };
        this.ui.updateSnapshot(snapshot);
    }

    private resetSession() {
        this.statistics = emptyStatistics();
        this.sessionElapsedSeconds = 0;
        this.lastUiUpdate = 0;
        this.maximumSessionIntensityDbSpl = Number.NEGATIVE_INFINITY;
        this.clearVisualHistory();
        this.ui.updateSnapshot({
            elapsedSeconds: 0,
            pitchHz: null,
            intensityDbSpl: 0,
            formantsHz: [null, null, null, null, null],
            meanPitchHz: null,
            minPitchHz: null,
            maxPitchHz: null,
            meanIntensityDbSpl: null,
            voicedPercent: 0,
            sampleRate: this.sampleRate,
        });
    }

    private clearVisualHistory() {
        this.analysisHistory = [];
        this.spectrogramBuffer.clear();
        this.renderer.updateSpectrogram(this.spectrogramBuffer, true);
        this.timeOffset = 0;
        this.renderer.updateParameters({ timeOffset: 0 });
        this.ui.updateTimeOffset(0);
        this.overlayDirty = true;
    }

    private resize() {
        const width = Math.max(1, this.stage.clientWidth);
        const height = Math.max(1, this.stage.clientHeight);
        const pixelRatio = Math.min(2, window.devicePixelRatio || 1);
        this.renderer.resizeCanvas(
            Math.round(width * pixelRatio),
            Math.round(height * pixelRatio)
        );
        this.overlay.width = Math.round(width * pixelRatio);
        this.overlay.height = Math.round(height * pixelRatio);
        this.overlay.style.width = `${width}px`;
        this.overlay.style.height = `${height}px`;
        this.renderer.updateSpectrogram(this.spectrogramBuffer, true);
        this.overlayDirty = true;
    }

    private renderLoop() {
        this.renderer.render();
        if (this.overlayDirty) {
            this.drawOverlay();
            this.overlayDirty = false;
        }
        requestAnimationFrame(() => this.renderLoop());
    }

    private visibleHistoryRange() {
        const zoom = Math.max(1, this.renderParameters.zoom || 1);
        const span = Math.max(2, Math.floor(this.spectrogramBuffer.width / zoom));
        const offset = Math.floor(this.timeOffset * this.spectrogramBuffer.width);
        const end = Math.max(0, this.analysisHistory.length - offset);
        return {
            start: Math.max(0, end - span),
            end,
            span,
        };
    }

    private drawOverlay() {
        const ctx = this.overlay.getContext('2d');
        if (!ctx) {
            return;
        }
        const width = this.overlay.width;
        const height = this.overlay.height;
        ctx.clearRect(0, 0, width, height);
        const visible = this.visibleHistoryRange();
        if (visible.end <= visible.start) {
            return;
        }

        const xForIndex = (index: number) =>
            width - ((visible.end - index - 0.5) / visible.span) * width;
        const frequencyY = (frequency: number) => {
            const min = this.renderParameters.minFrequencyHz || 0;
            const max = this.renderParameters.maxFrequencyHz || 5500;
            if (this.renderParameters.scale === 'mel') {
                return (
                    height *
                    (1 -
                        (hzToMel(frequency) - hzToMel(min)) /
                            Math.max(1e-9, hzToMel(max) - hzToMel(min)))
                );
            }
            return height * (1 - (frequency - min) / Math.max(1, max - min));
        };

        if (this.showFormants && this.mode === 'broadband') {
            const colors = [
                '#ff4f72',
                '#ff755e',
                '#ff9e61',
                '#ffc86b',
                '#ffe39a',
                '#fff0c7',
            ];
            const formantCount = Math.min(
                this.layerDisplayOptions.formantsToDisplay,
                this.analysisHistory[visible.end - 1]?.formantsHz.length || 0
            );
            for (
                let formantIndex = 0;
                formantIndex < formantCount;
                formantIndex += 1
            ) {
                ctx.fillStyle = colors[formantIndex % colors.length];
                for (let index = visible.start; index < visible.end; index += 2) {
                    const formant = this.analysisHistory[index].formantsHz[
                        formantIndex
                    ];
                    const withinDynamicRange =
                        this.analysisHistory[index].intensityDbSpl >=
                        this.maximumSessionIntensityDbSpl -
                            this.layerDisplayOptions.formantDynamicRangeDb;
                    if (formant !== null && withinDynamicRange) {
                        const y = frequencyY(formant);
                        if (y >= 0 && y <= height) {
                            ctx.beginPath();
                            ctx.arc(
                                xForIndex(index),
                                y,
                                this.layerDisplayOptions.formantDotSize,
                                0,
                                Math.PI * 2
                            );
                            ctx.fill();
                        }
                    }
                }
            }
        }

        if (this.showPitch) {
            this.strokeSeries(
                ctx,
                visible.start,
                visible.end,
                xForIndex,
                (point) => point.pitchHz,
                (pitch) =>
                    this.mode === 'narrowband'
                        ? frequencyY(pitch)
                        : height *
                          (1 -
                              (pitch -
                                  this.layerDisplayOptions.pitchFloorHz) /
                                  (this.layerDisplayOptions.pitchCeilingHz -
                                      this.layerDisplayOptions.pitchFloorHz)),
                '#2588ff',
                this.layerDisplayOptions.pitchLineWidth
            );
        }

        if (this.showIntensity && this.mode === 'broadband') {
            this.strokeSeries(
                ctx,
                visible.start,
                visible.end,
                xForIndex,
                (point) => point.intensityDbSpl,
                (intensity) =>
                    height *
                    (1 -
                        (intensity -
                            this.layerDisplayOptions.intensityFloorDbSpl) /
                            (this.layerDisplayOptions.intensityCeilingDbSpl -
                                this.layerDisplayOptions.intensityFloorDbSpl)),
                '#f4df22',
                this.layerDisplayOptions.intensityLineWidth
            );
        }

        if (this.inspector !== null) {
            ctx.save();
            ctx.strokeStyle = 'rgba(255, 77, 98, 0.9)';
            ctx.lineWidth = 1;
            ctx.setLineDash([5, 5]);
            ctx.beginPath();
            ctx.moveTo(this.inspector.x * width, 0);
            ctx.lineTo(this.inspector.x * width, height);
            ctx.moveTo(0, this.inspector.y * height);
            ctx.lineTo(width, this.inspector.y * height);
            ctx.stroke();
            ctx.restore();
        }
    }

    private strokeSeries(
        ctx: CanvasRenderingContext2D,
        start: number,
        end: number,
        xForIndex: (index: number) => number,
        valueForPoint: (point: AnalysisPoint) => number | null,
        yForValue: (value: number) => number,
        color: string,
        lineWidth: number
    ) {
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = lineWidth;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.shadowColor = color;
        ctx.shadowBlur = 4;
        let drawing = false;
        ctx.beginPath();
        for (let index = start; index < end; index += 1) {
            const value = valueForPoint(this.analysisHistory[index]);
            if (value === null) {
                drawing = false;
                continue;
            }
            const x = xForIndex(index);
            const y = yForValue(value);
            if (y < 0 || y > this.overlay.height) {
                drawing = false;
                continue;
            }
            if (drawing) {
                ctx.lineTo(x, y);
            } else {
                ctx.moveTo(x, y);
                drawing = true;
            }
        }
        ctx.stroke();
        ctx.restore();
    }
}

const appContainer = document.querySelector('#app');
if (appContainer === null) {
    throw new Error('Missing Spectro Pro application container');
}

let engine: SpectroEngine | null = null;
const ui = initialiseControlsUi(appContainer, {
    onStartMicrophone: () => engine?.startMicrophone(),
    onStartFile: (buffer, name) => engine?.startFile(buffer, name),
    onStop: () => engine?.stop(),
    onClear: () => engine?.clear(),
    onExport: () => engine?.exportImage(),
    onModeChange: (mode) => engine?.setMode(mode),
    onPitchAlgorithmChange: (algorithm) =>
        engine?.setPitchAlgorithm(algorithm),
    onAnalysisChange: (parameters) => engine?.updateAnalysis(parameters),
    onLayerDisplayChange: (parameters) =>
        engine?.updateLayerDisplay(parameters),
    onDisplayChange: (parameters) => engine?.updateDisplay(parameters),
    onOverlayChange: (pitch, formants, intensity) =>
        engine?.setOverlays(pitch, formants, intensity),
    onInspect: (x, y) => engine?.inspect(x, y),
    onNavigate: (amount) => engine?.navigate(amount),
});
engine = new SpectroEngine(ui);
