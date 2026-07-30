import { clamp } from './math-util';
import { getPlotSelectionTheme } from './plot-theme';

export type WaveformThemeName =
    | 'Aurora'
    | 'Praat'
    | 'Ember'
    | 'Ocean'
    | 'Heated Metal'
    | 'Audacity®'
    | 'Spectrum'
    | 'Black to White';

export type WaveformScaleMode = 'linear' | 'dbfs-reference' | 'logarithmic';

export const dbToLinear = (decibels: number) => 10 ** (decibels / 20);

export const amplitudeToDbfs = (amplitude: number) =>
    amplitude <= 1e-12 ? Number.NEGATIVE_INFINITY : 20 * Math.log10(amplitude);

export const compressAmplitude = (sample: number, mu: number = 31) =>
    Math.sign(sample) * (Math.log1p(mu * Math.abs(sample)) / Math.log1p(mu));

export const WAVEFORM_THEMES: {
    name: WaveformThemeName;
    background: string;
    waveform: string;
}[] = [
    { name: 'Aurora', background: '#040712', waveform: '#15cebe' },
    { name: 'Praat', background: '#ffffff', waveform: '#000000' },
    { name: 'Ember', background: '#08080d', waveform: '#ff8030' },
    { name: 'Ocean', background: '#030b16', waveform: '#5fe8d3' },
    { name: 'Heated Metal', background: '#000000', waveform: '#ff0000' },
    { name: 'Audacity®', background: '#bfbfbf', waveform: '#4c99ff' },
    { name: 'Spectrum', background: '#000080', waveform: '#00be00' },
    { name: 'Black to White', background: '#000000', waveform: '#ffffff' },
];

const WAVEFORM_THEME_COLORS: Record<
    WaveformThemeName,
    {
        background: string;
        waveform: string;
        zeroLine: string;
        pulses: string;
    }
> = {
    Aurora: {
        background: '#040712',
        waveform: '#15cebe',
        zeroLine: 'rgba(21, 206, 190, 0.48)',
        pulses: '#ff4d6d',
    },
    Praat: {
        background: '#ffffff',
        waveform: '#000000',
        zeroLine: 'rgba(50, 132, 170, 0.55)',
        pulses: '#0033b5',
    },
    Ember: {
        background: '#08080d',
        waveform: '#ff8030',
        zeroLine: 'rgba(255, 128, 48, 0.42)',
        pulses: '#35bfff',
    },
    Ocean: {
        background: '#030b16',
        waveform: '#5fe8d3',
        zeroLine: 'rgba(95, 232, 211, 0.42)',
        pulses: '#ffc247',
    },
    'Heated Metal': {
        background: '#000000',
        waveform: '#ff0000',
        zeroLine: 'rgba(255, 0, 0, 0.42)',
        pulses: '#00cfff',
    },
    'Audacity®': {
        background: '#bfbfbf',
        waveform: '#4c99ff',
        zeroLine: 'rgba(76, 153, 255, 0.55)',
        pulses: '#6d1299',
    },
    Spectrum: {
        background: '#000080',
        waveform: '#00be00',
        zeroLine: 'rgba(0, 190, 0, 0.5)',
        pulses: '#ffd400',
    },
    'Black to White': {
        background: '#000000',
        waveform: '#ffffff',
        zeroLine: 'rgba(255, 255, 255, 0.32)',
        pulses: '#00bfff',
    },
};

export interface WaveformDisplayOptions {
    gainDb: number;
    lineWidth: number;
    showZeroLine: boolean;
    showPulses: boolean;
    scaleMode: WaveformScaleMode;
    autoFitView: boolean;
    showPeak: boolean;
    showRms: boolean;
    showPeakHold: boolean;
    showClipping: boolean;
}

export interface WaveformSelection {
    startSeconds: number;
    endSeconds: number;
}

