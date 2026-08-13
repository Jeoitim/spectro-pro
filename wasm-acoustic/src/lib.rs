use nalgebra::{linalg::Schur, DMatrix};

#[no_mangle]
pub extern "C" fn allocate_f64(length: usize) -> *mut f64 {
    Box::into_raw(vec![0.0_f64; length].into_boxed_slice()) as *mut f64
}

#[no_mangle]
/// # Safety
/// `pointer` must have been returned by `allocate_f64` with the same `length`,
/// and must not have been deallocated previously.
pub unsafe extern "C" fn deallocate_f64(pointer: *mut f64, length: usize) {
    if !pointer.is_null() && length > 0 {
        drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(
            pointer, length,
        )));
    }
}

#[inline]
fn parabolic_peak(values: &[f64], index: usize) -> f64 {
    if index == 0 || index + 1 >= values.len() {
        return index as f64;
    }
    let left = values[index - 1];
    let centre = values[index];
    let right = values[index + 1];
    let denominator = left - 2.0 * centre + right;
    if denominator.abs() < 1e-12 {
        index as f64
    } else {
        index as f64 + 0.5 * (left - right) / denominator
    }
}

#[cfg(target_arch = "wasm32")]
#[target_feature(enable = "simd128")]
unsafe fn sum_squared_difference(signal: &[f64], lag: usize, count: usize) -> f64 {
    use core::arch::wasm32::*;
    let mut vector_sum = f64x2_splat(0.0);
    let mut index = 0;
    while index + 2 <= count {
        let left = v128_load(signal.as_ptr().add(index) as *const v128);
        let right = v128_load(signal.as_ptr().add(index + lag) as *const v128);
        let difference = f64x2_sub(left, right);
        vector_sum = f64x2_add(vector_sum, f64x2_mul(difference, difference));
        index += 2;
    }
    let mut sum = f64x2_extract_lane::<0>(vector_sum) + f64x2_extract_lane::<1>(vector_sum);
    while index < count {
        let difference = signal[index] - signal[index + lag];
        sum += difference * difference;
        index += 1;
    }
    sum
}

#[cfg(target_arch = "wasm32")]
#[target_feature(enable = "simd128")]
unsafe fn dot_product(left: &[f64], right: &[f64], count: usize) -> f64 {
    use core::arch::wasm32::*;
    let mut vector_sum = f64x2_splat(0.0);
    let mut index = 0;
    while index + 2 <= count {
        let a = v128_load(left.as_ptr().add(index) as *const v128);
        let b = v128_load(right.as_ptr().add(index) as *const v128);
        vector_sum = f64x2_add(vector_sum, f64x2_mul(a, b));
        index += 2;
    }
    let mut sum = f64x2_extract_lane::<0>(vector_sum) + f64x2_extract_lane::<1>(vector_sum);
    while index < count {
        sum += left[index] * right[index];
        index += 1;
    }
    sum
}

#[no_mangle]
#[target_feature(enable = "simd128")]
/// # Safety
/// `signal_pointer` must address `signal_length` readable f64 values and
/// `output_pointer` must address two writable f64 values in this module's memory.
pub unsafe extern "C" fn detect_pitch_yin(
    signal_pointer: *const f64,
    signal_length: usize,
    sample_rate: f64,
    minimum_pitch_hz: f64,
    maximum_pitch_hz: f64,
    output_pointer: *mut f64,
) -> i32 {
    if signal_pointer.is_null() || output_pointer.is_null() || signal_length < 4 {
        return 0;
    }
    let signal = std::slice::from_raw_parts(signal_pointer, signal_length);
    let minimum_lag = ((sample_rate / maximum_pitch_hz).floor() as usize).max(2);
    let maximum_lag = ((sample_rate / minimum_pitch_hz).floor() as usize).min(signal_length / 2);
    if maximum_lag <= minimum_lag {
        return 0;
    }

    let mut difference = vec![0.0; maximum_lag + 1];
    let comparison_count = signal_length - maximum_lag;
    for (lag, value) in difference.iter_mut().enumerate().skip(1) {
        *value = sum_squared_difference(signal, lag, comparison_count);
    }
    let mut running_sum = 0.0;
    difference[0] = 1.0;
    for (lag, value) in difference.iter_mut().enumerate().skip(1) {
        running_sum += *value;
        *value = if running_sum == 0.0 {
            1.0
        } else {
            *value * lag as f64 / running_sum
        };
    }

    let mut best_lag: Option<usize> = None;
    let mut best_value = 1.0;
    let mut lag = minimum_lag;
    while lag <= maximum_lag {
        if difference[lag] < 0.15 {
            while lag < maximum_lag && difference[lag + 1] < difference[lag] {
                lag += 1;
            }
            best_lag = Some(lag);
            best_value = difference[lag];
            break;
        }
        if difference[lag] < best_value {
            best_lag = Some(lag);
            best_value = difference[lag];
        }
        lag += 1;
    }
    let confidence = (1.0 - best_value).clamp(0.0, 1.0);
    *output_pointer.add(1) = confidence;
    let Some(best_lag) = best_lag else {
        return 0;
    };
    if best_value > 0.35 {
        return 0;
    }
    let inverted = difference.iter().map(|value| -*value).collect::<Vec<_>>();
    let refined_lag = parabolic_peak(&inverted, best_lag);
    *output_pointer = sample_rate / refined_lag;
    1
}

