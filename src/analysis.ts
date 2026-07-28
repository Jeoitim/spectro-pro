import { clamp } from './math-util';

export type PitchAlgorithm = 'autocorrelation' | 'yin';

export interface AnalysisOptions {
    pitchAlgorithm: PitchAlgorithm;
    minPitchHz: number;
    maxPitchHz: number;
    formantCeilingHz: number;
    splCalibrationDb: number;
}

export interface AcousticAnalysis {
    pitchHz: number | null;
    pitchConfidence: number;
    intensityDbSpl: number;
    formantsHz: [number | null, number | null, number | null];
}

interface Complex {
    re: number;
    im: number;
}

const DEFAULT_OPTIONS: AnalysisOptions = {
    pitchAlgorithm: 'yin',
    minPitchHz: 75,
    maxPitchHz: 500,
    formantCeilingHz: 5500,
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
        const weight =
            besselI0(20 * Math.sqrt(Math.max(0, 1 - ratio * ratio))) /
            denominator;
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
            if (correlation > 0.92) {
                break;
            }
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
        difference[lag] =
            runningSum === 0 ? 1 : (difference[lag] * lag) / runningSum;
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
    const radius = 0.72;
    for (let i = 0; i < degree; i += 1) {
        const angle = (2 * Math.PI * i) / degree + 0.17;
        roots.push({ re: radius * Math.cos(angle), im: radius * Math.sin(angle) });
    }

    for (let iteration = 0; iteration < 45; iteration += 1) {
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
            const correction = complexDivide(evaluatePolynomial(coefficients, roots[i]), denominator);
            roots[i] = {
                re: roots[i].re - correction.re,
                im: roots[i].im - correction.im,
            };
            maximumChange = Math.max(maximumChange, Math.sqrt(correction.re ** 2 + correction.im ** 2));
        }
        if (maximumChange < 1e-7) {
            break;
        }
    }
    return roots;
}

function estimateFormants(
    samples: Float32Array,
    sampleRate: number,
    ceilingHz: number
): [number | null, number | null, number | null] {
    if (samples.length < 64) {
        return [null, null, null];
    }

    const order = 12;
    const signal = new Float64Array(samples.length);
    let energy = 0;
    for (let i = 0; i < samples.length; i += 1) {
        const previous = i === 0 ? 0 : samples[i - 1];
        const value = samples[i] - 0.97 * previous;
        const window = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (samples.length - 1));
        signal[i] = value * window;
        energy += signal[i] * signal[i];
    }
    if (Math.sqrt(energy / signal.length) < 0.0015) {
        return [null, null, null];
    }

    const autocorrelation = new Float64Array(order + 1);
    for (let lag = 0; lag <= order; lag += 1) {
        let sum = 0;
        for (let i = lag; i < signal.length; i += 1) {
            sum += signal[i] * signal[i - lag];
        }
        autocorrelation[lag] = sum;
    }

    let predictionError = autocorrelation[0];
    const lpc = new Float64Array(order + 1);
    lpc[0] = 1;
    for (let i = 1; i <= order; i += 1) {
        let sum = autocorrelation[i];
        for (let j = 1; j < i; j += 1) {
            sum += lpc[j] * autocorrelation[i - j];
        }
        const reflection = -sum / Math.max(1e-12, predictionError);
        const previous = new Float64Array(lpc);
        lpc[i] = reflection;
        for (let j = 1; j < i; j += 1) {
            lpc[j] = previous[j] + reflection * previous[i - j];
        }
        predictionError *= Math.max(1e-6, 1 - reflection * reflection);
    }

    const candidates = polynomialRoots(lpc)
        .filter((root) => root.im > 0)
        .map((root) => {
            const angle = Math.atan2(root.im, root.re);
            const frequency = (angle * sampleRate) / (2 * Math.PI);
            const magnitude = Math.sqrt(root.re * root.re + root.im * root.im);
            const bandwidth = (-sampleRate * Math.log(Math.max(1e-9, magnitude))) / Math.PI;
            return { frequency, bandwidth };
        })
        .filter(
            ({ frequency, bandwidth }) =>
                frequency > 90 &&
                frequency < ceilingHz &&
                bandwidth > 0 &&
                bandwidth < 700
        )
        .sort((a, b) => a.frequency - b.frequency);

    return [
        candidates.length > 0 ? candidates[0].frequency : null,
        candidates.length > 1 ? candidates[1].frequency : null,
        candidates.length > 2 ? candidates[2].frequency : null,
    ];
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
        options.minPitchHz,
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

    const voiced = pitch.pitchHz !== null && pitch.confidence >= 0.6;
    return {
        pitchHz: voiced ? pitch.pitchHz : null,
        pitchConfidence: pitch.confidence,
        intensityDbSpl,
        formantsHz: voiced
            ? estimateFormants(samples, sampleRate, options.formantCeilingHz)
            : [null, null, null],
    };
}
