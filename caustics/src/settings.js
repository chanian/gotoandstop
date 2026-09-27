import GUI from 'lil-gui';

const STORAGE_KEY = 'whiskey-caustics-settings-v1';
const DPR = window.devicePixelRatio || 1;

const QUALITY_KEYS = [
  'pixelRatio', 'causticsOn', 'gridRes', 'mapRes', 'causticBlur', 'maxBounces',
  'woodOctaves', 'handShadow', 'liquidRes', 'bloom', 'grain',
];

export const PRESETS = {
  Low: {
    pixelRatio: 1, causticsOn: true, gridRes: 192, mapRes: 512, causticBlur: false, maxBounces: 8,
    woodOctaves: 3, handShadow: true, liquidRes: 64, bloom: false, grain: true,
  },
  Medium: {
    pixelRatio: Math.min(DPR, 1.25), causticsOn: true, gridRes: 320, mapRes: 1024, causticBlur: true, maxBounces: 12,
    woodOctaves: 4, handShadow: true, liquidRes: 96, bloom: true, grain: true,
  },
  High: {
    pixelRatio: Math.min(DPR, 2), causticsOn: true, gridRes: 512, mapRes: 1024, causticBlur: true, maxBounces: 16,
    woodOctaves: 5, handShadow: true, liquidRes: 96, bloom: true, grain: true,
  },
  Ultra: {
    pixelRatio: Math.min(DPR, 3), causticsOn: true, gridRes: 768, mapRes: 2048, causticBlur: true, maxBounces: 20,
    woodOctaves: 5, handShadow: true, liquidRes: 128, bloom: true, grain: true,
  },
};

export const DEFAULTS = {
  preset: 'High',
  ...PRESETS.High,
  bloomStrength: 0.55,
  bloomRadius: 0.6,
  bloomThreshold: 0.85,
  exposure: 1.05,
  lightIntensity: 2.6,
  lightAzimuth: 43,    // degrees from straight behind the glass toward the right
  lightElevation: 28,
  fill: 4.2,
  iceCount: 3,
  iceSize: 2.4,
  iceRound: 0.3,
  iceCloud: 0.15,
  sloshDamping: 0.045,
  autoShake: false,
  showStats: true,
};

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (saved && typeof saved === 'object') return { ...DEFAULTS, ...saved };
  } catch { /* storage unavailable */ }
  return { ...DEFAULTS };
}

function save(state) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* ignore */ }
}

