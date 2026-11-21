// 화면 전환(SPA). 왼쪽 메뉴는 스크롤 이동이 아니라 화면 하나를 골라 보여 준다.
// 주소는 #/overview 같은 해시라 뒤로가기·새로고침·즐겨찾기가 된다. 예전 앵커(#referer-panel 등)도 받아 준다.
// 데이터는 화면과 상관없이 각 스크립트가 기간이 바뀔 때 불러 두고, 여기서는 보이기만 바꾼다.
// 숨겨진 채로 그려진 Highcharts는 폭이 틀어지므로 화면이 보일 때 reflow한다.
(function () {
  const VIEWS = ['overview', 'referer', 'metrics', 'trends', 'queries'];
  const LEGACY = {
    overview: 'overview', 'referer-panel': 'referer', 'metrics-panel': 'metrics',
    'trends-panel': 'trends', 'queries-panel': 'queries',
  };
  const BASE_TITLE = document.title;

  function current() {
    const h = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
    if (VIEWS.includes(h)) return h;
    return LEGACY[h] || 'overview';
  }

  function reflowCharts(section) {
    const hc = window.Highcharts;
    if (!hc || !hc.charts) return;
    for (const c of hc.charts) {
      if (c && c.renderTo && section.contains(c.renderTo)) c.reflow();
    }
  }

  let shown = null;
  function show() {
    const v = current();
    let target = null;
    document.querySelectorAll('section.view').forEach((s) => {
      const on = s.dataset.view === v;
      s.hidden = !on;
      if (on) target = s;
    });
    document.querySelectorAll('.nav a[data-nav]').forEach((a) => {
      const on = a.dataset.nav === v;
      a.classList.toggle('active', on);
      if (on) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    const label = document.querySelector('.nav a[data-nav="' + v + '"]');
    document.title = (label ? label.textContent + ' · ' : '') + BASE_TITLE;
    if (shown !== null && shown !== v) window.scrollTo(0, 0);
    shown = v;
    if (target) requestAnimationFrame(() => reflowCharts(target));
    window.dispatchEvent(new CustomEvent('blog:view', { detail: v }));
  }

  window.addEventListener('hashchange', show);
  // 같은 메뉴를 다시 누르면 맨 위로
  document.querySelectorAll('.nav a[data-nav]').forEach((a) => a.addEventListener('click', () => {
    if (a.dataset.nav === current()) window.scrollTo(0, 0);
  }));
  // 숨겨진 화면에서 차트가 다시 그려진 경우(기간 변경 등)에 대비해, 보이는 화면을 창 크기 변화 때도 맞춘다.
  window.addEventListener('resize', () => {
    const s = document.querySelector('section.view:not([hidden])');
    if (s) reflowCharts(s);
  });
  show();
})();
