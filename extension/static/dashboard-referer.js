// 유입분석 탭: 모든 유입처의 상세 유입경로(URL·검색어)를 처음부터 펼쳐 전문으로 보여 준다.
// 사이드바 기간이 바뀌면(blog:range) 다시 불러온다. 데이터는 /api/dashboard/referrer-details, place-queries.
// URL·검색어·라벨은 외부 값이므로 textContent로만 넣고(innerHTML 금지), 링크는 http(s) URL만 만든다.
(function () {
  const $ = (id) => document.getElementById(id);
  const nf = new Intl.NumberFormat('ko-KR');
  const pct = (v) => v.toFixed(2) + '%';
  const OWN = new Set(['내 글에서 이동', '내 블로그 글 목록', '내 블로그 홈', '내 이웃 관리 화면']);
  let data = null;
  let seq = 0;
  let open = true;

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  const isHttp = (s) => /^https?:\/\//i.test(s);
  function decode(s) {
    try { return decodeURIComponent(s); } catch (e) { return s; }
  }

  async function get(name, range) {
    const res = await fetch('/api/dashboard/' + name + '?' + new URLSearchParams(range || {}).toString());
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).message || ''; } catch (e) { /* 본문 없음 */ }
      throw new Error(detail || ('HTTP ' + res.status));
    }
    return res.json();
  }

  function matches(d, q) {
    if (!q) return true;
    const hay = [d.label, d.text, d.kind === 'url' ? decode(d.text) : '', d.placeQuery || '', d.postTitle || '']
      .concat(d.tags || []).join('\n').toLowerCase();
    return hay.includes(q);
  }

  function copyButton(text) {
    const b = el('button', null, '복사');
    b.type = 'button';
    b.title = '원문을 클립보드에 복사';
    b.addEventListener('click', async (ev) => {
      ev.preventDefault();
      try {
        await navigator.clipboard.writeText(text);
        b.textContent = '복사됨';
      } catch (e) {
        b.textContent = '실패';
      }
      setTimeout(() => { b.textContent = '복사'; }, 1200);
    });
    return b;
  }

  function row(d) {
    const li = el('li', 'rf-row');
    li.append(el('span', 'rf-v', nf.format(d.visits)), el('span', 'rf-p', pct(d.ratio)));
    const main = el('div', 'rf-main');
    const head = el('div');
    head.appendChild(el('span', 'rf-label', d.label));
    if (d.postTitle) head.appendChild(el('span', 'rf-chip', d.postTitle));
    for (const t of d.tags || []) head.appendChild(el('span', 'rf-chip', t));
    if (d.placeQuery) head.appendChild(el('span', 'rf-chip q', '검색어: ' + d.placeQuery));
    main.appendChild(head);
    if (d.kind === 'url') {
      const shown = decode(d.text);
      const t = el('div', 'rf-text', shown);
      if (shown !== d.text) t.title = '원문: ' + d.text;
      main.appendChild(t);
    } else {
      main.appendChild(el('div', 'rf-text q', d.text));
    }
    const act = el('div', 'rf-act');
    act.appendChild(copyButton(d.text));
    if (d.kind === 'url' && isHttp(d.text)) {
      const a = el('a', null, '열기');
      a.href = d.text;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      act.appendChild(a);
    }
    li.append(main, act);
    return li;
  }

  function render() {
    const list = $('r-list');
    list.replaceChildren();
    if (!data) return;
    const q = $('r-filter').value.trim().toLowerCase();
    const hideOwn = $('r-hide-own').checked;
    let shownRefs = 0;
    for (const r of data.referrers) {
      const nameHit = q && r.name.toLowerCase().includes(q);
      const rows = r.details.filter((d) => !(hideOwn && OWN.has(d.label)) && (nameHit || matches(d, q)));
      if (q && !nameHit && rows.length === 0) continue;
      shownRefs++;
      const box = el('details', 'rf-ref');
      box.open = open;
      const sum = el('summary');
      const name = el('span', 'rf-name', r.name);
      if (r.searchEngine) name.appendChild(el('span', 'tag', '검색'));
      const num = el('span', 'rf-num');
      num.append(el('b', null, nf.format(r.visits)), document.createTextNode(' · ' + pct(r.ratio) + ' · 상세 ' + r.details.length));
      sum.append(name, num);
      const missing = r.days - r.detailDays;
      if (missing > 0) sum.appendChild(el('span', 'rf-badge', '상세 미수집 ' + missing + '일'));
      if (r.partialDays > 0) {
        const b = el('span', 'rf-badge warn', '일부만 수집 ' + r.partialDays + '일');
        b.title = '그 날 상세 방문수 합이 유입처 방문수와 다릅니다(네이버가 일부만 주었거나 상한에 걸림).';
        sum.appendChild(b);
      }
      box.appendChild(sum);
      if (rows.length > 0) {
        const ol = el('ol', 'rf-rows');
        for (const d of rows) ol.appendChild(row(d));
        box.appendChild(ol);
      } else {
        box.appendChild(el('div', 'rf-empty', r.details.length === 0
          ? (r.searchEngine ? '이 기간에 받은 검색어가 없습니다.' : '상세 URL을 아직 받지 않았습니다.')
          : '숨긴 줄만 있습니다.'));
      }
      list.appendChild(box);
    }
    if (shownRefs === 0) list.appendChild(el('p', 'rf-empty', q ? '찾는 줄이 없습니다.' : '이 기간에 유입경로가 없습니다.'));
    $('r-foot').textContent = data.unclassified > 0 ? '분류 안 됨 ' + nf.format(data.unclassified) + '개 (라벨 대신 주소로 표시)' : '';
  }

  function renderPlaces(items) {
    const body = $('r-place');
    body.replaceChildren();
    $('r-place-sub').textContent = items.length ? '플레이스 주소에 담긴 검색어 ' + items.length + '개' : '';
    if (items.length === 0) {
      const tr = el('tr');
      const td = el('td', null, '이 기간에 플레이스 검색어가 없습니다.');
      td.colSpan = 3;
      td.style.color = 'var(--muted)';
      tr.appendChild(td);
      body.appendChild(tr);
      return;
    }
    for (const p of items) {
      const tr = el('tr');
      tr.append(el('td', null, p.query), el('td', null, nf.format(p.visits)), el('td', null, p.places.join(', ')));
      body.appendChild(tr);
    }
  }

  async function load(range) {
    const my = ++seq;
    $('r-note').textContent = '불러오는 중…';
    try {
      const [details, places] = await Promise.all([get('referrer-details', range), get('place-queries', range)]);
      if (my !== seq) return;
      data = details;
      $('r-range').textContent = details.from + ' ~ ' + details.to + ' · 유입 ' + nf.format(details.total) + '회 · 유입처 ' + details.referrers.length + '곳';
      const noUrl = details.referrers.some((r) => !r.searchEngine && r.detailDays < r.days);
      $('r-note').textContent = noUrl ? '검색 아닌 유입처의 상세 URL은 수집된 날만 보입니다. 비율은 기간 전체 유입 대비입니다.' : '비율은 기간 전체 유입 대비입니다.';
      render();
      renderPlaces(places);
    } catch (e) {
      if (my !== seq) return;
      data = null;
      $('r-list').replaceChildren();
      $('r-note').textContent = '유입분석을 불러오지 못했습니다: ' + e.message;
    }
  }

  // CSV(UTF-8 BOM). 스프레드시트 수식으로 읽히지 않게 =,+,-,@로 시작하는 칸은 앞에 '를 붙인다.
  function csvCell(v) {
    let s = String(v == null ? '' : v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function exportCsv() {
    if (!data) return;
    const range = data.from + '~' + data.to;
    const lines = [['날짜범위', '유입처', '종류', '방문수', '비율', '라벨', '원문'].join(',')];
    for (const r of data.referrers) {
      for (const d of r.details) {
        const label = [d.label].concat(d.postTitle ? [d.postTitle] : [], d.tags || [], d.placeQuery ? ['검색어: ' + d.placeQuery] : []).join(' / ');
        lines.push([range, r.name, d.kind === 'url' ? 'URL' : '검색어', d.visits, d.ratio.toFixed(2), label, d.text].map(csvCell).join(','));
      }
    }
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = '유입분석_' + data.from + '_' + data.to + '.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  $('r-filter').addEventListener('input', render);
  $('r-hide-own').addEventListener('change', render);
  $('r-toggle').addEventListener('click', () => {
    open = !open;
    $('r-toggle').textContent = open ? '모두 접기' : '모두 펼치기';
    document.querySelectorAll('#r-list details').forEach((d) => { d.open = open; });
  });
  $('r-csv').addEventListener('click', exportCsv);
  window.addEventListener('blog:range', (e) => load(e.detail));
})();
