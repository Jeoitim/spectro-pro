import {
    AcousticAnalysis,
    AnalysisLayerSelection,
    AnalysisOptions,
    TimedAcousticAnalysis,
} from './analysis';
import { SpectrogramOptions, SpectrogramResult } from './spectrogram';
import {
    ACTION_ANALYZE_ACOUSTICS,
    ACTION_ANALYZE_OFFLINE,
    ACTION_COMPUTE_SPECTROGRAM,
    AnalyzeAcousticsMessage,
    AnalyzeOfflineMessage,
    ComputeSpectrogramMessage,
    Message,
} from './worker-constants';
import HelperWorker from 'helper-worker';

const WORKER_QUEUE: ((worker: HelperWorker) => void)[] = [];
const WORKER_POOL: { worker: HelperWorker; busy: boolean }[] = [];
for (let i = 0; i < (window.navigator.hardwareConcurrency || 4); i += 1) {
    WORKER_POOL.push({
        worker: new HelperWorker(),
        busy: false,
    });
}

function getFreeWorker(): Promise<HelperWorker> {
    const workerData = WORKER_POOL.find((w) => !w.busy);
    if (workerData !== undefined) {
        workerData.busy = true;
        return Promise.resolve(workerData.worker);
    }
    return new Promise((resolve) => {
        WORKER_QUEUE.push(resolve);
    });
}

function releaseWorker(worker: HelperWorker) {
    const workerData = WORKER_POOL.find((w) => w.worker === worker);
    if (workerData === undefined) {
        throw new Error('Provided worker to release is not valid');
    }

    workerData.busy = false;

    if (WORKER_QUEUE.length > 0) {
        const [next] = WORKER_QUEUE.splice(0, 1);
        workerData.busy = true;
        next(workerData.worker);
    }
}

function queueTask<T extends Message>(
    action: T['request']['action'],
    payload: T['request']['payload'],
    transfer: Transferable[]
): Promise<Required<T['response']>['payload']> {
    return new Promise((resolve, reject) => {
        getFreeWorker().then((worker) => {
            const messageHandler = (event: { data: T['response'] }) => {
                worker.removeEventListener('message', messageHandler);
                releaseWorker(worker);

                if ('error' in event.data) {
                    reject(event.data.error);
                    return;
                }
                resolve(event.data.payload);
            };

            worker.addEventListener('message', messageHandler);

            worker.postMessage(
                {
                    action,
                    payload,
                },
                transfer
            );
        });
    });
}

export function getWorkerCount(): number {
    return WORKER_POOL.length;
}

export async function offThreadGenerateSpectrogram(
    samples: Float32Array,
    samplesStart: number,
    samplesLength: number,
    options: SpectrogramOptions,
    analysisOptions: AnalysisOptions,
    analysisLayers: AnalysisLayerSelection
): Promise<SpectrogramResult & { input: Float32Array; analyses: AcousticAnalysis[] }> {
    const {
        spectrogramWindowCount,
        spectrogramOptions,
        spectrogramBuffer,
        inputBuffer,
        analyses,
    } = await queueTask<ComputeSpectrogramMessage>(
        ACTION_COMPUTE_SPECTROGRAM,
        {
            samplesBuffer: samples.buffer,
            samplesStart,
            samplesLength,
            options,
            analysisOptions,
            analysisLayers,
        },
        [samples.buffer]
    );

    return {
        windowCount: spectrogramWindowCount,
        options: spectrogramOptions,
        spectrogram: new Float32Array(spectrogramBuffer),
        input: new Float32Array(inputBuffer),
        analyses,
    };
}

export async function offThreadAnalyzeEntireFile(
    samples: Float32Array,
    options: SpectrogramOptions,
    analysisOptions: AnalysisOptions
): Promise<
    SpectrogramResult & {
        input: Float32Array;
        analyses: TimedAcousticAnalysis[];
    }
> {
    const {
        spectrogramWindowCount,
        spectrogramOptions,
        spectrogramBuffer,
        inputBuffer,
        analyses,
    } = await queueTask<AnalyzeOfflineMessage>(
        ACTION_ANALYZE_OFFLINE,
        {
            samplesBuffer: samples.buffer,
            options,
            analysisOptions,
        },
        [samples.buffer]
    );

    return {
        windowCount: spectrogramWindowCount,
        options: spectrogramOptions,
        spectrogram: new Float32Array(spectrogramBuffer),
        input: new Float32Array(inputBuffer),
        analyses,
    };
}

export async function offThreadAnalyzeAcoustics(
    samples: Float32Array,
    sampleRate: number,
    centreSamples: number[],
    analysisOptions: AnalysisOptions,
    includeFormants: boolean
): Promise<{ input: Float32Array; analyses: AcousticAnalysis[] }> {
    const { inputBuffer, analyses } = await queueTask<AnalyzeAcousticsMessage>(
        ACTION_ANALYZE_ACOUSTICS,
        {
            samplesBuffer: samples.buffer,
            sampleRate,
            centreSamples,
            analysisOptions,
            includeFormants,
        },
        [samples.buffer]
    );

    return {
        input: new Float32Array(inputBuffer),
        analyses,
    };
}