export interface WaveformRenderParameters {
    viewStartSeconds: number;
    viewEndSeconds: number;
    selection: WaveformSelection | null;
}

interface PeakLevel {
    blockSize: number;
    minimum: Float32Array;
    maximum: Float32Array;
    sumSquares: Float64Array;
    sampleCounts: Uint32Array;
}

interface WaveformRangeStatistics {
    minimum: number;
    maximum: number;
    sumSquares: number;
    sampleCount: number;
}

class WaveformPeakCache {
    private readonly samples: Float32Array;

    private readonly levels: PeakLevel[] = [];

    constructor(samples: Float32Array) {
        this.samples = samples;
        const blockSize = 64;
        const blockCount = Math.ceil(samples.length / blockSize);
        const minimum = new Float32Array(blockCount);
        const maximum = new Float32Array(blockCount);
        const sumSquares = new Float64Array(blockCount);
        const sampleCounts = new Uint32Array(blockCount);
        for (let block = 0; block < blockCount; block += 1) {
            let low = Number.POSITIVE_INFINITY;
            let high = Number.NEGATIVE_INFINITY;
            let squareTotal = 0;
            const start = block * blockSize;
            const end = Math.min(samples.length, start + blockSize);
            for (let index = start; index < end; index += 1) {
                low = Math.min(low, samples[index]);
                high = Math.max(high, samples[index]);
                squareTotal += samples[index] ** 2;
            }
            minimum[block] = Number.isFinite(low) ? low : 0;
            maximum[block] = Number.isFinite(high) ? high : 0;
            sumSquares[block] = squareTotal;
            sampleCounts[block] = end - start;
        }
        this.levels.push({ blockSize, minimum, maximum, sumSquares, sampleCounts });

        let previous = this.levels[0];
        while (previous.minimum.length > 1) {
            const nextCount = Math.ceil(previous.minimum.length / 2);
            const nextMinimum = new Float32Array(nextCount);
            const nextMaximum = new Float32Array(nextCount);
            const nextSumSquares = new Float64Array(nextCount);
            const nextSampleCounts = new Uint32Array(nextCount);
            for (let index = 0; index < nextCount; index += 1) {
                const first = index * 2;
                const second = Math.min(previous.minimum.length - 1, first + 1);
                nextMinimum[index] = Math.min(previous.minimum[first], previous.minimum[second]);
                nextMaximum[index] = Math.max(previous.maximum[first], previous.maximum[second]);
                nextSumSquares[index] =
                    previous.sumSquares[first] +
                    (second === first ? 0 : previous.sumSquares[second]);
                nextSampleCounts[index] =
                    previous.sampleCounts[first] +
                    (second === first ? 0 : previous.sampleCounts[second]);
            }
            previous = {
                blockSize: previous.blockSize * 2,
                minimum: nextMinimum,
                maximum: nextMaximum,
                sumSquares: nextSumSquares,
                sampleCounts: nextSampleCounts,
            };
            this.levels.push(previous);
        }
    }

