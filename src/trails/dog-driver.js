/* Drives the SHARED dog (src/dog/runtime.js) for trail movement, sneaking and gait —
   the dog itself is Pup City / Backyard Pups' rig, unmodified. This file owns none of
   the dog's geometry or presets; it only reads the live refs runtime.js already exports
   and turns trail movement into the same leg-swing / tail-wag / bark it always had.

   Trail-specific animation (distance-based gait, sneak crouch, terrain-following height)
   lives here rather than in dog/runtime.js because runtime.js is shared with two other
   games that have no notion of terrain or sneaking — putting trail concerns there would
   be the wrong direction for the dependency arrow to point. */
import { clamp, lerp } from '../core/math.js';
import { P, dog, R, dogPos, dogYaw, STATS, setDog, setDogYaw } from '../dog/runtime.js';
import { gaitStep, climbPose, wallPose, leapPose, pushPose, legSwingValue, gallopAmount, footfalls } from './gait.js';

let legPhase = 0;
let crouchAmt = 0;
let climbAmt = 0;
let leapAmt = 0;
let slopeAmt = 0;        // eased body tilt for the ground's slope, radians nose-up
let dogLegLen = 0.4;     // hip pivot height above ground, WORLD units -- see measureLegLen

/* The shared rig sizes itself directly in world units via g.scale.setScalar(p.size)
   inside dog/build.js -- tuned to look right in Pup City's own stylised world (city
   blocks 22 units square) and reused as-is in Backyard Pups. Trails' world is real
   metric distance (DEM + GeoJSON, "1 unit = 1 metre" per the scale slider's own copy),
   and the rig was never re-tuned for that: worked out from build.js's own geometry, a
   DEFAULTS pup (size:1) measures roughly 3.9 m nose to tail-tip before any correction --
   bigger than this world's own moose, the largest thing in the wildlife roster (~1.0m
   half-body-length, comparably sized overall), and enormous next to a real 2.6 m trail.
   TRAIL_DOG_SCALE brings a default pup down to roughly 1.15 m nose to tail-tip, in line
   with the fox/coyote/bobcat that already share this world.

   Applied to the BUILT GROUP, not to params.size, deliberately: dog/stats.js derives
   walk/run/turn speed from that same size field over a narrow expected range (0.55-1.6),
   so scaling it down here would flatten every pup's stats to the same low-size floor
   instead of shrinking the model. This way a saved pup's chosen size still varies its
   speed exactly as it does in Backyard Pups; only what you SEE changes. */
const TRAIL_DOG_SCALE = 0.3;

/* The gait is foot-locked against this length (see gait.js), so it has to be the pivot's
   real height in WORLD units -- measured off the built rig after every scale it carries,
   including TRAIL_DOG_SCALE above. Deriving it from params instead is precisely how the
   original slide got in: the rig was shrunk by 0.3 and the stride constant was not. */
function measureLegLen(){
  if(!R || !R.legs || !R.legs.length || !dog) return 0.4;
  const local = (R.bodyBaseY || 0) + (R.legs[0].position.y || 0);
  return Math.max(0.05, local*(dog.scale ? dog.scale.x : 1));
}
function dogLegLength(){ return dogLegLen; }
/* The torso, measured off the live rig in WORLD units (length nose-end to tail-end of the body
   ellipsoid, and its width) -- what the hoverboard is sized from. Not the whole animal: head
   and tail hang off the ends of a board, and sizing to them would make every pup ride a plank. */
function dogBodySize(){
  if(!dog || !R || !R.bodyG || !R.bodyG.children || !R.bodyG.children[0]) return null;
  const m = R.bodyG.children[0], k = dog.scale ? dog.scale.x : 1;
  return { len: 2*m.scale.x*k, wide: 2*m.scale.z*k };
}
function dogBodyColor(){ return P && P.furColor ? P.furColor : null; }
// half-width of the contact patch the blob shadow should cover
function dogShadowRadius(){ return dogLegLen*1.25; }

function spawnDog(params){
  setDog(params);
  dog.scale.multiplyScalar(TRAIL_DOG_SCALE);
  legPhase = 0; crouchAmt = 0; climbAmt = 0; leapAmt = 0; slopeAmt = 0;
  dogLegLen = measureLegLen();
}

/* The dog's x/z live in runtime.js's `dogPos`, which updateDog() reads every frame.
   Trails drives the player through its own `player` object, so that position has to be
   pushed across explicitly -- exactly the way wild-driver's `wildPos` is written by
   main.js. Without this the rig renders at the world origin no matter where the camera
   is, which on a real 2.6 km map means it is simply never on screen. Mutate in place:
   dogPos is a live binding several modules already hold a reference to. */
function setDogPos(x, z){ dogPos.set(x, 0, z); }
function getDogPos(){ return dogPos; }

/* Switching to a wild animal used to leave the dog standing wherever it was last
   drawn, because each driver only ever replaces its OWN instance. Hide rather than
   dispose: the rig is rebuilt from params on demand and re-showing is free. */
