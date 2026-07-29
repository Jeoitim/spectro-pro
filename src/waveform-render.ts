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
    }
> = {
    Aurora: {
        background: '#040712',
        waveform: '#15cebe',
        zeroLine: 'rgba(21, 206, 190, 0.48)',
    },
    Praat: {
        background: '#ffffff',
        waveform: '#000000',
        zeroLine: 'rgba(50, 132, 170, 0.55)',
    },
    Ember: {
        background: '#08080d',
        waveform: '#ff8030',
        zeroLine: 'rgba(255, 128, 48, 0.42)',
    },
    Ocean: {
        background: '#030b16',
        waveform: '#5fe8d3',
        zeroLine: 'rgba(95, 232, 211, 0.42)',
    },
    'Heated Metal': {
        background: '#000000',
        waveform: '#ff0000',
        zeroLine: 'rgba(255, 0, 0, 0.42)',
    },
    'Audacity®': {
        background: '#bfbfbf',
        waveform: '#4c99ff',
        zeroLine: 'rgba(76, 153, 255, 0.55)',
    },
    Spectrum: {
        background: '#000080',
        waveform: '#00be00',
        zeroLine: 'rgba(0, 190, 0, 0.5)',
    },
    'Black to White': {
        background: '#000000',
        waveform: '#ffffff',
        zeroLine: 'rgba(255, 255, 255, 0.32)',
    },
};

export interface WaveformDisplayOptions {
    gain: number;
    lineWidth: number;
    showZeroLine: boolean;
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
        for (let block = 0; block < blockCount; block += 1) {
            let low = Number.POSITIVE_INFINITY;
            let high = Number.NEGATIVE_INFINITY;
            const start = block * blockSize;
            const end = Math.min(samples.length, start + blockSize);
            for (let index = start; index < end; index += 1) {
                low = Math.min(low, samples[index]);
                high = Math.max(high, samples[index]);
            }
            minimum[block] = Number.isFinite(low) ? low : 0;
            maximum[block] = Number.isFinite(high) ? high : 0;
        }
        this.levels.push({ blockSize, minimum, maximum });

        let previous = this.levels[0];
        while (previous.minimum.length > 1) {
            const nextCount = Math.ceil(previous.minimum.length / 2);
            const nextMinimum = new Float32Array(nextCount);
            const nextMaximum = new Float32Array(nextCount);
            for (let index = 0; index < nextCount; index += 1) {
                const first = index * 2;
                const second = Math.min(previous.minimum.length - 1, first + 1);
                nextMinimum[index] = Math.min(previous.minimum[first], previous.minimum[second]);
                nextMaximum[index] = Math.max(previous.maximum[first], previous.maximum[second]);
            }
            previous = {
                blockSize: previous.blockSize * 2,
                minimum: nextMinimum,
                maximum: nextMaximum,
            };
            this.levels.push(previous);
        }
    }

    range(start: number, end: number): [number, number] {
        const firstSample = clamp(Math.floor(start), 0, this.samples.length);
        const lastSample = clamp(Math.ceil(end), firstSample, this.samples.length);
        if (lastSample <= firstSample) {
            return [0, 0];
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
            for (let index = firstSample; index < lastSample; index += 1) {
                low = Math.min(low, this.samples[index]);
                high = Math.max(high, this.samples[index]);
            }
            return [low, high];
        }

        const firstBlock = Math.floor(firstSample / level.blockSize);
        const lastBlock = Math.min(level.minimum.length, Math.ceil(lastSample / level.blockSize));
        let low = Number.POSITIVE_INFINITY;
        let high = Number.NEGATIVE_INFINITY;
        for (let block = firstBlock; block < lastBlock; block += 1) {
            low = Math.min(low, level.minimum[block]);
            high = Math.max(high, level.maximum[block]);
        }
        return [low, high];
    }
}

export class WaveformRenderer {
    private readonly canvas: HTMLCanvasElement;

    private readonly context: CanvasRenderingContext2D;

    private offlineSamples: Float32Array | null = null;

    private offlineSampleRate = 48000;

    private offlinePeaks: WaveformPeakCache | null = null;

    private liveSamples = new Float32Array(1);

    private liveSampleRate = 48000;

    private liveWriteIndex = 0;

    private liveLength = 0;

    private liveEndTimeSeconds = 0;

    private source: 'none' | 'offline' | 'live' = 'none';

    private envelope = new Float32Array(0);

    private themeName: WaveformThemeName = 'Aurora';

    private displayOptions: WaveformDisplayOptions = {
        gain: 1,
        lineWidth: 1,
        showZeroLine: true,
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
        }
        this.offlineSampleRate = sampleRate;
        this.source = 'offline';
    }

    startLive(sampleRate: number, historySeconds: number) {
        this.liveSampleRate = sampleRate;
        this.liveSamples = new Float32Array(Math.max(1, Math.ceil(sampleRate * historySeconds)));
        this.liveWriteIndex = 0;
        this.liveLength = 0;
        this.liveEndTimeSeconds = 0;
        this.source = 'live';
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

    clear() {
        this.source = 'none';
        this.offlineSamples = null;
        this.offlinePeaks = null;
        this.liveLength = 0;
        this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
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
        for (let x = 0; x < width; x += 1) {
            const startTime = viewStartSeconds + (x / width) * duration;
            const endTime = viewStartSeconds + ((x + 1) / width) * duration;
            const [low, high] = this.range(startTime, endTime);
            envelope[x * 2] = low;
            envelope[x * 2 + 1] = high;
            visiblePeak = Math.max(visiblePeak, Math.abs(low), Math.abs(high));
        }

        const amplitude = Math.max(0.01, Math.min(1, visiblePeak * 1.08));
        const yForAmplitude = (value: number) =>
            height / 2 -
            clamp((value / amplitude) * this.displayOptions.gain, -1, 1) * (height * 0.46);

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

        const xForTime = (seconds: number) => ((seconds - viewStartSeconds) / duration) * width;
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

    private range(startTimeSeconds: number, endTimeSeconds: number): [number, number] {
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
            return [0, 0];
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
            return [0, 0];
        }

        const oldestIndex =
            (this.liveWriteIndex - this.liveLength + this.liveSamples.length) %
            this.liveSamples.length;
        let low = Number.POSITIVE_INFINITY;
        let high = Number.NEGATIVE_INFINITY;
        for (let logicalIndex = first; logicalIndex < last; logicalIndex += 1) {
            const sample = this.liveSamples[(oldestIndex + logicalIndex) % this.liveSamples.length];
            low = Math.min(low, sample);
            high = Math.max(high, sample);
        }
        return [Number.isFinite(low) ? low : 0, Number.isFinite(high) ? high : 0];
    }
}
