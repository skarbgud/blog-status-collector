// 사용시간 합계 화면: 크리에이터 어드바이저 content-summary를 이 탭을 볼 때 바로 불러(저장하지 않음)
// 기간별(일·주·월)과 게시글별로 더해 보여 준다. 사용시간 = 조회수 × 평균 사용시간(초)의 합.
// 다른 화면을 보는 동안에는 부르지 않는다: 사이드바 기간이 바뀌면 기억만 해 두고, 이 탭이 보일 때 받는다.
// 데이터: /api/dashboard/post-duration?from&to&unit(=day|week|month)[&refresh=1] (오프스크린이 바로 부름, 10분 동안 같은 값 재사용)
// 게시글 제목은 외부 값이므로 textContent로만 넣는다.
(function () {
  const $ = (id) => document.getElementById(id);
  const nf = new Intl.NumberFormat('ko-KR');
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const section = document.querySelector('[data-view="duration"]');
  let data = null;
  let unit = 'day';
  let range = null;
  /** 마지막으로 받은 (기간, 단위). 바뀌었으면 탭이 보일 때 다시 받는다 */
  let loadedKey = null;
  let chart = null;
  let seq = 0;

  /** 초 → "2시간 52분", "4분 3초", "12초" */
  function dur(sec) {
    const s = Math.round(sec);
    if (s < 60) return s + '초';
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h > 0) return h + '시간' + (m ? ' ' + m + '분' : '');
    const r = s % 60;
    return m + '분' + (r ? ' ' + r + '초' : '');
  }
  const md = (d) => d.slice(5).replace('-', '/');
  function addDays(d, n) {
    const t = new Date(d + 'T00:00:00Z');
    t.setUTCDate(t.getUTCDate() + n);
    return t.toISOString().slice(0, 10);
  }
  const hm = (iso) => new Date(iso).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  async function get(params) {
    const res = await fetch('/api/dashboard/post-duration?' + new URLSearchParams(params).toString());
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).message || ''; } catch (e) { /* 본문 없음 */ }
      throw new Error(detail || ('HTTP ' + res.status));
    }
    return res.json();
  }

  function state(title, desc, retry) {
    $('du-body').hidden = true;
    $('du-state').hidden = false;
    $('du-state-title').textContent = title;
    $('du-state-desc').textContent = desc;
    $('du-retry').hidden = !retry;
  }

  function periodLabel(p) {
    if (data.unit === 'day') return md(p.date);
    if (data.unit === 'week') return md(p.date) + '~' + md(addDays(p.date, 6));
    return p.date.slice(0, 4) + '년 ' + Number(p.date.slice(5, 7)) + '월';
  }

  function renderPeriods() {
    document.querySelectorAll('#du-unit button').forEach((b) => b.classList.toggle('active', b.dataset.u === data.unit));
    const items = data.periods;
    if (chart) chart.destroy();
    chart = BlogCharts.draw($('du-chart'), {
      kind: 'column',
      categories: items.map(periodLabel),
      series: [{ name: '사용시간(분)', data: items.map((p) => Math.round(p.seconds / 6) / 10), color: css('--chart-1') || css('--c1') }],
      decimals: 1,
      valueFormat: (v) => dur(v * 60),
      axisFormat: (v) => nf.format(v) + '분',
    });
    const body = $('du-periods');
    body.replaceChildren();
    for (const p of items.slice().reverse()) {
      const tr = el('tr');
      tr.append(el('td', null, periodLabel(p)), el('td', null, nf.format(p.views)), el('td', null, dur(p.seconds)),
        el('td', null, p.views ? dur(p.seconds / p.views) : '-'));
      body.appendChild(tr);
    }
  }

  function renderPosts() {
    const body = $('du-posts');
    body.replaceChildren();
    const unitName = { day: '일', week: '주', month: '달' }[data.unit];
    for (const p of data.posts) {
      const tr = el('tr');
      const name = el('td');
      name.appendChild(el('span', 'du-post', p.title || '게시글 ' + p.postId));
      name.appendChild(el('span', 'du-sub', '조회된 ' + unitName + ' ' + p.periods + '개' + (p.likes ? ' · 공감 ' + nf.format(p.likes) : '')));
      tr.append(name, el('td', null, nf.format(p.views)), el('td', null, dur(p.seconds)), el('td', null, dur(p.average)));
      body.appendChild(tr);
    }
  }

  function render() {
    $('du-range').textContent = data.from + ' ~ ' + data.to;
    if (data.postCount === 0) {
      state('이 기간에 조회된 게시글이 없어요', '기간을 바꿔 보세요. 게시글 조회수 순위가 수집된 날의 글을 봐요.', false);
      return;
    }
    if (data.stopped && data.posts.length === 0) {
      state('사용시간을 받지 못했어요', data.stopped, true);
      return;
    }
    $('du-state').hidden = true;
    $('du-body').hidden = false;
    $('du-total').textContent = dur(data.total.seconds);
    $('du-avg').textContent = data.total.views ? dur(data.total.seconds / data.total.views) : '-';
    $('du-views').textContent = nf.format(data.total.views);
    $('du-count').textContent = nf.format(data.postCount) + '개';
    const warn = data.stopped ? ' ' + data.stopped
      : data.failures > 0 ? ' 게시글 ' + nf.format(data.failures) + '건을 받지 못해 실제보다 적게 보일 수 있어요.' : '';
    $('du-note').textContent = hm(data.fetchedAt) + ' 기준 · 크리에이터 어드바이저에서 바로 받은 값이에요(저장하지 않아요).'
      + (data.unit === 'day' ? '' : ' 주·월은 기간 첫 주·첫 달 전체를 포함해요.') + warn;
    renderPeriods();
    renderPosts();
  }

  async function load(refresh) {
    if (!range || !range.from || !range.to) return;
    const my = ++seq;
    const key = unit + '|' + range.from + '|' + range.to;
    loadedKey = key;
    $('du-refresh').disabled = true;
    if (!data || refresh) state('사용시간을 받는 중이에요', '게시글마다 크리에이터 어드바이저에 물어봐서 몇 초 걸려요.', false);
    try {
      const d = await get(Object.assign({ from: range.from, to: range.to, unit }, refresh ? { refresh: '1' } : {}));
      if (my !== seq) return;
      // 화면 파일은 새로 읽혔는데 확장 백그라운드(오프스크린)가 예전 버전으로 떠 있으면 응답 모양이 다르다
      if (!d || !Array.isArray(d.periods) || !Array.isArray(d.posts) || !d.total) {
        data = null;
        loadedKey = null;
        state('확장을 새로고침해 주세요', 'chrome://extensions에서 이 확장의 새로고침(↻)을 누른 뒤 이 탭을 다시 열어 주세요. 화면과 확장의 버전이 달라요.', false);
        return;
      }
      data = d;
      unit = d.unit || unit; // 공유 화면은 받은 단위 그대로 보여 준다
      loadedKey = unit + '|' + range.from + '|' + range.to;
      render();
    } catch (e) {
      if (my !== seq) return;
      data = null;
      loadedKey = null;
      state('사용시간을 받지 못했어요', e.message, true);
    } finally {
      if (my === seq) $('du-refresh').disabled = false;
    }
  }

  /** 이 탭이 보이고, 받은 값과 기간·단위가 다를 때만 받는다(다른 화면에서는 요청하지 않음). */
  function maybeLoad() {
    if (section.hidden || !range) return;
    if (loadedKey !== unit + '|' + range.from + '|' + range.to) load(false);
  }

  document.querySelectorAll('#du-unit button').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.u === unit && data) return;
    unit = b.dataset.u;
    document.querySelectorAll('#du-unit button').forEach((x) => x.classList.toggle('active', x === b));
    load(false);
  }));
  $('du-refresh').addEventListener('click', () => load(true));
  $('du-retry').addEventListener('click', () => load(true));
  window.addEventListener('blog:range', (e) => { range = e.detail; maybeLoad(); });
  window.addEventListener('blog:view', () => maybeLoad());
})();
