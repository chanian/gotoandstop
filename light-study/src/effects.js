import * as THREE from 'three';
import { ROOM, WINDOW, PANES, CURTAINS } from './room.js';

// Shared GLSL: is a point lit through a window pane? Projects back along the sun direction to the
// window plane, checks the panes, and dims light that passes through the sheer curtains.
const BEAM_GLSL = /* glsl */ `
uniform vec3 uSunDir;
uniform vec4 uPanes[3];     // z0, z1, y0, y1
uniform vec4 uCurtains;     // curtain A z0, z1, curtain B z0, z1
float paneLight(vec3 p) {
  if (uSunDir.x > -0.02) return 0.0;
  float t = (${WINDOW.x.toFixed(2)} - p.x) / uSunDir.x;
  if (t < 0.0) return 0.0;
  vec3 w = p + uSunDir * t;
  float lit = 0.0;
  for (int i = 0; i < 3; i++) {
    vec4 r = uPanes[i];
    float inside = step(r.x, w.z) * step(w.z, r.y) * step(r.z, w.y) * step(w.y, r.w);
    lit = max(lit, inside);
  }
  float curtain = step(uCurtains.x, w.z) * step(w.z, uCurtains.y) + step(uCurtains.z, w.z) * step(w.z, uCurtains.w);
  return lit * (1.0 - 0.62 * min(curtain, 1.0));
}
`;

function paneUniform() {
  return PANES.map(([a, b]) => new THREE.Vector4(a, b, WINDOW.y0 + 0.045, WINDOW.y1 - 0.045));
}

// ---------------------------------------------------------------- dust motes

