import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT || 8123);
const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.wav', 'audio/wav'],
  ['.data', 'application/octet-stream']
]);

const server = createServer(async (request, response) => {
  const requestPath = decodeURIComponent((request.url || '/').split('?')[0]);
  const relativePath = requestPath === '/' ? 'tests/browser/wasm-smoke.html' : requestPath;
  const filePath = path.resolve(rootDir, `.${relativePath}`);
  if (!filePath.startsWith(rootDir + path.sep)) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      throw new Error('Not a file');
    }
    response.writeHead(200, {
      'Content-Type': contentTypes.get(path.extname(filePath)) || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404).end('Not found');
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Open http://127.0.0.1:${port}/tests/browser/wasm-smoke.html`);
});
