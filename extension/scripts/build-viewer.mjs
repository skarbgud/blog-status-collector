// 공유 링크 보기 페이지 빌드: dist(확장 빌드 결과)에서 대시보드 화면만 꺼내 viewer-dist/에 정적 사이트로 만든다.
// Netlify가 이 폴더를 그대로 올린다(netlify.toml). 데이터는 들어가지 않는다(데이터는 링크의 # 뒤에만 있다).
// - dashboard.html → index.html. 데이터 계층 dashboard-api.js(확장 오프스크린 호출)를 share-viewer.js로 바꾸고,
//   공유 버튼(dashboard-share.js)은 뺀다.
// - 확장 전용 파일(manifest, 백그라운드, 오프스크린, sqlite, 옵션·팝업)은 복사하지 않는다.
// - index.html이 가리키는 파일이 모두 있는지 확인한다(다른 화면 스크립트가 추가돼도 빠뜨리지 않게).
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const out = join(root, 'viewer-dist');
if (!existsSync(join(dist, 'dashboard.html'))) throw new Error('dist가 없습니다. npm run build를 먼저 실행하세요.');

// 확장에만 필요한 파일. core/는 화면 스크립트가 import하는 것만 아래에서 따라가며 넣는다.
const SKIP_FILES = new Set([
  'manifest.json', 'background.js', 'offscreen.html', 'offscreen.js', 'popup.html', 'popup.js', 'options.html', 'options.js',
  'db.js', 'db.worker.js', 'dashboard-api.js', 'dashboard-share.js', 'dashboard.html',
]);
const SKIP_DIRS = new Set([join('vendor', 'sqlite')]);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(dist, out, {
  recursive: true,
  filter: (src) => {
    // Windows에서 cpSync는 긴 경로 접두어(\\?\)를 붙여 넘긴다.
    const rel = relative(dist, src.replace(/^\\\\\?\\/, ''));
    if (rel.startsWith('..')) throw new Error('dist 밖 경로: ' + src);
    if (rel === '') return true;
    if (statSync(src).isDirectory()) return !SKIP_DIRS.has(rel);
    if (rel.startsWith('core' + sep)) return false;
    if (rel.endsWith('.map')) return false;
    return !SKIP_FILES.has(rel);
  },
});

// 체크아웃에 따라 줄바꿈이 CRLF일 수 있어 LF로 맞춘다.
let html = readFileSync(join(dist, 'dashboard.html'), 'utf8').replace(/\r\n/g, '\n');
const replace = (from, to) => {
  if (!html.includes(from)) throw new Error('dashboard.html에서 찾지 못했습니다: ' + from);
  html = html.replace(from, to);
};
replace('<script src="dashboard-api.js"></script>', '<script src="share-viewer.js"></script>');
replace('<script src="dashboard-share.js"></script>\n', '');
replace('<title>블로그 통계 대시보드</title>', '<title>블로그 통계 (공유)</title>');
// 링크를 눌러 나가도(블로그 글, 유입 URL) 이 페이지 주소를 보내지 않는다. 검색엔진 색인 금지.
replace('<meta charset="utf-8">', '<meta charset="utf-8">\n<meta name="referrer" content="no-referrer">\n<meta name="robots" content="noindex, nofollow">\n<link rel="icon" href="data:,">');
writeFileSync(join(out, 'index.html'), html);

// 화면 스크립트가 import하는 core 모듈을 따라가며 dist에서 복사한다(수집기·DB 코드는 올리지 않는다).
const IMPORT = /(?:import\s*\(\s*|from\s+)['"](\.{1,2}\/[^'"]+)['"]/g;
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
const queue = walk(out).filter((f) => f.endsWith('.js'));
const missing = [];
while (queue.length) {
  const f = queue.shift();
  for (const m of readFileSync(f, 'utf8').matchAll(IMPORT)) {
    const target = join(dirname(f), m[1]);
    if (existsSync(target)) continue;
    const rel = relative(out, target);
    if (rel.startsWith('core' + sep) && existsSync(join(dist, rel))) {
      mkdirSync(dirname(target), { recursive: true });
      cpSync(join(dist, rel), target);
      queue.push(target);
    } else {
      missing.push(relative(out, f) + ' → ' + m[1]);
    }
  }
}
// index.html이 부르는 스크립트·스타일시트가 모두 있는지 확인(메뉴 링크는 제외)
for (const m of html.matchAll(/<(?:script[^>]*\ssrc|link[^>]*\shref)="([^"#:]+)"/g)) {
  if (!existsSync(join(out, m[1]))) missing.push(m[1]);
}
if (missing.length) throw new Error('보기 페이지에 빠진 파일: ' + missing.join(', '));
const core = walk(join(out, 'core')).map((f) => relative(out, f));
if (!core.includes(join('core', 'share-codec.js'))) throw new Error('core/share-codec.js가 없습니다.');
if (/chrome\.runtime/.test(readFileSync(join(out, 'share-viewer.js'), 'utf8'))) throw new Error('보기 페이지에 확장 API가 섞였습니다.');

console.log('보기 페이지 빌드 완료 →', out);
