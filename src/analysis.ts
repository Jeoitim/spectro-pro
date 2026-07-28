import { clamp } from './math-util';

export type PitchAlgorithm = 'autocorrelation' | 'yin';

export interface AnalysisOptions {
    pitchAlgorithm: PitchAlgorithm;
    minPitchHz: number;
    maxPitchHz: number;
    voicingThreshold: number;
    formantCeilingHz: number;
    maximumFormants: number;
    formantWindowLengthSeconds: number;
    preEmphasisFromHz: number;
    intensityPitchFloorHz: number;
    splCalibrationDb: number;
}

export interface AcousticAnalysis {
    pitchHz: number | null;
    pitchConfidence: number;
    intensityDbSpl: number;
    formantsHz: (number | null)[];
    formantBandwidthsHz: (number | null)[];
}

export interface TimedAcousticAnalysis extends AcousticAnalysis {
    timeSeconds: number;
}

interface Complex {
    re: number;
    im: number;
}

const DEFAULT_OPTIONS: AnalysisOptions = {
    pitchAlgorithm: 'yin',
    minPitchHz: 75,
    maxPitchHz: 500,
    voicingThreshold: 0.6,
    formantCeilingHz: 5500,
    maximumFormants: 5,
    formantWindowLengthSeconds: 0.025,
    preEmphasisFromHz: 50,
    intensityPitchFloorHz: 75,
    splCalibrationDb: 0,
};

function besselI0(value: number) {
    let sum = 1;
    let term = 1;
    const squared = (value * value) / 4;
    for (let k = 1; k < 30; k += 1) {
        term *= squared / (k * k);
        sum += term;
        if (term < sum * 1e-12) {
            break;
        }
    }
    return sum;
}

function calculateIntensityDbSpl(
    samples: Float32Array,
    sampleRate: number,
    pitchFloorHz: number,
    calibrationDb: number
) {
    // Praat's effective intensity window is 3.2 / pitchFloor and uses a
    // Kaiser-20 window before converting mean-square pressure to dB SPL.
    const windowLength = Math.min(
        samples.length,
        Math.max(1, Math.round((3.2 * sampleRate) / pitchFloorHz))
    );
    const start = samples.length - windowLength;
    const denominator = besselI0(20);
    let weightedPower = 0;
    let weightSum = 0;
    for (let i = 0; i < windowLength; i += 1) {
        const ratio = windowLength === 1 ? 0 : (2 * i) / (windowLength - 1) - 1;
        const weight = besselI0(20 * Math.sqrt(Math.max(0, 1 - ratio * ratio))) / denominator;
        weightedPower += samples[start + i] * samples[start + i] * weight;
        weightSum += weight;
    }
    const rms = Math.sqrt(weightedPower / Math.max(1e-12, weightSum));
    return 20 * Math.log10(Math.max(1e-7, rms) / 0.00002) + calibrationDb;
}

function preparePitchSignal(samples: Float32Array, sampleRate: number) {
    const targetRate = 16000;
    const stride = Math.max(1, Math.floor(sampleRate / targetRate));
    const length = Math.floor(samples.length / stride);
    const signal = new Float64Array(length);
    let mean = 0;

    for (let i = 0; i < length; i += 1) {
        signal[i] = samples[i * stride];
        mean += signal[i];
    }
    mean /= Math.max(1, length);

    let energy = 0;
    for (let i = 0; i < length; i += 1) {
        signal[i] -= mean;
        energy += signal[i] * signal[i];
    }

    return {
        signal,
        sampleRate: sampleRate / stride,
        rms: Math.sqrt(energy / Math.max(1, length)),
    };
}

function parabolicPeak(values: Float64Array, index: number): number {
    if (index <= 0 || index >= values.length - 1) {
        return index;
    }
    const left = values[index - 1];
    const centre = values[index];
    const right = values[index + 1];
    const denominator = left - 2 * centre + right;
    if (Math.abs(denominator) < 1e-12) {
        return index;
    }
    return index + (0.5 * (left - right)) / denominator;
}