    range(start: number, end: number): WaveformRangeStatistics {
        const firstSample = clamp(Math.floor(start), 0, this.samples.length);
        const lastSample = clamp(Math.ceil(end), firstSample, this.samples.length);
        if (lastSample <= firstSample) {
            return { minimum: 0, maximum: 0, sumSquares: 0, sampleCount: 0 };
        }

        const samplesInRange = lastSample - firstSample;
        let level: PeakLevel | null = null;
        for (const candidate of this.levels) {
            if (candidate.blockSize > samplesInRange / 2) {
                break;
            }
            level = candidate;
        }

        if (level === null) {
            let low = Number.POSITIVE_INFINITY;
            let high = Number.NEGATIVE_INFINITY;
            let sumSquares = 0;
            for (let index = firstSample; index < lastSample; index += 1) {
                low = Math.min(low, this.samples[index]);
                high = Math.max(high, this.samples[index]);
                sumSquares += this.samples[index] ** 2;
            }
            return {
                minimum: low,
                maximum: high,
                sumSquares,
                sampleCount: lastSample - firstSample,
            };
        }

        const firstBlock = Math.ceil(firstSample / level.blockSize);
        const lastBlock = Math.min(level.minimum.length, Math.floor(lastSample / level.blockSize));
        let low = Number.POSITIVE_INFINITY;
        let high = Number.NEGATIVE_INFINITY;
        let sumSquares = 0;
        let sampleCount = 0;
        const addSample = (sample: number) => {
            low = Math.min(low, sample);
            high = Math.max(high, sample);
            sumSquares += sample ** 2;
            sampleCount += 1;
        };
        const leadingEnd = Math.min(lastSample, firstBlock * level.blockSize);
        for (let index = firstSample; index < leadingEnd; index += 1) {
            addSample(this.samples[index]);
        }
        for (let block = firstBlock; block < lastBlock; block += 1) {
            low = Math.min(low, level.minimum[block]);
            high = Math.max(high, level.maximum[block]);
            sumSquares += level.sumSquares[block];
            sampleCount += level.sampleCounts[block];
        }
        const trailingStart = Math.max(leadingEnd, lastBlock * level.blockSize);
        for (let index = trailingStart; index < lastSample; index += 1) {
            addSample(this.samples[index]);
        }
        return {
            minimum: low,
            maximum: high,
            sumSquares,
            sampleCount,
        };
    }
}

export class WaveformRenderer {
    private readonly canvas: HTMLCanvasElement;

    private readonly context: CanvasRenderingContext2D;

    private offlineSamples: Float32Array | null = null;

    private offlineSampleRate = 48000;

    private offlinePeaks: WaveformPeakCache | null = null;

    private offlinePulseTimes: number[] = [];

    private liveSamples = new Float32Array(1);

    private liveSampleRate = 48000;

    private liveWriteIndex = 0;

    private liveLength = 0;

    private liveEndTimeSeconds = 0;

    private livePulseTimes: number[] = [];

    private source: 'none' | 'offline' | 'live' = 'none';

    private envelope = new Float32Array(0);

    private themeName: WaveformThemeName = 'Aurora';

    private autoGain = 1;

    private autoFitWasEnabled = false;

    private lastVisiblePeak = 0;

    private heldPeak = 0;

    private heldPeakUpdatedAt = 0;

    private displayOptions: WaveformDisplayOptions = {
        gainDb: 0,
        lineWidth: 1,
        showZeroLine: true,
        showPulses: false,
        scaleMode: 'linear',
        autoFitView: false,
        showPeak: true,
        showRms: true,
        showPeakHold: false,
        showClipping: true,
    };

    constructor(canvas: HTMLCanvasElement) {
        const context = canvas.getContext('2d');
        if (context === null) {
            throw new Error('Unable to initialise the waveform display');
        }
        this.canvas = canvas;
        this.context = context;
    }

    resize(width: number, height: number) {
        if (this.canvas.width !== width || this.canvas.height !== height) {
            this.canvas.width = width;
            this.canvas.height = height;
        }
    }

    setTheme(themeName: WaveformThemeName) {
        this.themeName = themeName;
    }

    updateDisplay(parameters: Partial<WaveformDisplayOptions>) {
        this.displayOptions = {
            ...this.displayOptions,
            ...parameters,
        };
    }

    setOfflineSamples(samples: Float32Array, sampleRate: number) {
        if (this.offlineSamples !== samples) {
            this.offlineSamples = samples;
            this.offlinePeaks = new WaveformPeakCache(samples);
            this.resetAdaptiveDisplay();
        }
        this.offlineSampleRate = sampleRate;
        this.source = 'offline';
    }

    setOfflinePulseTimes(pulseTimes: number[]) {
        this.offlinePulseTimes = pulseTimes;
    }

