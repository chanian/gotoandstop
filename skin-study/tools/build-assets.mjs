// Builds skin-study/assets/head.glb from Microsoft Rocketbox Female_Adult_07 (MIT).
//
//   npm i three@0.182.0 three-subdivide three-mesh-bvh@0.9.1 meshoptimizer \
//         @gltf-transform/core @gltf-transform/extensions @gltf-transform/functions
//   node build-assets.mjs path/to/Female_Adult_07_facial.fbx ../assets/head.glb
//
// Splits the avatar into skin / eyes / lashes / hair, turns it Y-up with the head at the origin (units: cm),
// makes a Loop-subdivided copy of the skin for the scattering pass, and bakes per-vertex ambient occlusion.
import fs from 'fs';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { LoopSubdivision } from 'three-subdivide';
import { MeshBVH } from 'three-mesh-bvh';
import { Document, NodeIO } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { reorder, quantize } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';

const [, , fbxPath, outPath] = process.argv;
THREE.TextureLoader.prototype.load = () => new THREE.Texture();
const buf = fs.readFileSync(fbxPath);
const root = new FBXLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
let src;
root.traverse((o) => { if (o.isMesh) src = o; });
const G = src.geometry, P = G.attributes.position, N = G.attributes.normal, UV = G.attributes.uv;
const matName = (i) => [].concat(src.material)[i].name;

// ---- split into connected parts (the FBX is unindexed, so weld by position to find islands)
function trianglesOf(name) {
  const out = [];
  for (const gr of G.groups) if (matName(gr.materialIndex) === name) for (let t = gr.start / 3; t < (gr.start + gr.count) / 3; t++) out.push(t);
  return out;
}
function islands(tris) {
  const key = (i) => `${P.getX(i).toFixed(3)},${P.getY(i).toFixed(3)},${P.getZ(i).toFixed(3)}`;
  const parent = new Map();
  const find = (a) => { while (parent.get(a) !== a) { parent.set(a, parent.get(parent.get(a))); a = parent.get(a); } return a; };
  for (const t of tris) {
    const k = [0, 1, 2].map((j) => key(t * 3 + j));
    k.forEach((x) => { if (!parent.has(x)) parent.set(x, x); });
    parent.set(find(k[1]), find(k[0]));
    parent.set(find(k[2]), find(k[0]));
  }
  const m = new Map();
  for (const t of tris) { const r = find(key(t * 3)); if (!m.has(r)) m.set(r, []); m.get(r).push(t); }
  return [...m.values()].sort((a, b) => b.length - a.length);
}
const centroidY = (ts) => ts.reduce((s, t) => s + P.getY(t * 3), 0) / ts.length; // source is Z-up, face toward -Y

const head = islands(trianglesOf('f007_head'));
const opacity = islands(trianglesOf('f007_opacity'));
const parts = {
  skin: head[0],
  eyes: head.slice(1).flat(),
  lashes: opacity.filter((ts) => centroidY(ts) < 0).flat(),
  hair: opacity.filter((ts) => centroidY(ts) >= 0).flat(),
};

// Z-up centimetres -> Y-up, head centred roughly between the ears
const ORIGIN = new THREE.Vector3(0, 0.5, 158);
const toY = (v) => new THREE.Vector3(v.x - ORIGIN.x, v.z - ORIGIN.z, -(v.y - ORIGIN.y));
function build(tris) {
  const pos = [], nor = [], uv = [];
  for (const t of tris) for (let j = 0; j < 3; j++) {
    const i = t * 3 + j;
    const p = toY(new THREE.Vector3().fromBufferAttribute(P, i));
    const n = new THREE.Vector3().fromBufferAttribute(N, i);
    pos.push(p.x, p.y, p.z);
    nor.push(n.x, n.z, -n.y);
    uv.push(UV.getX(i), UV.getY(i));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return mergeVertices(g, 1e-4);
}

// Smooth normals that ignore UV seams: accumulate face normals per welded position.
function seamlessNormals(g) {
  const p = g.attributes.position, idx = g.index.array;
  const key = (i) => `${p.getX(i).toFixed(4)},${p.getY(i).toFixed(4)},${p.getZ(i).toFixed(4)}`;
  const acc = new Map(), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let t = 0; t < idx.length; t += 3) {
    a.fromBufferAttribute(p, idx[t]); b.fromBufferAttribute(p, idx[t + 1]); c.fromBufferAttribute(p, idx[t + 2]);
    const fn = new THREE.Vector3().subVectors(c, b).cross(new THREE.Vector3().subVectors(a, b)); // area weighted
    for (let j = 0; j < 3; j++) {
      const k = key(idx[t + j]);
      if (!acc.has(k)) acc.set(k, new THREE.Vector3());
      acc.get(k).add(fn);
    }
  }
  const n = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) { const v = acc.get(key(i)).normalize(); n.set([v.x, v.y, v.z], i * 3); }
  g.setAttribute('normal', new THREE.BufferAttribute(n, 3));
  return g;
}