function detectPitchAutocorrelation(
    samples: Float32Array,
    sampleRate: number,
    minPitchHz: number,
    maxPitchHz: number
): { pitchHz: number | null; confidence: number } {
    const prepared = preparePitchSignal(samples, sampleRate);
    if (prepared.rms < 0.002) {
        return { pitchHz: null, confidence: 0 };
    }

    const minLag = Math.max(2, Math.floor(prepared.sampleRate / maxPitchHz));
    const maxLag = Math.min(
        Math.floor(prepared.sampleRate / minPitchHz),
        prepared.signal.length - 2
    );
    const correlations = new Float64Array(maxLag + 1);
    let bestLag = minLag;
    let bestCorrelation = -1;

    for (let lag = minLag; lag <= maxLag; lag += 1) {
        let numerator = 0;
        let energyA = 0;
        let energyB = 0;
        for (let i = 0; i < prepared.signal.length - lag; i += 1) {
            const a = prepared.signal[i];
            const b = prepared.signal[i + lag];
            numerator += a * b;
            energyA += a * a;
            energyB += b * b;
        }
        const correlation = numerator / Math.sqrt(Math.max(1e-12, energyA * energyB));
        correlations[lag] = correlation;

        const isLocalPeak =
            lag > minLag &&
            correlation > correlations[lag - 1] &&
            (correlation > bestCorrelation || bestCorrelation < 0.82);
        if (isLocalPeak && correlation > 0.35) {
            bestCorrelation = correlation;
            bestLag = lag;
        }
    }

    if (bestCorrelation < 0.35) {
        return { pitchHz: null, confidence: Math.max(0, bestCorrelation) };
    }

    const lag = parabolicPeak(correlations, bestLag);
    return {
        pitchHz: prepared.sampleRate / lag,
        confidence: clamp(bestCorrelation, 0, 1),
    };
}

function detectPitchYin(
    samples: Float32Array,
    sampleRate: number,
    minPitchHz: number,
    maxPitchHz: number
): { pitchHz: number | null; confidence: number } {
    const prepared = preparePitchSignal(samples, sampleRate);
    if (prepared.rms < 0.002) {
        return { pitchHz: null, confidence: 0 };
    }

    const minLag = Math.max(2, Math.floor(prepared.sampleRate / maxPitchHz));
    const maxLag = Math.min(
        Math.floor(prepared.sampleRate / minPitchHz),
        Math.floor(prepared.signal.length / 2)
    );
    const difference = new Float64Array(maxLag + 1);

    for (let lag = 1; lag <= maxLag; lag += 1) {
        let sum = 0;
        for (let i = 0; i < prepared.signal.length - maxLag; i += 1) {
            const delta = prepared.signal[i] - prepared.signal[i + lag];
            sum += delta * delta;
        }
        difference[lag] = sum;
    }

    let runningSum = 0;
    difference[0] = 1;
    for (let lag = 1; lag <= maxLag; lag += 1) {
        runningSum += difference[lag];
        difference[lag] = runningSum === 0 ? 1 : (difference[lag] * lag) / runningSum;
    }

    const threshold = 0.15;
    let bestLag = -1;
    let bestValue = 1;
    for (let lag = minLag; lag <= maxLag; lag += 1) {
        if (difference[lag] < threshold) {
            while (lag + 1 <= maxLag && difference[lag + 1] < difference[lag]) {
                lag += 1;
            }
            bestLag = lag;
            bestValue = difference[lag];
            break;
        }
        if (difference[lag] < bestValue) {
            bestLag = lag;
            bestValue = difference[lag];
        }
    }

    if (bestLag < 0 || bestValue > 0.35) {
        return { pitchHz: null, confidence: clamp(1 - bestValue, 0, 1) };
    }

    const inverted = new Float64Array(difference.length);
    for (let i = 0; i < difference.length; i += 1) {
        inverted[i] = -difference[i];
    }
    const lag = parabolicPeak(inverted, bestLag);
    return {
        pitchHz: prepared.sampleRate / lag,
        confidence: clamp(1 - bestValue, 0, 1),
    };
}

function complexAdd(a: Complex, b: Complex): Complex {
    return { re: a.re + b.re, im: a.im + b.im };
}

function complexMultiply(a: Complex, b: Complex): Complex {
    return { re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re };
}

function complexDivide(a: Complex, b: Complex): Complex {
    const denominator = b.re * b.re + b.im * b.im + 1e-18;
    return {
        re: (a.re * b.re + a.im * b.im) / denominator,
        im: (a.im * b.re - a.re * b.im) / denominator,
    };
}

function evaluatePolynomial(coefficients: Float64Array, x: Complex): Complex {
    let result = { re: coefficients[0], im: 0 };
    for (let i = 1; i < coefficients.length; i += 1) {
        result = complexAdd(complexMultiply(result, x), { re: coefficients[i], im: 0 });
    }
    return result;
}

