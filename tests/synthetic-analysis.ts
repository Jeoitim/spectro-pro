import {
    analyzeAcousticFrame,
    analyzeFormantFrames,
    AnalysisOptions,
    PitchAlgorithm,
    resampleForFormants,
} from '../src/analysis';
import { translate } from '../src/i18n';
import { frequencyToScale, scaleToFrequency } from '../src/math-util';
import { generateSpectrogram, Scale, SpectrogramWindowFunction } from '../src/spectrogram';

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
        throw new Error(`${name}: expected ${expected} ± ${tolerance}, received ${actual}`);
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
    const coefficient = 2 * radius * Math.cos((2 * Math.PI * frequencyHz) / sampleRate);
    const radiusSquared = radius * radius;
    for (let i = 0; i < input.length; i += 1) {
        output[i] =
            input[i] +
            coefficient * (i > 0 ? output[i - 1] : 0) -
            radiusSquared * (i > 1 ? output[i - 2] : 0);
    }
    return output;
}

function syntheticAllPoleVowel(sampleRate = FORMANT_SAMPLE_RATE, quantizeToPcm16 = false) {
    const resonances = [500, 1500, 2500, 3500, 4500];
    let workingSignal = deterministicNoise(Math.round(sampleRate * 0.5));
    resonances.forEach((frequency, index) => {
        workingSignal = applyResonator(workingSignal, frequency, 70 + index * 20, sampleRate);
    });
    let peak = 0;
    for (let i = 0; i < workingSignal.length; i += 1) {
        peak = Math.max(peak, Math.abs(workingSignal[i]));
    }
    const signal = new Float32Array(workingSignal.length);
    for (let i = 0; i < workingSignal.length; i += 1) {
        const sample = (0.35 * workingSignal[i]) / peak;
        signal[i] = quantizeToPcm16 ? Math.round(sample * 32767) / 32768 : sample;
    }
    return signal;
}

function syntheticTone(frequencyHz: number, rmsPascals: number, seconds = 0.1) {
    const result = new Float32Array(Math.round(SAMPLE_RATE * seconds));
    const peakPascals = rmsPascals * Math.sqrt(2);
    for (let i = 0; i < result.length; i += 1) {
        result[i] = peakPascals * Math.sin((2 * Math.PI * frequencyHz * i) / SAMPLE_RATE);
    }
    return result;
}

function testPitch(algorithm: PitchAlgorithm) {
    const result = analyzeAcousticFrame(syntheticTone(200, 0.08), SAMPLE_RATE, {
        ...DEFAULT_OPTIONS,
        pitchAlgorithm: algorithm,
    });
    assertNear(`${algorithm} pitch`, result.pitchHz, 200, 2);
}

function testIntensity() {
    const result = analyzeAcousticFrame(syntheticTone(200, 0.00002), SAMPLE_RATE, DEFAULT_OPTIONS);
    assertNear('0 dB SPL reference tone', result.intensityDbSpl, 0, 0.2);
}

