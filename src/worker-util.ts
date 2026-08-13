import {
    AcousticAnalysis,
    AnalysisComputationCadence,
    AnalysisLayerSelection,
    AnalysisOptions,
    TimedAcousticAnalysis,
} from './analysis';
import { SpectrogramOptions, SpectrogramResult } from './spectrogram';
import {
    ACTION_ANALYZE_ACOUSTICS,
    ACTION_ANALYZE_OFFLINE,
    ACTION_COMPUTE_SPECTROGRAM,
    ACTION_COMPUTE_SPECTROGRAM_ONLY,
    AnalyzeAcousticsMessage,
    AnalyzeOfflineMessage,
    ComputeSpectrogramMessage,
    ComputeSpectrogramOnlyMessage,
    Message,
} from './worker-constants';
import HelperWorker from 'helper-worker';

const WORKER_QUEUE: ((worker: HelperWorker) => void)[] = [];
const WORKER_LIMIT = Math.min(6, Math.max(2, (window.navigator.hardwareConcurrency || 4) - 1));
const WORKER_POOL: { worker: HelperWorker; busy: boolean }[] = [];
const WORKER_TASK_TIMEOUT_MS = 120_000;

function createWorker() {
    const workerData = { worker: new HelperWorker(), busy: true };
    WORKER_POOL.push(workerData);
    return workerData.worker;
}

function getFreeWorker(): Promise<HelperWorker> {
    const workerData = WORKER_POOL.find((w) => !w.busy);
    if (workerData !== undefined) {
        workerData.busy = true;
        return Promise.resolve(workerData.worker);
    }
    if (WORKER_POOL.length < WORKER_LIMIT) {
        return Promise.resolve(createWorker());
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

function retireWorker(worker: HelperWorker) {
    const workerIndex = WORKER_POOL.findIndex((entry) => entry.worker === worker);
    if (workerIndex !== -1) {
        WORKER_POOL.splice(workerIndex, 1);
    }
    worker.terminate();

    if (WORKER_QUEUE.length > 0) {
        const [next] = WORKER_QUEUE.splice(0, 1);
        next(createWorker());
    }
}

function queueTask<T extends Message>(
    action: T['request']['action'],
    payload: T['request']['payload'],
    transfer: Transferable[]
): Promise<Required<T['response']>['payload']> {
    return new Promise((resolve, reject) => {
        getFreeWorker().then((worker) => {
            let settled = false;
            const cleanup = () => {
                worker.removeEventListener('message', messageHandler);
                worker.removeEventListener('error', errorHandler);
                worker.removeEventListener('messageerror', messageErrorHandler);
                window.clearTimeout(timeout);
            };
            const failWorker = (error: Error) => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup();
                retireWorker(worker);
                reject(error);
            };
            const messageHandler = (event: { data: T['response'] }) => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup();
                releaseWorker(worker);

                if ('error' in event.data) {
                    const error = event.data.error;
                    reject(error instanceof Error ? error : new Error(String(error)));
                    return;
                }
                resolve(event.data.payload);
            };
            const errorHandler = (event: ErrorEvent) => {
                event.preventDefault();
                failWorker(event.error instanceof Error ? event.error : new Error(event.message));
            };
            const messageErrorHandler = () => {
                failWorker(new Error('Worker returned an unreadable analysis result'));
            };
            const timeout = window.setTimeout(() => {
                failWorker(new Error(`Worker task timed out after ${WORKER_TASK_TIMEOUT_MS} ms`));
            }, WORKER_TASK_TIMEOUT_MS);

            worker.addEventListener('message', messageHandler);
            worker.addEventListener('error', errorHandler);
            worker.addEventListener('messageerror', messageErrorHandler);

            try {
                worker.postMessage(
                    {
                        action,
                        payload,
                    },
                    transfer
                );
            } catch (error) {
                failWorker(error instanceof Error ? error : new Error(String(error)));
            }
        });
    });
}

async function retryTransientTask<T>(task: () => Promise<T>, maximumAttempts = 3): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
        try {
            return await task();
        } catch (error) {
            lastError = error;
            if (attempt + 1 < maximumAttempts) {
                await new Promise((resolve) => window.setTimeout(resolve, 80 * 2 ** attempt));
            }
        }
    }
    throw lastError;
}

export function getWorkerCount(): number {
    return WORKER_LIMIT;
}