function polynomialRoots(coefficients: Float64Array): Complex[] {
    const degree = coefficients.length - 1;
    const roots: Complex[] = [];
    const radius = 0.96;
    for (let i = 0; i < degree; i += 1) {
        const angle = (2 * Math.PI * i) / degree + 0.17;
        roots.push({ re: radius * Math.cos(angle), im: radius * Math.sin(angle) });
    }

    for (let iteration = 0; iteration < 180; iteration += 1) {
        let maximumChange = 0;
        for (let i = 0; i < degree; i += 1) {
            let denominator = { re: 1, im: 0 };
            for (let j = 0; j < degree; j += 1) {
                if (i !== j) {
                    denominator = complexMultiply(denominator, {
                        re: roots[i].re - roots[j].re,
                        im: roots[i].im - roots[j].im,
                    });
                }
            }
            const correction = complexDivide(
                evaluatePolynomial(coefficients, roots[i]),
                denominator
            );
            roots[i] = {
                re: roots[i].re - correction.re,
                im: roots[i].im - correction.im,
            };
            maximumChange = Math.max(
                maximumChange,
                Math.sqrt(correction.re ** 2 + correction.im ** 2)
            );
        }
        if (maximumChange < 1e-7) {
            break;
        }
    }
    return roots;
}

function sinc(value: number) {
    return Math.abs(value) < 1e-12 ? 1 : Math.sin(Math.PI * value) / (Math.PI * value);
}

export function resampleForFormants(
    samples: Float32Array,
    sampleRate: number,
    targetSampleRate: number
) {
    if (Math.abs(sampleRate - targetSampleRate) < 1) {
        return new Float64Array(samples);
    }

    const ratio = sampleRate / targetSampleRate;
    const outputLength = Math.max(1, Math.floor(samples.length / ratio));
    const output = new Float64Array(outputLength);
    const halfTaps = 32;
    const cutoff = Math.min(1, targetSampleRate / sampleRate) * 0.94;

    for (let outputIndex = 0; outputIndex < outputLength; outputIndex += 1) {
        const centre = outputIndex * ratio;
        const first = Math.max(0, Math.floor(centre) - halfTaps + 1);
        const last = Math.min(samples.length - 1, Math.floor(centre) + halfTaps);
        let sum = 0;
        let weightSum = 0;
        for (let inputIndex = first; inputIndex <= last; inputIndex += 1) {
            const distance = inputIndex - centre;
            const normalizedDistance = distance / halfTaps;
            const window =
                0.42 +
                0.5 * Math.cos(Math.PI * normalizedDistance) +
                0.08 * Math.cos(2 * Math.PI * normalizedDistance);
            const weight = cutoff * sinc(cutoff * distance) * window;
            sum += samples[inputIndex] * weight;
            weightSum += weight;
        }
        output[outputIndex] = sum / Math.max(1e-12, weightSum);
    }
    return output;
}

function burgLpc(signal: Float64Array, order: number) {
    const coefficients = new Float64Array(order + 1);
    coefficients[0] = 1;
    if (signal.length <= order + 1) {
        return coefficients;
    }

    let forward = new Float64Array(signal);
    let backward = new Float64Array(signal);

    for (let currentOrder = 1; currentOrder <= order; currentOrder += 1) {
        let numerator = 0;
        let denominator = 0;
        for (let i = currentOrder; i < signal.length; i += 1) {
            numerator += forward[i] * backward[i - 1];
            denominator += forward[i] * forward[i] + backward[i - 1] * backward[i - 1];
        }
        const reflection = (-2 * numerator) / Math.max(1e-18, denominator);
        const previousCoefficients = new Float64Array(coefficients);
        coefficients[currentOrder] = reflection;
        for (let i = 1; i < currentOrder; i += 1) {
            coefficients[i] =
                previousCoefficients[i] + reflection * previousCoefficients[currentOrder - i];
        }

        const nextForward = new Float64Array(forward);
        const nextBackward = new Float64Array(backward);
        for (let i = currentOrder; i < signal.length; i += 1) {
            nextForward[i] = forward[i] + reflection * backward[i - 1];
            nextBackward[i - 1] = backward[i - 1] + reflection * forward[i];
        }
        forward = nextForward;
        backward = nextBackward;
    }
    return coefficients;
}

