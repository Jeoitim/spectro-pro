# Spectro Pro

[![Deploy GitHub Pages](https://github.com/Jeoitim/spectro-pro/actions/workflows/deploy-pages.yml/badge.svg)](https://github.com/Jeoitim/spectro-pro/actions/workflows/deploy-pages.yml)

Spectro Pro 是一个现代、实时、易用的浏览器声学可视化工具。它在
[calebj0seph/spectro](https://github.com/calebj0seph/spectro) 的 WebAudio、
后台 FFT 和 WebGL 渲染基础上，增加面向语音观察的实时分析与交互界面。

当前版本定位为视觉与教学工具，不以替代 Praat 或提供研究级测量为目标。

## 功能

- 麦克风实时输入或播放本地音频
- 宽带语谱：5 ms 有效分析窗，显示 F0、LPC 共振峰和音强曲线
- 窄带语谱：30 ms 有效分析窗，显示谐波及按同一频率坐标绘制的声学曲线
- YIN、窗函数校正自相关两种 F0 算法
- 按 Praat 定义换算的 dB SPL 参考读数
- 实时 F0、F1–F3、音强读数和会话统计
- 鼠标时间/频率取值、缩放、历史回看与配色主题
- 可调 15–60 FPS 或无限制帧率、50%–200% 内部渲染分辨率和可选毛玻璃效果
- 精确、均衡、流畅三级实时分析精度；空格播放/暂停、方向键快速定位
- 导出当前语谱画面为 PNG
- 所有分析都在浏览器本地完成，音频不会上传

## 宽带与窄带

模式参数参考 Praat 文档：

- **宽带**使用 5 ms 有效窗，对应约 260 Hz 带宽。时间分辨率较高，适合观察音节边界和共振峰运动。
- **窄带**使用 30 ms 有效窗，对应约 43 Hz 带宽。频率分辨率较高，适合观察谐波；F0 在此模式中使用语谱图的频率坐标，可直接检查它与第一谐波的位置。

实际 FFT 使用不小于有效窗的最小二次幂并进行零填充。默认使用 Gaussian 窗，
也可以选择 Rectangular、Hamming、Bartlett、Welch、Hanning 或自定义窗长。

## 关于 dB SPL

Praat 将声音强度定义为：

```text
10 log10(mean(p²) / (2×10⁻⁵ Pa)²)
```

浏览器麦克风提供的是归一化、无统一物理校准的样本。Spectro Pro 默认沿用
Praat Sound 的计算约定，将 `1.0` 样本单位视为 `1 Pa`。因此曲线内部换算与
Praat 公式一致，但未经声级计和麦克风标定时，绝对 dB SPL 只可作相对参考。

## 开发

推荐使用与本项目本地验证及 GitHub Actions 一致的 **Node.js 24**。

```bash
npm ci
npm start
```

本地页面默认为 `http://localhost:9000`。

类型检查与生产构建：

```bash
npm run type-check
npm run build
```

## 部署

Spectro Pro 的分析、播放和 WebGL 绘制全部在浏览器完成，没有后端、数据库或
服务端运行时依赖。生产构建输出为 `dist`，其中资源使用相对路径，因此可以部署
到域名根目录或 GitHub Pages 的 `/spectro-pro/` 子路径。麦克风功能需要平台提供
HTTPS；下列 Pages 平台均满足这一要求。

| 平台 | 适合程度 | 推荐用途 | 构建配置 |
| --- | --- | --- | --- |
| GitHub Pages | 很适合 | 与源码、Action 集成的公开演示站 | Action 自动执行 `npm ci`、检查、测试和构建，再发布 `dist` |
| Cloudflare Pages | 很适合 | 独立域名、预览部署和全球静态分发 | Build command: `npm run build`; Output directory: `dist`; Node.js: `24` |
| EdgeOne Pages | 适合 | 希望增加另一套 Pages/CDN 发布入口 | Framework preset: Custom; Build command: `npm run build`; Output directory: `dist`; Node.js: `24` |

### GitHub Pages

仓库包含 [`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml)。
它会在每次推送 `master` 后执行类型检查、合成声学测试和生产构建，通过后发布
`dist`；也可以在 Actions 页面手动运行。

首次使用时，需要在仓库 **Settings → Pages → Build and deployment** 中将
**Source** 设为 **GitHub Actions**。之后站点地址通常为：

```text
https://jeoitim.github.io/spectro-pro/
```

### Cloudflare Pages

在 Cloudflare Dashboard 的 **Workers & Pages** 中导入本 GitHub 仓库，并设置：

```text
Production branch: master
Framework preset: None
Build command: npm run build
Build output directory: dist
Root directory: /
Node.js version: 24
```

该项目不使用前端路由，不需要额外 SPA rewrite、Pages Functions 或环境变量。
Cloudflare Pages 会为 `master` 创建生产部署，并可为其他分支或 Pull Request 创建
预览部署。

### EdgeOne Pages

在 EdgeOne Pages 中导入 GitHub 仓库，启用 Auto Deploy，并设置：

```text
Production branch: master
Framework preset: Custom
Install command: npm ci
Build command: npm run build
Output directory: dist
Root directory: /
Node.js version: 24
```

不要直接采用 React preset 默认的 `build` 输出目录：Spectro Pro 使用自定义
Webpack 配置，实际产物位于 `dist`。当前没有客户端路由，也不需要 catch-all
规则；以后若加入路径路由，再配置所有未知路径回退到 `index.html`。

## 算法说明

- 语谱：可选分析窗、零填充 FFT、Web Worker 计算、WebGL 绘制；默认 Gaussian 窗
- F0：分析前执行低通 FIR 抗混叠降采样并去除局部直流。YIN 使用差分函数、
  累积均值归一化与抛物线插值；自相关模式使用 Hanning 窗，并以窗函数自身的
  自相关校正边缘衰减，再对候选峰插值和轻微偏好高频候选。默认有声范围
  75–500 Hz，最终由可调周期性阈值判断有声/无声
- 实时声学层：录音分析保留一个共振峰半窗（默认约 25 ms）的必要延迟，使
  Gaussian 分析窗两侧都有真实样本；语谱纹理、F0/音强和共振峰采用独立缓存，
  参数变化只更新受影响的声学层
- 渲染：画面静止时跳过 WebGL 绘制，实时帧率和内部渲染分辨率可在“性能”
  设置中调整；遇到 GPU 占用高或滚动卡顿时可适当降低二者，并可关闭毛玻璃
- 实时计算开关：关闭 F0、共振峰或音强显示时，Worker 同时跳过对应分析链路；
  其中共振峰包含重采样、Burg LPC 和矩阵求根，关闭后通常能释放最多计算资源
- 实时分析精度：“均衡”将 F0 降为二分之一、共振峰降为四分之一；“流畅”
  还会让 F0 隔批、共振峰每四批计算，批内分别降为四分之一和八分之一，并在
  间隔中复用最近结果。单帧公式、语谱更新频率和离线音频精度不变
- 共振峰：整段声音先按 Praat 方式重采样至 `2 × formant ceiling`，包括 FFT
  抗混叠和深度 50 sinc 插值；随后整段执行 50 Hz 预加重，以 25 ms 有效
  Gaussian 窗居中分帧，运行 Childers Burg LPC、伴随矩阵特征值求根和 Newton
  残差校验。默认 10 个极点、5 条共振峰，并保留每条带宽和帧强度
- 音强：先减去分析窗内平均声压，再用物理时长 `6.4 / pitchFloor`、有效时长
  `3.2 / pitchFloor` 的 Kaiser-20 窗居中加权平方声压，最后相对
  `2×10⁻⁵ Pa` 换算为 dB SPL；静音按 Praat 语义记为 −300 dB
- 音强统计：按能量域平均后换算为 dB

这些实时估计优先保证响应速度和可视反馈。用于论文数据、临床或其他精密测量时，
请使用经过校准的设备，并以 Praat 等专业分析工具复核。

`npm test` 会检查 YIN 与校正自相关在 80–440 Hz、低幅度、缺失基频和高频干扰
条件下的结果，验证 Kaiser 音强、减均值与静音下限，并使用官方 Praat 6.6.30
生成的连续帧基准核对 11 kHz 和 48 kHz 输入的五条共振峰。

## 致谢与许可

Spectro Pro fork 自 Caleb Joseph 的
[Spectro](https://github.com/calebj0seph/spectro)，保留其 Git 历史与 MIT
许可证。项目继续以 [MIT License](LICENSE) 发布。
