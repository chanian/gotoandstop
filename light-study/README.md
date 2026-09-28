# Light Study

A warm, modern living room lit by the sun in real time: a study of how daylight moves through a room.

**Live:** https://chanian.github.io/gotoandstop/light-study/

## Interact

- **Time dial**: drag the sun around the 24-hour ring (noon at the top, midnight at the bottom, sunrise on the left).
- **Presets**: Night, Golden AM, Day and Golden PM glide around the clock to that moment. **Time-lapse** plays a day in about 70 seconds.
- **Compass dial**: turns the direction the window faces. The dot on the ring is the sun's bearing, so you can see when it lines up with the window.
- **Drag the room** to look around. **Extras** (top right) has breeze strength, beam haze, dust, AO, bloom and quality options.
- URL parameters: `?t=18.3&face=330` sets the time (hours) and window bearing (degrees).

## How it works

- **Sun** (`sky.js`): real solar geometry for 40°N in late spring (hour angle, declination), so golden hour, midday
  height and sunrise bearing all behave properly. The window's compass bearing rotates the sun around the room. After
  dusk the same directional light hands over to a bluish moon. Sky colour, sun colour and intensity, lamps and exposure
  are all keyed off the sun's elevation.
- **Light in the room**: one shadow-casting directional light, which only enters through the window opening. On top of
  that: a rect-area light at the window for skylight, a hemisphere fill, and a warm "bounce" light placed wherever the beam
  lands on the floor (cheap indirect light). GTAO adds contact shadows.
- **Sheer curtains** (`room.js`): translucent fabric that glows when backlit. In the shadow pass they use a dithered depth
  material, with random holes in about 40% of the fabric. Soft shadow filtering averages that into a diffused, dimmer
  patch of sun behind the curtain. Folds and breeze are rebuilt on the CPU each frame, so the colour and shadow passes agree.
- **Foliage**: branches of instanced leaves outside the window, swaying with slow gusts. Their real shadows are the moving
  dapple on the walls and floor.
- **Beams and dust** (`effects.js`): the window is extruded along the light into a prism. Its front faces ray-march the view
  ray through each pane's beam (clipped to the room), with a forward-scattering phase. Dust motes project back along
  the light to the window and only glow when they're in a pane's beam, dimmed behind the sheers.
- **Night**: a tripod floor lamp (shadowed spot + glow), a table lamp and a flickering candle fade in through dusk.
- **Materials**: all procedural canvas textures, with no image downloads: oak planks, limewash plaster, a wool rug,
  travertine, bouclé, and three generated modern art pieces.

Units are metres. The window is in the `-x` wall.
