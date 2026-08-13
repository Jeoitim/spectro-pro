#[no_mangle]
pub extern "C" fn allocate_f64(length: usize) -> *mut f64 {
    Box::into_raw(vec![0.0_f64; length].into_boxed_slice()) as *mut f64
}

#[derive(Clone, Copy, Default)]
struct Complex64 {
    re: f64,
    im: f64,
}

#[inline]
fn complex_add(left: Complex64, right: Complex64) -> Complex64 {
    Complex64 {
        re: left.re + right.re,
        im: left.im + right.im,
    }
}

#[inline]
fn complex_sub(left: Complex64, right: Complex64) -> Complex64 {
    Complex64 {
        re: left.re - right.re,
        im: left.im - right.im,
    }
}

#[inline]
fn complex_mul(left: Complex64, right: Complex64) -> Complex64 {
    Complex64 {
        re: left.re * right.re - left.im * right.im,
        im: left.re * right.im + left.im * right.re,
    }
}

#[inline]
fn complex_div(left: Complex64, right: Complex64) -> Option<Complex64> {
    let denominator = right.re * right.re + right.im * right.im;
    if !denominator.is_finite() || denominator < 1e-30 {
        return None;
    }
    Some(Complex64 {
        re: (left.re * right.re + left.im * right.im) / denominator,
        im: (left.im * right.re - left.re * right.im) / denominator,
    })
}

#[inline]
fn complex_norm_squared(value: Complex64) -> f64 {
    value.re * value.re + value.im * value.im
}

#[inline]
fn complex_norm(value: Complex64) -> f64 {
    complex_norm_squared(value).sqrt()
}

fn evaluate_polynomial(coefficients: &[f64], root: Complex64) -> (Complex64, Complex64) {
    let mut value = Complex64 {
        re: coefficients[0],
        im: 0.0,
    };
    let mut derivative = Complex64::default();
    for coefficient in coefficients.iter().skip(1) {
        derivative = complex_add(complex_mul(derivative, root), value);
        value = complex_add(
            complex_mul(value, root),
            Complex64 {
                re: *coefficient,
                im: 0.0,
            },
        );
    }
    (value, derivative)
}

fn polynomial_residual(coefficients: &[f64], root: Complex64) -> Option<f64> {
    let (value, _) = evaluate_polynomial(coefficients, root);
    let mut scale = coefficients[0].abs();
    let magnitude = complex_norm(root);
    for coefficient in coefficients.iter().skip(1) {
        scale = scale * magnitude + coefficient.abs();
    }
    let residual = complex_norm(value) / scale.max(1e-30);
    residual.is_finite().then_some(residual)
}

// Aberth-Ehrlich is used instead of an unconstrained Schur/QR iteration here.
// LPC polynomials are small (normally degree 10), so a fixed iteration budget
// gives us a predictable upper bound even for roots that are nearly repeated.
fn bounded_polynomial_roots(coefficients: &[f64]) -> Option<Vec<Complex64>> {
    const MAX_DEGREE: usize = 32;
    const MAX_ITERATIONS: usize = 256;
    const STEP_TOLERANCE: f64 = 1e-13;
    const RESIDUAL_TOLERANCE: f64 = 1e-7;

    let degree = coefficients.len().checked_sub(1)?;
    if degree == 0 || degree > MAX_DEGREE || coefficients.iter().any(|value| !value.is_finite()) {
        return None;
    }

    let leading = coefficients[0];
    let coefficient_scale = coefficients
        .iter()
        .map(|value| value.abs())
        .fold(0.0_f64, f64::max);
    if !leading.is_finite()
        || !coefficient_scale.is_finite()
        || coefficient_scale == 0.0
        || leading.abs() < coefficient_scale * 1e-12
    {
        return None;
    }

    let normalized: Vec<f64> = coefficients.iter().map(|value| *value / leading).collect();
    if normalized.iter().any(|value| !value.is_finite()) {
        return None;
    }
    let cauchy_radius = 1.0
        + normalized
            .iter()
            .skip(1)
            .map(|value| value.abs())
            .fold(0.0_f64, f64::max);
    if !cauchy_radius.is_finite() || cauchy_radius > 1e8 {
        return None;
    }

    let mut roots = Vec::with_capacity(degree);
    let phase = std::f64::consts::PI / (degree as f64 * 3.0);
    for index in 0..degree {
        let angle = phase + 2.0 * std::f64::consts::PI * index as f64 / degree as f64;
        roots.push(Complex64 {
            re: cauchy_radius * angle.cos(),
            im: cauchy_radius * angle.sin(),
        });
    }

    let mut converged = false;
    for _ in 0..MAX_ITERATIONS {
        let mut next_roots = roots.clone();
        let mut maximum_step = 0.0_f64;
        for index in 0..degree {
            let (value, derivative) = evaluate_polynomial(&normalized, roots[index]);
            let Some(newton_step) = complex_div(value, derivative) else {
                return None;
            };
            let mut separation_sum = Complex64::default();
            for other_index in 0..degree {
                if other_index == index {
                    continue;
                }
                let separation = complex_sub(roots[index], roots[other_index]);
                let Some(reciprocal) = complex_div(
                    Complex64 { re: 1.0, im: 0.0 },
                    separation,
                ) else {
                    return None;
                };
                separation_sum = complex_add(separation_sum, reciprocal);
            }
            let correction_denominator = complex_sub(
                Complex64 { re: 1.0, im: 0.0 },
                complex_mul(newton_step, separation_sum),
            );
            let Some(mut correction) = complex_div(newton_step, correction_denominator) else {
                return None;
            };
            let correction_norm = complex_norm(correction);
            let maximum_allowed_step = 2.0 * cauchy_radius;
            if correction_norm > maximum_allowed_step {
                let scale = maximum_allowed_step / correction_norm;
                correction.re *= scale;
                correction.im *= scale;
            }
            next_roots[index] = complex_sub(roots[index], correction);
            maximum_step = maximum_step.max(complex_norm(correction));
        }
        if next_roots.iter().any(|root| {
            !root.re.is_finite() || !root.im.is_finite() || complex_norm(*root) > 1e10
        }) {
            return None;
        }
        roots = next_roots;
        let maximum_root_norm = roots.iter().map(|root| complex_norm(*root)).fold(0.0, f64::max);
        if maximum_step <= STEP_TOLERANCE * (1.0 + maximum_root_norm) {
            converged = true;
            break;
        }
    }

    if !converged
        || roots.iter().any(|root| {
            polynomial_residual(&normalized, *root)
                .map(|residual| residual > RESIDUAL_TOLERANCE)
                .unwrap_or(true)
        })
    {
        return None;
    }
    Some(roots)
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
    let Some(roots) = bounded_polynomial_roots(coefficients) else {
        return 0;
    };
    for (index, root) in roots.iter().enumerate() {
        *output_pointer.add(2 * index) = root.re;
        *output_pointer.add(2 * index + 1) = root.im;
    }
    roots.len()
}
