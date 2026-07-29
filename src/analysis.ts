import { FFT, InvFFT } from 'jsfft';
import { clamp } from './math-util';
import { EigenvalueDecomposition, Matrix } from 'ml-matrix';

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

export interface AnalysisLayerSelection {
    pitch: boolean;
    formants: boolean;
    intensity: boolean;
}

export interface AcousticAnalysis {
    pitchHz: number | null;
    pitchConfidence: number;
    intensityDbSpl: number;
    formantsHz: (number | null)[];
    formantBandwidthsHz: (number | null)[];
    formantIntensity: number;
    drawFormants: boolean;
}

export interface TimedAcousticAnalysis extends AcousticAnalysis {
    timeSeconds: number;
}

interface Complex {
    re: number;
    im: number;
}

export interface FormantFrameAnalysis {
    timeSeconds: number;
    formantsHz: (number | null)[];
    formantBandwidthsHz: (number | null)[];
    formantIntensity: number;
}

interface PreparedFormantSignal {
    samples: Float64Array;
    sampleRate: number;
    firstSampleTimeSeconds: number;
    durationSeconds: number;
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
    calibrationDb: number,
    centreSample = 0.5 * (samples.length - 1)
) {
    // Praat's Kaiser-20 window has a 3.2 / pitchFloor effective duration
    // and a 6.4 / pitchFloor physical duration.
    const halfWindowDuration = 3.2 / pitchFloorHz;
    const halfWindowSamples = Math.floor(halfWindowDuration * sampleRate);
    const soundCentreSample = Math.round(centreSample);
    const start = Math.max(0, soundCentreSample - halfWindowSamples);
    const end = Math.min(samples.length - 1, soundCentreSample + halfWindowSamples);
    if (end < start) {
        return -300 + calibrationDb;
    }

    let localMean = 0;
    for (let index = start; index <= end; index += 1) {
        localMean += samples[index];
    }
    localMean /= end - start + 1;

    const kaiserParameter = 2 * Math.PI * Math.PI + 0.5;
    let weightedPower = 0;
    let weightSum = 0;
    for (let index = start; index <= end; index += 1) {
        const relativeTime = (index - soundCentreSample) / sampleRate / halfWindowDuration;
        const weight = besselI0(
            kaiserParameter * Math.sqrt(Math.max(0, 1 - relativeTime * relativeTime))
        );
        const pressure = samples[index] - localMean;
        weightedPower += pressure * pressure * weight;
        weightSum += weight;
    }
    const pressureSquared = weightedPower / Math.max(1e-300, weightSum);
    const relativeIntensity = pressureSquared / (0.00002 * 0.00002);
    return (relativeIntensity < 1e-30 ? -300 : 10 * Math.log10(relativeIntensity)) + calibrationDb;
}

function lowPassDecimate(samples: Float32Array, stride: number) {
    if (stride === 1) {
        return new Float64Array(samples);
    }
    const length = Math.max(1, Math.floor(samples.length / stride));
    const result = new Float64Array(length);
    const halfWidth = 4 * stride;
    for (let outputIndex = 0; outputIndex < length; outputIndex += 1) {
        const centre = outputIndex * stride + 0.5 * (stride - 1);
        const first = Math.max(0, Math.ceil(centre - halfWidth));
        const last = Math.min(samples.length - 1, Math.floor(centre + halfWidth));
        let weightedSample = 0;
        let weightSum = 0;
        for (let inputIndex = first; inputIndex <= last; inputIndex += 1) {
            const distance = inputIndex - centre;
            const window = 0.5 + 0.5 * Math.cos((Math.PI * distance) / (halfWidth + 1));
            const weight = sinc(distance / stride) * window;
            weightedSample += samples[inputIndex] * weight;
            weightSum += weight;
        }
        result[outputIndex] = weightedSample / Math.max(Number.EPSILON, weightSum);
    }
    return result;
}