function setDogVisible(v){ if(dog) dog.visible = !!v; }

// dog/stats.js's walk/run figures were tuned for Pup City's block-sized play area;
// wild-driver.js already applies a similar bump to SPECIES.speed for the same reason
// (trails covers real distance, not a city block) -- this is the dog-side equivalent,
// just more modest, since "a little faster" was the ask, not wildlife's full 1.7x.
const TRAIL_DOG_SPEED_MUL = 1.2;
function dogTopSpeed(){ return STATS.walk * TRAIL_DOG_SPEED_MUL; }
function dogRunMul(){ return STATS.run / STATS.walk; }

/* Called once per frame with the resolved ground height under the dog's feet (from
   terrain.js) and the current motion state. Everything below only touches `dog`/`R`,
   the live bindings runtime.js exports — never rebuilds geometry. */
/* SLOPE TILT. `slope` is how far main.js wants the body tipped for the ground under it
   (nose up positive: a fill embankment or a steep tread, see main.js groundSlope). The
   legs are children of bodyG, so tipping the body tips them with it and the paws follow
   the slope rather than one pair digging in. A body tipped about its hip-height pivot
   drops its paws by legLen*(1/cos - 1) below the slope, so the body is lifted by exactly
   that. Eased, so stepping onto a bank leans in over a few frames instead of snapping. */
