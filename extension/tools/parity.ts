// 대조 도구(개인 데이터로 로컬에서만 돌린다, 결과는 커밋하지 않는다).
//   node build-test/tools/parity.js <blogstat-export.json> [http://127.0.0.1:8080]
// Java 내보내기 JSON을 인메모리 SQLite로 가져와 확장 조회 계층의 응답을 만들고,
// 같은 스냅샷을 읽는 Java 대시보드 API의 응답과 값 단위로 비교한다. 다른 점만 출력한다(값은 출력하지 않고 위치만).
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { memoryDb } from '../test/node-sql.js';
import { importExport } from '../src/core/importer.js';
import { DashboardQuery } from '../src/core/dashboard-query.js';

const [file, base = 'http://127.0.0.1:8080'] = process.argv.slice(2);
if (!file) {
  console.error('사용법: node build-test/tools/parity.js <export.json> [기본 URL]');
  process.exit(2);
}

/** 부동소수 비교 허용 오차(Java double과 JS number는 같은 IEEE754라 보통 0 차이). */
const EPS = 1e-9;

function diff(a: unknown, b: unknown, path: string, out: string[]): void {
  if (out.length > 20) return;
  if (typeof a === 'number' && typeof b === 'number') {
    if (Math.abs(a - b) > EPS * Math.max(1, Math.abs(a))) out.push(path + ' 숫자 다름');
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push(path + ' 길이 ' + a.length + ' != ' + b.length);
    for (let i = 0; i < Math.min(a.length, b.length); i++) diff(a[i], b[i], path + '[' + i + ']', out);
    return;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) diff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], path + '.' + k, out);
    return;
  }
  if (!isDeepStrictEqual(a, b)) out.push(path + ' 값 다름(' + typeof a + ' / ' + typeof b + ')');
}

const sql = await memoryDb();
const imported = await importExport(sql, JSON.parse(readFileSync(file, 'utf8')));
console.log('[가져오기]', JSON.stringify(imported));
const q = new DashboardQuery(sql, () => new Date().toISOString().slice(0, 10));

const latest = String((await sql.query('SELECT MAX(stat_date) AS d FROM referrer_daily'))[0]?.d);
const first = String((await sql.query('SELECT MIN(stat_date) AS d FROM referrer_daily'))[0]?.d);
const ranges: Record<string, string>[] = [{}, { from: first, to: latest }, { from: latest, to: latest }, { from: '2026-11-10', to: '2026-11-16' }];
const cases: [string, Record<string, string>][] = [];
for (const r of ranges) {
  cases.push(['summary', r], ['daily', r], ['referrers', { ...r, limit: '10' }], ['queries', { ...r, limit: '1000' }], ['metrics', r]);
}
cases.push(['keyword-trends', { limit: '10' }], ['keyword-trends', { limit: '100', lookback: '7' }],
  ['summary', { from: '2026-11-20', to: '2026-11-01' }]);

let failed = 0;
for (const [name, params] of cases) {
  const label = name + ' ' + JSON.stringify(params);
  const res = await fetch(base + '/api/dashboard/' + name + '?' + new URLSearchParams(params));
  const java = (await res.json()) as unknown;
  const ext = await q.handle(name, params, null);
  const problems: string[] = [];
  if (res.status !== ext.status) problems.push('상태 ' + res.status + ' != ' + ext.status);
  else if (res.status === 200) diff(java, ext.body, '$', problems);
  if (problems.length === 0) {
    console.log('일치  ' + label);
  } else {
    failed++;
    console.log('다름  ' + label + '\n      ' + problems.slice(0, 10).join('\n      '));
  }
}
console.log(failed === 0 ? '[결과] ' + cases.length + '건 모두 일치' : '[결과] ' + failed + '/' + cases.length + '건 다름');
process.exit(failed === 0 ? 0 : 1);
