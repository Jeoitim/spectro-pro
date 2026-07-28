import {
    analyzeAcousticFrame,
    AnalysisOptions,
    PitchAlgorithm,
    resampleForFormants,
} from '../src/analysis';

const SAMPLE_RATE = 48000;
const FORMANT_SAMPLE_RATE = 11000;
const DEFAULT_OPTIONS: AnalysisOptions = {
    pitchAlgorithm: 'yin',
    minPitchHz: 75,
    maxPitchHz: 500,
    formantCeilingHz: 5500,
    maximumFormants: 5,
    formantWindowLengthSeconds: 0.025,
    preEmphasisFromHz: 50,
    splCalibrationDb: 0,
};

function assertNear(name: string, actual: number | null, expected: number, tolerance: number) {
    if (actual === null || Math.abs(actual - expected) > tolerance) {
        throw new Error(
            `${name}: expected ${expected} ± ${tolerance}, received ${actual}`
        );
    }
}

function deterministicNoise(length: number) {
    const result = new Float64Array(length);
    let state = 0x12345678;
    for (let i = 0; i < length; i += 1) {
        state = (1664525 * state + 1013904223) >>> 0;
        result[i] = (state / 0xffffffff) * 2 - 1;
    }
    return result;
}

function applyResonator(
    input: Float64Array,
    frequencyHz: number,
    bandwidthHz: number,
    sampleRate: number
) {
    const output = new Float64Array(input.length);
    const radius = Math.exp((-Math.PI * bandwidthHz) / sampleRate);
    const coefficient =
        2 * radius * Math.cos((2 * Math.PI * frequencyHz) / sampleRate);
    const radiusSquared = radius * radius;
    for (let i = 0; i < input.length; i += 1) {
        output[i] =
            input[i] +
            coefficient * (i > 0 ? output[i - 1] : 0) -
            radiusSquared * (i > 1 ? output[i - 2] : 0);
    }
    return output;
}

function syntheticAllPoleVowel() {
    const expected = [500, 1500, 2500, 3500, 4500];
    let workingSignal = deterministicNoise(Math.round(FORMANT_SAMPLE_RATE * 0.5));
    expected.forEach((frequency, index) => {
        workingSignal = applyResonator(
            workingSignal,
            frequency,
            70 + index * 20,
            FORMANT_SAMPLE_RATE
        );
    });
    let peak = 0;
    for (let i = 0; i < workingSignal.length; i += 1) {
        peak = Math.max(peak, Math.abs(workingSignal[i]));
    }
    const signal = new Float32Array(workingSignal.length);
    for (let i = 0; i < workingSignal.length; i += 1) {
        signal[i] = (0.35 * workingSignal[i]) / peak;
    }
    return { signal, expected };
}

function syntheticTone(frequencyHz: number, rmsPascals: number, seconds = 0.1) {
    const result = new Float32Array(Math.round(SAMPLE_RATE * seconds));
    const peakPascals = rmsPascals * Math.sqrt(2);
    for (let i = 0; i < result.length; i += 1) {
        result[i] =
            peakPascals * Math.sin((2 * Math.PI * frequencyHz * i) / SAMPLE_RATE);
    }
    return result;
}

function testPitch(algorithm: PitchAlgorithm) {
    const result = analyzeAcousticFrame(
        syntheticTone(200, 0.08),
        SAMPLE_RATE,
        { ...DEFAULT_OPTIONS, pitchAlgorithm: algorithm }
    );
    assertNear(`${algorithm} pitch`, result.pitchHz, 200, 2);
}

function testIntensity() {
    const result = analyzeAcousticFrame(
        syntheticTone(200, 0.00002),
        SAMPLE_RATE,
        DEFAULT_OPTIONS
    );
    assertNear('0 dB SPL reference tone', result.intensityDbSpl, 0, 0.2);
}

function testFormants() {
    const resampledTone = resampleForFormants(
        syntheticTone(1500, 0.1, 0.2),
        SAMPLE_RATE,
        11000
    );
    let crossings = 0;
    for (let i = 1; i < resampledTone.length; i += 1) {
        if (resampledTone[i - 1] <= 0 && resampledTone[i] > 0) {
            crossings += 1;
        }
    }
    assertNear(
        'resampler frequency',
        crossings / (resampledTone.length / 11000),
        1500,
        10
    );
    const { signal, expected } = syntheticAllPoleVowel();
    const result = analyzeAcousticFrame(
        signal,
        FORMANT_SAMPLE_RATE,
        DEFAULT_OPTIONS
    );
    expected.forEach((frequency, index) => {
        assertNear(
            `F${index + 1}`,
            result.formantsHz[index],
            frequency,
            Math.max(120, frequency * 0.08)
        );
    });
}

testPitch('yin');
testPitch('autocorrelation');
testIntensity();
testFormants();

console.log('Synthetic pitch, SPL and five-formant checks passed.');
