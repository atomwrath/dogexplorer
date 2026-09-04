/* The noise ring: how far away wildlife can hear you, drawn on the ground around you.

   Sneaking already worked -- critters.js scales each animal's spook radius by a noise
   factor (barking 2.4x, sneaking 0.34x, walking 0.55x rising to ~1.7x at a sprint) -- but
   none of that was visible. You pressed sneak, something felt different, and the only
   feedback was whether an animal bolted, which arrives exactly too late to act on. The
   button was a guess with a delayed, binary answer.

   Drawing the radius turns it into a decision you can make in advance: you can SEE the
   ring pull in when you crouch and swell when you break into a run, and you can see
   whether the deer ahead is inside it before you take another step.

   It is deliberately the PLAYER's ring, not a particular animal's. Each species has its
   own spook radius and drawing all of them would be a mess of overlapping circles; what
   the player controls is the multiplier, so the ring shows that multiplier against a
   representative radius. The number on the ground is honest for a typical animal and the
   right shape for every one of them.

   Drawn as a painted BAND -- a thin annulus of triangles, both edges sampled onto the
   terrain -- and not as a line loop, which is what the first version did and why it read
   as broken or absent. Two things were wrong with the line. WebGL ignores `linewidth`, so
   a LineBasicMaterial is always exactly one pixel no matter what you ask for: at a 27 m
   radius that is a hairline drawn over busy toon-shaded terrain. And with only 64 samples
   the segments were 2.7 m long, long enough to tunnel straight through the terrace risers
   they spanned -- measured on the default map, 17% of the loop was underground at any
   moment. A one-pixel line that is also 17% missing is not an indicator.

   A band fixes both: it has real width in metres so it scales with the view, and because
   every vertex on BOTH edges is placed on the terrain it drapes over risers instead of
   cutting through them. Rebuilt every frame -- a few hundred vertices is nothing, and it
   means the ring needs no invalidation logic when the ground under it changes. */
import { clamp, lerp } from '../core/math.js';
import { scene } from '../core/render.js';

const SEGS = 192;           // ~0.9 m of arc at a 27 m radius; short enough to drape
const LIFT = 0.13;          // clears the trail ribbon stack, same reasoning as shadow.js

let ring = null, geom = null, mat = null;
let shownR = 0;             // eased radius, so state changes glide rather than snap
let catchRing = null, catchGeom = null, catchMat = null;

/* Colour by how loud you are, because that is the thing being communicated. Green when
   you are quiet enough to approach, amber at a walk, red when you are broadcasting. */
const QUIET = 0x4f9d4f, WALK = 0xd8922e, LOUD = 0xc4442e;
/* The catch ring has exactly one colour now that it only exists while armed -- see
   updateCatchRing. Kept as a named constant rather than inlined so the build-time default
   passed to makeBand and the colour set every frame can't drift apart. */
const REACH_ARMED = 0x7bc47f;

/* One band, built once. Extracted the moment there were two of these: the noise ring and
   the catch ring differ in colour, radius and what they mean, and in nothing at all about
   how a draped annulus is constructed. Two copies of this would drift, and the drift would
   be invisible -- both rings would still draw, just no longer comparably, which is fatal
   for a mechanic whose entire readout is one circle sitting inside the other. */
function makeBand(name, color, opacity, order){
  const g = new THREE.BufferGeometry();
  // two vertices per angular step: inner edge, outer edge
  g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(SEGS*2*3), 3));
  const idx = [];
  for(let i=0;i<SEGS;i++){
    const a = i*2, b = a+1, c = ((i+1)%SEGS)*2, d = c+1;
    idx.push(a, b, d, a, d, c);
  }
  g.setIndex(idx);
  const m = new THREE.MeshBasicMaterial({
    color, transparent:true, opacity,
    depthWrite:false, side:THREE.DoubleSide,
    // same reasoning as shadow.js: a surface lying on the ground needs a firm depth
    // bias or it strobes against the ground it is lying on
    polygonOffset:true, polygonOffsetFactor:-8, polygonOffsetUnits:-8,
  });
  const mesh = new THREE.Mesh(g, m);
  mesh.frustumCulled = false;
  mesh.renderOrder = order;
  mesh.name = name;
  scene.add(mesh);
  return {mesh, geom:g, mat:m};
}

/* Write one circle's worth of draped vertices. Both edges are sampled onto the terrain
   (see the module header on why a line loop was not enough), and `lift` differs per ring
   so the two never z-fight where they cross -- which they do constantly, since the whole
   point is watching one pass through the other. */
