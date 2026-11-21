// 독자가 오는 시간(요일×시간). 블로그 지표 스크립트가 받은 metrics 응답(blog:metrics 이벤트)을 다시 쓴다(추가 조회 없음).
// 3D 지형도(terrain3d.js, three.js)는 이 구역이 화면에 들어올 때만 불러온다. 같은 값을 표로도 보여 주고,
// WebGL이 없거나 불러오지 못하면 표를 펼쳐 대신 보여 준다. 텍스트는 textContent로만 넣는다.
import { computeAudienceHours, MIN_SAMPLES, WEEKDAYS } from './core/audience-hours.js';

const $ = (id) => document.getElementById(id);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const nf1 = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const COL_LABELS = [0, 3, 6, 9, 12, 15, 18, 21].map((c) => ({ col: c, text: c + '시' }));

let data = null;
let mode = 'surface';   // surface | bars
let value = 'share';    // share | views
let visible = false;
let terrain = null;     // createTerrain 결과
let loading = null;     // 불러오는 중인 Promise
let failed = false;
let indexChart = null;

const panel = $('m-aud-panel');
if (panel) init();

function init() {
  window.addEventListener('blog:metrics', (e) => update(e.detail));
  // 이 모듈보다 먼저 그려졌으면. 모듈 끝까지 평가된 뒤에 그린다(아래 const values 등이 아직 초기화 전이라 바로 부르면 ReferenceError).
  if (window.blogMetricsView) queueMicrotask(() => update(window.blogMetricsView));

  new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting) && !visible) {
      visible = true;
      drawTerrain();
    }
  }, { rootMargin: '200px' }).observe(panel);

  segment('m-aud-mode', (v) => { mode = v; drawTerrain(); });
  segment('m-aud-value', (v) => { value = v; drawTerrain(); renderTable(); });
  $('m-aud-top-view').addEventListener('click', () => terrain && terrain.view('top'));
  $('m-aud-reset').addEventListener('click', () => terrain && terrain.view('default'));
}

function segment(id, onPick) {
  const buttons = document.querySelectorAll('#' + id + ' button');
  buttons.forEach((b) => b.addEventListener('click', () => {
    buttons.forEach((x) => x.classList.toggle('active', x === b));
    onPick(b.dataset.v);
  }));
}

function update(view) {
  if (!view || !view.items) return;
  data = computeAudienceHours(view.items, view.from, view.to);
  const empty = data.days === 0;
  $('m-aud-body').hidden = empty;
  $('m-aud-empty').hidden = !empty;
  if (empty) { $('m-aud-sub').textContent = ''; return; }

  const n = data.samples.filter((s) => s > 0);
  $('m-aud-sub').textContent = data.days + '일 · 요일당 ' + (Math.min(...n) === Math.max(...n) ? Math.min(...n) : Math.min(...n) + '~' + Math.max(...n)) + '주';
  renderTop();
  renderIndex();
  renderTable();
  drawTerrain();
}

function renderTop() {
  const list = $('m-aud-top');
  list.replaceChildren(...data.top.map((b) => {
    const li = document.createElement('li');
    li.textContent = WEEKDAYS[b.weekday] + ' ' + b.fromHour + '~' + b.toHour + '시 · 하루 조회의 ' + nf1.format(b.share) + '%';
    return li;
  }));
  if (data.top.length === 0) {
    const li = document.createElement('li');
    li.textContent = '요일마다 ' + MIN_SAMPLES + '주 이상 쌓이면 보여 드립니다.';
    list.replaceChildren(li);
  }
  $('m-aud-stable').textContent = data.stable === null
    ? '날짜가 14일 이상 쌓이면 이 패턴이 안정적인지 알려 드립니다.'
    : data.stable
      ? '기간 앞뒤 반의 상위 시간대가 비슷합니다. 패턴이 안정적입니다.'
      : '기간 앞뒤 반의 상위 시간대가 달라 패턴이 아직 안정적이지 않습니다. 기간을 늘려 보세요.';
}

