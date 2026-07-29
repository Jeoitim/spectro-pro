import debounce from 'lodash.debounce';

import {
    AcousticAnalysis,
    analysisCadenceForPrecision,
    AnalysisOptions,
    PitchAlgorithm,
    RealtimeAnalysisPrecision,
} from './analysis';
import { AURORA_GRADIENT } from './color-util';
import initialiseControlsUi from './controls-ui';
import {
    CursorSnapshot,
    LayerDisplayOptions,
    LiveSnapshot,
    MediaListItem,
    PerformanceSettings,
    SelectionSnapshot,
    SpectrogramAnalysisSettings,
    SpectrogramMode,
    TransportSnapshot,
    UiController,
} from './controls-ui/App';
import { t } from './i18n';
import { Circular2DBuffer, clamp, frequencyToScale, scaleToFrequency } from './math-util';
import { getPlotSelectionTheme } from './plot-theme';
import { SpectrogramWindowFunction } from './spectrogram';
import { RenderParameters, SpectrogramGPURenderer } from './spectrogram-render';
import {
    offThreadAnalyzeAcoustics,
    offThreadAnalyzeEntireFile,
    offThreadGenerateSpectrogram,
} from './worker-util';
import { WaveformDisplayOptions, WaveformRenderer, WaveformThemeName } from './waveform-render';

const AUDIO_CHUNK_SIZE = 1024;
const SPECTROGRAM_HEIGHT = 512;
const HISTORY_SECONDS = 8;
const PITCH_FLOOR_HZ = 75;
const PITCH_CEILING_HZ = 500;
const INTENSITY_FLOOR_DB_SPL = 50;
const INTENSITY_CEILING_DB_SPL = 100;
const MAX_OFFLINE_COLUMNS = 2048;

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

interface OfflineModeCache {
    spectrogram: Float32Array;
    analyses: AnalysisPoint[];
    windowCount: number;
    windowSize: number;
    windowStepSize: number;
    fftSize: number;
    analysisRevision: number;
}

interface MediaViewState {
    zoom: number;
    timeOffset: number;
}

interface MediaItem {
    id: string;
    name: string;
    type: 'file' | 'recording';
    state: 'ready' | 'analyzing' | 'error';
    durationSeconds: number;
    sampleRate: number;
    samples: Float32Array;
    modes: Partial<Record<SpectrogramMode, OfflineModeCache>>;
    views: Partial<Record<SpectrogramMode, MediaViewState>>;
    wavBlob?: Blob;
}

interface SessionStatistics {
    pitchFrames: number;
    intensityFrames: number;
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
    sampleRate: number,
    customWindowLengthMs: number
): ModeConfiguration {
    const durationSeconds =
        mode === 'broadband' ? 0.005 : mode === 'narrowband' ? 0.03 : customWindowLengthMs / 1000;
    const windowSize = Math.max(32, Math.round(sampleRate * durationSeconds));
    const hopSize = durationSeconds <= 0.012 ? 128 : 256;
    return {
        windowSize,
        fftSize: nextPowerOfTwo(windowSize),
        hopSize,
        historyCapacity: Math.ceil((HISTORY_SECONDS * sampleRate) / hopSize),
    };
}

