const { copyFileSync, mkdirSync } = require('fs');
const { resolve } = require('path');
const { spawnSync } = require('child_process');

const root = resolve(__dirname, '..');
const crate = resolve(root, 'wasm-acoustic');
const result = spawnSync(
    process.platform === 'win32' ? 'cargo.exe' : 'cargo',
    ['build', '--manifest-path', resolve(crate, 'Cargo.toml'), '--target', 'wasm32-unknown-unknown', '--release'],
    {
        cwd: root,
        env: { ...process.env, RUSTFLAGS: '-C target-feature=+simd128' },
        stdio: 'inherit',
        shell: false,
    }
);
if (result.status !== 0) {
    process.exit(result.status || 1);
}
const outputDirectory = resolve(root, 'src', 'wasm');
mkdirSync(outputDirectory, { recursive: true });
copyFileSync(
    resolve(crate, 'target', 'wasm32-unknown-unknown', 'release', 'spectro_acoustic_wasm.wasm'),
    resolve(outputDirectory, 'acoustic-core.wasm')
);
