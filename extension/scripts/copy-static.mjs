// 빌드 보조: 정적 파일(manifest, html)과 번들에 넣을 외부 라이브러리를 dist로 복사한다.
// MV3는 원격 코드를 금지하므로 sqlite-wasm과 Highcharts도 로컬 파일로 넣는다.
import { cpSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
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

// three.js(요일×시간 3D 지형도 하나에만 쓴다. MIT). 대시보드가 그 구역을 볼 때만 import()로 불러온다.
// three.module.js는 같은 폴더의 three.core.js를 상대 경로로 부른다. OrbitControls는 'three'라는 패키지 이름으로 부르는데
// 확장 페이지에는 import map을 둘 수 없으므로(CSP가 인라인 스크립트를 막음) 복사할 때 상대 경로로 바꾼다.
const three = join(root, 'node_modules', 'three');
if (!existsSync(join(three, 'build', 'three.module.js'))) throw new Error('three가 없습니다. npm install을 먼저 실행하세요.');
const threeOut = join(dist, 'vendor', 'three');
mkdirSync(threeOut, { recursive: true });
for (const f of ['three.module.js', 'three.core.js']) cpSync(join(three, 'build', f), join(threeOut, f));
cpSync(join(three, 'LICENSE'), join(threeOut, 'LICENSE'));
const orbit = readFileSync(join(three, 'examples', 'jsm', 'controls', 'OrbitControls.js'), 'utf8');
const orbitLocal = orbit.replace(/from\s+'three'/g, "from './three.module.js'");
if (orbitLocal === orbit || /from\s+'three'/.test(orbitLocal)) throw new Error("OrbitControls의 'three' import를 바꾸지 못했습니다(three 버전 확인).");
writeFileSync(join(threeOut, 'OrbitControls.js'), orbitLocal);

console.log('정적 파일과 vendor 복사 완료 →', dist);
