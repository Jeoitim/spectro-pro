# Spectro Pro

**English** | [简体中文](README.md)

[![Deploy GitHub Pages](https://github.com/Jeoitim/spectro-pro/actions/workflows/deploy-pages.yml/badge.svg)](https://github.com/Jeoitim/spectro-pro/actions/workflows/deploy-pages.yml)

Spectro Pro is a modern, real-time acoustic visualizer that runs in the browser. Building on [calebj0seph/spectro](https://github.com/calebj0seph/spectro)'s Web Audio capture, background FFT processing, and WebGL rendering, it adds real-time speech analysis and an interactive interface designed for inspecting spoken audio.

The current release is intended as a visual and teaching tool. It does not aim to replace Praat or provide research-grade measurements.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshot-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="docs/screenshot-light.png">
  <img alt="Spectro Pro waveform, spectrogram, and live acoustic tracks" src="docs/screenshot-light.png">
</picture>

_Waveform, spectrogram, F0, formants, and intensity tracks for the same speech sample in light and dark modes._

## Features

-   Live microphone input and local audio-file playback
-   Aligned waveform and spectrogram views with independent visibility and a resizable divider
-   Independent waveform and spectrogram themes, including Aurora and Praat palettes, plus light and dark interface modes
-   Broadband spectrogram with a 5 ms effective analysis window, F0, LPC formants, and intensity
-   Narrowband spectrogram with a 30 ms effective analysis window, harmonics, and acoustic tracks plotted against the shared frequency scale
-   YIN and window-corrected autocorrelation F0 algorithms
-   Reference dB SPL readings calculated using Praat's definition
-   Live F0, F1–F3, intensity readings, and session statistics
-   Mouse and touch inspection for time and frequency, zooming, history navigation, and themes
-   Mobile gestures: tap to move the playhead and retain crosshair readings, drag with one finger to select audio, and drag with two fingers to pan the view
-   Adjustable 15–60 FPS or uncapped rendering, 50%–200% internal render resolution, and an optional glass effect
-   Accurate, balanced, and smooth real-time analysis profiles; Space for play/pause and arrow keys for quick navigation
-   PNG export of the current spectrogram view
-   Fully local processing: audio never leaves the browser

## Broadband and narrowband modes

The mode parameters follow the Praat documentation:

-   **Broadband** uses a 5 ms effective window, corresponding to roughly 260 Hz bandwidth. Its higher time resolution is useful for inspecting syllable boundaries and formant movement.
-   **Narrowband** uses a 30 ms effective window, corresponding to roughly 43 Hz bandwidth. Its higher frequency resolution is useful for inspecting harmonics. In this mode, F0 uses the spectrogram frequency scale so its position can be checked directly against the first harmonic.

The actual FFT uses the smallest power of two that can contain the effective window and zero-pads the remaining samples. Gaussian is the default window; Rectangular, Hamming, Bartlett, Welch, Hanning, and custom window lengths are also available.

## About dB SPL

Praat defines sound intensity as:

```text
10 log10(mean(p²) / (2×10⁻⁵ Pa)²)
```

Browser microphones provide normalized samples without a universal physical calibration. Spectro Pro follows Praat Sound's calculation convention and treats a sample value of `1.0` as `1 Pa`. The internal conversion therefore follows the same formula, but absolute dB SPL values should be treated as relative references unless the microphone has been calibrated against a sound-level meter.

## Development

Use **Node.js 24**, which matches local validation and GitHub Actions.

```bash
npm ci
npm start
```

The development server is available at `http://localhost:9000`.

Run type checking and a production build with:

```bash
npm run type-check
npm run build
```

## Deployment

All analysis, playback, and WebGL rendering happen in the browser. There is no backend, database, or server runtime dependency. The production build is written to `dist` with relative asset paths, so it can be hosted at a domain root or under a path such as GitHub Pages' `/spectro-pro/`. Microphone access requires HTTPS, which the platforms below provide.

| Platform | Fit | Recommended use | Build configuration |
| --- | --- | --- | --- |
| GitHub Pages | Excellent | Public demo integrated with the repository and Actions | The included Action installs, checks, tests, builds, and publishes `dist` |
| Cloudflare Pages | Excellent | Custom domains, preview deployments, and global static delivery | Build: `npm run build`; output: `dist`; Node.js: `24` |
| EdgeOne Pages | Good | An additional Pages/CDN deployment option | Preset: Custom; build: `npm run build`; output: `dist`; Node.js: `24` |

### GitHub Pages

The repository includes [`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml). Every push to `master` runs type checking, synthetic acoustic tests, and a production build before publishing `dist`. The workflow can also be started manually from Actions.

For first-time setup, choose **GitHub Actions** under **Settings → Pages → Build and deployment → Source**. The site is normally published at:

```text
https://jeoitim.github.io/spectro-pro/
```

### Cloudflare Pages

Import the repository from **Workers & Pages** in the Cloudflare dashboard and use:

```text
Production branch: master
Framework preset: None
Build command: npm run build
Build output directory: dist
Root directory: /
Node.js version: 24
```

The project does not use client-side routing, Pages Functions, or environment variables, so no additional rewrites are required. Cloudflare Pages can publish `master` to production and create previews for other branches and pull requests.

### EdgeOne Pages

Import the GitHub repository into EdgeOne Pages, enable Auto Deploy, and use:

```text
Production branch: master
Framework preset: Custom
Install command: npm ci
Build command: npm run build
Output directory: dist
Root directory: /
Node.js version: 24
```

Do not use the React preset's default `build` output directory. Spectro Pro uses a custom Webpack configuration and writes its artifacts to `dist`. There are currently no client-side routes, so a catch-all fallback is unnecessary.

## Analysis notes

For the complete pipeline, formulas, parameters, rendering path, limitations, and source locations, see the [full algorithm guide](docs/algorithm.en.md).

-   **Spectrogram:** selectable analysis windows, zero-padded FFT, Web Worker processing, and WebGL rendering; Gaussian is the default window.
-   **F0:** input is locally DC-corrected and downsampled through a low-pass FIR anti-aliasing filter. YIN uses a difference function, cumulative mean normalization, and parabolic interpolation. Autocorrelation mode uses a Hanning window, corrects edge decay using the window's own autocorrelation, interpolates candidate peaks, and applies a slight preference toward higher candidates. The default voiced range is 75–500 Hz, with a configurable periodicity threshold for voiced/unvoiced decisions.
-   **Real-time acoustic layers:** recording analysis retains the formant half-window delay required by the centered Gaussian window, about 25 ms by default. Spectrogram texture, F0/intensity, and formant results have separate caches, so parameter changes update only the affected layers.
-   **Rendering:** WebGL drawing pauses when the view is static. Real-time frame rate and internal resolution can be reduced, and the glass effect disabled, to lower GPU use.
-   **Live calculation switches:** hiding F0, formants, or intensity also skips that analysis chain in the Worker. Formant processing includes resampling, Burg LPC, and matrix root solving, so disabling it typically saves the most processing time.
-   **Real-time precision:** Balanced computes F0 at half resolution and formants at quarter resolution. Smooth additionally computes F0 every other batch and formants every fourth batch, at quarter and eighth resolution respectively, reusing recent values between updates. Per-frame formulas, spectrogram refresh frequency, and offline precision remain unchanged.
-   **Formants:** the full sound is resampled to `2 × formant ceiling` using Praat-style FFT anti-aliasing and depth-50 sinc interpolation, followed by whole-sound 50 Hz pre-emphasis. Centered frames use a 25 ms effective Gaussian window, Childers Burg LPC, companion-matrix eigenvalue roots, and Newton residual verification. Defaults are 10 poles and five formants, with bandwidth and frame-intensity values retained.
-   **Intensity:** the window mean pressure is removed first. Mean-square pressure is then weighted by a centered Kaiser-20 window with physical duration `6.4 / pitchFloor` and effective duration `3.2 / pitchFloor`, then converted relative to `2×10⁻⁵ Pa`. Silence follows Praat semantics at −300 dB.
-   **Intensity statistics:** averages are calculated in the energy domain and converted back to dB.

These real-time estimates prioritize responsiveness and visual feedback. For publications, clinical work, or other precision measurements, use calibrated hardware and verify results with Praat or another professional analysis tool.

`npm test` checks YIN and corrected autocorrelation across 80–440 Hz, low-amplitude signals, missing fundamentals, and high-frequency interference. It also verifies Kaiser intensity, mean removal, and the silence floor, and compares five formants against continuous-frame references generated by official Praat 6.6.30 for 11 kHz and 48 kHz inputs.

## Credits and license

Spectro Pro is forked from Caleb Joseph's [Spectro](https://github.com/calebj0seph/spectro) and retains its Git history and MIT license. Its acoustic terminology and algorithm notes also reference the official [Praat](https://www.fon.hum.uva.nl/praat/) manual; thanks to the Praat project and its contributors for documenting speech-analysis methods so clearly. Spectro Pro and Praat are independent projects. This project continues to be released under the [MIT License](LICENSE).

## Documentation

-   [Building Spectro: the author's original](docs/making-of.md)
-   [Building Spectro Pro: development story](docs/building-spectro-pro.en.md)
-   [Visualization and acoustic analysis algorithms](docs/algorithm.en.md)
