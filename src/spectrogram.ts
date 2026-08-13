import { FrequencyScale, frequencyToScale, inverseLerp, lerp, scaleToFrequency } from './math-util';

export type Scale = FrequencyScale;
export type SpectrogramWindowFunction =
    | 'rectangular'
    | 'hamming'
    | 'bartlett'
    | 'welch'
    | 'hanning'
    | 'gaussian';

export interface SpectrogramOptions {
    isStart?: boolean;
    isEnd?: boolean;
    windowSize?: number;
    fftSize?: number;
    windowStepSize?: number;
    minFrequencyHz?: number;
    maxFrequencyHz?: number;
    sampleRate: number;
    scale?: Scale;
    scaleSize?: number;
    windowFunction?: SpectrogramWindowFunction;
}

export interface SpectrogramResult {
    windowCount: number;
    options: Required<SpectrogramOptions>;
    spectrogram: Float32Array;
}

interface SpectrogramFramePlan {
    fftReal: Float32Array;
    fftImaginary: Float32Array;
    bitReversedIndices: Uint32Array;
    windowWeights: Float32Array;
    lowerBins: Uint32Array;
    upperBins: Uint32Array;
    binFractions: Float32Array;
    normalization: number;
    preEmphasis: number;
}

function createFramePlan(
    fftSize: number,
    effectiveWindowSize: number,
    minFrequencyHz: number,
    maxFrequencyHz: number,
    sampleRate: number,
    scale: Scale,
    scaleSize: number,
    windowFunction: SpectrogramWindowFunction
): SpectrogramFramePlan {
    const bitReversedIndices = new Uint32Array(fftSize);
    const bitCount = Math.round(Math.log2(fftSize));
    for (let index = 0; index < fftSize; index += 1) {
        let source = index;
        let reversed = 0;
        for (let bit = 0; bit < bitCount; bit += 1) {
            reversed = (reversed << 1) | (source & 1);
            source >>= 1;
        }
        bitReversedIndices[index] = reversed;
    }

    const padding = Math.floor((fftSize - effectiveWindowSize) / 2);
    const windowWeights = new Float32Array(fftSize);
    const denominator = Math.max(1, effectiveWindowSize - 1);
    const midpoint = denominator / 2;
    for (let index = 0; index < effectiveWindowSize; index += 1) {
        const centered = midpoint === 0 ? 0 : (index - midpoint) / midpoint;
        let weight = 1;
        if (windowFunction === 'hamming') {
            weight = 0.54 - 0.46 * Math.cos((2 * Math.PI * index) / denominator);
        } else if (windowFunction === 'bartlett') {
            weight = Math.max(0, 1 - Math.abs(centered));
        } else if (windowFunction === 'welch') {
            weight = Math.max(0, 1 - centered ** 2);
        } else if (windowFunction === 'hanning') {
            weight = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / denominator);
        } else if (windowFunction === 'gaussian') {
            weight = Math.exp(-0.5 * (centered / 0.4) ** 2);
        }
        windowWeights[padding + index] = weight;
    }

    const lowerBins = new Uint32Array(scaleSize);
    const upperBins = new Uint32Array(scaleSize);
    const binFractions = new Float32Array(scaleSize);
    const scaledMinimum = frequencyToScale(minFrequencyHz, scale);
    const scaledMaximum = frequencyToScale(maxFrequencyHz, scale);
    for (let index = 0; index < scaleSize; index += 1) {
        const scaleAmount = inverseLerp(0, scaleSize - 1, index);
        const hz = scaleToFrequency(lerp(scaledMinimum, scaledMaximum, scaleAmount), scale);
        const bin = Math.min(fftSize - 1, Math.max(0, (hz * fftSize) / sampleRate));
        lowerBins[index] = Math.floor(bin);
        upperBins[index] = Math.ceil(bin);
        binFractions[index] = bin - lowerBins[index];
    }

    return {
        fftReal: new Float32Array(fftSize),
        fftImaginary: new Float32Array(fftSize),
        bitReversedIndices,
        windowWeights,
        lowerBins,
        upperBins,
        binFractions,
        normalization: 1 / Math.sqrt(fftSize),
        preEmphasis: Math.exp((-2 * Math.PI * 50) / sampleRate),
    };
}

function transformFrame(plan: SpectrogramFramePlan, input: Float32Array) {
    const { fftReal, fftImaginary, bitReversedIndices } = plan;
    for (let index = 0; index < input.length; index += 1) {
        fftReal[index] = input[bitReversedIndices[index]];
        fftImaginary[index] = 0;
    }

    for (let width = 1; width < input.length; width <<= 1) {
        const angle = Math.PI / width;
        const deltaReal = Math.cos(angle);
        const deltaImaginary = Math.sin(angle);
        for (let block = 0; block < input.length; block += width * 2) {
            let factorReal = 1;
            let factorImaginary = 0;
            for (let offset = 0; offset < width; offset += 1) {
                const left = block + offset;
                const right = left + width;
                const leftReal = fftReal[left];
                const leftImaginary = fftImaginary[left];
                const rightReal =
                    factorReal * fftReal[right] - factorImaginary * fftImaginary[right];
                const rightImaginary =
                    factorImaginary * fftReal[right] + factorReal * fftImaginary[right];

                fftReal[left] = (leftReal + rightReal) * Math.SQRT1_2;
                fftImaginary[left] = (leftImaginary + rightImaginary) * Math.SQRT1_2;
                fftReal[right] = (leftReal - rightReal) * Math.SQRT1_2;
                fftImaginary[right] = (leftImaginary - rightImaginary) * Math.SQRT1_2;

                const nextFactorReal = factorReal * deltaReal - factorImaginary * deltaImaginary;
                factorImaginary = factorReal * deltaImaginary + factorImaginary * deltaReal;
                factorReal = nextFactorReal;
            }
        }
    }
}