    startLive(sampleRate: number, historySeconds: number) {
        this.liveSampleRate = sampleRate;
        this.liveSamples = new Float32Array(Math.max(1, Math.ceil(sampleRate * historySeconds)));
        this.liveWriteIndex = 0;
        this.liveLength = 0;
        this.liveEndTimeSeconds = 0;
        this.livePulseTimes = [];
        this.source = 'live';
        this.resetAdaptiveDisplay();
    }

    appendLive(samples: Float32Array, endTimeSeconds: number) {
        if (this.source !== 'live') {
            return;
        }
        for (let index = 0; index < samples.length; index += 1) {
            this.liveSamples[this.liveWriteIndex] = samples[index];
            this.liveWriteIndex = (this.liveWriteIndex + 1) % this.liveSamples.length;
        }
        this.liveLength = Math.min(this.liveSamples.length, this.liveLength + samples.length);
        this.liveEndTimeSeconds = endTimeSeconds;
    }

    appendLivePulseTimes(pulseTimes: number[]) {
        const oldestTime = this.liveEndTimeSeconds - this.liveSamples.length / this.liveSampleRate;
        for (const time of pulseTimes) {
            const previous = this.livePulseTimes[this.livePulseTimes.length - 1];
            if (time >= oldestTime && (previous === undefined || time - previous > 0.0001)) {
                this.livePulseTimes.push(time);
            }
        }
        while (this.livePulseTimes.length > 0 && this.livePulseTimes[0] < oldestTime) {
            this.livePulseTimes.shift();
        }
    }

    clear() {
        this.source = 'none';
        this.offlineSamples = null;
        this.offlinePeaks = null;
        this.offlinePulseTimes = [];
        this.liveLength = 0;
        this.livePulseTimes = [];
        this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.resetAdaptiveDisplay();
    }

    recommendedGainDb() {
        if (this.lastVisiblePeak < 1e-8) {
            return 0;
        }
        return clamp(amplitudeToDbfs(0.9 / this.lastVisiblePeak), -24, 24);
    }

