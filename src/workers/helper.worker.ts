import {
    AcousticAnalysis,
    AnalysisComputationCadence,
    AnalysisLayerSelection,
    analyzeFormantsAtTimes,
    analyzePitchAndIntensityFrame,
    AnalysisOptions,
    TimedAcousticAnalysis,
} from '../analysis';
import { detectPulseTimes } from '../pulse-analysis';
import { generateSpectrogram } from '../spectrogram';
import { initializeAcousticWasm } from '../wasm-acoustic';
import {
    ACTION_ANALYZE_ACOUSTICS,
    ACTION_ANALYZE_OFFLINE,
    ACTION_COMPUTE_SPECTROGRAM,
    ACTION_COMPUTE_SPECTROGRAM_ONLY,
    ACTION_PREPARE_ACOUSTIC_WASM,
    AnalyzeAcousticsMessage,
    AnalyzeOfflineMessage,
    ComputeSpectrogramMessage,
    ComputeSpectrogramOnlyMessage,
    Message,
    PrepareAcousticWasmRequest,
} from '../worker-constants';

const workerScope = (self as unknown) as DedicatedWorkerGlobalScope;
let acousticWasmReady: Promise<boolean> | null = null;

function prepareAcousticWasm() {
    if (acousticWasmReady === null) {
        acousticWasmReady = initializeAcousticWasm();
    }
    return acousticWasmReady;
}

function analyzeAtCentres(
    samples: Float32Array,
    sampleRate: number,
    centreSamples: number[],
    analysisOptions: AnalysisOptions,
    layers: AnalysisLayerSelection = {
        pitch: true,
        formants: true,
        intensity: true,
    },
    cadence: AnalysisComputationCadence = {
        pitchStride: 1,
        formantStride: 1,
    }
) {
    const pitchStride = Math.max(1, Math.round(cadence.pitchStride));
    const formantStride = Math.max(1, Math.round(cadence.formantStride));
    const formantCentreSamples = centreSamples.filter((_, index) => index % formantStride === 0);
    const formantFrames = layers.formants
        ? analyzeFormantsAtTimes(
              samples,
              sampleRate,
              formantCentreSamples.map((centreSample) => centreSample / sampleRate),
              analysisOptions
          )
        : [];
    let recentPitchHz: number | null = null;
    let recentPitchConfidence = 0;
    return centreSamples.map(
        (centreSample, centreIndex): AcousticAnalysis => {
            const calculatePitch = layers.pitch && centreIndex % pitchStride === 0;
            const pitchAndIntensity = analyzePitchAndIntensityFrame(
                samples,
                sampleRate,
                analysisOptions,
                centreSample,
                {
                    pitch: calculatePitch,
                    intensity: layers.intensity,
                }
            );
            if (calculatePitch) {
                recentPitchHz = pitchAndIntensity.pitchHz;
                recentPitchConfidence = pitchAndIntensity.pitchConfidence;
            } else if (layers.pitch) {
                pitchAndIntensity.pitchHz = recentPitchHz;
                pitchAndIntensity.pitchConfidence = recentPitchConfidence;
            }
            const formants = formantFrames[Math.floor(centreIndex / formantStride)];
            return {
                ...pitchAndIntensity,
                formantsHz:
                    formants?.formantsHz ||
                    new Array(Math.ceil(analysisOptions.maximumFormants)).fill(null),
                formantBandwidthsHz:
                    formants?.formantBandwidthsHz ||
                    new Array(Math.ceil(analysisOptions.maximumFormants)).fill(null),
                formantIntensity: formants?.formantIntensity || 0,
                drawFormants:
                    layers.formants &&
                    centreIndex % formantStride === 0 &&
                    (formants?.formantIntensity || 0) > 0,
            };
        }
    );
}