function generateSpectrogramForSingleFrame(
    windowSamples: Float32Array,
    effectiveWindowSize: number,
    resultBuffer: Float32Array,
    resultBufferIndex: number,
    scaleSize: number,
    plan: SpectrogramFramePlan
) {
    // The effective analysis window can be shorter than the power-of-two FFT.
    // Zero padding preserves the requested Praat-style time window while keeping
    // jsfft on a fast radix-2 size.
    const padding = Math.floor((windowSamples.length - effectiveWindowSize) / 2);
    const firstSample = padding;
    const lastSample = padding + effectiveWindowSize - 1;
    // Praat-style +6 dB/octave display pre-emphasis flattens the natural spectral
    // slope of speech so upper formants remain visible without saturating F1.
    for (let i = lastSample; i > firstSample; i -= 1) {
        windowSamples[i] -= plan.preEmphasis * windowSamples[i - 1];
    }
    if (effectiveWindowSize > 0) {
        windowSamples[firstSample] *= 1 - plan.preEmphasis;
    }
    for (let i = 0; i < windowSamples.length; i += 1) {
        windowSamples[i] *= plan.windowWeights[i];
    }

    transformFrame(plan, windowSamples);
    for (let j = 0; j < scaleSize; j += 1) {
        const lowerN = plan.lowerBins[j];
        const upperN = plan.upperBins[j];

        const amplitude =
            lerp(
                Math.sqrt(plan.fftReal[lowerN] ** 2 + plan.fftImaginary[lowerN] ** 2),
                Math.sqrt(plan.fftReal[upperN] ** 2 + plan.fftImaginary[upperN] ** 2),
                plan.binFractions[j]
            ) * plan.normalization;

        resultBuffer[resultBufferIndex + j] = amplitude;
    }
}

export function generateSpectrogram(
    samples: Float32Array,
    samplesStart: number,
    samplesLength: number,
    {
        isStart = false, // Is the frame at the start of the audio
        isEnd = false, // Is the frame at the end of the audio
        windowSize = 4096, // Size of the FFT window in samples
        fftSize = windowSize, // Power-of-two FFT size; may include zero padding
        windowStepSize = 1024, // Number of samples between each FFT window
        minFrequencyHz, // Smallest frequency in Hz to calculate the spectrogram for
        maxFrequencyHz, // Largest frequency in Hz to calculate the spectrogram for
        sampleRate, // Sample rate of the audio
        scale = 'linear', // Frequency scale of the returned spectrogram
        scaleSize, // Number of rows in the returned spectrogram
        windowFunction = 'gaussian', // Shape applied to each analysis window
    }: SpectrogramOptions
): SpectrogramResult {
    if (minFrequencyHz === undefined) {
        minFrequencyHz = 0;
    }
    if (maxFrequencyHz === undefined) {
        maxFrequencyHz = (sampleRate * (fftSize - 2)) / (2 * fftSize);
    }
    if (scaleSize === undefined) {
        scaleSize = fftSize / 2;
    }
    if (fftSize < windowSize) {
        throw new Error('FFT size must be greater than or equal to the analysis window size');
    }

    let numWindows =
        samplesLength < windowSize
            ? 0
            : Math.floor((samplesLength - windowSize) / windowStepSize) + 1;
    let startIdx = samplesStart;
    if (isStart || isEnd) {
        const additionalWindows = Math.max(0, Math.ceil(windowSize / windowStepSize) - 1);
        if (isStart) {
            numWindows += additionalWindows;
            startIdx -= additionalWindows * windowStepSize;
        }
        if (isEnd) {
            numWindows += additionalWindows;
        }
    }

    const result = new Float32Array(scaleSize * numWindows);
    const windowSamples = new Float32Array(fftSize);
    const padding = Math.floor((fftSize - windowSize) / 2);
    const framePlan = createFramePlan(
        fftSize,
        windowSize,
        minFrequencyHz,
        maxFrequencyHz,
        sampleRate,
        scale,
        scaleSize,
        windowFunction
    );

    for (
        let i = startIdx, windowIdx = 0;
        windowIdx < numWindows * scaleSize;
        i += windowStepSize, windowIdx += scaleSize
    ) {
        windowSamples.fill(0);
        for (let j = 0; j < windowSize; j += 1) {
            const sampleIdx = i + j;
            if (sampleIdx < samplesStart || sampleIdx >= samplesStart + samplesLength) {
                windowSamples[padding + j] = 0;
            } else {
                windowSamples[padding + j] = samples[sampleIdx];
            }
        }

        generateSpectrogramForSingleFrame(
            windowSamples,
            windowSize,
            result,
            windowIdx,
            scaleSize,
            framePlan
        );
    }

    return {
        windowCount: numWindows,
        options: {
            isStart,
            isEnd,
            windowSize,
            fftSize,
            windowStepSize,
            minFrequencyHz,
            maxFrequencyHz,
            sampleRate,
            scale,
            scaleSize,
            windowFunction,
        },
        spectrogram: result,
    };
}
