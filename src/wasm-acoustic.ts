import {
    AcceleratedAnalysisBackend,
    installAcceleratedAnalysisBackend,
    PitchAlgorithm,
} from './analysis';
import { prepareAcousticWasmModule } from './acoustic-wasm-module';

interface AcousticWasmExports extends WebAssembly.Exports {
    memory: WebAssembly.Memory;
    allocate_f64(length: number): number;
    deallocate_f64(pointer: number, capacity: number): void;
    detect_pitch_yin(
        signalPointer: number,
        signalLength: number,
        sampleRate: number,
        minimumPitchHz: number,
        maximumPitchHz: number,
        outputPointer: number
    ): number;
    detect_pitch_autocorrelation(
        signalPointer: number,
        signalLength: number,
        sampleRate: number,
        minimumPitchHz: number,
        maximumPitchHz: number,
        outputPointer: number
    ): number;
    polynomial_roots(
        coefficientsPointer: number,
        coefficientCount: number,
        outputPointer: number
    ): number;
}

function copyToWasm(exports: AcousticWasmExports, values: Float64Array) {
    const pointer = exports.allocate_f64(values.length);
    new Float64Array(exports.memory.buffer, pointer, values.length).set(values);
    return pointer;
}

function createBackend(exports: AcousticWasmExports): AcceleratedAnalysisBackend {
    let disabled = false;
    return {
        detectPitch(
            algorithm: PitchAlgorithm,
            signal: Float64Array,
            sampleRate: number,
            minPitchHz: number,
            maxPitchHz: number
        ) {
            if (disabled) {
                return null;
            }
            const signalPointer = copyToWasm(exports, signal);
            const outputPointer = exports.allocate_f64(2);
            try {
                const detected =
                    algorithm === 'yin'
                        ? exports.detect_pitch_yin(
                              signalPointer,
                              signal.length,
                              sampleRate,
                              minPitchHz,
                              maxPitchHz,
                              outputPointer
                          )
                        : exports.detect_pitch_autocorrelation(
                              signalPointer,
                              signal.length,
                              sampleRate,
                              minPitchHz,
                              maxPitchHz,
                              outputPointer
                          );
                const output = new Float64Array(exports.memory.buffer, outputPointer, 2);
                return {
                    pitchHz: detected === 1 && Number.isFinite(output[0]) ? output[0] : null,
                    confidence: Number.isFinite(output[1]) ? output[1] : 0,
                };
            } catch {
                disabled = true;
                return null;
            } finally {
                exports.deallocate_f64(outputPointer, 2);
                exports.deallocate_f64(signalPointer, signal.length);
            }
        },
        polynomialRoots(coefficients: Float64Array) {
            if (disabled) {
                return null;
            }
            const degree = coefficients.length - 1;
            const coefficientsPointer = copyToWasm(exports, coefficients);
            const outputLength = 2 * degree;
            const outputPointer = exports.allocate_f64(outputLength);
            try {
                const rootCount = exports.polynomial_roots(
                    coefficientsPointer,
                    coefficients.length,
                    outputPointer
                );
                if (rootCount !== degree) {
                    return null;
                }
                const output = new Float64Array(exports.memory.buffer, outputPointer, outputLength);
                return new Array(rootCount).fill(null).map((_, index) => ({
                    re: output[2 * index],
                    im: output[2 * index + 1],
                }));
            } catch {
                disabled = true;
                return null;
            } finally {
                exports.deallocate_f64(outputPointer, outputLength);
                exports.deallocate_f64(coefficientsPointer, coefficients.length);
            }
        },
    };
}

export async function initializeAcousticWasm(preparedModule?: WebAssembly.Module) {
    try {
        const module = preparedModule || (await prepareAcousticWasmModule());
        if (module === null) {
            throw new Error('Acoustic Wasm module is unavailable');
        }
        const instance = await WebAssembly.instantiate(module, {});
        installAcceleratedAnalysisBackend(createBackend(instance.exports as AcousticWasmExports));
        return true;
    } catch (error) {
        installAcceleratedAnalysisBackend(null);
        console.warn('Wasm SIMD acoustic acceleration is unavailable; using JavaScript', error);
        return false;
    }
}
