import { AcousticAnalysis, AnalysisOptions, TimedAcousticAnalysis } from './analysis';
import { SpectrogramOptions, SpectrogramResult } from './spectrogram';

export const ACTION_COMPUTE_SPECTROGRAM = 'spectrogram-compute';
export const ACTION_ANALYZE_OFFLINE = 'offline-analyze';

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

export type AnalyzeOfflineMessage = MessageBase<
    typeof ACTION_ANALYZE_OFFLINE,
    {
        samplesBuffer: ArrayBufferLike;
        options: SpectrogramOptions;
        analysisOptions: AnalysisOptions;
    },
    {
        spectrogramWindowCount: number;
        spectrogramOptions: Required<SpectrogramOptions>;
        spectrogramBuffer: ArrayBufferLike;
        inputBuffer: ArrayBufferLike;
        analyses: TimedAcousticAnalysis[];
    }
>;

export type Message = ComputeSpectrogramMessage | AnalyzeOfflineMessage;