    render({ viewStartSeconds, viewEndSeconds, selection }: WaveformRenderParameters) {
        const { context: ctx, canvas } = this;
        const width = canvas.width;
        const height = canvas.height;
        if (width <= 0 || height <= 0) {
            return;
        }

        ctx.clearRect(0, 0, width, height);
        const theme = WAVEFORM_THEME_COLORS[this.themeName];
        ctx.fillStyle = theme.background;
        ctx.fillRect(0, 0, width, height);

        if (this.displayOptions.showZeroLine) {
            ctx.strokeStyle = theme.zeroLine;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(0, height / 2 + 0.5);
            ctx.lineTo(width, height / 2 + 0.5);
            ctx.stroke();
        }

        const duration = Math.max(1e-9, viewEndSeconds - viewStartSeconds);
        if (this.envelope.length !== width * 2) {
            this.envelope = new Float32Array(width * 2);
        }
        const envelope = this.envelope;
        let visiblePeak = 0;
        let visibleSumSquares = 0;
        let visibleSampleCount = 0;
        for (let x = 0; x < width; x += 1) {
            const startTime = viewStartSeconds + (x / width) * duration;
            const endTime = viewStartSeconds + ((x + 1) / width) * duration;
            const statistics = this.range(startTime, endTime);
            const { minimum: low, maximum: high } = statistics;
            envelope[x * 2] = low;
            envelope[x * 2 + 1] = high;
            visiblePeak = Math.max(visiblePeak, Math.abs(low), Math.abs(high));
            visibleSumSquares += statistics.sumSquares;
            visibleSampleCount += statistics.sampleCount;
        }

        this.lastVisiblePeak = visiblePeak;
        const gain = dbToLinear(this.displayOptions.gainDb);
        if (this.displayOptions.autoFitView && visiblePeak >= 1e-8) {
            const targetGain = 0.9 / Math.max(1e-8, visiblePeak * gain);
            this.autoGain = this.autoFitWasEnabled
                ? this.autoGain * 0.9 + targetGain * 0.1
                : targetGain;
            this.autoFitWasEnabled = true;
        } else {
            this.autoGain = 1;
            this.autoFitWasEnabled = false;
        }
        const yForAmplitude = (value: number) => {
            const adjusted = value * gain * this.autoGain;
            const displayed =
                this.displayOptions.scaleMode === 'logarithmic'
                    ? compressAmplitude(adjusted)
                    : adjusted;
            return height / 2 - clamp(displayed, -1, 1) * (height * 0.48);
        };

        ctx.strokeStyle = theme.waveform;
        ctx.lineWidth = this.displayOptions.lineWidth;
        ctx.beginPath();
        for (let x = 0; x < width; x += 1) {
            const low = envelope[x * 2];
            const high = envelope[x * 2 + 1];
            ctx.moveTo(x + 0.5, yForAmplitude(high));
            ctx.lineTo(x + 0.5, yForAmplitude(low));
        }
        ctx.stroke();

        const rms = visibleSampleCount <= 0 ? 0 : Math.sqrt(visibleSumSquares / visibleSampleCount);
        this.drawLevelReadout(visiblePeak, rms, gain * this.autoGain);

        const xForTime = (seconds: number) => ((seconds - viewStartSeconds) / duration) * width;
        if (this.displayOptions.showPulses) {
            const pulseTimes =
                this.source === 'offline' ? this.offlinePulseTimes : this.livePulseTimes;
            ctx.strokeStyle = theme.pulses;
            ctx.lineWidth = 1;
            ctx.setLineDash([]);
            ctx.beginPath();
            let previousPixel = -1;
            for (const time of pulseTimes) {
                if (time < viewStartSeconds || time > viewEndSeconds) {
                    continue;
                }
                const pixel = Math.round(xForTime(time));
                if (pixel === previousPixel) {
                    continue;
                }
                const x = pixel + 0.5;
                ctx.moveTo(x, 0);
                ctx.lineTo(x, height);
                previousPixel = pixel;
            }
            ctx.stroke();
        }

        if (selection !== null) {
            const selectionTheme = getPlotSelectionTheme(this.themeName);
            const left = clamp(xForTime(selection.startSeconds), 0, width);
            const right = clamp(xForTime(selection.endSeconds), 0, width);
            if (
                selection.endSeconds >= viewStartSeconds &&
                selection.startSeconds <= viewEndSeconds
            ) {
                ctx.fillStyle = selectionTheme.fill;
                ctx.fillRect(left, 0, Math.max(1, right - left), height);
                ctx.strokeStyle = selectionTheme.stroke;
                ctx.setLineDash([4, 4]);
                ctx.beginPath();
                ctx.moveTo(left, 0);
                ctx.lineTo(left, height);
                ctx.moveTo(right, 0);
                ctx.lineTo(right, height);
                ctx.stroke();
                ctx.setLineDash([]);
            }
        }
    }

