// 빌드 보조: 정적 파일(manifest, html)과 번들에 넣을 외부 라이브러리를 dist로 복사한다.
// MV3는 원격 코드를 금지하므로 sqlite-wasm과 Highcharts도 로컬 파일로 넣는다.
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

// Highcharts(대시보드 차트). 개인·비상업 용도 무료(www.highcharts.com/license). 원격 코드를 쓰지 않도록 번들에 넣는다.
const hc = join(root, 'node_modules', 'highcharts');
if (!existsSync(join(hc, 'highcharts.js'))) throw new Error('highcharts가 없습니다. npm install을 먼저 실행하세요.');
mkdirSync(join(dist, 'vendor', 'highcharts'), { recursive: true });
cpSync(join(hc, 'highcharts.js'), join(dist, 'vendor', 'highcharts', 'highcharts.js'));
cpSync(join(hc, 'modules', 'accessibility.js'), join(dist, 'vendor', 'highcharts', 'accessibility.js'));

console.log('정적 파일과 vendor 복사 완료 →', dist);
