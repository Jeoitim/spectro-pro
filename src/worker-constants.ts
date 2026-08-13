import {
    AcousticAnalysis,
    AnalysisComputationCadence,
    AnalysisLayerSelection,
    AnalysisOptions,
    TimedAcousticAnalysis,
} from './analysis';
import { SpectrogramOptions, SpectrogramResult } from './spectrogram';

export const ACTION_COMPUTE_SPECTROGRAM = 'spectrogram-compute';
export const ACTION_COMPUTE_SPECTROGRAM_ONLY = 'spectrogram-only-compute';
export const ACTION_ANALYZE_OFFLINE = 'offline-analyze';
export const ACTION_ANALYZE_ACOUSTICS = 'acoustics-analyze';
export const ACTION_PREPARE_ACOUSTIC_WASM = 'acoustic-wasm-prepare';

export interface PrepareAcousticWasmRequest {
    action: typeof ACTION_PREPARE_ACOUSTIC_WASM;
    payload: {
        module: WebAssembly.Module;
        responsePort?: MessagePort;
    };
}

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
        analysisOptions: AnalysisOptions;
        analysisLayers: AnalysisLayerSelection;
        analysisCadence: AnalysisComputationCadence;
    },
    {
        spectrogramWindowCount: number;
        spectrogramOptions: Required<SpectrogramOptions>;
        spectrogramBuffer: ArrayBufferLike;
        inputBuffer: ArrayBufferLike;
        analyses: AcousticAnalysis[];
        pulseTimes: number[];
    }
>;

export type AnalyzeOfflineMessage = MessageBase<
    typeof ACTION_ANALYZE_OFFLINE,
    {
        samplesBuffer: ArrayBufferLike;
        samplesStart: number;
        samplesLength: number;
        sampleOffset: number;
        options: SpectrogramOptions;
        analysisOptions: AnalysisOptions;
    },
    {
        spectrogramWindowCount: number;
        spectrogramOptions: Required<SpectrogramOptions>;
        spectrogramBuffer: ArrayBufferLike;
        inputBuffer: ArrayBufferLike;
        analyses: TimedAcousticAnalysis[];
        pulseTimes: number[];
    }
>;

export type ComputeSpectrogramOnlyMessage = MessageBase<
    typeof ACTION_COMPUTE_SPECTROGRAM_ONLY,
    {
        samplesBuffer: ArrayBufferLike;
        samplesStart: number;
        samplesLength: number;
        options: SpectrogramOptions;
    },
    {
        spectrogramWindowCount: number;
        spectrogramOptions: Required<SpectrogramOptions>;
        spectrogramBuffer: ArrayBufferLike;
    }
>;

export type AnalyzeAcousticsMessage = MessageBase<
    typeof ACTION_ANALYZE_ACOUSTICS,
    {
        samplesBuffer: ArrayBufferLike;
        sampleRate: number;
        centreSamples: number[];
        analysisOptions: AnalysisOptions;
        includeFormants: boolean;
        analysisLayers?: AnalysisLayerSelection;
    },
    {
        inputBuffer: ArrayBufferLike;
        analyses: AcousticAnalysis[];
        pulseTimes: number[];
    }
>;

export type Message =
    | ComputeSpectrogramMessage
    | ComputeSpectrogramOnlyMessage
    | AnalyzeOfflineMessage
    | AnalyzeAcousticsMessage;
