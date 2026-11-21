// Java 대시보드(src/main/resources/static/index.html)의 검색어 변화 스크립트. 확장 CSP가 인라인 스크립트를 막아 파일로 뺐다.
// /api/dashboard/* 요청은 dashboard-api.js가 오프스크린의 로컬 조회 계층으로 돌린다.
// 검색어 변화 패널. 기간 선택과 무관하게 "검색어가 저장된 가장 최근 날짜" 기준 이번 주 vs 지난주다.
// 검색어는 외부 입력이므로 textContent로만 넣는다.
(function () {
  const $ = (id) => document.getElementById(id);
  const nf = new Intl.NumberFormat('ko-KR');
  const md = (d) => d.slice(5).replace('-', '/');

  function fill(listId, items, label, empty) {
    const ol = $(listId);
    ol.replaceChildren();
    if (items.length === 0) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = empty;
      ol.appendChild(li);
      return;
    }
    for (const it of items) {
      const li = document.createElement('li');
      const q = document.createElement('span');
      q.className = 'q';
      q.textContent = it.query;
      const n = document.createElement('span');
      n.className = 'n';
      n.textContent = label(it);
      li.append(q, n);
      ol.appendChild(li);
    }
  }

  async function loadTrends() {
    try {
      const res = await fetch('/api/dashboard/keyword-trends?limit=10');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const t = await res.json();
      $('t-range').textContent = '이번 주 ' + md(t.thisFrom) + '~' + md(t.thisTo)
        + ' vs 지난주 ' + md(t.lastFrom) + '~' + md(t.lastTo)
        + ' · "새로 뜬" = 직전 ' + t.historyDays + '일치 기록에 없던 검색어';
      fill('t-fresh', t.fresh, (x) => nf.format(x.visits) + '회 · ' + md(x.firstSeen) + '부터',
        '새로 뜬 검색어가 없습니다.');
      fill('t-rising', t.rising, (x) => nf.format(x.lastWeek) + ' → ' + nf.format(x.thisWeek) + ' (+' + x.delta + ')',
        '늘어난 검색어가 없습니다.');
      fill('t-falling', t.falling, (x) => nf.format(x.lastWeek) + ' → ' + nf.format(x.thisWeek) + ' (' + x.delta + ')',
        '줄어든 검색어가 없습니다.');
    } catch (e) {
      $('t-range').textContent = '불러오기 실패: ' + e.message;
    }
  }

  loadTrends();
})();