function testFormants() {
    const resampledTone = resampleForFormants(syntheticTone(1500, 0.1, 0.2), SAMPLE_RATE, 11000);
    let crossings = 0;
    for (let i = 1; i < resampledTone.length; i += 1) {
        if (resampledTone[i - 1] <= 0 && resampledTone[i] > 0) {
            crossings += 1;
        }
    }
    assertNear('resampler frequency', crossings / (resampledTone.length / 11000), 1500, 10);
    const signal = syntheticAllPoleVowel(FORMANT_SAMPLE_RATE, true);
    const frames = analyzeFormantFrames(signal, FORMANT_SAMPLE_RATE, DEFAULT_OPTIONS);
    if (frames.length !== 72) {
        throw new Error(`Praat frame count: expected 72, received ${frames.length}`);
    }

    // Generated with official Praat 6.6.30, Sound: To Formant (burg), using the
    // same deterministic PCM16 signal and the options above. Tight tolerances
    // catch frame-centre, Gaussian-window, Burg-sign and root-solver regressions.
    const praatReference = [
        [513.937191648, 1509.492099167, 2589.004347864, 3476.164739598, 4528.605165554],
        [528.347458685, 1522.659629405, 2574.712531792, 3488.181198395, 4507.934004596],
        [567.717734392, 1506.942436441, 2489.491837332, 3507.174331971, 4510.796682795],
        [651.972547928, 1524.645321546, 2519.066970126, 3538.61751964, 4556.710100399],
        [576.501617674, 1496.834428503, 2570.068198232, 3549.254298302, 4569.31263075],
        [1497.002437715, 2497.292007516, 3536.117926418, 4505.039454271],
    ];
    praatReference.forEach((expectedFormants, referenceIndex) => {
        const frame = frames[33 + referenceIndex];
        assertNear(
            `Praat frame ${34 + referenceIndex} time`,
            frame.timeSeconds,
            0.234375 + referenceIndex * 0.00625,
            1e-12
        );
        expectedFormants.forEach((frequency, formantIndex) => {
            assertNear(
                `Praat frame ${34 + referenceIndex} F${formantIndex + 1}`,
                frame.formantsHz[formantIndex],
                frequency,
                1e-4
            );
        });
        if (!(frame.formantIntensity > 0) || !Number.isFinite(frame.formantIntensity)) {
            throw new Error(`invalid formant intensity at frame ${34 + referenceIndex}`);
        }
    });

    const result = analyzeAcousticFrame(signal, FORMANT_SAMPLE_RATE, DEFAULT_OPTIONS);
    praatReference[3].forEach((frequency, index) => {
        assertNear(`single-frame F${index + 1}`, result.formantsHz[index], frequency, 1e-4);
    });

    // This second official reference also exercises Praat's FFT anti-alias
    // filter and depth-50 sinc interpolation from 48 kHz down to 11 kHz.
    const signal48k = syntheticAllPoleVowel(SAMPLE_RATE, true);
    const frames48k = analyzeFormantFrames(signal48k, SAMPLE_RATE, DEFAULT_OPTIONS);
    const praat48kReference = [
        [586.546153579, 1482.158913686, 2447.601353887, 3254.000812287, 3844.864007288],
        [550.74608772, 1464.077431281, 2492.77680705, 3482.188099078, 3623.306282571],
        [546.842152855, 1468.52212046, 2494.621071871, 3415.15275582, 3764.868958721],
        [547.531588546, 1438.977280498, 2469.686189493, 3287.187260666, 3988.875012931],
        [584.919579633, 1462.029100359, 2459.488323077, 3560.81236373, 3617.712278197],
        [575.795762459, 1516.19076174, 2446.235166158, 3530.58508219, 3888.590985637],
    ];
    praat48kReference.forEach((expectedFormants, referenceIndex) => {
        const frame = frames48k[33 + referenceIndex];
        expectedFormants.forEach((frequency, formantIndex) => {
            assertNear(
                `Praat 48 kHz frame ${34 + referenceIndex} F${formantIndex + 1}`,
                frame.formantsHz[formantIndex],
                frequency,
                0.004
            );
        });
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
        Math.log(1 + Math.min(1, lowPeak * defaultSensitivity) * defaultContrast) /
        Math.log(1 + defaultContrast);
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

function testSpectrogramWindowFunctions() {
    const functions: SpectrogramWindowFunction[] = [
        'rectangular',
        'hamming',
        'bartlett',
        'welch',
        'hanning',
        'gaussian',
    ];
    const samples = syntheticTone(440, 0.05, 0.02);
    const defaultResult = generateSpectrogram(samples, 0, samples.length, {
        windowSize: 240,
        fftSize: 512,
        windowStepSize: 240,
        sampleRate: SAMPLE_RATE,
        scaleSize: 128,
    });
    if (defaultResult.options.windowFunction !== 'gaussian') {
        throw new Error('Gaussian must be the default spectrogram window');
    }
    for (const windowFunction of functions) {
        const result = generateSpectrogram(samples, 0, samples.length, {
            windowSize: 240,
            fftSize: 512,
            windowStepSize: 240,
            sampleRate: SAMPLE_RATE,
            scaleSize: 128,
            windowFunction,
        });
        if (
            result.options.windowFunction !== windowFunction ||
            result.spectrogram.some((value) => !Number.isFinite(value))
        ) {
            throw new Error(`invalid ${windowFunction} spectrogram window result`);
        }
    }
}

function testLocalization() {
    if (translate('导入音频', 'en') !== 'Import audio') {
        throw new Error('English localization did not translate a known label');
    }
    if (translate('导入音频', 'zh') !== '导入音频') {
        throw new Error('Chinese localization did not preserve its source label');
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
testSpectrogramWindowFunctions();
testLocalization();

console.log('Synthetic pitch, SPL, formant and spectrogram checks passed.');
