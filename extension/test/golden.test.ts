// 골든 테스트: Java(v1) 파서·수집 계획이 만든 결과(test/golden/*.json)와 TS 이식 결과가 같은지 확인한다.
// 골든 파일은 Java GoldenDumpTest가 만든다(GOLDEN_DIR=extension/test ./gradlew test --tests '*GoldenDumpTest').
// payload는 JSON 문자열의 표기(5 vs 5.0, 키 순서)가 아니라 값으로 비교한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseMetric, MetricParseError, type MetricRow } from '../src/core/metric-parser.js';
import { MetricJob, type MetricStore, type StatGetter } from '../src/core/metric-job.js';
import { HttpStatusError, buildQuery } from '../src/core/naver.js';
import { EMPTY_KEY, findSpec } from '../src/core/specs.js';

const read = (p: string) => JSON.parse(readFileSync(resolve(p), 'utf8'));

interface GoldenRow { statDate: string; metric: string; rowKey: string; payload: unknown }
const norm = (rows: MetricRow[]): GoldenRow[] => rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) }));

// ---- 파서 ----

interface ParserCase { name: string; spec: string; requested: string; today: string; key: string | null; body: unknown }
interface ParserGolden { name: string; rows?: GoldenRow[]; error?: boolean }

const cases: ParserCase[] = read('test/fixtures/parser-cases.json');
const parserGolden: ParserGolden[] = read('test/golden/metric-parser.json');

for (const [i, c] of cases.entries()) {
  test('파서: ' + c.name, () => {
    const golden = parserGolden[i]!;
    assert.equal(golden.name, c.name);
    const spec = findSpec(c.spec)!;
    const run = () => norm(parseMetric(JSON.stringify(c.body), spec, c.requested, c.today, c.key));
    if (golden.error) {
      assert.throws(run, MetricParseError);
    } else {
      assert.deepEqual(run(), golden.rows);
    }
  });
}

// ---- 수집 계획과 실행 ----

interface Exchange { url: string; status: number; body?: number }
type Call = { op: 'replace'; metric: string; rowKey: string | null; rows: GoldenRow[] } | { op: 'clear'; metric: string; date: string };
interface JobGolden {
  name: string;
  input: { specs: string[]; from: string; to: string; force: boolean;
    datesWith: Record<string, string[]>; keysWith: Record<string, string[]>; postIds: string[] };
  bodies: string[];
  exchanges: Exchange[];
  calls: Call[];
  saved: Record<string, number>;
  failures: number;
}

/** Java 골든의 모의 저장소와 같은 동작: 상태는 시나리오 입력으로 고정되고 실행 중 바뀌지 않는다. */
class FixedStore implements MetricStore {
  readonly calls: Call[] = [];
  constructor(private readonly input: JobGolden['input']) {}
  async datesWith(metric: string, from: string, to: string) {
    return new Set((this.input.datesWith[metric] ?? []).filter((d) => d >= from && d <= to));
  }
  async keysWith(metric: string, date: string) {
    return new Set(this.input.keysWith[metric + '@' + date] ?? []);
  }
  async postIds() {
    return [...new Set(this.input.postIds)].sort();
  }
  async replace(metric: string, rows: MetricRow[], rowKey: string | null) {
    this.calls.push({ op: 'replace', metric, rowKey, rows: norm(rows) });
    return rows.filter((r) => r.rowKey !== EMPTY_KEY).length;
  }
  async clear(metric: string, date: string) {
    this.calls.push({ op: 'clear', metric, date });
    return 0;
  }
}

const jobGolden: JobGolden[] = read('test/golden/metric-job.json');

for (const g of jobGolden) {
  test('수집: ' + g.name, async () => {
    const store = new FixedStore(g.input);
    const urls: string[] = [];
    const http: StatGetter = {
      async get(path, params, label) {
        const url = path + '?' + buildQuery(params);
        const ex = g.exchanges[urls.length];
        urls.push(url);
        assert.ok(ex, '골든보다 요청이 많음: ' + url);
        assert.equal(url, ex.url, (urls.length) + '번째 요청 주소');
        if (ex.status !== 200) throw new HttpStatusError(ex.status, label);
        return g.bodies[ex.body!]!;
      },
    };
    const job = new MetricJob(store);
    const result = await job.execute(http, {
      specs: g.input.specs.map((id) => findSpec(id)!),
      from: g.input.from, to: g.input.to, force: g.input.force, today: '2026-11-21',
    });

    assert.equal(urls.length, g.exchanges.length, '요청 수');
    assert.deepEqual(store.calls, g.calls);
    assert.deepEqual(result.saved, g.saved);
    assert.equal(result.failures, g.failures);
    assert.equal(result.budgetStopped, false);
  });
}