function renderIndex() {
  if (indexChart) { indexChart.destroy(); indexChart = null; }
  indexChart = window.BlogCharts.draw($('m-aud-index'), {
    kind: 'column', legend: false, decimals: true, categories: [...WEEKDAYS], title: '요일 지수',
    valueFormat: (v) => nf2.format(v) + '배',
    series: [{ name: '요일 지수(1 = 평균)', data: data.weekdayIndex.map((v) => (v == null ? null : Math.round(v * 100) / 100)), color: css('--c1') }],
  });
}

const values = () => (value === 'share' ? data.share : data.views);
const fmtCell = (v) => (v == null ? '-' : nf1.format(v));

function tooltip(r, c) {
  const s = data.share[r][c], v = data.views[r][c];
  const head = WEEKDAYS[r] + ' ' + c + '시';
  if (s == null) return head + ' · 데이터 없음';
  return head + ' · 하루의 ' + nf1.format(s) + '% · 평균 ' + nf1.format(v) + '회 · ' + data.samples[r] + '주'
    + (data.samples[r] < MIN_SAMPLES ? ' · 표본 부족' : '');
}

function renderTable() {
  if (!data) return;
  const m = values();
  let max = 0;
  for (const row of m) for (const v of row) if (v != null && v > max) max = v;
  const head = document.createElement('tr');
  head.appendChild(document.createElement('th'));
  for (let h = 0; h < 24; h++) {
    const th = document.createElement('th');
    th.textContent = String(h);
    head.appendChild(th);
  }
  const rows = m.map((row, r) => {
    const tr = document.createElement('tr');
    if (data.samples[r] < MIN_SAMPLES) tr.className = 'weak';
    const th = document.createElement('th');
    th.textContent = WEEKDAYS[r];
    th.scope = 'row';
    tr.appendChild(th);
    row.forEach((v, c) => {
      const td = document.createElement('td');
      td.textContent = fmtCell(v);
      td.title = tooltip(r, c);
      if (v != null && max > 0) td.style.setProperty('--a', Math.round((v / max) * 60) + '%'); // 60%까지만: 진한 칸에서도 글자가 읽히게
      tr.appendChild(td);
    });
    return tr;
  });
  $('m-aud-table-head').replaceChildren(head);
  $('m-aud-table-body').replaceChildren(...rows);
  $('m-aud-table-unit').textContent = value === 'share' ? '하루 조회 중 비율(%)' : '평균 조회수(회)';
}

function terrainData() {
  return {
    rows: [...WEEKDAYS], cols: 24, values: values(), colLabels: COL_LABELS,
    weak: data.samples.map((s) => s < MIN_SAMPLES),
    top: data.top.map((b) => ({ row: b.weekday, from: b.fromHour, to: b.toHour })),
    tooltip,
  };
}

function fallback(reason) {
  failed = true;
  $('m-aud-3d').hidden = true;
  $('m-aud-3d-tools').hidden = true;
  $('m-aud-table-box').open = true;
  $('m-aud-fallback').hidden = false;
  $('m-aud-fallback').textContent = '3D를 표시할 수 없어 표로 보여 드립니다' + (reason ? ' (' + reason + ')' : '') + '.';
}

async function drawTerrain() {
  if (!visible || !data || data.days === 0 || failed) return;
  try {
    if (!terrain) {
      loading ??= import('./terrain3d.js').then((m) => m.createTerrain($('m-aud-3d'), { hint: '눌러서 돌려 보기 · 바깥을 누르면 끝' }));
      terrain = await loading;
    }
    terrain.setData(terrainData(), { mode });
  } catch (e) {
    console.warn('지형도를 그리지 못했습니다', e);
    fallback(e && e.message && /webgl|context/i.test(e.message) ? 'WebGL 없음' : '');
  }
}
