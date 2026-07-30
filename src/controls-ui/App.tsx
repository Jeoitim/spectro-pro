import React, {
    ChangeEvent,
    PointerEvent as ReactPointerEvent,
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
} from 'react';
import AddIcon from '@material-ui/icons/Add';
import AssessmentOutlinedIcon from '@material-ui/icons/AssessmentOutlined';
import Brightness4Icon from '@material-ui/icons/Brightness4';
import Brightness7Icon from '@material-ui/icons/Brightness7';
import ClearAllIcon from '@material-ui/icons/ClearAll';
import CloseIcon from '@material-ui/icons/Close';
import CloudUploadIcon from '@material-ui/icons/CloudUpload';
import DeleteOutlineIcon from '@material-ui/icons/DeleteOutline';
import DeleteSweepIcon from '@material-ui/icons/DeleteSweep';
import ImageOutlinedIcon from '@material-ui/icons/ImageOutlined';
import LanguageIcon from '@material-ui/icons/Language';
import QueueMusicIcon from '@material-ui/icons/QueueMusic';
import RemoveIcon from '@material-ui/icons/Remove';
import RestoreIcon from '@material-ui/icons/Restore';
import SaveAltIcon from '@material-ui/icons/SaveAlt';
import StopIcon from '@material-ui/icons/Stop';
import UndoIcon from '@material-ui/icons/Undo';
import ViewArrayIcon from '@material-ui/icons/ViewArray';
import ZoomOutMapIcon from '@material-ui/icons/ZoomOutMap';

import { AnalysisOptions, PitchAlgorithm, RealtimeAnalysisPrecision } from '../analysis';
import { GRADIENTS } from '../color-util';
import { getActiveLocale, Locale, setActiveLocale, translate } from '../i18n';
import { frequencyToScale } from '../math-util';
import { Scale, SpectrogramWindowFunction } from '../spectrogram';
import { RenderParameters } from '../spectrogram-render';
import {
    WAVEFORM_THEMES,
    amplitudeToDbspl,
    expandAmplitude,
    WaveformAxisState,
    WaveformDisplayOptions,
    WaveformReferenceUnit,
    WaveformScaleMode,
    WaveformThemeName,
} from '../waveform-render';

export type SpectrogramMode = 'broadband' | 'narrowband' | 'custom';
export type PlayState = 'stopped' | 'loading-file' | 'loading-mic' | 'playing';
export interface SpectrogramAnalysisSettings {
    customWindowLengthMs: number;
    windowFunction: SpectrogramWindowFunction;
}
export interface PerformanceSettings {
    framesPerSecond: number;
    renderPixelRatio: number;
    analysisPrecision: RealtimeAnalysisPrecision;
}
type SettingsTab = 'spectrogram' | 'waveform' | 'pitch' | 'formants' | 'intensity' | 'performance';
type MetricSelection =
    | 'pitch'
    | 'intensity'
    | 'formant1'
    | 'formant2'
    | 'formant3'
    | 'formant4'
    | 'formant5';
type UiTheme = 'dark' | 'light';
type SourceProfileMode = 'live' | 'file';

interface SourceSettingsProfile {
    mode: SpectrogramMode;
    pitchAlgorithm: PitchAlgorithm;
    waveformScaleMode: WaveformScaleMode;
    waveformReferenceUnit: WaveformReferenceUnit;
    waveformGainDb: number;
    waveformNormalizeRecordingPeak: boolean;
    waveformAutoFitView: boolean;
    waveformShowPeak: boolean;
    waveformShowRms: boolean;
    waveformShowPeakHold: boolean;
    waveformShowClipping: boolean;
    waveformLineWidth: number;
    waveformZeroLine: boolean;
    waveformPulses: boolean;
    sensitivity: number;
    contrast: number;
    minFrequency: number;
    maxFrequency: number;
    broadbandScale: Scale;
    narrowbandScale: Scale;
    customScale: Scale;
    customWindowLengthMs: number;
    windowFunction: SpectrogramWindowFunction;
    pitchFloor: number;
    pitchCeiling: number;
    voicingThreshold: number;
    pitchLineWidth: number;
    narrowbandPitchFrequencyAligned: boolean;
    maximumFormants: number;
    formantsToDisplay: number;
    formantCeiling: number;
    formantWindowMs: number;
    preEmphasisFrom: number;
    formantDynamicRange: number;
    formantDotSize: number;
    intensityPitchFloor: number;
    intensityFloor: number;
    intensityCeiling: number;
    intensityLineWidth: number;
    splCalibration: number;
    framesPerSecond: number;
    renderPixelRatio: number;
    analysisPrecision: RealtimeAnalysisPrecision;
}

export interface LiveSnapshot {
    elapsedSeconds: number;
    pitchHz: number | null;
    intensityDbSpl: number;
    formantsHz: (number | null)[];
    meanPitchHz: number | null;
    minPitchHz: number | null;
    maxPitchHz: number | null;
    meanIntensityDbSpl: number | null;
    voicedPercent: number;
    sampleRate: number;
}

export interface CursorSnapshot {
    x: number;
    y: number;
    timeSeconds: number;
    frequencyHz: number;
    pitchHz: number | null;
    intensityDbSpl: number | null;
    formantsHz: (number | null)[];
}

export interface MediaListItem {
    id: string;
    name: string;
    durationSeconds: number;
    type: 'file' | 'recording';
    state: 'ready' | 'analyzing' | 'error';
}

export interface TransportSnapshot {
    activeId: string | null;
    currentSeconds: number;
    durationSeconds: number;
    viewStartSeconds: number;
    viewEndSeconds: number;
    isPlaying: boolean;
}

export interface SelectionSnapshot {
    xStart: number;
    xEnd: number;
    startSeconds: number;
    endSeconds: number;
    durationSeconds: number;
}

interface PlotPointer {
    x: number;
    y: number;
    clientX: number;
    clientY: number;
}

interface PlotGesture {
    pointers: Map<number, PlotPointer>;
    primaryPointerId: number | null;
    start: PlotPointer | null;
    dragging: boolean;
    panning: boolean;
    blockedUntilRelease: boolean;
    lastPanCenterX: number | null;
}

export interface AppCallbacks {
    onStartMicrophone: () => void;
    onStartFile: (buffer: ArrayBuffer, name: string) => void;
    onStop: () => void;
    onClear: () => void;
    onExport: () => void;
    onModeChange: (mode: SpectrogramMode) => void;
    onSpectrogramAnalysisChange: (settings: SpectrogramAnalysisSettings) => void;
    onPitchAlgorithmChange: (algorithm: PitchAlgorithm) => void;
    onAnalysisChange: (parameters: Partial<AnalysisOptions>) => void;
    onLayerDisplayChange: (parameters: Partial<LayerDisplayOptions>) => void;
    onDisplayChange: (parameters: Partial<RenderParameters>) => void;
    onPerformanceChange: (settings: PerformanceSettings) => void;
    onOverlayChange: (pitch: boolean, formants: boolean, intensity: boolean) => void;
    onPlotVisibilityChange: (waveform: boolean, spectrogram: boolean) => void;
    onPlotThemeChange: (spectrogramThemeName: string, waveformThemeName: WaveformThemeName) => void;
    onWaveformDisplayChange: (parameters: Partial<WaveformDisplayOptions>) => void;
    onFitWaveformView: () => number;
    onInspect: (xRatio: number, yRatio: number) => void;
    onSelectRange: (xStartRatio: number, xEndRatio: number) => void;
    onNavigate: (amount: number) => void;
    onSelectMedia: (id: string | null) => void;
    onToggleMediaPlayback: () => void;
    onStartMediaAudition: (playbackRate: number, direction: -1 | 1) => void;
    onPauseMediaPlayback: () => void;
    onPlayMediaAt: (xRatio: number) => void;
    onFitSelection: () => void;
    onReturnView: () => void;
    onRestoreView: () => void;
    onSeekMedia: (seconds: number) => void;
    onRenameMedia: (id: string, name: string) => void;
    onSaveMedia: (id: string) => void;
    onRemoveMedia: (id: string) => void;
    onClearPlaylist: () => void;
}

export interface LayerDisplayOptions {
    pitchFloorHz: number;
    pitchCeilingHz: number;
    pitchLineWidth: number;
    pitchFrequencyAligned: boolean;
    formantsToDisplay: number;
    formantDynamicRangeDb: number;
    formantDotSize: number;
    intensityFloorDbSpl: number;
    intensityCeilingDbSpl: number;
    intensityLineWidth: number;
}

const EMPTY_SNAPSHOT: LiveSnapshot = {
    elapsedSeconds: 0,
    pitchHz: null,
    intensityDbSpl: 0,
    formantsHz: [null, null, null, null, null],
    meanPitchHz: null,
    minPitchHz: null,
    maxPitchHz: null,
    meanIntensityDbSpl: null,
    voicedPercent: 0,
    sampleRate: 0,
};

const formatNumber = (value: number | null, digits: number = 0) =>
    value === null || !Number.isFinite(value) ? '—' : value.toFixed(digits);

const formatTime = (seconds: number) => {
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds - minutes * 60;
    return `${minutes.toString().padStart(2, '0')}:${remainder.toFixed(1).padStart(4, '0')}`;
};

const installSpectroFavicon = () => {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const context = canvas.getContext('2d');
    if (context === null) {
        return;
    }

    context.beginPath();
    context.moveTo(14, 3);
    context.lineTo(50, 3);
    context.quadraticCurveTo(61, 3, 61, 14);
    context.lineTo(61, 50);
    context.quadraticCurveTo(61, 61, 50, 61);
    context.lineTo(14, 61);
    context.quadraticCurveTo(3, 61, 3, 50);
    context.lineTo(3, 14);
    context.quadraticCurveTo(3, 3, 14, 3);
    context.closePath();
    context.fillStyle = '#101a31';
    context.fill();
    context.strokeStyle = 'rgba(91, 154, 255, 0.72)';
    context.lineWidth = 2;
    context.stroke();

    const gradient = context.createLinearGradient(0, 10, 0, 54);
    gradient.addColorStop(0, '#45d8e7');
    gradient.addColorStop(1, '#5179ff');
    const heights = [14, 32, 46, 32, 14];
    heights.forEach((height, index) => {
        const x = 15 + index * 8;
        context.beginPath();
        context.roundRect(x, 32 - height / 2, 4, height, 2);
        context.fillStyle = gradient;
        context.fill();
    });

    let favicon = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
    if (favicon === null) {
        favicon = document.createElement('link');
        favicon.rel = 'icon';
        document.head.appendChild(favicon);
    }
    favicon.type = 'image/png';
    favicon.href = canvas.toDataURL('image/png');
};

interface SavedSettings {
    liveProfile?: SourceSettingsProfile;
    fileProfile?: SourceSettingsProfile;
    mode: SpectrogramMode;
    pitchAlgorithm: PitchAlgorithm;
    pitchVisible: boolean;
    formantsVisible: boolean;
    intensityVisible: boolean;
    waveformVisible: boolean;
    spectrogramVisible: boolean;
    waveformShare: number;
    waveformThemeName: WaveformThemeName;
    darkWaveformThemeName: WaveformThemeName;
    lightWaveformThemeName: WaveformThemeName;
    waveformScaleMode: WaveformScaleMode;
    waveformGain: number;
    waveformGainDb?: number;
    waveformReferenceUnit?: WaveformReferenceUnit;
    waveformNormalizeRecordingPeak?: boolean;
    waveformAutoFitView?: boolean;
    waveformShowPeak?: boolean;
    waveformShowRms?: boolean;
    waveformShowPeakHold?: boolean;
    waveformShowClipping?: boolean;
    waveformLineWidth: number;
    waveformZeroLine: boolean;
    waveformPulses: boolean;
    uiTheme: UiTheme;
    sensitivity: number;
    contrast: number;
    zoom: number;
    minFrequency: number;
    maxFrequency: number;
    scale?: 'linear' | 'mel';
    broadbandScale: Scale;
    narrowbandScale: Scale;
    customScale: Scale;
    customWindowLengthMs: number;
    windowFunction: SpectrogramWindowFunction;
    gradientName: string;
    darkGradientName: string;
    lightGradientName: string;
    pitchFloor: number;
    pitchCeiling: number;
    voicingThreshold: number;
    pitchLineWidth: number;
    narrowbandPitchFrequencyAligned: boolean;
    maximumFormants: number;
    formantsToDisplay: number;
    formantCeiling: number;
    formantWindowMs: number;
    preEmphasisFrom: number;
    formantDynamicRange: number;
    formantDotSize: number;
    intensityPitchFloor: number;
    intensityFloor: number;
    intensityCeiling: number;
    intensityLineWidth: number;
    splCalibration: number;
    framesPerSecond: number;
    glassEffect: boolean;
    renderPixelRatio: number;
    analysisPrecision: RealtimeAnalysisPrecision;
}

const SETTINGS_STORAGE_KEY = 'spectro-pro.settings.v2';
const NARROWBAND_FREQUENCY_DEFAULT_MIGRATION_KEY =
    'spectro-pro.migrations.narrowband-frequency-default.v1';

const loadSavedSettings = (): Partial<SavedSettings> => {
    try {
        const settings = JSON.parse(
            window.localStorage.getItem(SETTINGS_STORAGE_KEY) || '{}'
        ) as Partial<SavedSettings>;
        if (
            window.localStorage.getItem(NARROWBAND_FREQUENCY_DEFAULT_MIGRATION_KEY) !== 'complete'
        ) {
            if (settings.maxFrequency === 1200) {
                settings.maxFrequency = 5500;
            }
            if (settings.liveProfile?.maxFrequency === 1200) {
                settings.liveProfile.maxFrequency = 5500;
            }
            if (settings.fileProfile?.maxFrequency === 1200) {
                settings.fileProfile.maxFrequency = 5500;
            }
            window.localStorage.setItem(NARROWBAND_FREQUENCY_DEFAULT_MIGRATION_KEY, 'complete');
        }
        return settings;
    } catch {
        return {};
    }
};

export interface AppProps extends AppCallbacks {
    registerController: (controller: UiController) => void;
}

export interface UiController {
    setPlayState: (state: PlayState, sourceName?: string, message?: string) => void;
    updateSnapshot: (snapshot: LiveSnapshot) => void;
    updateCursor: (snapshot: CursorSnapshot | null) => void;
    updateTimeOffset: (offset: number) => void;
    updateZoom: (zoom: number) => void;
    updateReturnViewAvailable: (available: boolean) => void;
    updateMediaLibrary: (items: MediaListItem[], activeId: string | null) => void;
    updateTransport: (snapshot: TransportSnapshot) => void;
    updateSelection: (snapshot: SelectionSnapshot | null) => void;
    updateWaveformAxis: (state: WaveformAxisState) => void;
}

