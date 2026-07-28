# Spectro Pro

[![Deploy GitHub Pages](https://github.com/Jeoitim/spectro-pro/actions/workflows/deploy-pages.yml/badge.svg)](https://github.com/Jeoitim/spectro-pro/actions/workflows/deploy-pages.yml)

Spectro Pro 是一个现代、实时、易用的浏览器声学可视化工具。它在
[calebj0seph/spectro](https://github.com/calebj0seph/spectro) 的 WebAudio、
后台 FFT 和 WebGL 渲染基础上，增加面向语音观察的实时分析与交互界面。

当前版本定位为视觉与教学工具，不以替代 Praat 或提供研究级测量为目标。

## 功能

- 麦克风实时输入或播放本地音频
- 宽带语谱：5 ms 有效分析窗，显示 F0、LPC 共振峰和音强曲线
- 窄带语谱：30 ms 有效分析窗，显示谐波与按同一频率坐标绘制的 F0
- YIN、自相关两种 F0 算法
- 按 Praat 定义换算的 dB SPL 参考读数
- 实时 F0、F1–F3、音强读数和会话统计
- 鼠标时间/频率取值、缩放、历史回看与配色主题
- 导出当前语谱画面为 PNG
- 所有分析都在浏览器本地完成，音频不会上传

## 宽带与窄带

模式参数参考 Praat 文档：

- **宽带**使用 5 ms 有效窗，对应约 260 Hz 带宽。时间分辨率较高，适合观察音节边界和共振峰运动。
- **窄带**使用 30 ms 有效窗，对应约 43 Hz 带宽。频率分辨率较高，适合观察谐波；F0 在此模式中使用语谱图的频率坐标，可直接检查它与第一谐波的位置。

实际 FFT 使用不小于有效窗的最小二次幂并进行零填充；窗函数使用 Hamming。

## 关于 dB SPL

Praat 将声音强度定义为：

```text
10 log10(mean(p²) / (2×10⁻⁵ Pa)²)
```

浏览器麦克风提供的是归一化、无统一物理校准的样本。Spectro Pro 默认沿用
Praat Sound 的计算约定，将 `1.0` 样本单位视为 `1 Pa`。因此曲线内部换算与
Praat 公式一致，但未经声级计和麦克风标定时，绝对 dB SPL 只可作相对参考。

## 开发

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
| Cloudflare Pages | 很适合 | 独立域名、预览部署和全球静态分发 | Build command: `npm run build`; Output directory: `dist`; Node.js: `20` |
| EdgeOne Pages | 适合 | 希望增加另一套 Pages/CDN 发布入口 | Framework preset: Custom; Build command: `npm run build`; Output directory: `dist`; Node.js: `20` |

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
Node.js version: 20
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
Node.js version: 20
```

不要直接采用 React preset 默认的 `build` 输出目录：Spectro Pro 使用自定义
Webpack 配置，实际产物位于 `dist`。当前没有客户端路由，也不需要 catch-all
规则；以后若加入路径路由，再配置所有未知路径回退到 `index.html`。

## 算法说明

- 语谱：Hamming 窗、零填充 FFT、Web Worker 计算、WebGL 绘制
- F0：YIN 或归一化自相关，默认有声范围 75–500 Hz
- 共振峰：先重采样至 `2 × formant ceiling`，再执行 50 Hz 预加重、
  25 ms 有效 Gaussian-like 窗、Burg LPC 与根分析；默认用 10 个极点分析
  5 条共振峰，并保留每条带宽
- 音强：按 `3.2 / pitchFloor` 有效窗与 Kaiser-20 加权后换算为 dB SPL
- 音强统计：按能量域平均后换算为 dB

这些实时估计优先保证响应速度和可视反馈。用于论文数据、临床或其他精密测量时，
请使用经过校准的设备，并以 Praat 等专业分析工具复核。

`npm test` 会用合成信号检查 YIN、自相关、SPL 参考值、重采样频率，以及五条
已知共振峰。后续仍需增加与真实语音的 Praat 对照数据集。

## 致谢与许可

Spectro Pro fork 自 Caleb Joseph 的
[Spectro](https://github.com/calebj0seph/spectro)，保留其 Git 历史与 MIT
许可证。项目继续以 [MIT License](LICENSE) 发布。
