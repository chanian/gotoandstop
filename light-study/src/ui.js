// Two dials: a 24-hour sun dial (noon at the top, midnight at the bottom, sunrise on the left)
// and a compass for the direction the window faces. Plus preset chips and a time-lapse toggle.

const PRESETS = [
  { id: 'night', label: 'Night', hours: 23.0 },
  { id: 'am', label: 'Golden AM', hours: 5.85 },
  { id: 'day', label: 'Day', hours: 13.0 },
  { id: 'pm', label: 'Golden PM', hours: 18.2 },
];

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

function fmtTime(h) {
  const hh = Math.floor(h) % 24, mm = Math.floor((h % 1) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function angleFrom(e, el) {
  const r = el.getBoundingClientRect();
  const x = e.clientX - (r.left + r.width / 2), y = e.clientY - (r.top + r.height / 2);
  return ((Math.atan2(x, -y) * 180) / Math.PI + 360) % 360; // clockwise from top
}

function dragDial(el, onAngle) {
  let active = false;
  el.addEventListener('pointerdown', (e) => {
    active = true;
    el.setPointerCapture(e.pointerId);
    el.classList.add('active');
    onAngle(angleFrom(e, el), true);
  });
  el.addEventListener('pointermove', (e) => { if (active) onAngle(angleFrom(e, el), false); });
  const end = () => { active = false; el.classList.remove('active'); };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

function place(el, angleDeg, radiusPct) {
  const a = (angleDeg * Math.PI) / 180;
  el.style.left = `${50 + Math.sin(a) * radiusPct}%`;
  el.style.top = `${50 - Math.cos(a) * radiusPct}%`;
}

export function createUI(state, { onPreset }) {
  const root = document.getElementById('ui');
  root.innerHTML = `
    <button class="collapse" id="collapse" title="Hide controls (H)" aria-label="Hide controls">
      <svg viewBox="0 0 12 12" width="12" height="12"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
    <button class="mini" id="mini" title="Show controls (H)" aria-label="Show controls">
      <span class="mini-orb" id="miniOrb"></span><b id="miniTime">15:00</b><span id="miniPhase"></span><span class="sep">·</span><span id="miniFace">SW</span>
      <svg viewBox="0 0 12 12" width="12" height="12"><path d="M2.5 7.5 6 4l3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
    <div class="dial" id="timeDial" aria-label="Time of day" role="slider">
      <div class="ring time-ring"></div>
      <div class="ticks">${Array.from({ length: 24 }, (_, i) => `<i style="transform: rotate(${i * 15}deg)" class="${i % 6 === 0 ? 'major' : ''}"></i>`).join('')}</div>
      <span class="hour-label" style="left:50%;top:22%">12</span>
      <span class="hour-label" style="left:78%;top:50%">18</span>
      <span class="hour-label" style="left:50%;top:78%">0</span>
      <span class="hour-label" style="left:22%;top:50%">6</span>
      <div class="knob" id="timeKnob"><span class="orb"></span></div>
      <div class="center"><div class="big" id="timeText">18:00</div><div class="small" id="phaseText">Golden hour</div></div>
    </div>
    <div class="middle">
      <div class="presets">${PRESETS.map((p) => `<button data-id="${p.id}">${p.label}</button>`).join('')}</div>
      <button class="play" id="play" title="Time-lapse"><span></span>Time-lapse</button>
    </div>
    <div class="dial" id="compassDial" aria-label="Window direction" role="slider">
      <div class="ring compass-ring"></div>
      <div class="ticks">${Array.from({ length: 36 }, (_, i) => `<i style="transform: rotate(${i * 10}deg)" class="${i % 9 === 0 ? 'major' : ''}"></i>`).join('')}</div>
      <span class="hour-label cardinal" style="left:50%;top:7.3%">N</span>
      <span class="hour-label cardinal" style="left:92.7%;top:50%">E</span>
      <span class="hour-label cardinal" style="left:50%;top:92.7%">S</span>
      <span class="hour-label cardinal" style="left:7.3%;top:50%">W</span>
      <div class="sun-dot" id="sunDot"></div>
      <div class="window-mark" id="windowMark"><span></span></div>
      <div class="center"><div class="big" id="faceText">W</div><div class="small">window faces</div></div>
    </div>
  `;

  const timeDial = root.querySelector('#timeDial');
  const compassDial = root.querySelector('#compassDial');
  const timeKnob = root.querySelector('#timeKnob');
  const windowMark = root.querySelector('#windowMark');
  const sunDot = root.querySelector('#sunDot');
  const timeText = root.querySelector('#timeText');
  const phaseText = root.querySelector('#phaseText');
  const faceText = root.querySelector('#faceText');
  const play = root.querySelector('#play');
  const presetBtns = [...root.querySelectorAll('.presets button')];
  const miniTime = root.querySelector('#miniTime');
  const miniPhase = root.querySelector('#miniPhase');
  const miniFace = root.querySelector('#miniFace');
  const miniOrb = root.querySelector('#miniOrb');

  // collapse to a small pill so the dials don't cover the render
  const KEY = 'light-study-ui-collapsed';
  const setCollapsed = (on) => {
    root.classList.toggle('collapsed', on);
    try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* ignore */ }
  };
  // collapsed by default; remember if someone opens it
  let stored = null;
  try { stored = localStorage.getItem(KEY); } catch { /* ignore */ }
  if (stored !== '0') root.classList.add('collapsed');
  root.querySelector('#collapse').addEventListener('click', () => setCollapsed(true));
  root.querySelector('#mini').addEventListener('click', () => setCollapsed(false));
  addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey) return;
    if (e.key === 'h' || e.key === 'H') setCollapsed(!root.classList.contains('collapsed'));
  });

  dragDial(timeDial, (a) => {
    state.timeAnim = null;
    state.playing = false;
    state.hours = (12 + a / 15) % 24;
  });
  dragDial(compassDial, (a) => { state.facing = Math.round(a); });

  presetBtns.forEach((b) => b.addEventListener('click', () => {
    const p = PRESETS.find((x) => x.id === b.dataset.id);
    state.playing = false;
    onPreset(p.hours);
  }));
  play.addEventListener('click', () => { state.playing = !state.playing; state.timeAnim = null; });

  return {
    update({ hours, facing, sunAzimuth, elevation, phase }) {
      place(timeKnob, (hours - 12) * 15, 42.75);
      timeKnob.classList.toggle('moon', elevation < -4);
      timeText.textContent = fmtTime(hours);
      phaseText.textContent = phase;
      miniTime.textContent = fmtTime(hours);
      miniPhase.textContent = phase;
      miniOrb.classList.toggle('moon', elevation < -4);
      place(windowMark, facing, 31);
      windowMark.style.transform = `translate(-50%, -50%) rotate(${facing}deg)`;
      place(sunDot, sunAzimuth, 42.75);
      sunDot.classList.toggle('down', elevation < 0);
      faceText.textContent = COMPASS[Math.round(facing / 45) % 8];
      miniFace.textContent = `faces ${faceText.textContent}`;
      play.classList.toggle('on', state.playing);
      const near = PRESETS.reduce((best, p) => {
        const d = Math.min(Math.abs(p.hours - hours), 24 - Math.abs(p.hours - hours));
        return d < best.d ? { d, id: p.id } : best;
      }, { d: 0.35, id: null });
      presetBtns.forEach((b) => b.classList.toggle('on', b.dataset.id === near.id));
    },
  };
}