function subdivide(g, iterations) {
  const s = LoopSubdivision.modify(g, iterations, { split: false, uvSmooth: false, preserveEdges: false });
  s.deleteAttribute('normal');
  return seamlessNormals(mergeVertices(s, 1e-4));
}

const skinLow = build(parts.skin);
const skinHi = subdivide(skinLow.clone(), 3);
const eyes = subdivide(build(parts.eyes), 2);
const lashes = build(parts.lashes);
const hair = build(parts.hair);

// ---- ambient occlusion, baked per vertex from cosine-weighted rays against everything but the hair cards
function bakeAO(g, occluders, rays = 64, maxDist = 6) {
  const merged = new THREE.BufferGeometry();
  const pos = [];
  for (const o of occluders) { const q = o.index ? o.toNonIndexed() : o; for (const v of q.attributes.position.array) pos.push(v); }
  merged.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const bvh = new MeshBVH(merged);
  const ray = new THREE.Ray(), p = g.attributes.position, n = g.attributes.normal;
  const ao = new Float32Array(p.count * 4);
  const nv = new THREE.Vector3(), t1 = new THREE.Vector3(), t2 = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    nv.fromBufferAttribute(n, i).normalize();
    t1.set(Math.abs(nv.x) < 0.9 ? 1 : 0, Math.abs(nv.x) < 0.9 ? 0 : 1, 0).cross(nv).normalize();
    t2.crossVectors(nv, t1);
    let open = 0;
    for (let r = 0; r < rays; r++) {
      // stratified cosine hemisphere
      const u = (r % 8 + Math.random()) / 8, v = (Math.floor(r / 8) + Math.random()) / (rays / 8);
      const rad = Math.sqrt(u), phi = 2 * Math.PI * v;
      const d = new THREE.Vector3().addScaledVector(t1, rad * Math.cos(phi)).addScaledVector(t2, rad * Math.sin(phi)).addScaledVector(nv, Math.sqrt(1 - u));
      ray.origin.fromBufferAttribute(p, i).addScaledVector(nv, 0.01);
      ray.direction.copy(d);
      const hit = bvh.raycastFirst(ray, THREE.DoubleSide);
      if (!hit || hit.distance > maxDist) open++;
    }
    const a = open / rays;
    ao.set([a, a, a, 1], i * 4);
  }
  g.setAttribute('color', new THREE.BufferAttribute(ao, 4));
}
// each skin is occluded by itself (the facets of the low mesh sit inside the smooth one in places)
bakeAO(skinHi, [skinHi, eyes]);
bakeAO(skinLow, [skinLow, eyes]);
bakeAO(eyes, [skinHi, eyes]);

// ---- write glTF
const doc = new Document();
const buffer = doc.createBuffer();
const scene = doc.createScene('head');
function addMesh(name, g) {
  const prim = doc.createPrimitive();
  const attr = (a, type) => doc.createAccessor().setType(type).setArray(new Float32Array(a.array)).setBuffer(buffer);
  prim.setAttribute('POSITION', attr(g.attributes.position, 'VEC3'));
  prim.setAttribute('NORMAL', attr(g.attributes.normal, 'VEC3'));
  prim.setAttribute('TEXCOORD_0', attr(g.attributes.uv, 'VEC2'));
  if (g.attributes.color) prim.setAttribute('COLOR_0', attr(g.attributes.color, 'VEC4'));
  const I = g.index.array, big = g.attributes.position.count > 65535;
  prim.setIndices(doc.createAccessor().setType('SCALAR').setArray(big ? new Uint32Array(I) : new Uint16Array(I)).setBuffer(buffer));
  prim.setMaterial(doc.createMaterial(name));
  scene.addChild(doc.createNode(name).setMesh(doc.createMesh(name).addPrimitive(prim)));
  console.log(name.padEnd(8), 'verts', g.attributes.position.count, 'tris', I.length / 3);
}
addMesh('skinLow', skinLow);
addMesh('skinHi', skinHi);
addMesh('eyes', eyes);
addMesh('lashes', lashes);
addMesh('hair', hair);

await MeshoptEncoder.ready;
doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
await doc.transform(reorder({ encoder: MeshoptEncoder }), quantize({ quantizePosition: 16, quantizeNormal: 10, quantizeTexcoord: 14, quantizeColor: 8 }));
await new NodeIO().registerExtensions([EXTMeshoptCompression, KHRMeshQuantization]).registerDependencies({ 'meshopt.encoder': MeshoptEncoder }).write(outPath, doc);
console.log('wrote', outPath, (fs.statSync(outPath).size / 1e6).toFixed(2), 'MB');
