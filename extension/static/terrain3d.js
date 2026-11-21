// 요일×시간 3D 지형도(three.js). 대시보드에서 three.js를 쓰는 곳은 여기 하나뿐이다. 다른 차트는 charts.js(Highcharts).
// 설계: ~/.claude/plans/extension-analysis-features.md "요일×시간 지형도"
// - 연속 렌더 루프 없음: 조작·크기·테마·데이터가 바뀔 때만 그린다. 자동 회전 없음.
// - 페이지 스크롤을 빼앗지 않도록 지형도를 한 번 눌러야 회전·확대가 켜진다(바깥을 누르거나 Esc로 끈다).
// - 라벨·툴팁은 HTML이고 textContent로만 넣는다.
// createTerrain이 실패하면(WebGL 없음, 로딩 실패) 예외를 던지고, 호출한 쪽이 표로 대체한다.

const SX = 1;      // 시간 한 칸 폭
const SZ = 1.6;    // 요일 한 칸 깊이(24×7이 너무 길쭉하지 않게)
const HEIGHT = 5;  // 최댓값의 높이
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/**
 * el 안에 지형도를 만든다.
 * data: { rows: string[], cols: number, values: (number|null)[][], weak: boolean[],
 *         top: [{ row, from, to }], tooltip(r, c) → string, colLabels: [{ col, text }] }
 * 돌려준 객체: setData(data, { mode: 'surface'|'bars' }), view('default'|'top'), dispose()
 */
