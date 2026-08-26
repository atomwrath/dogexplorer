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

/* Colour by how loud you are, because that is the thing being communicated. Green when
   you are quiet enough to approach, amber at a walk, red when you are broadcasting. */
const QUIET = 0x4f9d4f, WALK = 0xd8922e, LOUD = 0xc4442e;

function ensureRing(){
  if(ring) return ring;
  try{
    geom = new THREE.BufferGeometry();
    // two vertices per angular step: inner edge, outer edge
    geom.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(SEGS*2*3), 3));
    const idx = [];
    for(let i=0;i<SEGS;i++){
      const a = i*2, b = a+1, c = ((i+1)%SEGS)*2, d = c+1;
      idx.push(a, b, d, a, d, c);
    }
    geom.setIndex(idx);
    mat = new THREE.MeshBasicMaterial({
      color: WALK, transparent:true, opacity:0.55,
      depthWrite:false, side:THREE.DoubleSide,
      // same reasoning as shadow.js: a surface lying on the ground needs a firm depth
      // bias or it strobes against the ground it is lying on
      polygonOffset:true, polygonOffsetFactor:-8, polygonOffsetUnits:-8,
    });
    ring = new THREE.Mesh(geom, mat);
    ring.frustumCulled = false;
    ring.renderOrder = 3;
    ring.name = 'noiseRing';
    scene.add(ring);
  }catch(err){
    ring = null;
  }
  return ring;
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
  const arr = geom.attributes.position.array;
  for(let i=0;i<SEGS;i++){
    const a = i/SEGS*Math.PI*2, ca = Math.cos(a), sa = Math.sin(a);
    for(let e=0;e<2;e++){
      const rr = shownR + (e ? half : -half);
      const x = px + ca*rr, z = pz + sa*rr;
      const o = (i*2+e)*3;
      arr[o]   = x;
      arr[o+1] = groundAt(x, z) + LIFT;
      arr[o+2] = z;
    }
  }
  geom.attributes.position.needsUpdate = true;
  if(geom.computeBoundingSphere) geom.computeBoundingSphere();

  // colour tracks the multiplier, not the absolute radius, so it means the same thing
  // on a map full of jumpy deer as on one full of bold bears
  mat.color.setHex(noise <= 0.4 ? QUIET : (noise >= 1.2 ? LOUD : WALK));
  mat.opacity = noise <= 0.4 ? 0.7 : 0.5;
}

function setNoiseRingVisible(v){ const r = ensureRing(); if(r) r.visible = !!v; }
function getNoiseRing(){ return ring; }
function noiseRingRadius(){ return shownR; }

export { updateNoiseRing, setNoiseRingVisible, getNoiseRing, noiseRingRadius };