async function offThreadGenerateSpectrogramOnly(
    samples: Float32Array,
    options: SpectrogramOptions
): Promise<SpectrogramResult> {
    const {
        spectrogramWindowCount,
        spectrogramOptions,
        spectrogramBuffer,
    } = await queueTask<ComputeSpectrogramOnlyMessage>(
        ACTION_COMPUTE_SPECTROGRAM_ONLY,
        {
            samplesBuffer: samples.buffer,
            samplesStart: 0,
            samplesLength: samples.length,
            options,
        },
        [samples.buffer]
    );
    return {
        windowCount: spectrogramWindowCount,
        options: spectrogramOptions,
        spectrogram: new Float32Array(spectrogramBuffer),
    };
}

export async function offThreadGenerateEntireSpectrogram(
    samples: Float32Array,
    options: SpectrogramOptions,
    samplesStart = 0,
    samplesLength = samples.length
): Promise<SpectrogramResult & { input: Float32Array }> {
    const windowSize = options.windowSize || 4096;
    const windowStepSize = options.windowStepSize || 1024;
    const windowCount =
        samplesLength < windowSize
            ? 0
            : Math.floor((samplesLength - windowSize) / windowStepSize) + 1;
    const taskCount = Math.min(WORKER_LIMIT, Math.max(1, Math.ceil(windowCount / 1500)));
    const tasks: Promise<SpectrogramResult>[] = [];
    for (let taskIndex = 0; taskIndex < taskCount; taskIndex += 1) {
        const firstWindow = Math.floor((taskIndex * windowCount) / taskCount);
        const endWindow = Math.floor(((taskIndex + 1) * windowCount) / taskCount);
        if (endWindow <= firstWindow) {
            continue;
        }
        const chunkStart = samplesStart + firstWindow * windowStepSize;
        const chunkEnd = Math.min(
            samplesStart + samplesLength,
            samplesStart + (endWindow - 1) * windowStepSize + windowSize
        );
        tasks.push(
            retryTransientTask(() =>
                offThreadGenerateSpectrogramOnly(
                    new Float32Array(samples.subarray(chunkStart, chunkEnd)),
                    {
                        ...options,
                        isStart: false,
                        isEnd: false,
                    }
                )
            )
        );
    }
    const parts = await Promise.all(tasks);
    const scaleSize = parts[0]?.options.scaleSize || options.scaleSize || windowSize / 2;
    const spectrogram = new Float32Array(windowCount * scaleSize);
    let outputOffset = 0;
    for (const part of parts) {
        spectrogram.set(part.spectrogram, outputOffset);
        outputOffset += part.spectrogram.length;
    }
    const resolvedOptions = parts[0]?.options;
    if (resolvedOptions === undefined) {
        throw new Error('Audio is too short for the selected spectrogram window');
    }
    return {
        windowCount,
        options: resolvedOptions,
        spectrogram,
        input: samples,
    };
}

export async function offThreadGenerateSpectrogram(
    samples: Float32Array,
    samplesStart: number,
    samplesLength: number,
    options: SpectrogramOptions,
    analysisOptions: AnalysisOptions,
    analysisLayers: AnalysisLayerSelection,
    analysisCadence: AnalysisComputationCadence
): Promise<
    SpectrogramResult & { input: Float32Array; analyses: AcousticAnalysis[]; pulseTimes: number[] }
> {
    const {
        spectrogramWindowCount,
        spectrogramOptions,
        spectrogramBuffer,
        inputBuffer,
        analyses,
        pulseTimes,
    } = await queueTask<ComputeSpectrogramMessage>(
        ACTION_COMPUTE_SPECTROGRAM,
        {
            samplesBuffer: samples.buffer,
            samplesStart,
            samplesLength,
            options,
            analysisOptions,
            analysisLayers,
            analysisCadence,
        },
        [samples.buffer]
    );

    return {
        windowCount: spectrogramWindowCount,
        options: spectrogramOptions,
        spectrogram: new Float32Array(spectrogramBuffer),
        input: new Float32Array(inputBuffer),
        analyses,
        pulseTimes,
    };
}

export async function offThreadAnalyzeEntireFile(
    samples: Float32Array,
    options: SpectrogramOptions,
    analysisOptions: AnalysisOptions,
    samplesStart = 0,
    samplesLength = samples.length,
    sampleOffset = 0
): Promise<
    SpectrogramResult & {
        input: Float32Array;
        analyses: TimedAcousticAnalysis[];
        pulseTimes: number[];
    }
