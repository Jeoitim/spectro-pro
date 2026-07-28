import { analyzeAcousticFrame, AnalysisOptions, TimedAcousticAnalysis } from '../analysis';
import { generateSpectrogram } from '../spectrogram';
import {
    ACTION_ANALYZE_OFFLINE,
    ACTION_COMPUTE_SPECTROGRAM,
    AnalyzeOfflineMessage,
    ComputeSpectrogramMessage,
    Message,
} from '../worker-constants';

self.addEventListener('message', (event: { data: Message['request'] }) => {
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
                analysisSamplesStart,
                analysisSamplesLength,
                analysisOptions,
            } = payload as ComputeSpectrogramMessage['request']['payload'];

            try {
                const samples = new Float32Array(samplesBuffer);
                const {
                    windowCount: spectrogramWindowCount,
                    options: spectrogramOptions,
                    spectrogram,
                } = generateSpectrogram(samples, samplesStart, samplesLength, options);
                const analysis = analyzeAcousticFrame(
                    samples.subarray(
                        analysisSamplesStart,
                        analysisSamplesStart + analysisSamplesLength
                    ),
                    options.sampleRate,
                    analysisOptions
                );

                const response: ComputeSpectrogramMessage['response'] = {
                    payload: {
                        spectrogramWindowCount,
                        spectrogramOptions,
                        spectrogramBuffer: spectrogram.buffer,
                        inputBuffer: samples.buffer,
                        analysis,
                    },
                };
                self.postMessage(response, [spectrogram.buffer, samples.buffer]);
            } catch (error) {
                const response: ComputeSpectrogramMessage['response'] = { error };
                self.postMessage(response);
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
                const analysisWindowLength = Math.max(64, Math.round(options.sampleRate * 0.085));
                const analyses: TimedAcousticAnalysis[] = [];
                for (let windowIndex = 0; windowIndex < result.windowCount; windowIndex += 1) {
                    const centreSample =
                        windowIndex * result.options.windowStepSize + result.options.windowSize / 2;
                    const analysisStart = Math.max(
                        0,
                        Math.round(centreSample - analysisWindowLength / 2)
                    );
                    const analysisEnd = Math.min(
                        samples.length,
                        analysisStart + analysisWindowLength
                    );
                    analyses.push({
                        ...analyzeAcousticFrame(
                            samples.subarray(analysisStart, analysisEnd),
                            options.sampleRate,
                            analysisOptions
                        ),
                        timeSeconds: centreSample / options.sampleRate,
                    });
                }

                const response: AnalyzeOfflineMessage['response'] = {
                    payload: {
                        spectrogramWindowCount: result.windowCount,
                        spectrogramOptions: result.options,
                        spectrogramBuffer: result.spectrogram.buffer,
                        inputBuffer: samples.buffer,
                        analyses,
                    },
                };
                self.postMessage(response, [result.spectrogram.buffer, samples.buffer]);
            } catch (error) {
                const response: AnalyzeOfflineMessage['response'] = { error };
                self.postMessage(response);
            }
            break;
        }
        default:
            self.postMessage({
                error: new Error('Unknown action'),
            });
            break;
    }
});
