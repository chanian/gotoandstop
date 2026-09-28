# Light Study

A desert villa living room (after a photo of a house in the Agafay desert outside Marrakech), path traced
in the browser. Turn the dials to move the sun; let go and the view refines to a photoreal render.

**Live:** https://chanian.github.io/gotoandstop/light-study/

## Interact

- **Time dial**: drag the sun around the 24-hour ring (noon at the top, midnight at the bottom, sunrise on the left).
- **Presets**: Night, Golden AM, Day and Golden PM glide there. **Time-lapse** plays a day in about 70 seconds.
- **Compass dial**: turns the direction the glass wall faces. The dot on the ring is the sun's bearing.
- **Drag** to look around a little.
- **Render** (top right): toggle path tracing, sample count, path-trace resolution, light bounces, denoise and exposure.
- The dial panel starts collapsed to a small pill (time · phase · bearing). Click it or press **H** to open it.
- Once the room has built, it starts path tracing on the **Draft** preset. **Render → Path tracing** switches to
  Balanced or Final (slower, higher fidelity), or turns Photoreal off for the live preview.
- URL parameters: `?t=18.2&face=205` sets the time and bearing, `?preview` starts with path tracing off, `?ptscale=0.5` sets path-trace resolution.

## How it works

- **Two renderers.** While anything moves you see a fast raster preview (shadow maps, GTAO, bloom). Once it
  settles, [three-gpu-pathtracer](https://github.com/gkjohnson/three-gpu-pathtracer) takes over and accumulates
  samples: real bounce light, soft shadows, glossy reflections on the polished concrete, sheen on the linen and wool.
  A smart denoiser softens early samples and relaxes as the image converges. The status pill shows progress.
- **Sun and sky** (`sky.js`): solar geometry for 31°N in late spring. The sky is generated on the CPU as an
  equirectangular HDR texture, so the path tracer can importance-sample it: one version without the sun disc for
  lighting (the directional light is the sun), one with the disc, stars and moon for what you see through the glass.
- **Photographic tone.** A logarithmic highlight knee runs before Khronos Neutral tone mapping. It works like the exposure
  blending architectural photographers use, so the dim interior and the bright desert both hold detail. A soft
  "photographer's fill" behind the camera lifts the foreground, as it would on a real shoot.
- **The room** (`room.js`): the framing was measured from the photo (camera height, glass wall proportions, where
  every object sits), and it uses a level camera with lens shift so verticals stay straight. The furniture is
  procedural: puffy linen cushions, pinched kilim pillows, a displaced Beni Ourain shag with fringe, extruded
  pebble tables on steel legs, and a displaced teak root stool.
- **Outside**: a terrace with an infinity pool, a daybed, carved stools, a dry-stone wall and an olive. Beyond that, a
  procedural desert with soil patches, scrub and a dirt track, and the Atlas as a distant ring of ridges. Aerial
  haze is baked into vertex colours, plus a faint emission on the mountains, so the distance reads even when path traced.
- **Materials** (`textures.js`): all procedural canvas textures, with no downloads: polished and weathered concrete,
  tadelakt plaster, linen weave normals, the rug's hand-drawn lattice, kilim, walnut, bleached teak and desert grit.

Notes for the path tracer: instanced meshes are baked into plain meshes, vertex colours are RGBA, and meshes get safe
tangents up front. Otherwise they'd go missing or render black.