function emptyStatistics(): SessionStatistics {
    return {
        pitchFrames: 0,
        intensityFrames: 0,
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

    private readonly waveformStage: HTMLElement;

    private readonly waveformRenderer: WaveformRenderer;

    private renderer: SpectrogramGPURenderer;

    private spectrogramBuffer: Circular2DBuffer<Float32Array>;

    private analysisHistory: AnalysisPoint[] = [];

    private mode: SpectrogramMode = 'broadband';

    private customWindowLengthMs = 15;

    private windowFunction: SpectrogramWindowFunction = 'gaussian';

    private spectrogramAnalysisRevision: Record<SpectrogramMode, number> = {
        broadband: 0,
        narrowband: 0,
        custom: 0,
    };

    private acousticAnalysisRevision = 0;

    private sampleRate = 48000;

    private renderParameters: Partial<RenderParameters> = {
        sensitivity: 10 ** (2 + 0.42 * 2),
        contrast: 10 ** (0.5 + 0.32 * 3) - 1,
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

    private returnView: MediaViewState | null = null;

    private overlayDirty = true;

    private waveformVisible = true;

    private spectrogramVisible = true;

    private spectrogramThemeName = 'Aurora';

    private processing = false;

    private pendingRequest: ProcessRequest | null = null;

    private stopActiveSource: (() => void) | null = null;

    private statistics: SessionStatistics = emptyStatistics();

    private sessionElapsedSeconds = 0;

    private lastUiUpdate = 0;

    private lastRenderTime = 0;

    private renderFramesPerSecond = 30;

    private renderPixelRatio = 1.5;

    private realtimeAnalysisPrecision: RealtimeAnalysisPrecision = 'accurate';

    private liveAnalysisBatchSequence = 0;

    private inspector: { x: number; y: number } | null = null;

    private selection: SelectionSnapshot | null = null;

    private playbackRange: { startSeconds: number; endSeconds: number } | null = null;

    private mediaItems: MediaItem[] = [];

    private activeMediaId: string | null = null;

    private mediaSequence = 0;

    private playbackContext: AudioContext | null = null;

    private playbackSource: AudioBufferSourceNode | null = null;

    private playbackTimer: number | null = null;

    private playbackStartedAt = 0;

    private playbackRate = 1;

    private playbackDirection: -1 | 1 = 1;

    private playbackOffsetSeconds = 0;

    private playbackIsPlaying = false;

    private recordingChunks: Float32Array[] = [];

    private recordingSampleRate = 48000;

    private isRecordingMicrophone = false;

    constructor(ui: UiController) {
        const canvas = document.querySelector('#spectrogramCanvas');
        const overlay = document.querySelector('#analysisOverlay');
        const stage = document.querySelector('#spectrogramStage');
        const waveformCanvas = document.querySelector('#waveformCanvas');
        const waveformStage = document.querySelector('#waveformStage');
        if (
            !(canvas instanceof HTMLCanvasElement) ||
            !(overlay instanceof HTMLCanvasElement) ||
            !(stage instanceof HTMLElement) ||
            !(waveformCanvas instanceof HTMLCanvasElement) ||
            !(waveformStage instanceof HTMLElement)
        ) {
            throw new Error('Unable to initialise the Spectro Pro display');
        }
        this.ui = ui;
        this.canvas = canvas;
        this.overlay = overlay;
        this.stage = stage;
        this.waveformStage = waveformStage;
        this.waveformRenderer = new WaveformRenderer(waveformCanvas);

        const config = modeConfiguration(this.mode, this.sampleRate, this.customWindowLengthMs);
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
        const stageResizeObserver = new ResizeObserver(resize);
        stageResizeObserver.observe(this.stage);
        stageResizeObserver.observe(this.waveformStage);
        requestAnimationFrame(() => this.renderLoop());
        this.notifyMediaLibrary();
        this.notifyTransport();
        this.ui.updateReturnViewAvailable(false);
    }

    updateDisplay(parameters: Partial<RenderParameters>) {
        if (parameters.zoom !== undefined) {
            this.clearReturnView();
        }
        this.renderParameters = { ...this.renderParameters, ...parameters };
        if (parameters.timeOffset !== undefined) {
            this.timeOffset = parameters.timeOffset;
        }
        if (parameters.zoom !== undefined) {
            const maximumOffset = Math.max(0, 1 - 1 / Math.max(1, parameters.zoom));
            this.timeOffset = clamp(this.timeOffset, 0, maximumOffset);
            this.renderParameters.timeOffset = this.timeOffset;
            this.ui.updateTimeOffset(this.timeOffset);
        }
        this.renderer.updateParameters({
            ...parameters,
            timeOffset: this.timeOffset,
        });
        this.saveActiveView();
        this.notifyTransport();
        this.overlayDirty = true;
    }

    setMode(mode: SpectrogramMode) {
        this.clearReturnView();
        this.saveActiveView();
        this.mode = mode;
        const activeMedia = this.activeMedia();
        if (activeMedia !== null) {
            this.stopMediaPlayback();
            this.showOrAnalyzeMedia(activeMedia);
            return;
        }
        const config = modeConfiguration(mode, this.sampleRate, this.customWindowLengthMs);
        this.spectrogramBuffer.resizeWidth(config.historyCapacity);
        this.renderer.updateParameters({
            sampleRate: this.sampleRate,
            windowSize: config.fftSize,
            timeOffset: 0,
        });
        this.timeOffset = 0;
        this.clearVisualHistory();
    }

    setSpectrogramAnalysis(settings: SpectrogramAnalysisSettings) {
        const customWindowChanged = this.customWindowLengthMs !== settings.customWindowLengthMs;
        const windowFunctionChanged = this.windowFunction !== settings.windowFunction;
        if (!customWindowChanged && !windowFunctionChanged) {
            return;
        }

        this.customWindowLengthMs = settings.customWindowLengthMs;
        this.windowFunction = settings.windowFunction;
        if (windowFunctionChanged) {
            this.spectrogramAnalysisRevision.broadband += 1;
            this.spectrogramAnalysisRevision.narrowband += 1;
            this.spectrogramAnalysisRevision.custom += 1;
        } else {
            this.spectrogramAnalysisRevision.custom += 1;
        }
        for (const item of this.mediaItems) {
            if (windowFunctionChanged) {
                item.modes = {};
            } else {
                delete item.modes.custom;
            }
        }

        const affectsCurrentMode = windowFunctionChanged || this.mode === 'custom';
        if (!affectsCurrentMode) {
            return;
        }
        const activeMedia = this.activeMedia();
        if (activeMedia !== null) {
            this.stopMediaPlayback(false);
            this.showOrAnalyzeMedia(activeMedia);
            return;
        }

        const config = modeConfiguration(this.mode, this.sampleRate, this.customWindowLengthMs);
        this.spectrogramBuffer.resizeWidth(config.historyCapacity);
        this.renderer.updateParameters({
            sampleRate: this.sampleRate,
            windowSize: config.fftSize,
        });
        this.clearVisualHistory();
    }

    setPitchAlgorithm(algorithm: PitchAlgorithm) {
        this.updateAnalysis({ pitchAlgorithm: algorithm });
    }

    updateAnalysis(parameters: Partial<AnalysisOptions>) {
        const changed = Object.entries(parameters).some(
            ([key, value]) => this.analysisOptions[key as keyof AnalysisOptions] !== value
        );
        if (!changed) {
            return;
        }
        const formantParametersChanged = ([
            'formantCeilingHz',
            'maximumFormants',
            'formantWindowLengthSeconds',
            'preEmphasisFromHz',
        ] as (keyof AnalysisOptions)[]).some(
            (key) => parameters[key] !== undefined && this.analysisOptions[key] !== parameters[key]
        );
        this.analysisOptions = { ...this.analysisOptions, ...parameters };
        this.acousticAnalysisRevision += 1;
        const activeMedia = this.activeMedia();
        if (activeMedia !== null) {
            const cache = activeMedia.modes[this.mode];
            if (cache !== undefined) {
                this.reanalyzeMediaCache(activeMedia, this.mode, cache, formantParametersChanged);
            }
        }
    }

    updateLayerDisplay(parameters: Partial<LayerDisplayOptions>) {
        this.layerDisplayOptions = {
            ...this.layerDisplayOptions,
            ...parameters,
        };
        this.overlayDirty = true;
    }

    updatePerformance(settings: PerformanceSettings) {
        this.renderFramesPerSecond =
            settings.framesPerSecond <= 0 ? 0 : clamp(Math.round(settings.framesPerSecond), 15, 60);
        this.realtimeAnalysisPrecision = settings.analysisPrecision;
        const nextPixelRatio = clamp(settings.renderPixelRatio, 0.5, 2);
        if (this.renderPixelRatio !== nextPixelRatio) {
            this.renderPixelRatio = nextPixelRatio;
            this.resize();
        }
    }

    setOverlays(pitch: boolean, formants: boolean, intensity: boolean) {
        this.showPitch = pitch;
        this.showFormants = formants;
        this.showIntensity = intensity;
        this.overlayDirty = true;
    }

    setPlotVisibility(waveform: boolean, spectrogram: boolean) {
        this.waveformVisible = waveform;
        this.spectrogramVisible = spectrogram;
        requestAnimationFrame(() => this.resize());
    }

    setPlotThemes(spectrogramThemeName: string, waveformThemeName: WaveformThemeName) {
        this.spectrogramThemeName = spectrogramThemeName;
        this.waveformRenderer.setTheme(waveformThemeName);
        this.overlayDirty = true;
    }

    updateWaveformDisplay(parameters: Partial<WaveformDisplayOptions>) {
        this.waveformRenderer.updateDisplay(parameters);
        this.overlayDirty = true;
    }

    async startMicrophone() {
        this.saveActiveView();
        this.stop();
        this.activeMediaId = null;
        this.notifyMediaLibrary();
        this.notifyTransport();
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
            this.recordingChunks = [];
            this.recordingSampleRate = audioCtx.sampleRate;
            this.isRecordingMicrophone = true;
            this.waveformRenderer.startLive(audioCtx.sampleRate, HISTORY_SECONDS);

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
                this.recordingChunks.push(chunk);
                this.sessionElapsedSeconds = receivedSamples / audioCtx.sampleRate;
                this.waveformRenderer.appendLive(chunk, this.sessionElapsedSeconds);

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
                audioCtx.close();
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
        this.ui.setPlayState('loading-file', name, '正在解码音频…');

        try {
            const audioCtx = this.createAudioContext();
            const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
            const mono = new Float32Array(audioBuffer.length);
            for (let channel = 0; channel < audioBuffer.numberOfChannels; channel += 1) {
                const channelData = audioBuffer.getChannelData(channel);
                for (let i = 0; i < mono.length; i += 1) {
                    mono[i] += channelData[i] / audioBuffer.numberOfChannels;
                }
            }
            await audioCtx.close();
            const item: MediaItem = {
                id: `media-${Date.now()}-${(this.mediaSequence += 1)}`,
                name,
                type: 'file',
                state: 'analyzing',
                durationSeconds: mono.length / audioBuffer.sampleRate,
                sampleRate: audioBuffer.sampleRate,
                samples: mono,
                modes: {},
                views: {},
            };
            this.saveActiveView();
            this.mediaItems.push(item);
            this.activeMediaId = item.id;
            this.notifyMediaLibrary();
            this.notifyTransport();
            await this.showOrAnalyzeMedia(item);
        } catch (error) {
            this.ui.setPlayState(
                'stopped',
                name,
                error instanceof Error ? error.message : '无法读取此音频'
            );
        }
    }

    stop() {
        this.stopMediaPlayback();
        if (this.stopActiveSource !== null) {
            const stop = this.stopActiveSource;
            this.stopActiveSource = null;
            stop();
        }
        this.pendingRequest = null;
        if (this.isRecordingMicrophone) {
            this.isRecordingMicrophone = false;
            this.finalizeRecording();
        }
    }

    clear() {
        this.resetSession();
    }

    selectMedia(id: string | null) {
        this.clearReturnView();
        this.saveActiveView();
        this.stop();
        if (this.activeMediaId !== id) {
            this.selection = null;
            this.playbackRange = null;
            this.ui.updateSelection(null);
        }
        this.activeMediaId = id;
        this.notifyMediaLibrary();
        this.notifyTransport();
        if (id === null) {
            const config = modeConfiguration(this.mode, this.sampleRate, this.customWindowLengthMs);
            this.spectrogramBuffer = new Circular2DBuffer(
                Float32Array,
                config.historyCapacity,
                SPECTROGRAM_HEIGHT,
                1
            );
            this.clearVisualHistory();
            this.ui.setPlayState('stopped', '麦克风', '点击麦克风开始新的录音分段');
            return;
        }
        const item = this.activeMedia();
        if (item !== null) {
            this.showOrAnalyzeMedia(item);
        }
    }

    toggleMediaPlayback() {
        const item = this.activeMedia();
        if (item === null || item.state !== 'ready') {
            return;
        }
        if (this.playbackIsPlaying) {
            this.pauseMediaPlayback();
        } else {
            this.startMediaPlayback(item);
        }
    }

    startMediaAudition(playbackRate: number, direction: -1 | 1) {
        const item = this.activeMedia();
        if (item === null || item.state !== 'ready' || this.playbackIsPlaying) {
            return;
        }
        this.startMediaPlayback(item, clamp(playbackRate, 1, 3), direction);
    }

    seekMedia(seconds: number) {
        const item = this.activeMedia();
        if (item === null) {
            return;
        }
        const wasPlaying = this.playbackIsPlaying;
        const playbackRate = this.playbackRate;
        const playbackDirection = this.playbackDirection;
        this.stopMediaPlayback(false);
        const minimum = this.playbackRange?.startSeconds ?? 0;
        const maximum = this.playbackRange?.endSeconds ?? item.durationSeconds;
        this.playbackOffsetSeconds = clamp(seconds, minimum, maximum);
        this.sessionElapsedSeconds = this.playbackOffsetSeconds;
        this.updateSnapshotAtPlaybackOffset(true);
        this.notifyTransport();
        this.overlayDirty = true;
        if (wasPlaying && this.playbackOffsetSeconds < item.durationSeconds) {
            this.startMediaPlayback(item, playbackRate, playbackDirection);
        }
    }

    playMediaAt(xRatio: number) {
        const item = this.activeMedia();
        if (item === null || item.state !== 'ready') {
            return;
        }
        const visible = this.visibleTimeRange();
        const targetSeconds =
            visible.startSeconds +
            clamp(xRatio, 0, 1) * (visible.endSeconds - visible.startSeconds);
        const minimum = this.playbackRange?.startSeconds ?? 0;
        const maximum = this.playbackRange?.endSeconds ?? item.durationSeconds;
        const continuePlayback = this.playbackIsPlaying;
        const playbackRate = this.playbackRate;
        const playbackDirection = this.playbackDirection;
        this.stopMediaPlayback(false);
        this.playbackOffsetSeconds = clamp(targetSeconds, minimum, maximum);
        this.sessionElapsedSeconds = this.playbackOffsetSeconds;
        this.updateSnapshotAtPlaybackOffset(true);
        this.notifyTransport();
        if (continuePlayback) {
            this.startMediaPlayback(item, playbackRate, playbackDirection);
        } else {
            this.ui.setPlayState('stopped', item.name, '已定位，按绿色播放按钮开始');
        }
        this.overlayDirty = true;
    }

    renameMedia(id: string, name: string) {
        const item = this.mediaItems.find((candidate) => candidate.id === id);
        if (item === undefined) {
            return;
        }
        item.name = name;
        this.notifyMediaLibrary();
        if (this.activeMediaId === id) {
            this.ui.setPlayState('stopped', name, '分析缓存已就绪');
        }
    }

    saveMedia(id: string) {
        const item = this.mediaItems.find((candidate) => candidate.id === id);
        if (item?.type !== 'recording') {
            return;
        }
        const blob = item.wavBlob || encodeWav(item.samples, item.sampleRate);
        item.wavBlob = blob;
        const link = document.createElement('a');
        link.download = `${item.name.replace(/[<>:"/\\|?*]/g, '_')}.wav`;
        link.href = URL.createObjectURL(blob);
        link.click();
        URL.revokeObjectURL(link.href);
    }

    clearPlaylist() {
        this.stop();
        this.mediaItems = [];
        this.activeMediaId = null;
        this.playbackOffsetSeconds = 0;
        this.resetSession();
        this.notifyMediaLibrary();
        this.notifyTransport();
        this.ui.setPlayState('stopped', '麦克风', '播放列表已清空，可开始新的会话');
    }

    removeMedia(id: string) {
        const index = this.mediaItems.findIndex((item) => item.id === id);
        if (index < 0) {
            return;
        }
        const wasActive = this.activeMediaId === id;
        if (wasActive) {
            this.stopMediaPlayback();
            this.activeMediaId = null;
            this.playbackOffsetSeconds = 0;
            this.resetSession();
            this.ui.setPlayState('stopped', '麦克风', '音频已移除，可开始新的会话');
        }
        this.mediaItems.splice(index, 1);
        this.notifyMediaLibrary();
        if (wasActive) {
            this.notifyTransport();
        }
    }

    navigate(amount: number) {
        const zoom = this.renderParameters.zoom || 1;
        const maximumOffset = Math.max(0, 1 - 1 / Math.max(1, zoom));
        const nextOffset = clamp(this.timeOffset + amount, 0, maximumOffset);
        this.timeOffset = nextOffset;
        this.renderer.updateParameters({ timeOffset: nextOffset });
        this.renderParameters.timeOffset = nextOffset;
        this.ui.updateTimeOffset(nextOffset);
        this.saveActiveView();
        this.notifyTransport();
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
        const visibleTime = this.visibleTimeRange();
        const timeSeconds =
            visibleTime.startSeconds + x * (visibleTime.endSeconds - visibleTime.startSeconds);
        const index = this.analysisIndexAtTime(timeSeconds);
        const point = this.analysisHistory[index];
        if (!point) {
            this.ui.updateCursor(null);
            return;
        }
        const minFrequency = this.renderParameters.minFrequencyHz || 0;
        const maxFrequency = this.renderParameters.maxFrequencyHz || 5500;
        const scale = this.renderParameters.scale || 'linear';
        const frequency = scaleToFrequency(
            frequencyToScale(minFrequency, scale) +
                (1 - y) *
                    (frequencyToScale(maxFrequency, scale) - frequencyToScale(minFrequency, scale)),
            scale
        );
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

    selectRange(xStart: number, xEnd: number) {
        if (xStart < 0 || xEnd < 0 || this.analysisHistory.length === 0) {
            this.selection = null;
            this.playbackRange = null;
            this.ui.updateSelection(null);
            this.overlayDirty = true;
            return;
        }
        const visible = this.visibleTimeRange();
        const ratioStart = clamp(Math.min(xStart, xEnd), 0, 1);
        const ratioEnd = clamp(Math.max(xStart, xEnd), 0, 1);
        const visibleDuration = visible.endSeconds - visible.startSeconds;
        const activeMedia = this.activeMedia();
        const minimumTime = 0;
        const maximumTime = activeMedia?.durationSeconds ?? this.sessionElapsedSeconds;
        const startSeconds = clamp(
            visible.startSeconds + ratioStart * visibleDuration,
            minimumTime,
            maximumTime
        );
        const endSeconds = clamp(
            visible.startSeconds + ratioEnd * visibleDuration,
            minimumTime,
            maximumTime
        );
        this.selection = {
            xStart: ratioStart,
            xEnd: ratioEnd,
            startSeconds,
            endSeconds,
            durationSeconds: Math.max(0, endSeconds - startSeconds),
        };
        this.playbackRange = {
            startSeconds: this.selection.startSeconds,
            endSeconds: this.selection.endSeconds,
        };
        this.ui.updateSelection(this.selection);
        this.overlayDirty = true;
    }

    fitSelection() {
        const item = this.activeMedia();
        if (item === null || this.selection === null || this.analysisHistory.length < 2) {
            return;
        }
        const cache = item.modes[this.mode];
        if (cache === undefined) {
            return;
        }
        const hopSeconds = cache.windowStepSize / item.sampleRate;
        const fullStartSeconds = this.analysisHistory[0].timeSeconds - hopSeconds / 2;
        const fullEndSeconds =
            this.analysisHistory[this.analysisHistory.length - 1].timeSeconds + hopSeconds / 2;
        const fullDuration = Math.max(hopSeconds, fullEndSeconds - fullStartSeconds);
        const selectionStart = clamp(
            this.selection.startSeconds,
            fullStartSeconds,
            fullEndSeconds - hopSeconds
        );
        const selectionEnd = clamp(
            this.selection.endSeconds,
            selectionStart + hopSeconds,
            fullEndSeconds
        );
        const selectedDuration = Math.max(hopSeconds * 2, selectionEnd - selectionStart);
        const zoom = clamp(fullDuration / selectedDuration, 1, 64);
        const maximumOffset = Math.max(0, 1 - 1 / zoom);
        const offset = clamp((fullEndSeconds - selectionEnd) / fullDuration, 0, maximumOffset);
        const currentZoom = Math.max(1, this.renderParameters.zoom || 1);
        if (Math.abs(currentZoom - zoom) < 1e-9 && Math.abs(this.timeOffset - offset) < 1e-9) {
            return;
        }
        this.returnView = {
            zoom: currentZoom,
            timeOffset: this.timeOffset,
        };
        this.ui.updateReturnViewAvailable(true);
        this.renderParameters = {
            ...this.renderParameters,
            zoom,
            timeOffset: offset,
        };
        this.timeOffset = offset;
        this.renderer.updateParameters({ zoom, timeOffset: offset });
        this.ui.updateZoom(zoom);
        this.ui.updateTimeOffset(offset);
        this.saveActiveView();
        this.notifyTransport();
        this.overlayDirty = true;
    }

    returnToPreviousView() {
        if (this.returnView === null) {
            return;
        }
        const view = this.returnView;
        this.clearReturnView();
        const zoom = Math.max(1, view.zoom);
        const maximumOffset = Math.max(0, 1 - 1 / zoom);
        const timeOffset = clamp(view.timeOffset, 0, maximumOffset);
        this.renderParameters = {
            ...this.renderParameters,
            zoom,
            timeOffset,
        };
        this.timeOffset = timeOffset;
        this.renderer.updateParameters({ zoom, timeOffset });
        this.ui.updateZoom(zoom);
        this.ui.updateTimeOffset(timeOffset);
        this.saveActiveView();
        this.notifyTransport();
        this.overlayDirty = true;
    }

    restoreView() {
        this.clearReturnView();
        this.renderParameters = {
            ...this.renderParameters,
            zoom: 1,
            timeOffset: 0,
        };
        this.timeOffset = 0;
        this.renderer.updateParameters({ zoom: 1, timeOffset: 0 });
        this.ui.updateZoom(1);
        this.ui.updateTimeOffset(0);
        this.saveActiveView();
        this.notifyTransport();
        this.overlayDirty = true;
    }

    exportImage() {
        this.renderer.render(true);
        this.drawOverlay();
        const waveformCanvas = document.querySelector('#waveformCanvas');
        const waveformHeight =
            this.waveformVisible && waveformCanvas instanceof HTMLCanvasElement
                ? waveformCanvas.height
                : 0;
        const spectrogramHeight = this.spectrogramVisible ? this.canvas.height : 0;
        const dividerHeight = waveformHeight > 0 && spectrogramHeight > 0 ? 2 : 0;
        const width = Math.max(
            this.spectrogramVisible ? this.canvas.width : 0,
            this.waveformVisible && waveformCanvas instanceof HTMLCanvasElement
                ? waveformCanvas.width
                : 0
        );
        const height = waveformHeight + dividerHeight + spectrogramHeight;
        const exportCanvas = document.createElement('canvas');
        exportCanvas.width = width;
        exportCanvas.height = height;
        const ctx = exportCanvas.getContext('2d');
        if (!ctx) {
            return;
        }
        let y = 0;
        if (waveformHeight > 0 && waveformCanvas instanceof HTMLCanvasElement) {
            ctx.drawImage(waveformCanvas, 0, y, width, waveformHeight);
            y += waveformHeight;
        }
        if (dividerHeight > 0) {
            ctx.fillStyle = '#526177';
            ctx.fillRect(0, y, width, dividerHeight);
            y += dividerHeight;
        }
        if (spectrogramHeight > 0) {
            ctx.drawImage(this.canvas, 0, y, width, spectrogramHeight);
            ctx.drawImage(this.overlay, 0, y, width, spectrogramHeight);
        }
        const activeMedia = this.activeMedia();
        const visibleTime = this.visibleTimeRange();
        if (
            activeMedia !== null &&
            this.playbackOffsetSeconds >= visibleTime.startSeconds &&
            this.playbackOffsetSeconds <= visibleTime.endSeconds
        ) {
            const playheadX =
                ((this.playbackOffsetSeconds - visibleTime.startSeconds) /
                    Math.max(1e-9, visibleTime.endSeconds - visibleTime.startSeconds)) *
                width;
            ctx.save();
            ctx.globalCompositeOperation = 'difference';
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(playheadX - 1.5, 0, 3, height);
            ctx.restore();
        }
        ctx.fillStyle = 'rgba(4, 7, 18, 0.72)';
        ctx.fillRect(18, 18, 280, 90);
        ctx.fillStyle = '#ffffff';
        ctx.font = '600 22px Arial, sans-serif';
        ctx.fillText('SPECTRO PRO', 32, 50);
        ctx.strokeStyle = 'rgba(154, 167, 188, 0.28)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(32, 64);
        ctx.lineTo(284, 64);
        ctx.stroke();
        ctx.fillStyle = '#9aa7bc';
        ctx.font = '12px Arial, sans-serif';
        ctx.fillText(
            this.mode === 'broadband'
                ? `${t('宽带')} · 5 ms`
                : this.mode === 'narrowband'
                ? `${t('窄带')} · 30 ms`
                : `${t('自定义')} · ${this.customWindowLengthMs} ms`,
            32,
            88
        );
        exportCanvas.toBlob((blob) => {
            if (!blob) {
                return;
            }
            const link = document.createElement('a');
            link.download = `spectro-pro-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
            link.href = URL.createObjectURL(blob);
            link.click();
            URL.revokeObjectURL(link.href);
        }, 'image/png');
    }

    private activeMedia() {
        return this.mediaItems.find((item) => item.id === this.activeMediaId) || null;
    }

    private async showOrAnalyzeMedia(item: MediaItem) {
        const cache = item.modes[this.mode];
        if (cache !== undefined) {
            if (cache.analysisRevision !== this.acousticAnalysisRevision) {
                this.displayMediaCache(item, cache);
                await this.reanalyzeMediaCache(item, this.mode, cache);
                return;
            }
            this.displayMediaCache(item, cache);
            return;
        }
        await this.analyzeMedia(item, this.mode, true);
    }

    private async analyzeMedia(item: MediaItem, mode: SpectrogramMode, displayWhenReady: boolean) {
        const analysisRevision = this.spectrogramAnalysisRevision[mode];
        const acousticAnalysisRevision = this.acousticAnalysisRevision;
        item.state = 'analyzing';
        this.notifyMediaLibrary();
        if (displayWhenReady && this.activeMediaId === item.id) {
            this.ui.setPlayState(
                'loading-file',
                item.name,
                mode === 'broadband'
                    ? '正在分析整段宽带语谱…'
                    : mode === 'narrowband'
                    ? '正在分析整段窄带语谱…'
                    : '正在分析自定义语谱…'
            );
        }
        try {
            const config = modeConfiguration(mode, item.sampleRate, this.customWindowLengthMs);
            const adaptiveHop = Math.max(
                config.hopSize,
                Math.ceil(
                    Math.max(0, item.samples.length - config.windowSize) /
                        Math.max(1, MAX_OFFLINE_COLUMNS - 1)
                )
            );
            const result = await offThreadAnalyzeEntireFile(
                new Float32Array(item.samples),
                {
                    windowSize: config.windowSize,
                    fftSize: config.fftSize,
                    windowStepSize: adaptiveHop,
                    sampleRate: item.sampleRate,
                    scaleSize: SPECTROGRAM_HEIGHT,
                    windowFunction: this.windowFunction,
                },
                this.analysisOptions
            );
            if (analysisRevision !== this.spectrogramAnalysisRevision[mode]) {
                return;
            }
            const cache: OfflineModeCache = {
                spectrogram: result.spectrogram,
                analyses: result.analyses,
                windowCount: result.windowCount,
                windowSize: result.options.windowSize,
                windowStepSize: result.options.windowStepSize,
                fftSize: config.fftSize,
                analysisRevision: acousticAnalysisRevision,
            };
            item.modes[mode] = cache;
            item.state = 'ready';
            this.notifyMediaLibrary();
            if (displayWhenReady && this.activeMediaId === item.id && this.mode === mode) {
                this.displayMediaCache(item, cache);
                if (cache.analysisRevision !== this.acousticAnalysisRevision) {
                    this.reanalyzeMediaCache(item, mode, cache);
                }
            }
        } catch (error) {
            if (analysisRevision !== this.spectrogramAnalysisRevision[mode]) {
                return;
            }
            item.state = 'error';
            this.notifyMediaLibrary();
            if (displayWhenReady && this.activeMediaId === item.id) {
                this.ui.setPlayState(
                    'stopped',
                    item.name,
                    error instanceof Error ? error.message : '无法分析此音频'
                );
            }
        }
    }

    private async reanalyzeMediaCache(
        item: MediaItem,
        mode: SpectrogramMode,
        cache: OfflineModeCache,
        includeFormants = true
    ) {
        const analysisRevision = this.acousticAnalysisRevision;
        const centreSamples = new Array(cache.windowCount)
            .fill(0)
            .map((_, index) => index * cache.windowStepSize + cache.windowSize / 2);
        try {
            const result = await offThreadAnalyzeAcoustics(
                new Float32Array(item.samples),
                item.sampleRate,
                centreSamples,
                this.analysisOptions,
                includeFormants
            );
            if (analysisRevision !== this.acousticAnalysisRevision || item.modes[mode] !== cache) {
                return;
            }
            cache.analyses = result.analyses.map((analysis, index) => {
                const previous = cache.analyses[index];
                return {
                    ...analysis,
                    formantsHz:
                        includeFormants || previous === undefined
                            ? analysis.formantsHz
                            : previous.formantsHz,
                    formantBandwidthsHz:
                        includeFormants || previous === undefined
                            ? analysis.formantBandwidthsHz
                            : previous.formantBandwidthsHz,
                    formantIntensity:
                        includeFormants || previous === undefined
                            ? analysis.formantIntensity
                            : previous.formantIntensity,
                    drawFormants:
                        includeFormants || previous === undefined
                            ? analysis.drawFormants
                            : previous.drawFormants,
                    timeSeconds: centreSamples[index] / item.sampleRate,
                };
            });
            cache.analysisRevision = analysisRevision;
            if (this.activeMediaId === item.id && this.mode === mode) {
                this.analysisHistory = cache.analyses;
                this.rebuildStatisticsFromHistory();
                this.updateSnapshotAtPlaybackOffset(true);
                this.overlayDirty = true;
            }
        } catch (error) {
            console.warn('Unable to update acoustic overlays', error);
        }
    }

    private displayMediaCache(item: MediaItem, cache: OfflineModeCache) {
        const savedView = item.views[this.mode] || { zoom: 1, timeOffset: 0 };
        const zoom = Math.max(1, savedView.zoom);
        const maximumOffset = Math.max(0, 1 - 1 / zoom);
        const timeOffset = clamp(savedView.timeOffset, 0, maximumOffset);
        this.sampleRate = item.sampleRate;
        this.analysisHistory = cache.analyses;
        this.waveformRenderer.setOfflineSamples(item.samples, item.sampleRate);
        this.spectrogramBuffer = new Circular2DBuffer(
            Float32Array,
            Math.max(2, cache.windowCount),
            SPECTROGRAM_HEIGHT,
            1
        );
        this.spectrogramBuffer.enqueue(cache.spectrogram);
        this.renderer.updateParameters({
            sampleRate: item.sampleRate,
            windowSize: cache.fftSize,
            zoom,
            timeOffset,
        });
        this.renderer.updateSpectrogram(this.spectrogramBuffer, true);
        this.renderParameters = {
            ...this.renderParameters,
            zoom,
            timeOffset,
        };
        this.timeOffset = timeOffset;
        this.playbackOffsetSeconds = clamp(this.playbackOffsetSeconds, 0, item.durationSeconds);
        this.rebuildStatisticsFromHistory();
        this.sessionElapsedSeconds = this.playbackOffsetSeconds;
        this.updateSnapshotAtPlaybackOffset(true);
        this.ui.updateZoom(zoom);
        this.ui.updateTimeOffset(timeOffset);
        this.ui.setPlayState('stopped', item.name, '整段分析完成，可自由拖动播放');
        this.notifyTransport();
        this.overlayDirty = true;
    }

    private rebuildStatisticsFromHistory() {
        this.statistics = emptyStatistics();
        for (const point of this.analysisHistory) {
            this.statistics.pitchFrames += 1;
            this.statistics.intensityFrames += 1;
            this.statistics.intensityPowerSum += 10 ** (point.intensityDbSpl / 10);
            if (point.pitchHz !== null) {
                this.statistics.voicedFrames += 1;
                this.statistics.pitchSum += point.pitchHz;
                this.statistics.pitchMin = Math.min(this.statistics.pitchMin, point.pitchHz);
                this.statistics.pitchMax = Math.max(this.statistics.pitchMax, point.pitchHz);
            }
        }
    }

    private startMediaPlayback(
        item: MediaItem,
        playbackRate: number = 1,
        playbackDirection: -1 | 1 = 1
    ) {
        const rangeStart = this.playbackRange?.startSeconds ?? 0;
        const rangeEnd = this.playbackRange?.endSeconds ?? item.durationSeconds;
        if (
            this.playbackOffsetSeconds < rangeStart ||
            this.playbackOffsetSeconds > rangeEnd ||
            (playbackDirection > 0 && this.playbackOffsetSeconds >= rangeEnd) ||
            (playbackDirection < 0 && this.playbackOffsetSeconds <= rangeStart)
        ) {
            this.playbackOffsetSeconds = playbackDirection > 0 ? rangeStart : rangeEnd;
        }
        this.stopMediaPlayback(false);
        this.playbackRate = clamp(playbackRate, 1, 3);
        this.playbackDirection = playbackDirection;
        const audioCtx = this.createAudioContext();
        const buffer = audioCtx.createBuffer(1, item.samples.length, item.sampleRate);
        if (this.playbackDirection > 0) {
            buffer.copyToChannel(new Float32Array(item.samples), 0);
        } else {
            const reversedSamples = buffer.getChannelData(0);
            for (let index = 0; index < item.samples.length; index += 1) {
                reversedSamples[index] = item.samples[item.samples.length - index - 1];
            }
        }
        const source = audioCtx.createBufferSource();
        source.buffer = buffer;
        source.playbackRate.value = this.playbackRate;
        source.connect(audioCtx.destination);
        this.playbackContext = audioCtx;
        this.playbackSource = source;
        this.playbackStartedAt = audioCtx.currentTime;
        this.playbackIsPlaying = true;
        source.addEventListener('ended', () => {
            if (this.playbackSource !== source) {
                return;
            }
            const terminalSeconds = this.playbackDirection > 0 ? rangeEnd : rangeStart;
            this.playbackOffsetSeconds = terminalSeconds;
            this.sessionElapsedSeconds = terminalSeconds;
            this.stopMediaPlayback(false);
            this.updateSnapshotAtPlaybackOffset(true);
            this.overlayDirty = true;
            this.ui.setPlayState(
                'stopped',
                item.name,
                this.playbackRange === null ? '播放完成' : '选区播放完成'
            );
        });
        const sourceOffsetSeconds =
            this.playbackDirection > 0
                ? this.playbackOffsetSeconds
                : item.durationSeconds - this.playbackOffsetSeconds;
        const sourceDurationSeconds =
            this.playbackDirection > 0
                ? rangeEnd - this.playbackOffsetSeconds
                : this.playbackOffsetSeconds - rangeStart;
        source.start(0, sourceOffsetSeconds);
        source.stop(
            audioCtx.currentTime + Math.max(0.001, sourceDurationSeconds) / this.playbackRate
        );
        audioCtx.resume();
        this.playbackTimer = window.setInterval(() => this.updatePlaybackPosition(), 33);
        this.ui.setPlayState('playing', item.name, '播放中 · 分析图保持完整');
        this.notifyTransport();
    }

    private updatePlaybackPosition() {
        const item = this.activeMedia();
        if (item === null || this.playbackContext === null || !this.playbackIsPlaying) {
            return;
        }
        const rangeEnd = this.playbackRange?.endSeconds ?? item.durationSeconds;
        this.playbackOffsetSeconds = clamp(
            this.playbackOffsetSeconds +
                (this.playbackContext.currentTime - this.playbackStartedAt) *
                    this.playbackRate *
                    this.playbackDirection,
            this.playbackRange?.startSeconds ?? 0,
            rangeEnd
        );
        this.playbackStartedAt = this.playbackContext.currentTime;
        this.sessionElapsedSeconds = this.playbackOffsetSeconds;
        this.updateSnapshotAtPlaybackOffset();
        this.notifyTransport();
        this.overlayDirty = true;
    }

    pauseMediaPlayback() {
        const item = this.activeMedia();
        this.updatePlaybackPosition();
        this.stopMediaPlayback(false);
        if (item !== null) {
            this.ui.setPlayState('stopped', item.name, '已暂停，可拖动定位');
        }
    }

    private stopMediaPlayback(resetPosition: boolean = false) {
        if (this.playbackTimer !== null) {
            window.clearInterval(this.playbackTimer);
            this.playbackTimer = null;
        }
        const source = this.playbackSource;
        this.playbackSource = null;
        if (source !== null) {
            try {
                source.stop();
            } catch {
                // The source may already have ended.
            }
            source.disconnect();
        }
        if (this.playbackContext !== null) {
            this.playbackContext.close();
            this.playbackContext = null;
        }
        this.playbackIsPlaying = false;
        this.playbackRate = 1;
        this.playbackDirection = 1;
        if (resetPosition) {
            this.playbackOffsetSeconds = 0;
        }
        this.notifyTransport();
    }

    private finalizeRecording() {
        const totalLength = this.recordingChunks.reduce((total, chunk) => total + chunk.length, 0);
        if (totalLength === 0) {
            this.recordingChunks = [];
            return;
        }
        const samples = new Float32Array(totalLength);
        let offset = 0;
        for (const chunk of this.recordingChunks) {
            samples.set(chunk, offset);
            offset += chunk.length;
        }
        this.recordingChunks = [];
        const sequence = this.mediaItems.filter((item) => item.type === 'recording').length;
        const item: MediaItem = {
            id: `recording-${Date.now()}-${(this.mediaSequence += 1)}`,
            name: `${t('录音')} ${sequence + 1}`,
            type: 'recording',
            state: 'analyzing',
            durationSeconds: samples.length / this.recordingSampleRate,
            sampleRate: this.recordingSampleRate,
            samples,
            modes: {},
            views: {},
        };
        this.mediaItems.unshift(item);
        this.notifyMediaLibrary();
        this.analyzeMedia(item, this.mode, false);
    }

    private notifyMediaLibrary() {
        const items: MediaListItem[] = this.mediaItems.map((item) => ({
            id: item.id,
            name: item.name,
            durationSeconds: item.durationSeconds,
            type: item.type,
            state: item.state,
        }));
        this.ui.updateMediaLibrary(items, this.activeMediaId);
    }

    private saveActiveView() {
        const item = this.activeMedia();
        if (item === null) {
            return;
        }
        const view = {
            zoom: Math.max(1, this.renderParameters.zoom || 1),
            timeOffset: this.timeOffset,
        };
        item.views.broadband = view;
        item.views.narrowband = view;
        item.views.custom = view;
    }

    private notifyTransport() {
        const item = this.activeMedia();
        const visible = this.visibleTimeRange();
        const viewStartSeconds =
            item === null ? Math.max(0, visible.startSeconds) : visible.startSeconds;
        const viewEndSeconds = item === null ? Math.max(0, visible.endSeconds) : visible.endSeconds;
        const snapshot: TransportSnapshot = {
            activeId: item?.id || null,
            currentSeconds: item === null ? 0 : this.playbackOffsetSeconds,
            durationSeconds: item?.durationSeconds || 0,
            viewStartSeconds,
            viewEndSeconds: Math.max(viewStartSeconds, viewEndSeconds),
            isPlaying: this.playbackIsPlaying,
        };
        this.ui.updateTransport(snapshot);
    }

    private createAudioContext() {
        return new (window.AudioContext || window.webkitAudioContext)();
    }

    private setSampleRate(sampleRate: number) {
        if (this.sampleRate === sampleRate) {
            return;
        }
        this.sampleRate = sampleRate;
        const config = modeConfiguration(this.mode, sampleRate, this.customWindowLengthMs);
        this.spectrogramBuffer.resizeWidth(config.historyCapacity);
        this.renderer.updateParameters({
            sampleRate,
            windowSize: config.fftSize,
        });
        this.clearVisualHistory();
    }

    private queueProcessing(request: ProcessRequest) {
        if (this.processing) {
            this.pendingRequest = {
                ...request,
                newSamples: request.newSamples + (this.pendingRequest?.newSamples || 0),
            };
            return;
        }
        this.processRequest(request);
    }

    private async processRequest(request: ProcessRequest) {
        this.processing = true;
        try {
            const config = modeConfiguration(
                this.mode,
                request.sampleRate,
                this.customWindowLengthMs
            );
            if (request.samples.length < config.windowSize) {
                return;
            }
            const maximumFrames = Math.floor(request.newSamples / config.hopSize);
            const availableFrames =
                Math.floor((request.samples.length - config.windowSize) / config.hopSize) + 1;
            const frameCount = Math.max(1, Math.min(maximumFrames, availableFrames));
            const formantLookahead = Math.ceil(
                this.analysisOptions.formantWindowLengthSeconds * request.sampleRate
            );
            const samplesEnd = request.samples.length - formantLookahead;
            const samplesLength = config.windowSize + (frameCount - 1) * config.hopSize;
            const samplesStart = samplesEnd - samplesLength;
            if (samplesStart < 0) {
                return;
            }
            const analysisBatchSequence = this.liveAnalysisBatchSequence;
            this.liveAnalysisBatchSequence += 1;
            const smoothPrecision = this.realtimeAnalysisPrecision === 'smooth';
            const calculatePitch =
                this.showPitch && (!smoothPrecision || analysisBatchSequence % 2 === 0);
            const calculateFormants =
                this.showFormants && (!smoothPrecision || analysisBatchSequence % 4 === 0);
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
                    windowFunction: this.windowFunction,
                },
                this.analysisOptions,
                {
                    pitch: calculatePitch,
                    formants: calculateFormants,
                    intensity: this.showIntensity,
                },
                analysisCadenceForPrecision(this.realtimeAnalysisPrecision)
            );
            const previousAnalysis = this.analysisHistory[this.analysisHistory.length - 1];
            if (previousAnalysis !== undefined) {
                for (const analysis of result.analyses) {
                    if (this.showPitch && !calculatePitch) {
                        analysis.pitchHz = previousAnalysis.pitchHz;
                        analysis.pitchConfidence = previousAnalysis.pitchConfidence;
                    }
                    if (this.showFormants && !calculateFormants) {
                        analysis.formantsHz = previousAnalysis.formantsHz;
                        analysis.formantBandwidthsHz = previousAnalysis.formantBandwidthsHz;
                        analysis.formantIntensity = previousAnalysis.formantIntensity;
                        analysis.drawFormants = false;
                    }
                }
            }

            this.renderer.updateParameters({
                sampleRate: request.sampleRate,
                windowSize: config.fftSize,
            });
            this.spectrogramBuffer.enqueue(result.spectrogram);
            this.renderer.updateSpectrogram(this.spectrogramBuffer);
            const firstCentreSample = samplesStart + config.windowSize / 2;
            const firstTimeSeconds =
                request.endTimeSeconds -
                (request.samples.length - firstCentreSample) / request.sampleRate;
            this.pushAnalyses(
                result.analyses,
                firstTimeSeconds,
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

    private pushAnalyses(
        analyses: AcousticAnalysis[],
        firstTime: number,
        hopSize: number,
        sampleRate: number
    ) {
        for (let index = 0; index < analyses.length; index += 1) {
            this.analysisHistory.push({
                ...analyses[index],
                timeSeconds: firstTime + (index * hopSize) / sampleRate,
            });
        }
        if (this.analysisHistory.length > this.spectrogramBuffer.width) {
            this.analysisHistory.splice(
                0,
                this.analysisHistory.length - this.spectrogramBuffer.width
            );
        }

        const latestAnalysis = analyses[analyses.length - 1];
        if (latestAnalysis === undefined) {
            return;
        }
        for (const analysis of analyses) {
            if (this.showIntensity) {
                this.statistics.intensityFrames += 1;
                this.statistics.intensityPowerSum += 10 ** (analysis.intensityDbSpl / 10);
            }
            if (this.showPitch) {
                this.statistics.pitchFrames += 1;
            }
            if (this.showPitch && analysis.pitchHz !== null) {
                this.statistics.voicedFrames += 1;
                this.statistics.pitchSum += analysis.pitchHz;
                this.statistics.pitchMin = Math.min(this.statistics.pitchMin, analysis.pitchHz);
                this.statistics.pitchMax = Math.max(this.statistics.pitchMax, analysis.pitchHz);
            }
        }
        this.sessionElapsedSeconds = firstTime + ((analyses.length - 1) * hopSize) / sampleRate;
        this.overlayDirty = true;
        this.updateUiSnapshot(latestAnalysis);
    }

    private updateUiSnapshot(analysis: AcousticAnalysis, force: boolean = false) {
        const now = performance.now();
        if (!force && now - this.lastUiUpdate < 90) {
            return;
        }
        this.lastUiUpdate = now;
        const voiced = this.statistics.voicedFrames;
        const pitchFrames = this.statistics.pitchFrames;
        const intensityFrames = this.statistics.intensityFrames;
        const snapshot: LiveSnapshot = {
            elapsedSeconds: this.sessionElapsedSeconds,
            pitchHz: analysis.pitchHz,
            intensityDbSpl: analysis.intensityDbSpl,
            formantsHz: analysis.formantsHz,
            meanPitchHz: voiced ? this.statistics.pitchSum / voiced : null,
            minPitchHz: voiced ? this.statistics.pitchMin : null,
            maxPitchHz: voiced ? this.statistics.pitchMax : null,
            meanIntensityDbSpl: intensityFrames
                ? 10 * Math.log10(this.statistics.intensityPowerSum / intensityFrames)
                : null,
            voicedPercent: pitchFrames ? (100 * voiced) / pitchFrames : 0,
            sampleRate: this.sampleRate,
        };
        this.ui.updateSnapshot(snapshot);
    }

    private updateSnapshotAtPlaybackOffset(force: boolean = false) {
        const item = this.activeMedia();
        if (item === null || this.analysisHistory.length === 0) {
            return;
        }
        const snapshotIndex = clamp(
            Math.round(
                (this.playbackOffsetSeconds / Math.max(0.001, item.durationSeconds)) *
                    (this.analysisHistory.length - 1)
            ),
            0,
            this.analysisHistory.length - 1
        );
        const point = this.analysisHistory[snapshotIndex];
        this.sessionElapsedSeconds = this.playbackOffsetSeconds;
        this.updateUiSnapshot(point, force);
    }

    private resetSession() {
        this.clearReturnView();
        this.statistics = emptyStatistics();
        this.liveAnalysisBatchSequence = 0;
        this.sessionElapsedSeconds = 0;
        this.lastUiUpdate = 0;
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
        this.selection = null;
        this.playbackRange = null;
        this.ui.updateSelection(null);
        this.spectrogramBuffer.clear();
        if (!this.isRecordingMicrophone) {
            this.waveformRenderer.clear();
        }
        this.renderer.updateSpectrogram(this.spectrogramBuffer, true);
        this.timeOffset = 0;
        this.renderer.updateParameters({ timeOffset: 0 });
        this.ui.updateTimeOffset(0);
        this.overlayDirty = true;
    }

    private clearReturnView() {
        if (this.returnView === null) {
            return;
        }
        this.returnView = null;
        this.ui.updateReturnViewAvailable(false);
    }

    private resize() {
        const width = Math.max(1, this.stage.clientWidth);
        const height = Math.max(1, this.stage.clientHeight);
        const waveformWidth = Math.max(1, this.waveformStage.clientWidth);
        const waveformHeight = Math.max(1, this.waveformStage.clientHeight);
        const pixelRatio = this.renderPixelRatio;
        this.renderer.resizeCanvas(Math.round(width * pixelRatio), Math.round(height * pixelRatio));
        this.overlay.width = Math.round(width * pixelRatio);
        this.overlay.height = Math.round(height * pixelRatio);
        this.overlay.style.width = `${width}px`;
        this.overlay.style.height = `${height}px`;
        this.waveformRenderer.resize(
            Math.round(waveformWidth * pixelRatio),
            Math.round(waveformHeight * pixelRatio)
        );
        this.renderer.updateSpectrogram(this.spectrogramBuffer, true);
        this.overlayDirty = true;
    }

    private renderLoop(timestamp: number = performance.now()) {
        const frameInterval =
            this.renderFramesPerSecond === 0 ? 0 : 1000 / this.renderFramesPerSecond;
        if (timestamp - this.lastRenderTime >= frameInterval) {
            this.lastRenderTime =
                frameInterval === 0
                    ? timestamp
                    : timestamp - ((timestamp - this.lastRenderTime) % frameInterval);
            if (this.spectrogramVisible) {
                this.renderer.render();
            }
            if (this.spectrogramVisible && this.overlayDirty) {
                this.drawOverlay();
                this.overlayDirty = false;
            }
            if (this.waveformVisible) {
                const visible = this.visibleTimeRange();
                this.waveformRenderer.render({
                    viewStartSeconds: visible.startSeconds,
                    viewEndSeconds: visible.endSeconds,
                    selection: this.selection,
                });
            }
        }
        requestAnimationFrame((nextTimestamp) => this.renderLoop(nextTimestamp));
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

    private visibleTimeRange() {
        const visible = this.visibleHistoryRange();
        const item = this.activeMedia();
        const cache = item?.modes[this.mode];
        const config = modeConfiguration(this.mode, this.sampleRate, this.customWindowLengthMs);
        const hopSeconds =
            cache === undefined || item === null
                ? config.hopSize / this.sampleRate
                : cache.windowStepSize / item.sampleRate;
        const lastVisiblePoint = this.analysisHistory[Math.max(0, visible.end - 1)];
        const endSeconds =
            lastVisiblePoint === undefined
                ? this.sessionElapsedSeconds
                : lastVisiblePoint.timeSeconds + hopSeconds / 2;
        return {
            startSeconds: endSeconds - visible.span * hopSeconds,
            endSeconds,
        };
    }

    private analysisIndexAtTime(timeSeconds: number) {
        if (this.analysisHistory.length === 0) {
            return 0;
        }
        let low = 0;
        let high = this.analysisHistory.length - 1;
        while (low < high) {
            const middle = Math.floor((low + high) / 2);
            if (this.analysisHistory[middle].timeSeconds < timeSeconds) {
                low = middle + 1;
            } else {
                high = middle;
            }
        }
        if (
            low > 0 &&
            Math.abs(this.analysisHistory[low - 1].timeSeconds - timeSeconds) <
                Math.abs(this.analysisHistory[low].timeSeconds - timeSeconds)
        ) {
            return low - 1;
        }
        return low;
    }

    private drawOverlay() {
        const ctx = this.overlay.getContext('2d');
        if (!ctx) {
            return;
        }
        const width = this.overlay.width;
        const height = this.overlay.height;
        const selectionTheme = getPlotSelectionTheme(this.spectrogramThemeName);
        ctx.clearRect(0, 0, width, height);
        const visible = this.visibleHistoryRange();
        if (visible.end <= visible.start) {
            return;
        }

        const visibleTime = this.visibleTimeRange();
        const xForTime = (seconds: number) =>
            ((seconds - visibleTime.startSeconds) /
                Math.max(0.001, visibleTime.endSeconds - visibleTime.startSeconds)) *
            width;
        const xForIndex = (index: number) => xForTime(this.analysisHistory[index].timeSeconds);
        const frequencyY = (frequency: number) => {
            const min = this.renderParameters.minFrequencyHz || 0;
            const max = this.renderParameters.maxFrequencyHz || 5500;
            const scale = this.renderParameters.scale || 'linear';
            return (
                height *
                (1 -
                    (frequencyToScale(frequency, scale) - frequencyToScale(min, scale)) /
                        Math.max(1e-9, frequencyToScale(max, scale) - frequencyToScale(min, scale)))
            );
        };

        if (this.showFormants) {
            const colors = ['#ff4f72', '#ff755e', '#ff9e61', '#ffc86b', '#ffe39a', '#fff0c7'];
            let maximumVisibleFormantIntensity = 0;
            for (let index = visible.start; index < visible.end; index += 1) {
                if (this.analysisHistory[index].drawFormants) {
                    maximumVisibleFormantIntensity = Math.max(
                        maximumVisibleFormantIntensity,
                        this.analysisHistory[index].formantIntensity
                    );
                }
            }
            const minimumVisibleFormantIntensity =
                maximumVisibleFormantIntensity === 0 ||
                this.layerDisplayOptions.formantDynamicRangeDb <= 0
                    ? 0
                    : maximumVisibleFormantIntensity /
                      10 ** (this.layerDisplayOptions.formantDynamicRangeDb / 10);
            const formantCount = Math.min(
                this.layerDisplayOptions.formantsToDisplay,
                this.analysisHistory[visible.end - 1]?.formantsHz.length || 0
            );
            for (let formantIndex = 0; formantIndex < formantCount; formantIndex += 1) {
                ctx.fillStyle = colors[formantIndex % colors.length];
                for (let index = visible.start; index < visible.end; index += 1) {
                    const formant = this.analysisHistory[index].formantsHz[formantIndex];
                    const withinDynamicRange =
                        this.analysisHistory[index].formantIntensity >=
                        minimumVisibleFormantIntensity;
                    if (
                        this.analysisHistory[index].drawFormants &&
                        formant !== null &&
                        withinDynamicRange
                    ) {
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
                (pitch) => frequencyY(pitch),
                '#2588ff',
                this.layerDisplayOptions.pitchLineWidth
            );
        }

        if (this.showIntensity) {
            this.strokeSeries(
                ctx,
                visible.start,
                visible.end,
                xForIndex,
                (point) => point.intensityDbSpl,
                (intensity) =>
                    height *
                    (1 -
                        (intensity - this.layerDisplayOptions.intensityFloorDbSpl) /
                            (this.layerDisplayOptions.intensityCeilingDbSpl -
                                this.layerDisplayOptions.intensityFloorDbSpl)),
                '#f4df22',
                this.layerDisplayOptions.intensityLineWidth
            );
        }

        if (this.selection !== null) {
            const rawSelectionLeft = xForTime(this.selection.startSeconds);
            const rawSelectionRight = xForTime(this.selection.endSeconds);
            const selectionLeft = clamp(rawSelectionLeft, 0, width);
            const selectionRight = clamp(rawSelectionRight, 0, width);
            if (rawSelectionRight >= 0 && rawSelectionLeft <= width) {
                ctx.save();
                ctx.fillStyle = selectionTheme.fill;
                ctx.fillRect(selectionLeft, 0, Math.max(1, selectionRight - selectionLeft), height);
                ctx.strokeStyle = selectionTheme.stroke;
                ctx.lineWidth = 1;
                ctx.setLineDash([4, 4]);
                ctx.beginPath();
                ctx.moveTo(selectionLeft, 0);
                ctx.lineTo(selectionLeft, height);
                ctx.moveTo(selectionRight, 0);
                ctx.lineTo(selectionRight, height);
                ctx.stroke();
                ctx.restore();
            }
        }

        if (this.inspector !== null) {
            ctx.save();
            const inspectorIndex = clamp(
                Math.floor(
                    visible.start + this.inspector.x * Math.max(1, visible.end - visible.start)
                ),
                visible.start,
                Math.max(visible.start, visible.end - 1)
            );
            const inspectorPitch = this.analysisHistory[inspectorIndex]?.pitchHz;
            if (this.showPitch && inspectorPitch !== null && inspectorPitch !== undefined) {
                const pitchY = frequencyY(inspectorPitch);
                if (pitchY >= 0 && pitchY <= height) {
                    ctx.strokeStyle = 'rgba(61, 151, 255, 0.72)';
                    ctx.lineWidth = 0.75;
                    ctx.setLineDash([2, 3]);
                    ctx.beginPath();
                    ctx.moveTo(this.inspector.x * width, this.inspector.y * height);
                    ctx.lineTo(this.inspector.x * width, pitchY);
                    ctx.stroke();
                }
            }
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

function encodeWav(samples: Float32Array, sampleRate: number) {
    const bytesPerSample = 2;
    const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
    const view = new DataView(buffer);
    const writeText = (offset: number, value: string) => {
        for (let index = 0; index < value.length; index += 1) {
            view.setUint8(offset + index, value.charCodeAt(index));
        }
    };
    writeText(0, 'RIFF');
    view.setUint32(4, 36 + samples.length * bytesPerSample, true);
    writeText(8, 'WAVE');
    writeText(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * bytesPerSample, true);
    view.setUint16(32, bytesPerSample, true);
    view.setUint16(34, bytesPerSample * 8, true);
    writeText(36, 'data');
    view.setUint32(40, samples.length * bytesPerSample, true);
    for (let index = 0; index < samples.length; index += 1) {
        const sample = clamp(samples[index], -1, 1);
        view.setInt16(
            44 + index * bytesPerSample,
            sample < 0 ? sample * 32768 : sample * 32767,
            true
        );
    }
    return new Blob([buffer], { type: 'audio/wav' });
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
    onSpectrogramAnalysisChange: (settings) => engine?.setSpectrogramAnalysis(settings),
    onPitchAlgorithmChange: (algorithm) => engine?.setPitchAlgorithm(algorithm),
    onAnalysisChange: (parameters) => engine?.updateAnalysis(parameters),
    onLayerDisplayChange: (parameters) => engine?.updateLayerDisplay(parameters),
    onDisplayChange: (parameters) => engine?.updateDisplay(parameters),
    onPerformanceChange: (settings) => engine?.updatePerformance(settings),
    onOverlayChange: (pitch, formants, intensity) =>
        engine?.setOverlays(pitch, formants, intensity),
    onPlotVisibilityChange: (waveform, spectrogram) =>
        engine?.setPlotVisibility(waveform, spectrogram),
    onPlotThemeChange: (spectrogramThemeName, waveformThemeName) =>
        engine?.setPlotThemes(spectrogramThemeName, waveformThemeName),
    onWaveformDisplayChange: (parameters) => engine?.updateWaveformDisplay(parameters),
    onInspect: (x, y) => engine?.inspect(x, y),
    onSelectRange: (xStart, xEnd) => engine?.selectRange(xStart, xEnd),
    onNavigate: (amount) => engine?.navigate(amount),
    onSelectMedia: (id) => engine?.selectMedia(id),
    onToggleMediaPlayback: () => engine?.toggleMediaPlayback(),
    onStartMediaAudition: (playbackRate, direction) =>
        engine?.startMediaAudition(playbackRate, direction),
    onPauseMediaPlayback: () => engine?.pauseMediaPlayback(),
    onPlayMediaAt: (xRatio) => engine?.playMediaAt(xRatio),
    onFitSelection: () => engine?.fitSelection(),
    onReturnView: () => engine?.returnToPreviousView(),
    onRestoreView: () => engine?.restoreView(),
    onSeekMedia: (seconds) => engine?.seekMedia(seconds),
    onRenameMedia: (id, name) => engine?.renameMedia(id, name),
    onSaveMedia: (id) => engine?.saveMedia(id),
    onRemoveMedia: (id) => engine?.removeMedia(id),
    onClearPlaylist: () => engine?.clearPlaylist(),
});
engine = new SpectroEngine(ui);
