// Java 대시보드(src/main/resources/static/index.html)의 블로그 지표 스크립트. 확장 CSP가 인라인 스크립트를 막아 파일로 뺐다.
// /api/dashboard/* 요청은 dashboard-api.js가 오프스크린의 로컬 조회 계층으로 돌린다.
// 블로그 지표 섹션. /api/dashboard/metrics 한 번으로 받아 카드와 차트를 모두 그린다.
// 게시글 제목·국가 등은 외부 값이므로 innerHTML을 쓰지 않고 textContent로만 넣는다.
(function () {
  const $ = (id) => document.getElementById(id);
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const nf = new Intl.NumberFormat('ko-KR');
  const nf1 = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 1 });
  const PALETTE = ['#2563eb', '#16a34a', '#d97706', '#9333ea', '#dc2626', '#0891b2'];
  // 응답 컬럼 이름 기준 해석: friend=서로이웃, follow=피이웃(나를 이웃 추가한 사람), etc=이웃이 아닌 방문
  const REL = [['etc', '이웃 아님'], ['friend', '서로이웃'], ['follow', '피이웃']];
  const AGES = ['0~12세', '13~18세', '19~24세', '25~29세', '30~34세', '35~39세', '40~44세',
                '45~49세', '50~54세', '55~59세', '60세 이상'];
  const charts = {};
  let seq = 0;
  let demoMode = 'DEMO';   // 성별·연령 차트가 보여 주는 지표
  let lastView = null;     // 구분 버튼·게시글 선택으로 다시 그릴 때 쓰는 마지막 응답
  let selectedPost = null; // 게시글 추이에서 고른 게시글 번호
  let selectedHour = null; // 시간대 추이에서 고른 시간(두 자리)
  const postId = (uri) => ((uri || '').replace(/\/+$/, '').split('/').pop() || '');

  function isoDays(from, to) {
    const out = [];
    const d = new Date(from + 'T00:00:00Z');
    const end = new Date(to + 'T00:00:00Z');
    while (d <= end) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
    return out;
  }
  const sum = (a) => a.reduce((s, v) => s + (v || 0), 0);
  // 초를 먼저 반올림한 뒤 분·초로 나눈다(59.6초를 따로 반올림하면 "60초"가 된다).
  const fmtDur = (sec) => { const s = Math.round(sec); return Math.floor(s / 60) + '분 ' + String(s % 60).padStart(2, '0') + '초'; };
  const pct = (v, t) => (t > 0 ? nf1.format(v * 100 / t) + '%' : '-');

  /** metric의 시계열 행을 날짜→값 Map으로. */
  function series(items, metric, col) {
    const m = new Map();
    for (const it of items) if (it.metric === metric && it.values[col] != null) m.set(it.date, it.values[col]);
    return m;
  }
  /** 하루 단위 지표 행들을 key 기준으로 col 합계. */
  function sumByKey(items, metric, col) {
    const m = new Map();
    for (const it of items) if (it.metric === metric && it.key !== 'total') m.set(it.key, (m.get(it.key) || 0) + (it.values[col] || 0));
    return m;
  }

  function setEmpty(canvasId, empty) {
    const box = $(canvasId).parentElement;
    box.hidden = empty;
    box.nextElementSibling.hidden = !empty;
  }
  function draw(id, hasData, config) {
    if (charts[id]) { charts[id].destroy(); delete charts[id]; }
    setEmpty(id, !hasData);
    if (hasData) charts[id] = new Chart($(id), config);
  }
  function baseOptions(extra) {
    const grid = css('--grid'), muted = css('--muted');
    return Object.assign({
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { grid: { color: grid }, ticks: { color: muted, maxTicksLimit: 10 } },
        y: { beginAtZero: true, grid: { color: grid }, ticks: { color: muted } },
      },
      plugins: { legend: { labels: { color: muted } } },
    }, extra || {});
  }
  function pieOptions() {
    return { maintainAspectRatio: false, plugins: { legend: { position: 'right', labels: { color: css('--muted') } } } };
  }

  function td(text, cls) {
    const c = document.createElement('td');
    c.textContent = text;
    if (cls) c.className = cls;
    return c;
  }
  function fill(tbodyId, rows, emptyText, cols) {
    const body = $(tbodyId);
    body.replaceChildren();
    if (rows.length === 0) {
      const tr = document.createElement('tr');
      const c = td(emptyText);
      c.colSpan = cols;
      c.style.textAlign = 'left';
      c.style.color = css('--muted');
      tr.appendChild(c);
      body.appendChild(tr);
      return;
    }
    for (const cells of rows) {
      const tr = document.createElement('tr');
      if (cells.pick) { // 행을 누르면 동작하게 하고 싶을 때 배열에 pick 함수를 달아 둔다
        tr.className = 'pick';
        tr.title = '누르면 아래에서 이 글의 일별 조회수 추이를 봅니다';
        tr.addEventListener('click', cells.pick);
      }
      for (const c of cells) tr.appendChild(c);
      body.appendChild(tr);
    }
  }
  function titleCell(title, uri, rank) {
    const c = document.createElement('td');
    if (rank != null) {
      const r = document.createElement('span');
      r.className = 'rk';
      r.textContent = rank;
      c.appendChild(r);
    }
    if (/^https?:\/\/blog\.naver\.com\//.test(uri || '')) {
      const a = document.createElement('a');
      a.href = uri; a.target = '_blank'; a.rel = 'noopener noreferrer';
      a.textContent = title;
      c.appendChild(a);
    } else {
      c.appendChild(document.createTextNode(title));
    }
    return c;
  }

  /** 순위 지표를 글(uri) 기준으로 합친다. valueCol: cv 또는 event. */
  function aggregatePosts(items, metric, valueCol) {
    const m = new Map();
    for (const it of items) {
      if (it.metric !== metric) continue;
      const k = it.values.uri || it.values.title;
      const e = m.get(k) || { title: it.values.title, uri: it.values.uri, total: 0, days: new Set(), best: 1e9 };
      e.total += it.values[valueCol] || 0;
      e.days.add(it.date);
      e.best = Math.min(e.best, it.values.rank || 1e9);
      m.set(k, e);
    }
    return [...m.values()].sort((a, b) => b.total - a.total || a.best - b.best);
  }

  function renderCards(items, dates) {
    const views = series(items, 'VIEWS', 'total');
    const visits = series(items, 'VISITS', 'visit');
    const dur = series(items, 'DURATION', 'total');
    const vArr = [...views.values()];
    $('m-c-views').textContent = vArr.length ? nf.format(sum(vArr)) : '-';
    $('m-h-views').textContent = vArr.length ? '일평균 ' + nf1.format(sum(vArr) / vArr.length) : '';
    const sArr = [...visits.values()];
    $('m-c-visits').textContent = sArr.length ? nf.format(sum(sArr)) : '-';
    $('m-h-visits').textContent = sArr.length ? '일평균 ' + nf1.format(sum(sArr) / sArr.length) : '';

    // 순방문자는 네이버가 하루 늦게 확정해서 조회수가 있는데 0이면 집계 전으로 보고 뺀다.
    const uv = uvSeries(items);
    const uArr = dates.map((d) => uv.get(d)).filter((v) => v != null);
    $('m-c-uv').textContent = uArr.length ? nf1.format(sum(uArr) / uArr.length) : '-';
    $('m-h-uv').textContent = uArr.length ? uArr.length + '일 평균' : '';

    const dArr = [...dur.values()].filter((v) => v > 0);
    $('m-c-dur').textContent = dArr.length ? fmtDur(sum(dArr) / dArr.length) : '-';
    $('m-h-dur').textContent = dArr.length ? '일 평균' : '';

    const add = sum([...series(items, 'RELATION_DELTA', 'add').values()]);
    const del = sum([...series(items, 'RELATION_DELTA', 'delete').values()]);
    const hasDelta = series(items, 'RELATION_DELTA', 'add').size > 0;
    $('m-c-net').textContent = hasDelta ? (add - del > 0 ? '+' : '') + nf.format(add - del) : '-';
    $('m-h-net').textContent = hasDelta ? '추가 ' + nf.format(add) + ' · 삭제 ' + nf.format(del) : '';

    const rev = [...series(items, 'REVISIT_WEEKLY', 'total_p').entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const last = rev[rev.length - 1];
    $('m-c-rev').textContent = last ? nf1.format(last[1]) + '%' : '-';
    $('m-h-rev').textContent = last ? last[0].slice(5).replace('-', '/') + ' 주' : '';
  }

  function uvSeries(items) {
    const views = series(items, 'VIEWS', 'total');
    const out = new Map();
    for (const [d, v] of series(items, 'VISITORS', 'total')) {
      if (v === 0 && (views.get(d) || 0) > 0) continue; // 집계 전
      out.set(d, v);
    }
    return out;
  }

  function renderTimeCharts(items, dates) {
    const labels = dates.map((d) => d.slice(5));
    const at = (m) => dates.map((d) => (m.has(d) ? m.get(d) : null));

    const relSets = REL.map(([col, name], i) => ({
      label: name, data: at(series(items, 'VIEWS', col)), backgroundColor: PALETTE[i], borderWidth: 0,
    }));
    const hasViews = series(items, 'VIEWS', 'total').size > 0;
    const stacked = baseOptions();
    stacked.scales.x.stacked = true;
    stacked.scales.y.stacked = true;
    draw('m-views', hasViews, { type: 'bar', data: { labels, datasets: relSets }, options: stacked });

    const line = (label, data, color) => ({ label, data, borderColor: color, backgroundColor: color,
                                            tension: .25, spanGaps: false, pointRadius: 2 });
    const vs = series(items, 'VISITS', 'visit');
    const uv = uvSeries(items);
    const vw = series(items, 'VIEWS', 'total');
    draw('m-visits', hasViews || vs.size > 0, { type: 'line', data: { labels, datasets: [
      line('조회수', at(vw), PALETTE[0]), line('방문횟수', at(vs), PALETTE[1]), line('순방문자', at(uv), PALETTE[2]),
    ] }, options: baseOptions() });

    const dur = series(items, 'DURATION', 'total');
    const durOpts = baseOptions({ plugins: { legend: { display: false }, tooltip: { callbacks: {
      label: (c) => '평균 사용시간: ' + fmtDur(c.parsed.y * 60) } } } });
    draw('m-dur', dur.size > 0, { type: 'line', data: { labels, datasets: [
      line('평균 사용시간(분)', dates.map((d) => (dur.has(d) ? dur.get(d) / 60 : null)), PALETTE[3]),
    ] }, options: durOpts });

    const add = series(items, 'RELATION_DELTA', 'add');
    const del = series(items, 'RELATION_DELTA', 'delete');
    const req = series(items, 'RELATION_DELTA', 'friend');
    const deltaOpts = baseOptions();
    deltaOpts.scales.y.beginAtZero = false;
    draw('m-delta', add.size > 0, { type: 'bar', data: { labels, datasets: [
      { label: '이웃 추가', data: at(add), backgroundColor: PALETTE[1], borderWidth: 0 },
      { label: '이웃 삭제', data: dates.map((d) => (del.has(d) ? -del.get(d) : null)), backgroundColor: PALETTE[4], borderWidth: 0 },
      Object.assign(line('서로이웃 신청', at(req), PALETTE[0]), { type: 'line' }),
    ] }, options: deltaOpts });

    const relSum = REL.map(([col]) => sum([...series(items, 'VIEWS', col).values()]));
    draw('m-rel', sum(relSum) > 0, { type: 'doughnut', data: { labels: REL.map((r) => r[1]),
      datasets: [{ data: relSum, backgroundColor: PALETTE.slice(0, 3), borderWidth: 0 }] }, options: pieOptions() });
  }

  /** 성별·연령. demoMode가 정한 지표(전체, 이웃 구분별, 이웃 추가한 사람)의 기간 합계. */
  function renderDemo(items) {
    const men = sumByKey(items, demoMode, 'm');
    const women = sumByKey(items, demoMode, 'f');
    const codes = AGES.map((_, i) => String(i + 1).padStart(2, '0'));
    const mTotal = sum([...men.values()]), fTotal = sum([...women.values()]);
    // 이웃 구분별 합은 전체보다 조금 적다(네이버 집계 차이). 구분별 차트를 볼 때 그 차이를 숨기지 않는다.
    const gapNote = $('m-demo-gap');
    if (['DEMO_FRIEND', 'DEMO_FOLLOW', 'DEMO_ETC'].includes(demoMode)) {
      const all = (metric) => [...sumByKey(items, metric, 'm').values(), ...sumByKey(items, metric, 'f').values()];
      const full = sum(all('DEMO'));
      const parts = sum(all('DEMO_FRIEND')) + sum(all('DEMO_FOLLOW')) + sum(all('DEMO_ETC'));
      gapNote.textContent = full > 0 ? '세 구분(서로이웃·피이웃·이웃 아님)의 합은 전체보다 ' + nf.format(full - parts) + '명(' + pct(full - parts, full) + ') 적습니다. 네이버가 구분에 넣지 않은 방문자가 있어서이고, 차이는 대부분 이웃 아님 쪽에서 납니다.' : '';
      gapNote.hidden = full === 0;
    } else {
      gapNote.hidden = true;
    }
    $('m-demo-sub').textContent = mTotal + fTotal > 0 ? '남 ' + pct(mTotal, mTotal + fTotal) + ' · 여 ' + pct(fTotal, mTotal + fTotal) : '';
    draw('m-demo', mTotal + fTotal > 0, { type: 'bar', data: { labels: AGES, datasets: [
      { label: '남성', data: codes.map((c) => men.get(c) || 0), backgroundColor: PALETTE[0], borderWidth: 0 },
      { label: '여성', data: codes.map((c) => women.get(c) || 0), backgroundColor: PALETTE[4], borderWidth: 0 },
    ] }, options: baseOptions() });
  }

  function renderDistributions(items) {
    // 시간대: 저장된 날짜들의 일평균
    const hourDays = new Set(items.filter((i) => i.metric === 'HOUR').map((i) => i.date));
    const hours = sumByKey(items, 'HOUR', 'cv');
    const hourLabels = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'));
    $('m-hour-sub').textContent = hourDays.size ? hourDays.size + '일 평균' : '';
    draw('m-hour', hourDays.size > 0, { type: 'bar', data: { labels: hourLabels.map((h) => h + '시'),
      datasets: [{ label: '일평균 조회수', data: hourLabels.map((h) => (hours.get(h) || 0) / Math.max(1, hourDays.size)),
        backgroundColor: PALETTE[0], borderWidth: 0 }] },
      options: baseOptions({ plugins: { legend: { display: false } } }) });

    renderDemo(items);

    // 기기: DEVICE 'total' 행이 전체 합계다
    let pc = 0, mobile = 0;
    for (const it of items) if (it.metric === 'DEVICE' && it.key === 'total') { pc += it.values.pc || 0; mobile += it.values.mobile || 0; }
    draw('m-device', pc + mobile > 0, { type: 'doughnut', data: { labels: ['모바일', 'PC'],
      datasets: [{ data: [mobile, pc], backgroundColor: [PALETTE[0], PALETTE[2]], borderWidth: 0 }] }, options: pieOptions() });

    // 국가
    const countries = [...sumByKey(items, 'COUNTRY', 'cv').entries()].sort((a, b) => b[1] - a[1]);
    const cTotal = sum(countries.map((c) => c[1]));
    let names = null;
    try { names = new Intl.DisplayNames(['ko'], { type: 'region' }); } catch (e) { /* 지원 안 하면 코드로 표시 */ }
    fill('m-country', countries.map(([code, v]) => {
      let label = code;
      try { if (names) label = (names.of(code) || code) + ' (' + code + ')'; } catch (e) { /* 코드 그대로 */ }
      return [td(label), td(nf.format(v)), td(pct(v, cTotal))];
    }), '이 기간에 수집된 데이터가 없습니다.', 3);

    // 주제
    const subjects = new Map();
    for (const it of items) if (it.metric === 'RANK_SUBJECT')
      subjects.set(it.values.dimension1, (subjects.get(it.values.dimension1) || 0) + (it.values.cv || 0));
    const sub = [...subjects.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    draw('m-subject', sub.length > 0, { type: 'bar', data: { labels: sub.map((s) => s[0]),
      datasets: [{ label: '조회수', data: sub.map((s) => s[1]), backgroundColor: PALETTE[1], borderWidth: 0 }] },
      options: baseOptions({ indexAxis: 'y', plugins: { legend: { display: false } } }) });
  }

  function renderRanks(items) {
    const posts = aggregatePosts(items, 'RANK_POST', 'cv');
    const pTotal = sum(posts.map((p) => p.total));
    const info = postInfo(items);
    fill('m-posts', posts.slice(0, 30).map((p, i) => {
      const id = postId(p.uri);
      const total = info.get(id) && info.get(id).cvTotal;
      const cells = [
        titleCell(p.title, p.uri, i + 1), td(nf.format(p.total) + ' (' + pct(p.total, pTotal) + ')'),
        td(p.days.size + '일'), td(p.best < 1e9 ? p.best + '위' : '-'), td(total != null ? nf.format(total) : '-'),
      ];
      cells.pick = () => { selectedPost = id; renderPostTrend(lastView); $('m-post-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); };
      return cells;
    }), '이 기간에 수집된 게시글 순위가 없습니다.', 5);

    for (const [id, metric] of [['m-like', 'RANK_LIKE'], ['m-comment', 'RANK_COMMENT']]) {
      const list = aggregatePosts(items, metric, 'event').slice(0, 5);
      fill(id, list.map((p, i) => [titleCell(p.title, p.uri, i + 1), td(nf.format(p.total))]),
        '이 기간에 없습니다.', 2);
    }
  }

  function renderHourTrend(view) {
    if (!view) return;
    const dates = isoDays(view.from, view.to);
    const inRange = new Set(dates);
    const byHour = new Map(); // 시간 → 날짜 → {cv, cv_p}
    for (const it of view.items) {
      if (it.metric !== 'HOUR_TREND' || !inRange.has(it.date)) continue;
      if (!byHour.has(it.key)) byHour.set(it.key, new Map());
      byHour.get(it.key).set(it.date, it.values);
    }
    const select = $('m-ht-select');
    select.replaceChildren();
    const hours = [...byHour.keys()].sort();
    if (hours.length === 0) {
      $('m-ht-sub').textContent = '';
      draw('m-ht', false, null);
      return;
    }
    const totals = new Map(hours.map((h) => [h, sum([...byHour.get(h).values()].map((v) => v.cv))]));
    if (!hours.includes(selectedHour)) selectedHour = hours.slice().sort((a, b) => totals.get(b) - totals.get(a))[0];
    for (const h of hours) {
      const o = document.createElement('option');
      o.value = h;
      o.textContent = h + '시 (' + nf.format(totals.get(h)) + '회)';
      if (h === selectedHour) o.selected = true;
      select.appendChild(o);
    }
    const days = byHour.get(selectedHour);
    // cv_p는 15일 창 안에서의 비율이라 하루 중 비율이 아니다. cv_daily(그 날 전체)로 직접 계산한다.
    const shares = [...days.values()].filter((v) => v.cv_daily > 0).map((v) => v.cv * 100 / v.cv_daily);
    $('m-ht-sub').textContent = selectedHour + '시 · 기간 합계 ' + nf.format(totals.get(selectedHour)) + '회'
      + (shares.length ? ' · 하루 중 평균 ' + nf1.format(sum(shares) / shares.length) + '%' : '');
    draw('m-ht', true, { type: 'bar', data: { labels: dates.map((d) => d.slice(5)), datasets: [
      { label: selectedHour + '시 조회수', data: dates.map((d) => (days.has(d) ? days.get(d).cv : null)),
        backgroundColor: PALETTE[5], borderWidth: 0 },
    ] }, options: baseOptions({ plugins: { legend: { display: false } } }) });
  }

  /** ARTICLE_INFO(게시글 번호 → 제목·주소·누적 수치). 응답에는 가장 최근 수집분이 들어 있다. */
  function postInfo(items) {
    const m = new Map();
    for (const it of items) if (it.metric === 'ARTICLE_INFO') m.set(it.key, it.values);
    return m;
  }

  function renderPostTrend(view) {
    if (!view) return;
    const items = view.items;
    const dates = isoDays(view.from, view.to);
    const inRange = new Set(dates);
    const info = postInfo(items);
    const rankTitle = new Map();
    for (const it of items) if (it.metric === 'RANK_POST') rankTitle.set(postId(it.values.uri), it.values.title);

    const byPost = new Map(); // 게시글 번호 → 날짜 → 조회수
    for (const it of items) {
      if (it.metric !== 'ARTICLE_CV' || !inRange.has(it.date) || it.values.unavailable) continue;
      if (!byPost.has(it.key)) byPost.set(it.key, new Map());
      byPost.get(it.key).set(it.date, it.values.cv || 0);
    }
    const ranked = [...byPost.entries()].map(([id, m]) => ({ id, total: sum([...m.values()]), days: m }))
      .sort((a, b) => b.total - a.total).slice(0, 60);

    // 조회할 수 없는 글(HTTP 400, 순위 행의 제목·작성일도 빈 글)은 시계열이 없어도 목록에 남겨 이유를 보여 준다.
    const gone = [...info.entries()].filter(([id, v]) => v.unavailable && !byPost.has(id)).map(([id]) => id);
    const select = $('m-post-select');
    select.replaceChildren();
    if (ranked.length === 0 && gone.length === 0) {
      $('m-post-sub').textContent = '';
      $('m-post-info').textContent = '';
      draw('m-post', false, null);
      return;
    }
    if (!ranked.some((r) => r.id === selectedPost) && !gone.includes(selectedPost)) selectedPost = (ranked[0] || { id: gone[0] }).id;
    for (const r of ranked) {
      const o = document.createElement('option');
      const title = (info.get(r.id) && info.get(r.id).title) || rankTitle.get(r.id) || r.id;
      o.value = r.id;
      o.textContent = title + ' (' + nf.format(r.total) + '회)';
      if (r.id === selectedPost) o.selected = true;
      select.appendChild(o);
    }
    for (const id of gone) {
      const o = document.createElement('option');
      o.value = id;
      o.textContent = '글 ' + id + ' (삭제된 글로 보임)';
      if (id === selectedPost) o.selected = true;
      select.appendChild(o);
    }
    const cur = ranked.find((r) => r.id === selectedPost);
    $('m-post-sub').textContent = '게시글 ' + byPost.size + '개' + (cur ? ' · 이 글 기간 합계 ' + nf.format(cur.total) + '회' : '');

    const meta = $('m-post-info');
    meta.replaceChildren();
    const i = info.get(selectedPost);
    if (i && i.unavailable) {
      meta.textContent = '이 글은 조회할 수 없습니다(HTTP 400). 순위 기록에도 제목·작성일이 비어 있어 삭제된 글로 보입니다.';
    } else if (i) {
      const parts = ['누적 조회수 ' + nf.format(i.cvTotal || 0), '공감 ' + nf.format(i.likeTotal || 0),
        '댓글 ' + nf.format(i.commentTotal || 0)];
      if (i.createDate) parts.push('작성 ' + i.createDate);
      meta.appendChild(document.createTextNode(parts.join(' · ') + ' '));
      if (/^https?:\/\/blog\.naver\.com\//.test(i.url || '')) {
        const a = document.createElement('a');
        a.href = i.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
        a.textContent = '글 열기';
        meta.appendChild(a);
      }
    }
    if (!cur) { draw('m-post', false, null); return; }
    draw('m-post', true, { type: 'bar', data: { labels: dates.map((d) => d.slice(5)), datasets: [
      { label: '조회수', data: dates.map((d) => (cur.days.has(d) ? cur.days.get(d) : null)),
        backgroundColor: PALETTE[0], borderWidth: 0 },
    ] }, options: baseOptions({ plugins: { legend: { display: false } } }) });
  }

  /** 일간 현황: 그 날의 공감수·댓글수·재생수 합계(dashboard 블록). 값이 문자열로 올 수 있어 숫자로 바꾼다. */
  function renderDaily(items, dates) {
    const by = new Map();
    for (const it of items) if (it.metric === 'DAILY_SUMMARY') by.set(it.date, it.values);
    const num = (d, k) => (by.has(d) && by.get(d)[k] != null ? Number(by.get(d)[k]) : null);
    const like = dates.map((d) => num(d, 'dailyLike')), cmt = dates.map((d) => num(d, 'dailyComment')),
      play = dates.map((d) => num(d, 'dailyPlayCount'));
    $('m-daily-sub').textContent = by.size ? '공감 ' + nf.format(sum(like)) + ' · 댓글 ' + nf.format(sum(cmt)) + ' · 재생 ' + nf.format(sum(play)) : '';
    draw('m-daily', by.size > 0, { type: 'bar', data: { labels: dates.map((d) => d.slice(5)), datasets: [
      { label: '공감', data: like, backgroundColor: PALETTE[4], borderWidth: 0 },
      { label: '댓글', data: cmt, backgroundColor: PALETTE[1], borderWidth: 0 },
      { label: '재생', data: play, backgroundColor: PALETTE[0], borderWidth: 0 },
    ] }, options: baseOptions() });
  }

  function renderVideo(items) {
    const m = new Map();
    for (const it of items) {
      if (it.metric !== 'VIDEO_RANK') continue;
      const k = it.values.vid || it.values.videoTitle;
      const e = m.get(k) || { title: it.values.videoTitle, uri: it.values.uri, days: new Set(), best: 1e9 };
      e.days.add(it.date);
      e.best = Math.min(e.best, it.values.rank || 1e9);
      m.set(k, e);
    }
    const list = [...m.values()].sort((a, b) => b.days.size - a.days.size || a.best - b.best);
    fill('m-video', list.map((v, i) => [titleCell(v.title, v.uri, i + 1), td(v.days.size + '일'),
      td(v.best < 1e9 ? v.best + '위' : '-')]), '이 기간에 재생 순위에 오른 동영상이 없습니다.', 3);
  }

  /** 서비스 평균·상위 그룹 평균과의 월간 비교. 내 값은 조회 기간 기준이다. */
  function renderUpper(view) {
    const items = view.items.filter((i) => i.metric === 'UPPER_GROUP');
    const rows = new Map(items.map((i) => [i.key, i.values]));
    const month = items.length ? items[0].date : null;
    $('m-up-sub').textContent = month ? month.slice(0, 7).replace('-', '년 ') + '월 기준' : '';
    const views = sum([...series(view.items, 'VIEWS', 'total').values()]);
    const visits = sum([...series(view.items, 'VISITS', 'visit').values()]);
    const durArr = [...series(view.items, 'DURATION', 'total').values()].filter((v) => v > 0);
    const mine = { cv: views, visit: visits, uv: null, duration: durArr.length ? sum(durArr) / durArr.length : null };
    const avgUser = rows.get('value') || {};
    const fmt = (key, v) => (v == null ? '-' : key === 'duration' ? fmtDur(v) : nf.format(Math.round(v * 10) / 10));
    const labels = [['cv', '조회수'], ['uv', '순방문자'], ['visit', '방문횟수'], ['duration', '평균 사용시간']];
    fill('m-upper', rows.size === 0 ? [] : labels.map(([k, name]) => {
      const g = rows.get(k) || {};
      return [td(name), td(fmt(k, mine[k])), td(fmt(k, g.service_avg)), td(fmt(k, g.top_avg)), td(fmt(k, g.max)),
        td(fmt(k, avgUser[k]))];
    }), '비교 지표가 아직 수집되지 않았습니다.', 6);
  }

  function renderWeekly(items) {
    const rev = series(items, 'REVISIT_WEEKLY', 'total_p');
    const avg = series(items, 'AVG_VISIT_WEEKLY', 'total');
    const weeks = [...new Set([...rev.keys(), ...avg.keys()])].sort().reverse();
    fill('m-weekly', weeks.map((w) => [td(w.slice(5).replace('-', '/') + ' 주'),
      td(rev.has(w) ? nf1.format(rev.get(w)) + '%' : '-'), td(avg.has(w) ? nf.format(avg.get(w)) : '-')]),
      '이 기간에 수집된 주간 지표가 없습니다.', 3);
  }

  function renderCoverage(view) {
    fill('m-coverage', view.coverage.map((c) => [td(c.metric), td(nf.format(c.rows)), td(c.firstDate), td(c.lastDate)]),
      '수집된 지표가 없습니다.', 4);
  }

  function render(view) {
    lastView = view;
    const dates = isoDays(view.from, view.to);
    $('m-range').textContent = view.from + ' ~ ' + view.to + ' · 지표 ' + view.coverage.length + '종 수집됨';
    renderCards(view.items, dates);
    renderTimeCharts(view.items, dates);
    renderDistributions(view.items);
    renderRanks(view.items);
    renderHourTrend(view);
    renderDaily(view.items, dates);
    renderVideo(view.items);
    renderPostTrend(view);
    renderUpper(view);
    renderWeekly(view.items);
    renderCoverage(view);
    const latest = view.latest;
    const hours = view.items.some((i) => i.metric === 'HOUR' && i.date === latest);
    $('m-note').textContent = '순방문자와 시간대별 조회수는 네이버가 어제분을 늦게 집계해서, 확정 전에는 비어 있거나 빠집니다. '
      + '다음 수집 때 채워집니다.' + (hours ? '' : ' (최근 ' + latest + ' 시간대 값은 아직 없음)');
  }

  async function load(range) {
    const my = ++seq;
    const empty = $('m-empty'), body = $('m-body');
    try {
      const res = await fetch('/api/dashboard/metrics?' + new URLSearchParams(range || {}).toString());
      if (!res.ok) {
        let detail = '';
        try { detail = (await res.json()).message || ''; } catch (e) { /* 본문 없음 */ }
        throw new Error(detail || ('HTTP ' + res.status));
      }
      const view = await res.json();
      if (my !== seq) return; // 더 최근 요청이 있으면 이 응답은 버린다.
      if (!view.ready) {
        body.hidden = true;
        empty.textContent = '블로그 지표가 아직 수집되지 않았습니다. 팝업에서 "지금 수집"을 누르거나, 백업·가져오기에서 기존 데이터를 가져오면 이 섹션이 채워집니다.';
        empty.hidden = false;
        $('m-range').textContent = '';
        return;
      }
      empty.hidden = true;
      body.hidden = false;
      render(view);
    } catch (e) {
      if (my !== seq) return;
      body.hidden = true;
      empty.textContent = '지표를 불러오지 못했습니다: ' + e.message;
      empty.hidden = false;
    }
  }

  window.addEventListener('blog:range', (e) => load(e.detail));

  // 성별·연령: 방문자 구분 버튼
  document.querySelectorAll('#m-demo-seg button').forEach((b) => b.addEventListener('click', () => {
    demoMode = b.dataset.m;
    document.querySelectorAll('#m-demo-seg button').forEach((x) => x.classList.toggle('active', x === b));
    if (lastView) renderDemo(lastView.items);
  }));
  $('m-ht-select').addEventListener('change', (e) => { selectedHour = e.target.value; renderHourTrend(lastView); });
  // 게시글 추이: 선택한 글 바꾸기
  $('m-post-select').addEventListener('change', (e) => { selectedPost = e.target.value; renderPostTrend(lastView); });
})();
