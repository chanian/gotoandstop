# Skin Study

Three ways to light a face, side by side. You move one light around her head and compare how each
technique handles it, especially with the light behind her ear.

**Live:** https://chanian.github.io/gotoandstop/skin-study/

## The three modes

1. **Flat polygons.** The original 3,018-triangle mesh with one normal per face and a clay albedo. It shows
   what the geometry alone gives you.
2. **Texture + bump.** The same low-poly mesh with the photo colour map, a tangent-space normal map, a
   specular map and procedural pore bumps (cellular noise, applied through screen-space derivatives). Light
   stops at the surface, so terminators are hard and shadows go grey instead of red. The silhouette is still
   faceted.
3. **Subsurface.** The skin is Loop-subdivided three times (193k triangles). Light enters the skin and
   diffuses before it comes back out, and the diffusion profile has measured coefficients per colour channel.

**Compare** (or **C**) splits the screen. Drag the handle to wipe between two modes. **1 / 2 / 3** switch
modes.

## How the scattering works

This is the point-based method from Jensen & Buhler, *A Rapid Hierarchical Rendering Technique for
Translucent Materials* (2002), run on the GPU. All of it is in `src/sss.js`.

1. **Photons (irradiance points).** The skin is split into about K patches of equal size: a spatial grid,
   further split by which way the surface faces, so the two sides of an ear stay separate. Each patch keeps
   its total area and a representative vertex. **Photons → Count** sets K, from 1k up to every vertex (98k),
   and **Show photons** draws them as dots coloured by the light they received.
2. **Irradiance pass.** A fragment shader lights every point: the key light's N·L times a soft shadow, plus a
   hemisphere ambient times baked AO. With pre-scatter texturing it's also multiplied by the albedo. The
   result goes into a float texture.
3. **Gather pass.** Every vertex of the subdivided skin sums the points within the **gather radius**, each
   weighted by the diffusion profile R(r) and the point's area. The points sit in a uniform grid with cells
   half the radius wide, so a vertex only walks the cells that can reach it. The result is a normalised
   average, so uneven point density can't bias it.
4. **Final shading.** The scattered light is interpolated from the vertices, and a little unscattered
   per-pixel light (**Surface detail**) keeps the normal-map detail. Then comes the albedo (post-scatter, or
   split √ / √ between pre and post), then dual-lobe GGX specular with skin's 2.8% Fresnel.

Scattering doesn't depend on where you look from, so the passes only rerun when the light or a parameter
changes. On an M3, 24k photons with a 1.2 cm radius takes about 13 ms. The status pill shows the GPU time
wherever timer queries are available.

The irradiance at each point is computed directly from the light, with a shadow-map lookup. There's no
separate photon-tracing pass. The "photons" are the irradiance samples Jensen & Buhler integrate over.

### Profiles

The defaults are the Sum of Gaussians profile with post-scatter texturing, which looks the most realistic. The
narrow Gaussian keeps the normal-map detail, and the photo colour stays sharp instead of being blurred by the
gather. The dipole and pre-scatter options are there for comparison.

- **Dipole** (Jensen, Marschner, Levoy & Hanrahan 2001). It takes an absorption coefficient σa, a reduced
  scattering coefficient σs′ (per RGB, in 1/mm) and an index of refraction η. **Measured σ** loads the paper's
  table: two skins, marble, whole milk, ketchup and apple. **Albedo → From σ** drops the photo texture and
  takes the colour from the dipole's analytic total reflectance, so marble really turns white.
- **Sum of Gaussians** (d'Eon & Luebke 2007, *GPU Gems 3* ch. 14). This is the six-Gaussian fit to a
  three-layer skin model. The narrowest Gaussian is evaluated per pixel, and the other five are gathered.
- **Scatter distance ×** scales the profile, as if the skin were more or less translucent.
- The plot in the panel shows r·R(r) per channel out to the gather radius. Red travels furthest, which is why
  shadow edges on skin turn red.

### Extras

- **Translucent shadow map.** Adds light that went through thin parts (ears, nostrils), using the distance
  light travelled inside the head according to the shadow map, attenuated by exp(−σtr·d). This is the trick
  from NVIDIA's human-head demo. It's off by default, since the 3D gather already carries light a centimetre
  or so through the ear.
- **Technique → Wrap lighting.** The cheap fake for comparison: N·L wrapped past the terminator, further for
  red, and a reddened shadow penumbra. There's no gather at all.
- **View → Buffer.** Shows the scattered light, irradiance, albedo or specular on its own.

## URL parameters

- `?mode=1|2|3` picks the mode, and `?compare` opens the split view.
- `?light=x,y` places the light on the pad (from −1 to 1; the centre is in front of her, the rim is behind
  her).
- `?cam=x,y,z` places the camera, and `?clean` hides the UI (for screenshots).
- `?o.<option>=<value>` sets any control, e.g. `?o.samples=3000&o.showPoints=true` or `?o.material=Marble`.

## The head

The head is [Microsoft Rocketbox](https://github.com/microsoft/Microsoft-Rocketbox) `Female_Adult_07`, MIT
licensed (see `assets/LICENSE-Rocketbox.txt`). It's a game avatar built from photo-sourced textures, not a
light-stage scan. The freely licensed light-stage scans (Digital Emily 2, Ten24's free head) can't be
redistributed, and the CC-BY scans on Sketchfab need a login to download.

`tools/build-assets.mjs` turns the FBX into `assets/head.glb`. It splits skin, eyes, lashes and hair cards,
turns the model Y-up in centimetres, subdivides the skin for mode 3, bakes per-vertex AO for each mesh against
itself, and compresses the result with meshopt. The textures are the avatar's 2K head colour, normal and
specular maps, plus the hair/lash opacity atlas.