function slopeLift(angle, legLen){ const c = Math.cos(angle); return c > 0.2 ? legLen*(1/c - 1) : 0; }
function updateDog(dt, t, groundY, jumpY, speed, sneaking, barking, run, climb, leap, rise, onWall, slope, board){
  if(!dog || !R) return;
  const size = P ? P.size : 1;
  // dog.position is in SCENE space, unlike dog.scale -- shrinking the group above
  // doesn't shrink this offset automatically. 0.22 world units of crouch was tuned for
  // the pre-shrink ~2.5 m-tall rig (a subtle dip); left unscaled here it would now read
  // as the dog ducking by nearly a third of its own (post-shrink) height.
  crouchAmt = lerp(crouchAmt, sneaking ? 0.22*size*TRAIL_DOG_SCALE : 0, 1-Math.pow(0.0005,dt));
  dog.position.set(dogPos.x, groundY + jumpY - crouchAmt, dogPos.z);
  dog.rotation.y = dogYaw;
  /* Leaning into a carve on a hoverboard: a roll about the animal's own forward axis, from its
     feet (the group's origin is at the paws). Order YXZ so the roll is taken AFTER the yaw. */
  dog.rotation.order = 'YXZ';
  dog.rotation.x = board && board.lean ? board.lean : 0;

  /* Foot-locked gait. Amplitude AND phase rate both come out of one stride length, so
     the planted paw is stationary against the ground at any speed -- see gait.js for why
     picking those two independently is what made the old rig skate. A sneaking pup takes
     shorter, quicker steps: a lower stride ratio, not a slower phase, or it slides again. */
  const g = gaitStep(dogLegLen, speed, dt, sneaking ? {maxRatio:1.05, cadence:2.9} : null);
  const swing = g.swing;

  /* Leap wins over climb, and both blend OVER the walk cycle rather than replacing it,
     so a jump that starts mid-stride doesn't snap the legs to a new pose. The leap also
     FREEZES the cycle (see gait.js): with no ground to push against there is nothing for
     a swinging leg to be locked to, so continuing to cycle is just the airborne form of
     the paw-slide. Snappier easing than the climb -- a leap is a sudden commitment. */
  leapAmt  = lerp(leapAmt,  clamp(leap||0, 0, 1),  1-Math.pow(0.000002,dt));
  slopeAmt = lerp(slopeAmt, onWall ? 0 : clamp(slope||0, -1, 1), clamp(1-Math.pow(0.0001,dt), 0, 1));   // clamped: a non-positive dt must not blow the ease up   // ~80% settled in five frames: a bank is often crossed in a fifth of a second
  climbAmt = lerp(climbAmt, clamp(climb||0, 0, 1), 1-Math.pow(0.0001,dt));
  const lp = leapAmt  > 0.002 ? leapPose(leapAmt, rise||0, R.legs.length) : null;
  /* A wall cling and a kerb scramble share the climbT timer but not the pose: one stands
     the pup vertically against the stone, the other tips it a few degrees over a step. */
  const cp = onWall ? wallPose(t, R.legs.length)
           : (climbAmt > 0.002 ? climbPose(climbAmt, t, R.legs.length) : null);

  /* On a hoverboard (`board` = {blend, deck}, null otherwise): blend 0 is standing on the deck
     -- legs still -- and 1 is running behind it with the front paws on its tail. The front legs
     go to the push pose by the blend; the hind legs keep the gait, which main.js drives at the
     board's speed (times the blend), so they run exactly as fast as the board moves. */
  const bl = board ? clamp(board.blend, 0, 1) : 0;
  const bp = board ? pushPose(dogLegLen, board.deck, R.legs.length) : null;

  const prevPhase = legPhase;
  legPhase += g.dPhase*(1 - (lp ? lp.freeze : 0));

  /* Sprinting switches the FOOTFALL ORDER, not just the tempo: hind pair together, then
     fore pair, with a lead leg in each. Measured against this pup's own walk and run
     stats so a fast little dog and a slow big one both gallop at their own top end. */
  const gal = gallopAmount(speed, dogTopSpeed(), dogTopSpeed()*dogRunMul());
  R.legs.forEach((leg,i)=>{
    let z = legSwingValue(i, legPhase, gal)*swing;
    if(bp && i < 2) z = lerp(0, bp.legs[i], bl);        // front paws: still, or up on the tail
    if(cp) z = lerp(z, cp.legs[i], climbAmt);
    if(lp) z = lerp(z, lp.legs[i], leapAmt);
    leg.rotation.z = z;
  });
  if(R.tail){
    R.tail.rotation.y = Math.sin(t*(sneaking?0.004:0.012))*(sneaking?0.15:0.5)
      + (barking ? Math.sin(t*0.05)*0.8 : 0);
  }
  if(R.head){
    R.head.rotation.z = barking ? 0.25 : (sneaking ? -0.12 : Math.sin(t*0.003)*0.05);
  }
  if(R.jaw) R.jaw.rotation.x = barking ? -0.35 : 0;
  if(R.bubble) R.bubble.visible = barking;
  if(R.bodyG){
    // bob scales with the rig, not with raw speed in metres: the old constant was tuned
    // pre-shrink and is nearly invisible at 0.3x
    const bob = Math.abs(Math.sin(legPhase))*clamp(speed*0.012,0,0.14)*TRAIL_DOG_SCALE*3;
    /* The bound makes the flight phase visible. gaitStep only says how much ground is
       covered with no paw down; without lifting the body for it, a gallop would read as
       a fast trot whose feet mysteriously outrun their own reach. One hump per stride,
       scaled by the leg so it stays proportionate on any pup. */
    /* A gallop is a series of little leaps, so the bound grows with it, and the spine
       flexes: the body pitches nose-up as the hind legs drive and nose-down as the
       forelegs catch. Half a cycle out of phase with the bound, which is what makes the
       two read as one motion rather than two overlaid wobbles. */
    const bound = g.bound*dogLegLen*(0.42 + 0.5*gal)*Math.max(0, Math.sin(legPhase))*(1-leapAmt);
    const flex  = gal*0.16*Math.sin(legPhase - Math.PI*0.5)*(1-leapAmt);
    const tilt = slopeAmt*(1-leapAmt);
    R.bodyG.position.y = R.bodyBaseY + bob*(1-leapAmt) + bound + (cp ? cp.rise*dogLegLen : 0)
                       + slopeLift(tilt, dogLegLen);
    let pitch = (cp ? cp.pitch : 0) + flex + tilt + (bp ? bp.pitch*bl : 0);
    if(lp) pitch = lerp(pitch, lp.pitch, leapAmt);
    R.bodyG.rotation.z = pitch;
    /* Roll into whichever diagonal is reaching. Only the climb sets it, so this is zero on
       every other frame and the body rests flat -- but without it a scramble is perfectly
       bilateral, which is the thing that made the old pose read as a statue. */
    R.bodyG.rotation.x = cp ? cp.roll : 0;
  }
  /* Handed back rather than played here: the driver knows WHEN a paw lands, and only
     main.js knows what it landed ON. Splitting it that way keeps the driver free of the
     world and the surface rules in one place. Nothing underfoot while clinging to a
     wall, and a frozen leap cycle produces no crossings anyway. */
  return onWall ? [] : footfalls(prevPhase, legPhase, gal, R.legs.length);
}

function setYaw(v){ setDogYaw(v); }

/* Test seam. The wall pose is only right if it survives the whole path from player state
   through updateDog to bodyG.rotation -- reading gait.js's return value instead would have
   passed on the exact screenshot that prompted the fix, since the pose was correct and
   simply never reached the rig. Same reason dogLegLength is exported. */
function dogBodyPitch(){ return R && R.bodyG ? R.bodyG.rotation.z : null; }
// test seam: each leg's swing, so the push can be asserted through the whole path
function dogLean(){ return dog ? dog.rotation.x : null; }   // test seam: the roll the rig was actually given
function dogLegSwing(i){ return R && R.legs && R.legs[i] ? R.legs[i].rotation.z : null; }
// test seam: the eased slope tilt on its own, without the gait's flex riding on top
function dogSlopeTilt(){ return slopeAmt; }

export { spawnDog, updateDog, setYaw, setDogPos, getDogPos, setDogVisible,
         dogTopSpeed, dogRunMul, dogLegLength, dogShadowRadius, dogBodyPitch, dogSlopeTilt,
         dogBodySize, dogBodyColor, dogLegSwing, dogLean,
         TRAIL_DOG_SCALE };
