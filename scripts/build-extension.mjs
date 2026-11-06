import { access, cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..');
const extensionDir = path.join(rootDir, 'apps', 'extension');
const sourceDir = path.join(extensionDir, 'src');
const publicDir = path.join(extensionDir, 'public');
const outputDir = path.join(rootDir, 'dist');
const wasmRuntimeDir = path.join(rootDir, 'vendor', 'sherpa-onnx-web');
const puncRuntimeDir = path.join(rootDir, 'vendor', 'ct-punc');
const ortRuntimeDir = path.join(rootDir, 'vendor', 'onnxruntime-web');

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });

await build({
  entryPoints: {
    background: path.join(sourceDir, 'background.ts'),
    'page-bridge': path.join(sourceDir, 'page-bridge.ts'),
    offscreen: path.join(sourceDir, 'offscreen.ts'),
    'asr-worker': path.join(sourceDir, 'asr-worker.ts'),
    'caption-worker': path.join(sourceDir, 'caption-worker.ts'),
    panel: path.join(sourceDir, 'panel.tsx'),
    'audio-capture-processor': path.join(sourceDir, 'audio-capture-processor.ts')
  },
  bundle: true,
  outdir: outputDir,
  entryNames: '[name]',
  format: 'iife',
  platform: 'browser',
  target: 'chrome120',
  sourcemap: true,
  minify: false,
  define: {
    'process.env.NODE_ENV': '"production"'
  },
  logLevel: 'info'
});

await cp(publicDir, outputDir, { recursive: true });
await cp(path.join(rootDir, 'icons'), path.join(outputDir, 'icons'), { recursive: true });
const runtimeAvailable = await access(
  path.join(wasmRuntimeDir, 'sherpa-onnx-wasm-main-asr.wasm')
).then(() => true).catch(() => false);
if (!runtimeAvailable) {
  throw new Error(
    'WebAssembly runtime is missing. Run "npm run runtime:fetch" before building.'
  );
}
const puncAvailable = await access(
  path.join(puncRuntimeDir, 'model.int8.onnx')
).then(() => true).catch(() => false);
const ortAvailable = await access(
  path.join(ortRuntimeDir, 'ort-wasm-simd-threaded.wasm')
).then(() => true).catch(() => false);
if (!puncAvailable || !ortAvailable) {
  throw new Error(
    'Punctuation runtime is missing. Run "npm run runtime:fetch" before building.'
  );
}
await cp(
  wasmRuntimeDir,
  path.join(outputDir, 'runtime', 'sherpa-onnx'),
  { recursive: true }
);
await cp(puncRuntimeDir, path.join(outputDir, 'runtime', 'ct-punc'), {
  recursive: true
});
await cp(ortRuntimeDir, path.join(outputDir, 'runtime', 'onnxruntime-web'), {
  recursive: true
});

console.log(`Extension built at ${outputDir}`);

