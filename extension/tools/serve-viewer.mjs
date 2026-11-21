// 보기 페이지(viewer-dist)를 로컬에서 Netlify와 같은 헤더(netlify.toml의 CSP 등)로 띄운다. 127.0.0.1에만 연다.
// 사용: npm run build:viewer && node tools/serve-viewer.mjs [포트=8787]
// 확장에서 "보기 페이지 주소 바꾸기"에 http://localhost:8787/ 을 넣으면 공유 링크를 로컬에서 확인할 수 있다.
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'viewer-dist');
const port = Number(process.argv[2] ?? 8787);
const toml = readFileSync(join(root, '..', '..', 'netlify.toml'), 'utf8');
const headers = Object.fromEntries([...toml.matchAll(/^\s*([A-Za-z-]+)\s*=\s*"([^"]*)"\s*$/gm)]
  .filter(([, k]) => /^[A-Z]/.test(k)).map(([, k, v]) => [k, v]));
if (!headers['Content-Security-Policy']) throw new Error('netlify.toml에서 CSP를 찾지 못했습니다.');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  let file = normalize(join(root, path));
  if (!file.startsWith(root + sep) && file !== root) { res.writeHead(403).end(); return; }
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file)) { res.writeHead(404).end('not found'); return; }
  res.writeHead(200, { ...headers, 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
}).listen(port, '127.0.0.1', () => console.log('보기 페이지: http://localhost:' + port + '/'));
