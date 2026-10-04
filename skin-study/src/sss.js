// Point-based subsurface scattering, after Jensen & Buhler 2002 ("A Rapid Hierarchical Rendering Technique for
// Translucent Materials"), done on the GPU:
//
//   1. Samples. The skin is split into K evenly spread patches, each one irradiance point that stands for its
//      patch's area. These are the "photons" of the photon-map formulation: the more of them, the finer the
//      light is resolved before it diffuses.
//   2. Irradiance pass. Every point is lit (light, soft shadow, ambient) into a float texture.
//   3. Gather pass. Every vertex of the subdivided skin sums the points around it, weighted by the diffusion
//      profile Rd(r) and each point's area. Points go into a uniform grid with cells half the gather radius
//      wide, so each vertex only walks the cells that can reach it.
//
// Scattering doesn't depend on the view, so both passes only rerun when the light or a parameter changes.
import * as THREE from 'three';
import { LIGHTING, shared } from './shading.js';
import { SKIN_GAUSSIANS } from './profiles.js';

const W = 1024; // data texture width

function dataTexture(data, count, format = THREE.RGBAFormat) {
  const h = Math.max(1, Math.ceil(count / W));
  const full = new Float32Array(W * h * 4);
  full.set(data.subarray(0, Math.min(data.length, full.length)));
  const t = new THREE.DataTexture(full, W, h, format, THREE.FloatType);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  return t;
}

function target(count) {
  return new THREE.WebGLRenderTarget(W, Math.max(1, Math.ceil(count / W)), {
    type: THREE.HalfFloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false,
  });
}

const QUAD_VERT = 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }';