function drapeBand(g, px, pz, radius, half, groundAt, lift){
  const arr = g.attributes.position.array;
  for(let i=0;i<SEGS;i++){
    const a = i/SEGS*Math.PI*2, ca = Math.cos(a), sa = Math.sin(a);
    for(let e=0;e<2;e++){
      const rr = radius + (e ? half : -half);
      const x = px + ca*rr, z = pz + sa*rr;
      const o = (i*2+e)*3;
      arr[o]   = x;
      arr[o+1] = groundAt(x, z) + lift;
      arr[o+2] = z;
    }
  }
  g.attributes.position.needsUpdate = true;
  if(g.computeBoundingSphere) g.computeBoundingSphere();
}

function ensureRing(){
  if(ring) return ring;
  try{
    const built = makeBand('noiseRing', WALK, 0.55, 3);
    ring = built.mesh; geom = built.geom; mat = built.mat;
  }catch(err){
    ring = null;
  }
  return ring;
}

function ensureCatchRing(){
  if(catchRing) return catchRing;
  try{
    const built = makeBand('catchRing', REACH_ARMED, 0.8, 4);
    catchRing = built.mesh; catchGeom = built.geom; catchMat = built.mat;
  }catch(err){
    catchRing = null;
  }
  return catchRing;
}

/* noise:  critters.js's own multiplier for the current state (see updateCritters)
   baseR:  a representative spook radius for this map's wildlife
   groundAt: standingY, passed in so this module needs no world.js import */
function updateNoiseRing(dt, px, pz, noise, baseR, groundAt, visible){
  const r = ensureRing();
  if(!r) return;
  r.visible = !!visible;
  if(!visible) return;

  const target = clamp(baseR*noise, 1.5, 400);
  // ease, but converge fast enough that crouching feels like a response, not a delay
  shownR = shownR > 0 ? lerp(shownR, target, 1-Math.pow(0.004, dt)) : target;

  // band width grows with the circle so it stays readable at any radius, with a floor so
  // a tight sneaking ring does not thin away to nothing
  const half = clamp(shownR*0.045, 0.30, 1.6)*0.5;
  drapeBand(geom, px, pz, shownR, half, groundAt, LIFT);

  // colour tracks the multiplier, not the absolute radius, so it means the same thing
  // on a map full of jumpy deer as on one full of bold bears
  mat.color.setHex(noise <= 0.4 ? QUIET : (noise >= 1.2 ? LOUD : WALK));
  mat.opacity = noise <= 0.4 ? 0.7 : 0.5;
}

/* The catch ring: how far you can reach, drawn the same way the noise ring is so the two
   can be read against each other at a glance.

   CENTRED ON THE ANIMAL, NOT THE PLAYER, and shown only when there is one worth showing.

   Two rounds of getting this wrong are worth recording, because they were the same
   mistake at different sizes. First it was drawn continuously around the pup at a fixed
   radius -- next to the noise ring, which visibly breathes as you move and sneak, a circle
   that never changed read as a leftover rather than information ("a static blue ring that
   seems unnecessary"). Gating it on having a target fixed the clutter but kept it stapled
   to the player, which still asked the player to judge whether a moving animal had entered
   a ring attached to themselves.

   Drawing it around the animal inverts that into the question actually being asked: get
   inside this and it is yours. The centre is passed in, so this module stays ignorant of
   whose ring it is -- main.js decides, from critters.js's own search, which is what keeps
   the ring and the rule that governs catching from ever drifting apart.

   `armed` means the player is inside it right now. It gates colour rather than visibility
   here (visibility is the caller's `visible`, which is "is there a target at all"), so the
   ring fades in while you approach and brightens at the moment the jump would work. */
function updateCatchRing(dt, px, pz, radius, groundAt, visible, armed){
  const r = ensureCatchRing();
  if(!r) return;
  r.visible = !!visible;
  if(!visible) return;
  const rad = clamp(radius, 0.5, 60);
  // a hair thinner than the noise band, so where they overlap it is still obvious which
  // is which, and lifted clear of it so the crossing does not strobe
  drapeBand(catchGeom, px, pz, rad, 0.16, groundAt, LIFT + 0.05);
  catchMat.color.setHex(REACH_ARMED);
  // dim while you are still closing in, solid once you could actually grab it
  catchMat.opacity = armed ? 0.85 : 0.32;
}

function setNoiseRingVisible(v){ const r = ensureRing(); if(r) r.visible = !!v; }
function setCatchRingVisible(v){ const r = ensureCatchRing(); if(r) r.visible = !!v; }
function getNoiseRing(){ return ring; }
function getCatchRing(){ return catchRing; }
function noiseRingRadius(){ return shownR; }

export { updateNoiseRing, setNoiseRingVisible, getNoiseRing, noiseRingRadius,
         updateCatchRing, setCatchRingVisible, getCatchRing };