function estimateFormants(
    samples: Float32Array,
    sampleRate: number,
    options: AnalysisOptions
): { frequencies: (number | null)[]; bandwidths: (number | null)[] } {
    const maximumFormants = clamp(Math.round(options.maximumFormants * 2) / 2, 1, 8);
    const poleCount = Math.max(2, Math.round(maximumFormants * 2));
    const empty = () => new Array(Math.ceil(maximumFormants)).fill(null);
    if (samples.length < 64) {
        return { frequencies: empty(), bandwidths: empty() };
    }

    const actualWindowSeconds = options.formantWindowLengthSeconds * 2;
    const sourceWindowLength = Math.min(
        samples.length,
        Math.max(64, Math.round(actualWindowSeconds * sampleRate))
    );
    const sourceWindow = samples.subarray(samples.length - sourceWindowLength);
    const formantSampleRate = Math.min(sampleRate, Math.max(2000, options.formantCeilingHz * 2));
    const resampled = resampleForFormants(sourceWindow, sampleRate, formantSampleRate);

    const preEmphasisCoefficient = Math.exp(
        (-2 * Math.PI * options.preEmphasisFromHz) / formantSampleRate
    );
    const signal = new Float64Array(resampled.length);
    let energy = 0;
    for (let i = 0; i < resampled.length; i += 1) {
        const previous = i === 0 ? 0 : resampled[i - 1];
        const emphasized = resampled[i] - preEmphasisCoefficient * previous;
        const position =
            resampled.length === 1 ? 0 : (i - (resampled.length - 1) / 2) / (resampled.length - 1);
        const gaussianLikeWindow = Math.exp(-48 * position * position);
        signal[i] = emphasized * gaussianLikeWindow;
        energy += signal[i] * signal[i];
    }
    if (Math.sqrt(energy / Math.max(1, signal.length)) < 0.00008) {
        return { frequencies: empty(), bandwidths: empty() };
    }

    const lpc = burgLpc(signal, poleCount);

    const candidates = polynomialRoots(lpc)
        .map((root) => {
            const magnitudeSquared = root.re * root.re + root.im * root.im;
            return magnitudeSquared > 1
                ? {
                      re: root.re / magnitudeSquared,
                      im: root.im / magnitudeSquared,
                  }
                : root;
        })
        .filter((root) => root.im > 0)
        .map((root) => {
            const angle = Math.atan2(root.im, root.re);
            const frequency = (angle * formantSampleRate) / (2 * Math.PI);
            const magnitude = Math.sqrt(root.re * root.re + root.im * root.im);
            const bandwidth =
                (-formantSampleRate * Math.log(Math.max(1e-9, Math.min(1, magnitude)))) / Math.PI;
            return { frequency, bandwidth };
        })
        .filter(
            ({ frequency, bandwidth }) =>
                Number.isFinite(frequency) &&
                Number.isFinite(bandwidth) &&
                frequency >= 50 &&
                frequency <= options.formantCeilingHz - 50 &&
                bandwidth >= 0
        )
        .sort((a, b) => a.frequency - b.frequency);

    const resultLength = Math.ceil(maximumFormants);
    return {
        frequencies: new Array(resultLength)
            .fill(null)
            .map((_, index) => (candidates[index] ? candidates[index].frequency : null)),
        bandwidths: new Array(resultLength)
            .fill(null)
            .map((_, index) => (candidates[index] ? candidates[index].bandwidth : null)),
    };
}

export function analyzeAcousticFrame(
    samples: Float32Array,
    sampleRate: number,
    partialOptions: Partial<AnalysisOptions> = {}
): AcousticAnalysis {
    const options = { ...DEFAULT_OPTIONS, ...partialOptions };
    // Browser microphone samples are unitless, so the default follows Praat's
    // Sound convention of interpreting one sample unit as one Pascal.
    const intensityDbSpl = calculateIntensityDbSpl(
        samples,
        sampleRate,
        options.intensityPitchFloorHz,
        options.splCalibrationDb
    );

    const pitch =
        options.pitchAlgorithm === 'autocorrelation'
            ? detectPitchAutocorrelation(
                  samples,
                  sampleRate,
                  options.minPitchHz,
                  options.maxPitchHz
              )
            : detectPitchYin(samples, sampleRate, options.minPitchHz, options.maxPitchHz);

    const voiced = pitch.pitchHz !== null && pitch.confidence >= options.voicingThreshold;
    const formants = estimateFormants(samples, sampleRate, options);
    return {
        pitchHz: voiced ? pitch.pitchHz : null,
        pitchConfidence: pitch.confidence,
        intensityDbSpl,
        formantsHz: formants.frequencies,
        formantBandwidthsHz: formants.bandwidths,
    };
}
