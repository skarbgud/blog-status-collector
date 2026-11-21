// 공유 링크 길이 어림: 내보내기 JSON(blogstat-export)을 인메모리 DB에 넣고, 대시보드 화면이 부르는 응답을
// 기간별로 만들어 공유 링크 데이터 길이를 잰다. 값은 출력하지 않고 길이만 출력한다.
// 사용: npm test(컴파일) 뒤 node tools/share-size.mjs <export.json> [to=YYYY-MM-DD]
import { readFileSync } from 'node:fs';
import { memoryDb } from '../build-test/test/node-sql.js';
import { importExport } from '../build-test/src/core/importer.js';
import { DashboardQuery } from '../build-test/src/core/dashboard-query.js';
import { SHARE_VERSION, encodeShare } from '../build-test/src/core/share-codec.js';

const [file, toArg] = process.argv.slice(2);
const sql = await memoryDb();
await importExport(sql, JSON.parse(readFileSync(file, 'utf8')));
const q = new DashboardQuery(sql, () => '2099-01-01');
const latest = (await q.handle('summary', {}, null)).body.to;
const to = toArg ?? latest;

for (const days of [7, 30, 90]) {
  const d = new Date(to + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - (days - 1));
  const range = { from: d.toISOString().slice(0, 10), to };
  // dashboard-main/metrics/referer/trends.js가 부르는 것과 같은 이름·인자
  const calls = {
    summary: range, daily: range, referrers: { limit: '10', ...range }, queries: { limit: '1000', ...range },
    metrics: range, 'referrer-details': range, 'place-queries': range, 'keyword-trends': { limit: '10' },
  };
  const responses = {};
  const sizes = [];
  for (const [name, params] of Object.entries(calls)) {
    const r = await q.handle(name, params, null);
    if (r.status !== 200) throw new Error(name + ' ' + r.status);
    responses[name] = r.body;
    sizes.push(name + ' ' + (await encodeShare({ v: SHARE_VERSION, createdAt: '', from: '', to: '', responses: { [name]: r.body } })).length);
  }
  const all = await encodeShare({ v: SHARE_VERSION, createdAt: new Date().toISOString(), ...range, responses });
  console.log(days + '일', range.from + '~' + range.to, 'JSON', JSON.stringify(responses).length, '→ 링크 데이터', all.length, '자');
  console.log('   ', sizes.join(' | '));
}