export default function App({
    registerController,
    onStartMicrophone,
    onStartFile,
    onStop,
    onClear,
    onExport,
    onModeChange,
    onSpectrogramAnalysisChange,
    onPitchAlgorithmChange,
    onAnalysisChange,
    onLayerDisplayChange,
    onDisplayChange,
    onPerformanceChange,
    onOverlayChange,
    onPlotVisibilityChange,
    onPlotThemeChange,
    onWaveformDisplayChange,
    onFitWaveformView,
    onInspect,
    onSelectRange,
    onNavigate,
    onSelectMedia,
    onToggleMediaPlayback,
    onStartMediaAudition,
    onPauseMediaPlayback,
    onPlayMediaAt,
    onFitSelection,
    onReturnView,
    onRestoreView,
    onSeekMedia,
    onRenameMedia,
    onSaveMedia,
    onRemoveMedia,
    onClearPlaylist,
}: AppProps) {
    const savedSettingsRef = useRef<Partial<SavedSettings> | null>(null);
    if (savedSettingsRef.current === null) {
        savedSettingsRef.current = loadSavedSettings();
    }
    const saved = savedSettingsRef.current || {};
    const sourceProfilesRef = useRef<{
        live?: SourceSettingsProfile;
        file?: SourceSettingsProfile;
    }>({
        live: saved.liveProfile,
        file: saved.fileProfile,
    });
    const sourceProfileModeRef = useRef<SourceProfileMode>('live');
    const sourceProfileInitializedRef = useRef(false);
    const sourceProfileSwitchingRef = useRef(false);
    const currentSourceProfileRef = useRef<SourceSettingsProfile | null>(null);
    const legacyWaveformThemeName = WAVEFORM_THEMES.find(
        (item) => item.name === saved.waveformThemeName
    )?.name;
    const initialDarkWaveformThemeName =
        WAVEFORM_THEMES.find((item) => item.name === saved.darkWaveformThemeName)?.name ||
        (saved.uiTheme !== 'light' ? legacyWaveformThemeName : undefined) ||
        'Aurora';
    const initialLightWaveformThemeName =
        WAVEFORM_THEMES.find((item) => item.name === saved.lightWaveformThemeName)?.name ||
        (saved.uiTheme === 'light' ? legacyWaveformThemeName : undefined) ||
        'Praat';
    const legacyGradientName = GRADIENTS.find((item) => item.name === saved.gradientName)?.name;
    const initialDarkGradientName =
        GRADIENTS.find((item) => item.name === saved.darkGradientName)?.name ||
        (saved.uiTheme !== 'light' ? legacyGradientName : undefined) ||
        'Aurora';
    const initialLightGradientName =
        GRADIENTS.find((item) => item.name === saved.lightGradientName)?.name ||
        (saved.uiTheme === 'light' ? legacyGradientName : undefined) ||
        'Praat';
    const [locale, setLocale] = useState<Locale>(() => getActiveLocale());
    const [playState, setPlayState] = useState<PlayState>('stopped');
    const [sourceName, setSourceName] = useState('等待输入');
    const [statusMessage, setStatusMessage] = useState('选择麦克风或音频文件开始');
    const [mode, setMode] = useState<SpectrogramMode>(saved.mode || 'broadband');
    const [pitchAlgorithm, setPitchAlgorithm] = useState<PitchAlgorithm>(
        saved.pitchAlgorithm || 'yin'
    );
    const [settingsTab, setSettingsTab] = useState<SettingsTab>('spectrogram');
    const [snapshot, setSnapshot] = useState<LiveSnapshot>(EMPTY_SNAPSHOT);
    const [cursor, setCursor] = useState<CursorSnapshot | null>(null);
    const [pitchVisible, setPitchVisible] = useState(saved.pitchVisible ?? true);
    const [formantsVisible, setFormantsVisible] = useState(saved.formantsVisible ?? true);
    const [intensityVisible, setIntensityVisible] = useState(saved.intensityVisible ?? true);
    const [waveformVisible, setWaveformVisible] = useState(saved.waveformVisible ?? true);
    const [spectrogramVisible, setSpectrogramVisible] = useState(saved.spectrogramVisible ?? true);
    const [waveformShare, setWaveformShare] = useState(saved.waveformShare ?? 0.32);
    const [uiTheme, setUiTheme] = useState<UiTheme>(saved.uiTheme || 'dark');
    const [darkWaveformThemeName, setDarkWaveformThemeName] = useState<WaveformThemeName>(
        initialDarkWaveformThemeName
    );
    const [lightWaveformThemeName, setLightWaveformThemeName] = useState<WaveformThemeName>(
        initialLightWaveformThemeName
    );
    const waveformThemeName = uiTheme === 'dark' ? darkWaveformThemeName : lightWaveformThemeName;
    const setWaveformThemeName = useCallback(
        (themeName: WaveformThemeName) => {
            if (uiTheme === 'dark') {
                setDarkWaveformThemeName(themeName);
            } else {
                setLightWaveformThemeName(themeName);
            }
        },
        [uiTheme]
    );
    const legacyScaleMode = saved.liveProfile?.waveformScaleMode || saved.waveformScaleMode;
    const [waveformScaleMode, setWaveformScaleMode] = useState<WaveformScaleMode>(
        legacyScaleMode === 'logarithmic' ? 'logarithmic' : 'linear'
    );
    const [waveformReferenceUnit, setWaveformReferenceUnit] = useState<WaveformReferenceUnit>(
        saved.liveProfile?.waveformReferenceUnit ??
            saved.waveformReferenceUnit ??
            ((legacyScaleMode as string) === 'dbspl' ? 'dbspl' : 'dbfs')
    );
    const [waveformNormalizeRecordingPeak, setWaveformNormalizeRecordingPeak] = useState(
        saved.liveProfile?.waveformNormalizeRecordingPeak ??
            saved.waveformNormalizeRecordingPeak ??
            false
    );
    const [waveformAxisState, setWaveformAxisState] = useState<WaveformAxisState>({
        effectiveGain: 1,
        amplitudeUnitGain: 1,
        amplitudeReference: 1,
    });
    const [waveformGainDb, setWaveformGainDb] = useState(
        saved.liveProfile?.waveformGainDb ??
            saved.waveformGainDb ??
            20 * Math.log10(Math.max(1e-9, saved.waveformGain ?? 1))
    );
    const [waveformAutoFitView, setWaveformAutoFitView] = useState(
        saved.liveProfile?.waveformAutoFitView ?? saved.waveformAutoFitView ?? false
    );
    const [waveformShowPeak, setWaveformShowPeak] = useState(
        saved.liveProfile?.waveformShowPeak ?? saved.waveformShowPeak ?? true
    );
    const [waveformShowRms, setWaveformShowRms] = useState(
        saved.liveProfile?.waveformShowRms ?? saved.waveformShowRms ?? true
    );
    const [waveformShowPeakHold, setWaveformShowPeakHold] = useState(
        saved.liveProfile?.waveformShowPeakHold ?? saved.waveformShowPeakHold ?? false
    );
    const [waveformShowClipping, setWaveformShowClipping] = useState(
        saved.liveProfile?.waveformShowClipping ?? saved.waveformShowClipping ?? true
    );
    const [waveformLineWidth, setWaveformLineWidth] = useState(saved.waveformLineWidth ?? 1);
    const [waveformZeroLine, setWaveformZeroLine] = useState(saved.waveformZeroLine ?? true);
    const [waveformPulses, setWaveformPulses] = useState(saved.waveformPulses ?? false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [metricsOpen, setMetricsOpen] = useState(false);
    const [metricsCollapsed, setMetricsCollapsed] = useState(false);
    const [selectedMetric, setSelectedMetric] = useState<MetricSelection>('pitch');
    const [sensitivity, setSensitivity] = useState(saved.sensitivity ?? 0.42);
    const [contrast, setContrast] = useState(saved.contrast ?? 0.32);
    const [zoom, setZoom] = useState(saved.zoom ?? 1);
    const [minFrequency, setMinFrequency] = useState(saved.minFrequency ?? 0);
    const [maxFrequency, setMaxFrequency] = useState(saved.maxFrequency ?? 5500);
    const [broadbandScale, setBroadbandScale] = useState<Scale>(
        saved.broadbandScale || (saved.mode === 'broadband' ? saved.scale : undefined) || 'linear'
    );
    const [narrowbandScale, setNarrowbandScale] = useState<Scale>(
        saved.narrowbandScale || (saved.mode === 'narrowband' ? saved.scale : undefined) || 'log'
    );
    const [customScale, setCustomScale] = useState<Scale>(saved.customScale || 'linear');
    const [customWindowLengthMs, setCustomWindowLengthMs] = useState(
        saved.customWindowLengthMs ?? 15
    );
    const [windowFunction, setWindowFunction] = useState<SpectrogramWindowFunction>(
        saved.windowFunction || 'gaussian'
    );
    const [darkGradientName, setDarkGradientName] = useState(initialDarkGradientName);
    const [lightGradientName, setLightGradientName] = useState(initialLightGradientName);
    const gradientName = uiTheme === 'dark' ? darkGradientName : lightGradientName;
    const setGradientName = useCallback(
        (themeName: string) => {
            if (uiTheme === 'dark') {
                setDarkGradientName(themeName);
            } else {
                setLightGradientName(themeName);
            }
        },
        [uiTheme]
    );
    const [pitchFloor, setPitchFloor] = useState(saved.pitchFloor ?? 75);
    const [pitchCeiling, setPitchCeiling] = useState(saved.pitchCeiling ?? 500);
    const [voicingThreshold, setVoicingThreshold] = useState(saved.voicingThreshold ?? 0.6);
    const [pitchLineWidth, setPitchLineWidth] = useState(saved.pitchLineWidth ?? 2.5);
    const [narrowbandPitchFrequencyAligned, setNarrowbandPitchFrequencyAligned] = useState(
        saved.narrowbandPitchFrequencyAligned ?? true
    );
    const [maximumFormants, setMaximumFormants] = useState(saved.maximumFormants ?? 5);
    const [formantsToDisplay, setFormantsToDisplay] = useState(saved.formantsToDisplay ?? 5);
    const [formantCeiling, setFormantCeiling] = useState(saved.formantCeiling ?? 5500);
    const [formantWindowMs, setFormantWindowMs] = useState(saved.formantWindowMs ?? 25);
    const [preEmphasisFrom, setPreEmphasisFrom] = useState(saved.preEmphasisFrom ?? 50);
    const [formantDynamicRange, setFormantDynamicRange] = useState(saved.formantDynamicRange ?? 30);
    const [formantDotSize, setFormantDotSize] = useState(saved.formantDotSize ?? 2.4);
    const [intensityPitchFloor, setIntensityPitchFloor] = useState(saved.intensityPitchFloor ?? 75);
    const [intensityFloor, setIntensityFloor] = useState(saved.intensityFloor ?? 50);
    const [intensityCeiling, setIntensityCeiling] = useState(saved.intensityCeiling ?? 100);
    const [intensityLineWidth, setIntensityLineWidth] = useState(saved.intensityLineWidth ?? 2.5);
    const [splCalibration, setSplCalibration] = useState(saved.splCalibration ?? 0);
    const [framesPerSecond, setFramesPerSecond] = useState(saved.framesPerSecond ?? 30);
    const [glassEffect, setGlassEffect] = useState(saved.glassEffect ?? true);
    const [renderPixelRatio, setRenderPixelRatio] = useState(saved.renderPixelRatio ?? 1.5);
    const [analysisPrecision, setAnalysisPrecision] = useState<RealtimeAnalysisPrecision>(
        saved.liveProfile?.analysisPrecision || saved.analysisPrecision || 'balanced'
    );
    const [timeOffset, setTimeOffset] = useState(0);
    const [returnViewAvailable, setReturnViewAvailable] = useState(false);
    const [playlistOpen, setPlaylistOpen] = useState(false);
    const [playlistCollapsed, setPlaylistCollapsed] = useState(false);
    const [playlistPosition, setPlaylistPosition] = useState<{
        left: number;
        top: number;
    } | null>(null);
    const [metricsPosition, setMetricsPosition] = useState<{
        left: number;
        top: number;
    } | null>(null);
    const [mediaItems, setMediaItems] = useState<MediaListItem[]>([]);
    const [activeMediaId, setActiveMediaId] = useState<string | null>(null);
    const [transport, setTransport] = useState<TransportSnapshot>({
        activeId: null,
        currentSeconds: 0,
        durationSeconds: 0,
        viewStartSeconds: 0,
        viewEndSeconds: 0,
        isPlaying: false,
    });
    const [selection, setSelection] = useState<SelectionSnapshot | null>(null);
    const fileRef = useRef<HTMLInputElement | null>(null);
    const plotGestureRef = useRef<PlotGesture>({
        pointers: new Map(),
        primaryPointerId: null,
        start: null,
        dragging: false,
        panning: false,
        blockedUntilRelease: false,
        lastPanCenterX: null,
    });
    const plotContainerRef = useRef<HTMLDivElement | null>(null);
    const axisViewRef = useRef<HTMLDivElement | null>(null);
    const cursorTooltipRef = useRef<HTMLDivElement | null>(null);
    const playlistRef = useRef<HTMLElement | null>(null);
    const metricsRef = useRef<HTMLElement | null>(null);
    const languageRef = useRef<HTMLDivElement | null>(null);
    const draggedPanelRef = useRef<'playlist' | 'metrics' | null>(null);
    const zoomInitializedRef = useRef(false);
    const heldArrowKeysRef = useRef<Set<string>>(new Set());
    const keyboardAuditionRef = useRef(false);
    const [languageMenuOpen, setLanguageMenuOpen] = useState(false);
    const scale =
        mode === 'broadband'
            ? broadbandScale
            : mode === 'narrowband'
            ? narrowbandScale
            : customScale;
    const tr = useCallback((text: string) => translate(text, locale), [locale]);
    const localizedSourceName = sourceName.replace(
        /^(\d+) 个文件$/,
        (_, count: string) => `${count} ${tr('个文件')}`
    );
    const chooseLocale = useCallback((nextLocale: Locale) => {
        setActiveLocale(nextLocale);
        setLocale(nextLocale);
        setLanguageMenuOpen(false);
    }, []);
    const sourceProfileMode: SourceProfileMode =
        playState === 'loading-mic'
            ? 'live'
            : playState === 'loading-file' || activeMediaId !== null
            ? 'file'
            : 'live';
    const currentSourceProfile: SourceSettingsProfile = {
        mode,
        pitchAlgorithm,
        waveformScaleMode,
        waveformReferenceUnit,
        waveformGainDb,
        waveformNormalizeRecordingPeak,
        waveformAutoFitView,
        waveformShowPeak,
        waveformShowRms,
        waveformShowPeakHold,
        waveformShowClipping,
        waveformLineWidth,
        waveformZeroLine,
        waveformPulses,
        sensitivity,
        contrast,
        minFrequency,
        maxFrequency,
        broadbandScale,
        narrowbandScale,
        customScale,
        customWindowLengthMs,
        windowFunction,
        pitchFloor,
        pitchCeiling,
        voicingThreshold,
        pitchLineWidth,
        narrowbandPitchFrequencyAligned,
        maximumFormants,
        formantsToDisplay,
        formantCeiling,
        formantWindowMs,
        preEmphasisFrom,
        formantDynamicRange,
        formantDotSize,
        intensityPitchFloor,
        intensityFloor,
        intensityCeiling,
        intensityLineWidth,
        splCalibration,
        framesPerSecond,
        renderPixelRatio,
        analysisPrecision,
    };
    currentSourceProfileRef.current = currentSourceProfile;
    const applySourceProfile = useCallback(
        (profile: SourceSettingsProfile, profileMode: SourceProfileMode) => {
            const legacyProfile = profile as SourceSettingsProfile & { waveformGain?: number };
            setMode(profile.mode);
            setPitchAlgorithm(profile.pitchAlgorithm);
            setWaveformScaleMode(
                profile.waveformScaleMode === 'logarithmic' ? 'logarithmic' : 'linear'
            );
            setWaveformReferenceUnit(
                profile.waveformReferenceUnit ??
                    ((profile.waveformScaleMode as string) === 'dbspl' ? 'dbspl' : 'dbfs')
            );
            setWaveformGainDb(
                profile.waveformGainDb ??
                    20 * Math.log10(Math.max(1e-9, legacyProfile.waveformGain ?? 1))
            );
            setWaveformNormalizeRecordingPeak(
                profile.waveformNormalizeRecordingPeak ?? profileMode === 'file'
            );
            setWaveformAutoFitView(profile.waveformAutoFitView ?? false);
            setWaveformShowPeak(profile.waveformShowPeak ?? true);
            setWaveformShowRms(profile.waveformShowRms ?? true);
            setWaveformShowPeakHold(profile.waveformShowPeakHold ?? false);
            setWaveformShowClipping(profile.waveformShowClipping ?? true);
            setWaveformLineWidth(profile.waveformLineWidth);
            setWaveformZeroLine(profile.waveformZeroLine);
            setWaveformPulses(profile.waveformPulses);
            setSensitivity(profile.sensitivity);
            setContrast(profile.contrast);
            setMinFrequency(profile.minFrequency);
            setMaxFrequency(profile.maxFrequency);
            setBroadbandScale(profile.broadbandScale);
            setNarrowbandScale(profile.narrowbandScale);
            setCustomScale(profile.customScale);
            setCustomWindowLengthMs(profile.customWindowLengthMs);
            setWindowFunction(profile.windowFunction);
            setPitchFloor(profile.pitchFloor);
            setPitchCeiling(profile.pitchCeiling);
            setVoicingThreshold(profile.voicingThreshold);
            setPitchLineWidth(profile.pitchLineWidth);
            setNarrowbandPitchFrequencyAligned(profile.narrowbandPitchFrequencyAligned);
            setMaximumFormants(profile.maximumFormants);
            setFormantsToDisplay(profile.formantsToDisplay);
            setFormantCeiling(profile.formantCeiling);
            setFormantWindowMs(profile.formantWindowMs);
            setPreEmphasisFrom(profile.preEmphasisFrom);
            setFormantDynamicRange(profile.formantDynamicRange);
            setFormantDotSize(profile.formantDotSize);
            setIntensityPitchFloor(profile.intensityPitchFloor);
            setIntensityFloor(profile.intensityFloor);
            setIntensityCeiling(profile.intensityCeiling);
            setIntensityLineWidth(profile.intensityLineWidth);
            setSplCalibration(profile.splCalibration);
            setFramesPerSecond(profile.framesPerSecond);
            setRenderPixelRatio(profile.renderPixelRatio);
            setAnalysisPrecision(profile.analysisPrecision);
        },
        []
    );

    useEffect(() => {
        registerController({
            setPlayState: (state, source = sourceName, message = '') => {
                setPlayState(state);
                setSourceName(source);
                setStatusMessage(
                    message ||
                        (state === 'playing'
                            ? '实时分析中'
                            : state === 'stopped'
                            ? '分析已停止'
                            : '正在准备音频…')
                );
            },
            updateSnapshot: setSnapshot,
            updateCursor: setCursor,
            updateTimeOffset: setTimeOffset,
            updateZoom: setZoom,
            updateReturnViewAvailable: setReturnViewAvailable,
            updateMediaLibrary: (items, activeId) => {
                setMediaItems(items);
                setActiveMediaId(activeId);
            },
            updateTransport: setTransport,
            updateSelection: setSelection,
            updateWaveformAxis: setWaveformAxisState,
        });
    }, [registerController]);

    useEffect(() => {
        installSpectroFavicon();
    }, []);

    useEffect(() => {
        document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
        document.title = tr('Spectro Pro · 实时声学显示器');
        const description = document.querySelector('meta[name="description"]');
        description?.setAttribute(
            'content',
            tr('Spectro Pro 是一个现代、实时、易用的浏览器声学可视化工具。')
        );
        const ogTitle = document.querySelector('meta[property="og:title"]');
        ogTitle?.setAttribute('content', tr('Spectro Pro · 实时声学显示器'));
        const ogDescription = document.querySelector('meta[property="og:description"]');
        ogDescription?.setAttribute('content', tr('宽带与窄带语谱实时基频共振峰和音强曲线'));
    }, [locale, tr]);

    useEffect(() => {
        const closeLanguageMenu = (event: MouseEvent) => {
            if (
                languageRef.current !== null &&
                event.target instanceof Node &&
                !languageRef.current.contains(event.target)
            ) {
                setLanguageMenuOpen(false);
            }
        };
        const closeLanguageMenuWithEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setLanguageMenuOpen(false);
            }
        };
        document.addEventListener('mousedown', closeLanguageMenu);
        document.addEventListener('keydown', closeLanguageMenuWithEscape);
        return () => {
            document.removeEventListener('mousedown', closeLanguageMenu);
            document.removeEventListener('keydown', closeLanguageMenuWithEscape);
        };
    }, []);

    useEffect(() => {
        const current = currentSourceProfileRef.current;
        if (current === null) {
            return;
        }
        if (!sourceProfileInitializedRef.current) {
            sourceProfileInitializedRef.current = true;
            sourceProfileModeRef.current = sourceProfileMode;
            const savedProfile = sourceProfilesRef.current[sourceProfileMode];
            if (savedProfile !== undefined) {
                sourceProfileSwitchingRef.current = true;
                applySourceProfile(savedProfile, sourceProfileMode);
            }
            return;
        }
        const previousMode = sourceProfileModeRef.current;
        if (previousMode === sourceProfileMode) {
            return;
        }
        sourceProfilesRef.current[previousMode] = current;
        const target =
            sourceProfilesRef.current[sourceProfileMode] ||
            ({
                ...current,
                analysisPrecision: sourceProfileMode === 'live' ? 'balanced' : 'accurate',
                waveformScaleMode: 'linear',
                waveformReferenceUnit: 'dbfs',
                waveformGainDb: 0,
                waveformNormalizeRecordingPeak: sourceProfileMode === 'file',
                waveformAutoFitView: false,
            } as SourceSettingsProfile);
        sourceProfilesRef.current[sourceProfileMode] = target;
        sourceProfileModeRef.current = sourceProfileMode;
        sourceProfileSwitchingRef.current = true;
        applySourceProfile(target, sourceProfileMode);
    }, [applySourceProfile, sourceProfileMode]);

    useEffect(() => {
        if (sourceProfileSwitchingRef.current) {
            sourceProfileSwitchingRef.current = false;
            return;
        }
        sourceProfilesRef.current[sourceProfileMode] = currentSourceProfile;
        const settings: SavedSettings = {
            liveProfile: sourceProfilesRef.current.live || {
                ...currentSourceProfile,
                analysisPrecision: 'balanced',
                waveformScaleMode: 'linear',
                waveformReferenceUnit: 'dbfs',
                waveformGainDb: 0,
                waveformNormalizeRecordingPeak: false,
                waveformAutoFitView: false,
            },
            fileProfile: sourceProfilesRef.current.file || {
                ...currentSourceProfile,
                analysisPrecision: 'accurate',
                waveformScaleMode: 'linear',
                waveformReferenceUnit: 'dbfs',
                waveformGainDb: 0,
                waveformNormalizeRecordingPeak: true,
                waveformAutoFitView: false,
            },
            mode,
            pitchAlgorithm,
            pitchVisible,
            formantsVisible,
            intensityVisible,
            waveformVisible,
            spectrogramVisible,
            waveformShare,
            waveformThemeName,
            darkWaveformThemeName,
            lightWaveformThemeName,
            waveformScaleMode,
            waveformReferenceUnit,
            waveformGain: 10 ** (waveformGainDb / 20),
            waveformGainDb,
            waveformNormalizeRecordingPeak,
            waveformAutoFitView,
            waveformShowPeak,
            waveformShowRms,
            waveformShowPeakHold,
            waveformShowClipping,
            waveformLineWidth,
            waveformZeroLine,
            waveformPulses,
            uiTheme,
            sensitivity,
            contrast,
            zoom,
            minFrequency,
            maxFrequency,
            broadbandScale,
            narrowbandScale,
            customScale,
            customWindowLengthMs,
            windowFunction,
            gradientName,
            darkGradientName,
            lightGradientName,
            pitchFloor,
            pitchCeiling,
            voicingThreshold,
            pitchLineWidth,
            narrowbandPitchFrequencyAligned,
            maximumFormants,
            formantsToDisplay,
            formantCeiling,
            formantWindowMs,
            preEmphasisFrom,
            formantDynamicRange,
            formantDotSize,
            intensityPitchFloor,
            intensityFloor,
            intensityCeiling,
            intensityLineWidth,
            splCalibration,
            framesPerSecond,
            glassEffect,
            renderPixelRatio,
            analysisPrecision,
        };
        try {
            window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
        } catch {
            // The visualizer remains usable when browser storage is unavailable.
        }
    }, [
        sourceProfileMode,
        mode,
        pitchAlgorithm,
        pitchVisible,
        formantsVisible,
        intensityVisible,
        waveformVisible,
        spectrogramVisible,
        waveformShare,
        waveformThemeName,
        darkWaveformThemeName,
        lightWaveformThemeName,
        waveformScaleMode,
        waveformReferenceUnit,
        waveformGainDb,
        waveformNormalizeRecordingPeak,
        waveformAutoFitView,
        waveformShowPeak,
        waveformShowRms,
        waveformShowPeakHold,
        waveformShowClipping,
        waveformLineWidth,
        waveformZeroLine,
        waveformPulses,
        uiTheme,
        sensitivity,
        contrast,
        zoom,
        minFrequency,
        maxFrequency,
        broadbandScale,
        narrowbandScale,
        customScale,
        customWindowLengthMs,
        windowFunction,
        gradientName,
        darkGradientName,
        lightGradientName,
        pitchFloor,
        pitchCeiling,
        voicingThreshold,
        pitchLineWidth,
        narrowbandPitchFrequencyAligned,
        maximumFormants,
        formantsToDisplay,
        formantCeiling,
        formantWindowMs,
        preEmphasisFrom,
        formantDynamicRange,
        formantDotSize,
        intensityPitchFloor,
        intensityFloor,
        intensityCeiling,
        intensityLineWidth,
        splCalibration,
        framesPerSecond,
        glassEffect,
        renderPixelRatio,
        analysisPrecision,
    ]);

    useEffect(() => {
        onPerformanceChange({
            framesPerSecond,
            renderPixelRatio,
            analysisPrecision,
        });
    }, [framesPerSecond, renderPixelRatio, analysisPrecision, onPerformanceChange]);

    useEffect(() => {
        document.documentElement.classList.toggle('glass-effects', glassEffect);
        return () => document.documentElement.classList.remove('glass-effects');
    }, [glassEffect]);

    useEffect(() => {
        document.documentElement.classList.toggle('light-ui', uiTheme === 'light');
        return () => document.documentElement.classList.remove('light-ui');
    }, [uiTheme]);

    useEffect(() => {
        const finishKeyboardAudition = () => {
            heldArrowKeysRef.current.clear();
            if (keyboardAuditionRef.current) {
                keyboardAuditionRef.current = false;
                onPauseMediaPlayback();
            }
        };
        const handleKeyboardShortcut = (event: KeyboardEvent) => {
            const target = event.target;
            if (
                event.ctrlKey ||
                event.metaKey ||
                (target instanceof HTMLElement &&
                    (target.isContentEditable ||
                        target.closest('input, select, textarea') !== null))
            ) {
                return;
            }
            if (
                event.code === 'Space' &&
                !event.repeat &&
                activeMediaId !== null &&
                transport.durationSeconds > 0
            ) {
                event.preventDefault();
                onToggleMediaPlayback();
                return;
            }
            if (
                (event.key === 'ArrowLeft' || event.key === 'ArrowRight') &&
                activeMediaId !== null &&
                transport.durationSeconds > 0
            ) {
                event.preventDefault();
                heldArrowKeysRef.current.add(event.key);
                const direction = event.key === 'ArrowLeft' ? -1 : 1;
                if (event.repeat) {
                    if (!keyboardAuditionRef.current && !transport.isPlaying) {
                        keyboardAuditionRef.current = true;
                        onStartMediaAudition(event.shiftKey ? 3 : 1, direction);
                    }
                    return;
                }
                const visibleDurationSeconds = Math.max(
                    0.001,
                    transport.viewEndSeconds - transport.viewStartSeconds
                );
                const stepSeconds = visibleDurationSeconds * (event.shiftKey ? 0.05 : 0.01);
                onSeekMedia(
                    Math.max(
                        0,
                        Math.min(
                            transport.durationSeconds,
                            transport.currentSeconds + direction * stepSeconds
                        )
                    )
                );
            }
        };
        const handleKeyboardShortcutRelease = (event: KeyboardEvent) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
                return;
            }
            heldArrowKeysRef.current.delete(event.key);
            if (heldArrowKeysRef.current.size === 0 && keyboardAuditionRef.current) {
                keyboardAuditionRef.current = false;
                onPauseMediaPlayback();
            }
        };
        document.addEventListener('keydown', handleKeyboardShortcut);
        document.addEventListener('keyup', handleKeyboardShortcutRelease);
        window.addEventListener('blur', finishKeyboardAudition);
        return () => {
            document.removeEventListener('keydown', handleKeyboardShortcut);
            document.removeEventListener('keyup', handleKeyboardShortcutRelease);
            window.removeEventListener('blur', finishKeyboardAudition);
        };
    }, [
        activeMediaId,
        transport.currentSeconds,
        transport.durationSeconds,
        transport.isPlaying,
        transport.viewEndSeconds,
        transport.viewStartSeconds,
        onPauseMediaPlayback,
        onStartMediaAudition,
        onToggleMediaPlayback,
        onSeekMedia,
    ]);

    useEffect(() => {
        const gradient = GRADIENTS.find((item) => item.name === gradientName);
        onDisplayChange({
            sensitivity: 10 ** (2 + sensitivity * 2),
            contrast: 10 ** (0.5 + contrast * 3) - 1,
            minFrequencyHz: minFrequency,
            maxFrequencyHz: maxFrequency,
            scale,
            gradient: gradient?.gradient,
        });
    }, [sensitivity, contrast, minFrequency, maxFrequency, scale, gradientName, onDisplayChange]);

    useEffect(() => {
        if (zoomInitializedRef.current) {
            return;
        }
        zoomInitializedRef.current = true;
        onDisplayChange({ zoom });
    }, [onDisplayChange, zoom]);

    useEffect(() => {
        const timeout = window.setTimeout(
            () =>
                onAnalysisChange({
                    pitchAlgorithm,
                    minPitchHz: pitchFloor,
                    maxPitchHz: pitchCeiling,
                    voicingThreshold,
                    maximumFormants,
                    formantCeilingHz: formantCeiling,
                    formantWindowLengthSeconds: formantWindowMs / 1000,
                    preEmphasisFromHz: preEmphasisFrom,
                    intensityPitchFloorHz: intensityPitchFloor,
                    splCalibrationDb: splCalibration,
                }),
            160
        );
        return () => window.clearTimeout(timeout);
    }, [
        pitchAlgorithm,
        pitchFloor,
        pitchCeiling,
        voicingThreshold,
        maximumFormants,
        formantCeiling,
        formantWindowMs,
        preEmphasisFrom,
        intensityPitchFloor,
        splCalibration,
        onAnalysisChange,
    ]);

    useEffect(() => {
        onLayerDisplayChange({
            pitchFloorHz: pitchFloor,
            pitchCeilingHz: pitchCeiling,
            pitchLineWidth,
            pitchFrequencyAligned: mode === 'narrowband' && narrowbandPitchFrequencyAligned,
            formantsToDisplay,
            formantDynamicRangeDb: formantDynamicRange,
            formantDotSize,
            intensityFloorDbSpl: intensityFloor,
            intensityCeilingDbSpl: intensityCeiling,
            intensityLineWidth,
        });
    }, [
        pitchFloor,
        pitchCeiling,
        pitchLineWidth,
        mode,
        narrowbandPitchFrequencyAligned,
        formantsToDisplay,
        formantDynamicRange,
        formantDotSize,
        intensityFloor,
        intensityCeiling,
        intensityLineWidth,
        onLayerDisplayChange,
    ]);

    useEffect(() => {
        setFormantsToDisplay((current) => Math.min(current, Math.ceil(maximumFormants)));
    }, [maximumFormants]);

    useEffect(() => {
        onOverlayChange(pitchVisible, formantsVisible, intensityVisible);
    }, [pitchVisible, formantsVisible, intensityVisible, onOverlayChange]);

    useEffect(() => {
        onPlotVisibilityChange(waveformVisible, spectrogramVisible);
    }, [waveformVisible, spectrogramVisible, onPlotVisibilityChange]);

    useEffect(() => {
        onPlotThemeChange(gradientName, waveformThemeName);
    }, [gradientName, waveformThemeName, onPlotThemeChange]);

    useEffect(() => {
        onWaveformDisplayChange({
            gainDb: waveformGainDb,
            lineWidth: waveformLineWidth,
            showZeroLine: waveformZeroLine,
            showPulses: waveformPulses,
            scaleMode: waveformScaleMode,
            referenceUnit: waveformReferenceUnit,
            splCalibrationDb: splCalibration,
            normalizeRecordingPeak: sourceProfileMode === 'file' && waveformNormalizeRecordingPeak,
            autoFitView: waveformAutoFitView,
            showPeak: waveformShowPeak,
            showRms: waveformShowRms,
            showPeakHold: waveformShowPeakHold,
            showClipping: waveformShowClipping,
        });
    }, [
        waveformGainDb,
        waveformLineWidth,
        waveformZeroLine,
        waveformPulses,
        waveformScaleMode,
        waveformReferenceUnit,
        splCalibration,
        sourceProfileMode,
        waveformNormalizeRecordingPeak,
        waveformAutoFitView,
        waveformShowPeak,
        waveformShowRms,
        waveformShowPeakHold,
        waveformShowClipping,
        onWaveformDisplayChange,
    ]);

    useEffect(() => {
        const timeout = window.setTimeout(
            () =>
                onSpectrogramAnalysisChange({
                    customWindowLengthMs,
                    windowFunction,
                }),
            160
        );
        return () => window.clearTimeout(timeout);
    }, [customWindowLengthMs, windowFunction, onSpectrogramAnalysisChange]);

    useEffect(() => {
        onModeChange(mode);
    }, [mode, onModeChange]);

    const changeMode = useCallback((newMode: SpectrogramMode) => {
        setMode(newMode);
    }, []);

    const chooseFile = useCallback(() => fileRef.current?.click(), []);
    const loadFile = useCallback(
        async (event: ChangeEvent<HTMLInputElement>) => {
            const files = Array.from(event.target.files || []);
            if (files.length === 0) {
                return;
            }
            setPlayState('loading-file');
            setSourceName(files.length === 1 ? files[0].name : `${files.length} 个文件`);
            setStatusMessage('正在建立分析缓存…');
            for (const file of files) {
                const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
                    const reader = new FileReader();
                    reader.addEventListener('load', () => {
                        if (reader.result instanceof ArrayBuffer) {
                            resolve(reader.result);
                        } else {
                            reject(new Error('无法读取音频文件'));
                        }
                    });
                    reader.addEventListener('error', () => reject(reader.error));
                    reader.readAsArrayBuffer(file);
                });
                onStartFile(buffer, file.name);
            }
            if (fileRef.current) {
                fileRef.current.value = '';
            }
        },
        [onStartFile]
    );

    const plotPoint = useCallback(
        (canvas: HTMLCanvasElement, clientX: number, clientY: number): PlotPointer => {
            const bounds = canvas.getBoundingClientRect();
            return {
                x: Math.min(1, Math.max(0, (clientX - bounds.left) / bounds.width)),
                y: Math.min(1, Math.max(0, (clientY - bounds.top) / bounds.height)),
                clientX,
                clientY,
            };
        },
        []
    );

    const inspectPlotPoint = useCallback(
        (canvas: HTMLCanvasElement, point: PlotPointer) => {
            if (canvas.dataset.plot === 'spectrogram') {
                onInspect(point.x, point.y);
            } else {
                onInspect(-1, -1);
            }
        },
        [onInspect]
    );

    const resetPlotGesture = useCallback(() => {
        const gesture = plotGestureRef.current;
        gesture.pointers.clear();
        gesture.primaryPointerId = null;
        gesture.start = null;
        gesture.dragging = false;
        gesture.panning = false;
        gesture.blockedUntilRelease = false;
        gesture.lastPanCenterX = null;
    }, []);

    const plotPanCenterX = useCallback((gesture: PlotGesture) => {
        const points = Array.from(gesture.pointers.values());
        if (points.length === 0) {
            return null;
        }
        return points.reduce((sum, point) => sum + point.clientX, 0) / points.length;
    }, []);

    const startPlotGesture = useCallback(
        (event: ReactPointerEvent<HTMLCanvasElement>) => {
            if (event.pointerType === 'mouse' && event.button !== 0) {
                return;
            }
            event.preventDefault();
            const canvas = event.currentTarget;
            const gesture = plotGestureRef.current;
            const point = plotPoint(canvas, event.clientX, event.clientY);
            canvas.setPointerCapture(event.pointerId);
            gesture.pointers.set(event.pointerId, point);

            if (gesture.pointers.size === 1) {
                gesture.primaryPointerId = event.pointerId;
                gesture.start = point;
                gesture.dragging = false;
                gesture.panning = false;
                gesture.blockedUntilRelease = false;
                gesture.lastPanCenterX = null;
                inspectPlotPoint(canvas, point);
                onSelectRange(-1, -1);
                return;
            }

            if (event.pointerType === 'touch') {
                gesture.panning = true;
                gesture.blockedUntilRelease = true;
                gesture.dragging = false;
                gesture.lastPanCenterX = plotPanCenterX(gesture);
                onSelectRange(-1, -1);
                onInspect(-1, -1);
            }
        },
        [inspectPlotPoint, onInspect, onSelectRange, plotPanCenterX, plotPoint]
    );

    const updatePlotGesture = useCallback(
        (event: ReactPointerEvent<HTMLCanvasElement>) => {
            const canvas = event.currentTarget;
            const gesture = plotGestureRef.current;
            const current = gesture.pointers.get(event.pointerId);
            const point = plotPoint(canvas, event.clientX, event.clientY);

            if (current === undefined) {
                if (event.pointerType === 'mouse') {
                    inspectPlotPoint(canvas, point);
                }
                return;
            }

            event.preventDefault();
            gesture.pointers.set(event.pointerId, point);
            if (gesture.panning && gesture.pointers.size >= 2) {
                const centerX = plotPanCenterX(gesture);
                if (centerX !== null && gesture.lastPanCenterX !== null) {
                    const bounds = canvas.getBoundingClientRect();
                    onNavigate(
                        (centerX - gesture.lastPanCenterX) /
                            Math.max(1, bounds.width) /
                            Math.max(1, zoom)
                    );
                }
                gesture.lastPanCenterX = centerX;
                return;
            }

            if (
                gesture.blockedUntilRelease ||
                gesture.primaryPointerId !== event.pointerId ||
                gesture.start === null
            ) {
                return;
            }

            inspectPlotPoint(canvas, point);
            const distance = Math.hypot(
                point.clientX - gesture.start.clientX,
                point.clientY - gesture.start.clientY
            );
            if (distance >= 6) {
                gesture.dragging = true;
                onSelectRange(gesture.start.x, point.x);
            }
        },
        [inspectPlotPoint, onNavigate, onSelectRange, plotPanCenterX, plotPoint, zoom]
    );

    const finishPlotGesture = useCallback(
        (event: ReactPointerEvent<HTMLCanvasElement>, cancelled = false) => {
            const canvas = event.currentTarget;
            const gesture = plotGestureRef.current;
            const current = gesture.pointers.get(event.pointerId);
            if (current === undefined) {
                return;
            }

            const point = plotPoint(canvas, event.clientX, event.clientY);
            gesture.pointers.set(event.pointerId, point);
            const wasPanning = gesture.panning || gesture.blockedUntilRelease;
            const wasPrimary = gesture.primaryPointerId === event.pointerId;
            const start = gesture.start;
            const wasDragging = gesture.dragging;
            gesture.pointers.delete(event.pointerId);

            if (!cancelled && !wasPanning && wasPrimary && start !== null) {
                inspectPlotPoint(canvas, point);
                if (wasDragging) {
                    onSelectRange(start.x, point.x);
                    if (transport.activeId !== null) {
                        onPlayMediaAt(Math.min(start.x, point.x));
                    }
                } else {
                    onSelectRange(-1, -1);
                    if (transport.activeId !== null) {
                        onPlayMediaAt(point.x);
                    }
                }
            }

            if (canvas.hasPointerCapture(event.pointerId)) {
                canvas.releasePointerCapture(event.pointerId);
            }
            if (gesture.pointers.size === 0) {
                resetPlotGesture();
            } else if (gesture.pointers.size >= 2) {
                gesture.lastPanCenterX = plotPanCenterX(gesture);
            } else {
                gesture.panning = false;
                gesture.lastPanCenterX = null;
            }
        },
        [
            inspectPlotPoint,
            onPlayMediaAt,
            onSelectRange,
            plotPanCenterX,
            plotPoint,
            resetPlotGesture,
            transport.activeId,
        ]
    );

    const leavePlot = useCallback(
        (event: ReactPointerEvent<HTMLCanvasElement>) => {
            if (
                event.pointerType === 'mouse' &&
                !plotGestureRef.current.pointers.has(event.pointerId)
            ) {
                onInspect(-1, -1);
            }
        },
        [onInspect]
    );

    const cancelPlotGesture = useCallback(
        (event: ReactPointerEvent<HTMLCanvasElement>) => {
            finishPlotGesture(event, true);
        },
        [finishPlotGesture]
    );

    const beginPlotResize = useCallback(
        (event: ReactPointerEvent<HTMLDivElement>) => {
            const container = plotContainerRef.current;
            if (container === null || !waveformVisible || !spectrogramVisible) {
                return;
            }
            event.preventDefault();
            const bounds = container.getBoundingClientRect();
            const update = (clientY: number) => {
                const ratio = (clientY - bounds.top) / Math.max(1, bounds.height);
                setWaveformShare(Math.min(0.8, Math.max(0.15, ratio)));
            };
            const move = (moveEvent: PointerEvent) => update(moveEvent.clientY);
            const finish = (upEvent: PointerEvent) => {
                update(upEvent.clientY);
                document.removeEventListener('pointermove', move);
                document.removeEventListener('pointerup', finish);
            };
            document.addEventListener('pointermove', move);
            document.addEventListener('pointerup', finish);
        },
        [spectrogramVisible, waveformVisible]
    );

    const beginFloatingDrag = useCallback(
        (panelName: 'playlist' | 'metrics', event: ReactPointerEvent<HTMLElement>) => {
            if (event.button !== 0) {
                return;
            }
            const panel = panelName === 'playlist' ? playlistRef.current : metricsRef.current;
            if (panel === null) {
                return;
            }
            event.preventDefault();
            const dragTarget = event.currentTarget;
            dragTarget.setPointerCapture(event.pointerId);
            const bounds = panel.getBoundingClientRect();
            const startX = event.clientX;
            const startY = event.clientY;
            let moved = false;
            let latestLeft = bounds.left;
            let latestTop = bounds.top;
            let frameId: number | null = null;
            panel.classList.add('dragging');

            const updatePosition = (clientX: number, clientY: number) => {
                const deltaX = clientX - startX;
                const deltaY = clientY - startY;
                moved = moved || Math.abs(deltaX) + Math.abs(deltaY) > 3;
                latestLeft = Math.min(
                    Math.max(8, bounds.left + deltaX),
                    Math.max(8, window.innerWidth - bounds.width - 8)
                );
                latestTop = Math.min(
                    Math.max(8, bounds.top + deltaY),
                    Math.max(8, window.innerHeight - bounds.height - 8)
                );
            };
            const renderDragTransform = () => {
                frameId = null;
                panel.style.translate = `${latestLeft - bounds.left}px ${latestTop - bounds.top}px`;
            };
            const move = (moveEvent: PointerEvent) => {
                if (moveEvent.pointerId !== event.pointerId) {
                    return;
                }
                moveEvent.preventDefault();
                updatePosition(moveEvent.clientX, moveEvent.clientY);
                if (moved && frameId === null) {
                    frameId = window.requestAnimationFrame(renderDragTransform);
                }
            };
            const finish = (finishEvent: PointerEvent) => {
                if (finishEvent.pointerId !== event.pointerId) {
                    return;
                }
                document.removeEventListener('pointermove', move);
                document.removeEventListener('pointerup', finish);
                document.removeEventListener('pointercancel', finish);
                if (finishEvent.type !== 'pointercancel') {
                    updatePosition(finishEvent.clientX, finishEvent.clientY);
                }
                if (frameId !== null) {
                    window.cancelAnimationFrame(frameId);
                    frameId = null;
                }
                if (moved) {
                    renderDragTransform();
                    const nextPosition = { left: latestLeft, top: latestTop };
                    panel.style.left = `${latestLeft}px`;
                    panel.style.top = `${latestTop}px`;
                    panel.style.right = 'auto';
                    panel.style.translate = '0 0';
                    if (panelName === 'playlist') {
                        setPlaylistPosition(nextPosition);
                    } else {
                        setMetricsPosition(nextPosition);
                    }
                }
                if (dragTarget.hasPointerCapture(event.pointerId)) {
                    dragTarget.releasePointerCapture(event.pointerId);
                }
                window.requestAnimationFrame(() => {
                    panel.classList.remove('dragging');
                    window.requestAnimationFrame(() => {
                        panel.style.translate = '';
                    });
                });
                draggedPanelRef.current = moved ? panelName : null;
            };
            document.addEventListener('pointermove', move);
            document.addEventListener('pointerup', finish);
            document.addEventListener('pointercancel', finish);
        },
        []
    );

    const stop = useCallback(() => {
        onStop();
        setPlayState('stopped');
        setStatusMessage('分析已停止，可滚轮回看');
    }, [onStop]);

    const changeAlgorithm = useCallback(
        (event: ChangeEvent<HTMLSelectElement>) => {
            const value = event.target.value as PitchAlgorithm;
            setPitchAlgorithm(value);
            onPitchAlgorithmChange(value);
        },
        [onPitchAlgorithmChange]
    );

    const resetSettingsTab = useCallback(
        (tab: SettingsTab) => {
            if (tab === 'spectrogram') {
                setSensitivity(0.42);
                setContrast(0.32);
                setMinFrequency(0);
                setMaxFrequency(5500);
                setCustomWindowLengthMs(15);
                setWindowFunction('gaussian');
                if (mode === 'broadband') {
                    setBroadbandScale('linear');
                } else if (mode === 'narrowband') {
                    setNarrowbandScale('log');
                } else {
                    setCustomScale('linear');
                }
                setGradientName(uiTheme === 'light' ? 'Praat' : 'Aurora');
                return;
            }
            if (tab === 'waveform') {
                setWaveformThemeName(uiTheme === 'light' ? 'Praat' : 'Aurora');
                setWaveformScaleMode('linear');
                setWaveformReferenceUnit('dbfs');
                setWaveformGainDb(0);
                setWaveformNormalizeRecordingPeak(sourceProfileMode === 'file');
                setWaveformAutoFitView(false);
                setWaveformShowPeak(true);
                setWaveformShowRms(true);
                setWaveformShowPeakHold(false);
                setWaveformShowClipping(true);
                setWaveformLineWidth(1);
                setWaveformZeroLine(true);
                setWaveformPulses(false);
                return;
            }
            if (tab === 'pitch') {
                setPitchAlgorithm('yin');
                setPitchFloor(75);
                setPitchCeiling(500);
                setVoicingThreshold(0.6);
                setPitchLineWidth(2.5);
                setNarrowbandPitchFrequencyAligned(true);
                return;
            }
            if (tab === 'formants') {
                setMaximumFormants(5);
                setFormantsToDisplay(5);
                setFormantCeiling(5500);
                setFormantWindowMs(25);
                setPreEmphasisFrom(50);
                setFormantDynamicRange(30);
                setFormantDotSize(2.4);
                return;
            }
            if (tab === 'performance') {
                setFramesPerSecond(30);
                setGlassEffect(true);
                setRenderPixelRatio(1.5);
                setAnalysisPrecision(sourceProfileMode === 'live' ? 'balanced' : 'accurate');
                return;
            }
            setIntensityPitchFloor(75);
            setIntensityFloor(50);
            setIntensityCeiling(100);
            setIntensityLineWidth(2.5);
            setSplCalibration(0);
        },
        [mode, setGradientName, setWaveformThemeName, sourceProfileMode, uiTheme]
    );

    const toggleFullscreen = useCallback(() => {
        if (document.fullscreenElement) {
            document.exitFullscreen();
        } else {
            document.documentElement.requestFullscreen();
        }
    }, []);

    const selectedGradient = GRADIENTS.find((item) => item.name === gradientName);
    const activeWindowLengthMs =
        mode === 'broadband' ? 5 : mode === 'narrowband' ? 30 : customWindowLengthMs;
    const selectedFormantIndex =
        selectedMetric.indexOf('formant') === 0
            ? Number(selectedMetric.replace('formant', '')) - 1
            : -1;
    const collapsedMetric =
        selectedMetric === 'pitch'
            ? {
                  label: 'F0',
                  value: snapshot.pitchHz,
                  unit: 'Hz',
                  color: 'pitch',
                  digits: 1,
              }
            : selectedMetric === 'intensity'
            ? {
                  label: tr('音强'),
                  value: snapshot.intensityDbSpl,
                  unit: 'dB',
                  color: 'intensity',
                  digits: 1,
              }
            : {
                  label: `F${selectedFormantIndex + 1}`,
                  value: snapshot.formantsHz[selectedFormantIndex] ?? null,
                  unit: 'Hz',
                  color: 'formant',
                  digits: 0,
              };
    const clampCursorBubbleTop = (top: string) => `clamp(12px, ${top}, calc(100% - 12px))`;
    const cursorAxisTop =
        cursor === null
            ? undefined
            : {
                  top: clampCursorBubbleTop(`${(cursor.y * 100).toFixed(3)}%`),
              };
    const pitchUsesFrequencyAxis = mode === 'narrowband' && narrowbandPitchFrequencyAligned;
    const pitchAxisTop = (frequency: number) => {
        const ratio = pitchUsesFrequencyAxis
            ? (frequencyToScale(frequency, scale) - frequencyToScale(minFrequency, scale)) /
              Math.max(
                  1e-9,
                  frequencyToScale(maxFrequency, scale) - frequencyToScale(minFrequency, scale)
              )
            : (frequency - pitchFloor) / Math.max(1e-9, pitchCeiling - pitchFloor);
        return `${(1 - Math.min(1, Math.max(0, ratio))) * 100}%`;
    };
    const cursorPitchCoordinate = cursor?.pitchHz ?? null;
    const cursorPitchAxisTop =
        cursorPitchCoordinate === null
            ? undefined
            : { top: clampCursorBubbleTop(pitchAxisTop(cursorPitchCoordinate)) };
    const cursorIntensityCoordinate = cursor?.intensityDbSpl ?? null;
    const splUnitLabel = splCalibration === 0 ? 'dB SPL*' : 'dB SPL';
    const cursorIntensityAxisTop =
        cursorIntensityCoordinate === null
            ? undefined
            : {
                  top: clampCursorBubbleTop(
                      `${(
                          (1 -
                              Math.min(
                                  1,
                                  Math.max(
                                      0,
                                      (cursorIntensityCoordinate - intensityFloor) /
                                          Math.max(1e-9, intensityCeiling - intensityFloor)
                                  )
                              )) *
                          100
                      ).toFixed(3)}%`
                  ),
              };
    const waveformAxisGain = Math.max(1e-9, waveformAxisState.amplitudeUnitGain);
    const waveformContentReferenceDb =
        20 * Math.log10(Math.max(1e-9, waveformAxisState.amplitudeReference));
    const waveformInputAtDisplayLevel = (displayLevel: number) =>
        (waveformScaleMode === 'logarithmic' ? expandAmplitude(displayLevel) : displayLevel) /
        waveformAxisGain;
    const formatAxisAmplitude = (amplitude: number) =>
        amplitude >= 0.01 ? amplitude.toFixed(2) : amplitude.toExponential(1);
    const waveformAxisMarks = [
        {
            top: 2,
            label: `+${formatAxisAmplitude(waveformInputAtDisplayLevel(1))}`,
        },
        {
            top: 26,
            label: `+${formatAxisAmplitude(waveformInputAtDisplayLevel(0.5))}`,
        },
        { top: 50, label: '0' },
        {
            top: 74,
            label: `−${formatAxisAmplitude(waveformInputAtDisplayLevel(0.5))}`,
        },
        {
            top: 98,
            label: `−${formatAxisAmplitude(waveformInputAtDisplayLevel(1))}`,
        },
    ];
    const formatWaveformReference = (amplitude: number, includeUnit: boolean = false) => {
        const rawAmplitude = amplitude * waveformAxisState.amplitudeReference;
        let decibels = 20 * Math.log10(Math.max(1e-12, rawAmplitude));
        let unit = 'dBFS';
        if (waveformReferenceUnit === 'dbspl') {
            decibels = amplitudeToDbspl(rawAmplitude, splCalibration);
            unit = splUnitLabel;
        }
        return {
            value: `${decibels > 0 ? '+' : decibels < 0 ? '−' : ''}${Math.abs(decibels).toFixed(
                1
            )}`,
            unit: includeUnit ? unit : undefined,
        };
    };
    const waveformReferenceMarks =
        waveformReferenceUnit === 'none'
            ? []
            : [
                  {
                      top: 2,
                      label: formatWaveformReference(waveformInputAtDisplayLevel(1), true),
                  },
                  {
                      top: 26,
                      label: formatWaveformReference(waveformInputAtDisplayLevel(0.5)),
                  },
                  { top: 50, label: { value: '−∞', unit: undefined } },
                  {
                      top: 74,
                      label: formatWaveformReference(waveformInputAtDisplayLevel(0.5)),
                  },
                  {
                      top: 98,
                      label: formatWaveformReference(waveformInputAtDisplayLevel(1), true),
                  },
              ];
    const maximumTimeOffset = Math.max(0, 1 - 1 / Math.max(1, zoom));
    const scrollbarThumbWidth = 100 / Math.max(1, zoom);
    const scrollbarThumbLeft =
        maximumTimeOffset <= 0
            ? 0
            : (1 - timeOffset / maximumTimeOffset) * (100 - scrollbarThumbWidth);
    const playheadRatio =
        transport.activeId === null || transport.viewEndSeconds <= transport.viewStartSeconds
            ? null
            : (transport.currentSeconds - transport.viewStartSeconds) /
              (transport.viewEndSeconds - transport.viewStartSeconds);
    const playheadStyle =
        playheadRatio !== null && playheadRatio >= 0 && playheadRatio <= 1
            ? { left: `${playheadRatio * 100}%` }
            : undefined;
    useLayoutEffect(() => {
        const tooltip = cursorTooltipRef.current;
        if (cursor === null || tooltip === null) {
            return undefined;
        }
        const stage = tooltip.parentElement;
        if (stage === null) {
            return undefined;
        }

        const positionTooltip = () => {
            const edge = 8;
            const gap = 12;
            const stageWidth = stage.clientWidth;
            const stageHeight = stage.clientHeight;
            const tooltipWidth = tooltip.offsetWidth;
            const tooltipHeight = tooltip.offsetHeight;
            const anchorX = cursor.x * stageWidth;
            const anchorY = cursor.y * stageHeight;
            const preferredLeft = anchorX + gap;
            const preferredTop = anchorY + gap;
            const left =
                preferredLeft + tooltipWidth <= stageWidth - edge
                    ? preferredLeft
                    : anchorX - tooltipWidth - gap;
            const top =
                preferredTop + tooltipHeight <= stageHeight - edge
                    ? preferredTop
                    : anchorY - tooltipHeight - gap;
            tooltip.style.left = `${Math.min(
                Math.max(edge, left),
                Math.max(edge, stageWidth - tooltipWidth - edge)
            )}px`;
            tooltip.style.top = `${Math.min(
                Math.max(edge, top),
                Math.max(edge, stageHeight - tooltipHeight - edge)
            )}px`;
        };

        positionTooltip();
        const observer = new ResizeObserver(positionTooltip);
        observer.observe(stage);
        observer.observe(tooltip);
        return () => observer.disconnect();
    }, [cursor, locale, selection]);
    const navigateScrollbar = useCallback(
        (clientX: number, track: HTMLDivElement) => {
            if (zoom <= 1 || maximumTimeOffset <= 0) {
                return;
            }
            const bounds = track.getBoundingClientRect();
            const thumbWidth = bounds.width / zoom;
            const availableWidth = Math.max(1, bounds.width - thumbWidth);
            const position = Math.min(
                1,
                Math.max(0, (clientX - bounds.left - thumbWidth / 2) / availableWidth)
            );
            const targetOffset = (1 - position) * maximumTimeOffset;
            onNavigate(targetOffset - timeOffset);
        },
        [maximumTimeOffset, onNavigate, timeOffset, zoom]
    );
    const plotGridRows =
        waveformVisible && spectrogramVisible
            ? `${waveformShare}fr 8px ${1 - waveformShare}fr`
            : 'minmax(0, 1fr)';

    useLayoutEffect(() => {
        const root = axisViewRef.current;
        if (root === null) {
            return undefined;
        }

        let animationFrame = 0;
        const updateTitleVisibility = () => {
            const collisionGap = 3;
            root.querySelectorAll<HTMLElement>('.axis, .waveform-axis').forEach((axis) => {
                const labels = Array.from(axis.querySelectorAll<HTMLElement>('[data-axis-label]'));
                labels.forEach((label) => label.classList.remove('axis-title-hidden'));

                const axisBox = axis.getBoundingClientRect();
                const acceptedBoxes: DOMRect[] = [];
                labels
                    .sort(
                        (left, right) =>
                            Number(right.dataset.axisPriority || 0) -
                            Number(left.dataset.axisPriority || 0)
                    )
                    .forEach((label) => {
                        const labelBox = label.getBoundingClientRect();
                        const outsideVertically =
                            labelBox.top < axisBox.top - 1 || labelBox.bottom > axisBox.bottom + 1;
                        const overlaps = acceptedBoxes.some(
                            (box) =>
                                labelBox.left < box.right + collisionGap &&
                                labelBox.right + collisionGap > box.left &&
                                labelBox.top < box.bottom + collisionGap &&
                                labelBox.bottom + collisionGap > box.top
                        );
                        const hidden = outsideVertically || overlaps;
                        label.classList.toggle('axis-title-hidden', hidden);
                        if (!hidden) {
                            acceptedBoxes.push(labelBox);
                        }
                    });
            });
        };
        const scheduleUpdate = () => {
            window.cancelAnimationFrame(animationFrame);
            animationFrame = window.requestAnimationFrame(updateTitleVisibility);
        };
        const resizeObserver =
            typeof ResizeObserver === 'undefined'
                ? null
                : new ResizeObserver(updateTitleVisibility);
        resizeObserver?.observe(root);
        root.querySelectorAll<HTMLElement>('.axis, .waveform-axis').forEach((axis) => {
            resizeObserver?.observe(axis);
        });
        window.addEventListener('resize', scheduleUpdate);
        updateTitleVisibility();

        return () => {
            window.cancelAnimationFrame(animationFrame);
            resizeObserver?.disconnect();
            window.removeEventListener('resize', scheduleUpdate);
        };
    }, [
        intensityCeiling,
        intensityFloor,
        locale,
        maxFrequency,
        minFrequency,
        pitchCeiling,
        pitchFloor,
        pitchUsesFrequencyAxis,
        cursor?.frequencyHz,
        cursorIntensityCoordinate,
        cursorPitchCoordinate,
        scale,
        spectrogramVisible,
        waveformScaleMode,
        waveformShare,
        waveformVisible,
    ]);

    return (
        <div className="app-shell">
            <header className="topbar">
                <div className="brand">
                    <span className="brand-mark" aria-hidden="true">
                        <i />
                        <i />
                        <i />
                        <i />
                        <i />
                    </span>
                    <div>
                        <strong>Spectro</strong>
                        <span>PRO</span>
                    </div>
                </div>

                <div className="source-status">
                    <span className={`status-dot ${playState}`} />
                    <div>
                        <strong>{tr(localizedSourceName)}</strong>
                        <span>{tr(statusMessage)}</span>
                    </div>
                </div>

                <div className="session-clock">
                    <span>{tr('会话时间')}</span>
                    <strong>{formatTime(snapshot.elapsedSeconds)}</strong>
                </div>

                <div className={`top-actions ${transport.activeId !== null ? 'has-playback' : ''}`}>
                    <input
                        ref={fileRef}
                        type="file"
                        accept="audio/*"
                        multiple
                        onChange={loadFile}
                        hidden
                    />
                    <button
                        className="button secondary"
                        onClick={chooseFile}
                        disabled={playState !== 'stopped'}
                    >
                        <CloudUploadIcon aria-hidden="true" />
                        <span className="button-label">{tr('导入音频')}</span>
                    </button>
                    <button
                        className={`button secondary ${playlistOpen ? 'active' : ''}`}
                        onClick={() => setPlaylistOpen(!playlistOpen)}
                    >
                        <QueueMusicIcon aria-hidden="true" />
                        <span className="button-label">{tr('播放列表')}</span>
                    </button>
                    <button
                        className={`button secondary ${metricsOpen ? 'active' : ''}`}
                        onClick={() => {
                            setMetricsOpen(!metricsOpen);
                            setMetricsCollapsed(false);
                        }}
                        aria-pressed={metricsOpen}
                    >
                        <AssessmentOutlinedIcon aria-hidden="true" />
                        <span className="button-label">{tr('声学概览')}</span>
                    </button>
                    <div className="session-actions">
                        {playState === 'playing' && transport.activeId === null ? (
                            <button className="button danger" onClick={stop}>
                                <StopIcon aria-hidden="true" />
                                {tr('停止')}
                            </button>
                        ) : (
                            <button
                                className="button primary"
                                onClick={() => {
                                    setPlayState('loading-mic');
                                    onStartMicrophone();
                                }}
                                disabled={playState !== 'stopped'}
                            >
                                <span className="record-icon" />
                                <span className="button-label">{tr('麦克风')}</span>
                            </button>
                        )}
                        {transport.activeId !== null && (
                            <button
                                className={`button playback-button ${
                                    transport.isPlaying ? 'pause' : 'play'
                                }`}
                                onClick={onToggleMediaPlayback}
                                aria-label={tr(transport.isPlaying ? '暂停' : '播放')}
                                title={tr(transport.isPlaying ? '暂停' : '播放')}
                            >
                                {transport.isPlaying ? (
                                    <svg viewBox="0 0 24 24" aria-hidden="true">
                                        <path d="M7 5h4v14H7zM13 5h4v14h-4z" />
                                    </svg>
                                ) : (
                                    <svg viewBox="0 0 24 24" aria-hidden="true">
                                        <path d="M8 5v14l11-7z" />
                                    </svg>
                                )}
                                <span className="button-label">
                                    {tr(transport.isPlaying ? '暂停' : '播放')}
                                </span>
                            </button>
                        )}
                        <button
                            className="icon-button theme-button"
                            onClick={() => setUiTheme(uiTheme === 'dark' ? 'light' : 'dark')}
                            aria-label={tr(
                                uiTheme === 'dark' ? '切换到浅色模式' : '切换到深色模式'
                            )}
                            title={tr(uiTheme === 'dark' ? '切换到浅色模式' : '切换到深色模式')}
                            aria-pressed={uiTheme === 'light'}
                        >
                            {uiTheme === 'dark' ? (
                                <Brightness7Icon aria-hidden="true" />
                            ) : (
                                <Brightness4Icon aria-hidden="true" />
                            )}
                        </button>
                        <div className="language-control" ref={languageRef}>
                            <button
                                className="icon-button language-button"
                                onClick={() => setLanguageMenuOpen(!languageMenuOpen)}
                                aria-label={tr('选择语言')}
                                title={tr('选择语言')}
                                aria-haspopup="menu"
                                aria-expanded={languageMenuOpen}
                            >
                                <LanguageIcon aria-hidden="true" />
                            </button>
                            {languageMenuOpen && (
                                <div className="language-menu" role="menu">
                                    <button
                                        role="menuitemradio"
                                        aria-checked={locale === 'zh'}
                                        className={locale === 'zh' ? 'active' : ''}
                                        onClick={() => chooseLocale('zh')}
                                    >
                                        中文
                                    </button>
                                    <button
                                        role="menuitemradio"
                                        aria-checked={locale === 'en'}
                                        className={locale === 'en' ? 'active' : ''}
                                        onClick={() => chooseLocale('en')}
                                    >
                                        English
                                    </button>
                                </div>
                            )}
                        </div>
                        <button
                            className="icon-button"
                            onClick={() => setSettingsOpen(!settingsOpen)}
                            aria-label={tr('显示设置')}
                            title={tr('显示设置')}
                        >
                            <span className="sliders-icon" />
                        </button>
                    </div>
                </div>
            </header>

            <main className="workspace">
                <aside
                    ref={playlistRef}
                    className={`media-panel ${playlistOpen ? 'open' : ''} ${
                        playlistCollapsed ? 'collapsed' : ''
                    }`}
                    style={
                        playlistPosition
                            ? {
                                  left: playlistPosition.left,
                                  top: playlistPosition.top,
                              }
                            : undefined
                    }
                >
                    <div className="media-panel-heading">
                        <div
                            className="panel-drag-handle"
                            onPointerDown={(event) => beginFloatingDrag('playlist', event)}
                        >
                            <span className="eyebrow">MEDIA LIBRARY</span>
                            <strong>
                                <QueueMusicIcon
                                    className="playlist-heading-icon"
                                    aria-hidden="true"
                                />
                                {tr('播放列表')}
                                <small>{mediaItems.length}</small>
                            </strong>
                        </div>
                        <div className="media-panel-actions">
                            <button
                                className="clear-playlist"
                                onClick={onClearPlaylist}
                                disabled={mediaItems.length === 0}
                                aria-label={tr('清空播放列表')}
                                title={tr('清空播放列表')}
                            >
                                <DeleteSweepIcon aria-hidden="true" />
                            </button>
                            <button
                                onClick={() => setPlaylistCollapsed(!playlistCollapsed)}
                                aria-label={tr(playlistCollapsed ? '展开播放列表' : '收起播放列表')}
                                title={tr(playlistCollapsed ? '展开列表' : '收起列表')}
                            >
                                {playlistCollapsed ? (
                                    <AddIcon aria-hidden="true" />
                                ) : (
                                    <RemoveIcon aria-hidden="true" />
                                )}
                            </button>
                            <button
                                onClick={() => setPlaylistOpen(false)}
                                aria-label={tr('关闭播放列表')}
                                title={tr('关闭播放列表')}
                            >
                                <CloseIcon aria-hidden="true" />
                            </button>
                        </div>
                    </div>
                    <button
                        className={`media-row microphone ${activeMediaId === null ? 'active' : ''}`}
                        onClick={() => onSelectMedia(null)}
                    >
                        <span className="media-kind">LIVE</span>
                        <span className="media-copy">
                            <strong>{tr('麦克风')}</strong>
                            <small>{tr('始终置顶 · 结束后生成录音分段')}</small>
                        </span>
                        <i className={`status-dot ${playState}`} />
                    </button>
                    <div className="media-list">
                        {mediaItems.length === 0 ? (
                            <p className="media-empty">
                                {tr('导入音频或录制一段声音后，会保留在这里。')}
                            </p>
                        ) : (
                            mediaItems.map((item) => (
                                <div
                                    className={`media-row ${
                                        activeMediaId === item.id ? 'active' : ''
                                    }`}
                                    key={item.id}
                                >
                                    <button
                                        className="media-select"
                                        onClick={() => onSelectMedia(item.id)}
                                        onDoubleClick={() => {
                                            const nextName = window.prompt(tr('重命名'), item.name);
                                            if (nextName?.trim()) {
                                                onRenameMedia(item.id, nextName.trim());
                                            }
                                        }}
                                    >
                                        <span className="media-kind">
                                            {item.type === 'recording' ? 'REC' : 'FILE'}
                                        </span>
                                        <span className="media-copy">
                                            <strong>{item.name}</strong>
                                            <small>
                                                {item.state === 'analyzing'
                                                    ? tr('正在分析…')
                                                    : item.state === 'error'
                                                    ? tr('分析失败')
                                                    : `${formatTime(item.durationSeconds)} · ${tr(
                                                          '双击重命名'
                                                      )}`}
                                            </small>
                                        </span>
                                    </button>
                                    {item.type === 'recording' && (
                                        <button
                                            className="media-save"
                                            onClick={() => onSaveMedia(item.id)}
                                            title={tr('保存WAV')}
                                        >
                                            <SaveAltIcon aria-hidden="true" />
                                        </button>
                                    )}
                                    <button
                                        className="media-remove"
                                        onClick={() => onRemoveMedia(item.id)}
                                        title={tr('从播放列表移除')}
                                        aria-label={`${tr('移除')} ${item.name}`}
                                    >
                                        <DeleteOutlineIcon aria-hidden="true" />
                                    </button>
                                </div>
                            ))
                        )}
                    </div>
                </aside>
                <section className="visualizer-card">
                    <div className="visualizer-toolbar">
                        <div className="mode-switch" aria-label={tr('语谱类型')}>
                            <button
                                className={mode === 'broadband' ? 'active' : ''}
                                onClick={() => changeMode('broadband')}
                            >
                                <strong>{tr('宽带')}</strong>
                                <span>5 ms</span>
                            </button>
                            <button
                                className={mode === 'narrowband' ? 'active' : ''}
                                onClick={() => changeMode('narrowband')}
                            >
                                <strong>{tr('窄带')}</strong>
                                <span>30 ms</span>
                            </button>
                            <button
                                className={mode === 'custom' ? 'active' : ''}
                                onClick={() => changeMode('custom')}
                            >
                                <strong>{tr('自定义')}</strong>
                                <span>{customWindowLengthMs} ms</span>
                            </button>
                        </div>

                        <div className="toolbar-center">
                            <div className="plot-toggles" aria-label={tr('图层显示')}>
                                <button
                                    className={waveformVisible ? 'on waveform' : ''}
                                    onClick={() => {
                                        if (!waveformVisible || spectrogramVisible) {
                                            setWaveformVisible(!waveformVisible);
                                        }
                                    }}
                                    aria-pressed={waveformVisible}
                                    title={tr('显示或隐藏波形')}
                                >
                                    <i /> <span className="toggle-label">{tr('波形')}</span>
                                </button>
                                <button
                                    className={spectrogramVisible ? 'on spectrogram' : ''}
                                    onClick={() => {
                                        if (!spectrogramVisible || waveformVisible) {
                                            setSpectrogramVisible(!spectrogramVisible);
                                        }
                                    }}
                                    aria-pressed={spectrogramVisible}
                                    title={tr('显示或隐藏语谱图')}
                                >
                                    <i /> <span className="toggle-label">{tr('语谱图')}</span>
                                </button>
                            </div>
                            <div className="overlay-toggles">
                                <button
                                    className={pitchVisible ? 'on pitch' : ''}
                                    onClick={() => setPitchVisible(!pitchVisible)}
                                >
                                    <i /> <span className="toggle-label">{tr('基频')}</span>
                                </button>
                                <button
                                    className={formantsVisible ? 'on formants' : ''}
                                    onClick={() => setFormantsVisible(!formantsVisible)}
                                >
                                    <i /> <span className="toggle-label">{tr('共振峰')}</span>
                                </button>
                                <button
                                    className={intensityVisible ? 'on intensity' : ''}
                                    onClick={() => setIntensityVisible(!intensityVisible)}
                                >
                                    <i /> <span className="toggle-label">{tr('音强')}</span>
                                </button>
                            </div>
                        </div>

                        <div className="view-actions">
                            <button
                                onClick={() => {
                                    const nextZoom = Math.max(1, zoom - 0.5);
                                    setZoom(nextZoom);
                                    onDisplayChange({ zoom: nextZoom });
                                }}
                                aria-label={tr('缩小')}
                            >
                                −
                            </button>
                            <span className="zoom-readout">{zoom.toFixed(1)}×</span>
                            <button
                                onClick={() => {
                                    const nextZoom = Math.min(64, zoom + 0.5);
                                    setZoom(nextZoom);
                                    onDisplayChange({ zoom: nextZoom });
                                }}
                                aria-label={tr('放大')}
                            >
                                +
                            </button>
                            {transport.activeId !== null && (
                                <>
                                    <button
                                        onClick={onFitSelection}
                                        className="icon-action view-level-action"
                                        disabled={selection === null}
                                        aria-label={tr('扩选')}
                                        title={
                                            selection === null
                                                ? tr('先在语谱图中拖动选择一段音频')
                                                : tr('让选区扩展至铺满语谱图')
                                        }
                                    >
                                        <ZoomOutMapIcon aria-hidden="true" />
                                        <span>{tr('扩选')}</span>
                                    </button>
                                    <button
                                        onClick={onReturnView}
                                        className="icon-action view-level-action"
                                        disabled={!returnViewAvailable}
                                        aria-label={tr('返回')}
                                        title={tr('返回扩选前的视图')}
                                    >
                                        <UndoIcon aria-hidden="true" />
                                        <span>{tr('返回')}</span>
                                    </button>
                                    <button
                                        onClick={onRestoreView}
                                        className="icon-action view-level-action"
                                        disabled={zoom <= 1}
                                        aria-label={tr('全部')}
                                        title={tr('显示完整语谱图至 1×')}
                                    >
                                        <ViewArrayIcon aria-hidden="true" />
                                        <span>{tr('全部')}</span>
                                    </button>
                                </>
                            )}
                            <button
                                onClick={onExport}
                                className="icon-action"
                                aria-label={tr('导出图片')}
                                title={tr('导出图片')}
                            >
                                <svg viewBox="0 0 24 24" aria-hidden="true">
                                    <path d="M12 3v11m0 0 4-4m-4 4-4-4M5 16v4h14v-4" />
                                </svg>
                            </button>
                            <button
                                onClick={toggleFullscreen}
                                className="icon-action"
                                aria-label={tr('全屏')}
                                title={tr('全屏')}
                            >
                                <svg viewBox="0 0 24 24" aria-hidden="true">
                                    <path d="M8 4H4v4M16 4h4v4M8 20H4v-4m12 4h4v-4" />
                                </svg>
                            </button>
                        </div>
                    </div>

                    <div ref={axisViewRef} className="praat-view">
                        <div className="axis-stack">
                            <div className="axis-plots" style={{ gridTemplateRows: plotGridRows }}>
                                {waveformVisible && (
                                    <div className="waveform-axis waveform-axis-left">
                                        {waveformReferenceMarks.map((mark, index) => (
                                            <span
                                                key={`${mark.label.value}-${
                                                    mark.label.unit ?? ''
                                                }-${index}`}
                                                className={`waveform-scale-mark${
                                                    mark.label.unit
                                                        ? ' waveform-scale-mark-unit'
                                                        : ''
                                                }`}
                                                data-axis-label
                                                data-axis-priority={mark.top === 50 ? '20' : '80'}
                                                style={{
                                                    top: `${mark.top}%`,
                                                    transform:
                                                        mark.top === 2
                                                            ? undefined
                                                            : mark.top === 98
                                                            ? 'translateY(-100%)'
                                                            : 'translateY(-50%)',
                                                }}
                                            >
                                                <b>{mark.label.value}</b>
                                                {mark.label.unit && (
                                                    <small>{mark.label.unit}</small>
                                                )}
                                            </span>
                                        ))}
                                    </div>
                                )}
                                {waveformVisible && spectrogramVisible && (
                                    <div className="axis-divider-space" />
                                )}
                                {spectrogramVisible && (
                                    <div className="axis axis-left">
                                        <span
                                            className="axis-title pitch-color"
                                            data-axis-title
                                            data-axis-label
                                            data-axis-priority="60"
                                        >
                                            {tr('基频')}
                                        </span>
                                        {cursor !== null && cursorPitchCoordinate !== null && (
                                            <span
                                                className="axis-cursor-value pitch"
                                                data-axis-label
                                                data-axis-priority="100"
                                                style={cursorPitchAxisTop}
                                            >
                                                {cursorPitchCoordinate.toFixed(1)} Hz
                                            </span>
                                        )}
                                        <span
                                            className={`spectral-pitch-mark pitch-color ${
                                                pitchUsesFrequencyAxis ? 'aligned' : 'scale-top'
                                            }`}
                                            data-axis-label
                                            data-axis-priority="80"
                                            style={
                                                pitchUsesFrequencyAxis
                                                    ? { top: pitchAxisTop(pitchCeiling) }
                                                    : undefined
                                            }
                                        >
                                            {pitchCeiling} Hz
                                        </span>
                                        <span
                                            className={`spectral-pitch-mark pitch-color ${
                                                pitchUsesFrequencyAxis ? 'aligned' : 'scale-mid'
                                            }`}
                                            data-axis-label
                                            data-axis-priority="20"
                                            style={
                                                pitchUsesFrequencyAxis
                                                    ? {
                                                          top: pitchAxisTop(
                                                              (pitchFloor + pitchCeiling) / 2
                                                          ),
                                                      }
                                                    : undefined
                                            }
                                        >
                                            {Math.round((pitchFloor + pitchCeiling) / 2)} Hz
                                        </span>
                                        <span
                                            className={`spectral-pitch-mark pitch-color ${
                                                pitchUsesFrequencyAxis ? 'aligned' : 'scale-bottom'
                                            }`}
                                            data-axis-label
                                            data-axis-priority="80"
                                            style={
                                                pitchUsesFrequencyAxis
                                                    ? { top: pitchAxisTop(pitchFloor) }
                                                    : undefined
                                            }
                                        >
                                            {pitchFloor} Hz
                                        </span>
                                    </div>
                                )}
                            </div>
                            <div className="axis-navigation-space" />
                        </div>

                        <div className="plot-stack">
                            <div
                                ref={plotContainerRef}
                                className="acoustic-plots"
                                style={{ gridTemplateRows: plotGridRows }}
                            >
                                <div
                                    className="waveform-stage"
                                    id="waveformStage"
                                    style={{ display: waveformVisible ? undefined : 'none' }}
                                >
                                    <canvas id="waveformCanvas" />
                                    <canvas
                                        id="waveformInteraction"
                                        data-plot="waveform"
                                        aria-label={tr(
                                            '波形交互区：单击定位，单指拖动选择，双指拖动平移'
                                        )}
                                        onPointerDown={startPlotGesture}
                                        onPointerMove={updatePlotGesture}
                                        onPointerUp={finishPlotGesture}
                                        onPointerCancel={cancelPlotGesture}
                                        onPointerLeave={leavePlot}
                                        onWheel={(event) => {
                                            event.preventDefault();
                                            onNavigate(event.deltaY > 0 ? 0.05 : -0.05);
                                        }}
                                    />
                                    {playheadStyle && (
                                        <div
                                            className="inverted-playhead"
                                            style={playheadStyle}
                                            aria-hidden="true"
                                        />
                                    )}
                                </div>
                                {waveformVisible && spectrogramVisible && (
                                    <div
                                        className="plot-divider"
                                        role="separator"
                                        aria-label={tr('调整波形和语谱图高度')}
                                        aria-orientation="horizontal"
                                        onPointerDown={beginPlotResize}
                                    >
                                        <span />
                                    </div>
                                )}
                                <div
                                    className="spectrogram-stage"
                                    id="spectrogramStage"
                                    data-theme={gradientName.toLowerCase()}
                                    style={{ display: spectrogramVisible ? undefined : 'none' }}
                                >
                                    <canvas id="spectrogramCanvas" />
                                    <canvas
                                        id="analysisOverlay"
                                        data-plot="spectrogram"
                                        aria-label={tr(
                                            '语谱图交互区：单击定位并显示坐标，单指拖动选择，双指拖动平移'
                                        )}
                                        onPointerDown={startPlotGesture}
                                        onPointerMove={updatePlotGesture}
                                        onPointerUp={finishPlotGesture}
                                        onPointerCancel={cancelPlotGesture}
                                        onPointerLeave={leavePlot}
                                        onWheel={(event) => {
                                            event.preventDefault();
                                            onNavigate(event.deltaY > 0 ? 0.05 : -0.05);
                                        }}
                                    />
                                    {playheadStyle && (
                                        <div
                                            className="inverted-playhead"
                                            style={playheadStyle}
                                            aria-hidden="true"
                                        />
                                    )}
                                    <div className="plot-grid" aria-hidden="true">
                                        <i />
                                        <i />
                                        <i />
                                        <i />
                                    </div>
                                    {cursor && (
                                        <div
                                            ref={cursorTooltipRef}
                                            className="cursor-tooltip"
                                            style={{ left: 8, top: 8 }}
                                        >
                                            <strong>{cursor.timeSeconds.toFixed(3)} s</strong>
                                            <span>{cursor.frequencyHz.toFixed(0)} Hz</span>
                                            {cursor.pitchHz !== null && (
                                                <span className="tooltip-pitch">
                                                    F0 {cursor.pitchHz.toFixed(1)} Hz
                                                </span>
                                            )}
                                            {cursor.intensityDbSpl !== null && (
                                                <span className="tooltip-intensity">
                                                    {cursor.intensityDbSpl.toFixed(1)}{' '}
                                                    {splUnitLabel}
                                                </span>
                                            )}
                                            {selection && (
                                                <span className="tooltip-selection">
                                                    <span className="selection-duration">
                                                        {selection.durationSeconds.toFixed(1)} s
                                                    </span>
                                                    <span className="selection-range">
                                                        {' '}
                                                        ({selection.startSeconds.toFixed(1)}–
                                                        {selection.endSeconds.toFixed(1)} s)
                                                    </span>
                                                </span>
                                            )}
                                        </div>
                                    )}
                                </div>
                            </div>

                            <div className="plot-navigation">
                                {zoom > 1 && (
                                    <div
                                        className="zoom-scrollbar"
                                        role="scrollbar"
                                        aria-label={tr('放大后的图形滚动位置')}
                                        aria-orientation="horizontal"
                                        aria-valuemin={0}
                                        aria-valuemax={maximumTimeOffset}
                                        aria-valuenow={timeOffset}
                                        tabIndex={0}
                                        title={tr('拖动查看放大后未显示的音频')}
                                        onKeyDown={(event) => {
                                            const step = maximumTimeOffset / 20;
                                            if (event.key === 'ArrowLeft') {
                                                event.preventDefault();
                                                onNavigate(
                                                    Math.min(maximumTimeOffset, timeOffset + step) -
                                                        timeOffset
                                                );
                                            } else if (event.key === 'ArrowRight') {
                                                event.preventDefault();
                                                onNavigate(
                                                    Math.max(0, timeOffset - step) - timeOffset
                                                );
                                            } else if (event.key === 'Home') {
                                                event.preventDefault();
                                                onNavigate(maximumTimeOffset - timeOffset);
                                            } else if (event.key === 'End') {
                                                event.preventDefault();
                                                onNavigate(-timeOffset);
                                            }
                                        }}
                                        onPointerDown={(event) => {
                                            event.currentTarget.setPointerCapture(event.pointerId);
                                            navigateScrollbar(event.clientX, event.currentTarget);
                                        }}
                                        onPointerMove={(event) => {
                                            if (
                                                event.currentTarget.hasPointerCapture(
                                                    event.pointerId
                                                )
                                            ) {
                                                navigateScrollbar(
                                                    event.clientX,
                                                    event.currentTarget
                                                );
                                            }
                                        }}
                                    >
                                        <span
                                            className="zoom-scrollbar-thumb"
                                            style={{
                                                width: `${scrollbarThumbWidth}%`,
                                                left: `${scrollbarThumbLeft}%`,
                                            }}
                                        />
                                    </div>
                                )}
                            </div>
                        </div>

                        <div className="axis-stack">
                            <div className="axis-plots" style={{ gridTemplateRows: plotGridRows }}>
                                {waveformVisible && (
                                    <div className="waveform-axis waveform-axis-right">
                                        {waveformAxisMarks.map((mark, index) => (
                                            <span
                                                key={`${mark.label}-${index}`}
                                                className="waveform-scale-mark"
                                                data-axis-label
                                                data-axis-priority={mark.top === 50 ? '20' : '80'}
                                                style={{
                                                    top: `${mark.top}%`,
                                                    transform:
                                                        mark.top === 2
                                                            ? undefined
                                                            : mark.top === 98
                                                            ? 'translateY(-100%)'
                                                            : 'translateY(-50%)',
                                                }}
                                            >
                                                {mark.label}
                                            </span>
                                        ))}
                                    </div>
                                )}
                                {waveformVisible && spectrogramVisible && (
                                    <div className="axis-divider-space" />
                                )}
                                {spectrogramVisible && (
                                    <div className="axis axis-right">
                                        <span
                                            className="axis-title intensity-axis-title intensity-color"
                                            data-axis-title
                                            data-axis-label
                                            data-axis-priority="60"
                                        >
                                            {tr('音强')}
                                        </span>
                                        <span
                                            className="axis-title frequency-axis-title"
                                            data-axis-title
                                            data-axis-label
                                            data-axis-priority="60"
                                        >
                                            {tr('频率')}
                                        </span>
                                        {cursor && (
                                            <>
                                                <span
                                                    className="axis-cursor-value frequency"
                                                    data-axis-label
                                                    data-axis-priority="100"
                                                    style={cursorAxisTop}
                                                >
                                                    {cursor.frequencyHz.toFixed(1)} Hz
                                                </span>
                                                {cursorIntensityCoordinate !== null && (
                                                    <span
                                                        className="axis-cursor-value intensity"
                                                        data-axis-label
                                                        data-axis-priority="100"
                                                        style={cursorIntensityAxisTop}
                                                    >
                                                        {cursorIntensityCoordinate.toFixed(1)} dB
                                                        SPL*
                                                    </span>
                                                )}
                                            </>
                                        )}
                                        <span
                                            className="top"
                                            data-axis-label
                                            data-axis-priority="80"
                                        >
                                            {maxFrequency} Hz
                                        </span>
                                        <span
                                            className="spl-top scale-top intensity-color"
                                            data-axis-label
                                            data-axis-priority="80"
                                        >
                                            {intensityCeiling} {splUnitLabel}
                                        </span>
                                        <span
                                            className="spl-mid scale-mid intensity-color"
                                            data-axis-label
                                            data-axis-priority="20"
                                        >
                                            {Math.round((intensityFloor + intensityCeiling) / 2)} dB
                                        </span>
                                        <span
                                            className="spl-bottom scale-bottom intensity-color"
                                            data-axis-label
                                            data-axis-priority="80"
                                        >
                                            {intensityFloor} {splUnitLabel}
                                        </span>
                                        <span
                                            className="bottom"
                                            data-axis-label
                                            data-axis-priority="80"
                                        >
                                            {minFrequency} Hz
                                        </span>
                                    </div>
                                )}
                            </div>
                            <div className="axis-navigation-space" />
                        </div>
                    </div>
                </section>

                {metricsOpen && (
                    <section
                        ref={metricsRef}
                        className={`metrics-panel ${metricsCollapsed ? 'bubble' : ''}`}
                        style={
                            metricsPosition
                                ? {
                                      left: metricsPosition.left,
                                      right: 'auto',
                                      top: metricsPosition.top,
                                  }
                                : undefined
                        }
                    >
                        <button
                            className={`collapsed-reading ${collapsedMetric.color}`}
                            onPointerDown={(event) => beginFloatingDrag('metrics', event)}
                            onClick={() => {
                                if (draggedPanelRef.current === 'metrics') {
                                    draggedPanelRef.current = null;
                                    return;
                                }
                                setMetricsCollapsed(false);
                            }}
                            aria-label={`${collapsedMetric.label} ${formatNumber(
                                collapsedMetric.value,
                                collapsedMetric.digits
                            )} ${collapsedMetric.unit}`}
                            title={tr('展开声学概览')}
                        >
                            <span>{collapsedMetric.label}</span>
                            <strong>
                                {formatNumber(collapsedMetric.value, collapsedMetric.digits)}
                            </strong>
                            <em>{collapsedMetric.unit}</em>
                        </button>
                        <div className="metrics-heading">
                            <div
                                className="metrics-drag-handle"
                                onPointerDown={(event) => beginFloatingDrag('metrics', event)}
                            >
                                <span className="eyebrow">
                                    {tr(
                                        transport.activeId === null ? '实时读数' : '时刻线位置读数'
                                    )}
                                </span>
                                <h2>{tr('声学概览')}</h2>
                            </div>
                            <div className="metrics-heading-actions">
                                {transport.activeId !== null && (
                                    <span className="playhead-time">
                                        {formatTime(transport.currentSeconds)}
                                    </span>
                                )}
                                <span className="sample-rate">
                                    {snapshot.sampleRate
                                        ? `${(snapshot.sampleRate / 1000).toFixed(1)} kHz`
                                        : '— kHz'}
                                </span>
                                <button
                                    onClick={() => setMetricsCollapsed(true)}
                                    aria-label={tr('收起声学概览')}
                                    title={tr('缩成气泡')}
                                >
                                    −
                                </button>
                                <button
                                    onClick={() => setMetricsOpen(false)}
                                    aria-label={tr('关闭声学概览')}
                                    title={tr('关闭声学概览')}
                                >
                                    <CloseIcon aria-hidden="true" />
                                </button>
                            </div>
                        </div>

                        <div className="primary-metrics">
                            <article
                                className={`selectable-metric pitch ${
                                    selectedMetric === 'pitch' ? 'selected' : ''
                                }`}
                                role="button"
                                tabIndex={0}
                                onClick={() => setSelectedMetric('pitch')}
                                onKeyDown={(event) => {
                                    if (event.key === 'Enter' || event.key === ' ') {
                                        event.preventDefault();
                                        setSelectedMetric('pitch');
                                    }
                                }}
                            >
                                <span className="metric-label pitch-color">{tr('基频F0')}</span>
                                <strong>{formatNumber(snapshot.pitchHz, 1)}</strong>
                                <em>Hz</em>
                                <small>{tr('YIN / 自相关实时估计')}</small>
                            </article>
                            <article
                                className={`selectable-metric intensity ${
                                    selectedMetric === 'intensity' ? 'selected' : ''
                                }`}
                                role="button"
                                tabIndex={0}
                                onClick={() => setSelectedMetric('intensity')}
                                onKeyDown={(event) => {
                                    if (event.key === 'Enter' || event.key === ' ') {
                                        event.preventDefault();
                                        setSelectedMetric('intensity');
                                    }
                                }}
                            >
                                <span className="metric-label intensity-color">{tr('音强')}</span>
                                <strong>{formatNumber(snapshot.intensityDbSpl, 1)}</strong>
                                <em>{splUnitLabel}</em>
                                <small>{tr('参考声压 20 μPa')}</small>
                            </article>
                        </div>

                        <div className="formant-metrics">
                            {snapshot.formantsHz.map((value, index) => (
                                <article
                                    key={index}
                                    className={`selectable-metric formant ${
                                        selectedMetric === `formant${index + 1}` ? 'selected' : ''
                                    }`}
                                    role="button"
                                    tabIndex={0}
                                    onClick={() =>
                                        setSelectedMetric(`formant${index + 1}` as MetricSelection)
                                    }
                                    onKeyDown={(event) => {
                                        if (event.key === 'Enter' || event.key === ' ') {
                                            event.preventDefault();
                                            setSelectedMetric(
                                                `formant${index + 1}` as MetricSelection
                                            );
                                        }
                                    }}
                                >
                                    <span>F{index + 1}</span>
                                    <strong>{formatNumber(value)}</strong>
                                    <em>Hz</em>
                                </article>
                            ))}
                        </div>

                        <div className="statistics">
                            <div className="section-label">{tr('当前会话统计')}</div>
                            <dl>
                                <div>
                                    <dt>{tr('平均F0')}</dt>
                                    <dd>{formatNumber(snapshot.meanPitchHz, 1)} Hz</dd>
                                </div>
                                <div>
                                    <dt>{tr('F0范围')}</dt>
                                    <dd>
                                        {formatNumber(snapshot.minPitchHz)}–
                                        {formatNumber(snapshot.maxPitchHz)} Hz
                                    </dd>
                                </div>
                                <div>
                                    <dt>{tr('有声比例')}</dt>
                                    <dd>{snapshot.voicedPercent.toFixed(0)}%</dd>
                                </div>
                                <div>
                                    <dt>{tr('平均音强')}</dt>
                                    <dd>{formatNumber(snapshot.meanIntensityDbSpl, 1)} dB</dd>
                                </div>
                            </dl>
                        </div>

                        <div className="panel-actions">
                            <button onClick={onClear}>
                                <ClearAllIcon aria-hidden="true" />
                                {tr('清空会话')}
                            </button>
                            <button onClick={onExport}>
                                <ImageOutlinedIcon aria-hidden="true" />
                                {tr('保存当前画面')}
                            </button>
                        </div>
                    </section>
                )}
            </main>

            <aside className={`settings-panel ${settingsOpen ? 'open' : ''}`}>
                <div className="settings-header">
                    <div>
                        <span className="eyebrow">{tr('显示设置')}</span>
                        <h2>{tr('调整画面')}</h2>
                    </div>
                    <button onClick={() => setSettingsOpen(false)} aria-label={tr('关闭设置')}>
                        <CloseIcon aria-hidden="true" />
                    </button>
                </div>

                <div className="settings-tabs" role="tablist">
                    {[
                        ['spectrogram', tr('语谱图')],
                        ['waveform', tr('波形')],
                        ['pitch', tr('基频')],
                        ['formants', tr('共振峰')],
                        ['intensity', tr('音强')],
                        ['performance', tr('性能')],
                    ].map(([value, label]) => (
                        <button
                            key={value}
                            role="tab"
                            aria-selected={settingsTab === value}
                            className={settingsTab === value ? 'active' : ''}
                            onClick={() => setSettingsTab(value as SettingsTab)}
                        >
                            {label}
                        </button>
                    ))}
                </div>

                <div className="settings-tab-content">
                    {settingsTab === 'spectrogram' && (
                        <>
                            <button
                                className="reset-tab-button"
                                onClick={() => resetSettingsTab('spectrogram')}
                            >
                                <RestoreIcon aria-hidden="true" />
                                <span>{tr('恢复本页默认参数')}</span>
                            </button>
                            <label className="setting">
                                <span>
                                    {tr('语谱窗口长度')} <em>{activeWindowLengthMs} ms</em>
                                </span>
                                <input
                                    type="range"
                                    min={1}
                                    max={100}
                                    step={1}
                                    value={activeWindowLengthMs}
                                    disabled={mode !== 'custom'}
                                    onChange={(event) =>
                                        setCustomWindowLengthMs(Number(event.target.value))
                                    }
                                />
                                {mode !== 'custom' && (
                                    <small>{tr('选择自定义模式后可调节窗口长度')}</small>
                                )}
                            </label>
                            <div className="select-row one">
                                <label>
                                    {tr('窗口形状')}
                                    <select
                                        value={windowFunction}
                                        onChange={(event) =>
                                            setWindowFunction(
                                                event.target.value as SpectrogramWindowFunction
                                            )
                                        }
                                    >
                                        <option value="rectangular">Square (rectangular)</option>
                                        <option value="hamming">
                                            Hamming (raised sine-squared)
                                        </option>
                                        <option value="bartlett">Bartlett (triangular)</option>
                                        <option value="welch">Welch (parabolic)</option>
                                        <option value="hanning">Hanning (sine-squared)</option>
                                        <option value="gaussian">Gaussian</option>
                                    </select>
                                </label>
                            </div>
                            <label className="setting">
                                <span>
                                    {tr('显示增益')} <em>{Math.round(sensitivity * 100)}%</em>
                                </span>
                                <input
                                    type="range"
                                    min={0}
                                    max={1}
                                    step={0.01}
                                    value={sensitivity}
                                    onChange={(event) => setSensitivity(Number(event.target.value))}
                                />
                            </label>
                            <label className="setting">
                                <span>
                                    {tr('层次对比')} <em>{Math.round(contrast * 100)}%</em>
                                </span>
                                <input
                                    type="range"
                                    min={0}
                                    max={1}
                                    step={0.01}
                                    value={contrast}
                                    onChange={(event) => setContrast(Number(event.target.value))}
                                />
                            </label>
                            <label className="setting">
                                <span>
                                    {tr('显示频率上限')} <em>{maxFrequency} Hz</em>
                                </span>
                                <input
                                    type="range"
                                    min={mode === 'narrowband' ? 600 : 3000}
                                    max={10000}
                                    step={100}
                                    value={maxFrequency}
                                    onChange={(event) =>
                                        setMaxFrequency(Number(event.target.value))
                                    }
                                />
                            </label>
                            <label className="setting">
                                <span>
                                    {tr('显示频率下限')} <em>{minFrequency} Hz</em>
                                </span>
                                <input
                                    type="range"
                                    min={0}
                                    max={Math.min(2000, maxFrequency - 100)}
                                    step={10}
                                    value={minFrequency}
                                    onChange={(event) =>
                                        setMinFrequency(Number(event.target.value))
                                    }
                                />
                            </label>
                            <div className="select-row one">
                                <label>
                                    {tr('频率刻度')}
                                    <select
                                        value={scale}
                                        onChange={(event) => {
                                            const nextScale = event.target.value as Scale;
                                            if (mode === 'broadband') {
                                                setBroadbandScale(nextScale);
                                            } else if (mode === 'narrowband') {
                                                setNarrowbandScale(nextScale);
                                            } else {
                                                setCustomScale(nextScale);
                                            }
                                        }}
                                    >
                                        <option value="linear">{tr('线性')}</option>
                                        <option value="log">{tr('对数')}</option>
                                        <option value="mel">Mel</option>
                                        <option value="bark">Bark</option>
                                        <option value="erb">ERB</option>
                                    </select>
                                </label>
                            </div>
                            <div className="palette-setting">
                                <span>{tr('语谱主题')}</span>
                                <div>
                                    {GRADIENTS.map((item) => (
                                        <button
                                            key={item.name}
                                            aria-label={item.name}
                                            title={item.name}
                                            className={gradientName === item.name ? 'active' : ''}
                                            style={{
                                                background: `linear-gradient(135deg, ${item.gradient
                                                    .map(
                                                        (stop) =>
                                                            `rgb(${stop.color.join(',')}) ${
                                                                stop.stop * 100
                                                            }%`
                                                    )
                                                    .join(',')})`,
                                            }}
                                            onClick={() => setGradientName(item.name)}
                                        />
                                    ))}
                                </div>
                                <small>{selectedGradient?.name}</small>
                            </div>
                            <p className="setting-help">
                                {tr(
                                    mode === 'broadband'
                                        ? '专业语音建议：宽带使用 5 ms、频率上限 5000–5500 Hz。默认显示增益与层次对比已按语音共振峰优化；若录音噪声较大，可继续降低层次对比。'
                                        : mode === 'narrowband'
                                        ? '专业语音建议：窄带使用 30 ms，适合分辨基频与谐波；需要观察共振峰运动时请切换宽带。'
                                        : '自定义语音建议：较短窗口突出时间变化与共振峰，较长窗口突出基频与谐波；可从 15 ms 开始按目标调节。'
                                )}
                            </p>
                        </>
                    )}

                    {settingsTab === 'waveform' && (
                        <>
                            <div className="settings-action-row">
                                <button
                                    className="reset-tab-button"
                                    onClick={() => resetSettingsTab('waveform')}
                                >
                                    <RestoreIcon aria-hidden="true" />
                                    <span>{tr('恢复本页默认参数')}</span>
                                </button>
                                <button
                                    className="reset-tab-button"
                                    onClick={() => {
                                        setWaveformAutoFitView(false);
                                        setWaveformNormalizeRecordingPeak(false);
                                        setWaveformGainDb(onFitWaveformView());
                                    }}
                                >
                                    <ZoomOutMapIcon aria-hidden="true" />
                                    <span>{tr('适配当前视图')}</span>
                                </button>
                            </div>
                            <div className="select-row one">
                                <label>
                                    {tr('波形尺度')}
                                    <select
                                        value={waveformScaleMode}
                                        onChange={(event) =>
                                            setWaveformScaleMode(
                                                event.target.value as WaveformScaleMode
                                            )
                                        }
                                    >
                                        <option value="linear">{tr('线性振幅')}</option>
                                        <option value="logarithmic">{tr('对数增强')}</option>
                                    </select>
                                </label>
                            </div>
                            <p className="setting-help">
                                {tr(
                                    waveformScaleMode === 'linear'
                                        ? '固定数字满刻度，保留真实波形比例'
                                        : '放大弱信号，仅改变视觉显示'
                                )}
                            </p>
                            <div className="select-row one">
                                <label>
                                    {tr('左轴参考单位')}
                                    <select
                                        value={waveformReferenceUnit}
                                        onChange={(event) =>
                                            setWaveformReferenceUnit(
                                                event.target.value as WaveformReferenceUnit
                                            )
                                        }
                                    >
                                        <option value="dbfs">dBFS</option>
                                        <option value="dbspl">{splUnitLabel}</option>
                                        <option value="none">{tr('不显示')}</option>
                                    </select>
                                </label>
                            </div>
                            <div className="select-row one">
                                <label>
                                    {tr('振幅单位基准')}
                                    <select
                                        value={
                                            sourceProfileMode === 'live' ||
                                            !waveformNormalizeRecordingPeak
                                                ? 'digital-full-scale'
                                                : 'recording-peak'
                                        }
                                        disabled={sourceProfileMode === 'live'}
                                        onChange={(event) => {
                                            const normalize =
                                                event.target.value === 'recording-peak';
                                            setWaveformNormalizeRecordingPeak(normalize);
                                            if (normalize) {
                                                setWaveformAutoFitView(false);
                                            }
                                        }}
                                    >
                                        <option value="digital-full-scale">
                                            {tr('原始 PCM 电平基准')}
                                        </option>
                                        <option value="recording-peak">
                                            {tr('整段录音峰值基准')}
                                        </option>
                                    </select>
                                </label>
                            </div>
                            <p className="setting-help">
                                {tr(
                                    sourceProfileMode === 'live'
                                        ? 'Live 录音固定使用原始 PCM 电平基准，不能切换'
                                        : waveformNormalizeRecordingPeak
                                        ? '整段录音绝对峰值定义为振幅 1.0，右轴仍使用 ±1.0 振幅单位'
                                        : '原始 PCM ±1.0 定义为振幅 ±1.0，保留文件实际数字电平'
                                )}
                            </p>
                            <label className="setting">
                                <span>
                                    {tr('显示增益')}{' '}
                                    <em>
                                        {waveformGainDb > 0 ? '+' : ''}
                                        {waveformGainDb.toFixed(0)} dB
                                    </em>
                                </span>
                                <input
                                    type="range"
                                    min={-24}
                                    max={24}
                                    step={1}
                                    value={waveformGainDb}
                                    onChange={(event) =>
                                        setWaveformGainDb(Number(event.target.value))
                                    }
                                />
                                <small>{tr('调整波形可视高度，不改变录音内容')}</small>
                            </label>
                            <label className="effect-toggle">
                                <span>
                                    <strong>{tr('自动适配当前视图')}</strong>
                                    <small>{tr('根据可见区域峰值调整，不用于比较真实电平')}</small>
                                </span>
                                <input
                                    type="checkbox"
                                    checked={waveformAutoFitView}
                                    onChange={(event) => {
                                        setWaveformAutoFitView(event.target.checked);
                                        if (event.target.checked) {
                                            setWaveformNormalizeRecordingPeak(false);
                                        }
                                    }}
                                />
                            </label>
                            <div className="waveform-setting-section-label">{tr('电平显示')}</div>
                            <label className="effect-toggle">
                                <span>
                                    <strong>Peak</strong>
                                </span>
                                <input
                                    type="checkbox"
                                    checked={waveformShowPeak}
                                    onChange={(event) => setWaveformShowPeak(event.target.checked)}
                                />
                            </label>
                            <label className="effect-toggle">
                                <span>
                                    <strong>RMS</strong>
                                </span>
                                <input
                                    type="checkbox"
                                    checked={waveformShowRms}
                                    onChange={(event) => setWaveformShowRms(event.target.checked)}
                                />
                            </label>
                            <label className="effect-toggle">
                                <span>
                                    <strong>{tr('峰值保持')}</strong>
                                </span>
                                <input
                                    type="checkbox"
                                    checked={waveformShowPeakHold}
                                    onChange={(event) =>
                                        setWaveformShowPeakHold(event.target.checked)
                                    }
                                />
                            </label>
                            <label className="effect-toggle">
                                <span>
                                    <strong>{tr('削波提示')}</strong>
                                </span>
                                <input
                                    type="checkbox"
                                    checked={waveformShowClipping}
                                    onChange={(event) =>
                                        setWaveformShowClipping(event.target.checked)
                                    }
                                />
                            </label>
                            <label className="setting">
                                <span>
                                    {tr('波形粗细')} <em>{waveformLineWidth.toFixed(1)} px</em>
                                </span>
                                <input
                                    type="range"
                                    min={0.5}
                                    max={4}
                                    step={0.1}
                                    value={waveformLineWidth}
                                    onChange={(event) =>
                                        setWaveformLineWidth(Number(event.target.value))
                                    }
                                />
                            </label>
                            <label className="effect-toggle">
                                <span>
                                    <strong>{tr('显示零线')}</strong>
                                    <small>{tr('在波形中心显示振幅基准线')}</small>
                                </span>
                                <input
                                    type="checkbox"
                                    checked={waveformZeroLine}
                                    onChange={(event) => setWaveformZeroLine(event.target.checked)}
                                />
                            </label>
                            <label className="effect-toggle">
                                <span>
                                    <strong>{tr('显示脉冲')}</strong>
                                    <small>{tr('在有声区显示周期同步的声门脉冲时刻')}</small>
                                </span>
                                <input
                                    type="checkbox"
                                    checked={waveformPulses}
                                    onChange={(event) => setWaveformPulses(event.target.checked)}
                                />
                            </label>
                            <div className="palette-setting waveform-palette-setting">
                                <span>{tr('波形主题')}</span>
                                <div>
                                    {WAVEFORM_THEMES.map((item) => (
                                        <button
                                            key={item.name}
                                            aria-label={`${tr('波形主题')} ${item.name}`}
                                            title={item.name}
                                            className={
                                                waveformThemeName === item.name ? 'active' : ''
                                            }
                                            onClick={() => setWaveformThemeName(item.name)}
                                        >
                                            <span style={{ background: item.background }} />
                                            <span style={{ background: item.waveform }} />
                                        </button>
                                    ))}
                                </div>
                                <small>{waveformThemeName}</small>
                            </div>
                            <p className="setting-help">
                                {tr(
                                    '波形主题仅改变纯色背景和波形颜色，不影响语谱主题或整体界面模式。'
                                )}
                            </p>
                        </>
                    )}

                    {settingsTab === 'pitch' && (
                        <>
                            <button
                                className="reset-tab-button"
                                onClick={() => resetSettingsTab('pitch')}
                            >
                                <RestoreIcon aria-hidden="true" />
                                <span>{tr('恢复本页默认参数')}</span>
                            </button>
                            <div className="select-row one">
                                <label>
                                    {tr('F0检测算法')}
                                    <select value={pitchAlgorithm} onChange={changeAlgorithm}>
                                        <option value="yin">YIN</option>
                                        <option value="autocorrelation">
                                            {tr('归一化自相关')}
                                        </option>
                                    </select>
                                </label>
                            </div>
                            <label className="effect-toggle">
                                <span>
                                    <strong>{tr('窄带基频与频率轴对齐')}</strong>
                                    <small>
                                        {tr(
                                            '让基频曲线与语谱频率使用同一纵坐标，以检查第一谐波重叠'
                                        )}
                                    </small>
                                </span>
                                <input
                                    type="checkbox"
                                    checked={narrowbandPitchFrequencyAligned}
                                    onChange={(event) =>
                                        setNarrowbandPitchFrequencyAligned(event.target.checked)
                                    }
                                />
                            </label>
                            <label className="setting">
                                <span>
                                    {tr('搜索与显示下限')} <em>{pitchFloor} Hz</em>
                                </span>
                                <input
                                    type="range"
                                    min={40}
                                    max={200}
                                    step={5}
                                    value={pitchFloor}
                                    onChange={(event) => setPitchFloor(Number(event.target.value))}
                                />
                            </label>
                            <label className="setting">
                                <span>
                                    {tr('搜索与显示上限')} <em>{pitchCeiling} Hz</em>
                                </span>
                                <input
                                    type="range"
                                    min={250}
                                    max={1000}
                                    step={10}
                                    value={pitchCeiling}
                                    onChange={(event) =>
                                        setPitchCeiling(Number(event.target.value))
                                    }
                                />
                            </label>
                            <label className="setting">
                                <span>
                                    {tr('有声阈值')} <em>{voicingThreshold.toFixed(2)}</em>
                                </span>
                                <input
                                    type="range"
                                    min={0.3}
                                    max={0.95}
                                    step={0.01}
                                    value={voicingThreshold}
                                    onChange={(event) =>
                                        setVoicingThreshold(Number(event.target.value))
                                    }
                                />
                            </label>
                            <label className="setting">
                                <span>
                                    {tr('曲线粗细')} <em>{pitchLineWidth.toFixed(1)} px</em>
                                </span>
                                <input
                                    type="range"
                                    min={1}
                                    max={6}
                                    step={0.5}
                                    value={pitchLineWidth}
                                    onChange={(event) =>
                                        setPitchLineWidth(Number(event.target.value))
                                    }
                                />
                            </label>
                        </>
                    )}

                    {settingsTab === 'formants' && (
                        <>
                            <button
                                className="reset-tab-button"
                                onClick={() => resetSettingsTab('formants')}
                            >
                                <RestoreIcon aria-hidden="true" />
                                <span>{tr('恢复本页默认参数')}</span>
                            </button>
                            <div className="select-row">
                                <label>
                                    {tr('LPC分析数量')}
                                    <select
                                        value={maximumFormants}
                                        onChange={(event) =>
                                            setMaximumFormants(Number(event.target.value))
                                        }
                                    >
                                        {[4, 4.5, 5, 5.5, 6].map((value) => (
                                            <option key={value} value={value}>
                                                {value} {tr('条')}
                                            </option>
                                        ))}
                                    </select>
                                </label>
                                <label>
                                    {tr('画面显示数量')}
                                    <select
                                        value={formantsToDisplay}
                                        onChange={(event) =>
                                            setFormantsToDisplay(Number(event.target.value))
                                        }
                                    >
                                        {new Array(Math.ceil(maximumFormants))
                                            .fill(0)
                                            .map((_, index) => (
                                                <option key={index + 1} value={index + 1}>
                                                    F1–F{index + 1}
                                                </option>
                                            ))}
                                    </select>
                                </label>
                            </div>
                            <label className="setting">
                                <span>
                                    Formant ceiling <em>{formantCeiling} Hz</em>
                                </span>
                                <input
                                    type="range"
                                    min={3500}
                                    max={9000}
                                    step={100}
                                    value={formantCeiling}
                                    onChange={(event) =>
                                        setFormantCeiling(Number(event.target.value))
                                    }
                                />
                            </label>
                            <label className="setting">
                                <span>
                                    {tr('有效分析窗')} <em>{formantWindowMs} ms</em>
                                </span>
                                <input
                                    type="range"
                                    min={15}
                                    max={40}
                                    step={1}
                                    value={formantWindowMs}
                                    onChange={(event) =>
                                        setFormantWindowMs(Number(event.target.value))
                                    }
                                />
                            </label>
                            <label className="setting">
                                <span>
                                    {tr('预加重起点')} <em>{preEmphasisFrom} Hz</em>
                                </span>
                                <input
                                    type="range"
                                    min={0}
                                    max={1000}
                                    step={10}
                                    value={preEmphasisFrom}
                                    onChange={(event) =>
                                        setPreEmphasisFrom(Number(event.target.value))
                                    }
                                />
                            </label>
                            <label className="setting">
                                <span>
                                    {tr('绘制动态范围')} <em>{formantDynamicRange} dB</em>
                                </span>
                                <input
                                    type="range"
                                    min={10}
                                    max={80}
                                    step={5}
                                    value={formantDynamicRange}
                                    onChange={(event) =>
                                        setFormantDynamicRange(Number(event.target.value))
                                    }
                                />
                            </label>
                            <label className="setting">
                                <span>
                                    {tr('点大小')} <em>{formantDotSize.toFixed(1)} px</em>
                                </span>
                                <input
                                    type="range"
                                    min={1}
                                    max={5}
                                    step={0.2}
                                    value={formantDotSize}
                                    onChange={(event) =>
                                        setFormantDotSize(Number(event.target.value))
                                    }
                                />
                            </label>
                            <p className="setting-help">
                                {tr(
                                    'Praat 建议：成人男性可从 5000 Hz 起，成人女性从 5500 Hz 起；即使只显示 F1–F3，也通常保留 5 条分析数量。'
                                )}
                            </p>
                        </>
                    )}

                    {settingsTab === 'intensity' && (
                        <>
                            <button
                                className="reset-tab-button"
                                onClick={() => resetSettingsTab('intensity')}
                            >
                                <RestoreIcon aria-hidden="true" />
                                <span>{tr('恢复本页默认参数')}</span>
                            </button>
                            <label className="setting">
                                <span>
                                    {tr('音强窗Pitchfloor')} <em>{intensityPitchFloor} Hz</em>
                                </span>
                                <input
                                    type="range"
                                    min={40}
                                    max={200}
                                    step={5}
                                    value={intensityPitchFloor}
                                    onChange={(event) =>
                                        setIntensityPitchFloor(Number(event.target.value))
                                    }
                                />
                            </label>
                            <label className="setting">
                                <span>
                                    {tr('显示下限')}{' '}
                                    <em>
                                        {intensityFloor} {splUnitLabel}
                                    </em>
                                </span>
                                <input
                                    type="range"
                                    min={0}
                                    max={intensityCeiling - 10}
                                    step={1}
                                    value={intensityFloor}
                                    onChange={(event) =>
                                        setIntensityFloor(Number(event.target.value))
                                    }
                                />
                            </label>
                            <label className="setting">
                                <span>
                                    {tr('显示上限')}{' '}
                                    <em>
                                        {intensityCeiling} {splUnitLabel}
                                    </em>
                                </span>
                                <input
                                    type="range"
                                    min={intensityFloor + 10}
                                    max={140}
                                    step={1}
                                    value={intensityCeiling}
                                    onChange={(event) =>
                                        setIntensityCeiling(Number(event.target.value))
                                    }
                                />
                            </label>
                            <label className="setting">
                                <span>
                                    {tr('设备校准偏移')}{' '}
                                    <em>
                                        {splCalibration > 0 ? '+' : ''}
                                        {splCalibration} dB
                                    </em>
                                </span>
                                <input
                                    type="range"
                                    min={-40}
                                    max={40}
                                    step={0.5}
                                    value={splCalibration}
                                    onChange={(event) =>
                                        setSplCalibration(Number(event.target.value))
                                    }
                                />
                            </label>
                            <div className="calibration-readout">
                                <span>
                                    <strong>{tr('波形内容基准补偿')}</strong>
                                    <small>
                                        {tr('根据当前录音峰值自动计算，仅用于波形坐标换算')}
                                    </small>
                                </span>
                                <em>
                                    {waveformContentReferenceDb > 0 ? '+' : ''}
                                    {waveformContentReferenceDb.toFixed(1)} dB
                                </em>
                            </div>
                            <label className="setting">
                                <span>
                                    {tr('曲线粗细')} <em>{intensityLineWidth.toFixed(1)} px</em>
                                </span>
                                <input
                                    type="range"
                                    min={1}
                                    max={6}
                                    step={0.5}
                                    value={intensityLineWidth}
                                    onChange={(event) =>
                                        setIntensityLineWidth(Number(event.target.value))
                                    }
                                />
                            </label>
                            <p className="setting-help">
                                {tr(
                                    '使用整段录音峰值基准时，波形坐标自动使用 20 log10（录音峰值）的内容基准补偿；使用原始 PCM 电平基准时补偿为 0 dB。音强曲线始终根据原始样本实际电平计算，不受波形显示基准影响。设备校准偏移应使用相同录音增益下的已知声压参考信号确定。'
                                )}
                            </p>
                        </>
                    )}

                    {settingsTab === 'performance' && (
                        <>
                            <button
                                className="reset-tab-button"
                                onClick={() => resetSettingsTab('performance')}
                            >
                                <RestoreIcon aria-hidden="true" />
                                <span>{tr('恢复本页默认参数')}</span>
                            </button>
                            <div className="select-row one">
                                <label>
                                    {tr('实时分析精度')}
                                    <select
                                        value={analysisPrecision}
                                        onChange={(event) =>
                                            setAnalysisPrecision(
                                                event.target.value as RealtimeAnalysisPrecision
                                            )
                                        }
                                    >
                                        <option value="accurate">{tr('精确每帧分析')}</option>
                                        <option value="balanced">
                                            {tr('均衡降低全部分析频率')}
                                        </option>
                                        <option value="smooth">{tr('流畅大幅降低分析频率')}</option>
                                    </select>
                                </label>
                            </div>
                            <p className="setting-help">
                                {tr(
                                    '只降低实时分析的时间采样密度，每个被分析帧仍使用完整算法；离线音频始终保持精确。'
                                )}
                            </p>
                            <div className="select-row one">
                                <label>
                                    {tr('渲染帧率')}
                                    <select
                                        value={framesPerSecond}
                                        onChange={(event) =>
                                            setFramesPerSecond(Number(event.target.value))
                                        }
                                    >
                                        <option value={0}>{tr('无限制浏览器刷新率')}</option>
                                        {[15, 24, 30, 45, 60].map((fps) => (
                                            <option key={fps} value={fps}>
                                                {fps} FPS
                                            </option>
                                        ))}
                                    </select>
                                </label>
                            </div>
                            <p className="setting-help">{tr('较低帧率可显著降低实时 GPU 占用')}</p>
                            <label className="setting">
                                <span>
                                    {tr('内部渲染分辨率')}{' '}
                                    <em>{Math.round(renderPixelRatio * 100)}%</em>
                                </span>
                                <input
                                    type="range"
                                    min={0.5}
                                    max={2}
                                    step={0.25}
                                    value={renderPixelRatio}
                                    onChange={(event) =>
                                        setRenderPixelRatio(Number(event.target.value))
                                    }
                                />
                                <small>{tr('遇到性能问题时可适当降低，数值越高画面越清晰')}</small>
                            </label>
                            <label className="effect-toggle">
                                <span>
                                    <strong>{tr('毛玻璃效果')}</strong>
                                    <small>{tr('关闭后可降低动态图层的合成开销')}</small>
                                </span>
                                <input
                                    type="checkbox"
                                    checked={glassEffect}
                                    onChange={(event) => setGlassEffect(event.target.checked)}
                                />
                            </label>
                            <p className="setting-help">
                                {tr(
                                    '快捷键：空格播放或暂停；左右方向键按当前画面 1% 移动，按住 Shift 时按 5% 移动；长按右键正放、长按左键倒放，Shift + 长按以 3× 试听，松开自动暂停。'
                                )}
                            </p>
                        </>
                    )}
                </div>

                <div className="mode-explainer">
                    <strong>
                        {tr(
                            mode === 'broadband'
                                ? '宽带语谱'
                                : mode === 'narrowband'
                                ? '窄带语谱'
                                : '自定义语谱'
                        )}
                    </strong>
                    <p>
                        {tr(
                            mode === 'broadband'
                                ? '5 ms 有效窗，约 260 Hz 带宽。时间分辨率高，适合观察共振峰运动。'
                                : mode === 'narrowband'
                                ? '30 ms 有效窗，约 43 Hz 带宽。频率分辨率高，适合比较 F0 与第一谐波。'
                                : '自定义窗口长度可在 1–100 ms 之间调节，用于比较时间与频率分辨率。'
                        )}
                    </p>
                </div>
            </aside>
            {settingsOpen && (
                <button
                    className="settings-backdrop"
                    onClick={() => setSettingsOpen(false)}
                    aria-label={tr('关闭设置')}
                />
            )}
        </div>
    );
}
