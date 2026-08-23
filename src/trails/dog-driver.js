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
import { gaitStep, climbPose } from './gait.js';

let legPhase = 0;
let crouchAmt = 0;
let climbAmt = 0;
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
// half-width of the contact patch the blob shadow should cover
function dogShadowRadius(){ return dogLegLen*1.25; }

function spawnDog(params){
  setDog(params);
  dog.scale.multiplyScalar(TRAIL_DOG_SCALE);
  legPhase = 0; crouchAmt = 0; climbAmt = 0;
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
function updateDog(dt, t, groundY, jumpY, speed, sneaking, barking, run, climb){
  if(!dog || !R) return;
  const size = P ? P.size : 1;
  // dog.position is in SCENE space, unlike dog.scale -- shrinking the group above
  // doesn't shrink this offset automatically. 0.22 world units of crouch was tuned for
  // the pre-shrink ~2.5 m-tall rig (a subtle dip); left unscaled here it would now read
  // as the dog ducking by nearly a third of its own (post-shrink) height.
  crouchAmt = lerp(crouchAmt, sneaking ? 0.22*size*TRAIL_DOG_SCALE : 0, 1-Math.pow(0.0005,dt));
  dog.position.set(dogPos.x, groundY + jumpY - crouchAmt, dogPos.z);
  dog.rotation.y = dogYaw;

  /* Foot-locked gait. Amplitude AND phase rate both come out of one stride length, so
     the planted paw is stationary against the ground at any speed -- see gait.js for why
     picking those two independently is what made the old rig skate. A sneaking pup takes
     shorter, quicker steps: a lower stride ratio, not a slower phase, or it slides again. */
  const g = gaitStep(dogLegLen, speed, dt, sneaking ? {maxRatio:1.05, cadence:2.9} : null);
  legPhase += g.dPhase;
  const swing = g.swing;

  // climb blends OVER the walk cycle rather than replacing it, so a scramble that starts
  // mid-stride doesn't snap the legs to a new pose
  climbAmt = lerp(climbAmt, clamp(climb||0, 0, 1), 1-Math.pow(0.0001,dt));
  const cp = climbAmt > 0.002 ? climbPose(climbAmt, t, R.legs.length) : null;

  R.legs.forEach((leg,i)=>{
    const phase=(i%2?Math.PI:0)+(i>1?Math.PI*0.5:0);
    const walkZ = Math.sin(legPhase+phase)*swing;
    leg.rotation.z = cp ? lerp(walkZ, cp.legs[i], climbAmt) : walkZ;
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
    const bound = g.bound*dogLegLen*0.42*Math.max(0, Math.sin(legPhase));
    R.bodyG.position.y = R.bodyBaseY + bob + bound + (cp ? cp.rise*dogLegLen : 0);
    R.bodyG.rotation.z = cp ? cp.pitch : 0;
  }
}

function setYaw(v){ setDogYaw(v); }

export { spawnDog, updateDog, setYaw, setDogPos, getDogPos, setDogVisible,
         dogTopSpeed, dogRunMul, dogLegLength, dogShadowRadius };
