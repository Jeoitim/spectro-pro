import {
    analyzeAcousticFrame,
    AnalysisOptions,
    PitchAlgorithm,
    resampleForFormants,
} from '../src/analysis';
import { translate } from '../src/i18n';
import { frequencyToScale, scaleToFrequency } from '../src/math-util';
import { generateSpectrogram, Scale } from '../src/spectrogram';

const SAMPLE_RATE = 48000;
const FORMANT_SAMPLE_RATE = 11000;
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

function testSpectrogramDisplayPreEmphasis() {
    const peakForTone = (frequencyHz: number) => {
        const samples = syntheticTone(frequencyHz, 0.05, 0.02);
        const result = generateSpectrogram(samples, 0, samples.length, {
            windowSize: 240,
            fftSize: 1024,
            windowStepSize: 240,
            sampleRate: SAMPLE_RATE,
            scaleSize: 512,
        });
        let peak = 0;
        for (let i = 0; i < result.spectrogram.length; i += 1) {
            peak = Math.max(peak, result.spectrogram[i]);
        }
        return peak;
    };
    const lowPeak = peakForTone(250);
    const highPeak = peakForTone(2000);
    if (highPeak <= lowPeak * 3) {
        throw new Error(
            `spectrogram pre-emphasis: expected upper frequencies to be clearer; received ${lowPeak} and ${highPeak}`
        );
    }
    const defaultSensitivity = 10 ** (2 + 0.42 * 2);
    const defaultContrast = 10 ** (0.5 + 0.32 * 3) - 1;
    const lowDisplayIntensity =
        Math.log(
            1 + Math.min(1, lowPeak * defaultSensitivity) * defaultContrast
        ) / Math.log(1 + defaultContrast);
    if (lowDisplayIntensity < 0.15) {
        throw new Error(
            `spectrogram display mapping: expected visible low-frequency energy; received ${lowDisplayIntensity}`
        );
    }
}

function testFrequencyScales() {
    const scales: Scale[] = ['linear', 'log', 'mel', 'bark', 'erb'];
    const frequencies = [0, 75, 250, 1000, 5500, 10000];
    for (const scale of scales) {
        let previous = -1;
        for (const frequency of frequencies) {
            const scaled = frequencyToScale(frequency, scale);
            if (scaled < previous) {
                throw new Error(`${scale} scale is not monotonic at ${frequency} Hz`);
            }
            assertNear(
                `${scale} scale round trip`,
                scaleToFrequency(scaled, scale),
                frequency,
                Math.max(1e-6, frequency * 1e-9)
            );
            previous = scaled;
        }
    }
}

function testLocalization() {
    if (translate('导入音频', 'en') !== 'Import audio') {
        throw new Error('English localization did not translate a known label');
    }
    if (translate('导入音频', 'zh') !== '导入音频') {
        throw new Error(
            'Chinese localization did not preserve its source label'
        );
    }
    if (translate('user-audio.wav', 'en') !== 'user-audio.wav') {
        throw new Error('Localization changed an unknown user-provided label');
    }
}

testPitch('yin');
testPitch('autocorrelation');
testIntensity();
testFormants();
testSpectrogramDisplayPreEmphasis();
testFrequencyScales();
testLocalization();

console.log('Synthetic pitch, SPL, formant and spectrogram checks passed.');
