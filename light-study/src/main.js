import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import GUI from 'lil-gui';
import { buildRoom, animateCurtains, animateFoliage, WINDOW, ROOM } from './room.js';
import { sunPosition, moonPosition, lightingFor, phaseName, makeSky, smooth } from './sky.js';
import { makeDust, makeShafts } from './effects.js';
import { createUI } from './ui.js';

const params = new URLSearchParams(location.search);
const state = {
  hours: params.has('t') ? +params.get('t') : 18.4,
  facing: params.has('face') ? +params.get('face') : 330,
  playing: false,
  timeAnim: null,
};
const opts = { ao: true, bloom: true, beams: true, dust: true, beamDensity: 0.1, wind: 0.6, shadowRes: 2048, pixelRatio: Math.min(devicePixelRatio, 2) };

// ------------------------------------------------------------------ renderer / scene

const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(opts.pixelRatio);
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.prepend(renderer.domElement);
RectAreaLightUniformsLib.init();

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xbcd4f5, 14, 70); // haze outside; the room is well inside the near distance
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

const camera = new THREE.PerspectiveCamera(52, innerWidth / innerHeight, 0.05, 200);
camera.position.set(2.45, 1.38, 2.25);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(-0.7, 1.0, -1.1);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.enablePan = false;
controls.minDistance = 2.2;
controls.maxDistance = 5.2;
controls.minPolarAngle = 1.05;
controls.maxPolarAngle = 1.72;
controls.rotateSpeed = 0.45;
controls.update();
const baseAz = controls.getAzimuthalAngle();
controls.minAzimuthAngle = baseAz - 0.55;
controls.maxAzimuthAngle = baseAz + 0.4;

const room = buildRoom(scene);
const sky = makeSky();
scene.add(sky.mesh);
const dust = makeDust();
scene.add(dust.points);
const shafts = makeShafts();
scene.add(shafts.mesh);

// ------------------------------------------------------------------ lights

