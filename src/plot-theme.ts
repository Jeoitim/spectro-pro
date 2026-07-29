export interface PlotSelectionTheme {
    fill: string;
    stroke: string;
}

const DEFAULT_SELECTION_THEME: PlotSelectionTheme = {
    fill: 'rgba(105, 188, 255, 0.22)',
    stroke: 'rgba(52, 145, 210, 0.95)',
};

const PLOT_SELECTION_THEMES: Record<string, PlotSelectionTheme> = {
    Aurora: DEFAULT_SELECTION_THEME,
    Praat: {
        fill: 'rgba(255, 105, 120, 0.2)',
        stroke: 'rgba(211, 48, 70, 0.92)',
    },
    Ember: {
        fill: 'rgba(255, 128, 48, 0.22)',
        stroke: 'rgba(230, 89, 24, 0.95)',
    },
    Ocean: {
        fill: 'rgba(95, 232, 211, 0.2)',
        stroke: 'rgba(22, 166, 159, 0.95)',
    },
    'Heated Metal': {
        fill: 'rgba(255, 210, 64, 0.22)',
        stroke: 'rgba(230, 160, 0, 0.95)',
    },
    'Audacity®': {
        fill: 'rgba(229, 25, 229, 0.18)',
        stroke: 'rgba(196, 29, 196, 0.92)',
    },
    Spectrum: {
        fill: 'rgba(225, 225, 0, 0.2)',
        stroke: 'rgba(178, 153, 0, 0.95)',
    },
    'Black to White': DEFAULT_SELECTION_THEME,
};

export const getPlotSelectionTheme = (themeName: string): PlotSelectionTheme =>
    PLOT_SELECTION_THEMES[themeName] || DEFAULT_SELECTION_THEME;

export const drawPlotPlayhead = (
    context: CanvasRenderingContext2D,
    x: number,
    height: number,
    themeName: string
) => {
    const gradient = GRADIENTS.find((item) => item.name === themeName)?.gradient;
    const background = gradient?.[0]?.color || [4, 7, 18];
    const negative = background.map((channel) => 255 - channel);
    const backgroundColor = `rgb(${background.join(', ')})`;
    const negativeColor = `rgb(${negative.join(', ')})`;

    context.save();
    context.lineCap = 'butt';
    context.setLineDash([]);
    context.strokeStyle = negativeColor;
    context.lineWidth = 4;
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, height);
    context.stroke();

    context.strokeStyle = backgroundColor;
    context.lineWidth = 1.5;
    context.setLineDash([8, 5]);
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, height);
    context.stroke();
    context.setLineDash([]);

    context.fillStyle = negativeColor;
    context.beginPath();
    context.moveTo(x - 7, 0);
    context.lineTo(x + 7, 0);
    context.lineTo(x, 11);
    context.closePath();
    context.fill();

    context.fillStyle = backgroundColor;
    context.beginPath();
    context.moveTo(x - 4, 1);
    context.lineTo(x + 4, 1);
    context.lineTo(x, 7);
    context.closePath();
    context.fill();
    context.restore();
};
import { GRADIENTS } from './color-util';
