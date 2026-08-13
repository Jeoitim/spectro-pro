let modulePromise: Promise<WebAssembly.Module | null> | null = null;

function acousticCoreUrl() {
    return new URL('./wasm/acoustic-core.wasm', import.meta.url).toString();
}

async function fetchWasmBytes() {
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), 10_000);
    try {
        return await fetch(acousticCoreUrl(), {
            cache: 'force-cache',
            signal: controller.signal,
        });
    } finally {
        globalThis.clearTimeout(timeout);
    }
}

async function compileAcousticWasm() {
    const response = await fetchWasmBytes();
    if (!response.ok) {
        throw new Error(`Unable to load acoustic Wasm (${response.status})`);
    }
    if (WebAssembly.compileStreaming !== undefined) {
        try {
            return await WebAssembly.compileStreaming(response.clone());
        } catch {
            // Some static hosts do not provide application/wasm. Byte compilation
            // keeps those deployments working while retaining the browser cache.
        }
    }
    return WebAssembly.compile(await response.arrayBuffer());
}

export function prepareAcousticWasmModule() {
    if (modulePromise === null) {
        modulePromise = compileAcousticWasm().catch((error) => {
            console.warn('Unable to prepare shared acoustic Wasm module', error);
            return null;
        });
    }
    return modulePromise;
}
