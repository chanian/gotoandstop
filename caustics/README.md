# Whiskey Caustics

A WebGL recreation of the whiskey-glass shot from *Final Fantasy: The Spirits Within*: a dark study,
a walnut desk under one warm light, and a tumbler of whiskey throwing caustics onto the wood.

**Live:** https://chanian.github.io/gotoandstop/caustics/

## Run locally

ES modules have to be served over http:

```sh
cd caustics
python3 -m http.server 8000   # or: npx serve
```

Then open http://localhost:8000.

## Interact

- **Hover**: your (invisible) hand casts a soft shadow on the desk.
- **Click and drag the glass** to pick it up. Move it around, or shake it to slosh and swirl the whiskey.
- **Release** to set it down. The impact sends a ring through the liquid.
- **Ice**: the Ice folder in settings sets the number of cubes (0–6), their size, how melted (rounded) they
  look, and how cloudy they are. **Drop fresh ice** drops them in again from the rim.
- `?auto` runs a scripted pick-up and shake. `?top` switches to a top-down camera for inspecting the caustics.

## Settings and performance

The settings panel (top right, **G** hides it along with the stats) has quality presets
(Low / Medium / High / Ultra) and individual controls. Changes are saved in the browser.

| Control | What it costs |
| --- | --- |
| Pixel ratio | Pixel count for every full-screen pass. Usually the biggest lever on Retina/4K. |
| Wood noise octaves | Desk shader cost per pixel (it's evaluated on the desk and again through the glass). |
| Glass ray bounces | Ray-trace loop length for the glass and the caustic rays. |
| Hand shadow | 13 capsule tests per desk pixel. |
| Caustics: enabled / ray grid / map resolution / smooth | The caustic pass. The ray grid is N² rays traced per frame. |
| Bloom (+ strength, radius, threshold), grain | Post-processing passes. |
| Ripple grid | CPU wave simulation (N² cells, 240 Hz). |
| Auto shake | Keeps the glass moving so you can measure under load. |
| Ice cubes | Each cube is one more box test per ray bounce. Three cubes add about 1 ms to the caustic pass. |

The **Look** folder has exposure, light intensity and direction, and whiskey level.

The stats readout (top left) shows fps, CPU time per frame, and GPU time for the caustic pass and the
scene + post (via `EXT_disjoint_timer_query_webgl2`, where the browser supports it). The frame rate caps
at your display's refresh rate, so **compare GPU ms** to judge headroom: under ~16 ms fits 60 Hz, under
~8 ms fits 120 Hz. Expect a brief hitch when changing bounces, octaves or smoothing, since those recompile shaders.

## How it works

- **Glass and whiskey** are ray-traced analytically in a fragment shader on a cylinder proxy mesh
  (`GLASS_FS`). The model is a thick-walled tumbler with a solid base, with Fresnel reflections, total
  internal reflection, and Beer–Lambert amber absorption in the whiskey. Refracted rays shade the
  desk directly, so you see the desk, its caustics and the hand shadow through the glass.
- **Caustics** (`CAUSTIC_VS/FS`): a 512² grid of parallel light rays around the glass is traced through
  the same glass/whiskey model and splatted into a table-space map. Brightness is the ratio of each
  grid cell's area before and after refraction (screen-space derivatives). A second, untraced copy of
  the grid writes coverage into alpha, so the desk swaps its direct light for the traced light:
  `light = caustic.rgb + (1 - caustic.a)`.
- **Liquid** (`liquid.js`): a sloshing plane, i.e. a damped spring for the first slosh mode (~3 Hz)
  driven by the glass's acceleration, plus a 96² wave-equation height field for ripples. Waves are
  excited at the wall by jerk, by splashes when you shake it, and by the landing impact.
- **Ice** (`ice.js`): rigid cubes simulated in the glass's frame. They feel gravity minus the glass's
  acceleration, buoyancy from how far they're submerged (they float about 96% under in whiskey), drag
  toward the sloshing flow, and a torque that settles a face flat on the surface. They collide with the
  wall, base, rim and each other, and push ripples into the liquid as they bob and drift. The liquid level
  rises by the volume they displace. In the tracers, ice is a fourth medium (IOR 1.31) with an exact box
  intersection and a rounded-box normal for the "melted" look. Cloudiness adds scattering inside the ice.
  Rays only test the surfaces reachable from the medium they're in, which keeps the ice cheap.
- **Hand shadow** (`hand.js`): 13 capsules posed as a right hand, either hovering or wrapped around
  the glass. They're never drawn. The desk shader computes an analytic soft shadow against them.
- **Desk**: procedural walnut (warped growth rings, pores, figure), GGX specular plus a satin clearcoat,
  and a dark inlay strip along the front edge.
- **Post**: bloom, ACES tone mapping, vignette and film grain.

Units are centimetres; the desk top is `y = 0`.
