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
/* CLINGING TO A VERTICAL FACE, which is a different animal from scrambling over a kerb.

   The reported screenshot showed the pup sticking out of the rock nose-first, lying
   horizontally like a shelf bracket: that is the walking orientation with a scramble pitch
   of about 26 degrees added, which is right for hopping a terrace riser and completely
   wrong for hanging off a wall. On a wall the body has to stand UP -- pitched most of a
   right angle so the spine runs up the face and the belly is against the stone.

   It is a PITCH and not a yaw because forward on this rig is +x and bodyG.rotation.z tips
   the nose up; the driver turns the whole group to face the rock separately (main.js sets
   player.yaw from the face normal), so pitch and yaw compose into "standing on the wall,
   facing it" rather than "lying along it".

   Paws scrabble in the same diagonal antiphase as the scramble, at a smaller amplitude --
   a cling is holding on, not hauling. The slow sway keeps it from reading as a decal. */
function wallPose(t, legCount){
  const ph = t*0.009;
  const A = Math.sin(ph), B = Math.sin(ph + Math.PI);
  const legs = [];
  for(let i=0;i<legCount;i++){
    const front = i<2;
    const swing = ((i===0 || i===3) ? A : B);
    legs.push(front ? 0.55 + swing*0.30 : -0.30 + swing*0.22);
  }
  return {
    legs,
    pitch: 1.32,                 // ~76 degrees: nose up the face, belly to the rock
    rise:  0.02 + A*0.03,
    roll:  A*0.10,
  };
}

function climbPose(amt, t, legCount){
  const a = clamp(amt, 0, 1);

  /* A DIAGONAL SCRAMBLE, not a symmetric one. The first version swung both front legs
     together against both hind legs, which is a pose rather than a movement -- it reads as
     a dog frozen mid-stretch and holds that read for the whole ascent. Real climbing moves
     one limb at a time and keeps three planted, so the two diagonals are driven in
     antiphase: front-left reaches with hind-right while the other pair holds, then they
     swap. Same cycle a trot uses, which is why it reads as locomotion instead of a stance.

     Slower than the old 0.026 and deeper. The scrabble used to be fast and tiny, which at
     a climb rate you can now watch just looked like a vibration; a climb that takes
     several seconds needs strokes you can actually follow. */
  const ph = t*0.0115;
  const A = Math.sin(ph), B = Math.sin(ph + Math.PI);   // the two diagonals, in antiphase
  const legs = [];
  for(let i=0;i<legCount;i++){
    const front = i<2;
    const left = (i===0 || i===2);
    // legs 0,3 form one diagonal and 1,2 the other -- matching the trot offsets below
    const swing = ((i===0 || i===3) ? A : B);
    legs.push(front
      ? a*(0.95 + swing*0.55)                  // reach: paws haul up over the lip
      : a*(-0.55 + swing*0.32));               // push: hind legs drive off the face
    void left;
  }
  return {
    legs,
    pitch: a*0.46,                     // bodyG.rotation.z -- nose up, because forward is +x
    /* Body surges with the stroke rather than bobbing on a timer of its own, so the rise
       lands on the beat the paws pull -- that coupling is most of what sells the effort. */
    rise:  a*(0.10 + A*0.06),
    // a little roll into whichever side is reaching, which is what stops it reading flat
    roll:  a*A*0.13,
  };
}

/* Leg phase offsets, per gait.

   A TROT is diagonal: each leg is half a cycle from its neighbour and a quarter from the
   pair behind, which is the pattern the drivers always used and the right one at walking
   speed. A GALLOP is not a faster trot -- it is a different footfall order. The hind pair
   lands together, then the fore pair together, with a small lead offset inside each pair
   so one leg reaches slightly further than its partner (the "lead leg" every galloping
   quadruped has). Blending between the two is what makes a sprint read as a sprint rather
   than as a trot with the tape sped up.

   Returned as a SIN VALUE rather than a phase so callers can cross-fade between gaits
   without the wrap discontinuity that lerping two angles across +-PI would give. */
function legSwingValue(i, phase, gallopAmt){
  const trotPhase   = (i%2?Math.PI:0) + (i>1?Math.PI*0.5:0);
  // i<2 are the forelegs (dog/build.js and animal-models.js both put them at +x)
  const front = i<2;
  const lead  = (i%2) ? 0.22 : 0;                       // one leg of each pair leads
  const gallopPhase = (front ? Math.PI*0.62 : 0) + lead;
  const trot   = Math.sin(phase + trotPhase);
  const gallop = Math.sin(phase + gallopPhase);
  const a = clamp(gallopAmt, 0, 1);
  return trot + (gallop - trot)*a;
}

/* How much of a gallop the animal is in, from its own speed against its own walk and run
   figures -- NOT from an absolute m/s, which would make a bobcat gallop while a moose
   ambled at the same number. 0 at its comfortable pace, 1 flat out. */
function gallopAmount(speed, walkTop, runTop){
  const lo = Math.max(0.01, walkTop), hi = Math.max(lo*1.05, runTop);
  return clamp((speed - lo)/(hi - lo), 0, 1);
}

/* Airborne. A jumping animal does NOT keep running in mid-air -- there is no ground to
   push against, so the legs stop cycling and hold a spread: forelegs reaching ahead,
   hind legs trailing behind, the shape every leaping animal makes and every cartoon
   exaggerates. Freezing the walk cycle matters as much as the pose; a leg that keeps
   swinging while the paw is nowhere near the ground is the airborne version of exactly
   the slide we removed on the ground.

   `rise` is the vertical velocity normalised to roughly -1..1. Going up, the animal is
   still extending and the nose comes up; coming down it reaches for the landing and the
   nose drops. Same sign convention as everything else here: +x is the nose, and a
   positive Z rotation swings a paw forward. */
function leapPose(amt, rise, legCount){
  const a = clamp(amt, 0, 1);
  const r = clamp(rise, -1, 1);
  const legs = [];
  for(let i=0;i<legCount;i++){
    const front = i<2;
    // splay the pairs slightly apart from each other so the silhouette reads as a spread
    // rather than two legs hidden behind two others
    const splay = (i%2 ? 0.90 : 1.10);
    legs.push(front ? a*1.00*splay*(1 + 0.12*r)      // forelegs reach ahead, more so rising
                    : a*-0.92*splay*(1 - 0.12*r));   // hind legs trail, extending on the way up
  }
  return {
    legs,
    pitch: a*0.30*r,        // nose up while climbing, down while dropping
    // how much of the walk cycle to suppress: total, at full leap
    freeze: a,
  };
}

export { gaitStep, climbPose, wallPose, leapPose, legSwingValue, gallopAmount,
         STRIDE_MIN_RATIO, STRIDE_MAX_RATIO, TARGET_CADENCE };
