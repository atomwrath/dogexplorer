/* Gait maths shared by dog-driver.js and wild-driver.js. Pure — no THREE, no DOM, no
   knowledge of either rig beyond "it has four hip pivots that rotate about Z".

   WHY THIS EXISTS AT ALL: the paws were sliding.

   Both drivers used to advance the leg phase at a rate pulled out of the air --
   `2.6 / legLength` for the dog -- with no relationship to how far the animal actually
   moved. That constant sets a stride length whether you meant it to or not: the body
   travels `speed` metres per second while the legs complete `speed * 2.6 / 2pi` cycles,
   which works out at 2.4 m of ground per stride. A trail pup is about 1.15 m nose to
   tail with a hip roughly 0.42 m off the ground (dog-driver.js's TRAIL_DOG_SCALE shrank
   the shared rig by 0.3, and nothing downstream was ever re-tuned for it), so its real
   stride is nearer 0.5 m. The legs were therefore cycling about five times too slowly
   for the distance covered, which is exactly the "moving too slow and sliding along the
   ground" the eye picks up instantly: a planted paw was travelling backwards at a fifth
   of the speed the body went forwards.

   THE FIX IS TO DERIVE BOTH NUMBERS FROM ONE STRIDE LENGTH. Swing amplitude and phase
   rate are not independent knobs -- pick either and the other follows, or the foot
   slips. For a leg of length L swinging +/-θ about its hip, the paw sweeps 2*L*sin(θ)
   of ground per cycle. Foot-lock means the phase advances exactly 2π over that distance.
   Compute the amplitude FROM the stride and the rate FROM the same stride and the
   contact patch is stationary by construction, at any speed, for any pup's proportions.

   Stride is chosen from speed against a target cadence, then clamped by the leg itself:
   a pendulum cannot out-reach 2L, and a real quadruped only exceeds that by flexing a
   spine these rigs do not have. At a sprint the clamp binds and cadence rises instead --
   the honest trade, since a fast little dog SHOULD look frantic, and any other choice
   here reintroduces the slide we are removing. */
import { clamp } from '../core/math.js';

const TWO_PI = Math.PI*2;

/* Ratios are of LEG LENGTH, not of body length or world units, so a short-legged corgi
   and a long-legged coyote both get proportionate strides with no per-species tuning.
   The 0.92 sin cap keeps the leg off its own singularity (a 90-degree swing has no
   forward component left to give) and keeps the pose readable rather than doing splits. */
const STRIDE_MIN_RATIO = 0.55;
/* A pendulum leg cannot sweep more than 2L, so a stride longer than that has to be paid
   for by a FLIGHT PHASE -- ground covered while no paw is down. That is not a fudge, it
   is what a galloping animal actually does, and modelling it explicitly is what lets the
   cadence stay believable at speed without the paws going back to skating. Below this
   the animal walks and trots with every stride fully planted; above it, it bounds. */
const STRIDE_MAX_RATIO = 3.0;
const MAX_SIN_SWING = 0.92;

/* Target cadence in strides/sec at a walk. Whenever speed allows a stride inside the
   ratio band, the animal walks at about this cadence and lengthens its stride to go
   faster -- which is what real quadrupeds do until they run out of leg. */
const TARGET_CADENCE = 2.35;

/* legLen is the hip pivot's height above the ground IN WORLD UNITS -- i.e. after every
   scale the rig carries, including the driver's own shrink factor. Passing a rig-local
   length is the one mistake that silently reproduces the original bug, so drivers
   measure it off the live object rather than recomputing it from params. */
function gaitStep(legLen, speed, dt, opts){
  const L = Math.max(1e-4, legLen);
  const o = opts || {};
  const minR = o.minRatio != null ? o.minRatio : STRIDE_MIN_RATIO;
  const maxR = o.maxRatio != null ? o.maxRatio : STRIDE_MAX_RATIO;
  const cad  = o.cadence  != null ? o.cadence  : TARGET_CADENCE;
  const sp = Math.max(0, speed);

  const wanted = sp/Math.max(0.01, cad);
  const stride = clamp(wanted, L*minR, L*maxR);
  // what the leg itself can sweep while planted...
  const reach = Math.min(stride, 2*L*MAX_SIN_SWING);
  // ...and the remainder, covered airborne. Zero at walking speeds; grows into a gallop.
  const flight = Math.max(0, stride - reach);
  const sinSwing = clamp(reach/(2*L), 0, MAX_SIN_SWING);
  /* THE FOOT-LOCK INVARIANT, and the one line to get right: reach + flight == stride,
     and the phase advances 2π over exactly `stride`. So while a paw is down it moves
     backwards at precisely body speed, and the only ground not accounted for by a
     planted paw is the ground crossed with all four feet off it. */
  return {
    swing: Math.asin(sinSwing),
    dPhase: sp*dt*TWO_PI/Math.max(1e-4, stride),
    stride,
    reach,
    flight,
    // 0 at a walk, ->1 in a full gallop; drivers use it to add a bound so the airborne
    // part of the cycle is something you can SEE rather than an accounting trick
    bound: clamp(flight/Math.max(1e-4, stride), 0, 1),
    cadence: sp/Math.max(1e-4, stride),
  };
}

/* Scrambling up a ledge. `amt` is 0..1 and comes from the movement code, which is the
   only thing that knows a step-up actually happened; the drivers just pose to it.

   Front legs reach up and over the lip while the hind pair stays planted and pushes --
   the read is "hauling itself up", not "walking with a tilt". `+x is the nose` on both
   rigs (dog/build.js puts headG at +bodyRx, animal-models.js at +L), and hips rotate
   about Z with positive Z swinging a paw FORWARD, so every sign below follows from that
   one convention. Returns per-leg targets for the caller to blend toward, rather than
   writing them, so the drivers keep sole ownership of their own refs. */
function climbPose(amt, t, legCount){
  const a = clamp(amt, 0, 1);
  // alternating paw scrabble, fast and small -- a climb is not a walk cycle
  const scrab = Math.sin(t*0.026)*0.38*a;
  const legs = [];
  for(let i=0;i<legCount;i++){
    const front = i<2;
    legs.push(front
      ? a*(1.05 + (i===0 ? scrab : -scrab))    // reach: paws up onto the lip
      : a*(-0.62 + (i===2 ? -scrab : scrab))); // push: hind legs extend behind
  }
  return {
    legs,
    pitch: a*0.40,      // bodyG.rotation.z -- nose up, because forward is +x
    rise:  a*0.11,      // a little hop of the body as it hauls up
  };
}

export { gaitStep, climbPose, STRIDE_MIN_RATIO, STRIDE_MAX_RATIO, TARGET_CADENCE };
