import { FFT } from 'jsfft';

import { hzToMel, inverseLerp, lerp, melToHz } from './math-util';

export type Scale = 'linear' | 'mel';

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
}

export interface SpectrogramResult {
    windowCount: number;
    options: Required<SpectrogramOptions>;
    spectrogram: Float32Array;
}

function generateSpectrogramForSingleFrame(
    windowSamples: Float32Array,
    effectiveWindowSize: number,
    resultBuffer: Float32Array,
    resultBufferIndex: number,
    minFrequencyHz: number,
    maxFrequencyHz: number,
    sampleRate: number,
    scale: Scale,
    scaleSize: number
) {
    // The effective analysis window can be shorter than the power-of-two FFT.
    // Zero padding preserves the requested Praat-style time window while keeping
    // jsfft on a fast radix-2 size.
    const padding = Math.floor((windowSamples.length - effectiveWindowSize) / 2);
    for (let i = 0; i < windowSamples.length; i += 1) {
        if (i < padding || i >= padding + effectiveWindowSize) {
            windowSamples[i] = 0;
        } else {
            const windowIndex = i - padding;
            const hamming =
                0.54 -
                0.46 *
                    Math.cos(
                        (2 * Math.PI * windowIndex) /
                            Math.max(1, effectiveWindowSize - 1)
                    );
            windowSamples[i] *= hamming;
        }
    }

    const fft = FFT(windowSamples);
    for (let j = 0; j < scaleSize; j += 1) {
        const scaleAmount = inverseLerp(0, scaleSize - 1, j);
        let n;
        switch (scale) {
            case 'linear': {
                const hz = lerp(minFrequencyHz, maxFrequencyHz, scaleAmount);
                n = (hz * windowSamples.length) / sampleRate;
                break;
            }
            case 'mel': {
                const mel = lerp(hzToMel(minFrequencyHz), hzToMel(maxFrequencyHz), scaleAmount);
                n = (melToHz(mel) * windowSamples.length) / sampleRate;
                break;
            }
            default:
                throw new Error('Unknown scale');
        }

        const lowerN = Math.floor(n);
        const upperN = Math.ceil(n);

        const amplitude =
            lerp(
                Math.sqrt(fft.real[lowerN] ** 2 + fft.imag[lowerN] ** 2),
                Math.sqrt(fft.real[upperN] ** 2 + fft.imag[upperN] ** 2),
                n - lowerN
            ) / Math.sqrt(windowSamples.length);

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
        scale = 'linear', // Scale of the returned spectrogram (can be 'linear' or 'mel')
        scaleSize, // Number of rows in the returned spectrogram
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
        const additionalWindows = Math.max(
            0,
            Math.ceil(windowSize / windowStepSize) - 1
        );
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
            minFrequencyHz,
            maxFrequencyHz,
            sampleRate,
            scale,
            scaleSize
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
        },
        spectrogram: result,
    };
}