#[no_mangle]
#[target_feature(enable = "simd128")]
/// # Safety
/// `signal_pointer` must address `signal_length` readable f64 values and
/// `output_pointer` must address two writable f64 values in this module's memory.
pub unsafe extern "C" fn detect_pitch_autocorrelation(
    signal_pointer: *const f64,
    signal_length: usize,
    sample_rate: f64,
    minimum_pitch_hz: f64,
    maximum_pitch_hz: f64,
    output_pointer: *mut f64,
) -> i32 {
    if signal_pointer.is_null() || output_pointer.is_null() || signal_length < 4 {
        return 0;
    }
    let signal = std::slice::from_raw_parts(signal_pointer, signal_length);
    let minimum_lag = ((sample_rate / maximum_pitch_hz).floor() as usize).max(2);
    let maximum_lag = ((sample_rate / minimum_pitch_hz).floor() as usize).min(signal_length - 3);
    if maximum_lag <= minimum_lag {
        return 0;
    }
    let mut window = vec![0.0; signal_length];
    let mut windowed_signal = vec![0.0; signal_length];
    for index in 0..signal_length {
        window[index] = 0.5
            - 0.5
                * (2.0 * std::f64::consts::PI * (index + 1) as f64 / (signal_length + 1) as f64)
                    .cos();
        windowed_signal[index] = signal[index] * window[index];
    }
    let signal_power = dot_product(&windowed_signal, &windowed_signal, signal_length);
    let window_power = dot_product(&window, &window, signal_length);
    let mut correlations = vec![0.0; maximum_lag + 2];
    for lag in 1..=maximum_lag + 1 {
        let count = signal_length - lag;
        let signal_correlation = dot_product(&windowed_signal, &windowed_signal[lag..], count);
        let window_correlation = dot_product(&window, &window[lag..], count);
        let normalized_window_correlation = window_correlation / window_power.max(f64::EPSILON);
        let raw_correlation =
            signal_correlation / (signal_power * normalized_window_correlation).max(f64::EPSILON);
        correlations[lag] = if raw_correlation > 1.0 {
            1.0 / raw_correlation
        } else {
            raw_correlation
        };
    }
    let mut best_lag = minimum_lag;
    let mut best_score = f64::NEG_INFINITY;
    for lag in minimum_lag..=maximum_lag {
        let correlation = correlations[lag];
        if correlation > 0.3
            && correlation > correlations[lag - 1]
            && correlation >= correlations[lag + 1]
        {
            let frequency = sample_rate / lag as f64;
            let score = correlation + 0.01 * (frequency / minimum_pitch_hz).max(1.0).log2();
            if score > best_score {
                best_score = score;
                best_lag = lag;
            }
        }
    }
    if !best_score.is_finite() {
        *output_pointer.add(1) = 0.0;
        return 0;
    }
    let refined_lag = parabolic_peak(&correlations, best_lag);
    *output_pointer = sample_rate / refined_lag;
    *output_pointer.add(1) = correlations[best_lag].clamp(0.0, 1.0);
    1
}

#[no_mangle]
/// # Safety
/// `coefficients_pointer` must address `coefficient_count` readable f64 values
/// and `output_pointer` must address twice the polynomial degree writable f64 values.
pub unsafe extern "C" fn polynomial_roots(
    coefficients_pointer: *const f64,
    coefficient_count: usize,
    output_pointer: *mut f64,
) -> usize {
    if coefficients_pointer.is_null() || output_pointer.is_null() || coefficient_count < 2 {
        return 0;
    }
    let coefficients = std::slice::from_raw_parts(coefficients_pointer, coefficient_count);
    let degree = coefficient_count - 1;
    let leading = coefficients[0];
    if !leading.is_finite() || leading.abs() < f64::EPSILON {
        return 0;
    }
    let companion = DMatrix::from_fn(degree, degree, |row, column| {
        if column + 1 == degree {
            -coefficients[degree - row] / leading
        } else if row == column + 1 {
            1.0
        } else {
            0.0
        }
    });
    let eigenvalues = Schur::new(companion).complex_eigenvalues();
    for (index, root) in eigenvalues.iter().enumerate() {
        *output_pointer.add(2 * index) = root.re;
        *output_pointer.add(2 * index + 1) = root.im;
    }
    degree
}
