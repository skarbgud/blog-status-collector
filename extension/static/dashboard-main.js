// Java 대시보드(src/main/resources/static/index.html)의 개요·유입경로·검색어 스크립트. 확장 CSP가 인라인 스크립트를 막아 파일로 뺐다.
// /api/dashboard/* 요청은 dashboard-api.js가 오프스크린의 로컬 조회 계층으로 돌린다.
(function () {
  const $ = (id) => document.getElementById(id);
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const nf = new Intl.NumberFormat('ko-KR');
  let dailyChart = null, shareChart = null;

  function iso(d) {
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  async function get(path, params) {
    const qs = new URLSearchParams(params).toString();
    const res = await fetch(path + '?' + qs);
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).message || ''; } catch (e) { /* 본문 없음 */ }
      throw new Error(detail || ('HTTP ' + res.status));
    }
    return res.json();
  }

  function render(summary, daily, referrers) {
    $('from').value = summary.from;
    $('to').value = summary.to;
    $('c-total').textContent = nf.format(summary.totalVisits);
    $('c-search').textContent = nf.format(summary.searchVisits);
    $('c-ratio').textContent = summary.searchRatio.toFixed(1) + '%';
    $('c-days').textContent = summary.collectedDays + ' / ' + summary.totalDays + '일';
    $('ov-range').textContent = summary.from.replace(/-/g, '.') + ' ~ ' + summary.to.replace(/-/g, '.');

    // 계열색은 tokens.css의 --chart-*를 정해진 순서로 쓴다(dataviz 검증 팔레트).
    const c1 = css('--chart-1'), c2 = css('--chart-2');
    if (dailyChart) dailyChart.destroy();
    dailyChart = BlogCharts.draw($('daily'), {
      kind: 'line', title: '일별 방문 추이', fill: false, // 두 계열의 채움이 겹치면 탁해 보여 선만 그린다
      categories: daily.map((d) => d.date.slice(5)),
      series: [
        { name: '전체', data: daily.map((d) => d.visits), color: c1 },
        { name: '검색', data: daily.map((d) => d.searchVisits), color: c2 },
      ],
    });

    // 색은 여섯 개까지만 쓰고(돌려 쓰지 않는다) 7위부터는 '그 외' 한 조각으로 묶는다. 순위 표에는 모두 나온다.
    const palette = [1, 2, 3, 4, 5, 6].map((i) => css('--chart-' + i));
    const top = referrers.slice(0, palette.length);
    const rest = referrers.slice(palette.length);
    const slices = top.map((r, i) => ({ name: r.name, y: r.visits, color: palette[i] }));
    if (rest.length > 0) {
      slices.push({ name: '그 외 ' + rest.length + '곳', y: rest.reduce((a, r) => a + r.visits, 0), color: css('--chart-other') });
    }
    if (shareChart) shareChart.destroy();
    shareChart = BlogCharts.draw($('share'), {
      kind: 'donut', title: '유입처 비율',
      series: [{ name: '방문', data: slices }],
    });

    // 유입처 이름은 외부 값이므로 innerHTML을 쓰지 않고 textContent로만 넣는다.
    const body = $('rank');
    body.replaceChildren();
    for (const r of referrers) {
      const tr = document.createElement('tr');
      const name = document.createElement('td');
      name.textContent = r.name;
      if (r.searchEngine) {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = '검색';
        name.appendChild(tag);
      }
      const v = document.createElement('td');
      v.textContent = nf.format(r.visits);
      const p = document.createElement('td');
      p.textContent = r.ratio.toFixed(1) + '%';
      tr.append(name, v, p);
      body.appendChild(tr);
    }
  }

  // 검색어는 외부(검색 사용자) 입력이므로 innerHTML을 쓰지 않고 textContent로만 넣는다.
  let allQueries = [];

  // 검색어가 실제로 들어온 날짜마다 뱃지를 하나씩 붙인다('MM/DD').
  // 날짜가 많으면 최근 MAX_BADGES개만 보이고, 나머지는 '+N' 뱃지 툴팁으로 보여준다.
  const MAX_BADGES = 7;
  function dateBadges(dates) {
    const wrap = document.createElement('span');
    wrap.className = 'badges';
    if (!dates || dates.length === 0) return wrap;
    const md = (d) => d.slice(5).replace('-', '/');
    const hidden = dates.length > MAX_BADGES ? dates.slice(0, dates.length - MAX_BADGES) : [];
    const shown = dates.slice(hidden.length);
    if (hidden.length > 0) {
      const more = document.createElement('span');
      more.className = 'badge more';
      more.textContent = '+' + hidden.length;
      more.title = hidden.join(', ');
      wrap.appendChild(more);
    }
    for (const d of shown) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = md(d);
      badge.title = d;
      wrap.appendChild(badge);
    }
    return wrap;
  }

  function renderQueries(report) {
    allQueries = report.items;
    $('q-count').textContent = '서로 다른 검색어 ' + nf.format(report.distinctQueries) + '개 · 방문 '
      + nf.format(report.totalVisits) + '회'
      + (report.truncated ? ' · 상위 ' + nf.format(report.items.length) + '개만 표시' : '');
    drawQueries();
  }

  function drawQueries() {
    const kw = $('q-filter').value.trim().toLowerCase();
    const rows = kw ? allQueries.filter((q) => q.query.toLowerCase().includes(kw)) : allQueries;
    const body = $('queries');
    body.replaceChildren();
    if (rows.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 5;
      td.style.textAlign = 'left';
      td.textContent = allQueries.length === 0 ? '이 기간에 수집된 검색어가 없습니다.' : '일치하는 검색어가 없습니다.';
      tr.appendChild(td);
      body.appendChild(tr);
      return;
    }
    rows.forEach((q, i) => {
      const tr = document.createElement('tr');
      tr.title = '유입처: ' + q.sources.join(', '); // 레일에서 숨긴 유입처 열 대신
      const cells = [String(i + 1), q.query, nf.format(q.visits), String(q.days), q.sources.join(', ')];
      cells.forEach((text, col) => {
        const td = document.createElement('td');
        td.textContent = text;
        if (col === 1) td.appendChild(dateBadges(q.dates));
        tr.appendChild(td);
      });
      body.appendChild(tr);
    });
  }

  // 개요 화면 상태: 'loading' | 'empty' | 'error' | null(데이터 있음). 다른 화면은 위쪽 #msg 한 줄로 안내한다.
  let lastParams = {};
  function setState(kind, detail) {
    const ov = $('overview');
    ov.classList.toggle('is-loading', kind === 'loading');
    ov.classList.toggle('is-empty', kind === 'empty');
    ov.classList.toggle('is-error', kind === 'error');
    const box = $('ov-state');
    const action = $('ov-state-action');
    box.hidden = kind !== 'empty' && kind !== 'error';
    action.hidden = true;
    action.onclick = null;
    if (kind === 'empty') {
      $('ov-state-title').textContent = '이 기간에는 모은 데이터가 없어요';
      $('ov-state-desc').textContent = '기간을 넓혀 보거나, 확장 아이콘을 눌러 수집을 시작해 보세요.';
      const wide = document.querySelector('[data-days="90"]');
      if (wide && wide.offsetParent !== null && !wide.classList.contains('active')) {
        action.textContent = '최근 90일 보기';
        action.onclick = () => wide.click();
        action.hidden = false;
      }
    } else if (kind === 'error') {
      $('ov-state-title').textContent = '데이터를 불러오지 못했어요';
      // 사람이 읽을 수 있는 안내(공유 링크 오류 등)는 그대로, 기술 메시지는 일반 안내로 바꾼다.
      const readable = detail && /[가-힣]/.test(detail) && !/HTTP|Error|undefined/.test(detail);
      $('ov-state-desc').textContent = readable ? detail : '잠시 후 다시 불러와 보세요. 계속 안 되면 대시보드 탭을 닫았다가 다시 열어 주세요.';
      box.title = detail || '';
      action.textContent = '다시 불러오기';
      action.onclick = () => load(lastParams);
      action.hidden = false;
    }
  }

  // 처리 중에는 기간 버튼을 잠가 중복 조회를 막는다.
  function lockControls(on) {
    document.querySelectorAll('[data-days], #apply').forEach((b) => { b.disabled = on; });
  }

  async function load(params) {
    lastParams = params;
    $('msg').textContent = '불러오는 중이에요…';
    $('msg').title = '';
    setState('loading');
    lockControls(true);
    try {
      const summary = await get('/api/dashboard/summary', params);
      const range = { from: summary.from, to: summary.to };
      // 블로그 지표 섹션(아래 별도 스크립트)이 같은 기간으로 다시 그리도록 알린다.
      window.dispatchEvent(new CustomEvent('blog:range', { detail: range }));
      const [daily, referrers, queries] = await Promise.all([
        get('/api/dashboard/daily', range),
        get('/api/dashboard/referrers', Object.assign({ limit: 10 }, range)),
        get('/api/dashboard/queries', Object.assign({ limit: 1000 }, range)),
      ]);
      render(summary, daily, referrers);
      renderQueries(queries);
      $('s-latest').textContent = summary.latestDate || '없음';
      const empty = summary.collectedDays === 0;
      $('msg').textContent = empty ? '이 기간에는 모은 데이터가 없어요.' : '';
      setState(empty ? 'empty' : null);
    } catch (e) {
      $('msg').textContent = '데이터를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.';
      $('msg').title = e.message;
      setState('error', e.message);
      // 유입경로 조회가 실패해도 지표 섹션은 자기 기간으로 따로 그린다.
      window.dispatchEvent(new CustomEvent('blog:range', { detail: params }));
    } finally {
      lockControls(false);
    }
  }

  // 로그인 쿠키 만료 경고. 문구는 서버가 만든 값이지만 innerHTML 없이 textContent로만 넣는다.
  async function loadSession() {
    const banner = $('session-banner');
    const side = $('s-session');
    try {
      const s = await get('/api/dashboard/session', {});
      const level = s.state === 'OK' ? 'ok' : (s.state === 'EXPIRED' || s.state === 'MISSING' ? 'danger' : 'warn');
      side.textContent = s.daysLeft == null ? (s.state === 'OK' ? '정상' : '확인 필요')
        : (s.daysLeft < 0 ? '만료' : 'D-' + s.daysLeft);
      side.className = level;
      side.title = s.message || '';
      if (s.state === 'OK') {
        banner.hidden = true;
        return;
      }
      banner.textContent = s.message;
      banner.className = 'banner ' + level;
      banner.hidden = false;
    } catch (e) {
      banner.hidden = true; // 경고를 못 가져와도 대시보드 본문은 계속 보여 준다.
      side.textContent = '-';
    }
  }

  function setActive(btn) {
    document.querySelectorAll('[data-days]').forEach((b) => b.classList.toggle('active', b === btn));
  }

  document.querySelectorAll('[data-days]').forEach((b) => b.addEventListener('click', async () => {
    setActive(b);
    // 기준일은 서버가 정한 최근 저장일이다(오늘 기준이 아님). to만 비우고 from을 맞춘다.
    const latest = (await get('/api/dashboard/summary', {})).to;
    const to = new Date(latest + 'T00:00:00');
    const from = new Date(to);
    from.setDate(from.getDate() - (Number(b.dataset.days) - 1));
    load({ from: iso(from), to: latest });
  }));

  $('apply').addEventListener('click', () => {
    setActive(null);
    const params = {};
    if ($('from').value) params.from = $('from').value;
    if ($('to').value) params.to = $('to').value;
    load(params);
  });

  $('q-filter').addEventListener('input', drawQueries);

  loadSession();
  load({});
})();
