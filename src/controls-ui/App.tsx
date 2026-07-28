import React, { ChangeEvent, MouseEvent, useCallback, useEffect, useRef, useState } from 'react';

import { AnalysisOptions, PitchAlgorithm } from '../analysis';
import { GRADIENTS } from '../color-util';
import { RenderParameters } from '../spectrogram-render';

export type SpectrogramMode = 'broadband' | 'narrowband';
export type PlayState = 'stopped' | 'loading-file' | 'loading-mic' | 'playing';

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
    isPlaying: boolean;
}

export interface SelectionSnapshot {
    xStart: number;
    xEnd: number;
    startSeconds: number;
    endSeconds: number;
    durationSeconds: number;
}

export interface AppCallbacks {
    onStartMicrophone: () => void;
    onStartFile: (buffer: ArrayBuffer, name: string) => void;
    onStop: () => void;
    onClear: () => void;
    onExport: () => void;
    onModeChange: (mode: SpectrogramMode) => void;
    onPitchAlgorithmChange: (algorithm: PitchAlgorithm) => void;
    onAnalysisChange: (parameters: Partial<AnalysisOptions>) => void;
    onLayerDisplayChange: (parameters: Partial<LayerDisplayOptions>) => void;
    onDisplayChange: (parameters: Partial<RenderParameters>) => void;
    onOverlayChange: (pitch: boolean, formants: boolean, intensity: boolean) => void;
    onInspect: (xRatio: number, yRatio: number) => void;
    onSelectRange: (xStartRatio: number, xEndRatio: number) => void;
    onNavigate: (amount: number) => void;
    onSelectMedia: (id: string | null) => void;
    onToggleMediaPlayback: () => void;
    onSeekMedia: (seconds: number) => void;
    onRenameMedia: (id: string, name: string) => void;
    onSaveMedia: (id: string) => void;
}

