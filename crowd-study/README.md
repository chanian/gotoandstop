# Crowd Study

One orange crash-test dummy in a crowd of grey ones. You click to walk it through them. People who see you
coming step aside. People who don't get shoved, and if you're running, some of them go down.

**Live:** https://chanian.github.io/gotoandstop/crowd-study/

## Controls

- **Click** to walk to a point and **drag** to steer, or walk with the **arrow keys** (up is away from the
  camera). Hold **Shift** (or toggle **Run**) to run.
- **+ / −** add or remove ten people.
- **Right-drag** orbits the camera, the **wheel** zooms, and **Q / E** turn it 45°.
- **S** switches to quarter-speed slow motion. **D** shows the collision discs: blue means making way, red
  means being shoved, black means on the floor. **C** collapses the controls drawer, and **H** hides the UI.
- `?preset=Concert` (or Plaza, Commute, Skittles) starts on a preset, and `?clean` hides the UI.

## How it works

There are three layers, and each one feeds the next.

1. **Discs** (`src/sim.js`). Each character is a 0.27 m disc with a mass and a velocity. Steering only sets
   a *desired* velocity, and each character can accelerate toward it at a limited rate (its grip). Contacts
   are solved on a spatial hash: overlaps are projected apart by inverse mass, then a restitution impulse
   with a little shoulder-to-shoulder friction is applied. A shove passes from person to person as a chain
   of these impulses. **Your mass** sets how hard you are to stop.
2. **Steering.** Every NPC keeps a soft **personal space** from its neighbours and from bodies on the floor,
   and drifts back inside the crowd's circle (drawn faintly on the floor). Making way is a look-ahead along
   your path, split into two dials. **Notice you** is whether they register you at all. An NPC reacts if
   they're in your lane and either facing you or close enough to feel you, after their own reaction time.
   **Get out of the way** is how hard they try once they have. At 0 they barely shuffle, at 50% they sidestep
   politely, and at 100% they hop well clear, quickly and leaving a wider lane. **Milling about** sends a
   fraction of the crowd walking between random points.
3. **Bodies** (`src/body.js`). The figure is posed procedurally, and its feet move in one of two ways.
   - **Walking and running** run on a gait clock. Cadence and duty factor (the fraction of a stride each foot
     spends on the ground) follow human gait data. At 1.5 m/s that's about 1.95 steps a second with 0.77 m
     steps. At 4.2 m/s it's about 2.9 steps a second with 1.45 m steps, ~0.2 s of ground contact and two
     flight phases per stride. Each swing foot lands beside where the hip will be half a stance later. The
     foot is a rigid lever that never slides on the floor. A walk lands on the heel with the toe up, rocks
     flat, then peels the heel up and pivots on the ball while the toes stay flat, until toe-off. A run lands
     midfoot. Lift-off and touchdown are events,
     so slowing from a run to a walk never plants a foot in mid-air. If braking hard leaves a foot out of
     reach, it takes a catch step early.
   - **Standing, turning and stumbling** step on demand: a foot stays planted until the body leaves it
     behind, then steps to where the body is heading.

   The legs are two-bone IK, and the hips drop until both feet can be reached, which gives the walk its bob.
   Walking, the pelvis also shifts over the stance foot and drops on the swing side, and the hips and
   shoulders counter-rotate only about 5°. These amounts come from clinical gait data, since exaggerating
   them turns a walk into a strut.

   **Turning** is limited the way a body is. The hips have their own facing, which can't turn more than about
   35° past a planted foot, so the feet step round first. Each turning step opens a foot at most ~60° from
   the other, so turning right round takes three or four steps. The spine adds up to ~25° on top of the hips
   and the neck up to ~65° on top of that, so the head and shoulders lead the turn. On a curve, feet land
   along the curve rather than off its tangent.
   A runner's knee also gives at mid-stance. Arms are springs that swing against the legs, get thrown around
   by acceleration, flail when you're knocked, and come up to push when the player is pressing into someone.

**Balance and falling.** The upper body is a damped spring pendulum. The velocity a contact forces on you in
one step tips it in the direction of the push. Feet absorb steady pressure up to about 7 m/s², so a dense
crowd leaning on itself only makes people lean visibly. A sudden impact goes straight into the tilt. If the
tilt passes a threshold set by **Fragility**, the character becomes a Verlet ragdoll: 18 particles on the
joints, a braced rigid torso, stick limbs with minimum distances so knees and elbows can't fold flat, and
friction against the floor. Ragdolls pile on each other, and standing characters shove limbs out of their way.
Once a body has been still for a second or so, it blends into a crouch and stands back up, facing the way
its head was pointing.

## Rendering

three.js, white box. Every body part is one `InstancedMesh` (capsules, spheres and rounded boxes), so the
whole crowd draws in a dozen calls and each part's matrix is built directly from two joints. There's a
4096² PCF sun shadow that follows the camera, GTAO for contact darkening, and an endless floor with a
faint metre grid.
