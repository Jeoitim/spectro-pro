import {
    AcousticAnalysis,
    AnalysisComputationCadence,
    AnalysisLayerSelection,
    analyzeFormantsAtTimes,
    analyzePitchAndIntensityFrame,
    AnalysisOptions,
    TimedAcousticAnalysis,
} from '../analysis';
import { generateSpectrogram } from '../spectrogram';
import {
    ACTION_ANALYZE_ACOUSTICS,
    ACTION_ANALYZE_OFFLINE,
    ACTION_COMPUTE_SPECTROGRAM,
    AnalyzeAcousticsMessage,
    AnalyzeOfflineMessage,
    ComputeSpectrogramMessage,
    Message,
} from '../worker-constants';

const workerScope = (self as unknown) as DedicatedWorkerGlobalScope;

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

workerScope.addEventListener('message', (event: { data: Message['request'] }) => {
    const {
        data: { action, payload },
    } = event;

    switch (action) {
        case ACTION_ANALYZE_ACOUSTICS: {
            const {
                samplesBuffer,
                sampleRate,
                centreSamples,
                analysisOptions,
                includeFormants,
            } = payload as AnalyzeAcousticsMessage['request']['payload'];
            try {
                const samples = new Float32Array(samplesBuffer);
                const analyses = analyzeAtCentres(
                    samples,
                    sampleRate,
                    centreSamples,
                    analysisOptions,
                    {
                        pitch: true,
                        formants: includeFormants,
                        intensity: true,
                    }
                );
                const response: AnalyzeAcousticsMessage['response'] = {
                    payload: {
                        inputBuffer: samples.buffer,
                        analyses,
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

                const response: ComputeSpectrogramMessage['response'] = {
                    payload: {
                        spectrogramWindowCount,
                        spectrogramOptions,
                        spectrogramBuffer: spectrogram.buffer,
                        inputBuffer: samples.buffer,
                        analyses,
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
        case ACTION_ANALYZE_OFFLINE: {
            const {
                samplesBuffer,
                options,
                analysisOptions,
            } = payload as AnalyzeOfflineMessage['request']['payload'];
            try {
                const samples = new Float32Array(samplesBuffer);
                const result = generateSpectrogram(samples, 0, samples.length, options);
                const centreSamples = new Array(result.windowCount)
                    .fill(0)
                    .map(
                        (_, windowIndex) =>
                            windowIndex * result.options.windowStepSize +
                            result.options.windowSize / 2
                    );
                const analyses: TimedAcousticAnalysis[] = analyzeAtCentres(
                    samples,
                    options.sampleRate,
                    centreSamples,
                    analysisOptions
                ).map((analysis, index) => ({
                    ...analysis,
                    timeSeconds: centreSamples[index] / options.sampleRate,
                }));

                const response: AnalyzeOfflineMessage['response'] = {
                    payload: {
                        spectrogramWindowCount: result.windowCount,
                        spectrogramOptions: result.options,
                        spectrogramBuffer: result.spectrogram.buffer,
                        inputBuffer: samples.buffer,
                        analyses,
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
});