// apply: { [settingKey]: (value, state) => void }. Every key is applied once at startup.
export function createSettings(apply, { autoShake = false } = {}) {
  const state = load();
  if (autoShake) state.autoShake = true;

  const run = (key) => apply[key]?.(state[key], state);
  const changed = (key, fromPreset = false) => {
    run(key);
    if (!fromPreset && QUALITY_KEYS.includes(key) && state.preset !== 'Custom') {
      state.preset = 'Custom';
      presetCtrl.updateDisplay();
    }
    save(state);
  };

  const gui = new GUI({ title: 'Settings  ·  G to hide' });
  gui.domElement.style.zIndex = 11;

  const presetCtrl = gui.add(state, 'preset', [...Object.keys(PRESETS), 'Custom']).name('Quality preset')
    .onChange((name) => {
      const p = PRESETS[name];
      if (!p) return;
      Object.assign(state, p);
      for (const k of Object.keys(p)) changed(k, true);
      gui.controllersRecursive().forEach((c) => c.updateDisplay());
    });

  const render = gui.addFolder('Render');
  render.add(state, 'pixelRatio', 0.5, Math.max(2, Math.min(DPR, 3)), 0.25).name('Pixel ratio').onChange(() => changed('pixelRatio'));
  render.add(state, 'woodOctaves', 1, 6, 1).name('Wood noise octaves').onChange(() => changed('woodOctaves'));
  render.add(state, 'maxBounces', 3, 20, 1).name('Glass ray bounces').onChange(() => changed('maxBounces'));
  render.add(state, 'handShadow').name('Hand shadow').onChange(() => changed('handShadow'));

  const caustics = gui.addFolder('Caustics');
  caustics.add(state, 'causticsOn').name('Enabled').onChange(() => changed('causticsOn'));
  caustics.add(state, 'gridRes', [128, 192, 256, 320, 384, 512, 640, 768, 1024]).name('Ray grid (N×N)').onChange(() => changed('gridRes'));
  caustics.add(state, 'mapRes', [256, 512, 1024, 2048]).name('Map resolution').onChange(() => changed('mapRes'));
  caustics.add(state, 'causticBlur').name('Smooth (4-tap)').onChange(() => changed('causticBlur'));

  const post = gui.addFolder('Post');
  post.add(state, 'bloom').name('Bloom').onChange(() => changed('bloom'));
  post.add(state, 'bloomStrength', 0, 2, 0.01).name('Bloom strength').onChange(() => changed('bloomStrength'));
  post.add(state, 'bloomRadius', 0, 1, 0.01).name('Bloom radius').onChange(() => changed('bloomRadius'));
  post.add(state, 'bloomThreshold', 0, 2, 0.01).name('Bloom threshold').onChange(() => changed('bloomThreshold'));
  post.add(state, 'grain').name('Grain + vignette').onChange(() => changed('grain'));

  const sim = gui.addFolder('Simulation');
  sim.add(state, 'liquidRes', [32, 48, 64, 96, 128, 160]).name('Ripple grid').onChange(() => changed('liquidRes'));
  sim.add(state, 'sloshDamping', 0.01, 0.3, 0.005).name('Slosh damping').onChange(() => changed('sloshDamping'));
  sim.add(state, 'autoShake').name('Auto shake (load test)').onChange(() => changed('autoShake'));

  const iceF = gui.addFolder('Ice');
  iceF.add(state, 'iceCount', 0, 6, 1).name('Cubes').onChange(() => changed('iceCount'));
  iceF.add(state, 'iceSize', 1.6, 3.0, 0.05).name('Cube size cm').onChange(() => changed('iceSize'));
  iceF.add(state, 'iceRound', 0, 1, 0.01).name('Melted (rounding)').onChange(() => changed('iceRound'));
  iceF.add(state, 'iceCloud', 0, 1, 0.01).name('Cloudiness').onChange(() => changed('iceCloud'));
  iceF.add({ drop: () => apply.dropIce?.() }, 'drop').name('Drop fresh ice');

  const look = gui.addFolder('Look');
  look.add(state, 'exposure', 0.3, 3, 0.01).name('Exposure').onChange(() => changed('exposure'));
  look.add(state, 'lightIntensity', 0.5, 8, 0.05).name('Light intensity').onChange(() => changed('lightIntensity'));
  look.add(state, 'lightAzimuth', -80, 80, 1).name('Light azimuth °').onChange(() => changed('lightAzimuth'));
  look.add(state, 'lightElevation', 12, 80, 1).name('Light elevation °').onChange(() => changed('lightElevation'));
  look.add(state, 'fill', 2.0, 7.4, 0.05).name('Whiskey level cm').onChange(() => changed('fill'));
  look.close();

  gui.add(state, 'showStats').name('Show stats').onChange(() => changed('showStats'));
  gui.add({
    reset: () => {
      Object.assign(state, DEFAULTS);
      for (const k of Object.keys(DEFAULTS)) run(k);
      gui.controllersRecursive().forEach((c) => c.updateDisplay());
      save(state);
    },
  }, 'reset').name('Reset all');

  if (window.innerWidth < 700) gui.close();

  addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return;
    if (e.key === 'g' || e.key === 'G') document.body.classList.toggle('hidden-ui');
  });

  for (const k of Object.keys(DEFAULTS)) run(k);
  return state;
}