const sun = new THREE.DirectionalLight(0xffffff, 3);
sun.castShadow = true;
sun.shadow.mapSize.set(opts.shadowRes, opts.shadowRes);
Object.assign(sun.shadow.camera, { left: -6.5, right: 6.5, top: 6.5, bottom: -6.5, near: 1, far: 45 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.02;
sun.shadow.radius = 3;
sun.target.position.set(-1, 1, 0);
scene.add(sun, sun.target);

const hemi = new THREE.HemisphereLight(0xbcd4f5, 0x8a6a4f, 0.4);
scene.add(hemi);

// soft skylight through the glass
const windowLight = new THREE.RectAreaLight(0xffffff, 2, WINDOW.z1 - WINDOW.z0, WINDOW.y1 - WINDOW.y0);
windowLight.position.set(WINDOW.x + 0.02, (WINDOW.y0 + WINDOW.y1) / 2, (WINDOW.z0 + WINDOW.z1) / 2);
windowLight.lookAt(0, windowLight.position.y, windowLight.position.z);
scene.add(windowLight);

// cheap bounce: warm light rising off the sunlit patch on the floor
const bounce = new THREE.PointLight(0xffb070, 0, 0, 1.1);
scene.add(bounce);

// lamps
const warm = new THREE.Color(0xffa55c);
const spot = new THREE.SpotLight(warm, 0, 5, 1.0, 0.7, 1.4);
spot.position.copy(room.anchors.floorLamp).add(new THREE.Vector3(0, -0.14, 0));
spot.target.position.copy(room.anchors.floorLamp).setY(0);
spot.castShadow = true;
spot.shadow.mapSize.set(1024, 1024);
spot.shadow.bias = -0.0008;
spot.shadow.normalBias = 0.02;
scene.add(spot, spot.target);
const glow = new THREE.PointLight(warm, 0, 6, 1.4);
glow.position.copy(room.anchors.floorLamp).add(new THREE.Vector3(0, 0.06, 0));
scene.add(glow);
const tableLamp = new THREE.PointLight(warm, 0, 5, 1.5);
tableLamp.position.copy(room.anchors.tableLamp);
scene.add(tableLamp);
const candle = new THREE.PointLight(0xff9a45, 0, 3, 1.6);
candle.position.copy(room.anchors.candle);
scene.add(candle);

// ------------------------------------------------------------------ post

const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(innerWidth * opts.pixelRatio, innerHeight * opts.pixelRatio, { type: THREE.HalfFloatType, samples: 4 }));
composer.addPass(new RenderPass(scene, camera));
const gtao = new GTAOPass(scene, camera, innerWidth, innerHeight);
gtao.updateGtaoMaterial({ radius: 0.45, distanceExponent: 1.4, thickness: 1.2, scale: 1.1, samples: 16 });
gtao.blendIntensity = 0.9;
// keep the see-through things out of the AO normal/depth pass
const aoHidden = [sky.mesh, shafts.mesh, ...room.curtains.map((c) => c.mesh)];
const gtaoRender = gtao.render.bind(gtao);
gtao.render = (...args) => {
  const vis = aoHidden.map((o) => o.visible);
  aoHidden.forEach((o) => { o.visible = false; });
  gtaoRender(...args);
  aoHidden.forEach((o, i) => { o.visible = vis[i]; });
};
composer.addPass(gtao);
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.22, 0.65, 0.9);
composer.addPass(bloom);
composer.addPass(new OutputPass());
const finish = new ShaderPass({
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uAspect: { value: 1 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform float uTime, uAspect; varying vec2 vUv;
    float h(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      vec2 q = (vUv - 0.5) * vec2(uAspect, 1.0);
      c.rgb *= mix(0.72, 1.0, smoothstep(1.1, 0.35, length(q)));
      c.rgb += (h(gl_FragCoord.xy + fract(uTime * 7.3) * 400.0) - 0.5) * 0.018;
      gl_FragColor = c;
    }
  `,
});
composer.addPass(finish);

function resize() {
  const w = innerWidth, h = innerHeight;
  camera.aspect = w / h;
  camera.fov = w / h < 1 ? 70 : 52;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(w, h);
  gtao.setSize(w, h);
  bloom.setSize(w, h);
  finish.uniforms.uAspect.value = w / h;
  dust.uniforms.uScale.value = h * renderer.getPixelRatio() * 0.006;
}
addEventListener('resize', resize);
resize();

// ------------------------------------------------------------------ settings

const gui = new GUI({ title: 'Extras' });
gui.add(opts, 'wind', 0, 1.5, 0.01).name('Breeze');
gui.add(opts, 'beams').name('Light beams').onChange((v) => { shafts.mesh.visible = v; });
gui.add(opts, 'beamDensity', 0, 0.2, 0.005).name('Beam haze');
gui.add(opts, 'dust').name('Dust motes').onChange((v) => { dust.points.visible = v; });
gui.add(opts, 'ao').name('Ambient occlusion').onChange((v) => { gtao.enabled = v; });
gui.add(opts, 'bloom').name('Bloom').onChange((v) => { bloom.enabled = v; });
gui.add(opts, 'shadowRes', [1024, 2048, 4096]).name('Sun shadow res').onChange((v) => {
  sun.shadow.mapSize.set(v, v);
  sun.shadow.map?.dispose();
  sun.shadow.map = null;
});
gui.add(opts, 'pixelRatio', 0.5, Math.max(2, devicePixelRatio), 0.25).name('Pixel ratio').onChange((v) => { renderer.setPixelRatio(v); resize(); });
gui.close();

// ------------------------------------------------------------------ UI

const ui = createUI(state, {
  onPreset(target) {
    const from = state.hours;
    let diff = (((target - from) % 24) + 36) % 24 - 12; // shortest way around the clock
    state.timeAnim = { from, diff, t: 0, dur: 1.2 + Math.abs(diff) * 0.22 };
  },
});

// ------------------------------------------------------------------ frame

const L = { zenith: new THREE.Color(), horizon: new THREE.Color(), sunColor: new THREE.Color() };
const sunDir = new THREE.Vector3(), moonDir = new THREE.Vector3(), lightDir = new THREE.Vector3();
const moonColor = new THREE.Color(0x9fb4ff);
const lightColor = new THREE.Color();
const floorTint = new THREE.Color(0xd9a878);
const tmpC = new THREE.Color();
const winCenter = new THREE.Vector3(WINDOW.x, (WINDOW.y0 + WINDOW.y1) / 2, (WINDOW.z0 + WINDOW.z1) / 2);
const clock = new THREE.Clock();
const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

function frame() {
  const dt = Math.min(clock.getDelta(), 1 / 20);
  const t = clock.elapsedTime;

  if (state.timeAnim) {
    const a = state.timeAnim;
    a.t += dt / a.dur;
    const k = ease(Math.min(a.t, 1));
    state.hours = (((a.from + a.diff * k) % 24) + 24) % 24;
    if (a.t >= 1) state.timeAnim = null;
  } else if (state.playing) {
    state.hours = (state.hours + dt * (24 / 70)) % 24; // a day in 70 s
  }

  const sp = sunPosition(state.hours, state.facing, sunDir);
  const el = sp.elevation;
  lightingFor(el, L);

  // one directional light: the sun, handing over to the moon after dusk
  const moon = moonPosition(sp.azimuth, state.facing, moonDir);
  const sunI = L.sunIntensity;
  const moonI = 0.28 * L.night;
  if (sunI > 0.001 || moonI < 0.001) {
    lightDir.copy(sunDir);
    lightColor.copy(L.sunColor);
    sun.intensity = sunI;
  } else {
    lightDir.copy(moon.dir);
    lightColor.copy(moonColor);
    sun.intensity = moonI;
  }
  sun.color.copy(lightColor);
  sun.position.copy(sun.target.position).addScaledVector(lightDir, 22);
  const beamStrength = sun.intensity * smooth(-0.02, -0.15, lightDir.x) * (lightDir.y > 0 ? 1 : 0);

  hemi.color.copy(L.horizon).lerp(L.zenith, 0.4);
  hemi.groundColor.copy(floorTint).multiplyScalar(0.5);
  hemi.intensity = 0.04 + L.day * 0.38;
  windowLight.color.copy(L.horizon).lerp(L.zenith, 0.55);
  windowLight.intensity = 0.12 + L.day * 3.0 + (1 - L.day) * (1 - L.night) * 1.2;

  // bounce from wherever the beam lands on the floor
  if (lightDir.y > 0.02) {
    const D = lightDir;
    const tt = winCenter.y / D.y;
    bounce.position.set(
      THREE.MathUtils.clamp(winCenter.x - D.x * tt, ROOM.x0 + 0.3, ROOM.x1 - 0.3), 0.3,
      THREE.MathUtils.clamp(winCenter.z - D.z * tt, ROOM.z0 + 0.3, ROOM.z1 - 0.3));
  }
  bounce.color.copy(lightColor).multiply(floorTint);
  bounce.intensity = beamStrength * 0.55;

  // lamps + candle
  const lamps = L.lamps;
  const flicker = 0.82 + 0.1 * Math.sin(t * 13.1) * Math.sin(t * 7.7 + 1.3) + 0.08 * Math.sin(t * 23.3);
  spot.intensity = lamps * 10;
  glow.intensity = lamps * 1.4;
  tableLamp.intensity = lamps * 1.3;
  candle.intensity = lamps * 0.5 * flicker;
  room.flame.material.opacity = lamps;
  room.flame.scale.set(1, 2.2 + flicker * 0.4, 1);
  room.emissive.shades.emissiveIntensity = lamps * 1.6;

  // sheers glow with the light behind them
  const backlit = beamStrength * 0.35;
  room.emissive.curtains.emissive.copy(tmpC.copy(L.horizon).lerp(L.zenith, 0.3).multiplyScalar(0.5 + L.day)).add(lightColor.clone().multiplyScalar(backlit));
  room.emissive.curtains.emissiveIntensity = 0.1 + 0.5 * L.day + 0.05 * lamps;

  scene.environmentIntensity = 0.04 + 0.32 * L.day + 0.05 * lamps;
  renderer.toneMappingExposure = L.exposure;

  scene.fog.color.copy(L.horizon).lerp(L.zenith, 0.25);

  // sky
  sky.uniforms.uZenith.value.copy(L.zenith);
  sky.uniforms.uHorizon.value.copy(L.horizon);
  sky.uniforms.uSunDir.value.copy(sunDir);
  sky.uniforms.uSunColor.value.copy(L.sunColor);
  sky.uniforms.uSunVis.value = smooth(-3, 1, el);
  sky.uniforms.uMoonDir.value.copy(moonDir);
  sky.uniforms.uNight.value = L.night;
  sky.uniforms.uTime.value = t;
  sky.uniforms.uBright.value = 1.6 + L.day * 1.2;

  // beams + dust follow whichever light is shining in
  shafts.update(lightDir);
  shafts.uniforms.uSunDir.value.copy(lightDir);
  shafts.uniforms.uColor.value.copy(lightColor).multiplyScalar(beamStrength);
  shafts.uniforms.uDensity.value = opts.beamDensity * (0.35 + 0.9 * (1 - smooth(6, 40, el))); // beams read best in low sun
  shafts.uniforms.uTime.value = t;
  shafts.uniforms.uFrame.value = (shafts.uniforms.uFrame.value + 1) % 64;
  dust.uniforms.uSunDir.value.copy(lightDir);
  dust.uniforms.uColor.value.copy(lightColor).lerp(tmpC.setRGB(1, 1, 1), 0.35).multiplyScalar(beamStrength * 0.22);
  dust.uniforms.uTime.value = t;

  animateCurtains(room.curtains, t, opts.wind);
  animateFoliage(room.foliage, t, opts.wind);
  finish.uniforms.uTime.value = t;

  controls.update();
  ui.update({ hours: state.hours, facing: state.facing, sunAzimuth: sp.azimuth, elevation: el, phase: phaseName(state.hours, el) });
  composer.render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
