// 보기 페이지(viewer-dist)를 로컬에서 Netlify와 같은 헤더(netlify.toml의 CSP 등)로 띄운다. 127.0.0.1에만 연다.
// /api/share는 Netlify 함수와 같은 처리기(src/core/share-api.ts)를 메모리 저장소로 돌린다(끄면 사라짐).
// 사용: npm test && npm run build:viewer && node tools/serve-viewer.mjs [포트=8787]
//   쓰기 토큰은 환경변수 SHARE_WRITE_TOKEN, 없으면 local-test.
// 확장의 공유 설정에서 보기 페이지 주소를 http://localhost:8787/ 로, 쓰기 토큰을 같은 값으로 넣으면 로컬에서 끝까지 확인할 수 있다.
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', 'viewer-dist');
const port = Number(process.argv[2] ?? 8787);
const token = process.env.SHARE_WRITE_TOKEN ?? 'local-test';
const { handleShare } = await import('../build-test/src/core/share-api.js');
const toml = readFileSync(join(root, '..', '..', 'netlify.toml'), 'utf8');
const headers = Object.fromEntries([...toml.matchAll(/^\s*([A-Za-z-]+)\s*=\s*"([^"]*)"\s*$/gm)]
  .filter(([, k]) => /^[A-Z]/.test(k)).map(([, k, v]) => [k, v]));
if (!headers['Content-Security-Policy']) throw new Error('netlify.toml에서 CSP를 찾지 못했습니다.');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

const blobs = new Map();
const store = {
  async get(id) { return blobs.get(id) ?? null; },
  async meta(id) { return blobs.get(id)?.meta ?? null; },
  async set(id, data, meta) { blobs.set(id, { data, meta }); },
  async delete(id) { blobs.delete(id); },
  async list() { return [...blobs.keys()]; },
};

async function api(req, res) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? undefined : Buffer.concat(chunks);
  const r = await handleShare(new Request('http://localhost:' + port + req.url, { method: req.method, headers: req.headers, body }), store, { token });
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
  console.log(req.method, new URL(req.url, 'http://x').pathname.replace(/[A-Za-z0-9_-]{16}$/, '<id>'), r.status, '보관 ' + blobs.size + '개');
}

createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  if (path === '/api/share' || path.startsWith('/api/share/')) {
    api(req, res).catch((e) => { res.writeHead(500).end(String(e)); });
    return;
  }
  let file = normalize(join(root, path));
  if (!file.startsWith(root + sep) && file !== root) { res.writeHead(403).end(); return; }
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file)) { res.writeHead(404).end('not found'); return; }
  res.writeHead(200, { ...headers, 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
}).listen(port, '127.0.0.1', () => console.log('보기 페이지: http://localhost:' + port + '/ (쓰기 토큰: 환경변수 또는 local-test)'));
