import React, { ChangeEvent, MouseEvent, useCallback, useEffect, useRef, useState } from 'react';

import { PitchAlgorithm } from '../analysis';
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

export interface AppCallbacks {
    onStartMicrophone: () => void;
    onStartFile: (buffer: ArrayBuffer, name: string) => void;
    onStop: () => void;
    onClear: () => void;
    onExport: () => void;
    onModeChange: (mode: SpectrogramMode) => void;
    onPitchAlgorithmChange: (algorithm: PitchAlgorithm) => void;
    onDisplayChange: (parameters: Partial<RenderParameters>) => void;
    onOverlayChange: (pitch: boolean, formants: boolean, intensity: boolean) => void;
    onInspect: (xRatio: number, yRatio: number) => void;
    onNavigate: (amount: number) => void;
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
    onDisplayChange,
    onOverlayChange,
    onInspect,
    onNavigate,
}: AppProps) {
    const [playState, setPlayState] = useState<PlayState>('stopped');
    const [sourceName, setSourceName] = useState('等待输入');
    const [statusMessage, setStatusMessage] = useState('选择麦克风或音频文件开始');
    const [mode, setMode] = useState<SpectrogramMode>('broadband');
    const [pitchAlgorithm, setPitchAlgorithm] = useState<PitchAlgorithm>('yin');
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
    const [timeOffset, setTimeOffset] = useState(0);
    const fileRef = useRef<HTMLInputElement | null>(null);

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
        onOverlayChange(
            pitchVisible,
            mode === 'broadband' && formantsVisible,
            mode === 'broadband' && intensityVisible
        );
    }, [
        pitchVisible,
        formantsVisible,
        intensityVisible,
        mode,
        onOverlayChange,
    ]);

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
        (event: ChangeEvent<HTMLInputElement>) => {
            const file = event.target.files?.[0];
            if (!file) {
                return;
            }
            const reader = new FileReader();
            setPlayState('loading-file');
            setSourceName(file.name);
            setStatusMessage('正在解码音频…');
            reader.addEventListener('load', () => {
                if (reader.result instanceof ArrayBuffer) {
                    onStartFile(reader.result, file.name);
                }
                if (fileRef.current) {
                    fileRef.current.value = '';
                }
            });
            reader.readAsArrayBuffer(file);
        },
        [onStartFile]
    );

    const handlePointer = useCallback(
        (event: MouseEvent<HTMLCanvasElement>) => {
            const bounds = event.currentTarget.getBoundingClientRect();
            onInspect(
                (event.clientX - bounds.left) / bounds.width,
                (event.clientY - bounds.top) / bounds.height
            );
        },
        [onInspect]
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
                            <button
                                onClick={toggleFullscreen}
                                className="export-button"
                            >
                                全屏
                            </button>
                        </div>
                    </div>

                    <div className="praat-view">
                        <div className="axis axis-left">
                            <span className="axis-title pitch-color">基频 Hz</span>
                            {mode === 'broadband' ? (
                                <>
                                    <span className="top pitch-color">500</span>
                                    <span className="mid pitch-color">290</span>
                                    <span className="bottom pitch-color">75</span>
                                </>
                            ) : (
                                <>
                                    <span
                                        className="spectral-pitch-mark pitch-color"
                                        style={{ top: `${(1 - 500 / maxFrequency) * 100}%` }}
                                    >
                                        500
                                    </span>
                                    <span
                                        className="spectral-pitch-mark pitch-color"
                                        style={{ top: `${(1 - 290 / maxFrequency) * 100}%` }}
                                    >
                                        290
                                    </span>
                                    <span
                                        className="spectral-pitch-mark pitch-color"
                                        style={{ top: `${(1 - 75 / maxFrequency) * 100}%` }}
                                    >
                                        75
                                    </span>
                                </>
                            )}
                        </div>

                        <div className="plot-stack">
                            <div className="spectrogram-stage" id="spectrogramStage">
                                <canvas id="spectrogramCanvas" />
                                <canvas
                                    id="analysisOverlay"
                                    onMouseMove={handlePointer}
                                    onMouseLeave={() => onInspect(-1, -1)}
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
                                        {mode === 'broadband' &&
                                            cursor.intensityDbSpl !== null && (
                                                <span>
                                                    {cursor.intensityDbSpl.toFixed(1)} dB SPL*
                                                </span>
                                            )}
                                    </div>
                                )}
                            </div>

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
                        </div>

                        <div className="axis axis-right">
                            <span className="axis-title">频率 / 音强</span>
                            <span className="top">{maxFrequency} Hz</span>
                            {mode === 'broadband' && (
                                <>
                                    <span className="spl-top intensity-color">100 dB SPL*</span>
                                    <span className="spl-mid intensity-color">75 dB</span>
                                    <span className="spl-bottom intensity-color">
                                        50 dB SPL*
                                    </span>
                                </>
                            )}
                            <span className="bottom">0 Hz</span>
                        </div>
                    </div>
                </section>

                <section
                    className={`metrics-panel ${
                        metricsCollapsed ? 'bubble' : ''
                    }`}
                >
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
                                    <dd>
                                        {formatNumber(snapshot.meanIntensityDbSpl, 1)} dB
                                    </dd>
                                </div>
                            )}
                        </dl>
                    </div>

                    <p className="calibration-note">
                        * 浏览器麦克风没有统一声压校准。当前按 Praat 公式并假定
                        1.0 样本单位 = 1 Pa；绝对 SPL 仅作参考。
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
                        最高频率 <em>{maxFrequency} Hz</em>
                    </span>
                    <input
                        type="range"
                        min={3000}
                        max={10000}
                        step={100}
                        value={maxFrequency}
                        onChange={(event) => setMaxFrequency(Number(event.target.value))}
                    />
                </label>
                <label className="setting">
                    <span>
                        最低频率 <em>{minFrequency} Hz</em>
                    </span>
                    <input
                        type="range"
                        min={0}
                        max={1000}
                        step={10}
                        value={minFrequency}
                        onChange={(event) => setMinFrequency(Number(event.target.value))}
                    />
                </label>

                <div className="select-row">
                    <label>
                        F0 算法
                        <select value={pitchAlgorithm} onChange={changeAlgorithm}>
                            <option value="yin">YIN</option>
                            <option value="autocorrelation">自相关</option>
                        </select>
                    </label>
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
