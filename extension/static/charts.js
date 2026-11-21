// 대시보드 차트 그리기(Highcharts). 화면 스크립트는 차트 라이브러리를 직접 부르지 않고 BlogCharts.draw만 쓴다.
// 테마(글자·격자·배경색)는 페이지의 CSS 변수에서 읽고, 운영체제 다크/라이트가 바뀌면 그려진 차트를 모두 다시 그린다.
// Highcharts는 개인·비상업 용도로 무료다(www.highcharts.com/license). 번들에 넣어 원격 코드를 쓰지 않는다.
(function () {
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const nf = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 1 });
  const live = new Set(); // { el, spec, chart }

  Highcharts.setOptions({
    lang: {
      thousandsSep: ',', decimalPoint: '.', numericSymbols: null, noData: '데이터 없음', resetZoom: '원래대로',
      months: ['1월', '2월', '3월', '4월', '5월', '6월', '7월', '8월', '9월', '10월', '11월', '12월'],
      weekdays: ['일', '월', '화', '수', '목', '금', '토'],
    },
  });

  function theme() {
    return { text: css('--text'), muted: css('--muted'), grid: css('--grid'), line: css('--line'), card: css('--card') };
  }

  /** 반투명 그라데이션(꺾은선 아래 영역). */
  function fade(color) {
    return { linearGradient: { x1: 0, y1: 0, x2: 0, y2: 1 },
      stops: [[0, Highcharts.color(color).setOpacity(0.28).get('rgba')], [1, Highcharts.color(color).setOpacity(0).get('rgba')]] };
  }

  // 유입처·주제 이름 등 외부 값은 여기서 한 번 이스케이프한다(축·범례·툴팁이 모두 이 값을 쓴다).
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ESC[c]);

  function options(raw, width) {
    const spec = Object.assign({}, raw, {
      categories: raw.categories && raw.categories.map(esc),
      series: raw.series.map((s) => Object.assign({}, s, { name: esc(s.name || ''),
        data: raw.kind === 'donut' ? s.data.map((d) => Object.assign({}, d, { name: esc(d.name) })) : s.data })),
    });
    const t = theme();
    const axisLabel = { style: { color: t.muted, fontSize: '11px' } };
    const isPie = spec.kind === 'donut';
    const many = spec.series.length > 1;
    const fmt = spec.valueFormat || ((v) => nf.format(v));

    const base = {
      chart: {
        backgroundColor: 'transparent', spacing: [8, 4, 16, 0], animation: { duration: 350 },
        style: { fontFamily: 'inherit' }, styledMode: false,
      },
      title: { text: null },
      // 출처 표시는 축 글자와 겹치지 않게 맨 아래 여백에 둔다.
      credits: { style: { color: t.muted, fontSize: '9px' }, position: { align: 'right', x: -4, y: -2 } },
      accessibility: { enabled: true, description: spec.title || undefined },
      legend: {
        enabled: spec.legend ?? (isPie || many), itemStyle: { color: t.muted, fontWeight: '400', fontSize: '12px' },
        itemHoverStyle: { color: t.text }, itemHiddenStyle: { color: t.line }, symbolRadius: 3, margin: 8,
        navigation: { activeColor: t.text, inactiveColor: t.line, style: { color: t.muted } },
      },
      tooltip: {
        shared: !isPie, outside: true, borderRadius: 8, borderWidth: 1, borderColor: t.line, shadow: false,
        backgroundColor: t.card, style: { color: t.text, fontSize: '12px' }, padding: 10,
        headerFormat: isPie ? '' : '<span style="font-size:11px;color:' + t.muted + '">{point.key}</span><br/>',
        pointFormatter: function () {
          const v = isPie ? fmt(this.y) + ' (' + nf.format(this.percentage) + '%)' : (this.y == null ? '-' : fmt(this.y));
          return '<span style="color:' + this.color + '">●</span> ' + (isPie ? this.name : this.series.name)
            + ': <b>' + v + '</b><br/>';
        },
      },
      responsive: { rules: [{
        condition: { maxWidth: 420 },
        chartOptions: { legend: { layout: 'horizontal', align: 'center', verticalAlign: 'bottom', itemStyle: { fontSize: '11px' } } },
      }] },
    };

    if (isPie) {
      return Highcharts.merge(base, {
        legend: { layout: 'vertical', align: 'right', verticalAlign: 'middle', itemMarginBottom: 4 },
        plotOptions: { pie: {
          innerSize: '64%', borderWidth: 2, borderColor: t.card, borderRadius: 4, showInLegend: true,
          dataLabels: { enabled: false }, states: { hover: { halo: { size: 6 } } },
        } },
        series: [{ type: 'pie', name: spec.series[0].name || '', data: spec.series[0].data }],
      });
    }

    const type = { line: 'areaspline', column: 'column', bar: 'bar' }[spec.kind];
    // 가로 글자 하나에 70px 안팎을 잡아 그 수만큼만 날짜를 보인다(390px 폭이면 4~5개).
    const n = spec.categories ? spec.categories.length : 0;
    const slots = Math.max(4, Math.floor((width || 600) / 70));
    const sparse = spec.kind !== 'bar' && n > 12;
    return Highcharts.merge(base, {
      // 꺾은선은 가로로 끌어 기간을 확대할 수 있다(zooming은 값이 있을 때만 넣는다. undefined를 넣으면 Highcharts가 멈춘다).
      chart: spec.kind === 'line' ? { type, zooming: { type: 'x' } } : { type },
      xAxis: {
        // 날짜가 많으면 글자를 눕히지 않고 10개 안팎만 보인다.
        categories: spec.categories, lineColor: t.line, tickColor: t.line,
        tickInterval: sparse ? Math.ceil(n / slots) : undefined,
        labels: sparse ? Object.assign({ rotation: 0, autoRotation: false }, axisLabel) : axisLabel,
        crosshair: spec.kind === 'bar' ? false : { color: Highcharts.color(t.muted).setOpacity(0.12).get('rgba') },
      },
      yAxis: {
        title: { text: null }, labels: Object.assign({ formatter: function () { return spec.axisFormat ? spec.axisFormat(this.value) : nf.format(this.value); } }, axisLabel),
        gridLineColor: t.grid, min: spec.yMin === undefined ? 0 : spec.yMin, softMin: spec.yMin === null ? 0 : undefined,
        allowDecimals: !!spec.decimals,
        plotLines: spec.yMin === null ? [{ value: 0, color: t.line, width: 1, zIndex: 2 }] : undefined,
      },
      plotOptions: {
        series: { connectNulls: false, animation: { duration: 350 } },
        areaspline: { lineWidth: 2.2, marker: { enabled: false, radius: 3, symbol: 'circle' }, fillOpacity: 1, threshold: 0 },
        spline: { lineWidth: 2.2, marker: { enabled: false, radius: 3, symbol: 'circle' } },
        column: { borderWidth: 0, borderRadius: 3, groupPadding: 0.12, pointPadding: 0.04, stacking: spec.stacked ? 'normal' : undefined },
        bar: { borderWidth: 0, borderRadius: 3, groupPadding: 0.1, pointPadding: 0.06 },
      },
      series: spec.series.map((s) => {
        const out = { name: s.name, data: s.data, color: s.color };
        if (s.type === 'line') out.type = 'spline';
        if (type === 'areaspline' && !s.type) out.fillColor = spec.fill === false ? 'transparent' : fade(s.color);
        return out;
      }),
    });
  }

  function render(entry) {
    if (entry.chart) entry.chart.destroy();
    entry.chart = Highcharts.chart(entry.el, options(entry.spec, entry.el.clientWidth));
  }

  /**
   * spec: { kind: 'line'|'column'|'bar'|'donut', categories?, series: [{ name, data, color, type? }],
   *         stacked?, legend?, yMin?(기본 0, null이면 음수 허용), decimals?, valueFormat?(v→문자열), axisFormat?, fill?, title? }
   * 돌려준 객체의 destroy()로 지운다.
   */
  function draw(el, spec) {
    const entry = { el, spec, chart: null };
    render(entry);
    live.add(entry);
    return { destroy() { if (entry.chart) entry.chart.destroy(); entry.chart = null; live.delete(entry); } };
  }

  // 운영체제 테마가 바뀌면 색을 다시 읽어 그린다.
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { for (const e of live) render(e); });

  window.BlogCharts = { draw };
})();
