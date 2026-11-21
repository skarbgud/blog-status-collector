// 병행 운영 비교(4단계). 개인 데이터로 로컬에서만 돌리고 결과는 커밋하지 않는다.
//   node build-test/tools/compare.js <확장 백업.sqlite> <Java blogstat-export.json> [시작일] [종료일]
// 확장: 옵션 페이지 "백업 파일 받기". Java: ./gradlew exportJson (스냅샷 기준).
// 같은 날짜를 양쪽이 각자 받았을 때 행이 같은지 본다. 값은 출력하지 않고 지표·날짜와 개수만 출력한다.
import { readFileSync } from 'node:fs';
import { openSqliteFile } from '../test/node-sql.js';
import { compare } from './compare-core.js';

const [backup, exportFile, from, to] = process.argv.slice(2);
if (!backup || !exportFile) {
  console.error('사용법: node build-test/tools/compare.js <backup.sqlite> <export.json> [from] [to]');
  process.exit(2);
}
const sql = await openSqliteFile(new Uint8Array(readFileSync(backup)));
const r = await compare(sql, JSON.parse(readFileSync(exportFile, 'utf8')), from, to);
console.log('[범위] ' + r.range.from + ' ~ ' + r.range.to);
console.log('[비교] 각자 받은 유입경로 ' + r.compared.referrerDays + '일, 검색어 ' + r.compared.queryDays + '일, 지표 ' + r.compared.metricGroups + '건');
console.log('[제외] Java에서 가져온 복사본: 유입경로 ' + r.copied.referrerDays + '일, 지표 ' + r.copied.metricGroups + '건');
console.log('[한쪽만] 확장에만 ' + r.onlyExtension + '건, Java에만 ' + r.onlyJava + '건');
for (const d of r.diffs) console.log('다름  ' + d.table + ' ' + d.group + ': ' + d.problem);
console.log(r.diffs.length === 0 ? '[결과] 각자 받은 행이 모두 같습니다' : '[결과] ' + r.diffs.length + '건 다름');
process.exit(r.diffs.length === 0 ? 0 : 1);