function preparePitchSignal(
    samples: Float32Array,
    sampleRate: number,
    minPitchHz: number,
    maxPitchHz: number,
    centreSample: number
) {
    const physicalWindowLength = Math.max(16, Math.floor((3 * sampleRate) / minPitchHz));
    const halfWindowLength = Math.floor(physicalWindowLength / 2);
    const nearestCentreSample = Math.round(centreSample);
    const start = Math.max(0, nearestCentreSample - halfWindowLength);
    const end = Math.min(samples.length, nearestCentreSample + halfWindowLength);
    const pitchSamples = samples.subarray(start, Math.max(start + 1, end));
    const targetRate = Math.max(8000, maxPitchHz * 8);
    const stride = Math.max(1, Math.floor(sampleRate / targetRate));
    const signal = lowPassDecimate(pitchSamples, stride);
    const preparedSampleRate = sampleRate / stride;
    let mean = 0;

    for (let i = 0; i < signal.length; i += 1) {
        mean += signal[i];
    }
    mean /= Math.max(1, signal.length);

    let energy = 0;
    for (let i = 0; i < signal.length; i += 1) {
        signal[i] -= mean;
        energy += signal[i] * signal[i];
    }

    return {
        signal,
        sampleRate: preparedSampleRate,
        rms: Math.sqrt(energy / Math.max(1, signal.length)),
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
    maxPitchHz: number,
    centreSample: number
): { pitchHz: number | null; confidence: number } {
    const prepared = preparePitchSignal(samples, sampleRate, minPitchHz, maxPitchHz, centreSample);
    if (prepared.rms < 1e-12) {
        return { pitchHz: null, confidence: 0 };
    }

    const minLag = Math.max(2, Math.floor(prepared.sampleRate / maxPitchHz));
    const maxLag = Math.min(
        Math.floor(prepared.sampleRate / minPitchHz),
        prepared.signal.length - 3
    );
    if (maxLag <= minLag) {
        return { pitchHz: null, confidence: 0 };
    }

    const window = new Float64Array(prepared.signal.length);
    const windowedSignal = new Float64Array(prepared.signal.length);
    let signalPower = 0;
    let windowPower = 0;
    for (let index = 0; index < prepared.signal.length; index += 1) {
        window[index] =
            0.5 - 0.5 * Math.cos((2 * Math.PI * (index + 1)) / (prepared.signal.length + 1));
        windowedSignal[index] = prepared.signal[index] * window[index];
        signalPower += windowedSignal[index] * windowedSignal[index];
        windowPower += window[index] * window[index];
    }

    const correlations = new Float64Array(maxLag + 2);
    let bestLag = minLag;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let lag = 1; lag <= maxLag + 1; lag += 1) {
        let signalCorrelation = 0;
        let windowCorrelation = 0;
        for (let index = 0; index < prepared.signal.length - lag; index += 1) {
            signalCorrelation += windowedSignal[index] * windowedSignal[index + lag];
            windowCorrelation += window[index] * window[index + lag];
        }
        const normalizedWindowCorrelation =
            windowCorrelation / Math.max(Number.EPSILON, windowPower);
        const rawCorrelation =
            signalCorrelation / Math.max(Number.EPSILON, signalPower * normalizedWindowCorrelation);
        correlations[lag] = rawCorrelation > 1 ? 1 / rawCorrelation : rawCorrelation;
    }
    for (let lag = minLag; lag <= maxLag; lag += 1) {
        const correlation = correlations[lag];
        if (
            correlation > 0.3 &&
            correlation > correlations[lag - 1] &&
            correlation >= correlations[lag + 1]
        ) {
            const frequency = prepared.sampleRate / lag;
            const score = correlation + 0.01 * Math.log2(Math.max(1, frequency / minPitchHz));
            if (score > bestScore) {
                bestScore = score;
                bestLag = lag;
            }
        }
    }

    if (!Number.isFinite(bestScore)) {
        return { pitchHz: null, confidence: 0 };
    }

    const lag = parabolicPeak(correlations, bestLag);
    return {
        pitchHz: prepared.sampleRate / lag,
        confidence: clamp(correlations[bestLag], 0, 1),
    };
}

