export type TypedArray =
    | Int8Array
    | Uint8Array
    | Int16Array
    | Uint16Array
    | Int32Array
    | Uint32Array
    | Uint8ClampedArray
    | Float32Array
    | Float64Array;

export type FrequencyScale = 'linear' | 'log' | 'mel' | 'bark' | 'erb';

export function hzToMel(hz: number): number {
    return 2595 * Math.log10(1 + hz / 700);
}

export function melToHz(mel: number): number {
    return 700 * (10 ** (mel / 2595) - 1);
}

export function frequencyToScale(hz: number, scale: FrequencyScale): number {
    const frequency = Math.max(0, hz);
    switch (scale) {
        case 'linear':
            return frequency;
        case 'log':
            return Math.log(1 + frequency / 20);
        case 'mel':
            return hzToMel(frequency);
        case 'bark': {
            const ratio = frequency / 600;
            return 6 * Math.log(ratio + Math.sqrt(ratio * ratio + 1));
        }
        case 'erb':
            return 21.4 * Math.log10(1 + 0.00437 * frequency);
        default:
            throw new Error('Unknown frequency scale');
    }
}

export function scaleToFrequency(value: number, scale: FrequencyScale): number {
    const scaled = Math.max(0, value);
    switch (scale) {
        case 'linear':
            return scaled;
        case 'log':
            return 20 * (Math.exp(scaled) - 1);
        case 'mel':
            return melToHz(scaled);
        case 'bark': {
            const ratio = scaled / 6;
            return 600 * (Math.exp(ratio) - Math.exp(-ratio)) / 2;
        }
        case 'erb':
            return (10 ** (scaled / 21.4) - 1) / 0.00437;
        default:
            throw new Error('Unknown frequency scale');
    }
}

export function log(base: number, x: number): number {
    return Math.log(x) / Math.log(base);
}

export function clamp(x: number, min: number, max: number): number {
    return Math.max(Math.min(x, max), min);
}

export function lerp(a: number, b: number, t: number): number {
    return a + t * (b - a);
}

export function inverseLerp(a: number, b: number, n: number): number {
    return (a - n) / (a - b);
}

export function mod(x: number, y: number): number {
    return ((x % y) + y) % y;
}

const BLACKMAN_HARRIS_COEFFICIENTS: number[] = [
    0.27105140069342,
    -0.43329793923448,
    0.21812299954311,
    -0.06592544638803,
    0.01081174209837,
    -0.00077658482522,
    0.00001388721735,
];

export function blackmanHarris(n: number, samples: number): number {
    let result = 0;
    for (let i = 0; i < BLACKMAN_HARRIS_COEFFICIENTS.length; i += 1) {
        result += BLACKMAN_HARRIS_COEFFICIENTS[i] * Math.cos((2 * Math.PI * i * n) / samples);
    }
    return result;
}

// Circular queue of 2D data along the x-axis
export class Circular2DBuffer<T extends TypedArray> {
    public width: number;

    public height: number;

    public elementSize: number;

    public start: number;

    public length: number;

    public data: T;

    constructor(
        TypeOrData: T | { new (length: number): T },
        width: number,
        height: number,
        elementSize: number,
        start: number = 0,
        length: number = 0
    ) {
        this.width = width;
        this.height = height;
        this.elementSize = elementSize;
        this.start = start;
        this.length = length;
        if (typeof TypeOrData === 'function') {
            this.data = new TypeOrData(width * height * elementSize);
        } else {
            this.data = TypeOrData;
        }
    }

    enqueue(data: T): void {
        const dataWidth = data.length / (this.elementSize * this.height);
        for (let i = 0; i < dataWidth; i += 1) {
            const x = mod(this.start + this.length + i, this.width);
            this.data.set(data.subarray(i * this.height, (i + 1) * this.height), x * this.height);
        }

        this.length += dataWidth;
        if (this.length > this.width) {
            this.start = mod(this.start + this.length - this.width, this.width);
            this.length = this.width;
        }
    }

    // Resizes the width of the queue, preserving newer image data
    resizeWidth(width: number) {
        if (width === this.width) {
            return;
        }

        const newData: T = new (Object.getPrototypeOf(this.data).constructor)(
            width * this.height * this.elementSize
        );
        for (let i = 0; i < Math.min(this.length, width); i += 1) {
            const newX = Math.min(this.length, width) - i - 1;
            const oldX = mod(this.start + this.length - i - 1, this.width);
            newData.set(
                this.data.subarray(oldX * this.height, (oldX + 1) * this.height),
                newX * this.height
            );
        }
        this.data = newData;
        this.width = width;
        if (this.length >= this.width) {
            this.length = this.width;
        }
        this.start = 0;
    }

    clear() {
        const newData: T = new (Object.getPrototypeOf(this.data).constructor)(
            this.width * this.height * this.elementSize
        );
        this.data = newData;
        this.start = 0;
        this.length = 0;
    }
}