    private range(startTimeSeconds: number, endTimeSeconds: number): WaveformRangeStatistics {
        if (
            this.source === 'offline' &&
            this.offlineSamples !== null &&
            this.offlinePeaks !== null
        ) {
            return this.offlinePeaks.range(
                startTimeSeconds * this.offlineSampleRate,
                endTimeSeconds * this.offlineSampleRate
            );
        }
        if (this.source !== 'live' || this.liveLength === 0) {
            return { minimum: 0, maximum: 0, sumSquares: 0, sampleCount: 0 };
        }

        const liveStartTime = this.liveEndTimeSeconds - this.liveLength / this.liveSampleRate;
        const first = clamp(
            Math.floor((startTimeSeconds - liveStartTime) * this.liveSampleRate),
            0,
            this.liveLength
        );
        const last = clamp(
            Math.ceil((endTimeSeconds - liveStartTime) * this.liveSampleRate),
            first,
            this.liveLength
        );
        if (last <= first) {
            return { minimum: 0, maximum: 0, sumSquares: 0, sampleCount: 0 };
        }

        const oldestIndex =
            (this.liveWriteIndex - this.liveLength + this.liveSamples.length) %
            this.liveSamples.length;
        let low = Number.POSITIVE_INFINITY;
        let high = Number.NEGATIVE_INFINITY;
        let sumSquares = 0;
        for (let logicalIndex = first; logicalIndex < last; logicalIndex += 1) {
            const sample = this.liveSamples[(oldestIndex + logicalIndex) % this.liveSamples.length];
            low = Math.min(low, sample);
            high = Math.max(high, sample);
            sumSquares += sample ** 2;
        }
        return {
            minimum: Number.isFinite(low) ? low : 0,
            maximum: Number.isFinite(high) ? high : 0,
            sumSquares,
            sampleCount: last - first,
        };
    }

    private resetAdaptiveDisplay() {
        this.autoGain = 1;
        this.autoFitWasEnabled = false;
        this.lastVisiblePeak = 0;
        this.heldPeak = 0;
        this.heldPeakUpdatedAt = 0;
    }

    private drawLevelReadout(peak: number, rms: number, displayGain: number) {
        const { showPeak, showRms, showPeakHold, showClipping } = this.displayOptions;
        const clipped = peak * displayGain > 1;
        if (!showPeak && !showRms && !showPeakHold && !(showClipping && clipped)) {
            return;
        }

        const now = performance.now();
        if (peak >= this.heldPeak || now - this.heldPeakUpdatedAt > 1500) {
            this.heldPeak = peak;
            this.heldPeakUpdatedAt = now;
        }

        const formatDbfs = (value: number) => {
            const decibels = amplitudeToDbfs(value);
            return Number.isFinite(decibels) ? `${decibels.toFixed(1)} dBFS` : '−∞ dBFS';
        };
        const lines: { label: string; alert?: boolean }[] = [];
        if (showPeak) {
            lines.push({ label: `Peak  ${formatDbfs(peak)}` });
        }
        if (showRms) {
            lines.push({ label: `RMS  ${formatDbfs(rms)}` });
        }
        if (showPeakHold) {
            lines.push({ label: `Hold  ${formatDbfs(this.heldPeak)}` });
        }
        if (showClipping && clipped) {
            lines.push({ label: 'CLIP', alert: true });
        }

        const pixelRatio = Math.max(1, this.canvas.width / Math.max(1, this.canvas.clientWidth));
        const fontSize = 11 * pixelRatio;
        const lineHeight = 16 * pixelRatio;
        const padding = 8 * pixelRatio;
        const gap = 8 * pixelRatio;
        const { context: ctx, canvas } = this;
        ctx.save();
        ctx.font = `600 ${fontSize}px ui-monospace, SFMono-Regular, Consolas, monospace`;
        const contentWidth = Math.max(...lines.map(({ label }) => ctx.measureText(label).width));
        const boxWidth = contentWidth + padding * 2;
        const boxHeight = lines.length * lineHeight + padding * 1.5;
        const left = canvas.width - boxWidth - gap;
        const top = gap;
        ctx.fillStyle =
            this.themeName === 'Praat' || this.themeName === 'Audacity®'
                ? 'rgba(255,255,255,0.82)'
                : 'rgba(2,6,15,0.72)';
        ctx.fillRect(left, top, boxWidth, boxHeight);
        lines.forEach(({ label, alert }, index) => {
            ctx.fillStyle = alert
                ? '#ff3b30'
                : this.themeName === 'Praat' || this.themeName === 'Audacity®'
                ? '#172033'
                : '#dce8f8';
            ctx.fillText(label, left + padding, top + padding + (index + 0.72) * lineHeight);
        });
        ctx.restore();
    }
}