> {
    const windowSize = options.windowSize || 4096;
    const windowStepSize = options.windowStepSize || 1024;
    const windowCount =
        samplesLength < windowSize
            ? 0
            : Math.floor((samplesLength - windowSize) / windowStepSize) + 1;
    const centreSamples = new Array(windowCount);
    for (let index = 0; index < windowCount; index += 1) {
        centreSamples[index] = samplesStart + index * windowStepSize + windowSize / 2;
    }

    const maximumSpectrogramWorkers = Math.max(1, WORKER_LIMIT - 1);
    const spectrogramTaskCount = Math.min(
        maximumSpectrogramWorkers,
        Math.max(1, Math.ceil(windowCount / 1500))
    );
    const spectrogramTasks: Promise<SpectrogramResult>[] = [];
    for (let taskIndex = 0; taskIndex < spectrogramTaskCount; taskIndex += 1) {
        const firstWindow = Math.floor((taskIndex * windowCount) / spectrogramTaskCount);
        const endWindow = Math.floor(((taskIndex + 1) * windowCount) / spectrogramTaskCount);
        if (endWindow <= firstWindow) {
            continue;
        }
        const chunkStart = samplesStart + firstWindow * windowStepSize;
        const chunkEnd = Math.min(
            samplesStart + samplesLength,
            samplesStart + (endWindow - 1) * windowStepSize + windowSize
        );
        spectrogramTasks.push(
            offThreadGenerateSpectrogramOnly(
                new Float32Array(samples.subarray(chunkStart, chunkEnd)),
                {
                    ...options,
                    isStart: false,
                    isEnd: false,
                }
            )
        );
    }

    const acousticTask = offThreadAnalyzeAcoustics(
        new Float32Array(samples),
        options.sampleRate,
        centreSamples,
        analysisOptions,
        true
    );
    const [spectrogramParts, acousticResult] = await Promise.all([
        Promise.all(spectrogramTasks),
        acousticTask,
    ]);
    const scaleSize = spectrogramParts[0]?.options.scaleSize || options.scaleSize || windowSize / 2;
    const spectrogram = new Float32Array(windowCount * scaleSize);
    let outputOffset = 0;
    for (const part of spectrogramParts) {
        spectrogram.set(part.spectrogram, outputOffset);
        outputOffset += part.spectrogram.length;
    }
    const spectrogramOptions: Required<SpectrogramOptions> = spectrogramParts[0]?.options || {
        isStart: false,
        isEnd: false,
        windowSize,
        fftSize: options.fftSize || windowSize,
        windowStepSize,
        minFrequencyHz: options.minFrequencyHz || 0,
        maxFrequencyHz:
            options.maxFrequencyHz ||
            (options.sampleRate * ((options.fftSize || windowSize) - 2)) /
                (2 * (options.fftSize || windowSize)),
        sampleRate: options.sampleRate,
        scale: options.scale || 'linear',
        scaleSize,
        windowFunction: options.windowFunction || 'gaussian',
    };
    const analyses: TimedAcousticAnalysis[] = acousticResult.analyses.map((analysis, index) => ({
        ...analysis,
        timeSeconds: (centreSamples[index] + sampleOffset) / options.sampleRate,
    }));

    return {
        windowCount,
        options: spectrogramOptions,
        spectrogram,
        input: acousticResult.input,
        analyses,
        pulseTimes: acousticResult.pulseTimes.map(
            (time) => time + sampleOffset / options.sampleRate
        ),
    };
}

export async function offThreadAnalyzeAcoustics(
    samples: Float32Array,
    sampleRate: number,
    centreSamples: number[],
    analysisOptions: AnalysisOptions,
    includeFormants: boolean,
    analysisLayers?: AnalysisLayerSelection
): Promise<{ input: Float32Array; analyses: AcousticAnalysis[]; pulseTimes: number[] }> {
    const { inputBuffer, analyses, pulseTimes } = await queueTask<AnalyzeAcousticsMessage>(
        ACTION_ANALYZE_ACOUSTICS,
        {
            samplesBuffer: samples.buffer,
            sampleRate,
            centreSamples,
            analysisOptions,
            includeFormants,
            analysisLayers,
        },
        [samples.buffer]
    );

    return {
        input: new Float32Array(inputBuffer),
        analyses,
        pulseTimes,
    };
}
