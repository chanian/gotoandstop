// Bottom panel: the three modes, a light pad, and a plot of the diffusion profile.
//
// The light pad is the sphere around her head seen from the front. The centre is light from straight ahead,
// the dashed ring is light from the side, and the rim is light from directly behind her.

export const MODES = [
  { id: 1, name: 'Flat polygons', short: 'Flat' },
  { id: 2, name: 'Texture + bump', short: 'Texture' },
  { id: 3, name: 'Subsurface', short: 'SSS' },
];

export const LIGHTS = [
  { id: 'key', label: 'Key', x: -0.3, y: -0.28 },
  { id: 'side', label: 'Side', x: 0.52, y: -0.05 },
  { id: 'top', label: 'Top', x: 0.02, y: -0.56 },
  { id: 'under', label: 'Under', x: 0.05, y: 0.42 },
  { id: 'rim', label: 'Rim', x: 0.74, y: -0.3 },
  { id: 'ear', label: 'Behind ear', x: -0.87, y: -0.08 },
];

export function createUI(state, { onMode, onCompare, onLight }) {
  const root = document.getElementById('ui');
  root.innerHTML = `
    <div class="modes">
      <span class="label">Technique</span>
      ${MODES.map((m) => `<button data-mode="${m.id}"><b>0${m.id}</b>${m.name}</button>`).join('')}
      <div class="row"><button id="compare" title="Split the view (C)">Compare</button></div>
    </div>
    <div class="light">
      <div class="pad" id="pad" title="Drag to move the light">
        <div class="ring"></div><div class="face"></div>
        <span class="tag" style="left:50%;top:10%">behind</span>
        <span class="tag" style="left:50%;top:30%">side</span>
        <div class="orb" id="orb"></div>
      </div>
      <div class="presets">${LIGHTS.map((l) => `<button data-light="${l.id}">${l.label}</button>`).join('')}</div>
    </div>
    <div class="plot">
      <span class="label">Diffusion profile</span>
      <canvas id="plot" width="340" height="192"></canvas>
      <span class="caption" id="plotCap"></span>
    </div>
  `;

  const modeBtns = [...root.querySelectorAll('[data-mode]')];
  const compareBtn = root.querySelector('#compare');
  const pad = root.querySelector('#pad');
  const orb = root.querySelector('#orb');
  const lightBtns = [...root.querySelectorAll('[data-light]')];

  modeBtns.forEach((b) => b.addEventListener('click', () => onMode(+b.dataset.mode)));
  compareBtn.addEventListener('click', () => onCompare(!state.compare));
  lightBtns.forEach((b) => b.addEventListener('click', () => {
    const l = LIGHTS.find((x) => x.id === b.dataset.light);
    onLight(l.x, l.y, true);
  }));
  addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey) return;
    if (e.key >= '1' && e.key <= '3') onMode(+e.key);
    if (e.key === 'c' || e.key === 'C') onCompare(!state.compare);
  });

  let dragging = false;
  const fromEvent = (e) => {
    const r = pad.getBoundingClientRect();
    let x = ((e.clientX - r.left) / r.width) * 2 - 1, y = ((e.clientY - r.top) / r.height) * 2 - 1;
    const len = Math.hypot(x, y);
    if (len > 0.97) { x *= 0.97 / len; y *= 0.97 / len; }
    onLight(x, y, false);
  };
  pad.addEventListener('pointerdown', (e) => { dragging = true; pad.setPointerCapture(e.pointerId); pad.classList.add('active'); fromEvent(e); });
  pad.addEventListener('pointermove', (e) => { if (dragging) fromEvent(e); });
  const end = () => { dragging = false; pad.classList.remove('active'); };
  pad.addEventListener('pointerup', end);
  pad.addEventListener('pointercancel', end);

  return {
    sync() {
      modeBtns.forEach((b) => b.classList.toggle('on', +b.dataset.mode === state.mode));
      compareBtn.classList.toggle('on', state.compare);
      orb.style.left = `${50 + state.light.x * 50}%`;
      orb.style.top = `${50 + state.light.y * 50}%`;
      orb.classList.toggle('behind', Math.hypot(state.light.x, state.light.y) > 0.5);
      lightBtns.forEach((b) => {
        const l = LIGHTS.find((x) => x.id === b.dataset.light);
        b.classList.toggle('on', Math.hypot(l.x - state.light.x, l.y - state.light.y) < 0.02);
      });
    },
    get dragging() { return dragging; },
  };
}

// r * R(r) per channel: how much of the scattered light re-emerges at each distance
export function drawProfile(canvas, caption, fn, maxMm, label) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(255,236,220,0.1)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) { ctx.beginPath(); ctx.moveTo((i * w) / 4, 0); ctx.lineTo((i * w) / 4, h); ctx.stroke(); }
  const N = 120, curves = [[], [], []];
  let peak = 1e-9;
  for (let i = 0; i <= N; i++) {
    const r = (i / N) * maxMm;
    const v = fn(Math.max(r, maxMm / N / 4));
    for (let c = 0; c < 3; c++) { const y = v[c] * r; curves[c].push(y); peak = Math.max(peak, y); }
  }
  ['rgba(255,110,90,0.95)', 'rgba(120,230,130,0.9)', 'rgba(110,160,255,0.9)'].forEach((col, c) => {
    ctx.strokeStyle = col;
    ctx.lineWidth = 2;
    ctx.beginPath();
    curves[c].forEach((y, i) => {
      const px = (i / N) * w, py = h - 8 - (y / peak) * (h - 18);
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    });
    ctx.stroke();
  });
  caption.textContent = `${label} · 0–${maxMm.toFixed(0)} mm`;
}
