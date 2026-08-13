const { readFileSync } = require('fs');
const {
    analyzeFormantsAtTimes,
    analyzePitchAndIntensityFrame,
    installAcceleratedAnalysisBackend,
} = require('../.test-dist/src/analysis.js');

const bytes = readFileSync(require('path').resolve(__dirname, '../src/wasm/acoustic-core.wasm'));

function copyToWasm(exports, values) {
    const pointer = exports.allocate_f64(values.length);
    new Float64Array(exports.memory.buffer, pointer, values.length).set(values);
    return pointer;
}

function createBackend(exports) {
    return {
        detectPitch(algorithm, signal, sampleRate, minPitchHz, maxPitchHz) {
            const signalPointer = copyToWasm(exports, signal);
            const outputPointer = exports.allocate_f64(2);
            try {
                const detected = exports[
                    algorithm === 'yin'
                        ? 'detect_pitch_yin'
                        : 'detect_pitch_autocorrelation'
                ](signalPointer, signal.length, sampleRate, minPitchHz, maxPitchHz, outputPointer);
                const output = new Float64Array(exports.memory.buffer, outputPointer, 2);
                return {
                    pitchHz: detected === 1 ? output[0] : null,
                    confidence: output[1],
                };
            } finally {
                exports.deallocate_f64(outputPointer, 2);
                exports.deallocate_f64(signalPointer, signal.length);
            }
        },
        polynomialRoots(coefficients) {
            const degree = coefficients.length - 1;
            const coefficientsPointer = copyToWasm(exports, coefficients);
            const outputPointer = exports.allocate_f64(2 * degree);
            try {
                const count = exports.polynomial_roots(
                    coefficientsPointer,
                    coefficients.length,
                    outputPointer
                );
                const output = new Float64Array(exports.memory.buffer, outputPointer, 2 * degree);
                return count === degree
                    ? Array.from({ length: degree }, (_, index) => ({
                          re: output[2 * index],
                          im: output[2 * index + 1],
                      }))
                    : null;
            } finally {
                exports.deallocate_f64(outputPointer, 2 * degree);
                exports.deallocate_f64(coefficientsPointer, coefficients.length);
            }
        },
    };
}

function assertNear(name, actual, expected, tolerance) {
    if (actual === null || expected === null || Math.abs(actual - expected) > tolerance) {
        throw new Error(`${name}: expected ${expected} ± ${tolerance}, received ${actual}`);
    }
}

(async () => {
    if (!WebAssembly.validate(bytes)) {
        throw new Error('Generated acoustic-core.wasm is invalid');
    }
    const { instance } = await WebAssembly.instantiate(bytes, {});
    const sampleRate = 48000;
    const samples = new Float32Array(sampleRate * 0.2);
    for (let index = 0; index < samples.length; index += 1) {
        const time = index / sampleRate;
        samples[index] =
            0.08 * Math.sin(2 * Math.PI * 120 * time) +
            0.03 * Math.sin(2 * Math.PI * 730 * time) +
            0.02 * Math.sin(2 * Math.PI * 1090 * time);
    }
    const options = {
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
    const baselinePitch = {};
    for (const algorithm of ['yin', 'autocorrelation']) {
        baselinePitch[algorithm] = analyzePitchAndIntensityFrame(samples, sampleRate, {
            ...options,
            pitchAlgorithm: algorithm,
        });
    }
    const baselineFormants = analyzeFormantsAtTimes(samples, sampleRate, [0.1], {
        ...options,
        pitchAlgorithm: 'yin',
    })[0];

    installAcceleratedAnalysisBackend(createBackend(instance.exports));
    for (const algorithm of ['yin', 'autocorrelation']) {
        const accelerated = analyzePitchAndIntensityFrame(samples, sampleRate, {
            ...options,
            pitchAlgorithm: algorithm,
        });
        assertNear(`${algorithm} Wasm pitch`, accelerated.pitchHz, baselinePitch[algorithm].pitchHz, 1e-8);
        assertNear(
            `${algorithm} Wasm confidence`,
            accelerated.pitchConfidence,
            baselinePitch[algorithm].pitchConfidence,
            1e-8
        );
    }
    const acceleratedFormants = analyzeFormantsAtTimes(samples, sampleRate, [0.1], {
        ...options,
        pitchAlgorithm: 'yin',
    })[0];
    baselineFormants.formantsHz.forEach((expected, index) => {
        if (expected !== null) {
            assertNear(
                `Wasm formant F${index + 1}`,
                acceleratedFormants.formantsHz[index],
                expected,
                1e-6
            );
        }
    });

    // Regression case from the recording that previously stalled at 93%:
    // the coefficients are finite, but their companion matrix is poorly
    // conditioned and must still return within the bounded Wasm budget.
    const pathologicalCoefficients = new Float64Array([
        1,
        -2.165,
        3.1553,
        -3.4695,
        3.2431,
        -2.701,
        2.0115,
        -1.3205,
        1.0276,
        -0.59061,
        0.20922,
    ]);
    const rootStartedAt = Date.now();
    const pathologicalRoots = createBackend(instance.exports).polynomialRoots(
        pathologicalCoefficients
    );
    const rootElapsedMs = Date.now() - rootStartedAt;
    if (rootElapsedMs > 1000) {
        throw new Error(`Bounded Wasm polynomial-root regression failed (${rootElapsedMs} ms)`);
    }
    if (pathologicalRoots === null) {
        throw new Error('Bounded Wasm polynomial-root regression returned no roots');
    }
    console.log('Wasm SIMD pitch and formant-root parity checks passed.');
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
