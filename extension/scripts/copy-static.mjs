// 빌드 보조: 정적 파일(manifest, html)과 번들에 넣을 외부 라이브러리를 dist로 복사한다.
// MV3는 원격 코드를 금지하므로 sqlite-wasm(이후 Chart.js)도 로컬 파일로 넣는다.
import { cpSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
mkdirSync(dist, { recursive: true });

cpSync(join(root, 'static'), dist, { recursive: true });

const sqliteDir = join(root, 'node_modules', '@sqlite.org', 'sqlite-wasm', 'dist');
if (!existsSync(sqliteDir)) {
  throw new Error('sqlite-wasm dist 폴더가 없습니다. npm install을 먼저 실행하세요: ' + sqliteDir);
}
cpSync(sqliteDir, join(dist, 'vendor', 'sqlite'), { recursive: true });

console.log('정적 파일과 vendor 복사 완료 →', dist);