function detectPitchYin(
    samples: Float32Array,
    sampleRate: number,
    minPitchHz: number,
    maxPitchHz: number,
    centreSample: number
): { pitchHz: number | null; confidence: number } {
    const prepared = preparePitchSignal(samples, sampleRate, minPitchHz, maxPitchHz, centreSample);
    if (prepared.rms < 1e-12) {
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

function sinc(value: number) {
    return Math.abs(value) < 1e-12 ? 1 : Math.sin(Math.PI * value) / (Math.PI * value);
}

function praatAntiAliasFilter(samples: Float32Array, sampleRateFactor: number) {
    const padding = 1000;
    let fftSize = 1;
    while (fftSize < samples.length + 2 * padding) {
        fftSize *= 2;
    }
    const padded = new Float64Array(fftSize);
    padded.set(samples, padding);
    const spectrum = FFT<Float64Array>(padded);
    const firstDiscardedBin = Math.ceil((Math.floor(sampleRateFactor * fftSize) - 1) / 2);
    for (let bin = firstDiscardedBin; bin <= fftSize - firstDiscardedBin; bin += 1) {
        spectrum.real[bin] = 0;
        spectrum.imag[bin] = 0;
    }
    return InvFFT(spectrum).real.subarray(padding, padding + samples.length);
}

function praatSincInterpolate(samples: Float64Array, oneBasedIndex: number, maximumDepth: number) {
    if (oneBasedIndex < 1) {
        return samples[0];
    }
    if (oneBasedIndex > samples.length) {
        return samples[samples.length - 1];
    }
    const middleLeft = Math.floor(oneBasedIndex);
    if (oneBasedIndex === middleLeft) {
        return samples[middleLeft - 1];
    }
    const middleRight = middleLeft + 1;
    const depth = Math.min(maximumDepth, middleRight - 1, samples.length - middleLeft);
    const left = middleRight - depth;
    const right = middleLeft + depth;
    const windowDepth = depth + 0.5;
    let result = 0;
    for (let sampleIndex = left; sampleIndex <= right; sampleIndex += 1) {
        const distance = sampleIndex - oneBasedIndex;
        const window = 0.5 + 0.5 * Math.cos((Math.PI * distance) / windowDepth);
        result += samples[sampleIndex - 1] * sinc(distance) * window;
    }
    return result;
}

export function resampleForFormants(
    samples: Float32Array,
    sampleRate: number,
    targetSampleRate: number
) {
    if (Math.abs(sampleRate - targetSampleRate) < 1) {
        return new Float64Array(samples);
    }

    const inputSamplePeriod = 1 / sampleRate;
    const durationSeconds = samples.length * inputSamplePeriod;
    const outputLength = Math.max(1, Math.round(durationSeconds * targetSampleRate));
    const output = new Float64Array(outputLength);
    const inputFirstSampleTime = 0.5 * inputSamplePeriod;
    const outputFirstSampleTime = 0.5 * (durationSeconds - (outputLength - 1) / targetSampleRate);
    const interpolationDepth = 50;
    const sampleRateFactor = targetSampleRate / sampleRate;
    const filtered =
        sampleRateFactor < 1
            ? praatAntiAliasFilter(samples, sampleRateFactor)
            : new Float64Array(samples);

    for (let outputIndex = 0; outputIndex < outputLength; outputIndex += 1) {
        const outputTime = outputFirstSampleTime + outputIndex / targetSampleRate;
        const oneBasedIndex = (outputTime - inputFirstSampleTime) / inputSamplePeriod + 1;
        output[outputIndex] = praatSincInterpolate(filtered, oneBasedIndex, interpolationDepth);
    }
    return output;
}

function praatBurgCoefficients(signal: Float64Array, order: number) {
    const coefficients = new Float64Array(order);
    if (signal.length <= order + 1) {
        return null;
    }

    const forward = new Float64Array(signal.length);
    const backward = new Float64Array(signal.length);
    const previousCoefficients = new Float64Array(order);
    forward[0] = signal[0];
    backward[signal.length - 2] = signal[signal.length - 1];
    for (let index = 1; index <= signal.length - 2; index += 1) {
        forward[index] = signal[index];
        backward[index - 1] = signal[index];
    }

    for (let currentOrder = 0; currentOrder < order; currentOrder += 1) {
        let numerator = 0;
        let denominator = 0;
        for (let index = 0; index < signal.length - currentOrder - 1; index += 1) {
            numerator += forward[index] * backward[index];
            denominator += forward[index] * forward[index] + backward[index] * backward[index];
        }
        if (!(denominator > 0) || !Number.isFinite(denominator)) {
            return null;
        }

        coefficients[currentOrder] = (2 * numerator) / denominator;
        if (!Number.isFinite(coefficients[currentOrder])) {
            return null;
        }
        for (let index = 0; index < currentOrder; index += 1) {
            coefficients[index] =
                previousCoefficients[index] -
                coefficients[currentOrder] * previousCoefficients[currentOrder - index - 1];
        }

        if (currentOrder + 1 < order) {
            previousCoefficients.set(coefficients);
            for (let index = 0; index < signal.length - currentOrder - 2; index += 1) {
                forward[index] -= coefficients[currentOrder] * backward[index];
                backward[index] =
                    backward[index + 1] - coefficients[currentOrder] * forward[index + 1];
            }
        }
    }
    return coefficients;
}

function evaluatePolynomialAndDerivative(coefficients: Float64Array, root: Complex) {
    let value = { re: coefficients[0], im: 0 };
    let derivative = { re: 0, im: 0 };
    for (let index = 1; index < coefficients.length; index += 1) {
        derivative = {
            re: derivative.re * root.re - derivative.im * root.im + value.re,
            im: derivative.re * root.im + derivative.im * root.re + value.im,
        };
        value = {
            re: value.re * root.re - value.im * root.im + coefficients[index],
            im: value.re * root.im + value.im * root.re,
        };
    }
    return { value, derivative };
}

function polishAndValidateRoot(coefficients: Float64Array, initialRoot: Complex) {
    let root = initialRoot;
    for (let iteration = 0; iteration < 12; iteration += 1) {
        const { value, derivative } = evaluatePolynomialAndDerivative(coefficients, root);
        const denominator = derivative.re * derivative.re + derivative.im * derivative.im;
        if (!(denominator > 1e-28)) {
            break;
        }
        const correction = {
            re: (value.re * derivative.re + value.im * derivative.im) / denominator,
            im: (value.im * derivative.re - value.re * derivative.im) / denominator,
        };
        root = { re: root.re - correction.re, im: root.im - correction.im };
        if (Math.hypot(correction.re, correction.im) < 1e-12 * (1 + Math.hypot(root.re, root.im))) {
            break;
        }
    }

    const { value } = evaluatePolynomialAndDerivative(coefficients, root);
    const magnitude = Math.hypot(root.re, root.im);
    let scale = 0;
    for (let index = 0; index < coefficients.length; index += 1) {
        scale += Math.abs(coefficients[index]) * magnitude ** (coefficients.length - index - 1);
    }
    const relativeResidual = Math.hypot(value.re, value.im) / Math.max(1e-30, scale);
    return Number.isFinite(relativeResidual) && relativeResidual <= 1e-8 ? root : null;
}

function polynomialRoots(coefficients: Float64Array) {
    const degree = coefficients.length - 1;
    const ascending = new Float64Array(coefficients).reverse();
    const companion = Matrix.zeros(degree, degree);
    for (let row = 0; row < degree; row += 1) {
        companion.set(row, degree - 1, -ascending[row] / ascending[degree]);
        if (row > 0) {
            companion.set(row, row - 1, 1);
        }
    }
    const decomposition = new EigenvalueDecomposition(companion);
    const real = decomposition.realEigenvalues;
    const imaginary = decomposition.imaginaryEigenvalues;
    const roots: Complex[] = [];
    for (let index = 0; index < degree; index += 1) {
        const root = polishAndValidateRoot(coefficients, {
            re: real[index],
            im: imaginary[index],
        });
        if (root !== null) {
            roots.push(root);
        }
    }
    return roots;
}

function prepareFormantSignal(
    samples: Float32Array,
    sampleRate: number,
    options: AnalysisOptions
): PreparedFormantSignal {
    const targetSampleRate = Math.min(sampleRate, Math.max(2000, options.formantCeilingHz * 2));
    const resampled = resampleForFormants(samples, sampleRate, targetSampleRate);
    const emphasis = Math.exp((-2 * Math.PI * options.preEmphasisFromHz) / targetSampleRate);
    for (let index = resampled.length - 1; index >= 1; index -= 1) {
        resampled[index] -= emphasis * resampled[index - 1];
    }
    const sourceDurationSeconds = samples.length * (1 / sampleRate);
    return {
        samples: resampled,
        sampleRate: targetSampleRate,
        firstSampleTimeSeconds:
            0.5 * (sourceDurationSeconds - (resampled.length - 1) / targetSampleRate),
        durationSeconds: resampled.length * (1 / targetSampleRate),
    };
}

function estimatePreparedFormants(
    prepared: PreparedFormantSignal,
    centreTimeSeconds: number,
    options: AnalysisOptions
): FormantFrameAnalysis {
    const maximumFormants = clamp(Math.round(options.maximumFormants * 2) / 2, 1, 8);
    const poleCount = Math.max(2, Math.round(maximumFormants * 2));
    const empty = () => new Array(Math.ceil(maximumFormants)).fill(null);
    const emptyResult = (intensity = 0): FormantFrameAnalysis => ({
        timeSeconds: centreTimeSeconds,
        formantsHz: empty(),
        formantBandwidthsHz: empty(),
        formantIntensity: intensity,
    });
    if (prepared.samples.length < poleCount + 1) {
        return emptyResult();
    }

    const actualWindowSeconds = options.formantWindowLengthSeconds * 2;
    const nominalWindowLength = Math.max(
        poleCount + 1,
        Math.floor(actualWindowSeconds / (1 / prepared.sampleRate))
    );
    const halfWindowLength = Math.floor(nominalWindowLength / 2);
    const lowIndex = Math.floor(
        (centreTimeSeconds - prepared.firstSampleTimeSeconds) / (1 / prepared.sampleRate)
    );
    const startIndex = Math.max(0, lowIndex + 1 - halfWindowLength);
    const endIndex = Math.min(prepared.samples.length - 1, lowIndex + halfWindowLength);
    const actualWindowLength = endIndex - startIndex + 1;
    if (actualWindowLength < poleCount + 1) {
        return emptyResult();
    }

    const signal = new Float64Array(actualWindowLength);
    const midpoint = 0.5 * (nominalWindowLength + 1);
    const edge = Math.exp(-12);
    let maximumIntensity = 0;
    for (let index = 0; index < actualWindowLength; index += 1) {
        const sample = prepared.samples[startIndex + index];
        maximumIntensity = Math.max(maximumIntensity, sample * sample);
        const praatIndex = index + 1;
        const window =
            (Math.exp(
                (-48 * (praatIndex - midpoint) * (praatIndex - midpoint)) /
                    ((nominalWindowLength + 1) * (nominalWindowLength + 1))
            ) -
                edge) /
            (1 - edge);
        signal[index] = sample * window;
    }
    if (!(maximumIntensity > 0)) {
        return emptyResult();
    }

    const predictorCoefficients = praatBurgCoefficients(signal, poleCount);
    if (predictorCoefficients === null) {
        return emptyResult(maximumIntensity);
    }
    const polynomial = new Float64Array(poleCount + 1);
    polynomial[0] = 1;
    for (let index = 0; index < poleCount; index += 1) {
        polynomial[index + 1] = -predictorCoefficients[index];
    }

    const candidates = polynomialRoots(polynomial)
        .map((root) => {
            const magnitudeSquared = root.re * root.re + root.im * root.im;
            return magnitudeSquared > 1
                ? {
                      re: root.re / magnitudeSquared,
                      im: root.im / magnitudeSquared,
                  }
                : root;
        })
        .filter((root) => root.im >= 0)
        .map((root) => {
            const angle = Math.atan2(root.im, root.re);
            const frequency = (Math.abs(angle) * prepared.sampleRate) / (2 * Math.PI);
            const magnitude = Math.sqrt(root.re * root.re + root.im * root.im);
            const bandwidth =
                (-prepared.sampleRate * Math.log(Math.max(1e-15, Math.min(1, magnitude)))) /
                Math.PI;
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
        timeSeconds: centreTimeSeconds,
        formantsHz: new Array(resultLength)
            .fill(null)
            .map((_, index) => (candidates[index] ? candidates[index].frequency : null)),
        formantBandwidthsHz: new Array(resultLength)
            .fill(null)
            .map((_, index) => (candidates[index] ? candidates[index].bandwidth : null)),
        formantIntensity: maximumIntensity,
    };
}

export function analyzeFormantFrames(
    samples: Float32Array,
    sampleRate: number,
    partialOptions: Partial<AnalysisOptions> = {}
) {
    const options = { ...DEFAULT_OPTIONS, ...partialOptions };
    const prepared = prepareFormantSignal(samples, sampleRate, options);
    const actualWindowSeconds = options.formantWindowLengthSeconds * 2;
    const timeStepSeconds = options.formantWindowLengthSeconds / 4;
    let frameCount =
        1 + Math.floor((prepared.durationSeconds - actualWindowSeconds) / timeStepSeconds);
    let firstFrameTime =
        prepared.firstSampleTimeSeconds +
        0.5 *
            (prepared.durationSeconds -
                1 / prepared.sampleRate -
                (frameCount - 1) * timeStepSeconds);
    if (frameCount < 1) {
        frameCount = 1;
        firstFrameTime = prepared.firstSampleTimeSeconds + 0.5 * prepared.durationSeconds;
    }
    const frames: FormantFrameAnalysis[] = [];
    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
        frames.push(
            estimatePreparedFormants(
                prepared,
                firstFrameTime + frameIndex * timeStepSeconds,
                options
            )
        );
    }
    return frames;
}

export function analyzeFormantsAtTimes(
    samples: Float32Array,
    sampleRate: number,
    centreTimesSeconds: number[],
    partialOptions: Partial<AnalysisOptions> = {}
) {
    const options = { ...DEFAULT_OPTIONS, ...partialOptions };
    const prepared = prepareFormantSignal(samples, sampleRate, options);
    return centreTimesSeconds.map((centreTimeSeconds) =>
        estimatePreparedFormants(prepared, centreTimeSeconds, options)
    );
}

export function analyzePitchAndIntensityFrame(
    samples: Float32Array,
    sampleRate: number,
    partialOptions: Partial<AnalysisOptions> = {},
    centreSample = 0.5 * (samples.length - 1),
    layers: Pick<AnalysisLayerSelection, 'pitch' | 'intensity'> = {
        pitch: true,
        intensity: true,
    }
) {
    const options = { ...DEFAULT_OPTIONS, ...partialOptions };
    const intensityDbSpl = layers.intensity
        ? calculateIntensityDbSpl(
              samples,
              sampleRate,
              options.intensityPitchFloorHz,
              options.splCalibrationDb,
              centreSample
          )
        : 0;
    if (!layers.pitch) {
        return {
            pitchHz: null,
            pitchConfidence: 0,
            intensityDbSpl,
        };
    }
    const pitch =
        options.pitchAlgorithm === 'autocorrelation'
            ? detectPitchAutocorrelation(
                  samples,
                  sampleRate,
                  options.minPitchHz,
                  options.maxPitchHz,
                  centreSample
              )
            : detectPitchYin(
                  samples,
                  sampleRate,
                  options.minPitchHz,
                  options.maxPitchHz,
                  centreSample
              );
    const voiced = pitch.pitchHz !== null && pitch.confidence >= options.voicingThreshold;
    return {
        pitchHz: voiced ? pitch.pitchHz : null,
        pitchConfidence: pitch.confidence,
        intensityDbSpl,
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
    const pitchAndIntensity = analyzePitchAndIntensityFrame(samples, sampleRate, options);
    const formantFrames = analyzeFormantFrames(samples, sampleRate, options);
    const formants =
        formantFrames[Math.floor(formantFrames.length / 2)] ||
        ({
            formantsHz: new Array(Math.ceil(options.maximumFormants)).fill(null),
            formantBandwidthsHz: new Array(Math.ceil(options.maximumFormants)).fill(null),
            formantIntensity: 0,
        } as FormantFrameAnalysis);
    return {
        ...pitchAndIntensity,
        formantsHz: formants.formantsHz,
        formantBandwidthsHz: formants.formantBandwidthsHz,
        formantIntensity: formants.formantIntensity,
        drawFormants: true,
    };
}
