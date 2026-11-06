import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { cp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const ASR_PACKAGE = {
  name: 'asr',
  url: (
    'https://github.com/k2-fsa/sherpa-onnx/releases/download/'
    + 'v1.13.7/sherpa-onnx-wasm-simd-v1.13.7-zh-en-asr-zipformer.tar.bz2'
  ),
  sha256: '25e47ff0ceab2b3b3b7005eb5355dab041ac1806a0d7b75b363c036243cf718e',
  archiveRoot: 'sherpa-onnx-wasm-simd-v1.13.7-zh-en-asr-zipformer',
  files: [
    'sherpa-onnx-asr.js',
    'sherpa-onnx-wasm-main-asr.js',
    'sherpa-onnx-wasm-main-asr.data',
    'sherpa-onnx-wasm-main-asr.wasm'
  ],
  target: ['vendor', 'sherpa-onnx-web']
};

const PUNCTUATION_PACKAGE = {
  name: 'punctuation',
  url: (
    'https://github.com/k2-fsa/sherpa-onnx/releases/download/punctuation-models/'
    + 'sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12-int8.tar.bz2'
  ),
  sha256: 'c0d5aa5f8eeb686032345e180bedf39319dc2e0556781c6264bcadba8328a6e1',
  archiveRoot: 'sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12-int8',
  files: ['model.int8.onnx', 'tokens.json'],
  target: ['vendor', 'ct-punc']
};

const ORT_FILES = [
  'ort.wasm.min.js',
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.wasm'
];

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..');
const cacheDir = path.join(rootDir, '.wasm-cache');

async function sha256(filePath) {
  const hash = createHash('sha256');
  hash.update(await readFile(filePath));
  return hash.digest('hex');
}

async function downloadPackage(spec) {
  const archivePath = path.join(cacheDir, `${spec.name}.tar.bz2`);
  const extractDir = path.join(cacheDir, `extract-${spec.name}`);
  const targetDir = path.join(rootDir, ...spec.target);
  const hasArchive = await stat(archivePath)
    .then(() => true)
    .catch(() => false);

  await mkdir(cacheDir, { recursive: true });
  if (!hasArchive || await sha256(archivePath) !== spec.sha256) {
    console.log(`Downloading ${spec.url}`);
    const response = await fetch(spec.url);
    if (!response.ok || !response.body) {
      throw new Error(`Download failed: HTTP ${response.status}`);
    }
    await new Promise((resolve, reject) => {
      const output = createWriteStream(archivePath);
      output.on('finish', resolve);
      output.on('error', reject);
      Readable.fromWeb(response.body).pipe(output);
    });
  }

  const actualHash = await sha256(archivePath);
  if (actualHash !== spec.sha256) {
    throw new Error(
      `${spec.name} checksum mismatch: expected ${spec.sha256}, got ${actualHash}`
    );
  }

  await rm(extractDir, { recursive: true, force: true });
  await mkdir(extractDir, { recursive: true });
  const result = spawnSync(
    'tar',
    ['-xf', archivePath, '-C', extractDir],
    { stdio: 'inherit' }
  );
  if (result.status !== 0) {
    throw new Error(`Failed to extract the ${spec.name} package`);
  }

  const sourceDir = path.join(extractDir, spec.archiveRoot);
  await rm(targetDir, { recursive: true, force: true });
  await mkdir(targetDir, { recursive: true });
  for (const fileName of spec.files) {
    await cp(
      path.join(sourceDir, fileName),
      path.join(targetDir, fileName)
    );
  }
  console.log(`${spec.name} runtime installed at ${targetDir}`);
}

await downloadPackage(ASR_PACKAGE);
await downloadPackage(PUNCTUATION_PACKAGE);

const ortSourceDir = path.join(rootDir, 'node_modules', 'onnxruntime-web', 'dist');
const ortTargetDir = path.join(rootDir, 'vendor', 'onnxruntime-web');
await rm(ortTargetDir, { recursive: true, force: true });
await mkdir(ortTargetDir, { recursive: true });
for (const fileName of ORT_FILES) {
  await cp(
    path.join(ortSourceDir, fileName),
    path.join(ortTargetDir, fileName)
  );
}
console.log(`ONNX Runtime Web installed at ${ortTargetDir}`);
