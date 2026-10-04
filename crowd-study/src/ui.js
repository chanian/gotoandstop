// Side panel: the crowd's dials, presets, and a few view toggles.

export const PRESETS = {
  Plaza: { count: 160, space: 0.95, awareness: 0.55, effort: 0.5, milling: 0.12, strength: 1.6, fragility: 0.35 },
  Concert: { count: 340, space: 0.62, awareness: 0.08, effort: 0.25, milling: 0, strength: 2.2, fragility: 0.2 },
  Commute: { count: 220, space: 0.9, awareness: 0.85, effort: 0.8, milling: 0.55, strength: 1.4, fragility: 0.25 },
  Skittles: { count: 200, space: 0.8, awareness: 0, effort: 0, milling: 0.04, strength: 3, fragility: 0.85 },
};

const SLIDERS = [
  { key: 'count', label: 'Crowd', min: 0, max: 400, step: 10, fmt: (v) => v },
  { key: 'space', label: 'Personal space', min: 0.55, max: 1.6, step: 0.05, fmt: (v) => `${v.toFixed(2)} m` },
  { key: 'awareness', label: 'Notice you', min: 0, max: 1, step: 0.05, fmt: (v) => `${Math.round(v * 100)}%` },
  { key: 'effort', label: 'Get out of the way', min: 0, max: 1, step: 0.05, fmt: (v) => `${Math.round(v * 100)}%` },
  { key: 'milling', label: 'Milling about', min: 0, max: 1, step: 0.05, fmt: (v) => `${Math.round(v * 100)}%` },
  { key: 'strength', label: 'Your mass', min: 0.5, max: 5, step: 0.1, fmt: (v) => `${v.toFixed(1)}×` },
  { key: 'fragility', label: 'Fragility', min: 0, max: 1, step: 0.05, fmt: (v) => (v < 0.01 ? 'no falls' : `${Math.round(v * 100)}%`) },
];

export function createUI(params, view, { onParam, onPreset, onView }) {
  const root = document.getElementById('ui');
  root.innerHTML = `
    <button id="toggle" title="Collapse the controls (C)" aria-expanded="true">Controls <svg width="12" height="12" viewBox="0 0 12 12"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
    <div class="group">
      <div class="label">Presets</div>
      <div class="btns">${Object.keys(PRESETS).map((k) => `<button data-preset="${k}">${k}</button>`).join('')}</div>
    </div>
    <div class="group">
      <div class="label">Crowd</div>
      ${SLIDERS.map((s) => `<label class="row"><span>${s.label}</span><output data-out="${s.key}"></output>
        <input type="range" data-key="${s.key}" min="${s.min}" max="${s.max}" step="${s.step}"></label>`).join('')}
    </div>
    <div class="group">
      <div class="label">You</div>
      <div class="btns">
        <button data-gait="walk">Walk</button><button data-gait="run">Run <kbd>⇧</kbd></button>
      </div>
    </div>
    <div class="group">
      <div class="label">View</div>
      <div class="btns three">
        <button data-view="slow" title="Quarter speed (S)">Slow <kbd>S</kbd></button>
        <button data-view="discs" title="Show the collision discs (D)">Discs <kbd>D</kbd></button>
        <button data-view="ao" title="Ambient occlusion">AO</button>
      </div>
    </div>
  `;
  // remember whether the drawer was collapsed; phones start collapsed the first time
  const toggle = root.querySelector('#toggle');
  let saved = null;
  try { saved = localStorage.getItem('crowd-study:drawer'); } catch { /* storage blocked */ }
  const setOpen = (open) => {
    root.classList.toggle('closed', !open);
    toggle.setAttribute('aria-expanded', open);
    try { localStorage.setItem('crowd-study:drawer', open ? 'open' : 'closed'); } catch { /* storage blocked */ }
  };
  root.classList.toggle('closed', saved ? saved === 'closed' : innerWidth <= 720);
  toggle.setAttribute('aria-expanded', !root.classList.contains('closed'));
  toggle.addEventListener('click', () => setOpen(root.classList.contains('closed')));
  addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey) return;
    if (e.key === 'c' || e.key === 'C') setOpen(root.classList.contains('closed'));
  });

  const inputs = [...root.querySelectorAll('input[data-key]')];
  inputs.forEach((el) => el.addEventListener('input', () => { onParam(el.dataset.key, +el.value); sync(); }));
  inputs.forEach((el) => el.addEventListener('pointerup', () => el.blur()));
  root.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => { onPreset(b.dataset.preset); sync(); }));
  root.querySelectorAll('[data-gait]').forEach((b) => b.addEventListener('click', () => { params.run = b.dataset.gait === 'run'; sync(); }));
  root.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => { onView(b.dataset.view); sync(); }));

  function sync() {
    for (const el of inputs) {
      const s = SLIDERS.find((x) => x.key === el.dataset.key);
      if (document.activeElement !== el) el.value = params[s.key];
      root.querySelector(`[data-out="${s.key}"]`).textContent = s.fmt(params[s.key]);
    }
    root.querySelectorAll('[data-gait]').forEach((b) => b.classList.toggle('on', (b.dataset.gait === 'run') === (params.run || view.shift)));
    root.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('on', !!view[b.dataset.view]));
    root.querySelectorAll('[data-preset]').forEach((b) => {
      const p = PRESETS[b.dataset.preset];
      b.classList.toggle('on', Object.keys(p).every((k) => Math.abs(p[k] - params[k]) < 1e-6));
    });
  }
  sync();
  return { sync };
}
