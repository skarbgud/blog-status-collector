// 사용시간 합계 화면: 게시글별 사용시간(크리에이터 어드바이저, POST_DURATION)을
// 기간별(일·주·월)과 게시글별로 더해 보여 준다. 사용시간 = 조회수 × 평균 사용시간(초)의 합.
// 사이드바 기간이 바뀌면(blog:range) /api/dashboard/post-duration을 다시 부른다.
// 게시글 제목은 외부 값이므로 textContent로만 넣는다.
(function () {
  const $ = (id) => document.getElementById(id);
  const nf = new Intl.NumberFormat('ko-KR');
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  let data = null;
  let unit = 'daily';
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

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  async function get(range) {
    const res = await fetch('/api/dashboard/post-duration?' + new URLSearchParams(range || {}).toString());
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).message || ''; } catch (e) { /* 본문 없음 */ }
      throw new Error(detail || ('HTTP ' + res.status));
    }
    return res.json();
  }

  function state(title, desc) {
    $('du-body').hidden = true;
    $('du-state').hidden = false;
    $('du-state-title').textContent = title;
    $('du-state-desc').textContent = desc;
  }

  function periodLabel(p) {
    if (unit === 'daily') return md(p.date);
    if (unit === 'weekly') return md(p.from) + '~' + md(p.to) + (p.partial ? ' (일부)' : '');
    return p.key.replace('-', '년 ') + '월' + (p.partial ? ' (일부)' : '');
  }

  function renderPeriods() {
    document.querySelectorAll('#du-unit button').forEach((b) => b.classList.toggle('active', b.dataset.u === unit));
    const items = data[unit];
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
    if (data.posts.length === 0) {
      const tr = el('tr');
      const td = el('td', 'du-sub', '이 기간에 사용시간을 받은 게시글이 없어요.');
      td.colSpan = 4;
      tr.appendChild(td);
      body.appendChild(tr);
      return;
    }
    for (const p of data.posts) {
      const tr = el('tr');
      const name = el('td');
      name.appendChild(el('span', 'du-post', p.title || '게시글 ' + p.postId));
      name.appendChild(el('span', 'du-sub', '조회된 날 ' + p.days + '일' + (p.likes ? ' · 공감 ' + nf.format(p.likes) : '')));
      tr.append(name, el('td', null, nf.format(p.views)), el('td', null, dur(p.seconds)), el('td', null, dur(p.average)));
      body.appendChild(tr);
    }
  }

  function render() {
    const c = data.coverage;
    $('du-range').textContent = data.from + ' ~ ' + data.to;
    if (c.need === 0 && data.total.views === 0) {
      state('이 기간에 조회된 게시글이 없어요', '기간을 바꿔 보세요. 게시글 순위가 수집된 날만 계산해요.');
      return;
    }
    if (c.have === 0 && data.total.views === 0) {
      state('아직 사용시간을 받지 않았어요', '팝업에서 "지금 수집"을 누르면 게시글별 사용시간을 받아요. 다 받은 뒤 이 화면을 새로고침해 주세요.');
      return;
    }
    $('du-state').hidden = true;
    $('du-body').hidden = false;
    $('du-total').textContent = dur(data.total.seconds);
    $('du-avg').textContent = data.total.views ? dur(data.total.seconds / data.total.views) : '-';
    $('du-views').textContent = nf.format(data.total.views);
    $('du-cover').textContent = c.need ? Math.floor((c.have * 100) / c.need) + '%' : '-';
    $('du-note').textContent = '사용시간은 조회수 × 평균 사용시간(크리에이터 어드바이저)을 게시글마다 더한 값이에요. 주·월은 일 값을 더해서 구해요.'
      + (c.need > c.have ? ' 아직 받지 못한 (게시글, 날짜) ' + nf.format(c.need - c.have) + '개가 있어 실제보다 적게 보일 수 있어요. 다음 수집에서 채워요.' : '');
    renderPeriods();
    renderPosts();
  }

  async function load(range) {
    const my = ++seq;
    try {
      const d = await get(range);
      if (my !== seq) return;
      data = d;
      render();
    } catch (e) {
      if (my !== seq) return;
      data = null;
      state('사용시간을 불러오지 못했어요', '잠시 뒤 다시 열어 주세요. (' + e.message + ')');
    }
  }

  document.querySelectorAll('#du-unit button').forEach((b) => b.addEventListener('click', () => {
    if (!data || b.dataset.u === unit) return;
    unit = b.dataset.u;
    renderPeriods();
  }));
  window.addEventListener('blog:range', (e) => load(e.detail));
})();
