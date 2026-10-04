// Diffusion profiles: how much light comes back out of the skin at distance r from where it went in.
// Coefficients are in mm^-1 (Jensen, Marschner, Levoy & Hanrahan 2001, table 2).

export const MATERIALS = {
  'Skin 1': { sigmaA: [0.032, 0.17, 0.48], sigmaS: [0.74, 0.88, 1.01], eta: 1.3 },
  'Skin 2': { sigmaA: [0.013, 0.070, 0.145], sigmaS: [1.09, 1.59, 1.79], eta: 1.3 },
  Marble: { sigmaA: [0.0021, 0.0041, 0.0071], sigmaS: [2.19, 2.62, 3.00], eta: 1.5 },
  'Whole milk': { sigmaA: [0.0011, 0.0024, 0.014], sigmaS: [2.55, 3.21, 3.77], eta: 1.3 },
  Ketchup: { sigmaA: [0.061, 0.97, 1.45], sigmaS: [0.18, 0.07, 0.03], eta: 1.3 },
  Apple: { sigmaA: [0.0030, 0.0034, 0.046], sigmaS: [2.29, 2.39, 1.97], eta: 1.3 },
};

// d'Eon & Luebke 2007 (GPU Gems 3, ch. 14): a three-layer skin profile fitted with six Gaussians.
// Variances in mm^2, weights per RGB channel. The first one is so narrow it's evaluated per pixel.
export const SKIN_GAUSSIANS = [
  { v: 0.0064, w: [0.233, 0.455, 0.649] },
  { v: 0.0484, w: [0.100, 0.336, 0.344] },
  { v: 0.187, w: [0.118, 0.198, 0.0] },
  { v: 0.567, w: [0.113, 0.007, 0.007] },
  { v: 1.99, w: [0.358, 0.004, 0.0] },
  { v: 7.41, w: [0.078, 0.0, 0.0] },
];

// diffuse Fresnel reflectance (Egan & Hilgeman fit)
const fdr = (eta) => -1.440 / (eta * eta) + 0.710 / eta + 0.668 + 0.0636 * eta;

// The dipole's constants for one channel; the shader gets the same numbers as uniforms.
export function dipoleConstants(sa, ss, eta) {
  const st = sa + ss;
  const alpha = ss / st;
  const str = Math.sqrt(3 * sa * st);
  const F = fdr(eta);
  const A = (1 + F) / (1 - F);
  const zr = 1 / st;
  const zv = zr * (1 + (4 / 3) * A);
  // total diffuse reflectance: the dipole integrated over the plane
  const s = Math.sqrt(3 * (1 - alpha));
  const total = (alpha / 2) * (1 + Math.exp((-4 / 3) * A * s)) * Math.exp(-s);
  return { alpha, str, zr, zv, total };
}

export function dipole(c, r) {
  const dr = Math.sqrt(r * r + c.zr * c.zr), dv = Math.sqrt(r * r + c.zv * c.zv);
  return (c.alpha / (4 * Math.PI)) * (
    (c.zr * (c.str * dr + 1) * Math.exp(-c.str * dr)) / (dr * dr * dr) +
    (c.zv * (c.str * dv + 1) * Math.exp(-c.str * dv)) / (dv * dv * dv));
}

export function gaussians(r, ch, scale = 1, skipFirst = false) {
  let s = 0;
  SKIN_GAUSSIANS.forEach((g, i) => {
    if (skipFirst && i === 0) return;
    const v = g.v * scale * scale;
    s += (g.w[ch] / (2 * Math.PI * v)) * Math.exp((-r * r) / (2 * v));
  });
  return s;
}