async function handleWorkerMessage(event: {
    data: Message['request'] | PrepareAcousticWasmRequest;
}) {
        const {
            data: { action, payload },
        } = event;

        if (action === ACTION_PREPARE_ACOUSTIC_WASM) {
            const { module, responsePort } = payload as PrepareAcousticWasmRequest['payload'];
            if (acousticWasmReady === null) {
                acousticWasmReady = initializeAcousticWasm(module);
            }
            responsePort?.postMessage(await acousticWasmReady);
            responsePort?.close();
            return;
        }

        if (action !== ACTION_COMPUTE_SPECTROGRAM_ONLY) {
            try {
                await prepareAcousticWasm();
            } catch (error) {
                workerScope.postMessage({
                    error: error instanceof Error ? error : new Error(String(error)),
                });
                return;
            }
        }

        switch (action) {
            case ACTION_ANALYZE_ACOUSTICS: {
                const {
                    samplesBuffer,
                    sampleRate,
                    centreSamples,
                    analysisOptions,
                    includeFormants,
                    analysisLayers,
                } = payload as AnalyzeAcousticsMessage['request']['payload'];
                try {
                    const samples = new Float32Array(samplesBuffer);
                    const analyses = analyzeAtCentres(
                        samples,
                        sampleRate,
                        centreSamples,
                        analysisOptions,
                        analysisLayers || {
                            pitch: true,
                            formants: includeFormants,
                            intensity: true,
                        }
                    );
                    const timedPitch = analyses.map((analysis, index) => ({
                        ...analysis,
                        timeSeconds: centreSamples[index] / sampleRate,
                    }));
                    const response: AnalyzeAcousticsMessage['response'] = {
                        payload: {
                            inputBuffer: samples.buffer,
                            analyses,
                            pulseTimes:
                                analysisLayers?.pitch === false
                                    ? []
                                    : detectPulseTimes(samples, sampleRate, timedPitch),
                        },
                    };
                    workerScope.postMessage(response, [samples.buffer as ArrayBuffer]);
                } catch (error) {
                    const response: AnalyzeAcousticsMessage['response'] = {
                        error: error instanceof Error ? error : new Error(String(error)),
                    };
                    workerScope.postMessage(response);
                }
                break;
            }
            case ACTION_COMPUTE_SPECTROGRAM: {
                const {
                    samplesBuffer,
                    samplesStart,
                    samplesLength,
                    options,
                    analysisOptions,
                    analysisLayers,
                    analysisCadence,
                } = payload as ComputeSpectrogramMessage['request']['payload'];

                try {
                    const samples = new Float32Array(samplesBuffer);
                    const {
                        windowCount: spectrogramWindowCount,
                        options: spectrogramOptions,
                        spectrogram,
                    } = generateSpectrogram(samples, samplesStart, samplesLength, options);
                    const centreSamples = new Array(spectrogramWindowCount)
                        .fill(0)
                        .map(
                            (_, windowIndex) =>
                                samplesStart +
                                windowIndex * spectrogramOptions.windowStepSize +
                                spectrogramOptions.windowSize / 2
                        );
                    const analyses = analyzeAtCentres(
                        samples,
                        options.sampleRate,
                        centreSamples,
                        analysisOptions,
                        analysisLayers,
                        analysisCadence
                    );
                    const timedPitch = analyses.map((analysis, index) => ({
                        ...analysis,
                        timeSeconds: centreSamples[index] / options.sampleRate,
                    }));

                    const response: ComputeSpectrogramMessage['response'] = {
                        payload: {
                            spectrogramWindowCount,
                            spectrogramOptions,
                            spectrogramBuffer: spectrogram.buffer,
                            inputBuffer: samples.buffer,
                            analyses,
                            pulseTimes: detectPulseTimes(samples, options.sampleRate, timedPitch),
                        },
                    };
                    workerScope.postMessage(response, [
                        spectrogram.buffer as ArrayBuffer,
                        samples.buffer as ArrayBuffer,
                    ]);
                } catch (error) {
                    const response: ComputeSpectrogramMessage['response'] = {
                        error: error instanceof Error ? error : new Error(String(error)),
                    };
                    workerScope.postMessage(response);
                }

                break;
            }
            case ACTION_COMPUTE_SPECTROGRAM_ONLY: {
                const {
                    samplesBuffer,
                    samplesStart,
                    samplesLength,
                    options,
                } = payload as ComputeSpectrogramOnlyMessage['request']['payload'];
                try {
                    const result = generateSpectrogram(
                        new Float32Array(samplesBuffer),
                        samplesStart,
                        samplesLength,
                        options
                    );
                    const response: ComputeSpectrogramOnlyMessage['response'] = {
                        payload: {
                            spectrogramWindowCount: result.windowCount,
                            spectrogramOptions: result.options,
                            spectrogramBuffer: result.spectrogram.buffer,
                        },
                    };
                    workerScope.postMessage(response, [result.spectrogram.buffer as ArrayBuffer]);
                } catch (error) {
                    const response: ComputeSpectrogramOnlyMessage['response'] = {
                        error: error instanceof Error ? error : new Error(String(error)),
                    };
                    workerScope.postMessage(response);
                }
                break;
            }
            case ACTION_ANALYZE_OFFLINE: {
                const {
                    samplesBuffer,
                    samplesStart,
                    samplesLength,
                    sampleOffset,
                    options,
                    analysisOptions,
                } = payload as AnalyzeOfflineMessage['request']['payload'];
                try {
                    const samples = new Float32Array(samplesBuffer);
                    const result = generateSpectrogram(
                        samples,
                        samplesStart,
                        samplesLength,
                        options
                    );
                    const analysisPadding = Math.max(
                        options.windowSize || 0,
                        Math.ceil(0.08 * options.sampleRate)
                    );
                    const analysisStart = Math.max(0, samplesStart - analysisPadding);
                    const analysisEnd = Math.min(
                        samples.length,
                        samplesStart + samplesLength + analysisPadding
                    );
                    const analysisSamples = samples.subarray(analysisStart, analysisEnd);
                    const centreSamples = new Array(result.windowCount)
                        .fill(0)
                        .map(
                            (_, windowIndex) =>
                                samplesStart +
                                windowIndex * result.options.windowStepSize +
                                result.options.windowSize / 2
                        );
                    const analyses: TimedAcousticAnalysis[] = analyzeAtCentres(
                        analysisSamples,
                        options.sampleRate,
                        centreSamples.map((centreSample) => centreSample - analysisStart),
                        analysisOptions
                    ).map((analysis, index) => ({
                        ...analysis,
                        timeSeconds: (centreSamples[index] + sampleOffset) / options.sampleRate,
                    }));
                    const pulseTimes = detectPulseTimes(
                        analysisSamples,
                        options.sampleRate,
                        analyses.map((analysis) => ({
                            ...analysis,
                            timeSeconds:
                                analysis.timeSeconds -
                                analysisStart / options.sampleRate -
                                sampleOffset / options.sampleRate,
                        }))
                    ).map(
                        (time) =>
                            time +
                            analysisStart / options.sampleRate +
                            sampleOffset / options.sampleRate
                    );

                    const response: AnalyzeOfflineMessage['response'] = {
                        payload: {
                            spectrogramWindowCount: result.windowCount,
                            spectrogramOptions: result.options,
                            spectrogramBuffer: result.spectrogram.buffer,
                            inputBuffer: samples.buffer,
                            analyses,
                            pulseTimes,
                        },
                    };
                    workerScope.postMessage(response, [
                        result.spectrogram.buffer as ArrayBuffer,
                        samples.buffer as ArrayBuffer,
                    ]);
                } catch (error) {
                    const response: AnalyzeOfflineMessage['response'] = {
                        error: error instanceof Error ? error : new Error(String(error)),
                    };
                    workerScope.postMessage(response);
                }
                break;
            }
            default:
                workerScope.postMessage({
                    error: new Error('Unknown action'),
                });
                break;
        }
}

let pendingWorkerMessage = Promise.resolve();
workerScope.addEventListener('message', (event) => {
    pendingWorkerMessage = pendingWorkerMessage
        .then(() => handleWorkerMessage(event))
        .catch((error) => {
            workerScope.postMessage({
                error: error instanceof Error ? error : new Error(String(error)),
            });
        });
});
