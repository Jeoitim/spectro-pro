import {
    AcousticAnalysis,
    analyzeFormantFrames,
    analyzePitchAndIntensityFrame,
    AnalysisOptions,
    FormantFrameAnalysis,
    TimedAcousticAnalysis,
} from '../analysis';
import { generateSpectrogram } from '../spectrogram';
import {
    ACTION_ANALYZE_OFFLINE,
    ACTION_COMPUTE_SPECTROGRAM,
    AnalyzeOfflineMessage,
    ComputeSpectrogramMessage,
    Message,
} from '../worker-constants';

const workerScope = (self as unknown) as DedicatedWorkerGlobalScope;

function nearestFormantFrame(
    frames: FormantFrameAnalysis[],
    timeSeconds: number
): FormantFrameAnalysis | null {
    if (frames.length === 0) {
        return null;
    }
    if (frames.length === 1) {
        return frames[0];
    }
    const step = frames[1].timeSeconds - frames[0].timeSeconds;
    const index = Math.max(
        0,
        Math.min(frames.length - 1, Math.round((timeSeconds - frames[0].timeSeconds) / step))
    );
    return frames[index];
}

function analyzeAtCentres(
    samples: Float32Array,
    sampleRate: number,
    centreSamples: number[],
    analysisOptions: AnalysisOptions
) {
    const formantFrames = analyzeFormantFrames(samples, sampleRate, analysisOptions);
    const analyses: AcousticAnalysis[] = centreSamples.map((centreSample) => {
        const pitchAndIntensity = analyzePitchAndIntensityFrame(
            samples,
            sampleRate,
            analysisOptions,
            centreSample
        );
        const formants = nearestFormantFrame(formantFrames, centreSample / sampleRate);
        return {
            ...pitchAndIntensity,
            formantsHz:
                formants?.formantsHz ||
                new Array(Math.ceil(analysisOptions.maximumFormants)).fill(null),
            formantBandwidthsHz:
                formants?.formantBandwidthsHz ||
                new Array(Math.ceil(analysisOptions.maximumFormants)).fill(null),
            formantIntensity: formants?.formantIntensity || 0,
            drawFormants: false,
        };
    });

    if (centreSamples.length > 0) {
        const firstCentre = centreSamples[0];
        const centreStep =
            centreSamples.length > 1
                ? centreSamples[1] - centreSamples[0]
                : Math.max(
                      1,
                      Math.round((analysisOptions.formantWindowLengthSeconds / 4) * sampleRate)
                  );
        for (const frame of formantFrames) {
            const nearestAnalysisIndex = Math.round(
                (frame.timeSeconds * sampleRate - firstCentre) / centreStep
            );
            if (
                nearestAnalysisIndex >= 0 &&
                nearestAnalysisIndex < analyses.length &&
                Math.abs(centreSamples[nearestAnalysisIndex] - frame.timeSeconds * sampleRate) <=
                    centreStep / 2 + 1
            ) {
                analyses[nearestAnalysisIndex] = {
                    ...analyses[nearestAnalysisIndex],
                    formantsHz: frame.formantsHz,
                    formantBandwidthsHz: frame.formantBandwidthsHz,
                    formantIntensity: frame.formantIntensity,
                    drawFormants: true,
                };
            }
        }
    }
    return analyses;
}

workerScope.addEventListener('message', (event: { data: Message['request'] }) => {
    const {
        data: { action, payload },
    } = event;

    switch (action) {
        case ACTION_COMPUTE_SPECTROGRAM: {
            const {
                samplesBuffer,
                samplesStart,
                samplesLength,
                options,
                analysisOptions,
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
                    analysisOptions
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
