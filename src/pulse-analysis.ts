export interface PulsePitchPoint {
    timeSeconds: number;
    pitchHz: number | null;
    pitchConfidence: number;
}

const MIN_CORRELATION = 0.3;
const EDGE_CORRELATION = 0.7;
const TARGET_SAMPLE_RATE = 12000;

interface VoicedInterval {
    startSeconds: number;
    endSeconds: number;
    points: PulsePitchPoint[];
}

function median(values: number[]) {
    if (values.length === 0) {
        return 0.01;
    }
    const ordered = [...values].sort((left, right) => left - right);
    return ordered[Math.floor(ordered.length / 2)];
}

function voicedIntervals(points: PulsePitchPoint[], durationSeconds: number): VoicedInterval[] {
    if (points.length === 0) {
        return [];
    }
    const positiveSteps = points
        .slice(1)
        .map((point, index) => point.timeSeconds - points[index].timeSeconds)
        .filter((step) => step > 0);
    const frameStep = median(positiveSteps);
    const intervals: VoicedInterval[] = [];
    let voiced: PulsePitchPoint[] = [];

    const finish = () => {
        if (voiced.length === 0) {
            return;
        }
        const firstIndex = points.indexOf(voiced[0]);
        const lastIndex = points.indexOf(voiced[voiced.length - 1]);
        const previous = points[firstIndex - 1];
        const next = points[lastIndex + 1];
        intervals.push({
            startSeconds: Math.max(
                0,
                previous
                    ? 0.5 * (previous.timeSeconds + voiced[0].timeSeconds)
                    : voiced[0].timeSeconds - 0.5 * frameStep
            ),
            endSeconds: Math.min(
                durationSeconds,
                next
                    ? 0.5 * (voiced[voiced.length - 1].timeSeconds + next.timeSeconds)
                    : voiced[voiced.length - 1].timeSeconds + 0.5 * frameStep
            ),
            points: voiced,
        });
        voiced = [];
    };

    for (const point of points) {
        if (
            point.pitchHz === null ||
            point.pitchHz <= 0 ||
            point.pitchConfidence < MIN_CORRELATION
        ) {
            finish();
            continue;
        }
        const previous = voiced[voiced.length - 1];
        if (
            previous !== undefined &&
            point.timeSeconds - previous.timeSeconds > Math.max(0.06, 3 * frameStep)
        ) {
            finish();
        }
        voiced.push(point);
    }
    finish();
    return intervals;
}

function decimate(samples: Float32Array, sampleRate: number) {
    const stride = Math.max(1, Math.floor(sampleRate / TARGET_SAMPLE_RATE));
    if (stride === 1) {
        return { samples, sampleRate };
    }
    const result = new Float32Array(Math.ceil(samples.length / stride));
    for (let output = 0; output < result.length; output += 1) {
        const start = output * stride;
        const end = Math.min(samples.length, start + stride);
        let sum = 0;
        for (let input = start; input < end; input += 1) {
            sum += samples[input];
        }
        result[output] = sum / Math.max(1, end - start);
    }
    return { samples: result, sampleRate: sampleRate / stride };
}

function pitchAt(points: PulsePitchPoint[], timeSeconds: number) {
    if (points.length === 1) {
        return points[0].pitchHz as number;
    }
    let right = 1;
    while (right < points.length && points[right].timeSeconds < timeSeconds) {
        right += 1;
    }
    if (right >= points.length) {
        return points[points.length - 1].pitchHz as number;
    }
    const left = points[right - 1];
    const rightPoint = points[right];
    const span = Math.max(Number.EPSILON, rightPoint.timeSeconds - left.timeSeconds);
    const ratio = Math.max(0, Math.min(1, (timeSeconds - left.timeSeconds) / span));
    return (
        (left.pitchHz as number) +
        ratio * ((rightPoint.pitchHz as number) - (left.pitchHz as number))
    );
}

function absoluteExtremum(samples: Float32Array, first: number, last: number) {
    let best = Math.max(0, Math.min(samples.length - 1, first));
    let amplitude = Math.abs(samples[best]);
    for (let index = best + 1; index <= last && index < samples.length; index += 1) {
        const candidate = Math.abs(samples[index]);
        if (candidate > amplitude) {
            best = index;
            amplitude = candidate;
        }
    }
    return best;
}

function correlation(
    samples: Float32Array,
    reference: number,
    candidate: number,
    halfWindow: number
) {
    const radius = Math.max(2, halfWindow);
    let referenceMean = 0;
    let candidateMean = 0;
    let count = 0;
    for (let offset = -radius; offset <= radius; offset += 1) {
        const left = reference + offset;
        const right = candidate + offset;
        if (left < 0 || right < 0 || left >= samples.length || right >= samples.length) {
            continue;
        }
        referenceMean += samples[left];
        candidateMean += samples[right];
        count += 1;
    }
    if (count < 5) {
        return -1;
    }
    referenceMean /= count;
    candidateMean /= count;
    let numerator = 0;
    let referencePower = 0;
    let candidatePower = 0;
    for (let offset = -radius; offset <= radius; offset += 1) {
        const left = reference + offset;
        const right = candidate + offset;
        if (left < 0 || right < 0 || left >= samples.length || right >= samples.length) {
            continue;
        }
        const a = samples[left] - referenceMean;
        const b = samples[right] - candidateMean;
        numerator += a * b;
        referencePower += a * a;
        candidatePower += b * b;
    }
    return numerator / Math.sqrt(Math.max(Number.EPSILON, referencePower * candidatePower));
}