export function makeDust(count = 900) {
  const pos = new Float32Array(count * 3);
  const seed = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = ROOM.x0 + 0.1 + Math.random() * (ROOM.x1 - ROOM.x0 - 0.2);
    pos[i * 3 + 1] = 0.1 + Math.random() * (ROOM.y1 - 0.2);
    pos[i * 3 + 2] = ROOM.z0 + 0.1 + Math.random() * (ROOM.z1 - ROOM.z0 - 0.2);
    seed[i] = Math.random();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
  const uniforms = {
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uPanes: { value: paneUniform() },
    uCurtains: { value: new THREE.Vector4(CURTAINS[0].z0, CURTAINS[0].z1, CURTAINS[1].z0, CURTAINS[1].z1) },
    uColor: { value: new THREE.Color() },
    uTime: { value: 0 },
    uScale: { value: 1 },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: BEAM_GLSL + /* glsl */ `
      attribute float seed;
      uniform float uTime, uScale;
      varying float vLit;
      varying float vTw;
      void main() {
        vec3 p = position;
        float s = seed * 6.2831;
        // slow drifting, looping in a small volume
        p += vec3(sin(uTime * 0.07 + s * 3.0), sin(uTime * 0.05 + s * 5.0) * 0.6 - 0.2 * fract(uTime * 0.01 + seed), cos(uTime * 0.06 + s * 2.0)) * 0.18;
        p.y = mod(p.y, ${ROOM.y1.toFixed(2)});
        vLit = paneLight(p);
        vTw = 0.55 + 0.45 * sin(uTime * (0.8 + seed * 2.0) + s * 10.0);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = uScale * (1.2 + seed * 2.2) / -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      varying float vLit;
      varying float vTw;
      void main() {
        if (vLit < 0.01) discard;
        vec2 c = gl_PointCoord - 0.5;
        float a = smoothstep(0.5, 0.0, length(c));
        gl_FragColor = vec4(uColor * a * vLit * vTw, 1.0);
      }
    `,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  return { points, uniforms };
}

// ---------------------------------------------------------------- light shafts
// A prism = the window extruded along the sunlight. Its front faces are rasterised; each fragment
// then works out, analytically, how far the view ray travels through each pane's beam (clipped to
// the room), and adds in-scattered light with a forward-scattering phase.

export function makeShafts() {
  const uniforms = {
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uPanes: { value: paneUniform() },
    uCurtains: { value: new THREE.Vector4(CURTAINS[0].z0, CURTAINS[0].z1, CURTAINS[1].z0, CURTAINS[1].z1) },
    uColor: { value: new THREE.Color() },
    uDensity: { value: 0.05 },
    uTime: { value: 0 },
    uFrame: { value: 0 },
  };
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(8 * 3), 3));
  geo.setIndex([0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2, 2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0]);
  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: BEAM_GLSL + /* glsl */ `
      uniform vec3 uColor;
      uniform float uDensity, uTime, uFrame;
      varying vec3 vWorld;

      // ray vs box, returns (tNear, tFar)
      vec2 boxHit(vec3 ro, vec3 rd, vec3 bmin, vec3 bmax) {
        vec3 inv = 1.0 / rd;
        vec3 t0 = (bmin - ro) * inv, t1 = (bmax - ro) * inv;
        vec3 tn = min(t0, t1), tf = max(t0, t1);
        return vec2(max(max(tn.x, tn.y), tn.z), min(min(tf.x, tf.y), tf.z));
      }

      void main() {
        vec3 ro = cameraPosition;
        vec3 rd = normalize(vWorld - ro);
        vec2 room = boxHit(ro, rd, vec3(${ROOM.x0.toFixed(2)}, 0.0, ${ROOM.z0.toFixed(2)}), vec3(${ROOM.x1.toFixed(2)}, ${ROOM.y1.toFixed(2)}, ${ROOM.z1.toFixed(2)}));
        float tMax = room.y;
        // march the in-room part of the ray and integrate light from the panes
        float t0 = max(room.x, 0.0);
        float len = max(tMax - t0, 0.0);
        const int N = 28;
        float dt = len / float(N);
        // interleaved gradient noise, shifted per frame: smoother than white noise
        vec2 fc = gl_FragCoord.xy + 5.588 * uFrame;
        float jitter = fract(52.9829189 * fract(dot(fc, vec2(0.06711056, 0.00583715))));
        float acc = 0.0;
        for (int i = 0; i < N; i++) {
          vec3 p = ro + rd * (t0 + (float(i) + jitter) * dt);
          float dust = 0.75 + 0.25 * sin(p.x * 7.0 + uTime * 0.3) * sin(p.z * 5.0 - uTime * 0.2) * sin(p.y * 6.0 + uTime * 0.25);
          acc += paneLight(p) * dust;
        }
        acc *= dt;
        float mu = dot(rd, -uSunDir);
        float phase = 0.35 + 1.6 * pow(max(mu, 0.0), 6.0);
        gl_FragColor = vec4(uColor * acc * uDensity * phase, 1.0);
      }
    `,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 10;

  const corners = [
    new THREE.Vector3(WINDOW.x, WINDOW.y0, WINDOW.z0),
    new THREE.Vector3(WINDOW.x, WINDOW.y0, WINDOW.z1),
    new THREE.Vector3(WINDOW.x, WINDOW.y1, WINDOW.z1),
    new THREE.Vector3(WINDOW.x, WINDOW.y1, WINDOW.z0),
  ];
  const tmp = new THREE.Vector3();
  // rebuild the prism for the current sun direction
  function update(sunDir) {
    const pos = geo.attributes.position;
    const D = tmp.copy(sunDir).negate();
    for (let i = 0; i < 4; i++) {
      pos.setXYZ(i, corners[i].x + 0.01, corners[i].y, corners[i].z);
      pos.setXYZ(i + 4, corners[i].x + D.x * 14, corners[i].y + D.y * 14, corners[i].z + D.z * 14);
    }
    pos.needsUpdate = true;
    // keep every triangle facing outward so only the near side of the beam is rasterised
    const idx = geo.index;
    const c = new THREE.Vector3();
    for (let i = 0; i < 8; i++) c.add(va.fromBufferAttribute(pos, i));
    c.multiplyScalar(1 / 8);
    for (let f = 0; f < idx.count; f += 3) {
      va.fromBufferAttribute(pos, idx.getX(f));
      vb.fromBufferAttribute(pos, idx.getX(f + 1));
      vc.fromBufferAttribute(pos, idx.getX(f + 2));
      const n = vb.clone().sub(va).cross(vc.clone().sub(va));
      const mid = va.add(vb).add(vc).multiplyScalar(1 / 3).sub(c);
      if (n.dot(mid) < 0) {
        const t = idx.getX(f + 1);
        idx.setX(f + 1, idx.getX(f + 2));
        idx.setX(f + 2, t);
      }
    }
    idx.needsUpdate = true;
  }
  const va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3();
  return { mesh, uniforms, update };
}