export async function createTerrain(el, { hint } = {}) {
  const THREE = await import('./vendor/three/three.module.js');
  const { OrbitControls } = await import('./vendor/three/OrbitControls.js');

  const canvasHost = document.createElement('div');
  canvasHost.className = 't3-host';
  const labels = document.createElement('div');
  labels.className = 't3-labels';
  const tip = document.createElement('div');
  tip.className = 't3-tip';
  tip.hidden = true;
  const hintEl = document.createElement('div');
  hintEl.className = 't3-hint';
  hintEl.textContent = hint || '눌러서 돌려 보기';
  el.replaceChildren(canvasHost, labels, tip, hintEl);

  // WebGL이 없으면 여기서 예외가 난다.
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  canvasHost.appendChild(renderer.domElement);
  const canvas = renderer.domElement;
  canvas.style.touchAction = 'pan-y';
  canvas.setAttribute('aria-hidden', 'true'); // 화면 읽기 프로그램은 아래 표를 읽는다

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 300);
  // 조명 합이 크면 색이 하얗게 날아가 높낮이 색 차이가 줄어든다(특히 다크 모드). 모양이 보일 만큼만 둔다.
  scene.add(new THREE.AmbientLight(0xffffff, 0.75));
  const sun = new THREE.DirectionalLight(0xffffff, 0.7);
  sun.position.set(-12, 24, 18);
  scene.add(sun);

  const controls = new OrbitControls(camera, canvas);
  controls.enabled = false;
  controls.enablePan = false;
  controls.enableDamping = false;
  controls.minPolarAngle = 0.05;
  controls.maxPolarAngle = Math.PI / 2 - 0.06; // 바닥 아래로 돌지 않게
  controls.minDistance = 12;
  controls.maxDistance = 100;

  const world = new THREE.Group();
  scene.add(world);
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  let data = null;
  let mode = 'surface';
  let pickable = null;     // 레이캐스트 대상(면 또는 막대)
  let hoverMarker = null;
  let labelEls = [];       // { el, pos: Vector3 }
  let pinned = false;
  let frame = 0;
  let disposed = false;

  const rows = () => (data ? data.rows.length : 7);
  const cols = () => (data ? data.cols : 24);
  const center = () => new THREE.Vector3(((cols() - 1) * SX) / 2, 0, ((rows() - 1) * SZ) / 2);

  function palette() {
    const card = css('--card') || '#ffffff', c1 = css('--c1') || '#2563eb';
    // 보간은 눈에 보이는 색(sRGB)에서 한다. 선형 공간에서 섞으면 낮은 값들이 모두 비슷한 색으로 뭉친다.
    const low = new THREE.Color().setStyle(card).convertLinearToSRGB().lerp(new THREE.Color().setStyle(c1).convertLinearToSRGB(), 0.18);
    return { low, high: new THREE.Color().setStyle(c1).convertLinearToSRGB(), muted: new THREE.Color().setStyle(css('--muted') || '#6b7686').convertLinearToSRGB(),
      line: new THREE.Color(css('--line') || '#e3e7ee'), grid: new THREE.Color(css('--muted') || '#6b7686'),
      accent: new THREE.Color(css('--c2') || '#16a34a') };
  }

  function maxValue() {
    let m = 0;
    for (const r of data.values) for (const v of r) if (v != null && v > m) m = v;
    return m || 1;
  }
  const heightOf = (v, max) => (v == null ? 0 : (v / max) * HEIGHT);
  /** 높이에 따른 색. p.low/high/muted는 sRGB 값이라 섞은 뒤 선형으로 되돌려 정점 색으로 쓴다. */
  function colorOf(v, max, weak, p) {
    if (v == null) return p.line.clone();
    // 대부분의 칸이 최댓값의 10~20%라서, 제곱근에 가까운 곡선으로 낮은 구간의 색 차이를 넓힌다.
    const c = p.low.clone().lerp(p.high, Math.pow(v / max, 0.55));
    if (weak) c.lerp(p.muted, 0.65);
    return c.convertSRGBToLinear();
  }

  function clearWorld() {
    for (const obj of [...world.children]) {
      world.remove(obj);
      obj.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
      });
    }
    pickable = null;
    hoverMarker = null;
  }

  /** 바닥 사각형 테두리. onTop이면 지형 면에 가려지지 않게 깊이 검사 없이 맨 나중에 그린다. */
  function lineRect(x0, x1, z0, z1, y, color, onTop = false) {
    const g = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(x0, y, z0), new THREE.Vector3(x1, y, z0), new THREE.Vector3(x1, y, z1), new THREE.Vector3(x0, y, z1)]);
    const line = new THREE.LineLoop(g, new THREE.LineBasicMaterial({ color, depthTest: !onTop, transparent: onTop }));
    if (onTop) line.renderOrder = 10;
    return line;
  }

  function buildSurface(max, p) {
    const R = rows(), C = cols();
    const pos = new Float32Array(R * C * 3);
    const col = new Float32Array(R * C * 3);
    for (let r = 0; r < R; r++) {
      for (let c = 0; c < C; c++) {
        const i = (r * C + c) * 3;
        const v = data.values[r][c];
        pos[i] = c * SX; pos[i + 1] = heightOf(v, max); pos[i + 2] = r * SZ;
        const k = colorOf(v, max, data.weak[r], p);
        col[i] = k.r; col[i + 1] = k.g; col[i + 2] = k.b;
      }
    }
    const idx = [];
    for (let r = 0; r < R - 1; r++) {
      for (let c = 0; c < C - 1; c++) {
        const a = r * C + c, b = a + 1, d = a + C, e = d + 1;
        idx.push(a, d, b, b, d, e);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    world.add(mesh);

    // 격자선(칸 경계가 보이게)
    const seg = [];
    for (let r = 0; r < R; r++) for (let c = 0; c < C - 1; c++) {
      const i = (r * C + c) * 3, j = i + 3;
      seg.push(pos[i], pos[i + 1] + 0.01, pos[i + 2], pos[j], pos[j + 1] + 0.01, pos[j + 2]);
    }
    for (let c = 0; c < C; c++) for (let r = 0; r < R - 1; r++) {
      const i = (r * C + c) * 3, j = i + C * 3;
      seg.push(pos[i], pos[i + 1] + 0.01, pos[i + 2], pos[j], pos[j + 1] + 0.01, pos[j + 2]);
    }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(seg), 3));
    world.add(new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: p.grid, transparent: true, opacity: 0.22 })));
    pickable = mesh;
  }

  function buildBars(max, p) {
    const R = rows(), C = cols();
    const geo = new THREE.BoxGeometry(SX * 0.8, 1, SZ * 0.7);
    const mesh = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial(), R * C);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    for (let r = 0; r < R; r++) {
      for (let c = 0; c < C; c++) {
        const v = data.values[r][c];
        const h = Math.max(heightOf(v, max), 0.03);
        m.compose(new THREE.Vector3(c * SX, h / 2, r * SZ), q, new THREE.Vector3(1, h, 1));
        mesh.setMatrixAt(r * C + c, m);
        mesh.setColorAt(r * C + c, colorOf(v, max, data.weak[r], p));
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    world.add(mesh);
    pickable = mesh;
  }

  function buildFloorAndLabels(p) {
    const R = rows(), C = cols();
    const x0 = -0.5 * SX, x1 = (C - 0.5) * SX, z0 = -0.5 * SZ, z1 = (R - 0.5) * SZ;
    world.add(lineRect(x0, x1, z0, z1, 0, p.line));
    // 상위 블록: 바닥에 테두리
    for (const b of data.top || []) {
      world.add(lineRect((b.from - 0.5) * SX, (b.to - 0.5) * SX, (b.row - 0.5) * SZ, (b.row + 0.5) * SZ, 0.02, p.accent, true));
    }
    hoverMarker = lineRect(-0.5 * SX, 0.5 * SX, -0.5 * SZ, 0.5 * SZ, 0.03, p.high, true);
    hoverMarker.visible = false;
    world.add(hoverMarker);

    for (const l of labelEls) l.el.remove();
    labelEls = [];
    const add = (text, pos, cls) => {
      const s = document.createElement('span');
      s.className = 't3-label ' + cls;
      s.textContent = text;
      labels.appendChild(s);
      labelEls.push({ el: s, pos });
    };
    data.rows.forEach((t, r) => add(t, new THREE.Vector3(-1.4 * SX, 0, r * SZ), 'row'));
    for (const { col, text } of data.colLabels || []) add(text, new THREE.Vector3(col * SX, 0, z1 + 0.9), 'col');
  }

  function rebuild() {
    clearWorld();
    if (!data) return;
    const p = palette();
    const max = maxValue();
    if (mode === 'bars') buildBars(max, p); else buildSurface(max, p);
    buildFloorAndLabels(p);
    requestRender();
  }

  const v3 = new THREE.Vector3();
  const LABEL_GAP = 13; // 같은 축 라벨끼리 이보다 가까우면 건너뛴다(좁은 화면에서 요일 7개가 겹치지 않게)
  function placeLabels() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const last = {};
    for (const l of labelEls) {
      v3.copy(l.pos).project(camera);
      const x = ((v3.x + 1) / 2) * w, y = ((1 - v3.y) / 2) * h;
      const axis = l.el.classList.contains('row') ? 'row' : 'col';
      const prev = last[axis];
      const off = v3.z > 1 || v3.x < -1.1 || v3.x > 1.1 || v3.y < -1.1 || v3.y > 1.1
        || (prev && Math.hypot(x - prev.x, y - prev.y) < (axis === 'row' ? LABEL_GAP : LABEL_GAP * 2));
      l.el.hidden = off;
      if (!off) {
        l.el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
        last[axis] = { x, y };
      }
    }
  }

  function render() {
    frame = 0;
    if (disposed) return;
    renderer.render(scene, camera);
    placeLabels();
  }
  function requestRender() {
    if (!frame && !disposed) frame = requestAnimationFrame(render);
  }

  function setView(which) {
    const c = center();
    controls.target.copy(c);
    // 화면이 좁으면(세로로 긴 비율) 24시간 폭이 다 들어오게 더 멀리서 본다.
    const k = Math.max(1, 1.7 / (camera.aspect || 1.7));
    if (which === 'top') camera.position.set(c.x, 38 * k, c.z + 0.01);
    else camera.position.set(c.x - 9 * k, 15 * k, c.z + 22 * k);
    camera.lookAt(c);
    controls.update();
    requestRender();
  }

  function resize() {
    const w = el.clientWidth, h = el.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    requestRender();
  }

  // ---- 툴팁(레이캐스트) ----
  function cellAt(ev) {
    if (!pickable || !data) return null;
    const rect = canvas.getBoundingClientRect();
    pointer.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObject(pickable, false)[0];
    if (!hit) return null;
    if (mode === 'bars' && hit.instanceId != null) return { r: Math.floor(hit.instanceId / cols()), c: hit.instanceId % cols() };
    const c = Math.round(hit.point.x / SX), r = Math.round(hit.point.z / SZ);
    if (r < 0 || r >= rows() || c < 0 || c >= cols()) return null;
    return { r, c };
  }
  function showTip(cell, ev) {
    if (!cell) { tip.hidden = true; hoverMarker && (hoverMarker.visible = false); requestRender(); return; }
    tip.textContent = data.tooltip(cell.r, cell.c);
    tip.hidden = false;
    const rect = el.getBoundingClientRect();
    const x = Math.min(ev.clientX - rect.left + 12, rect.width - tip.offsetWidth - 4);
    const y = Math.max(ev.clientY - rect.top - tip.offsetHeight - 10, 4);
    tip.style.transform = `translate(${Math.max(4, x)}px, ${y}px)`;
    if (hoverMarker) {
      hoverMarker.position.set(cell.c * SX, 0, cell.r * SZ);
      hoverMarker.visible = true;
    }
    requestRender();
  }
  let moveFrame = 0;
  const onMove = (ev) => {
    if (pinned || moveFrame) return;
    moveFrame = requestAnimationFrame(() => { moveFrame = 0; showTip(cellAt(ev), ev); });
  };
  const onLeave = () => { if (!pinned) showTip(null); };

  // ---- 조작 켜기/끄기 ----
  function activate(on) {
    controls.enabled = on;
    el.classList.toggle('t3-active', on);
    canvas.style.touchAction = on ? 'none' : 'pan-y';
    hintEl.hidden = on;
  }
  const onDown = (ev) => {
    if (!controls.enabled) { activate(true); return; }
    // 이미 켜져 있으면: 끌지 않고 누른 경우를 클릭으로 보고 툴팁 고정/해제
    const sx = ev.clientX, sy = ev.clientY;
    const up = (e2) => {
      canvas.removeEventListener('pointerup', up);
      if (Math.hypot(e2.clientX - sx, e2.clientY - sy) > 4) return;
      const cell = cellAt(e2);
      pinned = !!cell && !pinned;
      showTip(cell, e2);
    };
    canvas.addEventListener('pointerup', up);
  };
  const onDocDown = (ev) => { if (controls.enabled && !el.contains(ev.target)) activate(false); };
  const onKey = (ev) => { if (ev.key === 'Escape' && controls.enabled) activate(false); };
  const onTheme = () => rebuild();
  const themeQuery = matchMedia('(prefers-color-scheme: dark)');

  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('pointerdown', onDown);
  document.addEventListener('pointerdown', onDocDown, true);
  document.addEventListener('keydown', onKey);
  themeQuery.addEventListener('change', onTheme);
  controls.addEventListener('change', requestRender);
  const ro = new ResizeObserver(resize);
  ro.observe(el);
  resize();
  setView('default');

  return {
    setData(next, opts = {}) {
      const first = !data;
      data = next;
      if (opts.mode) mode = opts.mode;
      pinned = false;
      tip.hidden = true;
      rebuild();
      if (first) setView('default');
    },
    view: setView,
    dispose() {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      if (moveFrame) cancelAnimationFrame(moveFrame);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('pointerdown', onDown);
      document.removeEventListener('pointerdown', onDocDown, true);
      document.removeEventListener('keydown', onKey);
      themeQuery.removeEventListener('change', onTheme);
      ro.disconnect();
      controls.dispose();
      clearWorld();
      renderer.dispose();
      renderer.forceContextLoss();
      el.replaceChildren();
    },
  };
}