export interface LayerDisplayOptions {
    pitchFloorHz: number;
    pitchCeilingHz: number;
    pitchLineWidth: number;
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

export interface AppProps extends AppCallbacks {
    registerController: (controller: UiController) => void;
}

export interface UiController {
    setPlayState: (state: PlayState, sourceName?: string, message?: string) => void;
    updateSnapshot: (snapshot: LiveSnapshot) => void;
    updateCursor: (snapshot: CursorSnapshot | null) => void;
    updateTimeOffset: (offset: number) => void;
    updateMediaLibrary: (items: MediaListItem[], activeId: string | null) => void;
    updateTransport: (snapshot: TransportSnapshot) => void;
    updateSelection: (snapshot: SelectionSnapshot | null) => void;
}

export default function App({
    registerController,
    onStartMicrophone,
    onStartFile,
    onStop,
    onClear,
    onExport,
    onModeChange,
    onPitchAlgorithmChange,
    onAnalysisChange,
    onLayerDisplayChange,
    onDisplayChange,
    onOverlayChange,
    onInspect,
    onSelectRange,
    onNavigate,
    onSelectMedia,
    onToggleMediaPlayback,
    onSeekMedia,
    onRenameMedia,
    onSaveMedia,
}: AppProps) {
    const [playState, setPlayState] = useState<PlayState>('stopped');
    const [sourceName, setSourceName] = useState('等待输入');
    const [statusMessage, setStatusMessage] = useState('选择麦克风或音频文件开始');
    const [mode, setMode] = useState<SpectrogramMode>('broadband');
    const [pitchAlgorithm, setPitchAlgorithm] = useState<PitchAlgorithm>('yin');
    const [settingsTab, setSettingsTab] = useState<
        'spectrogram' | 'pitch' | 'formants' | 'intensity'
    >('spectrogram');
    const [snapshot, setSnapshot] = useState<LiveSnapshot>(EMPTY_SNAPSHOT);
    const [cursor, setCursor] = useState<CursorSnapshot | null>(null);
    const [pitchVisible, setPitchVisible] = useState(true);
    const [formantsVisible, setFormantsVisible] = useState(true);
    const [intensityVisible, setIntensityVisible] = useState(true);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [metricsCollapsed, setMetricsCollapsed] = useState(false);
    const [sensitivity, setSensitivity] = useState(0.54);
    const [contrast, setContrast] = useState(0.56);
    const [zoom, setZoom] = useState(1);
    const [minFrequency, setMinFrequency] = useState(0);
    const [maxFrequency, setMaxFrequency] = useState(5500);
    const [scale, setScale] = useState<'linear' | 'mel'>('linear');
    const [gradientName, setGradientName] = useState('Aurora');
    const [pitchFloor, setPitchFloor] = useState(75);
    const [pitchCeiling, setPitchCeiling] = useState(500);
    const [voicingThreshold, setVoicingThreshold] = useState(0.6);
    const [pitchLineWidth, setPitchLineWidth] = useState(2.5);
    const [maximumFormants, setMaximumFormants] = useState(5);
    const [formantsToDisplay, setFormantsToDisplay] = useState(5);
    const [formantCeiling, setFormantCeiling] = useState(5500);
    const [formantWindowMs, setFormantWindowMs] = useState(25);
    const [preEmphasisFrom, setPreEmphasisFrom] = useState(50);
    const [formantDynamicRange, setFormantDynamicRange] = useState(30);
    const [formantDotSize, setFormantDotSize] = useState(2.4);
    const [intensityPitchFloor, setIntensityPitchFloor] = useState(75);
    const [intensityFloor, setIntensityFloor] = useState(50);
    const [intensityCeiling, setIntensityCeiling] = useState(100);
    const [intensityLineWidth, setIntensityLineWidth] = useState(2.5);
    const [splCalibration, setSplCalibration] = useState(0);
    const [timeOffset, setTimeOffset] = useState(0);
    const [playlistOpen, setPlaylistOpen] = useState(true);
    const [mediaItems, setMediaItems] = useState<MediaListItem[]>([]);
    const [activeMediaId, setActiveMediaId] = useState<string | null>(null);
    const [transport, setTransport] = useState<TransportSnapshot>({
        activeId: null,
        currentSeconds: 0,
        durationSeconds: 0,
        isPlaying: false,
    });
    const [selection, setSelection] = useState<SelectionSnapshot | null>(null);
    const fileRef = useRef<HTMLInputElement | null>(null);
    const dragStartRef = useRef<number | null>(null);

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
            updateMediaLibrary: (items, activeId) => {
                setMediaItems(items);
                setActiveMediaId(activeId);
            },
            updateTransport: setTransport,
            updateSelection: setSelection,
        });
    }, [registerController]);

    useEffect(() => {
        const gradient = GRADIENTS.find((item) => item.name === gradientName);
        onDisplayChange({
            sensitivity: 10 ** (sensitivity * 3) - 1,
            contrast: 10 ** (contrast * 5) - 1,
            zoom,
            minFrequencyHz: minFrequency,
            maxFrequencyHz: maxFrequency,
            scale,
            gradient: gradient?.gradient,
        });
    }, [
        sensitivity,
        contrast,
        zoom,
        minFrequency,
        maxFrequency,
        scale,
        gradientName,
        onDisplayChange,
    ]);

    useEffect(() => {
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
        });
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
        onOverlayChange(
            pitchVisible,
            mode === 'broadband' && formantsVisible,
            mode === 'broadband' && intensityVisible
        );
    }, [pitchVisible, formantsVisible, intensityVisible, mode, onOverlayChange]);

    const changeMode = useCallback(
        (newMode: SpectrogramMode) => {
            setMode(newMode);
            setMaxFrequency(newMode === 'broadband' ? 5500 : 1200);
            setScale('linear');
            setTimeOffset(0);
            onModeChange(newMode);
        },
        [onModeChange]
    );

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

    const pointerRatios = useCallback((event: MouseEvent<HTMLCanvasElement>) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        return {
            x: Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)),
            y: Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height)),
        };
    }, []);

    const startPlotSelection = useCallback(
        (event: MouseEvent<HTMLCanvasElement>) => {
            const point = pointerRatios(event);
            dragStartRef.current = point.x;
            onInspect(point.x, point.y);
            onSelectRange(-1, -1);
        },
        [onInspect, onSelectRange, pointerRatios]
    );

    const updatePlotSelection = useCallback(
        (event: MouseEvent<HTMLCanvasElement>) => {
            if (dragStartRef.current === null) {
                return;
            }
            const point = pointerRatios(event);
            onSelectRange(dragStartRef.current, point.x);
        },
        [onSelectRange, pointerRatios]
    );

    const finishPlotSelection = useCallback(
        (event: MouseEvent<HTMLCanvasElement>) => {
            if (dragStartRef.current === null) {
                return;
            }
            const point = pointerRatios(event);
            const start = dragStartRef.current;
            dragStartRef.current = null;
            onSelectRange(
                Math.abs(point.x - start) < 0.004 ? -1 : start,
                Math.abs(point.x - start) < 0.004 ? -1 : point.x
            );
        },
        [onSelectRange, pointerRatios]
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

    const toggleFullscreen = useCallback(() => {
        if (document.fullscreenElement) {
            document.exitFullscreen();
        } else {
            document.documentElement.requestFullscreen();
        }
    }, []);

    const selectedGradient = GRADIENTS.find((item) => item.name === gradientName);

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
                        <strong>{sourceName}</strong>
                        <span>{statusMessage}</span>
                    </div>
                </div>

                <div className="session-clock">
                    <span>会话时间</span>
                    <strong>{formatTime(snapshot.elapsedSeconds)}</strong>
                </div>

                <div className="top-actions">
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
                        导入音频
                    </button>
                    <button
                        className={`button secondary ${playlistOpen ? 'active' : ''}`}
                        onClick={() => setPlaylistOpen(!playlistOpen)}
                    >
                        播放列表
                    </button>
                    {playState === 'playing' ? (
                        <button className="button danger" onClick={stop}>
                            停止
                        </button>
                    ) : (
                        <button
                            className="button primary"
                            onClick={onStartMicrophone}
                            disabled={playState !== 'stopped'}
                        >
                            <span className="record-icon" />
                            麦克风
                        </button>
                    )}
                    <button
                        className="icon-button"
                        onClick={() => setSettingsOpen(!settingsOpen)}
                        aria-label="显示设置"
                        title="显示设置"
                    >
                        <span className="sliders-icon" />
                    </button>
                </div>
            </header>

            <main className="workspace">
                <aside className={`media-panel ${playlistOpen ? 'open' : ''}`}>
                    <div className="media-panel-heading">
                        <div>
                            <span className="eyebrow">MEDIA LIBRARY</span>
                            <strong>播放列表</strong>
                        </div>
                        <button onClick={() => setPlaylistOpen(false)} aria-label="收起播放列表">
                            ×
                        </button>
                    </div>
                    <button
                        className={`media-row microphone ${activeMediaId === null ? 'active' : ''}`}
                        onClick={() => onSelectMedia(null)}
                    >
                        <span className="media-kind">LIVE</span>
                        <span className="media-copy">
                            <strong>麦克风</strong>
                            <small>始终置顶 · 结束后生成录音分段</small>
                        </span>
                        <i className={`status-dot ${playState}`} />
                    </button>
                    <div className="media-list">
                        {mediaItems.length === 0 ? (
                            <p className="media-empty">导入音频或录制一段声音后，会保留在这里。</p>
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
                                            const nextName = window.prompt('重命名', item.name);
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
                                                    ? '正在分析…'
                                                    : item.state === 'error'
                                                    ? '分析失败'
                                                    : `${formatTime(
                                                          item.durationSeconds
                                                      )} · 双击重命名`}
                                            </small>
                                        </span>
                                    </button>
                                    {item.type === 'recording' && (
                                        <button
                                            className="media-save"
                                            onClick={() => onSaveMedia(item.id)}
                                            title="保存 WAV"
                                        >
                                            保存
                                        </button>
                                    )}
                                </div>
                            ))
                        )}
                    </div>
                </aside>
                <section className="visualizer-card">
                    <div className="visualizer-toolbar">
                        <div className="mode-switch" aria-label="语谱类型">
                            <button
                                className={mode === 'broadband' ? 'active' : ''}
                                onClick={() => changeMode('broadband')}
                            >
                                <strong>宽带</strong>
                                <span>5 ms · 共振峰</span>
                            </button>
                            <button
                                className={mode === 'narrowband' ? 'active' : ''}
                                onClick={() => changeMode('narrowband')}
                            >
                                <strong>窄带</strong>
                                <span>30 ms · 谐波</span>
                            </button>
                        </div>

                        <div className="overlay-toggles">
                            <button
                                className={pitchVisible ? 'on pitch' : ''}
                                onClick={() => setPitchVisible(!pitchVisible)}
                            >
                                <i /> 基频
                            </button>
                            {mode === 'broadband' && (
                                <>
                                    <button
                                        className={formantsVisible ? 'on formants' : ''}
                                        onClick={() => setFormantsVisible(!formantsVisible)}
                                    >
                                        <i /> 共振峰
                                    </button>
                                    <button
                                        className={intensityVisible ? 'on intensity' : ''}
                                        onClick={() => setIntensityVisible(!intensityVisible)}
                                    >
                                        <i /> 音强
                                    </button>
                                </>
                            )}
                        </div>

                        <div className="view-actions">
                            <button
                                onClick={() => setZoom(Math.max(1, zoom - 0.5))}
                                aria-label="缩小"
                            >
                                −
                            </button>
                            <span>{zoom.toFixed(1)}×</span>
                            <button
                                onClick={() => setZoom(Math.min(8, zoom + 0.5))}
                                aria-label="放大"
                            >
                                +
                            </button>
                            <button onClick={onExport} className="export-button">
                                导出图片
                            </button>
                            <button onClick={toggleFullscreen} className="export-button">
                                全屏
                            </button>
                        </div>
                    </div>

                    <div className="praat-view">
                        <div className="axis axis-left">
                            <span className="axis-title pitch-color">基频 Hz</span>
                            {cursor !== null && cursor.pitchHz !== null && (
                                <span
                                    className="axis-cursor-value pitch"
                                    style={{
                                        top: `${
                                            mode === 'broadband'
                                                ? (1 -
                                                      (cursor.pitchHz - pitchFloor) /
                                                          Math.max(1, pitchCeiling - pitchFloor)) *
                                                  100
                                                : (1 - cursor.pitchHz / maxFrequency) * 100
                                        }%`,
                                    }}
                                >
                                    {cursor.pitchHz.toFixed(1)}
                                </span>
                            )}
                            {mode === 'broadband' ? (
                                <>
                                    <span className="top pitch-color">{pitchCeiling}</span>
                                    <span className="mid pitch-color">
                                        {Math.round((pitchFloor + pitchCeiling) / 2)}
                                    </span>
                                    <span className="bottom pitch-color">{pitchFloor}</span>
                                </>
                            ) : (
                                <>
                                    <span
                                        className="spectral-pitch-mark pitch-color"
                                        style={{
                                            top: `${(1 - pitchCeiling / maxFrequency) * 100}%`,
                                        }}
                                    >
                                        {pitchCeiling}
                                    </span>
                                    <span
                                        className="spectral-pitch-mark pitch-color"
                                        style={{
                                            top: `${
                                                (1 -
                                                    (pitchFloor + pitchCeiling) /
                                                        2 /
                                                        maxFrequency) *
                                                100
                                            }%`,
                                        }}
                                    >
                                        {Math.round((pitchFloor + pitchCeiling) / 2)}
                                    </span>
                                    <span
                                        className="spectral-pitch-mark pitch-color"
                                        style={{
                                            top: `${(1 - pitchFloor / maxFrequency) * 100}%`,
                                        }}
                                    >
                                        {pitchFloor}
                                    </span>
                                </>
                            )}
                        </div>

                        <div className="plot-stack">
                            <div className="spectrogram-stage" id="spectrogramStage">
                                <canvas id="spectrogramCanvas" />
                                <canvas
                                    id="analysisOverlay"
                                    onMouseDown={startPlotSelection}
                                    onMouseMove={updatePlotSelection}
                                    onMouseUp={finishPlotSelection}
                                    onMouseLeave={() => {
                                        dragStartRef.current = null;
                                    }}
                                    onWheel={(event) => {
                                        event.preventDefault();
                                        onNavigate(event.deltaY > 0 ? 0.05 : -0.05);
                                    }}
                                />
                                <div className="plot-grid" aria-hidden="true">
                                    <i />
                                    <i />
                                    <i />
                                    <i />
                                </div>
                                {cursor && (
                                    <div
                                        className="cursor-tooltip"
                                        style={{
                                            left: `${Math.min(78, Math.max(2, cursor.x * 100))}%`,
                                            top: `${Math.min(72, Math.max(2, cursor.y * 100))}%`,
                                        }}
                                    >
                                        <strong>{cursor.timeSeconds.toFixed(3)} s</strong>
                                        <span>{cursor.frequencyHz.toFixed(0)} Hz</span>
                                        {cursor.pitchHz !== null && (
                                            <span>F0 {cursor.pitchHz.toFixed(1)} Hz</span>
                                        )}
                                        {mode === 'broadband' && cursor.intensityDbSpl !== null && (
                                            <span>{cursor.intensityDbSpl.toFixed(1)} dB SPL*</span>
                                        )}
                                    </div>
                                )}
                                {cursor && (
                                    <span
                                        className="cursor-time-mark"
                                        style={{ left: `${cursor.x * 100}%` }}
                                    >
                                        {cursor.timeSeconds.toFixed(3)} s
                                    </span>
                                )}
                                {selection && (
                                    <div className="selection-reading">
                                        <strong>{selection.durationSeconds.toFixed(3)} s</strong>
                                        <span>
                                            {selection.startSeconds.toFixed(3)}–
                                            {selection.endSeconds.toFixed(3)} s
                                        </span>
                                    </div>
                                )}
                            </div>

                            {transport.activeId !== null ? (
                                <div className="file-transport">
                                    <button
                                        onClick={onToggleMediaPlayback}
                                        aria-label={transport.isPlaying ? '暂停' : '播放'}
                                    >
                                        {transport.isPlaying ? 'Ⅱ' : '▶'}
                                    </button>
                                    <span>{formatTime(transport.currentSeconds)}</span>
                                    <input
                                        className="history-slider"
                                        aria-label="播放位置"
                                        type="range"
                                        min={0}
                                        max={Math.max(0.001, transport.durationSeconds)}
                                        step={0.001}
                                        value={Math.min(
                                            transport.currentSeconds,
                                            transport.durationSeconds
                                        )}
                                        onChange={(event) =>
                                            onSeekMedia(Number(event.target.value))
                                        }
                                    />
                                    <span>{formatTime(transport.durationSeconds)}</span>
                                </div>
                            ) : (
                                <>
                                    <div className="timeline">
                                        <span>−{(8 / zoom).toFixed(1)} s</span>
                                        <span>时间</span>
                                        <span>现在</span>
                                    </div>
                                    <input
                                        className="history-slider"
                                        aria-label="回看历史"
                                        type="range"
                                        min={0}
                                        max={0.9}
                                        step={0.005}
                                        value={timeOffset}
                                        onChange={(event) =>
                                            onNavigate(Number(event.target.value) - timeOffset)
                                        }
                                    />
                                </>
                            )}
                        </div>

                        <div className="axis axis-right">
                            <span className="axis-title">频率 / 音强</span>
                            {cursor && (
                                <span
                                    className="axis-cursor-value frequency"
                                    style={{ top: `${cursor.y * 100}%` }}
                                >
                                    {cursor.frequencyHz.toFixed(1)} Hz
                                </span>
                            )}
                            <span className="top">{maxFrequency} Hz</span>
                            {mode === 'broadband' && (
                                <>
                                    <span className="spl-top intensity-color">
                                        {intensityCeiling} dB SPL*
                                    </span>
                                    <span className="spl-mid intensity-color">
                                        {Math.round((intensityFloor + intensityCeiling) / 2)} dB
                                    </span>
                                    <span className="spl-bottom intensity-color">
                                        {intensityFloor} dB SPL*
                                    </span>
                                </>
                            )}
                            <span className="bottom">0 Hz</span>
                        </div>
                    </div>
                </section>

                <section className={`metrics-panel ${metricsCollapsed ? 'bubble' : ''}`}>
                    <button
                        className="collapsed-reading"
                        onClick={() => setMetricsCollapsed(false)}
                        aria-label="展开声学概览"
                    >
                        <span>F0</span>
                        <strong>{formatNumber(snapshot.pitchHz)}</strong>
                        <em>Hz</em>
                    </button>
                    <div className="metrics-heading">
                        <div>
                            <span className="eyebrow">实时读数</span>
                            <h2>声学概览</h2>
                        </div>
                        <div className="metrics-heading-actions">
                            <span className="sample-rate">
                                {snapshot.sampleRate
                                    ? `${(snapshot.sampleRate / 1000).toFixed(1)} kHz`
                                    : '— kHz'}
                            </span>
                            <button
                                onClick={() => setMetricsCollapsed(true)}
                                aria-label="收起声学概览"
                                title="缩成气泡"
                            >
                                −
                            </button>
                        </div>
                    </div>

                    <div className="primary-metrics">
                        <article>
                            <span className="metric-label pitch-color">基频 F0</span>
                            <strong>{formatNumber(snapshot.pitchHz, 1)}</strong>
                            <em>Hz</em>
                            <small>YIN / 自相关实时估计</small>
                        </article>
                        {mode === 'broadband' && (
                            <article>
                                <span className="metric-label intensity-color">音强</span>
                                <strong>{formatNumber(snapshot.intensityDbSpl, 1)}</strong>
                                <em>dB SPL*</em>
                                <small>参考声压 20 μPa</small>
                            </article>
                        )}
                    </div>

                    {mode === 'broadband' && (
                        <div className="formant-metrics">
                            {snapshot.formantsHz.map((value, index) => (
                                <article key={index}>
                                    <span>F{index + 1}</span>
                                    <strong>{formatNumber(value)}</strong>
                                    <em>Hz</em>
                                </article>
                            ))}
                        </div>
                    )}

                    <div className="statistics">
                        <div className="section-label">当前会话统计</div>
                        <dl>
                            <div>
                                <dt>平均 F0</dt>
                                <dd>{formatNumber(snapshot.meanPitchHz, 1)} Hz</dd>
                            </div>
                            <div>
                                <dt>F0 范围</dt>
                                <dd>
                                    {formatNumber(snapshot.minPitchHz)}–
                                    {formatNumber(snapshot.maxPitchHz)} Hz
                                </dd>
                            </div>
                            <div>
                                <dt>有声比例</dt>
                                <dd>{snapshot.voicedPercent.toFixed(0)}%</dd>
                            </div>
                            {mode === 'broadband' && (
                                <div>
                                    <dt>平均音强</dt>
                                    <dd>{formatNumber(snapshot.meanIntensityDbSpl, 1)} dB</dd>
                                </div>
                            )}
                        </dl>
                    </div>

                    <p className="calibration-note">
                        * 浏览器麦克风没有统一声压校准。当前按 Praat 公式并假定 1.0 样本单位 = 1
                        Pa；绝对 SPL 仅作参考。
                    </p>

                    <div className="panel-actions">
                        <button onClick={onClear}>清空会话</button>
                        <button onClick={onExport}>保存当前画面</button>
                    </div>
                </section>
            </main>

            <aside className={`settings-panel ${settingsOpen ? 'open' : ''}`}>
                <div className="settings-header">
                    <div>
                        <span className="eyebrow">显示设置</span>
                        <h2>调整画面</h2>
                    </div>
                    <button onClick={() => setSettingsOpen(false)} aria-label="关闭设置">
                        ×
                    </button>
                </div>

                <div className="settings-tabs" role="tablist">
                    {[
                        ['spectrogram', '语谱图'],
                        ['pitch', '基频'],
                        ['formants', '共振峰'],
                        ['intensity', '音强'],
                    ].map(([value, label]) => (
                        <button
                            key={value}
                            role="tab"
                            aria-selected={settingsTab === value}
                            className={settingsTab === value ? 'active' : ''}
                            onClick={() =>
                                setSettingsTab(
                                    value as 'spectrogram' | 'pitch' | 'formants' | 'intensity'
                                )
                            }
                        >
                            {label}
                        </button>
                    ))}
                </div>

                <div className="settings-tab-content">
                    {settingsTab === 'spectrogram' && (
                        <>
                            <label className="setting">
                                <span>
                                    灵敏度 <em>{Math.round(sensitivity * 100)}%</em>
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
                                    对比度 <em>{Math.round(contrast * 100)}%</em>
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
                                    显示频率上限 <em>{maxFrequency} Hz</em>
                                </span>
                                <input
                                    type="range"
                                    min={mode === 'broadband' ? 3000 : 600}
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
                                    显示频率下限 <em>{minFrequency} Hz</em>
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
                                    频率刻度
                                    <select
                                        value={scale}
                                        onChange={(event) =>
                                            setScale(event.target.value as 'linear' | 'mel')
                                        }
                                    >
                                        <option value="linear">线性</option>
                                        <option value="mel">Mel</option>
                                    </select>
                                </label>
                            </div>
                            <div className="palette-setting">
                                <span>颜色主题</span>
                                <div>
                                    {GRADIENTS.slice(0, 5).map((item) => (
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
                        </>
                    )}

                    {settingsTab === 'pitch' && (
                        <>
                            <div className="select-row one">
                                <label>
                                    F0 检测算法
                                    <select value={pitchAlgorithm} onChange={changeAlgorithm}>
                                        <option value="yin">YIN</option>
                                        <option value="autocorrelation">归一化自相关</option>
                                    </select>
                                </label>
                            </div>
                            <label className="setting">
                                <span>
                                    搜索与显示下限 <em>{pitchFloor} Hz</em>
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
                                    搜索与显示上限 <em>{pitchCeiling} Hz</em>
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
                                    有声阈值 <em>{voicingThreshold.toFixed(2)}</em>
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
                                    曲线粗细 <em>{pitchLineWidth.toFixed(1)} px</em>
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
                            <div className="select-row">
                                <label>
                                    LPC 分析数量
                                    <select
                                        value={maximumFormants}
                                        onChange={(event) =>
                                            setMaximumFormants(Number(event.target.value))
                                        }
                                    >
                                        {[4, 4.5, 5, 5.5, 6].map((value) => (
                                            <option key={value} value={value}>
                                                {value} 条
                                            </option>
                                        ))}
                                    </select>
                                </label>
                                <label>
                                    画面显示数量
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
                                    有效分析窗 <em>{formantWindowMs} ms</em>
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
                                    预加重起点 <em>{preEmphasisFrom} Hz</em>
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
                                    绘制动态范围 <em>{formantDynamicRange} dB</em>
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
                                    点大小 <em>{formantDotSize.toFixed(1)} px</em>
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
                                Praat 建议：成人男性可从 5000 Hz 起，成人女性从 5500 Hz
                                起；即使只显示 F1–F3，也通常保留 5 条分析数量。
                            </p>
                        </>
                    )}

                    {settingsTab === 'intensity' && (
                        <>
                            <label className="setting">
                                <span>
                                    音强窗 Pitch floor <em>{intensityPitchFloor} Hz</em>
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
                                    显示下限 <em>{intensityFloor} dB SPL</em>
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
                                    显示上限 <em>{intensityCeiling} dB SPL</em>
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
                                    SPL 校准偏移{' '}
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
                            <label className="setting">
                                <span>
                                    曲线粗细 <em>{intensityLineWidth.toFixed(1)} px</em>
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
                                未经声级计校准时只比较相对变化；校准偏移用于已知声压级的麦克风系统。
                            </p>
                        </>
                    )}
                </div>

                <div className="mode-explainer">
                    <strong>{mode === 'broadband' ? '宽带语谱' : '窄带语谱'}</strong>
                    <p>
                        {mode === 'broadband'
                            ? '5 ms 有效窗，约 260 Hz 带宽。时间分辨率高，适合观察共振峰运动。'
                            : '30 ms 有效窗，约 43 Hz 带宽。频率分辨率高，适合比较 F0 与第一谐波。'}
                    </p>
                </div>
            </aside>
            {settingsOpen && (
                <button
                    className="settings-backdrop"
                    onClick={() => setSettingsOpen(false)}
                    aria-label="关闭设置"
                />
            )}
        </div>
    );
}