export class Scatter {
  constructor(renderer, geometry, albedo) {
    this.renderer = renderer;
    this.texW = W;
    const p = geometry.attributes.position, n = geometry.attributes.normal, uv = geometry.attributes.uv, ao = geometry.attributes.aAO;
    this.count = p.count;

    // per-vertex area: a third of each adjacent triangle
    const area = new Float32Array(p.count);
    const idx = geometry.index.array, a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    for (let t = 0; t < idx.length; t += 3) {
      a.fromBufferAttribute(p, idx[t]); b.fromBufferAttribute(p, idx[t + 1]); c.fromBufferAttribute(p, idx[t + 2]);
      const ar = b.sub(a).cross(c.sub(a)).length() / 6;
      area[idx[t]] += ar; area[idx[t + 1]] += ar; area[idx[t + 2]] += ar;
    }
    this.vtx = { p, n, uv, ao, area };
    this.totalArea = area.reduce((s, x) => s + x, 0);
    geometry.computeBoundingBox();
    this.bbox = geometry.boundingBox.clone().expandByScalar(0.01);

    // shading points: every vertex of the subdivided skin
    const vp = new Float32Array(p.count * 4);
    for (let i = 0; i < p.count; i++) vp.set([p.getX(i), p.getY(i), p.getZ(i), 1], i * 4);
    this.tVPos = dataTexture(vp, p.count);
    this.rtScatter = target(p.count);

    this.scene = new THREE.Scene();
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3)));
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);

    this.irradianceMat = new THREE.ShaderMaterial({
      uniforms: {
        ...shared,
        tSPos: { value: null }, tSNor: { value: null }, tSUv: { value: null }, tAlbedo: { value: albedo },
        uCount: { value: 0 }, uPre: { value: 0.5 },
      },
      vertexShader: QUAD_VERT,
      fragmentShader: /* glsl */ `
        ${LIGHTING}
        uniform sampler2D tSPos;
        uniform sampler2D tSNor;
        uniform sampler2D tSUv;
        uniform sampler2D tAlbedo;
        uniform int uCount;
        uniform float uPre;
        void main() {
          ivec2 px = ivec2(gl_FragCoord.xy);
          if (px.x + px.y * ${W} >= uCount) { gl_FragColor = vec4(0.0); return; }
          vec3 x = texelFetch(tSPos, px, 0).xyz;
          vec4 no = texelFetch(tSNor, px, 0);
          vec3 n = normalize(no.xyz);
          vec3 l = normalize(uLightPos - x);
          vec3 E = uLightColor * max(dot(n, l), 0.0) * shadowAt(x, n) + hemi(n) * no.w;
          E *= pow(texture(tAlbedo, texelFetch(tSUv, px, 0).xy).rgb, vec3(uPre)); // pre-scatter texturing
          gl_FragColor = vec4(E, 1.0);
        }
      `,
      toneMapped: false,
    });

    const g = SKIN_GAUSSIANS.slice(1);
    this.gatherMat = new THREE.ShaderMaterial({
      defines: { NG: g.length },
      uniforms: {
        tVPos: { value: this.tVPos }, tSPos: { value: null }, tE: { value: null }, tCells: { value: null },
        uVCount: { value: p.count }, uGridMin: { value: new THREE.Vector3() }, uGridN: { value: new THREE.Vector3() },
        uCell: { value: 1 }, uRadius: { value: 1 }, uMm: { value: 10 },
        uProfile: { value: 0 }, uNormalize: { value: true },
        uZr: { value: new THREE.Vector3() }, uZv: { value: new THREE.Vector3() }, uStr: { value: new THREE.Vector3() }, uAlpha: { value: new THREE.Vector3() },
        uGV: { value: g.map((x) => x.v) }, uGW: { value: g.map((x) => new THREE.Vector3(...x.w)) },
      },
      vertexShader: QUAD_VERT,
      fragmentShader: /* glsl */ `
        uniform sampler2D tVPos;
        uniform sampler2D tSPos;
        uniform sampler2D tE;
        uniform sampler2D tCells;
        uniform int uVCount;
        uniform vec3 uGridMin;
        uniform vec3 uGridN;
        uniform float uCell;
        uniform float uRadius;
        uniform float uMm;       // millimetres per scene unit, divided by the scatter scale
        uniform int uProfile;    // 0 dipole, 1 d'Eon sum of Gaussians
        uniform bool uNormalize;
        uniform vec3 uZr;
        uniform vec3 uZv;
        uniform vec3 uStr;
        uniform vec3 uAlpha;
        uniform float uGV[NG];
        uniform vec3 uGW[NG];

        vec3 dipole(float r) {
          vec3 dr = sqrt(r * r + uZr * uZr), dv = sqrt(r * r + uZv * uZv);
          return uAlpha / 12.566371 * (uZr * (uStr * dr + 1.0) * exp(-uStr * dr) / (dr * dr * dr)
                                     + uZv * (uStr * dv + 1.0) * exp(-uStr * dv) / (dv * dv * dv));
        }
        vec3 sog(float r) {
          vec3 s = vec3(0.0);
          for (int i = 0; i < NG; i++) s += uGW[i] / (6.2831853 * uGV[i]) * exp(-r * r / (2.0 * uGV[i]));
          return s;
        }

        void main() {
          ivec2 px = ivec2(gl_FragCoord.xy);
          if (px.x + px.y * ${W} >= uVCount) { gl_FragColor = vec4(0.0); return; }
          vec3 x = texelFetch(tVPos, px, 0).xyz;
          ivec3 N = ivec3(uGridN);
          ivec3 c = ivec3(floor((x - uGridMin) / uCell));
          float r2max = uRadius * uRadius;
          vec3 sum = vec3(0.0), wsum = vec3(0.0);
          float nearR2 = 1e9;
          vec3 nearE = vec3(0.0);
          vec3 f = (x - uGridMin) / uCell - vec3(c); // position inside its cell, 0..1
          for (int dz = -2; dz <= 2; dz++) for (int dy = -2; dy <= 2; dy++) for (int dx = -2; dx <= 2; dx++) {
            ivec3 o = ivec3(dx, dy, dz);
            ivec3 cc = c + o;
            if (any(lessThan(cc, ivec3(0))) || any(greaterThanEqual(cc, N))) continue;
            // skip cells that can't reach the gather sphere
            vec3 gap = max(vec3(0.0), max(vec3(o) - f, f - vec3(o) - 1.0)) * uCell;
            if (dot(gap, gap) > r2max) continue;
            int ci = cc.x + cc.y * N.x + cc.z * N.x * N.y;
            vec2 sc = texelFetch(tCells, ivec2(ci % ${W}, ci / ${W}), 0).xy;
            int start = int(sc.x), cnt = int(sc.y);
            for (int k = 0; k < 8192; k++) {
              if (k >= cnt) break;
              int j = start + k;
              ivec2 pj = ivec2(j % ${W}, j / ${W});
              vec4 P = texelFetch(tSPos, pj, 0);
              vec3 d = P.xyz - x;
              float r2 = dot(d, d);
              if (r2 < nearR2) { nearR2 = r2; nearE = texelFetch(tE, pj, 0).rgb; }
              if (r2 > r2max) continue;
              // a point stands for a patch: don't evaluate the profile closer than the patch's own radius
              float r = max(sqrt(r2), 0.5 * sqrt(P.w / 3.14159)) * uMm;
              vec3 w = (uProfile == 0 ? dipole(r) : sog(r)) * P.w * uMm * uMm;
              sum += w * texelFetch(tE, pj, 0).rgb;
              wsum += w;
            }
          }
          // Normalised: a weighted average of the irradiance around x, so point density can't bias it. With
          // too few photons for the radius, a vertex may find none at all; it takes the nearest one instead.
          vec3 avg = wsum.r > 1e-12 ? sum / max(wsum, vec3(1e-12)) : nearE;
          gl_FragColor = vec4(uNormalize ? avg : sum, 1.0);
        }
      `,
      toneMapped: false,
    });

    this.samplesTarget = 0;
    this.radius = 0;
    this.dirty = true;
  }

  // Split the surface into about `target` patches: a grid in space, also split by which way the surface
  // faces (so the two sides of an ear don't merge). Each patch keeps its total area and the vertex nearest
  // its centroid.
  setSamples(targetCount) {
    if (targetCount === this.samplesTarget) return;
    this.samplesTarget = targetCount;
    const { p, n, uv, ao, area } = this.vtx;
    const N = p.count;
    let members;
    if (targetCount >= N) {
      members = null;
    } else {
      const cluster = (s) => {
        const m = new Map();
        const o = this.bbox.min;
        for (let i = 0; i < N; i++) {
          const ix = Math.floor((p.getX(i) - o.x) / s), iy = Math.floor((p.getY(i) - o.y) / s), iz = Math.floor((p.getZ(i) - o.z) / s);
          const nx = n.getX(i), ny = n.getY(i), nz = n.getZ(i);
          const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
          const face = ax > ay && ax > az ? (nx > 0 ? 0 : 1) : ay > az ? (ny > 0 ? 2 : 3) : (nz > 0 ? 4 : 5);
          const key = ((ix * 1024 + iy) * 1024 + iz) * 6 + face;
          let arr = m.get(key);
          if (!arr) m.set(key, (arr = []));
          arr.push(i);
        }
        return m;
      };
      // search the cell size that yields close to the requested count
      let lo = Math.sqrt(this.totalArea / targetCount) * 0.3, hi = lo * 10;
      for (let it = 0; it < 14; it++) {
        const mid = Math.sqrt(lo * hi);
        const k = cluster(mid).size;
        if (Math.abs(k - targetCount) / targetCount < 0.02) { lo = hi = mid; break; }
        if (k > targetCount) lo = mid; else hi = mid;
      }
      members = [...cluster(Math.sqrt(lo * hi)).values()];
    }

    const K = members ? members.length : N;
    const pos = new Float32Array(K * 4), nor = new Float32Array(K * 4), tuv = new Float32Array(K * 4);
    const c = new THREE.Vector3();
    for (let k = 0; k < K; k++) {
      let rep = k, A = area[k];
      if (members) {
        const m = members[k];
        c.set(0, 0, 0);
        A = 0;
        for (const i of m) { c.x += p.getX(i) * area[i]; c.y += p.getY(i) * area[i]; c.z += p.getZ(i) * area[i]; A += area[i]; }
        c.divideScalar(A);
        let best = Infinity;
        for (const i of m) {
          const d = (p.getX(i) - c.x) ** 2 + (p.getY(i) - c.y) ** 2 + (p.getZ(i) - c.z) ** 2;
          if (d < best) { best = d; rep = i; }
        }
      }
      pos.set([p.getX(rep), p.getY(rep), p.getZ(rep), A], k * 4);
      nor.set([n.getX(rep), n.getY(rep), n.getZ(rep), ao ? ao.getX(rep) : 1], k * 4);
      tuv.set([uv.getX(rep), uv.getY(rep), 0, 0], k * 4);
    }
    this.samples = { pos, nor, uv: tuv, K };
    this.radius = 0; // force a grid rebuild
    return K;
  }

  // Sort the points into a grid with cells half a gather radius wide (the gather walks the 5x5x5 around it).
  setRadius(R) {
    R = Math.max(R, 0.3);
    if (R === this.radius && this.gridBuilt === this.samples) return;
    this.radius = R;
    this.gridBuilt = this.samples;
    const cellSize = Math.max(R / 2, 0.3); // (the 5x5x5 walk still covers R when the cells are larger)
    const { pos, nor, uv, K } = this.samples;
    const o = this.bbox.min, size = this.bbox.getSize(new THREE.Vector3());
    const gn = [Math.ceil(size.x / cellSize) + 1, Math.ceil(size.y / cellSize) + 1, Math.ceil(size.z / cellSize) + 1];
    const cells = gn[0] * gn[1] * gn[2];
    const cellOf = new Int32Array(K);
    const counts = new Int32Array(cells);
    for (let k = 0; k < K; k++) {
      const ix = Math.floor((pos[k * 4] - o.x) / cellSize), iy = Math.floor((pos[k * 4 + 1] - o.y) / cellSize), iz = Math.floor((pos[k * 4 + 2] - o.z) / cellSize);
      const ci = ix + iy * gn[0] + iz * gn[0] * gn[1];
      cellOf[k] = ci;
      counts[ci]++;
    }
    const start = new Int32Array(cells);
    for (let i = 1; i < cells; i++) start[i] = start[i - 1] + counts[i - 1];
    const fill = start.slice();
    const sp = new Float32Array(K * 4), sn = new Float32Array(K * 4), su = new Float32Array(K * 4);
    for (let k = 0; k < K; k++) {
      const j = fill[cellOf[k]]++;
      sp.set(pos.subarray(k * 4, k * 4 + 4), j * 4);
      sn.set(nor.subarray(k * 4, k * 4 + 4), j * 4);
      su.set(uv.subarray(k * 4, k * 4 + 4), j * 4);
    }
    const ct = new Float32Array(cells * 4);
    for (let i = 0; i < cells; i++) { ct[i * 4] = start[i]; ct[i * 4 + 1] = counts[i]; }

    [this.tSPos, this.tSNor, this.tSUv, this.tCells].forEach((t) => t?.dispose());
    this.tSPos = dataTexture(sp, K);
    this.tSNor = dataTexture(sn, K);
    this.tSUv = dataTexture(su, K);
    this.tCells = dataTexture(ct, cells);
    this.rtE?.dispose();
    this.rtE = target(K);

    const iu = this.irradianceMat.uniforms;
    iu.tSPos.value = this.tSPos; iu.tSNor.value = this.tSNor; iu.tSUv.value = this.tSUv; iu.uCount.value = K;
    const gu = this.gatherMat.uniforms;
    gu.tSPos.value = this.tSPos; gu.tE.value = this.rtE.texture; gu.tCells.value = this.tCells;
    gu.uGridMin.value.copy(o); gu.uGridN.value.set(...gn); gu.uCell.value = cellSize; gu.uRadius.value = R;
    this.maxPerCell = counts.reduce((m, x) => Math.max(m, x), 0);
    this.dirty = true;
    this.points?.geometry.setDrawRange(0, K);
  }

  update() {
    if (!this.dirty) return false;
    this.dirty = false;
    const r = this.renderer, prev = r.getRenderTarget();
    this.quad.material = this.irradianceMat;
    r.setRenderTarget(this.rtE);
    r.render(this.scene, this.cam);
    this.quad.material = this.gatherMat;
    r.setRenderTarget(this.rtScatter);
    r.render(this.scene, this.cam);
    r.setRenderTarget(prev);
    return true;
  }

  get texture() { return this.rtScatter.texture; }

  // the irradiance points themselves, drawn as dots and coloured by the light they received
  createPoints() {
    const MAX = this.count;
    const ids = new Float32Array(MAX);
    for (let i = 0; i < MAX; i++) ids[i] = i;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX * 3), 3));
    g.setAttribute('aSid', new THREE.BufferAttribute(ids, 1));
    g.setDrawRange(0, this.samples?.K ?? 0);
    const self = this;
    const mat = new THREE.ShaderMaterial({
      uniforms: { tSPos: { value: null }, tE: { value: null }, uPx: { value: 1 } },
      vertexShader: /* glsl */ `
        attribute float aSid;
        uniform sampler2D tSPos;
        uniform sampler2D tE;
        uniform float uPx;
        varying vec3 vE;
        void main() {
          int id = int(aSid + 0.5);
          ivec2 c = ivec2(id % ${W}, id / ${W});
          vec4 P = texelFetch(tSPos, c, 0);
          vE = texelFetch(tE, c, 0).rgb;
          vec4 mv = modelViewMatrix * vec4(P.xyz, 1.0);
          gl_PointSize = max(1.5, uPx * sqrt(P.w) / -mv.z);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vE;
        void main() {
          vec2 q = gl_PointCoord * 2.0 - 1.0;
          if (dot(q, q) > 1.0) discard;
          gl_FragColor = vec4(vE, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });
    this.points = new THREE.Points(g, mat);
    this.points.frustumCulled = false;
    this.points.onBeforeRender = (renderer, scene, camera) => {
      mat.uniforms.tSPos.value = self.tSPos;
      mat.uniforms.tE.value = self.rtE.texture;
      mat.uniforms.uPx.value = renderer.getDrawingBufferSize(new THREE.Vector2()).y / (2 * Math.tan((camera.fov * Math.PI) / 360)) * 0.9;
    };
    return this.points;
  }
}