function bestCorrelatedPoint(
    samples: Float32Array,
    reference: number,
    expectedPeriod: number,
    direction: -1 | 1
) {
    const first = Math.max(
        1,
        Math.round(reference + direction * expectedPeriod * (direction > 0 ? 0.8 : 1.2))
    );
    const last = Math.min(
        samples.length - 2,
        Math.round(reference + direction * expectedPeriod * (direction > 0 ? 1.2 : 0.8))
    );
    if (last < first) {
        return null;
    }
    const candidates: number[] = [];
    for (let index = first; index <= last; index += 1) {
        const amplitude = Math.abs(samples[index]);
        if (
            amplitude >= Math.abs(samples[index - 1]) &&
            amplitude >= Math.abs(samples[index + 1])
        ) {
            candidates.push(index);
        }
    }
    candidates.push(
        Math.max(first, Math.min(last, Math.round(reference + direction * expectedPeriod)))
    );

    const halfWindow = Math.max(2, Math.round(expectedPeriod / 2));
    let bestIndex = candidates[0];
    let bestScore = -1;
    for (const candidate of candidates) {
        const score = correlation(samples, reference, candidate, halfWindow);
        if (score > bestScore) {
            bestIndex = candidate;
            bestScore = score;
        }
    }
    if (bestScore < MIN_CORRELATION) {
        return null;
    }

    const leftScore = correlation(samples, reference, bestIndex - 1, halfWindow);
    const rightScore = correlation(samples, reference, bestIndex + 1, halfWindow);
    const denominator = leftScore - 2 * bestScore + rightScore;
    const fraction =
        Math.abs(denominator) < 1e-12
            ? 0
            : Math.max(-0.5, Math.min(0.5, (0.5 * (leftScore - rightScore)) / denominator));
    return { sample: bestIndex + fraction, score: bestScore };
}

/**
 * Finds pitch-synchronous pulse times using the procedure documented for
 * Praat's Sound & Pitch: To PointProcess (cc): seed at an absolute extremum,
 * then follow the waveform in both directions with local cross-correlation.
 */
export function detectPulseTimes(
    inputSamples: Float32Array,
    inputSampleRate: number,
    pitchPoints: PulsePitchPoint[]
) {
    if (inputSamples.length < 8 || inputSampleRate <= 0) {
        return [];
    }
    const prepared = decimate(inputSamples, inputSampleRate);
    const samples = prepared.samples;
    const sampleRate = prepared.sampleRate;
    const durationSeconds = inputSamples.length / inputSampleRate;
    const result: number[] = [];

    for (const interval of voicedIntervals(pitchPoints, durationSeconds)) {
        const midpoint = 0.5 * (interval.startSeconds + interval.endSeconds);
        const midpointPeriod = 1 / pitchAt(interval.points, midpoint);
        const seed = absoluteExtremum(
            samples,
            Math.round((midpoint - midpointPeriod / 2) * sampleRate),
            Math.round((midpoint + midpointPeriod / 2) * sampleRate)
        );
        const intervalPulses = [seed];

        for (const direction of [-1, 1] as const) {
            let reference = seed;
            for (let guard = 0; guard < samples.length; guard += 1) {
                const referenceTime = reference / sampleRate;
                const periodSamples = sampleRate / pitchAt(interval.points, referenceTime);
                const next = bestCorrelatedPoint(
                    samples,
                    Math.round(reference),
                    periodSamples,
                    direction
                );
                if (next === null) {
                    break;
                }
                const nextTime = next.sample / sampleRate;
                const inside = nextTime >= interval.startSeconds && nextTime <= interval.endSeconds;
                if (!inside && next.score < EDGE_CORRELATION) {
                    break;
                }
                if (
                    nextTime < interval.startSeconds - periodSamples / sampleRate ||
                    nextTime > interval.endSeconds + periodSamples / sampleRate
                ) {
                    break;
                }
                intervalPulses.push(next.sample);
                reference = next.sample;
                if (!inside) {
                    break;
                }
            }
        }
        intervalPulses
            .map((sample) => sample / sampleRate)
            .filter((time) => time >= 0 && time <= durationSeconds)
            .forEach((time) => result.push(time));
    }

    result.sort((left, right) => left - right);
    return result.filter((time, index) => index === 0 || time - result[index - 1] > 0.0001);
}
