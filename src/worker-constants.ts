import { AcousticAnalysis, AnalysisOptions } from './analysis';
import { SpectrogramOptions } from './spectrogram';

export const ACTION_COMPUTE_SPECTROGRAM = 'spectrogram-compute';

interface MessageBase<T, U, V> {
    request: {
        action: T;
        payload: U;
    };
    response: {
        payload?: V;
        error?: Error;
    };
}

export type ComputeSpectrogramMessage = MessageBase<
    typeof ACTION_COMPUTE_SPECTROGRAM,
    {
        samplesBuffer: ArrayBufferLike;
        samplesStart: number;
        samplesLength: number;
        options: SpectrogramOptions;
        analysisSamplesStart: number;
        analysisSamplesLength: number;
        analysisOptions: AnalysisOptions;
    },
    {
        spectrogramWindowCount: number;
        spectrogramOptions: Required<SpectrogramOptions>;
        spectrogramBuffer: ArrayBufferLike;
        inputBuffer: ArrayBufferLike;
        analysis: AcousticAnalysis;
    }
>;

export type Message = ComputeSpectrogramMessage;
