/* Pup Trails entry point. Player movement is shared regardless of whether you're playing
   as the dog or a wild animal; only the two driver modules differ in what gets animated
   and where the geometry comes from (dog/runtime.js's shared rig vs. animal-models.js's
   shared quadruped()).

   THE AVATAR RULE, learned the hard way: this file owns `player`, and every driver has
   its own position store -- dog/runtime.js's `dogPos`, wild-driver.js's `pos`. Neither
   reads `player`. Any code path that moves the player MUST push x/z across to whichever
   driver is live (syncAvatar below), or the rig renders at the world origin while the
   camera follows the player, which on a 2.6 km map means it is simply never on screen.
   That was the "map loads, no dog" bug. */
import { clamp, lerp } from '../core/math.js';
import { setWildVisible, setWildYaw, spawnWild, spookRadiusFor, topSpeedFor, updateWild, wildPos, wildShadowRadius } from './wild-driver.js';

import { dogRunMul, dogTopSpeed, setDogPos, setDogVisible, setYaw, spawnDog, updateDog, dogShadowRadius } from './dog-driver.js';
import { updateShadow, setShadowVisible } from './shadow.js';
import { updateNoiseRing, setNoiseRingVisible, noiseRingRadius, updateCatchRing, setCatchRingVisible } from './noise-ring.js';
import { getWorld, rawGroundY } from './terrain.js';

import { addCamPitch, addCamYaw, addCamZoom, getCamPitch, getCamYaw, getCamZoom, setCamYaw, snapChaseCam, updateChaseCam } from './camera.js';
import { getCritterStats, spawnCritters, resetCritters, updateCritters, WATCH_SECONDS, playerNoise, typicalSpookRadius, takeImpacts,
         catchNear, releaseCarried, getCarried, carrySlow, setCarryAnchor, nearestCatchable, catchRadius } from './critters.js';
import { initMinimap, updateMinimap, setHighlightRoute,
         setCourseShown, getCourseShown, setRaceFrac } from './minimap.js';
import { initPanes, getPane, showPane, togglePane } from './panes.js';
import { setCourseLine, refreshCourseLine, clearCourseLine } from './course-line.js';
import { addSpot, getSpots, removeSpot, setSpotMap, spotNear, spotWorld } from './spots.js';
import { addCourse, courseBestFor, courseBestOverall, courseFinished, courseLengthM, courseLookFrac,
         coursePoints, courseProgress, courseStartYaw, courseTimes, fmtCourseLen, fmtRaceTime,
         getCourse, getCourses, polyLenM, recordCourseTime, removeCourse, setCourseMap,
         COURSE_MAX_PTS, COURSE_MIN_M, COURSE_ON_M, COURSE_STEP_M, COURSE_JUMP_M,
         COURSE_REJOIN_S, COURSE_SNAP_M, courseRelief, polyRelief, bumpRelief,
         courseGhost, ghostAt, GHOST_DT, GHOST_MAX } from './courses.js';
import { setGhostAvatar, placeGhost, hideGhost, disposeGhost, getGhostGroup } from './ghost.js';
import { comicBurst, updateFX } from '../core/fx.js';
import { shakeT, setShake, decayShake } from '../core/shake.js';
import { barkSound, cheerBlip, initAudio, thudSound,
         stepSound, landSound, jumpSound, scrabbleSound,
         countPip, goTone, offCourseSound, rejoinSound } from '../core/audio.js';

import { addLayers, clearLayers, compass, getBBox, getBackdrop, getContourStep, getExaggeration, getFogMultiplier, getGraph, getMapId, getMapScale, getPathMix, getPOIs, hasBundle, getStartHead, getTrailheads, getVertScale, loadWorld, setContourStep, setFogMultiplier, setMapScale, setStartHead, setThemeById, setVertScale, standingY, areaBlocked, areaSolidTop, nearestSolidFace, solidEmbed, distToSolid } from './world.js';

import { THEME, THEMES } from './themes.js';
import { renderer, scene, camera, resize } from '../core/render.js';
import { SPECIES } from '../data/species.js';
import { PRESETS } from '../creator/presets.js';
import { DEFAULTS, randomPupParams } from '../dog/params.js';
import { computeStats } from '../dog/stats.js';
import { addPups, kennelPups, loadKennel, parsePupFile } from '../data/kennel.js';
import { nearestTrail } from './spatial.js';

/* Trail networks run to real kilometres; Pup City's camera (far=300, tuned for one city
   block) would clip most of a trail map. Extend it rather than touch the shared file. */
// far: trail networks run to real kilometres; Pup City's far=300 (tuned for one city
// block) would clip most of a trail map. fov: Pup City's 38 deg is a tight telephoto,
// chosen for its small enclosed blocks; trails is wide open country, so a wider,
// more natural-feeling field of view suits it better.
camera.far = 4000; camera.fov = 62; camera.updateProjectionMatrix();
camera.position.set(0, 40, 60);

const $ = s => document.querySelector(s);

/* The map you get if you don't ask for one. Relative to trails/index.html, which also
   resolves correctly for dist/pup-trails.html served from the repo root and for the
   GitHub Pages deploy. `?world=` still overrides it, and the file picker still replaces
   it at runtime. Loaded through the normal path -- no special-casing -- so a failure
   here fails exactly the way a hand-picked bundle would. */
const DEFAULT_WORLD = '../data/world.json';

/* ---------- player state ---------- */
let mode = 'dog';           // 'dog' | 'wild'
let wildKey = 'fox';
let dogChoice = {label: PRESETS[0].label, params: PRESETS[0].o};
let browseMode = 'dog';     // which roster grid the panel is showing -- independent of
                             // `mode` above, so you can look at Wildlife without it
                             // changing who you're actually playing as until you tap one
const player = { x:0, z:0, y:0, vy:0, yaw:0, speed:0, dist:0, sneaking:false, barkT:0,
                 /* What the last movement frame decided is underfoot, for the footstep
                    voice. Defaulted so a footfall arriving before movement has run (a
                    placement, a lobby preview) still has a surface to speak with. */
                 surface:'trail',
                 scuffT:0,          // countdown between climbing scuffs
                 /* climbT counts DOWN while the pup is scrambling up a step. It is set
                    only by an on-foot step-up (see moveOffTrail) -- never by a jump,
                    which is the whole point: jumping a ledge is the fast way over it and
                    costs nothing, walking up one costs you speed. */
                 climbT:0, climbAmt:0,
                 /* Knockback, from a big animal deciding it has had enough of you.
                    `knockT` counts down and is the ONLY thing that suppresses input --
                    which is deliberate and short: a hit you cannot respond to for a full
                    second stops being funny the second time it happens. */
                 knockT:0, kvx:0, kvz:0, spinT:0, spin:0,
                 /* Seconds spent holding position. Feeds critters.js's noise model, which
                    could not previously tell "stopped" from "creeping", because the only
                    signal it had was player.speed and the loop lerps that to zero in about
                    a fifth of a second. Time is the honest measure of settling: it keeps
                    paying out for as long as you hold, which is what makes standing still
                    a move rather than an absence of one. */
                 stillT:0, wall:null, regrabT:0 };
/* Seconds of holding position to be fully settled, and seconds of moving to undo it.
   ASYMMETRIC ON PURPOSE, and this is what makes the catch reachable at all. Settling has
   to be slow enough to be a decision; losing it has to be slow enough that the two or
   three sneaking steps between "close" and "in reach" do not hand the animal its full
   spook radius back before you arrive. Measured against the default roster, a settled
   sneak sits at ~2.9 m and a moving one at ~4.8 m, so those few steps are exactly the
   window this constant governs. */
/* How far out the reach ring starts being drawn, as a multiple of the reach itself. Wide
   enough that it appears while you are still closing in -- a ring that only shows up once
   you are already inside it tells you nothing you could act on -- and tight enough that it
   is a response to one particular animal rather than ambient decoration. */
const SHOW_MUL = 2.6;
/* How far up you can clamber onto a rock or a roof, in world units. Set well above what a
   jump alone reaches (1.74) so most formations and every building are gettable, and well
   below the tallest fins (15) so those stay scenery you look at rather than furniture. */
/* Still used by the smoke suite to sort formations into "a wall jump can plausibly reach
   this" and "this is scenery", which is a judgement about the map rather than a rule the
   game enforces -- the wall jump itself has no height limit, only a cling clock. */
const MOUNT_REACH = 7;
/* ---- wall jumping ----------------------------------------------------------------
   Replaces a continuous hold-to-ascend climb, which was the wrong shape for this game.
   Hauling up a face at a fixed rate asks nothing of the player but patience -- and the
   thing Pup Trails is actually good at is small physical skills you get better at, like
   sneaking. Jumping a rock in stages is a skill; holding a stick is not.

   The loop: leap at a face, cling to it, and jump again before you slide off. Each wall
   jump throws you up and a little away, so you have to steer back in to catch the rock
   higher up. Miss the timing and you slide, miss the catch and you land. */
const WALL_STANDOFF = 0.55;   // how far the pup's body sits off the rock while clinging
const WALL_GRAB_DIST = 1.9;   // how close a face has to be to catch it in mid-air
/* How squarely you have to be moving at a face to catch it. Looser than the old walking
   grab, because in the air you are on a ballistic arc and cannot steer freely. */
const WALL_GRAB_DOT = 0.35;
/* Cling physics. You do not hang indefinitely: the slide starts gently and accelerates,
   so there is a comfortable beat to push off in and a penalty for dithering. */
const WALL_SLIDE_ACCEL = 5.2;
const WALL_SLIDE_MAX = 4.5;
const WALL_CLING_MAX = 1.6;   // seconds before your paws give out entirely
/* The push-off. Up is most of it; OUT is small but not zero -- a wall jump that went
   straight up would let you hold one direction and ratchet to the summit, which is the
   patience mechanic again wearing a cape. Having to re-aim is the skill. */
const WALL_JUMP_VY = 8.6;
const WALL_JUMP_OUT = 2.6;
/* A short grace after pushing off during which you cannot re-catch the SAME face. Without
   it the frame after a wall jump re-grabs the rock you are still touching and the jump is
   swallowed. */
const WALL_REGRAB_DELAY = 0.22;
/* How far up a face you must be before it can be caught. A plain jump reaches about 1.74,
   so this leaves room to start a chain from the ground while refusing catches at ankle
   height -- see tryWallCatch. */
const WALL_MIN_CATCH = 1.0;
function mountReach(){ return MOUNT_REACH; }
const SETTLE_SECONDS = 1.4;
const UNSETTLE_SECONDS = 1.1;
const STILL_SPEED = 0.35;        // m/s below which the pup counts as holding position
function stillness(){ return clamp(player.stillT/SETTLE_SECONDS, 0, 1); }
const KNOCK_DUR = 0.55;      // seconds of lost control per hit
const KNOCK_DRAG = 0.06;     // per-second velocity retention; a shove, not a slide
const CLIMB_DUR = 0.42;    // seconds of scramble per step-up, refreshed on each new step
const CLIMB_SLOW = 0.45;   // top-speed multiplier while scrambling
/* Beyond this much turn, the auto-follow gives up rather than whipping the view round.
   ~115 degrees: comfortably past a diagonal (45) and a hard strafe (90), so only a real
   backpedal trips it. See the derivation at the call site. */
const BACKPEDAL_ARC = 2.0;
function backpedalArc(){ return BACKPEDAL_ARC; }   // test seam (const, see climbSlowFactor)
/* Test seam. `const` bindings do not survive the smoke harness's eval boundary the way
   function declarations do (same reason getSignCount and getBigView exist), so the two
   climb tunables are readable through calls rather than asserted on directly. */
function climbSlowFactor(){ return CLIMB_SLOW; }
function climbDuration(){ return CLIMB_DUR; }

/* One walk's worth of state. `parked` is the trailhead index you are currently standing
   at: it suppresses re-triggering the arrival screen every frame while you stand there,
   and is cleared once you walk away, so coming BACK to the same trailhead counts again.
   `paused` freezes input and movement while the card is up but keeps rendering, because
   "Keep exploring" has to drop you exactly where you were rather than at the start. */
const trip = { startT:0, parked:-1, paused:false, landmarks:[], bonks:0 };
let playing=false;
/* Timestamp of the last manual look-drag (performance.now(), not the loop's own `t` --
   pointer events fire outside the loop). While recent, the auto-follow below backs off
   so it doesn't fight a hand that's actively orbiting the camera. */
let lastLookT=-Infinity;
let avatarKey='';           // identity of whatever is currently built, for ensureAvatar
/* The trail underfoot, as a route identity plus what to call it. Two consumers want the
   same answer and would otherwise each ask nearestTrail their own way: the map, which
   over-strokes it bright, and the HUD chip, which names it. Held rather than recomputed
   so that stepping OFF a trail does not immediately blank both -- the map you are reading
   at a fork should still show the trail you just left, right up until you are properly
   away from it. */
const onTrail = {route:null, name:'', color:'', d:Infinity};
const TRAIL_FORGET_U = 25;   // world units off-trail before the highlight is dropped

/* Recompute the trail underfoot from wherever the player currently is, and push the
   answer to the map. Called after every teleport (trailhead, saved spot, world rebuild)
   as well as each frame of a walk, so the highlight is right in the lobby preview too --
   not only once you are moving. */
function refreshOnTrail(known){
  const nt = known || nearestTrail(player.x, player.z);
  if(nt.edge && nt.d <= Math.max(nt.hw, 2.5)){
    onTrail.route = nt.edge.route; onTrail.name = nt.edge.name;
    onTrail.color = nt.edge.color; onTrail.d = nt.d;
  }else if(!nt.edge || nt.d > TRAIL_FORGET_U){
    onTrail.route = null; onTrail.name = ''; onTrail.color = ''; onTrail.d = Infinity;
  }else{
    onTrail.d = nt.d;
  }
  setHighlightRoute(onTrail.route);
}

/* Bark. The sound is pitched by the barker's SIZE rather than read off the dog rig, so a
   moose does not yip like a terrier -- see core/audio.js's barkSound on why it cannot
   just use the city dog's yip(). `barkT` is unchanged and still does the gameplay half:
   critters.js reads it as a noise spike, so a bark is also how you deliberately blow your
   own cover. */
function barkerSize(){
  if(mode==='dog') return dogParams().size ?? 1;
  return (SPECIES[wildKey] && SPECIES[wildKey].scale) || 1;
}
function doBark(){
  if(!playing || trip.paused) return;
  player.barkT=1;
  barkSound(barkerSize());
}

function currentTopSpeed(){ return mode==='dog' ? dogTopSpeed() : topSpeedFor(wildKey); }
function currentRunMul(){ return mode==='dog' ? dogRunMul() : 1.8; }
/* The speed the noise model measures you against: the animal's FLAT-OUT speed, not its
   walking speed. critters.js computes pace as speed/reference and clamps it to 1, so
   passing the walking top speed meant pace hit 1.0 at a walk and a sprint could not be
   any louder -- sneaking worked, but walking and running were identical to every animal
   on the map. Invisible while the only feedback was whether a deer bolted; obvious the
   moment the radius is drawn on the ground. */
function noiseReference(){ return currentTopSpeed()*currentRunMul(); }

/* ---------- avatar ----------
   ensureAvatar rebuilds geometry only when the *identity* changes; syncAvatar pushes
   position every time the player moves or is teleported. Keeping them apart means
   re-placing at a trailhead, changing theme or dragging the scale slider no longer
   rebuilds and re-uploads the whole rig. */
function dogParams(){ return Object.assign({}, DEFAULTS, dogChoice.params); }

function ensureAvatar(){
  const key = mode==='dog' ? 'dog:'+dogChoice.label : 'wild:'+wildKey;
  if(key === avatarKey) return;
  avatarKey = key;
  if(mode==='dog'){
    spawnDog(dogParams());
  }else{
    // stable seed per species: the same fox should look the same every time you pick it
    let h=0; for(let i=0;i<wildKey.length;i++) h=(h*31+wildKey.charCodeAt(i))|0;
    spawnWild(wildKey, Math.abs(h)||1);
  }
  setDogVisible(mode==='dog');
  setWildVisible(mode==='wild');
}

/* Turn the drivers' footfall reports into sound. Everything that varies is a fact the
   game already has: how fast this animal is moving as a fraction of ITS OWN range -- so
   a fox and a moose each brighten across their own gait rather than against an absolute
   m/s, the same reasoning gallopAmount uses -- what is underfoot, and which pair the paw
   belongs to.

   Hind paws land heavier than front ones. That is not decoration: a quadruped drives off
   its hind legs, and giving both pairs identical weight is what makes a gallop read as a
   drum machine rather than an animal. A sneaking pup is PLACING its feet, so it gets the
   same rhythm at a fraction of the level rather than a different sound. */
function playFootfalls(steps, speed, sneaking){
  if(!steps || !steps.length) return;
  const ceiling = Math.max(0.01, currentTopSpeed()*currentRunMul());
  const frac = clamp(speed/ceiling, 0, 1);
  const hush = sneaking ? 0.32 : 1;
  for(const s of steps){
    stepSound({ surface: player.surface,
                speed: frac,
                weight: (s.front ? 0.78 : 1.12)*hush });
  }
}

function syncAvatar(dt, t, jumpY, speed, sneaking, barking, run){
  // standingY, not terrainY: it is the ONE definition of "what am I standing on",
  // shared with the critters and with everything world.js plants on a path. Off-trail it
  // is plain terrain; on-trail it reads the tread's own profile out of the spatial hash,
  // so the avatar can't clip through the ribbon inside the short ramps at a terrace step.
  const groundY = playerGroundY(player.x, player.z);
  // eased 0..1: full while the scramble timer runs, decaying once it expires, so the
  // pose settles back into the walk instead of popping flat the instant the step is done
  const climb = player.climbT > 0 ? player.climbAmt : 0;
  /* Airborne: 1 once the pup is clear of the ground, so the drivers can hold a leap
     spread instead of running in mid-air. The threshold is a hair above zero because
     `player.y` is exactly 0 while grounded (the gravity clamp guarantees it) -- anything
     larger would miss the start of a hop, and anything smaller would flicker on the
     frame it lands. `rise` is vertical velocity normalised, so the pose knows whether it
     is still going up or already reaching for the landing. */
  /* NOT while clinging to a wall. `jumpY` is height above the ground, which is metres of
     rock face when the pup is hanging off one -- so this read as a permanent leap and the
     drivers lerped the leap pose right over the wall pose, leaving the body pitched 32
     degrees instead of 76. That is the reported screenshot: a pup lying horizontally,
     sticking out of the stone nose-first. A cling is the opposite of airborne. */
  const leap = (!player.wall && jumpY > 0.02) ? 1 : 0;
  const rise = clamp(player.vy/7, -1, 1);
  let radius = 0.5;
  let steps = null;
  if(mode==='dog'){
    setDogPos(player.x, player.z);
    setYaw(player.yaw);
    steps = updateDog(dt, t, groundY, jumpY, speed, sneaking, barking, run, climb, leap, rise, !!player.wall);
    radius = dogShadowRadius();
  }else{
    wildPos.set(player.x, 0, player.z);
    setWildYaw(player.yaw);
    steps = updateWild(dt, t, groundY, jumpY, speed, sneaking, barking, climb, leap, rise, !!player.wall);
    radius = wildShadowRadius();
  }
  playFootfalls(steps, speed, sneaking);
  updateShadow(player.x, player.z, groundY, jumpY, radius, true);
  /* Where a passenger rides, measured off the LIVE rig rather than guessed. `radius` is
     the shadow radius, which both drivers derive from their own measured leg length in
     world units -- so it already accounts for TRAIL_DOG_SCALE, for whichever pup size the
     player picked, and for a fox being smaller than a moose. Everything here is expressed
     as a multiple of it, which is why a passenger sits correctly on any avatar without a
     per-species table.

     `mount` is that same radius used as a scale. An unshrunk city rig measures about 1.0
     here, so passing the radius straight through renders the passenger at the same
     reduction the avatar itself is carrying -- see critters.js's catchNear for why an
     unscaled one is unusable. */
  setCarryAnchor(player.x - Math.cos(player.yaw)*radius*0.7,
                 groundY + jumpY + radius*2.2,
                 player.z + Math.sin(player.yaw)*radius*0.7,
                 player.yaw, radius);
  return groundY;
}

/* Drop the player at trailhead `i`. Falls back to the middle of the map when a set of
   layers has no degree-1 node to make a trailhead out of -- an avatar standing in the
   centre of the map is far more debuggable than no avatar at all. */
function placeAtHead(i){
  const heads = getTrailheads();
  if(heads.length){
    setStartHead(clamp(i,0,heads.length-1));
    const h = heads[getStartHead()];
    player.x=h.x; player.z=h.z; player.yaw=h.yaw;
  }else{
    const bb=getBBox();
    player.x=(bb.minx+bb.maxx)/2; player.z=(bb.minz+bb.maxz)/2; player.yaw=0;
  }
  player.y=0; player.vy=0; player.dist=0; player.speed=0;
  setCamYaw(Math.atan2(Math.cos(player.yaw), -Math.sin(player.yaw)));
  ensureAvatar();
  const groundY = syncAvatar(0,0,0,0,false,false,false);
  // snap, never ease: placing at a trailhead is a teleport, and springing the camera
  // across a kilometre of map to catch up reads as a cutscene nobody asked for
  snapChaseCam(player.x, player.z, groundY, getVertScale(), 13);
  refreshOnTrail();
  renderStartPicker();
}

/* Put the player at an arbitrary spot on the map, facing `yaw`.

   Deliberately NOT placeAtHead with different numbers: a trailhead is the START of a walk
   and resets the odometer, whereas returning to a saved pin mid-walk is travel WITHIN one
   -- zeroing the distance there would quietly delete the walk you are auditing when you
   go back to check something. `parked` is cleared either way, or arriving back at a
   trailhead you pinned would not re-open the summary. */
function placeAt(x, z, yaw){
  player.x=x; player.z=z; player.yaw=yaw||0;
  player.y=0; player.vy=0; player.speed=0; player.wall=null; player.regrabT=0;
  setCamYaw(Math.atan2(Math.cos(player.yaw), -Math.sin(player.yaw)));
  ensureAvatar();
  const groundY = syncAvatar(0,0,0,0,false,false,false);
  snapChaseCam(player.x, player.z, groundY, getVertScale(), 13);
  refreshOnTrail();
  trip.parked = -1;
}

function placeAtSpot(spot){
  if(!spot) return;
  const p = spotWorld(spot);
  placeAt(p.x, p.z, spot.yaw);
  showPane(null);
}

/* Drop a pin where the player is standing.

   Stored through spots.js in REAL metres (see that file on why), named after the trail
   underfoot when there is one -- "On Palmer Trail" tells you more at a glance than
   "Spot 3", and the number is on the badge anyway. Refuses to stack: a held key or a
   double-tap would otherwise leave three pins on one rock, and a map of duplicates is
   worse than no map. */
const SPOT_MIN_GAP_U = 4;
function saveHere(){
  if(!getGraph()) return null;
  const dup = spotNear(player.x, player.z, SPOT_MIN_GAP_U);
  if(dup){ flashSpotNote('Already pinned here'); return null; }
  const where = onTrail.name ? ('On ' + onTrail.name) : (compass(player.x, player.z) + ' country');
  const spot = addSpot(player.x, player.z, player.yaw, where, elevationFt(player.x, player.z));
  renderSpotList();
  comicBurst('\ud83d\udccd ' + spot.name, player.x, standingY(player.x, player.z)+2.2,
             player.z, '#4f8fd6');
  cheerBlip();
  return spot;
}
/* With the HUD button gone there is nowhere in the corner to say "already pinned here",
   so it is said in the world instead, where the player is already looking. */
function flashSpotNote(msg){
  comicBurst(msg, player.x, standingY(player.x, player.z)+2.0, player.z, '#8d7a66');
}


/* ============================ RECORDING A COURSE ============================

   WHAT IS ACTUALLY STORED, and why it is not where you walked. Every sample is the
   projection of the player onto the nearest trail centreline (spatial.js's nearestTrail
   now hands that point back), not the player's own position. Two walkers padding along
   opposite verges of the same trail would otherwise trace two courses a metre and a half
   apart, and a race against the other one would read as permanently off-line. Snapping
   means a course is a fact about the NETWORK, which is what makes it raceable by anyone.

   Off the trail, nothing is recorded and the trace simply pauses. That is deliberate
   rather than a limitation: "record a path" on a trail map means a path, and a course
   that wandered across open country could not be snapped, could not be followed on the
   ground, and would be raced by cutting straight across the countryside anyway. Walking
   off and rejoining leaves one long leg in the trace, which the race handles as a leg like
   any other -- see courses.js's courseProgress on why a long leg is not a free shortcut.

   Samples are in REAL METRES from the first one, not converted at save time, so dragging
   the world-scale slider halfway through a recording does not leave a course with a kink
   in it. */
const rec = {on:false, pts:[], lenM:0, startName:'', offT:0, full:false, live:null};
/* The live trace, as one object that never changes identity. minimap.js holds this by
   reference and re-reads `pts` every frame, so appending a point is all the drawing needs
   -- which is why `pts` below is cleared IN PLACE rather than reassigned, the same rule
   COLLIDERS and SPOTS live under and for the same reason. */
rec.live = {id:-1, name:'Recording', pts:rec.pts, lenM:0, times:{}};
/* A finished trace waiting for a name. Held apart from `rec` because "stopped" and "saved"
   are different states and the card shows a different thing in each -- and because
   discarding has to be possible, which means the trace cannot go straight into storage. */
let recPending = null;
/* A course the walker has asked to SEE without racing it. Separate from the race's own
   course so closing the finish card can leave the line on the map. */
let previewCourse = null;

/* ============================== RACING A COURSE =============================

   `count` runs the 3-2-1, `go` holds the GO! flash, `t` is the clock and `frac` is how far
   round the runner has got (courses.js owns the rule; this only holds the number). The
   clock does not start until the countdown ends, and input is frozen until then -- a
   countdown you can walk through is a countdown that means nothing.

   `frac` is monotonic on purpose: it only ever moves forward, and only within a window
   ahead of where it already is. That single property is the whole of the anti-shortcut
   rule and it lives in courses.js, so a race and the line drawn on the map can never
   disagree about how far round somebody is. */
const race = {on:false, course:null, count:0, go:0, t:0, frac:0, off:0, done:false,
              trail:[], trailT:0, ghost:null, ghostFrac:0, gap:null,
              pip:-1,        // last countdown number spoken; -1 so the opening 3 counts
              warned:false,  // has the walker been told they are off the line?
              offT:0};       // countdown to repeating that
const RACE_COUNT_SECS = 3;
const RACE_GO_SECS = 0.8;
/* How long before the off-course cue repeats. Deliberately long: this fires at someone
   who is already lost, and a reminder that arrives faster than they can read the map is
   the difference between a helpful game and one people mute. */
const OFF_REMIND_S = 6;
/* Which ghost to chase: 'best' (the course record, by anyone), 'mine' (your own best with
   the animal you are playing) or 'off'. Three rather than two because they are genuinely
   different sessions -- chasing a record you have never been near is discouraging when
   what you wanted was to beat yesterday's you, and vice versa. */
let ghostMode = 'best';
function getGhostMode(){ return ghostMode; }
function setGhostMode(m){
  ghostMode = (m === 'mine' || m === 'off') ? m : 'best';
  if(race.on) armGhost();
  renderCourseUI();
}

/* Who set the time. Two halves: a stable KEY that survives a rename and is what the
   scoreboard is filed under, and a human name for the card to print. rosterKey() already
   produces exactly the identity ensureAvatar rebuilds on, so a time is filed against the
   thing the player actually chose rather than against a species or a size. */
/* ELEVATION IN REAL METRES, whatever units the caller measures position in.

   rawGroundY is the UN-TERRACED height straight off the DEM, and both halves of that
   matter. Un-terraced, because the contour step is a drawing decision -- a trail does not
   gain a metre of climb because somebody moved a slider from 4 m bands to 2 m ones. And
   raw rather than terrainY, because terrainY multiplies by VERT_SCALE, which is the hill
   exaggeration: sampling that would report a different total ascent for the same hill at
   every setting of a control that exists purely to make the view nicer.

   Two samplers because the two things being measured store position differently -- a
   course in real metres, a trail route in world units -- and converting one to the other
   just to convert it back would be a rounding step for nothing. */
function courseElevAt(rx, rz){
  const k = getMapScale() || 1;
  return rawGroundY(rx*k, rz*k);
}
function worldElevAt(x, z){ return rawGroundY(x, z); }

/* "480 m · ↗120 m ↘95 m · +25 m" -- the three numbers that answer three different
   questions. Gain and loss are the CUMULATIVE climb and descent, which is what the legs
   feel; net is the plain end-to-end difference, which on a loop is zero however hard it
   was. Net is omitted when it is small enough to be noise, rather than printed as a
   confident "+1 m" the DEM cannot actually support. */
function fmtRelief(r){
  if(!r || !r.ok) return '';
  const bits = [];
  if(r.gain >= 1 || r.loss >= 1)
    bits.push('\u2197' + Math.round(r.gain) + ' m \u2198' + Math.round(r.loss) + ' m');
  if(Math.abs(r.net) >= 3)
    bits.push((r.net > 0 ? '+' : '\u2212') + Math.round(Math.abs(r.net)) + ' m net');
  return bits.join(' \u00b7 ');
}

function avatarName(){
  if(mode === 'dog') return dogChoice.label;
  return (SPECIES[wildKey] && SPECIES[wildKey].nm) || wildKey;
}

/* The trace as it stands, shaped like a saved course so the map can draw it with no
   special case (see minimap.js's setCourseShown). */
function liveCourse(){
  rec.live.name = rec.startName || 'Recording';
  rec.live.lenM = rec.lenM;
  return rec.live;
}

/* One place decides what the map and the ground are showing, because three things can each
   want the overlay (a live trace, a live race, a previewed course) and letting each set it
   directly is how you end up with a course line left on the map after the race that owned
   it ended. Priority is most-live-first. */
function syncCourseOverlay(){
  const c = race.on ? race.course : (rec.on ? liveCourse() : previewCourse);
  setCourseShown(c);
  setRaceFrac(race.on && !race.done ? race.frac : null);
  /* The GROUND ribbon is only for a course you are about to run over -- a race, or one
     you have asked to see so you can go and find its start. It is deliberately NOT drawn
     for the live trace: the trace is the ground behind you, which you can already see,
     and the strip has baked geometry that would have to be rebuilt from scratch every
     five metres for the whole length of a recording. The map disc still shows it, because
     that costs a polyline stroke. */
  if(c && playing && !rec.on) setCourseLine(c, standingY);
  else clearCourseLine();
}

function startRecording(){
  if(!getGraph() || race.on) return false;
  rec.on = true;
  rec.pts.length = 0;          // in place: rec.live holds this same array (see above)
  rec.lenM = 0;
  rec.full = false;
  rec.offT = 0;
  rec.startName = onTrail.name || '';
  recPending = null;
  showPane(null);             // you cannot walk a path with the sheet over the whole screen
  renderCourseUI();
  syncCourseOverlay();
  comicBurst('\u23fa Recording', player.x, standingY(player.x, player.z)+2.2, player.z, '#d94fa0');
  return true;
}

/* Stop, and hand the trace over to be named. A trace too short to be a course is dropped
   rather than offered: naming and saving a nine-metre stumble is worse than being told it
   did not take. */
function stopRecording(){
  if(!rec.on) return null;
  rec.on = false;
  const pts = rec.pts.slice();      // a copy, because the live array is about to be emptied
  const lenM = rec.lenM;
  rec.pts.length = 0;
  rec.lenM = 0;
  if(pts.length < 2 || lenM < COURSE_MIN_M){
    recPending = null;
    renderCourseUI();
    syncCourseOverlay();
    flashSpotNote('Too short to save \u2014 walk at least ' + COURSE_MIN_M + ' m on a trail');
    return null;
  }
  recPending = {pts, lenM, name: rec.startName ? rec.startName + ' run'
                                               : 'Course ' + (getCourses().length + 1)};
  showPane('map');            // the naming half of the control lives on the map pane
  renderCourseUI();
  syncCourseOverlay();
  return recPending;
}

function saveRecording(name){
  if(!recPending) return null;
  const c = addCourse(name == null ? recPending.name : name, recPending.pts);
  recPending = null;
  if(c){ previewCourse = c; cheerBlip(); showHereCourse(c); }
  renderCourseUI();
  syncCourseOverlay();
  return c;
}

function discardRecording(){
  recPending = null;
  renderCourseUI();
  syncCourseOverlay();
}

/* One frame of the trace. `nt` is the lookup the loop already did, passed in rather than
   re-hashed -- same arrangement as refreshOnTrail, and for the same reason.

   The snap threshold is the corridor's own half-width with a floor, which is the same test
   refreshOnTrail uses to decide the trail is underfoot. Using one rule for both means the
   trail named in the HUD chip is always the trail being recorded. */
function sampleRecording(nt, dt){
  if(!rec.on || rec.full) return;
  const k = getMapScale() || 1;
  /* The corridor's own half-width, or six real metres, whichever is wider. It was a flat
     3 world units, which is a different distance on every map: at 1:5 it let a walker
     fifteen metres off the trail be snapped onto whichever parallel path happened to be
     nearest, and near two parallel trails "nearest" flips back and forth. Expressed in
     real metres it means the same thing at every scale, and a walker who is genuinely
     beside the trail rather than on it now leaves a gap -- which is what the card on the
     map sheet has always said happens off-trail. */
  const snapMax = Math.max(nt.hw || 0, COURSE_SNAP_M*k);
  if(!nt.edge || nt.d > snapMax || nt.px == null){ rec.offT += dt; return; }
  const rx = nt.px/k, rz = nt.pz/k;                 // world units -> real metres
  const last = rec.pts[rec.pts.length-1];
  if(last){
    const step = Math.hypot(rx-last[0], rz-last[1]);
    // still inside the sampling interval: a normal on-trail frame, and the thing it
    // establishes is that we are NOT away from a trail (see the jump gate below)
    if(step < COURSE_STEP_M){ rec.offT = 0; return; }
    /* THE JUMP GATE. See courses.js on COURSE_JUMP_M: a step several times the sampling
       interval is the snap changing its mind about which of two parallel trails you are
       on, not a stride. Refused while we have been continuously on a trail, allowed once
       we have spent COURSE_REJOIN_S away from one -- which is the honest case of walking
       off the network and rejoining it somewhere else.

       `offT` grows on a refusal as well as on being off-trail, so a walker genuinely stuck
       between two trails is not refused forever: after the rejoin delay the recorder takes
       the point and carries on. It self-heals rather than silently stopping. */
    if(step > COURSE_JUMP_M && rec.offT < COURSE_REJOIN_S){ rec.offT += dt; return; }
    rec.lenM += step;
  }
  rec.offT = 0;
  rec.pts.push([rx, rz]);
  if(!rec.startName && nt.edge.name) rec.startName = nt.edge.name;
  if(rec.pts.length >= COURSE_MAX_PTS){
    // a cap, not a crash: stop growing and let the walker save what they have
    rec.full = true;
    stopRecording();
  }
}

/* --- the race itself --- */

function startRace(course){
  if(!course || !getGraph()) return false;
  if(rec.on){ flashSpotNote('Stop recording first'); return false; }
  const pts = coursePoints(course);
  if(pts.length < 2) return false;
  closeArrival();
  closeRaceCard();
  showPane(null);
  previewCourse = course;
  race.on = true; race.course = course; race.done = false;
  race.count = RACE_COUNT_SECS; race.go = 0; race.t = 0; race.frac = 0; race.off = 0;
  race.pip = -1; race.warned = false; race.offT = 0;
  /* At the start line, facing the way the course goes -- not facing wherever the walk left
     you. Standing on a start line pointed backwards would cost a second nobody chose to
     spend, on a clock that is the entire point of the mode. */
  placeAt(pts[0][0], pts[0][1], courseStartYaw(course));
  player.dist = 0;
  race.trail = [];
  race.trailT = 0;
  race.gap = null;
  race.ghostFrac = 0;
  armGhost();
  document.body.classList.add('racing');
  syncCourseOverlay();
  updateRaceHud();
  return true;
}

/* Pick up the track to chase, and build a body for it. Called at the start of a race and
   again whenever the mode changes mid-race, so switching from the record to your own best
   swaps the ghost rather than needing a restart. */
function armGhost(){
  race.ghost = (ghostMode === 'off' || !race.course)
    ? null : courseGhost(race.course, ghostMode, rosterKey());
  if(!race.ghost){ hideGhost(); return; }
  setGhostAvatar(race.ghost.key, dogParams());
}

/* Leave a race without finishing it. Nothing is banked -- a time only counts if you
   crossed the line, which is the only thing that makes the scoreboard mean anything. */
function quitRace(){
  if(!race.on) return;
  race.on = false; race.done = false; race.course = null;
  race.count = 0; race.go = 0; race.t = 0; race.frac = 0;
  race.pip = -1; race.warned = false; race.offT = 0;
  race.trail = []; race.trailT = 0; race.ghost = null; race.gap = null;
  hideGhost();
  document.body.classList.remove('racing');
  closeRaceCard();
  syncCourseOverlay();
  updateRaceHud();
}

function finishRace(){
  if(!race.on || race.done) return null;
  race.done = true;
  const secs = race.t;
  /* The track goes in with the time, so courses.js can keep the two together or drop
     both -- see recordCourseTime on why a ghost from an older run beside a newer best is
     worse than no ghost at all. */
  const res = recordCourseTime(race.course, rosterKey(), avatarName(), secs, race.trail);
  refreshHere();              // the scoreboard on the details card has just changed
  cheerBlip();
  showRaceCard(res, secs);
  return res;
}

/* One frame of a live race. Called from the loop AFTER movement, so the clock and the
   progress agree with where the runner actually ended the frame. */
function updateRace(dt){
  if(!race.on) return;
  if(race.count > 0){
    race.count -= dt;
    /* One pip per whole second, keyed to the number the HUD is SHOWING rather than to a
       separate timer, so the two can never disagree and a long frame cannot skip or
       double a pip. Tracking the last number pipped (instead of watching for a crossing)
       is also what gets the opening "3" -- there is no crossing into it. */
    const n = Math.max(0, Math.ceil(race.count));
    if(n !== race.pip){
      race.pip = n;
      if(n >= 1) countPip(n);
    }
    if(race.count <= 0){ race.count = 0; race.go = RACE_GO_SECS; goTone(); }
    updateRaceHud();
    return;
  }
  if(race.go > 0) race.go = Math.max(0, race.go - dt);
  if(race.done){ updateRaceHud(); return; }
  race.t += dt;
  sampleGhostTrail(dt);
  driveGhost(dt);
  const pts = coursePoints(race.course);
  const pr = courseProgress(pts, player.x, player.z, race.frac, courseLookFrac(race.course));
  if(pr){
    /* COURSE_ON_M is real metres; positions are world units, so it has to be compacted to
       compare against one. Getting this backwards is the same mistake the noise chip made
       in the other direction (see updateTrailHud) -- a tolerance that is a distance between
       two things in the world scales with the world, and one that is a property of an
       animal does not. */
    const onM = COURSE_ON_M*(getMapScale() || 1);
    if(pr.d <= onM){
      race.frac = Math.max(race.frac, pr.frac);
      /* Rejoining only speaks if you had strayed far enough to have been TOLD. Without
         that guard, brushing the edge of the tolerance would chime every time the
         distance wobbled across it. */
      if(race.warned) rejoinSound();
      race.warned = false;
      race.off = 0; race.offT = 0;
    }else{
      race.off = pr.d/(getMapScale() || 1);
      /* The nag, and the sound most able to become hateful: it can fire repeatedly at
         someone already lost and already annoyed. So it says it once on the way out, then
         waits a long OFF_REMIND_S before saying it again, and never escalates. A player
         who knows they are off the line does not need to be told faster. */
      race.offT -= dt;
      if(!race.warned || race.offT <= 0){
        offCourseSound();
        race.warned = true;
        race.offT = OFF_REMIND_S;
      }
    }
    setRaceFrac(race.frac);
  }
  if(courseFinished(race.course, race.frac)) finishRace();
  updateRaceHud();
}

/* One sample of the run being made, at the fixed GHOST_DT cadence courses.js stores. The
   cadence is the timestamp (see the ghost notes there), so this has to hold the interval
   exactly rather than sampling per frame: a track written at the frame rate would replay
   at the wrong speed on any machine that rendered it at a different one. */
function sampleGhostTrail(dt){
  race.trailT += dt;
  if(race.trail.length >= GHOST_MAX) return;      // five minutes; a cap, not a failure
  const want = Math.floor(race.trailT/GHOST_DT) + 1;
  if(race.trail.length >= want) return;
  const k = getMapScale() || 1;
  while(race.trail.length < want && race.trail.length < GHOST_MAX)
    race.trail.push([player.x/k, player.z/k]);    // real metres, as always
}

/* Put the ghost where the record-holder was at this point in THEIR run, and work out who
   is ahead. The gap is measured in DISTANCE ALONG THE COURSE converted back to a time, not
   as a straight line between the two bodies: on a switchback the record-holder can be
   thirty metres away and a second behind, and a straight-line gap would call that a huge
   lead in whichever direction the geometry happened to point. */
function driveGhost(dt){
  if(!race.ghost){ hideGhost(); race.gap = null; return; }
  const at = ghostAt(race.ghost, race.t);
  if(!at){
    // the ghost has finished; stop drawing it rather than parking it on the line, where it
    // would look like it was waiting for you
    hideGhost();
    race.gap = race.t - race.ghost.t;
    return;
  }
  const k = getMapScale() || 1;
  const gx = at[0]*k, gz = at[1]*k;
  const prev = ghostAt(race.ghost, Math.max(0, race.t - dt));
  let yaw = 0, speed = 0;
  if(prev){
    const dx = gx - prev[0]*k, dz = gz - prev[1]*k;
    const L = Math.hypot(dx, dz);
    if(L > 1e-4) yaw = Math.atan2(-dz, dx);
    speed = dt > 0 ? L/dt : 0;
  }
  placeGhost(gx, gz, standingY(gx, gz), yaw, speed, dt);

  const pts = coursePoints(race.course);
  const gp = courseProgress(pts, gx, gz, race.ghostFrac, courseLookFrac(race.course));
  if(gp) race.ghostFrac = Math.max(race.ghostFrac, gp.frac);
  /* Lead in seconds, from the fraction of the course between the two of you and the pace
     the record was run at. Positive means the ghost is ahead. */
  race.gap = (race.ghostFrac - race.frac)*race.ghost.t;
}

/* Input is frozen for the countdown and for nothing else. Being unable to move while a
   summary card is up is trip.paused's job; this is the three seconds before the clock
   starts, which is a different thing and has to leave the rest of the frame running. */
function raceFrozen(){ return race.on && race.count > 0; }

function isRaceCardOpen(){ return document.body.classList.contains('racedone'); }

function showRaceCard(res, secs){
  const c = race.course;
  trip.paused = true;
  document.body.classList.add('racedone');
  const set = (id, v)=>{ const el=$(id); if(el) el.textContent=v; };
  const mine = res && res.improved;
  const rec_ = res && res.overallImproved;
  set('#raceCardTitle', rec_ ? '\ud83c\udfc6 Course record!' : (mine ? '\u2b50 Your best yet!' : '\ud83c\udfc1 Finished!'));
  const rel = c ? fmtRelief(courseRelief(c, courseElevAt)) : '';
  set('#raceCardSub', c ? c.name + ' \u2014 ' + fmtCourseLen(courseLengthM(c)) +
      (rel ? ' \u00b7 ' + rel : '') : '');
  set('#raceCardTime', fmtRaceTime(secs));
  set('#raceCardWho', avatarName());
  const prev = res && res.prevMine;
  set('#raceCardDelta', prev == null ? 'first run with ' + avatarName()
      : (secs < prev ? '\u2212' + fmtRaceTime(prev-secs) + ' on your best'
                     : '+' + fmtRaceTime(secs-prev) + ' off your best (' + fmtRaceTime(prev) + ')'));
  const board = $('#raceBoard');
  if(board){
    board.innerHTML = '';
    const rows = c ? courseTimes(c) : [];
    if(!rows.length){
      const n=document.createElement('div'); n.className='none';
      n.textContent = 'No times on this course yet.';
      board.appendChild(n);
    } else rows.forEach((r, i)=>{
      const el=document.createElement('div');
      el.className='arr-row' + (r.key===rosterKey() ? ' me' : '');
      el.innerHTML = '<span></span><span></span><span class="n"></span>';
      el.children[0].textContent = i===0 ? '\ud83c\udfc6' : (r.key.startsWith('wild:') ? '\ud83e\udd8a' : '\ud83d\udc15');
      el.children[1].textContent = r.name;
      el.children[2].textContent = fmtRaceTime(r.t);
      board.appendChild(el);
    });
  }
}

function closeRaceCard(){
  if(!isRaceCardOpen()) return;
  document.body.classList.remove('racedone');
  trip.paused = false;
  race.on = false; race.done = false;
  document.body.classList.remove('racing');
  syncCourseOverlay();
  updateRaceHud();
}

/* --- the two readouts a race needs while it is running --- */
function updateRaceHud(){
  const hud = $('#raceHud'), cd = $('#raceCount');
  if(cd){
    const on = race.on && (race.count > 0 || race.go > 0);
    cd.classList.toggle('on', !!on);
    if(on) cd.textContent = race.count > 0 ? String(Math.ceil(race.count)) : 'GO!';
  }
  if(!hud) return;
  hud.classList.toggle('on', !!race.on);
  if(!race.on) return;
  const c = race.course;
  const set = (id, v)=>{ const el=$(id); if(el) el.textContent=v; };
  set('#raceName', c ? c.name : '');
  set('#raceClock', race.count > 0 ? '\u2014' : fmtRaceTime(race.t));
  set('#raceProg', Math.round(race.frac*100) + '%');
  const best = c ? courseBestOverall(c) : null;
  const mine = c ? courseBestFor(c, rosterKey()) : null;
  set('#raceBest', best ? '\ud83c\udfc6 ' + fmtRaceTime(best.t) + ' \u00b7 ' + best.name : 'no time yet');
  set('#raceMine', mine ? '\u2b50 ' + fmtRaceTime(mine.t) : '\u2b50 \u2014');
  const gapEl = $('#raceGap');
  if(gapEl){
    const g = race.gap;
    /* SHOWN EVEN WHEN THERE IS NO GHOST, which is the point. A ghost only exists once
       somebody has completed a run, so the first race on any course has none -- and the
       first version of this hid the row entirely in that case, which left a player who had
       just switched the ghost on staring at a screen with no ghost and nothing at all
       saying why. An empty row that explains itself is worth more than a tidy one. */
    const want = ghostMode !== 'off';
    gapEl.classList.toggle('on', want);
    gapEl.classList.toggle('ahead', !!race.ghost && g != null && g > 0);
    gapEl.classList.toggle('behind', !!race.ghost && g != null && g < 0);
    gapEl.classList.toggle('none', want && !race.ghost);
    if(!want) gapEl.textContent = '';
    else if(!race.ghost) gapEl.textContent = ghostMode === 'mine'
      ? '\ud83d\udc7b no run of yours to chase yet'
      : '\ud83d\udc7b no ghost yet \u2014 finish this run to set one';
    else gapEl.textContent = g == null ? '\ud83d\udc7b \u2014'
      : '\ud83d\udc7b ' + (g > 0 ? '\u2212' : '+') + fmtRaceTime(Math.abs(g)) +
        ' \u00b7 ' + race.ghost.name + ' ' + fmtRaceTime(race.ghost.t);
  }
  const off = $('#raceOff');
  if(off) off.classList.toggle('on', race.off > COURSE_ON_M);
}

/* --- the map sheet's course card, and the recording chip on the HUD --- */
function renderCourseUI(){
  const startBtn = $('#recStartBtn');
  if(startBtn){
    startBtn.textContent = rec.on ? '\u23f9 Stop recording' : '\u23fa Record a path';
    startBtn.classList.toggle('primary', rec.on);
    startBtn.disabled = !!race.on;
  }
  const saveRow = $('#recSaveRow');
  if(saveRow) saveRow.classList.toggle('on', !!recPending);
  const nameInput = $('#recName');
  if(nameInput && recPending && nameInput.value !== recPending.name && !nameInput.dataset.touched)
    nameInput.value = recPending.name;
  if(nameInput && !recPending) nameInput.dataset.touched = '';
  const note = $('#recNote');
  if(note){
    note.textContent = rec.on
      ? 'Recording \u2014 walk the trails you want in the course, then stop.'
      : (recPending ? 'Name it and save, or discard.'
                    : 'Recording snaps to whatever trail you are on. Off-trail stretches are skipped.');
  }
  const gm = $('#ghostMode');
  if(gm) for(const b of gm.querySelectorAll('button'))
    b.classList.toggle('on', b.dataset.ghost === ghostMode);
  updateRecChip();
  renderCourseList();
}

/* The only part of the recording UI that changes while you walk, split out because the
   rest of it is a dozen rows of DOM and rebuilding those sixty times a second would both
   waste the frame and blow away the caret in the name field every time it was rendered. */
function updateRecChip(){
  const chip = $('#recHud');
  if(chip) chip.classList.toggle('on', !!rec.on);
  if(!rec.on) return;
  const stat = $('#recStat');
  if(stat) stat.textContent = fmtCourseLen(rec.lenM) + ' \u00b7 ' + rec.pts.length + ' pts' +
    (rec.offT > 1.5 ? ' \u00b7 off trail' : '');
}

/* Courses as rows, mirroring the saved-pins list beside them: badge, name, the two times
   that matter (the record, and yours with whoever you are playing as) and the one control
   that is the whole point of a course -- race it. Tapping the NAME shows it on the map
   without racing, because "where does that one go" is a question you ask before you commit
   to running it. */
function renderCourseList(){
  const list = $('#courseList');
  if(!list) return;
  const courses = getCourses();
  list.innerHTML = '';
  if(!courses.length){
    const n=document.createElement('div'); n.className='none';
    n.textContent = 'No courses yet \u2014 tap Record a path and walk one.';
    list.appendChild(n);
    return;
  }
  courses.forEach((c, i)=>{
    const row=document.createElement('div');
    row.className='course-row' + (previewCourse && previewCourse.id===c.id ? ' shown' : '');
    row.innerHTML =
      '<span class="cs-badge"></span>' +
      '<button class="cs-name"></button>' +
      '<button class="cs-go" title="Race this course">\ud83c\udfc1</button>' +
      '<button class="cs-x" title="Forget this course">\u2715</button>' +
      '<div class="cs-best"></div>';
    row.querySelector('.cs-badge').textContent = String(i+1);
    row.querySelector('.cs-name').textContent = c.name + ' \u00b7 ' + fmtCourseLen(courseLengthM(c));
    const rel = fmtRelief(courseRelief(c, courseElevAt));
    if(rel) row.querySelector('.cs-name').textContent += ' \u00b7 ' + rel;
    const best = courseBestOverall(c), mine = courseBestFor(c, rosterKey());
    row.querySelector('.cs-best').textContent =
      (best ? '\ud83c\udfc6 ' + fmtRaceTime(best.t) + ' \u00b7 ' + best.name : '\ud83c\udfc6 no time yet') +
      '   ' + (mine ? '\u2b50 ' + fmtRaceTime(mine.t) : '\u2b50 ' + avatarName() + ': \u2014');
    /* Tapping the name LOADS it into the details card and puts it on the map, rather than
       only toggling the line. Showing a course without telling you anything about it made
       the length and climb beside the name the only stats a course had, which is a poor
       return for having measured them. */
    row.querySelector('.cs-name').addEventListener('click', ()=>{
      previewCourse = c;
      showHereCourse(c);
      renderCourseList();
      syncCourseOverlay();
    });
    row.querySelector('.cs-go').addEventListener('click', ()=> startRace(c));
    row.querySelector('.cs-x').addEventListener('click', ()=>{
      if(previewCourse && previewCourse.id===c.id) previewCourse = null;
      if(race.on && race.course && race.course.id===c.id) quitRace();
      removeCourse(c.id);
      refreshHere();          // the card may have been describing exactly this course
      renderCourseUI();
      syncCourseOverlay();
    });
    list.appendChild(row);
  });
}

function toggleCourseShown(c){
  previewCourse = (previewCourse && previewCourse.id === c.id) ? null : c;
  renderCourseList();
  syncCourseOverlay();
}

/* Re-seat the player after the world has been rebuilt underneath them.

   The panel is a live settings drawer now, so contour step, hill exaggeration, landscape
   and world scale can all be moved MID-WALK -- and every one of them throws the scene
   away and builds a new one. The old handlers all ended with placeAtHead(), which was
   right in a lobby and completely wrong while walking: change the fog-free contour step
   two kilometres out and you were teleported back to the car park with your odometer
   zeroed.

   World scale is the one that needs real arithmetic rather than "stay put". It compacts
   POSITIONS, so the same rock is at a different world coordinate before and after -- the
   player has to move with it or they end up somewhere else entirely on the map. `ratio`
   is newScale/oldScale; multiplying position and odometer by it holds both the place and
   the distance walked constant in REAL terms, which is what the HUD is reporting. */
function afterWorldChange(ratio){
  if(!playing){ placeAtHead(getStartHead()); return; }
  const k = (ratio && isFinite(ratio) && ratio > 0) ? ratio : 1;
  player.x *= k; player.z *= k; player.dist *= k;
  const bb=getBBox(), F=55;
  player.x=clamp(player.x, bb.minx-F, bb.maxx+F);
  player.z=clamp(player.z, bb.minz-F, bb.maxz+F);
  player.y=0; player.vy=0; player.speed=0; player.wall=null; player.regrabT=0;
  ensureAvatar();
  const groundY = syncAvatar(0,0,0,0,player.sneaking,false,false);
  snapChaseCam(player.x, player.z, groundY, getVertScale(), 13);
  refreshOnTrail();
  trip.parked = -1;
  /* The ribbon was draped onto ground that no longer exists, and world scale has moved the
     course points as well. Everything else on the map is derived per frame; this is the one
     overlay with baked geometry, so it is the one that has to be told. */
  refreshCourseLine();
  /* Relief is cached per course (courses.js), and the ground it was measured against has
     just been rebuilt. Contour step and exaggeration do not move rawGroundY, but loading a
     different bundle does, and this is the one call that knows either happened. */
  bumpRelief();
  renderStartPicker();
}

/* ---------- off-trail movement ----------

   On the tread, movement is unconstrained (see the loop). Off it, it is physical, and the
   rule comes straight out of the terracing: ONE terrace riser is a step you can walk up,
   anything taller is a wall you have to jump. Tying the limit to the contour step rather
   than to a tuned constant is what makes the landscape readable -- the bands are the only
   vertical quantum this world has, so if you can see two of them between you and a ledge
   you already know the walk won't do it.

   `player.y` is height ABOVE the ground beneath the player, NOT an absolute altitude.
   Every comparison here therefore converts to absolute feet height (ground + y) and back
   again; getting that backwards is what makes an avatar sink through hillsides. */
function stepUpLimit(){
  // one riser, plus a hair, so a step exactly one band tall is never a coin flip
  return getContourStep()*getVertScale()*1.05;
}

/* ---- wall jumping ------------------------------------------------------------------

   `player.wall` is a CLING: a point on a solid's outline, the outward normal there, and
   nothing else -- height lives in player.y as it does everywhere else, so gravity, the
   avatar and the camera all keep working without knowing a wall exists.

   THE PUP HANGS VERTICALLY. That is a real requirement and not decoration: with the body
   left in its walking orientation the pup sticks out of the rock like a shelf, nose-first,
   which is what the reported screenshot showed. On a wall it is pitched nose-up with its
   belly to the stone, so it reads as an animal holding on rather than one embedded in
   masonry. The pitch is applied through gait.js's wall pose; the yaw here turns the pup to
   FACE the rock so the pitch tips it up the face rather than sideways along it. */
/* Which way the pup faces while clinging. The rig's forward is +x and yaw maps a world
   direction through atan2(-dz, dx), so this points forward at the INWARD normal -- the pup
   faces the rock.

   That matters because of how the wall pitch works. Pitched ~76 degrees nose-up, the legs
   swing to point along the body's backward axis, which is the opposite of forward. Facing
   the pup AWAY from the rock therefore drove its legs straight INTO the stone -- reported
   as the dog positioned backwards with its legs sticking through the formation, and
   measured as forward pointing along the outward normal with a dot of exactly 1. Turning
   it to face the rock puts the legs and paws on the outside, where they can be seen. */
function wallYaw(f){ return Math.atan2(f.oz, -f.ox); }

function wallFaceAt(x, z, dist){
  const f = nearestSolidFace(x, z, dist);
  if(!f) return null;
  const base = standingY(f.x + f.ox*WALL_STANDOFF, f.z + f.oz*WALL_STANDOFF);
  // a kerb is not a wall; anything you could step onto is not worth catching in mid-air
  return (f.top - base > stepUpLimit()) ? {f, base, top: f.top} : null;
}

/* Catch a wall in mid-air. Airborne only -- on the ground you walk, and a grab that fired
   while standing would glue the pup to every rock it brushed past. */
function tryWallCatch(dirX, dirZ){
  if(player.wall || player.knockT > 0) return false;
  if(player.y <= 0.05 && player.vy <= 0) return false;
  if(player.regrabT > 0) return false;
  const L = Math.hypot(dirX, dirZ);
  const lookX = L > 1e-6 ? dirX/L : 0, lookZ = L > 1e-6 ? dirZ/L : 0;
  const hit = wallFaceAt(player.x + lookX*0.4, player.z + lookZ*0.4, WALL_GRAB_DIST);
  if(!hit) return false;
  /* HIGH ENOUGH TO BE WORTH CATCHING. Without this, jumping while stood next to a
     formation caught the face at almost zero height -- and a cling that low slides to the
     ground within a few frames and releases, so the jump was swallowed and the pup ended
     up pinned to the bottom edge of the rock unable to get off the floor. That is the
     reported "we try to jump and immediately get stuck at the bottom edge".

     Measured from the face's own base rather than from player.y, because player.y is
     height above whatever is underfoot and that is not the same datum once the terrain
     around a formation slopes. */
  const groundHere = standingY(player.x, player.z);
  if(groundHere + player.y < hit.base + WALL_MIN_CATCH) return false;
  /* Moving INTO the rock. On a ballistic arc the horizontal direction is whatever the
     player steered, so this is the one thing they control in the air and the one thing
     worth testing. With no input at all, catching is still allowed if the face is right
     there -- falling onto a wall you are already touching should stick. */
  if(L > 1e-6){
    const dot = (lookX*-hit.f.ox + lookZ*-hit.f.oz);
    if(dot <= WALL_GRAB_DOT) return false;
  }
  player.wall = {
    fx: hit.f.x, fz: hit.f.z, ox: hit.f.ox, oz: hit.f.oz,
    base: hit.base, top: hit.top,
    slide: 0, clingT: 0,
  };
  player.vy = 0;
  // snap onto the face, keeping whatever height the leap earned
  player.x = hit.f.x + hit.f.ox*WALL_STANDOFF;
  player.z = hit.f.z + hit.f.oz*WALL_STANDOFF;
  player.yaw = wallYaw(hit.f);
  thudSound();
  return true;
}

/* Push off. Up and out, so the next catch has to be aimed rather than held. */
function wallJump(){
  const w = player.wall;
  if(!w) return false;
  player.wall = null;
  player.vy = WALL_JUMP_VY;
  player.regrabT = WALL_REGRAB_DELAY;
  player.x += w.ox*0.35;
  player.z += w.oz*0.35;
  player.kvx = w.ox*WALL_JUMP_OUT;
  player.kvz = w.oz*WALL_JUMP_OUT;
  player.climbT = CLIMB_DUR;
  player.climbAmt = 1;
  return true;
}

function letGoWall(){ player.wall = null; }

/* One frame of clinging. Returns true while the wall owns the frame. */
function updateWall(dt){
  const w = player.wall;
  if(!w) return false;
  w.clingT += dt;
  // paws give out: the slide accelerates, then you are off entirely
  w.slide = Math.min(WALL_SLIDE_MAX, w.slide + WALL_SLIDE_ACCEL*dt);
  player.y -= w.slide*dt;

  const groundHere = standingY(player.x, player.z);
  const climbedTo = groundHere + player.y;

  if(climbedTo >= w.top - 0.15){
    /* Over the lip. Probe INWARD until areaSolidTop actually answers with this rock's top,
       rather than trusting a fixed inset -- on a thin fin a fixed step lands on terrain
       below the slab, and solidEmbed then ejects the pup off the rock it just climbed. */
    for(const inset of [0.9, 1.4, 2.1, 3.0, 4.2]){
      const inx = w.fx - w.ox*(WALL_STANDOFF + inset);
      const inz = w.fz - w.oz*(WALL_STANDOFF + inset);
      const top = areaSolidTop(inx, inz);
      if(top != null && Math.abs(top - w.top) < 0.5){
        player.wall = null;
        player.x = inx; player.z = inz;
        player.y = 0; player.vy = 0;
        player.climbT = CLIMB_DUR;
        player.climbAmt = 1;
        cheerBlip();
        return true;
      }
    }
  }

  if(player.y <= 0.02 || w.clingT > WALL_CLING_MAX){
    player.wall = null;
    player.y = Math.max(0, player.y);
    return true;
  }

  player.x = w.fx + w.ox*WALL_STANDOFF;
  player.z = w.fz + w.oz*WALL_STANDOFF;
  player.yaw = wallYaw(w);
  /* The pose that stands the pup up. climbAmt drives gait.js's wall pose, which pitches
     the body nose-up against the stone -- see the note there on why this is a pitch and
     not a yaw. */
  player.climbT = Math.max(player.climbT, CLIMB_DUR);
  player.climbAmt = 1;
  return true;
}

/* THE ground height for the player: terrain, or the top of a solid area when one stands
   here. One function, used by movement, by the avatar and by the shadow, for exactly the
   reason the README gives about standingY -- when two consumers each answered "what am I
   standing on" their own way, the pup sank into the tread. The same trap is available here
   in a new place: an avatar drawn on terrain height while movement thought it was on a
   rock is a pup standing inside a boulder.

   This is also the whole of what makes a rock formation stand-on-able rather than a trap.
   Nothing below needed a new rule: the step-up limit already turns a tall face into a
   wall, `airborneOver` already lets a jump land on a ledge, preserving absolute height
   already turns walking off an edge into a fall, and the gravity clamp already puts
   anything that finds itself inside a footprint on top of it rather than in it. */
function playerGroundY(x, z){
  const g = standingY(x, z);
  const top = areaSolidTop(x, z);
  return (top != null && top > g) ? top : g;
}

function moveOffTrail(stepX, stepZ){
  const lim = stepUpLimit();
  const gHere = playerGroundY(player.x, player.z);
  const feet = gHere + player.y;
  const tryMove = (dx, dz)=>{
    if(!dx && !dz) return false;
    const nx=player.x+dx, nz=player.z+dz;
    const gThere = playerGroundY(nx, nz);
    const rise = gThere - gHere;
    // walkable if it is at most a single step up, or if we are already airborne high
    // enough to clear it -- which is precisely what makes jumping the answer to a ledge
    const airborneOver = feet >= gThere - 0.05;
    /* Plain terrain rules, unchanged. A rock face is a wall to WALKING and always was --
       getting on top of one is the wall jump's job now (see tryWallCatch), not something
       the movement step should be talked into. An earlier version let a step-up mount a
       solid directly, which is what produced a pup teleporting to the summit. */
    if(rise > lim && !airborneOver) return false;
    /* A step-up done ON FOOT costs speed and triggers the scramble. Clearing the same
       rise while airborne does neither -- the jump already paid for it, and taxing it
       twice would make jumping strictly worse than walking, which inverts the whole
       point of having a jump. `player.y <= 0.02` is the test for "on the ground": being
       mid-jump is exactly the case we are exempting. */
    if(rise > lim*0.25 && player.y <= 0.02){
      player.climbT = CLIMB_DUR;
      player.climbAmt = clamp(rise/Math.max(1e-4, lim), 0.35, 1);
    }
    player.x=nx; player.z=nz;
    /* Preserve ABSOLUTE height across the move and let the loop's gravity do the rest.
       Walking off a ledge thus leaves the pup briefly airborne with a positive `y` and it
       falls, instead of the old behaviour -- which re-read the ground every frame and
       slid the avatar down the cliff face as though it were a ramp. Stepping UP resolves
       to y=0 on the same frame, so a kerb stays a step rather than becoming a launch. */
    /* Terrain keeps the plain clamp: a kerb resolves to a step on the same frame, and
       walking off a ledge leaves a positive `y` so the pup falls. Solids no longer take
       a shortcut through here at all -- mounting one is a CLIMB now, owned by
       startClimb/updateClimb below, because it needs a face to hang on and an input to
       drive it and neither of those is a thing a movement step can express. */
    player.y = Math.max(0, feet - gThere);
    return true;
  };
  // Try the full move, then each axis alone, so a glancing approach to a bank slides
  // along it instead of stopping dead against it.
  if(tryMove(stepX, stepZ)) return;
  if(tryMove(stepX, 0)) return;
  tryMove(0, stepZ);
}

/* The one place that decides HOW a step is taken. Extracted from the loop so the rule
   is testable on its own -- while it lived inline, a test could only reach moveOffTrail,
   which is the branch, not the decision, and would have passed just as happily against
   the bug this exists to prevent. */
function movePlayer(stepX, stepZ){
  const nt = nearestTrail(player.x, player.z);
  /* `inCorridor` -- is the tread actually underfoot? This is the ONLY thing that may
     bypass the step-up rule, and it uses the corridor's own half-width, the same measure
     standingY uses to decide you are standing on the tread at all.

     It used to be `nt.d < 1.5`, a soft "near a trail" band that also drives the walking
     speed bonus. A narrow trail's half-width is 0.55 m, so everything from 0.55 to 1.5 m
     counted as on-trail and skipped the step check -- including when the trail ran along
     a clifftop and you stood at the bottom. One step in and standingY hauled you up the
     whole cliff. On the default map there are over a thousand such approaches, the worst
     a 9 m wall. Granting free vertical movement was never what proximity meant. */
  const inCorridor = nt.d <= nt.hw;
  if(inCorridor &&
     Math.abs(playerGroundY(player.x+stepX, player.z+stepZ) - playerGroundY(player.x, player.z)) <= stepUpLimit()){
    /* On the tread, movement stays frictionless: the graded corridor is a continuous,
       walkable bench by construction (terrain.js's gradeProfile), so there is nothing to
       climb, and preserving absolute height on the way down would turn every graded
       descent ramp into a series of little falls.

       The height guard covers the 0.15% of corridor where grading did not fully win (a
       terrace riser surviving right at the lip): there, fall through to the physical path
       rather than gliding up a wall just because a tread is nominally underfoot. */
    player.x+=stepX; player.z+=stepZ;
    return 'glide';
  }
  moveOffTrail(stepX, stepZ);
  return 'physical';
}

/* ---------- input: trail-owned, not core/input.js (that module is wired directly to
   Pup City's player-state/modes/pickups -- creator has its own for the same reason) --- */
const trailKeys = {};
addEventListener('keydown', e=>{
  trailKeys[e.code]=true;
  /* Both panes are reachable by key in BOTH states, so both keys are handled before the
     play gate. M used to sit inside it, which meant the map -- the one thing that can get
     you out of a lobby you are stuck in because the world failed to load -- was the only
     pane you could not open from there. preventDefault on Tab always, or the browser
     moves focus into the drawer behind it. */
  if(e.code==='Tab'){ e.preventDefault(); togglePane('settings'); return; }
  if(e.code==='KeyM'){ togglePane('map'); return; }
  /* Esc unwinds one layer at a time, outermost first, and the drawer is the outermost
     layer there is -- so this runs before the play gate too. Quitting a whole walk
     because you wanted to put the map away is the kind of thing you only forgive once. */
  if(e.code==='Escape' && getPane()){ showPane(null); return; }
  if(!playing) return;
  // while the arrival card is up only Escape does anything -- barking or jumping through
  // a summary screen you can't see the effect of is just confusing
  if(trip.paused){
    if(e.code==='Escape'){ if(isRaceCardOpen()) closeRaceCard(); else closeArrival(); }
    return;
  }
  if(e.code==='Space'){ e.preventDefault(); trailJump(); }
  if(e.code==='KeyC') toggleSneak();
  if(e.code==='KeyB') doBark();
  if(e.code==='KeyP') saveHere();
  /* The drawer was already dealt with above; what is left is the rest of the stack.
     Abandoning a walk because you wanted to abandon a race is the same mistake the map
     used to make, one level in. */
  if(e.code==='Escape'){
    if(race.on) quitRace();
    else exitPlay();
  }
});
addEventListener('keyup', e=> trailKeys[e.code]=false);

/* Pointer input, and it is NOT the same deal for a mouse as for a thumb.

   The twin-stick split -- drag the left half to walk, the right half to look -- is the
   right answer on a phone, where there is no keyboard and both jobs need a finger. On a
   desktop it is actively wrong: WASD already walks, so the only thing the mouse is needed
   for is the camera, and dedicating half the window to a virtual joystick means every
   drag that happens to start left of centre yanks the pup somewhere instead of turning
   the view. Which half of the screen the cursor happens to be over is not a decision the
   player made.

   So the split is decided by pointerType, not by geometry. A mouse looks, wherever it is
   pressed. Touch and pen keep the two zones, because there the keyboard is not an option.
   `stick` is left untouched by mouse input entirely rather than merely ignored, so a
   device with both (a laptop with a touchscreen) gets the right behaviour from each. */
const stick = {active:false,id:null,dx:0,dy:0,ox:0,oy:0};
const look  = {active:false,id:null,lastX:0,lastY:0};
const YAW_SENS=0.0055, PITCH_SENS=0.0042;
const STICK_MAX=52;                     // px of thumb travel that means "full speed"

/* THE TOUCH LAYER, and why it is a body class rather than a media query.

   `pointer: coarse` alone is answered at page load and never revisited, which gets a
   laptop-with-a-touchscreen wrong in both directions: it hides the stick from someone
   using the screen, or shows it to someone using the trackpad. So the class is set for a
   coarse-pointer device up front (every iPhone, iPad and Android tablet) AND on the first
   touch that actually arrives. Nothing removes it: a device that has been touched once
   keeps the controls, because the alternative is a joystick that blinks out mid-walk.

   The controls it reveals are not new inputs -- the left-half drag-stick has always been
   there. What was missing is that nothing on screen said so, and that jump (space) and
   sneak (C) had no touch equivalent at all, so on an iPad two of the four verbs were
   simply unreachable. */
function markTouchDevice(){
  if(document.body && !document.body.classList.contains('touch')) document.body.classList.add('touch');
}
if(typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches) markTouchDevice();
/* Anything that is not explicitly a finger or a stylus is treated as a mouse, including
   an empty pointerType -- an unknown device on a desktop-shaped page is far likelier to
   be a mouse than a thumb, and guessing wrong that way costs a look-drag rather than an
   unwanted sprint into a canyon. */
function isTouchPointer(e){ return e.pointerType === 'touch' || e.pointerType === 'pen'; }

/* The visible stick is a READOUT of `stick`, not a second source of truth -- it is
   painted from the same numbers movement reads, so it can never show one thing while the
   pup does another. It is also pointer-events:none in CSS, so drawing it under the thumb
   cannot swallow the very drag it is drawing. */
const stickBase=$('#stickBase'), stickKnob=$('#stickKnob');
/* THE FIXED PAD CENTRE. Read from the resting element itself rather than copying its CSS
   position into a JS constant, so the two can never drift apart -- a future redesign or a
   safe-area-inset change moves this along with it. Read fresh on every grab instead of
   cached once, since the pad's on-screen spot changes across a rotate or resize between
   walks. stickBase itself never moves any more (see paintStick), so this is always the
   pad's true resting centre, active or not. */
function stickHome(){
  const r = stickBase.getBoundingClientRect();
  return {x: r.left + r.width/2, y: r.top + r.height/2};
}
/* Thumb position, relative to a fixed origin, clamped to the travel radius. Shared by the
   grab (pointerdown) and the drag (pointermove) so a touch that lands away from the pad
   reads exactly the same direction whichever handler asks -- there is only one formula for
   "how hard and which way", not a start-at-zero one and a follow-up one that could disagree. */
function stickVectorFrom(cx, cy){
  let dx=cx-stick.ox, dy=cy-stick.oy;
  const L=Math.hypot(dx,dy), max=STICK_MAX;
  if(L>max){dx*=max/L; dy*=max/L;}
  return {dx: dx/max, dy: dy/max};
}
function paintStick(){
  if(!stickBase) return;
  // The pad is fixed at its CSS resting spot always -- nothing to position here any more,
  // only the knob (below) and the state classes move.
  const mag = stick.active ? Math.hypot(stick.dx, stick.dy) : 0;
  stickBase.classList.toggle('on', stick.active);
  stickBase.classList.toggle('run', mag>0.92 && !player.sneaking);
  stickBase.classList.toggle('sneak', !!player.sneaking);
  if(stickKnob) stickKnob.style.transform = stick.active
    ? `translate(${(stick.dx*STICK_MAX).toFixed(1)}px, ${(stick.dy*STICK_MAX).toFixed(1)}px)`
    : 'translate(0px, 0px)';
}

renderer.domElement.addEventListener('pointerdown', e=>{
  if(isTouchPointer(e)) markTouchDevice();
  if(!playing) return;
  if(!isTouchPointer(e)){
    // mouse: camera only, from anywhere on the canvas
    if(!look.active){
      look.active=true; look.id=e.pointerId; look.lastX=e.clientX; look.lastY=e.clientY;
    }
    return;
  }
  const rect=renderer.domElement.getBoundingClientRect();
  const rightHalf = (e.clientX-rect.left) > rect.width*0.5;
  if(rightHalf && !look.active){
    look.active=true; look.id=e.pointerId; look.lastX=e.clientX; look.lastY=e.clientY;
  }else if(!rightHalf && !stick.active){
    // Grabbing the stick no longer means "the pad appears here" -- the origin is the
    // fixed pad centre, and a touch that lands away from it reads as an immediate
    // deflection in that direction rather than starting at zero. Touching anywhere on
    // the left half still grabs it; only the pad's own position stopped moving.
    stick.active=true; stick.id=e.pointerId;
    const home = stickHome();
    stick.ox = home.x; stick.oy = home.y;
    const v = stickVectorFrom(e.clientX, e.clientY);
    stick.dx = v.dx; stick.dy = v.dy;
    paintStick();
  }
});
addEventListener('pointermove', e=>{
  if(stick.active && e.pointerId===stick.id){
    const v = stickVectorFrom(e.clientX, e.clientY);
    stick.dx=v.dx; stick.dy=v.dy;
    paintStick();
  }else if(look.active && e.pointerId===look.id){
    const dx=e.clientX-look.lastX, dy=e.clientY-look.lastY;
    look.lastX=e.clientX; look.lastY=e.clientY;
    addCamYaw(-dx*YAW_SENS);
    addCamPitch(-dy*PITCH_SENS);
    lastLookT = performance.now();
  }
});
const endPointer=e=>{
  if(stick.active&&e.pointerId===stick.id){ stick.active=false; stick.dx=stick.dy=0; paintStick(); }
  if(look.active&&e.pointerId===look.id){ look.active=false; }
};
addEventListener('pointerup', endPointer); addEventListener('pointercancel', endPointer);

/* ---------- the two verbs a touchscreen had no way to reach ----------
   Both go through the same functions the keys do rather than poking `player` from the
   button handler, so space and JUMP can never drift apart -- and both are gated on the
   walk being live, since jumping through the arrival summary does nothing visible and
   leaves you airborne when it closes. */
/* Jump is now three verbs wearing one button, and the order below is the whole rule:
   carrying beats catching, catching beats plain jumping, and you always leave the ground
   either way.

   ONE BUTTON, NOT THREE. A grab key and a release key would be two more things to teach
   on a device with no keyboard, and they would be pressed in exactly the situations jump
   already covers -- you are standing next to something small, or you have something on
   your back. Overloading the key the player is already holding down means the mechanic
   costs no new vocabulary at all. It is unambiguous because the three cases cannot
   overlap: you either have a passenger or you do not, and if you do not, something is
   either in reach or it is not.

   The jump still happens in every case. Making the grab consume the press would mean the
   pup sometimes refuses to jump for reasons the player cannot see -- a small animal they
   had not noticed standing just inside the ring -- and an input that silently does
   something else is worse than one that does two things at once. */
function trailJump(){
  if(!playing || trip.paused || player.knockT > 0) return;
  /* On a face, jump means LET GO -- push off and drop away from the rock. Taken before
     anything else because a pup hanging four metres up a boulder cannot be picking
     anything up, and the alternative reading (jump to climb faster) would leave no input
     for getting off partway, which is the thing that was asked for. */
  /* On a wall, jump means PUSH OFF. Taken before everything else: a pup clinging four
     metres up a boulder is not picking anything up, and the wall jump is the whole
     mechanic -- it must never be shadowed by another meaning of the same button. */
  if(player.wall){ wallJump(); return; }
  const carrying = getCarried();
  if(carrying){
    releaseCarried(player.x, player.z, player.yaw);
  }else{
    catchNear(player.x, player.z);
  }
  /* Only when the hop actually happens. `trailJump` is also the catch and release button,
     so firing this unconditionally would scuff every time you picked something up
     without moving. */
  if(player.y === 0){ player.vy = 9.5; jumpSound(player.surface); }
  /* A jump AT a rock catches it. Checked after the hop is launched so the pup is already
     rising when it takes hold, which is what makes the first catch of a chain land partway
     up the face rather than at its foot. */
  if(!getCarried()) tryWallCatch(-Math.cos(player.yaw), Math.sin(player.yaw));
}
function toggleSneak(){
  if(!playing || trip.paused) return;
  player.sneaking = !player.sneaking;
  syncTouchButtons();
}
/* Sneak is a TOGGLE, and it is also cleared out from under the player by being knocked
   over -- so the button's lit state has to be pushed from the flag rather than flipped by
   the tap. Called from the frame loop, which is the only place that sees every way the
   flag can change. */
function syncTouchButtons(){
  const s=$('#tSneak');
  if(s) s.classList.toggle('on', !!player.sneaking);
  if(stickBase) stickBase.classList.toggle('sneak', !!player.sneaking);
}

/* pointerdown, not click: a jump that lands 100 ms after the thumb is a jump you missed,
   and on a phone `click` is the tail end of a whole gesture. The click listener stays as
   the fallback for anything that synthesises one (a mouse, an assistive device, the smoke
   harness) and is suppressed when the pointerdown already fired for the same tap. */
function tapBtn(el, fn){
  if(!el) return;
  let lastTap = -1e9;
  el.addEventListener('pointerdown', e=>{ e.preventDefault(); lastTap = performance.now(); fn(); });
  el.addEventListener('click', ()=>{ if(performance.now() - lastTap > 500) fn(); });
}

/* Scroll to zoom. camera.js owns the factor and applies it to the boom length in both
   the snap and the follow path, so this is the only place zoom needs to be taught about. */
renderer.domElement.addEventListener('wheel', e=>{
  if(!playing) return;
  e.preventDefault();
  addCamZoom(Math.sign(e.deltaY)*0.08);
}, {passive:false});

/* ---------- game loop ---------- */
let lastT=0;
function loop(t){
  requestAnimationFrame(loop);
  const dt=Math.min(0.05,(t-lastT)/1000||0.016); lastT=t;

  // the horizon ring is a sky dome: keep it centred on the camera so it can't be reached
  const bd=getBackdrop();
  if(bd) bd.position.set(camera.position.x, 0, camera.position.z);

  if(!playing || !getGraph() || trip.paused){
    // idle, or the arrival card is up: no movement, but keep the avatar breathing so
    // neither the lobby nor the summary is a still frame. Pausing deliberately keeps the
    // world rendered -- "Keep exploring" puts you back exactly where you are standing,
    // and cutting to a blank panel would throw that away. The minimap keeps drawing here
    // too, now that it's part of the startup/selection screen and not just the play HUD.
    if(avatarKey) syncAvatar(dt, t, 0, 0, player.sneaking, false, false);
    setNoiseRingVisible(false);        // nothing to sneak up on until the walk starts
    setCatchRingVisible(false);
    updateAreaLabels(camera.position.x, camera.position.y, camera.position.z);
    updateMinimap(player.x, player.z, player.yaw);
    renderer.render(scene,camera);
    return;
  }

  let ix=0,iz=0,run=false;
  if(trailKeys.KeyW||trailKeys.ArrowUp) iz-=1;
  if(trailKeys.KeyS||trailKeys.ArrowDown) iz+=1;
  if(trailKeys.KeyA||trailKeys.ArrowLeft) ix-=1;
  if(trailKeys.KeyD||trailKeys.ArrowRight) ix+=1;
  run=(trailKeys.ShiftLeft||trailKeys.ShiftRight) && !player.sneaking;
  let mag=Math.hypot(ix,iz);
  if(mag>0){ix/=mag;iz/=mag;mag=1;}
  if(stick.active){
    const L=Math.hypot(stick.dx,stick.dy); mag=clamp(L,0,1);
    if(mag>0.06){ix=stick.dx/L;iz=stick.dy/L;run=mag>0.92&&!player.sneaking;} else {ix=iz=0;mag=0;}
  }
  /* THE 3-2-1. Input is dropped, not the frame: the camera still follows, the animals
     still move and the countdown still draws, because a countdown over a frozen still
     frame reads as the game having hung rather than as a start line. */
  if(raceFrozen()){ ix=0; iz=0; mag=0; run=false; }
  const fS=Math.sin(getCamYaw()), fC=Math.cos(getCamYaw());
  const wx=-fC*ix-fS*iz, wz=fS*ix-fC*iz;
  /* Knocked: the stick and the keys do nothing until you land. Checked here rather than
     inside movePlayer so the pup still gets carried by its own momentum -- input is what
     is suspended, not physics. */
  const knocked = player.knockT > 0;

  /* ON A ROCK FACE the frame belongs to the climb: the same stick that walks you around
     drives you up and down instead, and none of the ground movement below runs. `-iz` is
     forward on this rig, so pushing the way you would walk into the rock climbs it and
     pulling back comes down, which is the mapping a player will guess first.

     Taken from the RAW input rather than the camera-relative world vector, because up a
     face is not a compass direction -- swinging the camera round to look at the pup
     should not invert which way it climbs. */
  /* A FLAG, NOT AN EARLY RETURN. The first version of this returned out of loop() once a
     climb took over the frame -- and renderer.render is the LAST line of loop(), so
     touching a rock stopped the screen updating entirely. The climb was running correctly
     underneath; nothing was drawn to show it, which presented as the game freezing the
     moment you touched a formation.

     Nothing in loop() may return early, because everything after the movement block --
     the critters, both rings, the landmark and trailhead checks, the HUD and the render
     itself -- has to run on every frame whatever the player happens to be doing. So a
     climb suppresses the parts it replaces and lets the rest of the frame proceed. */
  /* A FLAG, NOT AN EARLY RETURN. An earlier version returned out of loop() once a climb
     took over the frame -- and renderer.render is the LAST line of loop(), so touching a
     rock stopped the screen updating entirely. Nothing in loop() may return early: the
     critters, both rings, the landmark and trailhead checks, the HUD and the render all
     have to run every frame whatever the player is doing. */
  if(player.regrabT > 0) player.regrabT = Math.max(0, player.regrabT - dt);
  let onWall = false;
  if(player.wall){
    onWall = updateWall(dt);
    if(onWall) player.speed = 0;
  }else if(!knocked){
    // in the air and steering at a face: catch it. This is the chain -- push off, arc,
    // re-aim, catch higher.
    tryWallCatch(wx, wz);
    onWall = !!player.wall;
  }

  const moving=!onWall && !knocked && mag>0.03&&(wx||wz);

  const nt = nearestTrail(player.x,player.z);
  /* TWO different questions, which used to share one answer and caused the cliff bug.

     `inCorridor` -- is the tread actually underfoot? This is the ONLY thing that may
     bypass the step-up rule, and it has to use the corridor's own half-width, which is
     what standingY uses to decide you are standing on the tread at all.

     `nearTrail` -- is walking easier here? A soft 1.5 m band, used only for the speed
     bonus. It has no business granting free vertical movement.

     Conflating them let you walk up a cliff. A narrow trail's half-width is 0.55 m, so
     the band from 0.55 to 1.5 m counted as "on trail" and skipped the step check --
     including when the trail was on the clifftop and you were on the beach below.
     One step into the corridor and standingY lifted you the full height of the cliff.
     Measured on the default map, treads sit more than one step-up above the local
     terrain at 0.15% of corridor samples (max 1.70u, over two full terrace steps), which
     is exactly the set of cliff-edge spots where this was reachable. */
  const inCorridor = nt.d <= nt.hw;
  const nearTrail = nt.d < 1.5;
  /* What is underfoot, for the footstep voice. Derived from what movement ALREADY knows
     rather than from a new material system: `inCorridor` is the same test that decides
     you are standing on the tread at all, so the sound changes at exactly the boundary
     the ground does. Anything else would need a per-polygon material table nothing else
     in the game wants, and would drift out of step with the surface you can see.

     Rock is the scramble case rather than a place: a kerb or a face is stone whichever
     side of the trail edge it sits on, and it is the one surface you hear before you can
     see why. */
  player.surface = (player.climbT > 0 || player.wall) ? 'rock'
                 : (inCorridor ? 'trail' : 'grass');
  const surf = nearTrail ? 1 : 0.6;
  refreshOnTrail(nt);          // reuse the lookup above rather than hashing twice a frame
  if(rec.on) sampleRecording(nt, dt);   // same lookup again: the trail named in the HUD
                                        // and the trail being recorded are one answer
  if(player.climbT > 0) player.climbT = Math.max(0, player.climbT - dt);
  /* Scrabbling. A scramble is not a sequence of discrete footfalls -- the paws are
     dragging at the stone rather than striking it -- so this is a repeat on its own
     timer rather than anything the gait phase could report. The interval is jittered
     because a scuff landing on an exact beat is the thing that would turn a climb into a
     rhythm loop, which is the one way this becomes annoying. */
  if(player.climbT > 0 || player.wall){
    player.scuffT -= dt;
    if(player.scuffT <= 0){
      scrabbleSound();
      player.scuffT = 0.17 + Math.random()*0.13;
    }
  }else{
    player.scuffT = 0;      // next contact scuffs immediately, not after a stale delay
  }
  // scrambling drags the top speed down; it does NOT touch the jump, which is what makes
  // "jump the big steps" the faster line through broken ground
  const climbDrag = player.climbT > 0 ? CLIMB_SLOW : 1;
  // carrySlow() is 1 with an empty back, so this costs nothing until it costs something
  const top = currentTopSpeed()*(player.sneaking?0.5:(run?currentRunMul():1))*surf*climbDrag*carrySlow()*(stick.active?mag:1);
  player.speed = lerp(player.speed, moving?top:0, 1-Math.pow(0.0009,dt));
  /* Settling. Measured off SPEED rather than off the input, so being knocked over or
     sliding to a halt counts as movement until you have actually stopped -- an animal
     does not care whether your hands are on the controls. */
  player.stillT = player.speed < STILL_SPEED
    ? player.stillT + dt
    : Math.max(0, player.stillT - dt*(SETTLE_SECONDS/UNSETTLE_SECONDS));
  if(moving){
    const L=Math.hypot(wx,wz);
    const stepX=wx/L*player.speed*dt, stepZ=wz/L*player.speed*dt;
    const before={x:player.x, z:player.z};
    movePlayer(stepX, stepZ);
    player.dist += Math.hypot(player.x-before.x, player.z-before.z);
    const targetYaw=Math.atan2(-wz/L,wx/L);
    let dy=targetYaw-player.yaw; while(dy>Math.PI)dy-=Math.PI*2; while(dy<-Math.PI)dy+=Math.PI*2;
    player.yaw+=dy*Math.min(1,dt*10);
    /* Convenience auto-follow: swing the camera in behind the direction you're walking,
       but only when nobody's hand is on it -- otherwise every step yanks the view back
       out from under a manual look-drag, which is worse than not auto-following at all.

       WHY THIS USED TO SHAKE ON THE DOWN ARROW. The correction was measured in WORLD
       space: turn the camera toward atan2(wx, wz). But wx/wz are themselves derived from
       the camera yaw, so the camera was chasing a target that moved with it. Working the
       algebra through, the world heading is exactly camYaw + atan2(-ix, -iz) -- meaning
       the correction depends ONLY on which keys are down, and walking straight back gives
       a constant PI no matter where the camera already points. The camera could never
       converge: it span forever, and at the +-PI wrap the sign flipped frame to frame,
       which is the shake. Measuring in input space instead removes the feedback loop and
       the wrap in one go.

       Backing up is then simply excluded. Pressing "back" means "walk toward the camera";
       whipping the view around 180 degrees to get behind the pup would point it exactly
       where the player just chose not to look, and it is the one input with no stable
       answer anyway. Hold the view still and let the pup walk toward you. */
    const dc = Math.atan2(-ix, -iz);      // input direction, relative to the camera
    if(performance.now()-lastLookT>900 && Math.abs(dc) < BACKPEDAL_ARC){
      addCamYaw(dc*Math.min(1,dt*2.2));
    }
  }
  const bb=getBBox(), F=55;
  player.x=clamp(player.x,bb.minx-F,bb.maxx+F); player.z=clamp(player.z,bb.minz-F,bb.maxz+F);
  /* Gravity is suspended on a face: updateClimb owns player.y while a climb is live, and
     letting the fall integrator also write it would drag the pup down the rock as fast as
     it hauled itself up. */
  /* Gravity is suspended on a wall: updateWall owns player.y while a cling is live (it
     applies its own slide), and letting the fall integrator write it too would drop the
     pup off the rock as fast as it caught it. */
  if(!onWall){
    const wasAir = player.y > 0;
    const fell = player.vy;                 // impact speed, before the clamp discards it
    player.vy-=26*dt; player.y=Math.max(0,player.y+player.vy*dt);
    if(player.y===0){
      /* The one frame where a landing is knowable. The clamp below is about to throw the
         downward velocity away, so the impact has to be read here or not at all -- and
         `wasAir` is what stops a pup standing still on the ground from re-landing every
         frame. Scaled against the jump's own launch speed (9.5) rather than an absolute,
         so stepping off a kerb is a tap and a drop off a terrace is a thump. */
      if(wasAir && fell < -1.5) landSound(clamp(-fell/9.5, 0, 1), player.surface);
      player.vy=Math.max(0,player.vy);
    }
  }

  /* NEVER INSIDE THE ROCK. Checked as an invariant after everything else has had its say,
     rather than trusted to the movement rules -- see world.js's solidEmbed for why the
     list of ways in turned out to be longer than the list of ways it was guarded. Skipped
     while clinging, because a climber is held against the face on purpose and re-solving
     its position here would fight updateWall for control of the same two numbers. */
  if(!player.wall){
    const out = solidEmbed(player.x, player.z, playerGroundY(player.x, player.z) + player.y);
    if(out){ player.x = out.x; player.z = out.z; }
  }
  player.barkT=Math.max(0,player.barkT-dt*2);

  const groundY = syncAvatar(dt,t,player.y,player.speed,player.sneaking,player.barkT>0,run);

  /* Boom length. Pulled in from 11 to 8.5: the pup is only about a metre nose to tail at
     TRAIL_DOG_SCALE, and from 11 m back it was a small shape in a large landscape. */
  updateChaseCam(dt, player.x, player.z, groundY, player.y, player.speed, getVertScale(), 8.5);
  /* shake.js owns the NUMBER; somebody has to move a camera with it, and in trails that
     is here -- after the follow camera has settled, so the jolt is added to the framing
     rather than fought by the spring trying to undo it. Offsets are metres and tiny; the
     tell is that the horizon kicks, not that the view lurches. */
  if(shakeT > 0){
    const k = Math.min(1, shakeT)*0.34;
    camera.position.x += (Math.random()*2-1)*k;
    camera.position.y += (Math.random()*2-1)*k*0.7;
    camera.position.z += (Math.random()*2-1)*k;
    decayShake(dt*1.6);
  }

  const settled = stillness();
  updateCritters(dt, t, player.x, player.z, player.speed, noiseReference(),
                 player.sneaking, player.barkT>0, settled);
  applyImpacts(dt, groundY);
  /* Same call the critters just used, so the circle on the ground is the rule they are
     actually being judged by rather than a second guess at it. */
  updateNoiseRing(dt, player.x, player.z,
                  playerNoise(player.speed, noiseReference(), player.sneaking, player.barkT>0, settled),
                  typicalSpookRadius(), standingY, true);
  /* The reach ring, drawn around the ANIMAL rather than around the pup.

     It used to be a circle centred on the player, which put the burden the wrong way
     round: the player had to judge whether a moving animal had entered a ring attached to
     themselves. Centred on the animal it answers the question directly -- "get inside
     this and it is yours" -- and it also stops being a ring that follows you everywhere,
     which is what made the old one read as a static fixture.

     SHOW_MUL widens the search past arm's length so the ring appears while you are still
     approaching rather than popping into existence at the instant you could already grab.
     It brightens once you are actually inside it (`inReach`), which is the moment the
     jump would work.

     The radius comes back FROM the search rather than being asked for separately, because
     reach is now per-species (critters.js's catchRadiusFor) -- a jumpy rabbit has a bigger
     one than a bold fox. Drawing a roster average around a specific animal would be a ring
     that does not mean what it shows. */
  const reach = getCarried() ? null : nearestCatchable(player.x, player.z, SHOW_MUL);
  updateCatchRing(dt, reach ? reach.critter.x : player.x, reach ? reach.critter.z : player.z,
                  reach ? reach.reach : 1, standingY, !!reach, !!(reach && reach.inReach));
  updateAreaLabels(camera.position.x, camera.position.y, camera.position.z);
  updateFX(dt, t);
  /* AFTER movement, BEFORE the map draws. The clock and the progress have to describe
     where the runner ended this frame, and the line on the disc has to show that same
     number -- a race scored before the step and drawn after it would be a percentage that
     always lagged the pup by one frame. */
  updateRace(dt);
  if(rec.on) updateRecChip();
  updateMinimap(player.x, player.z, player.yaw);
  updateTrailHud();

  /* Landmarks. Walking within a few metres of a POI banks it -- there is no interact
     key, because stopping to press a button is the opposite of what a walk is. */
  for(const poi of getPOIs()){
    if(poi.found) continue;
    if(Math.hypot(poi.x-player.x, poi.z-player.z) < 6){
      poi.found = true;
      trip.landmarks.push(poi.name || poi.kind || 'Landmark');
      comicBurst('\ud83d\udccd ' + (poi.name||'Landmark'), poi.x, groundY+2.2, poi.z, '#e8743a');
      cheerBlip();
    }
  }

  /* Arriving at a trailhead opens the summary instead of quietly ending the walk. The
     old behaviour dumped you back to the lobby with no idea what you'd done, and with no
     way to carry on from where you stood. */
  const nh=getTrailheads().reduce((b,h,i)=>{const d=Math.hypot(h.x-player.x,h.z-player.z);
    return(!b||d<b.d)?{d,i}:b;},null);
  if(nh){
    if(nh.d > 12 && trip.parked === nh.i) trip.parked = -1;      // walked away; it re-arms
    /* NOT during a race. Courses start and finish at trailheads more often than not (they
       are where trails begin), so without this the summary card pauses the game and stops
       the clock a couple of seconds into every run. */
    if(nh.d < 5 && player.dist > 20 && trip.parked !== nh.i && !race.on){
      trip.parked = nh.i;
      showArrival(nh.i);
    }
  }

  syncTouchButtons();
  renderer.render(scene,camera);
}

function enterPlay(){
  if(!getGraph()){ return; }
  initAudio();
  placeAtHead(getStartHead());
  // fresh population per walk, so the sightings tally means "this trip" rather than
  // "since you opened the tab"
  spawnCritters(Date.now());
  getPOIs().forEach(p=>{ p.found=false; });
  trip.startT = Date.now();
  trip.parked = getStartHead();     // don't fire the card at the head you started from
  trip.paused = false;
  trip.landmarks.length = 0;
  trip.bonks = 0;
  player.stillT = 0;
  playing=true;
  document.body.classList.add('play');
  showPane(null);                   // walk full-bleed; the drawer is opt-in
  refreshOnTrail();
  renderSpotList();
  renderCourseUI();
  syncCourseOverlay();
  updateTrailHud();
}
function exitPlay(){
  playing=false;
  trip.paused=false;
  showPane(null);
  closeArrival();
  /* A race and a half-finished trace are both things about THIS walk. Leaving either
     running would have the next walk open with a clock counting and a magenta line across
     a course nobody chose. */
  quitRace();
  disposeGhost();
  rec.on = false; rec.pts.length = 0; rec.lenM = 0;
  recPending = null;
  renderCourseUI();
  syncCourseOverlay();
  /* Put the passenger down before the population is torn down. resetCritters disposes
     every group including the carried one, and leaving `carried` pointing at a disposed
     rig would have the next walk start with an invisible animal on your back. */
  releaseCarried(player.x, player.z, player.yaw);
  resetCritters();
  setCatchRingVisible(false);
  document.body.classList.remove('play');
  placeAtHead(getStartHead());
}

/* ---------- being sent backwards by something with horns ----------

   critters.js queues a hit and knows nothing about players; this turns each one into
   motion. Three separate effects, and they are separate on purpose:

     the shove    a velocity along the hit direction, spent through movePlayer so you are
                  pushed ALONG the ground and stopped by the same walls that stop you
                  walking -- never shoved through a hillside or off a terrace you could
                  not have walked off.
     the tumble   yaw spin plus a vertical pop. This is the whole animation, and it reuses
                  the rig's existing leap pose rather than adding a "stagger" the two
                  drivers would both have to learn: airborne + spinning already reads
                  exactly like being knocked head over heels.
     the jolt     a camera shake, so the hit is felt by the view and not only watched.

   Distance travelled is NOT credited while you are being thrown. Being launched forty
   metres by a moose is many things, but it is not a walk. */
function applyImpacts(dt, groundY){
  for(const hit of takeImpacts()){
    player.knockT = KNOCK_DUR;
    player.kvx = hit.dirX*hit.force;
    player.kvz = hit.dirZ*hit.force;
    player.vy = Math.max(player.vy, 4.2 + hit.force*0.16);
    // spin the way you were pushed, so the tumble agrees with the shove
    player.spin = (hit.dirX*Math.sin(player.yaw) + hit.dirZ*Math.cos(player.yaw)) >= 0 ? 1 : -1;
    player.spinT = KNOCK_DUR*1.5;
    player.speed = 0;
    player.sneaking = false;         // you are not sneaking any more, whatever you think
    setShake(0.55 + hit.force*0.02);
    trip.bonks = (trip.bonks||0) + 1;
  }
  if(player.knockT > 0){
    player.knockT = Math.max(0, player.knockT - dt);
    const k = Math.pow(KNOCK_DRAG, dt);
    const stepX = player.kvx*dt, stepZ = player.kvz*dt;
    movePlayer(stepX, stepZ);        // same collision rules as walking
    player.kvx *= k; player.kvz *= k;
  }
  if(player.spinT > 0){
    player.spinT = Math.max(0, player.spinT - dt);
    // eases out, so the pup rights itself rather than stopping mid-rotation
    player.yaw += player.spin*dt*9.5*(player.spinT/(KNOCK_DUR*1.5));
  }
}

/* ---------- trailhead arrival ---------- */

/* Deliberately legible rather than tuned: distance is the base, watching an animal is
   worth about 300 m of walking, a landmark about 200, and spooking something costs a
   little. The point is that a slow, quiet walk out-scores a fast noisy one. */
function tripScore(st){
  // getting butted costs more than spooking something: one is bad luck, the other is
  // walking into a bear that spent three seconds telling you not to
  /* A catch is worth more than a sighting because it is strictly harder: you have to bank
     the sighting's worth of stillness AND then be inside a ring a third the size of the
     one that would already have sent the animal running. It is not worth so much that
     catching becomes the only thing to do -- two catches still lose to four quiet
     sightings, which keeps the walk a walk. */
  return Math.max(0, Math.round(
    player.dist*0.2 + st.sightings*60 + (st.caught||0)*100 + trip.landmarks.length*40
    - st.spooked*10 - (trip.bonks||0)*35));
}

function showArrival(i){
  const th = getTrailheads()[i];
  if(!th) return;
  const st = getCritterStats();
  trip.paused = true;
  document.body.classList.add('arrived');

  const secs = Math.max(0, Math.round((Date.now()-trip.startT)/1000));
  const set = (id, v)=>{ const el=$(id); if(el) el.textContent=v; };
  set('#arrTitle', 'You reached ' + th.name + '!');
  set('#arrSub', 'The ' + th.where + ' trailhead \u2014 rest here or head back out.' +
    (trip.bonks ? '  You got knocked over ' + trip.bonks + (trip.bonks===1?' time.':' times.') : ''));
  set('#arrScore', tripScore(st));
  // same conversion as the HUD, or the summary would contradict the number the player
  // watched tick up for the whole walk
  set('#arrDist', formatTravelled(realMetres(player.dist)));
  set('#arrTime', Math.floor(secs/60)+':'+String(secs%60).padStart(2,'0'));
  set('#arrSeen', st.sightings);
  set('#arrSpooked', st.spooked);
  set('#arrCaught', st.caught || 0);

  const lm = $('#arrLandmarks');
  if(lm){
    lm.innerHTML = '';
    if(!trip.landmarks.length){
      const n=document.createElement('div'); n.className='none';
      n.textContent = getPOIs().length
        ? 'None yet \u2014 there are ' + getPOIs().length + ' waiting out there.'
        : 'No landmarks on this map \u2014 add a points or polygons layer.';
      lm.appendChild(n);
    } else for(const name of trip.landmarks){
      const r=document.createElement('div'); r.className='arr-row';
      r.innerHTML = '<span>\ud83d\udccd</span><span></span>';
      r.children[1].textContent = name;
      lm.appendChild(r);
    }
  }
  const lg = $('#arrLog');
  if(lg){
    lg.innerHTML = '';
    if(!st.log.length){
      const n=document.createElement('div'); n.className='none';
      n.textContent = 'Nothing watched yet \u2014 hold C to sneak and stay still.';
      lg.appendChild(n);
    } else for(const e of st.log){
      const r=document.createElement('div'); r.className='arr-row';
      r.innerHTML = '<span></span><span></span><span class="n"></span>';
      r.children[0].textContent = e.emo;
      r.children[1].textContent = e.nm;
      r.children[2].textContent = '\u00d7' + e.n;
      lg.appendChild(r);
    }
  }
}

function closeArrival(){
  trip.paused=false;
  document.body.classList.remove('arrived');
}

/* Sightings / spooked tally plus the watch meter. Cheap enough to run every frame --
   it's four textContent writes and one style width -- and gating it behind a change
   check would cost more in bookkeeping than it saves. */
/* World units -> real-world metres.

   Positions are compacted by the world scale (World.setMapScale multiplies metres per
   degree by it), so a world unit is `MAP_SCALE` real metres and every raw length in
   src/trails is short by that factor. Elevations are NOT compacted -- they stay in true
   metres -- which is exactly why this conversion has to be explicit rather than assumed.
   At 1:5 a 500 m trail is 100 world units, so anything reporting a raw length as metres
   is understating it fivefold. */
function realMetres(u){ return u/Math.max(1e-6, getMapScale()); }

/* Elevation is a real-world fact about the place, so it comes from the DEM in true
   metres rather than from the terraced game surface -- the terracing quantises height to
   the contour step, and reporting "you are on band 14" as an altitude would be inventing
   precision the player can't use. World.heightAt already takes scaled world coordinates
   and returns absolute metres above sea level. */
function elevationFt(x, z){
  const W = getWorld();
  if(!W || typeof W.heightAt !== 'function') return null;
  return W.heightAt(x, z)*3.28084;
}

function formatTravelled(m){
  return m >= 1000 ? (m/1000).toFixed(2)+' km' : Math.round(m)+' m';
}

function updateTrailHud(){
  const st = getCritterStats();
  const seen = $('#hudSeen'), oops = $('#hudSpooked'), meter = $('#watchMeter'), fill = $('#watchFill'), name = $('#watchName');
  if(seen) seen.textContent = '\u2728 ' + st.sightings;
  if(oops) oops.textContent = '\ud83d\udca8 ' + st.spooked;

  /* Two separate readouts, not one. The tally is history (how many you caught this walk)
     and the chip is state (who is on your back right now). Folding them together would
     make the count blink between two meanings, and the one the player needs mid-walk is
     the state -- it is the thing that explains why they are suddenly slower. */
  const got = $('#hudCaught');
  if(got) got.textContent = '\ud83e\udd17 ' + (st.caught || 0);
  const carry = $('#hudCarry');
  if(carry){
    const c = st.carrying;
    carry.classList.toggle('on', !!c);
    if(c) carry.textContent = c.emo + ' ' + c.name + ' \u2014 jump to let go';
  }

  const elev = $('#hudElev');
  if(elev){
    const ft = elevationFt(player.x, player.z);
    elev.textContent = ft==null ? '\u26f0 \u2014' : '\u26f0 ' + Math.round(ft).toLocaleString() + ' ft';
  }
  const dist = $('#hudDist');
  if(dist) dist.textContent = '\ud83d\udc63 ' + formatTravelled(realMetres(player.dist));
  const trail = $('#hudTrail');
  if(trail){
    trail.classList.toggle('on', !!onTrail.name);
    if(onTrail.name){
      trail.textContent = onTrail.name;
      // same ink as the highlight stroked on the disc above it, so the chip names the
      // bright line rather than sitting beside it as a separate fact
      trail.style.borderColor = onTrail.color || '';
    }
  }
  /* The 🔊 chip is gone. It restated, in a number, what the ring drawn on the ground was
     already showing as a picture -- and the picture is the better readout, because it is
     in the world with the animals it is about rather than in the corner of the screen.
     The lookup stays guarded rather than deleted: a themed build could put it back. */
  const noise = $('#hudNoise');
  if(noise){
    /* NO realMetres() here, and that is not an oversight. Positions compact with world
       scale, so travelled distance must be converted -- but a spook radius is the gap
       between the pup and an animal, both of which stay true size at any scale, and
       critters.js deliberately leaves those radii unscaled (see wanderTarget's note on
       why the *S applies to positions and not to the radii). Converting here made the
       chip read 800 m at 1:32 for a deer that can hear you from 25. The number IS the
       ring's radius, so the chip and the circle can never disagree. */
    const r = noiseRingRadius();
    noise.textContent = '\ud83d\udd0a ' + (r>=1000 ? (r/1000).toFixed(1)+' km' : Math.round(r)+' m');
    const n = playerNoise(player.speed, noiseReference(), player.sneaking, player.barkT>0, stillness());
    noise.classList.toggle('quiet', n <= 0.4);
    noise.classList.toggle('loud', n >= 1.2);
  }
  if(meter){
    const w = st.watching;
    meter.classList.toggle('on', !!w);
    if(w){
      if(fill) fill.style.width = Math.round(w.progress*100) + '%';
      if(name) name.textContent = w.progress >= 1 ? w.name + ' spotted!' : 'Watching ' + w.name + '\u2026';
    }
  }
}

/* ---------- UI wiring ----------
   Sighting log, exit-gate stats screen and full minimap drawing from the standalone
   build are still not ported -- flagged rather than silently dropped. */

/* --- who's exploring ---
   Two rosters, not one mixed grid: the premade pups and any pups saved in the creator
   are one kind of choice, the wildlife is another. Both are populated on boot with no
   file to import and no map required -- picking a dog before a map has loaded stands it
   at the origin rather than doing nothing, which is also how you can tell the picker
   works when a map fails. The live choice carries `.sel`, because a button that silently
   does its job is indistinguishable from a button that is broken. */
function rosterKey(){ return mode==='dog' ? 'dog:'+dogChoice.label : 'wild:'+wildKey; }

/* Two stats become the pupcard's blue/pink bars: dogTopSpeed (well, its underlying
   dog/stats.js curve, not the trail-only multiplier) for "trail speed", and something
   distance-shaped for "how far off you spook the locals". Dogs and wildlife don't share
   a stat system, so this leans on the closest analogue each already has --
   STATS.scareRadius for a dog (how far ITS presence disturbs wildlife) and
   spookRadiusFor() for a wild animal (how far away it notices you, the same underlying
   idea from the other side) -- rather than inventing a third, unified number. Each is
   normalised against the min/max across ITS OWN roster, so the bars stay meaningful
   whether the roster is six dogs or fourteen species.
   Returns {speedPct, spookPct}, both 0-100. */
function dogBarStats(size){
  const st = computeStats(size);
  const pct = (v,lo,hi) => clamp(Math.round((v-lo)/(hi-lo)*100), 4, 100);
  // walk range is fixed by computeStats's own formula (2.6..3.6); scareRadius likewise
  // (3.2..8.6) -- see dog/stats.js. Using the formula's own bounds, not the roster's
  // observed min/max, keeps a lone saved pup's bar meaningful on its own.
  return { speedPct: pct(st.walk, 2.6, 3.6), spookPct: pct(st.scareRadius, 3.2, 8.6) };
}
let wildBarRange = null;
function wildBarStats(key){
  if(!wildBarRange){
    const speeds = Object.keys(SPECIES).map(topSpeedFor);
    const spooks = Object.keys(SPECIES).map(spookRadiusFor);
    wildBarRange = { sLo:Math.min(...speeds), sHi:Math.max(...speeds),
                      pLo:Math.min(...spooks), pHi:Math.max(...spooks) };
  }
  const r = wildBarRange;
  const pct = (v,lo,hi) => clamp(Math.round((v-lo)/((hi-lo)||1)*100), 4, 100);
  return { speedPct: pct(topSpeedFor(key), r.sLo, r.sHi), spookPct: pct(spookRadiusFor(key), r.pLo, r.pHi) };
}

function pupCard(grid, key, icon, name, sub, bars, onClick){
  const b = document.createElement('button');
  b.className = 'pupcard' + (key===rosterKey() ? ' sel' : '');
  b.innerHTML = `<span class="pc-top"><span class="pc-ic">${icon}</span><span class="pc-nm">${name}</span></span>` +
    (sub ? `<span class="pc-sub">${sub}</span>` : '') +
    `<span class="pc-bar speed"><i style="width:${bars.speedPct}%"></i></span>` +
    `<span class="pc-bar spook"><i style="width:${bars.spookPct}%"></i></span>`;
  // swapping who you are mid-walk should not also swap WHERE you are
  b.addEventListener('click', ()=>{ onClick(); renderRoster(); afterWorldChange(1); });
  grid.appendChild(b);
  return b;
}

function renderRoster(){
  const dogs=$('#dogGrid'), wild=$('#animalGrid');
  if(dogs){
    dogs.innerHTML='';
    kennelPups.forEach(k=>{
      pupCard(dogs, 'dog:saved:'+k.name, '⭐', k.name, 'Saved pup', dogBarStats(k.params.size ?? 1), ()=>{
        mode='dog'; dogChoice={label:'saved:'+k.name, params:k.params};
      });
    });
    PRESETS.forEach(p=>{
      pupCard(dogs, 'dog:'+p.label, '🐕', p.label, p.sub||'', dogBarStats(p.o.size ?? 1), ()=>{
        mode='dog'; dogChoice={label:p.label, params:p.o};
      });
    });
  }
  if(wild){
    wild.innerHTML='';
    // every species in the shared roster, theme-appropriate ones first so the list reads
    // as "what you'd meet out here" before "everything that exists"
    const local=(THEME.wildlife||[]);
    const trailKeys=[...local, ...Object.keys(SPECIES).filter(k=>!local.includes(k))];
    for(const key of trailKeys){
      if(!SPECIES[key]) continue;
      pupCard(wild, 'wild:'+key, '🦊', SPECIES[key].nm, '', wildBarStats(key), ()=>{ mode='wild'; wildKey=key; });
    }
  }
  const note=$('#pupNote');
  if(note) note.textContent = kennelPups.length
    ? `${kennelPups.length} saved pup${kennelPups.length>1?'s':''} from the creator, plus the ${PRESETS.length} starters.`
    : `${PRESETS.length} starter pups. Make your own in Backyard Pups — they show up here automatically — or import a backyard-pups.json below.`;
}

/* Dogs/Wildlife toggle: purely which grid is visible, independent of `mode` (see
   browseMode's own comment) -- so opening the Wildlife tab to browse doesn't switch who
   you're playing as until you actually tap a card. */
function renderPupToggle(){
  document.querySelectorAll('#pupModeToggle .toggle').forEach(b=>{
    b.classList.toggle('sel', b.dataset.mode===browseMode);
  });
  const dogs=$('#dogGrid'), wild=$('#animalGrid');
  if(dogs) dogs.hidden = browseMode!=='dog';
  if(wild) wild.hidden = browseMode!=='wild';
}
document.querySelectorAll('#pupModeToggle .toggle').forEach(b=>{
  b.addEventListener('click', ()=>{ browseMode=b.dataset.mode; renderPupToggle(); });
});

$('#randomPupBtn')?.addEventListener('click', ()=>{
  const params = randomPupParams();
  mode='dog'; browseMode='dog'; dogChoice={label:'random:'+params.name, params};
  renderPupToggle(); renderRoster(); afterWorldChange(1);
});

/* --- environment --- */
function renderThemePicker(){
  const grid=$('#envGrid'); if(!grid) return;
  grid.innerHTML='';
  Object.values(THEMES).forEach(t=>{
    const b=document.createElement('button');
    b.className='envcard'+(t.id===THEME.id?' sel':'');
    b.style.background=t.grass[0];      // ground colour, not sky -- reads as a swatch of
                                         // the actual landscape rather than just "blue"
    b.innerHTML=`<span class="em">${t.em}</span><span class="nm">${t.label}</span>`;
    b.addEventListener('click',()=>{
      if(!setThemeById(t.id)) return;
      renderThemePicker();
      renderRoster();
      afterWorldChange(1);     // rebuild dropped the old scene; re-seat where we stand
    });
    grid.appendChild(b);
  });
}

/* --- scale ---
   All three sliders below can rebuild the world, which is expensive, so the label
   updates on `input` and the rebuild only fires on `change` (pointer release /
   arrow-key commit) -- except fog, which is cheap enough to apply live (see below). */
/* Set by wireScale once the exaggeration slider is wired. A no-op until then, so the
   world-scale handler can call it unconditionally without caring about wiring order. */
let syncExaggerationUI = ()=>{};
function wireScale(){
  /* World scale, shown as "1 : N" (N = 1..1000, matching real map-scale notation --
     N=1 is true size, bigger N is more compacted) rather than the old "0.25x..2x"
     multiplier. N spans three orders of magnitude, so the <input type=range> itself
     runs over a plain 0..1000 "slider position" and is mapped through log10 rather than
     used as N directly -- linear would put every value between 1:1 and 1:50 (the range
     most trail networks actually need) into the first 5% of the handle's travel. */
  const map=$('#worldScale'), mapV=$('#worldScaleVal');
  /* 1:1 .. 1:15. The old range ran to 1:1000, which was three orders of magnitude of
     handle travel for a setting whose useful span is the first one -- past about 1:15 a
     real trail network is compacted into a courtyard and the terrain is a crumpled sheet.
     Narrowing the range gives the whole handle to values worth choosing.

     Still logarithmic, for the same reason as before: the interesting differences are
     between 1:1 and 1:4, and a linear handle spends most of itself above 1:8. */
  const SCALE_MAX = 15;
  const LOG_MAX = Math.log10(SCALE_MAX);
  const posToN = t => clamp(Math.round(Math.pow(10, t/1000*LOG_MAX)), 1, SCALE_MAX);
  const nToPos = n => clamp(Math.log10(clamp(n,1,SCALE_MAX))/LOG_MAX*1000, 0, 1000);
  if(map && mapV){
    map.min=0; map.max=1000; map.step=1;
    map.value=nToPos(Math.round(1/getMapScale()));
    const show=n=>{ mapV.textContent = '1 : '+n; };
    show(posToN(map.value));
    map.addEventListener('input', e=> show(posToN(+e.target.value)));
    map.addEventListener('change', e=>{
      // capture the OLD scale first: afterWorldChange needs the ratio to carry the
      // player to the same real-world place in the recompacted coordinate system
      const before=getMapScale();
      setMapScale(1/posToN(+e.target.value));
      /* KEEP THE PROPORTIONS. Elevation does not compact with the footprint, so at 1:N the
         same hills are N times steeper -- which is why the exaggeration slider existed as
         a manual counterweight and why the hint text told you to go and adjust it. Making
         the link automatic is what "consistent proportions" means: exaggeration tracks the
         map scale so the ratio EXAG/MAP_SCALE stays at 1 and the country keeps true slope
         at every setting.

         Still adjustable afterwards. This sets a sane default at the moment the scale
         moves rather than locking the slider, so exaggeration remains a deliberate
         stylistic choice instead of a correction you are obliged to make. */
      setVertScale(getMapScale());
      syncExaggerationUI();
      show(Math.round(1/getMapScale()));
      afterWorldChange(getMapScale()/before);
    });
  }
  /* Hill exaggeration: 0..2 as asked, but on a SQUARED handle rather than a linear one.

     Linear was unusable in combination with full-range world scale. Elevation no longer
     compacts with the footprint, so slope steepens in exact proportion: at 1:16 the same
     hills are sixteen times steeper, and the setting you actually want is around 0.06 --
     the first three percent of a linear handle's travel. Squaring gives most of the
     travel to the low end, where the useful values now live, without changing the range.

     The readout says how steep the result is against real-world slope, because that ratio
     is EXAG / MAP_SCALE and there is no way to guess it from either slider alone. */
  const ex=$('#vertScale'), exV=$('#vertScaleVal');
  const exToPos = v => clamp(Math.sqrt(Math.max(0,v)/2)*1000, 0, 1000);
  const posToEx = t => Math.round(2*Math.pow(t/1000, 2)*1000)/1000;
  if(ex && exV){
    /* Hoisted so the world-scale handler above can drive this slider when it re-links the
       two. Assigned here rather than declared at function scope because it needs `show`,
       which needs `exV` -- and a second copy of the readout formatting is exactly the kind
       of duplication that ends with the number and the handle disagreeing. */
    ex.min=0; ex.max=1000; ex.step=1;
    ex.value=exToPos(getExaggeration());
    const show=v=>{
      const ratio = v/Math.max(1e-6, getMapScale());
      const how = v<=0 ? 'flat'
        : ratio>=1.05 ? Math.round(ratio*10)/10+'\u00d7 real slope'
        : ratio<=0.95 ? Math.round(10/ratio)/10+'\u00d7 gentler than real'
        : 'true slope';
      exV.textContent = (+v).toFixed(2)+'\u00d7 \u2014 '+how;
    };
    show(getExaggeration());
    ex.addEventListener('input', e=> show(posToEx(+e.target.value)));
    ex.addEventListener('change', e=>{
      setVertScale(posToEx(+e.target.value));
      show(getExaggeration());
      afterWorldChange(1);       // heights only -- x/z are untouched
    });
    syncExaggerationUI = ()=>{ ex.value = exToPos(getExaggeration()); show(getExaggeration()); };
    // world scale changes the ratio too, so the readout has to follow it
    $('#worldScale')?.addEventListener('change', ()=> show(getExaggeration()));
  }
  // fog touches scene.fog only -- no rebuild, so it applies live on every `input` tick
  // instead of waiting for `change` the way the two rebuild-triggering sliders above do.
  /* Contour step. It rebuilds the terrain mesh, so it commits on 'change' (pointer up)
     rather than 'input' like the cheap fog slider -- dragging it live would rebuild the
     whole grid on every pixel of handle travel. */
  const cs=$('#contourStep'), csV=$('#contourVal');
  if(cs && csV){
    cs.value=getContourStep();
    const showC=v=>{ csV.textContent = (+v).toFixed(1)+' m'; };
    showC(cs.value);
    cs.addEventListener('input', e=> showC(e.target.value));
    cs.addEventListener('change', e=>{
      setContourStep(+e.target.value);
      showC(getContourStep());
      afterWorldChange(1);
    });
  }

  const fog=$('#fogAmt'), fogV=$('#fogAmtVal');
  if(fog && fogV){
    fog.value=getFogMultiplier();
    const show=v=>{ fogV.textContent = (+v).toFixed(2)+'\u00d7'; };
    show(fog.value);
    fog.addEventListener('input', e=>{
      setFogMultiplier(+e.target.value);
      show(getFogMultiplier());
    });
  }
}

/* --- starting point --- */
/* --- starting point --- */
function headLetter(i){ return i<26 ? String.fromCharCode(65+i) : String(i+1); }

/* The trailhead list is GONE from the panel, and this is what replaced it.

   A list of eight cards named "Palmer Trail, north end" was the worst possible interface
   for a spatial question. Which of them is near the rocks? Which two are ten minutes
   apart? The map already knew, and already drew a lettered, tappable badge on every one
   of them -- the list was a second, worse copy of a control that existed. So the sheet is
   now the picker outright, and the panel is settings only. All that is left here is the
   answer: which one is currently selected, shown on the sheet beside the badges so the
   letter you are reading has something to match against. */

/* ====================== THE DETAILS PANEL ON THE MAP SHEET ======================

   One card answering "what is this thing I just tapped", for both kinds of thing you can
   tap on the sheet: a lettered trailhead badge and a saved course.

   TAPPING NO LONGER TELEPORTS. It used to: a pick on the sheet placed the player and
   started walking, because the map was the only way into a walk and a pick therefore had
   to do the starting as well as the choosing. That was fine while a trailhead was just a
   letter, and stopped being fine once there was anything to know about it -- you cannot
   read the elevation of a place you have already been moved to, and a walk you did not
   mean to start costs you the one you were in. So the pick now LOADS, and a button STARTS.

   Both kinds of subject render through the same three slots (title, stats, actions) in the
   same order, so wherever the answer appears for a trailhead it appears for a course too.
   `hereSubject` is what is loaded, and it is a tagged object rather than two separate
   nullable variables, because "a trailhead is showing" and "a course is showing" have to
   be mutually exclusive and two variables can disagree about that. */
let hereSubject = null;      // {kind:'head', i} | {kind:'course', c} | null

function getHereSubject(){ return hereSubject; }

function hereEl(){
  return {title:$('#hereTitle'), idle:$('#hereIdle'),
          stats:$('#hereStats'), actions:$('#hereActions')};
}

/* Back to the idle state: the current start point and the hint about tapping things. */
function showHereIdle(){
  hereSubject = null;
  const el = hereEl();
  if(el.title) el.title.textContent = '\u{1F6A9} Start here';
  if(el.idle) el.idle.classList.remove('off');
  if(el.stats){ el.stats.classList.remove('on'); el.stats.innerHTML = ''; }
  if(el.actions){ el.actions.classList.remove('on'); el.actions.innerHTML = ''; }
  renderStartPicker();
}

/* Small builders so the two subjects cannot drift into different-looking cards. */
function hereRow(stats, label, value){
  const r = document.createElement('div');
  r.className = 'hs-row';
  r.innerHTML = '<span></span><span></span>';
  r.children[0].textContent = label;
  r.children[1].textContent = value;
  stats.appendChild(r);
  return r;
}
function hereNote(stats, text){
  const n = document.createElement('div');
  n.className = 'hs-sub';
  n.textContent = text;
  stats.appendChild(n);
  return n;
}
function hereBtn(actions, label, primary, fn){
  const b = document.createElement('button');
  b.className = 'btn small' + (primary ? ' primary' : '');
  b.textContent = label;
  b.addEventListener('click', fn);
  actions.appendChild(b);
  return b;
}

/* --- a trailhead --------------------------------------------------------------------- */
function showHereHead(i){
  const heads = getTrailheads();
  if(!heads.length || i == null || i < 0 || i >= heads.length){ showHereIdle(); return; }
  hereSubject = {kind:'head', i};
  const h = heads[i];
  const el = hereEl();
  if(el.idle) el.idle.classList.add('off');
  if(el.title) el.title.textContent = '\u{1F6A9} ' + headLetter(i) + ' \u00b7 ' + h.name;
  const stats = el.stats, actions = el.actions;
  if(!stats || !actions) return;
  stats.innerHTML = ''; actions.innerHTML = '';

  hereRow(stats, 'Trail', h.name + ' (' + h.where + ' end)');
  const ft = elevationFt(h.x, h.z);
  if(ft != null) hereRow(stats, 'Elevation', Math.round(ft).toLocaleString() + ' ft');
  /* How far away it is, and in a straight line -- said so explicitly, because on a trail
     network the walk is always longer and a number that looked like walking distance would
     be wrong by a factor that varies with the terrain. */
  const k = Math.max(1e-6, getMapScale());
  const away = Math.hypot(h.x - player.x, h.z - player.z)/k;
  hereRow(stats, 'From you', fmtCourseLen(away) + ' as the crow flies');

  /* Which trails actually meet here. A trailhead is a dead end by definition, so this is
     usually one -- but junction trailheads exist, and "three trails start here" is the
     single most useful thing to know before committing a walk to it. */
  const g = getGraph();
  if(g){
    const names = new Set();
    g.edges.forEach(e=>{
      if(!e.named) return;
      const pts = e.pts || [];
      for(const q of [pts[0], pts[pts.length-1]]){
        if(q && Math.hypot(q[0]-h.x, q[1]-h.z) < 2.0) names.add(e.name);
      }
    });
    if(names.size) hereNote(stats, [...names].join(' \u00b7 '));
  }
  stats.classList.add('on');

  hereBtn(actions, '\u{1F6A9} Start here', true, ()=>{
    placeAtHead(i);
    if(!playing) enterPlay();
    showPane(null);
  });
  hereBtn(actions, '\u2715 Close', false, showHereIdle);
  actions.classList.add('on');
}

/* --- a course ------------------------------------------------------------------------- */
function showHereCourse(c){
  if(!c){ showHereIdle(); return; }
  hereSubject = {kind:'course', c};
  const el = hereEl();
  if(el.idle) el.idle.classList.add('off');
  if(el.title) el.title.textContent = '\u{1F3C1} ' + c.name;
  const stats = el.stats, actions = el.actions;
  if(!stats || !actions) return;
  stats.innerHTML = ''; actions.innerHTML = '';

  const rel = courseRelief(c, courseElevAt);
  hereRow(stats, 'Length', fmtCourseLen(courseLengthM(c)));
  if(rel.ok){
    /* Cumulative and absolute kept on separate lines, because they answer different
       questions and a loop is the case that proves it: 300 m of climbing and 0 m net. */
    hereRow(stats, 'Climb', '\u2197 ' + Math.round(rel.gain) + ' m \u00b7 \u2198 ' +
                            Math.round(rel.loss) + ' m');
    hereRow(stats, 'Net rise', (rel.net >= 0 ? '+' : '\u2212') + Math.round(Math.abs(rel.net)) + ' m');
    hereRow(stats, 'High / low', Math.round(rel.hi) + ' / ' + Math.round(rel.lo) + ' m');
  }

  const board = document.createElement('div');
  board.className = 'hs-board';
  const rows = courseTimes(c);
  if(!rows.length){
    hereNote(stats, 'No times on this course yet.');
  }else rows.forEach((r, i)=>{
    const row = document.createElement('div');
    row.className = 'r' + (r.key === rosterKey() ? ' me' : '');
    row.innerHTML = '<span></span><span></span><span></span>';
    row.children[0].textContent = i === 0 ? '\u{1F3C6}' : (r.key.startsWith('wild:') ? '\u{1F98A}' : '\u{1F415}');
    row.children[1].textContent = r.name;
    row.children[2].textContent = fmtRaceTime(r.t);
    board.appendChild(row);
  });
  stats.appendChild(board);

  /* Whether there is a ghost to chase, said before the race rather than discovered during
     it. A ghost that is slower than the record is normal (see recordCourseTime) and is
     labelled with its own time, so the two numbers never quietly contradict each other. */
  const gh = courseGhost(c, getGhostMode() === 'mine' ? 'mine' : 'best', rosterKey());
  hereNote(stats, getGhostMode() === 'off'
    ? '\u{1F47B} Ghost is off.'
    : (gh ? '\u{1F47B} Chasing ' + gh.name + ' at ' + fmtRaceTime(gh.t)
          : '\u{1F47B} No ghost yet \u2014 finish a run to set one.'));
  stats.classList.add('on');

  hereBtn(actions, '\u{1F3C1} Race this', true, ()=> startRace(c));
  const shown = previewCourse && previewCourse.id === c.id;
  hereBtn(actions, shown ? '\u{1F441} Hide on map' : '\u{1F441} Show on map', false, ()=>{
    toggleCourseShown(c);
    showHereCourse(c);
  });
  hereBtn(actions, '\u2715 Forget', false, ()=>{
    if(previewCourse && previewCourse.id === c.id) previewCourse = null;
    if(race.on && race.course && race.course.id === c.id) quitRace();
    removeCourse(c.id);
    showHereIdle();
    renderCourseUI();
    syncCourseOverlay();
  });
  actions.classList.add('on');
}

/* Re-render whatever is loaded, after something it displays has changed underneath it --
   a new best time, a course removed, the map swapped. Silently drops a subject that no
   longer exists rather than leaving a card describing something that is gone. */
function refreshHere(){
  if(!hereSubject){ showHereIdle(); return; }
  if(hereSubject.kind === 'head'){
    if(hereSubject.i >= getTrailheads().length) showHereIdle();
    else showHereHead(hereSubject.i);
  }else{
    const still = getCourses().some(x => x.id === hereSubject.c.id);
    if(still) showHereCourse(hereSubject.c); else showHereIdle();
  }
}

function renderStartPicker(){
  const now=$('#startNow');
  const heads=getTrailheads();
  if(!heads.length){
    if(now) now.textContent='— load a map first —';
    return;
  }
  const i=getStartHead(), h=heads[i];
  if(now && h) now.textContent = headLetter(i)+' · '+h.name+' ('+h.where+' end)';
}

/* Saved pins, as rows that mirror the badges on the sheet: same order, same numbers. The
   row is a button because a pin's whole purpose is to be gone back to, and the ✕ removes
   it -- both live here on the map rather than in the panel, since a pin is a place and
   places belong on the map. */
function renderSpotList(){
  const list=$('#spotList'); if(!list) return;
  const spots=getSpots();
  list.innerHTML='';
  if(!spots.length){
    const n=document.createElement('div'); n.className='none';
    n.textContent='No pins yet — press P, or “Save where I am”, to remember a place.';
    list.appendChild(n);
    return;
  }
  spots.forEach((sp,i)=>{
    const row=document.createElement('div');
    row.className='spot-row';
    row.innerHTML=`<span class="sp-badge">${i+1}</span>` +
      `<button class="sp-name"></button><button class="sp-x" title="Forget this spot">✕</button>`;
    const nameBtn=row.querySelector('.sp-name');
    nameBtn.textContent = sp.name + (sp.elevFt==null ? '' : ' · '+Math.round(sp.elevFt).toLocaleString()+' ft');
    nameBtn.addEventListener('click', ()=> placeAtSpot(sp));
    row.querySelector('.sp-x').addEventListener('click', ()=>{ removeSpot(sp.id); renderSpotList(); });
    list.appendChild(row);
  });
}

/* togglePanel is gone -- see src/trails/panes.js. It had to reason about two resting
   states (open in the lobby, closed during a walk) across two class names, and it ended
   by scheduling a resize because the panel used to be in the stage's flex flow. The
   drawer overlays in both states, so there is one resting state and nothing to resize. */
/* WHERE A WALK STARTS WHEN NOBODY HAS PICKED YET.

   "Surprise me" is gone: it was a button that answered a spatial question with a dice
   roll, on a sheet whose whole point is that you can see where everything is. What it was
   really covering for is that the game used to open with no walk at all, so SOMETHING had
   to get you moving. Starting a walk automatically removes the need, and the map goes
   back to being a map.

   Not head 0, and not random. Head 0 is whichever dead-end the survey file happened to
   list first, which on the default map is as likely to be a stub in a corner as anything
   else; random makes every reload a different game and gives the walker no idea where
   they are. The trailhead nearest the middle of the network is the one with trail leading
   away from it in the most directions -- the best first thirty seconds, and the same
   thirty seconds every time, which is also what makes it testable. */
function pickDefaultHead(){
  const heads=getTrailheads();
  if(!heads.length) return 0;
  const bb=getBBox();
  const cx=(bb.minx+bb.maxx)/2, cz=(bb.minz+bb.maxz)/2;
  let best=0, bd=Infinity;
  heads.forEach((h,i)=>{
    const d=Math.hypot(h.x-cx, h.z-cz);
    if(d<bd){ bd=d; best=i; }
  });
  return best;
}

/* --- map stats + trail list (Trail map card) ---
   Computed straight from the graph rebuildWorld() already built -- no separate tally
   kept in sync by hand, so this can never drift from what's actually on screen. */
function renderMapStats(){
  const box=$('#mapStats'), list=$('#trailList');
  const g=getGraph();
  if(!box) return;
  if(!g || !g.edges.length){ box.innerHTML=''; if(list) list.innerHTML=''; return; }
  /* Counted by ROUTE, not by name and not by edge. An edge is a fragment between two of
     splitT's cuts, so "316 segments" tells a walker nothing; a name can be an invented
     SPUR_NAMES label shared by a dozen unrelated paths, so counting names both overstates
     the unnamed ones and understates them at the same time. A route is one path. */
  const routes=new Map();
  g.edges.forEach(e=>{ if(!routes.has(e.route)) routes.set(e.route, e); });
  const named=[...routes.values()].filter(e=>e.named);
  const unnamed=routes.size-named.length;
  const km=g.edges.reduce((s,e)=>s+(e.lenM||0),0)/1000/Math.max(1e-6,getMapScale());
  const mix=getPathMix();
  box.innerHTML = `${named.length} named trail${named.length===1?'':'s'}` +
    (unnamed?` · ${unnamed} unnamed connector${unnamed===1?'':'s'}`:'') + `<br>` +
    `${mix.forks} fork${mix.forks===1?'':'s'} · ${mix.crossings} crossing${mix.crossings===1?'':'s'} · ` +
    `${getTrailheads().length} trailhead${getTrailheads().length===1?'':'s'}<br>` +
    `${km.toFixed(1)} km of real trail` +
    (mix.buried?`<span class="flat">${mix.buried} stretch${mix.buried===1?'':'es'} share a road — waymarked, not repaved</span>`:'') +
    `<span class="flat">${hasBundle()?'elevation from DEM bundle':'flat — no elevation (Z) in this file'}</span>`;
  if(list){
    list.innerHTML='';
    /* PER-ROUTE STATS, which means the edges have to be gathered back up first. splitT
       cuts a path into a fragment per junction, so `named` holds one representative edge
       each and the length beside a trail's name would be the length of whichever fragment
       happened to be first -- a few dozen metres of a four-kilometre trail. Summing the
       route's own edges is the only figure a walker would recognise as "how long is it".

       Relief is measured on the route's geometry in world units and handed worldElevAt,
       which reads the raw DEM in real metres: see courseElevAt above on why the drawn
       terrain is the wrong thing to sample. */
    const byRoute = new Map();
    g.edges.forEach(e=>{
      if(!byRoute.has(e.route)) byRoute.set(e.route, []);
      byRoute.get(e.route).push(e);
    });
    const k = Math.max(1e-6, getMapScale());
    named.sort((a,b)=>a.name.localeCompare(b.name)).forEach(e=>{
      const part = byRoute.get(e.route) || [e];
      const lenM = part.reduce((sum,x)=>sum+(x.lenM||0),0)/k;
      // stitched end to end: the fragments of one route are contiguous, so this is the
      // profile a walker following the signs would actually climb
      const line = [];
      part.forEach(x=>{ (x.pts||[]).forEach(q=>line.push(q)); });
      const rel = polyRelief(line, worldElevAt);
      const row=document.createElement('div');
      row.className='tl-row';
      row.innerHTML=`<span class="tl-dot" style="background:${e.color}"></span>`;
      row.appendChild(document.createTextNode(e.name));
      const stat=document.createElement('span');
      stat.className='tl-stat';
      stat.textContent = fmtCourseLen(lenM) + (fmtRelief(rel) ? ' \u00b7 ' + fmtRelief(rel) : '');
      row.appendChild(stat);
      list.appendChild(row);
    });
    if(unnamed){
      const row=document.createElement('div');
      row.className='tl-row';
      // deliberately NOT twelve rows of invented names: they are connectors, and listing
      // them as trails is what made the signage confusing in the first place
      row.innerHTML=`<span class="tl-dot" style="background:#b9ae97"></span>`;
      row.appendChild(document.createTextNode(`${unnamed} unnamed connector${unnamed===1?'':'s'}`));
      list.appendChild(row);
    }
  }
}

/* Everything that has to change when the MAP changes, in one call. Saved pins are filed
   per map (see spots.js), so loading a different bundle has to re-read them before any of
   the three renderers below draws a stale list. */
function refreshMapUI(){
  setSpotMap(getMapId());
  setCourseMap(getMapId());
  /* A course traced somewhere else is not raceable here, so anything pointing at one from
     the old map is dropped rather than left to draw a line across a network it was never
     recorded on. */
  quitRace();
  previewCourse = null;
  recPending = null;
  rec.on = false; rec.pts.length = 0; rec.lenM = 0;
  showHereIdle();             // a trailhead index or course from the old map means nothing
  renderMapStats();
  renderSpotList();
  renderCourseUI();
  syncCourseOverlay();
}

/* --- loaded GeoJSON file chips ---
   Purely a panel display concern -- world.js's own EXTRA array has no notion of which
   file a feature came from (features from every dropped file get merged for rendering),
   so this keeps its own lightweight {name, count} record just for the chip list.
   Removing a chip removes ONLY that file's features and rebuilds from what's left,
   which is why it re-adds every REMAINING file's layer rather than trying to subtract
   in place -- addLayers/rebuildWorld have no notion of removal either. */
let loadedFiles=[];   // [{name, count, layer}]
function renderFileChips(){
  const wrap=$('#fileChips'); if(!wrap) return;
  wrap.innerHTML='';
  const dots=['var(--blue)','var(--green)','var(--pink)','var(--orange)'];
  loadedFiles.forEach((f,i)=>{
    const chip=document.createElement('div');
    chip.className='file-chip';
    chip.innerHTML=`<span class="fc-dot" style="background:${dots[i%dots.length]}"></span>` +
      `<span class="fc-name">${f.name}</span><span class="fc-count">${f.count}</span>` +
      `<button class="fc-x" title="Remove">✕</button>`;
    chip.querySelector('.fc-x').addEventListener('click', ()=>{
      loadedFiles.splice(i,1);
      clearLayers();
      if(loadedFiles.length) addLayers(loadedFiles.map(f=>f.layer));
      renderFileChips(); refreshMapUI();
      if(getGraph()) placeAtHead(pickDefaultHead());
    });
    wrap.appendChild(chip);
  });
}

$('#saveCombinedBtn')?.addEventListener('click', ()=>{
  if(!loadedFiles.length){ console.warn('no loaded GeoJSON layers to save'); return; }
  const combined = loadedFiles.length===1 ? loadedFiles[0].layer : {
    type:'FeatureCollection',
    features: loadedFiles.flatMap(f=>f.layer.features||[]),
  };
  const blob=new Blob([JSON.stringify(combined)], {type:'application/geo+json'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url; a.download='combined.geojson';
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
});

async function boot(bundleUrl){
  loadKennel();
  renderThemePicker();
  renderPupToggle();
  wireScale();
  // the callback lets the full-sheet map hand back "which trailhead got tapped" without
  // minimap.js needing to know anything about players, avatars or cameras
  // the sheet hands back BOTH kinds of pick without knowing anything about players,
  // avatars or cameras -- a trailhead index, or a saved spot
  /* A PICK LOADS; A BUTTON STARTS.

     Picking used to place the player and start walking outright, because the map was the
     only way into a walk and so a pick had to do the starting as well as the choosing.
     That held while a trailhead was just a letter. It stopped holding once there was
     anything worth reading about one: you cannot read the elevation of a place you have
     already been moved to, and a walk you did not mean to start costs you the one you were
     already in. So a trailhead pick now fills the details card and the card carries the
     button.

     Saved pins still go straight there, and that asymmetry is deliberate rather than an
     oversight: a pin is a place YOU chose and named, so there is nothing to tell you about
     it that you do not already know -- the whole point of dropping one is to come back. */
  /* The drawer is wired before the map loads, so the settings pane is reachable even on
     the failure path below -- a walker whose world did not load needs the pane that has
     the "load a map" controls in it, and that used to be the one thing a broken boot
     could not open. */
  initPanes({ onChange: () => updateTrailHud() });
  initMinimap({
    onTrailhead: i => showHereHead(i),
    onSpot: sp => { placeAtSpot(sp); if(!playing) enterPlay(); showPane(null); },
  });
  await loadMap(bundleUrl || DEFAULT_WORLD, !bundleUrl);
  renderRoster();
  refreshMapUI();
  // seat an avatar unconditionally. With a map that means the chosen trailhead; without
  // one, the middle of an empty world -- either way you can see who you picked, which is
  // what tells you the roster works when the map does not.
  placeAtHead(pickDefaultHead());
  resize();
  /* Then just start walking. Opening on a static lobby meant the first thing every new
     player had to do was find the 🗺 button and understand that tapping a lettered badge
     was how a game begins -- a tutorial step in front of a game with no other tutorial
     steps. You now land on a trail, facing down it, and the map is where you go when you
     want to be SOMEWHERE ELSE, which is what a map is for.

     Guarded on the graph: with no map loaded there is nothing to walk on, and the lobby
     is the right place to be told the map failed rather than standing in an empty void. */
  /* No graph means no trail to stand on, so there is no walk to start. Open settings
     rather than leaving a lobby with nothing on it: that pane holds the drop zone, the
     bundle picker and #mapNote, which is where loadMap has just written what went wrong. */
  if(getGraph()) enterPlay();
  else showPane('settings');
  requestAnimationFrame(loop);
}

/* One place that loads a map by URL, so the boot path, the reload button and any future
   map list all report success and failure identically. */
async function loadMap(url, isDefault){
  const note=$('#mapNote');
  if(note) note.textContent='Loading map…';
  try{
    await loadWorld(url, [], 3);
    if(note) note.textContent = (isDefault?'Default map: ':'Loaded: ')+url.split('/').pop()
      + ` · ${getTrailheads().length} trailhead${getTrailheads().length===1?'':'s'}`;
    return true;
  }catch(err){
    console.error('could not load world:', url, err);
    if(note) note.textContent = isDefault
      ? 'Default map could not load — serve the repo over http (python3 build.py --serve), or pick a bundle below.'
      : 'That map could not be loaded — see the console.';
    return false;
  }
}

$('#defaultMapBtn')?.addEventListener('click', async ()=>{
  // the default map is a DEM bundle, not dropped GeoJSON files -- it doesn't belong in
  // the file-chip list, and replaces whatever chips/EXTRA layers were there
  loadedFiles=[];
  renderFileChips();
  if(await loadMap(DEFAULT_WORLD, true)){ refreshMapUI(); placeAtHead(pickDefaultHead()); }
});
tapBtn($('#touchBarkBtn'), doBark);
tapBtn($('#tJump'), trailJump);
tapBtn($('#tSneak'), toggleSneak);
/* Bark and save-spot have no HUD buttons any more -- B and P, plus "Save where I am" on
   the map sheet. The optional-chaining is what makes removing them from the HTML a
   one-file change rather than a two-file one. */
$('#barkBtn')?.addEventListener('click', doBark);
$('#saveSpotBtn')?.addEventListener('click', saveHere);
$('#mapSaveSpotBtn')?.addEventListener('click', ()=>{ saveHere(); });

/* The record control is ONE button with two jobs, because "record" and "stop" are the same
   decision seen from either side of it and two buttons would leave one of them dead at any
   moment. The stop chip on the HUD is the same call again: a walker who started recording
   and walked off has no reason to reopen the map sheet just to stop. */
$('#recStartBtn')?.addEventListener('click', ()=>{
  if(getRecState().on) stopRecording(); else startRecording();
});
tapBtn($('#recStop'), ()=> stopRecording());
$('#recSaveBtn')?.addEventListener('click', ()=>{
  const el = $('#recName');
  saveRecording(el ? el.value : null);
  if(el){ el.value=''; el.dataset.touched=''; }
});
$('#recDropBtn')?.addEventListener('click', ()=>{
  const el = $('#recName');
  if(el){ el.value=''; el.dataset.touched=''; }
  discardRecording();
});
// once the walker has typed, renderCourseUI stops overwriting the field -- otherwise the
// per-frame refresh during a recording would eat every keystroke
$('#recName')?.addEventListener('input', e=>{ e.target.dataset.touched = '1'; });
// keyup as well as keydown: the walk's key table is a set of held keys, so swallowing only
// the press would leave every letter typed here stuck down for the rest of the walk
$('#recName')?.addEventListener('keyup', e=> e.stopPropagation());
$('#recName')?.addEventListener('keydown', e=>{
  e.stopPropagation();                       // W/A/S/D in a text field must type, not walk
  if(e.key === 'Enter'){
    const el = $('#recName');
    saveRecording(el ? el.value : null);
    if(el){ el.value=''; el.dataset.touched=''; }
  }
});
$('#ghostMode')?.addEventListener('click', e=>{
  const b = e.target.closest('button');
  if(b && b.dataset.ghost) setGhostMode(b.dataset.ghost);
});
$('#raceQuit')?.addEventListener('click', ()=> quitRace());
$('#raceAgain')?.addEventListener('click', ()=>{
  const c = getRaceState().course;
  closeRaceCard();
  if(c) startRace(c);
});
$('#raceDone')?.addEventListener('click', ()=> closeRaceCard());
/* Every door into the drawer -- the two edge tabs, the two header tabs and the one ✕ --
   is wired inside panes.js, which owns the state they set. */

$('#playBtn')?.addEventListener('click', enterPlay);
$('#exitBtn')?.addEventListener('click', exitPlay);
$('#arrStay')?.addEventListener('click', closeArrival);
$('#arrFinish')?.addEventListener('click', exitPlay);
$('#clearLayersBtn')?.addEventListener('click', ()=>{
  loadedFiles=[];
  clearLayers();
  renderFileChips(); refreshMapUI();
});

$('#worldFile')?.addEventListener('change', async e=>{
  const files=[...e.target.files];
  e.target.value='';
  await loadFiles(files);
});
$('#pupFile')?.addEventListener('change', async e=>{
  const files=[...e.target.files];
  e.target.value='';
  let n=0;
  for(const f of files) n += addPups(parsePupFile(await f.text()));
  renderRoster();
  if(!n) console.warn('no pups found in that file');
});

/* Drag-and-drop onto the dropzone -- the <label for="worldFile"> already gives tap-to-
   browse for free, this adds the other half. dragover must preventDefault or the
   browser's own "navigate to the dropped file" handling wins instead of firing `drop`. */
const dropzone=$('#dropzone');
if(dropzone){
  ['dragenter','dragover'].forEach(evt=>
    dropzone.addEventListener(evt, e=>{ e.preventDefault(); dropzone.classList.add('hover'); }));
  ['dragleave','drop'].forEach(evt=>
    dropzone.addEventListener(evt, e=>{ e.preventDefault(); dropzone.classList.remove('hover'); }));
  dropzone.addEventListener('drop', e=>{
    const files=[...(e.dataTransfer?.files||[])];
    if(files.length) loadFiles(files);
  });
}

/* One picker for everything. A pup-world/1 bundle, a plain .geojson and a
   backyard-pups.json are all just JSON, so detect by content rather than by extension --
   QGIS writes .geojson, fetch_dem.py writes .json, and users rename both. Layers are
   batched so dropping trails + areas together rebuilds once, not twice. */
async function loadFiles(files){
  if(!files.length) return;
  const layers=[];
  let gotPups=0;
  for(const f of files){
    let obj;
    try{ obj=JSON.parse(await f.text()); }
    catch(err){ console.error('not valid JSON:',f.name,err); continue; }
    if(obj && obj.format==='pup-world/1'){
      try{ await loadWorld(obj, [], 3); }
      catch(err){ console.error('bad world bundle:',f.name,err); }
    }else if(obj && (obj.type==='FeatureCollection' || obj.type==='Feature')){
      const layer = obj.type==='Feature' ? {type:'FeatureCollection',features:[obj]} : obj;
      layers.push(layer);
      // chip tracking is separate from EXTRA (world.js has no per-file memory of what it
      // merged) -- record name+count here purely for the panel's own display
      loadedFiles.push({name:f.name, count:(layer.features||[]).length, layer});
    }else if(obj && (obj.backyardPups || obj.pups || obj.furColor)){
      gotPups += addPups(parsePupFile(obj));
    }else{
      console.error('unrecognised file (expected a pup-world/1 bundle, GeoJSON or a pup file):', f.name);
    }
  }
  if(layers.length){ addLayers(layers); renderFileChips(); }
  if(gotPups) renderRoster();
  if(!getGraph()) return;
  refreshMapUI();
  placeAtHead(pickDefaultHead());
}

/* Test seams. build.py flattens every module into one classic script, where top-level
   `let`/`const` bindings are NOT reachable from outside but function declarations are --
   so tools/smoke.js can call getGraph() but could never see `playing` or `player`. These
   three exist so the harness can drive and inspect a walk without main.js having to
   promote its state to globals. */
function trailIsPlaying(){ return playing; }
function getTrailPlayer(){ return player; }
function getTripState(){ return trip; }

function getOnTrail(){ return onTrail; }

/* The course machinery gets the same treatment for the same reason: `rec`, `race` and
   `previewCourse` are top-level bindings that vanish into the bundle's one scope, so the
   harness reaches them through calls. */
function getRecState(){ return rec; }
function getRaceState(){ return race; }
function getPendingRecording(){ return recPending; }
function getPreviewCourse(){ return previewCourse; }

export { boot, enterPlay, exitPlay, placeAtHead, placeAt, placeAtSpot, saveHere, doBark,
         trailIsPlaying, getTrailPlayer, getTripState, getOnTrail,
         startRecording, stopRecording, saveRecording, discardRecording, startRace,
         quitRace, finishRace, toggleCourseShown, renderCourseUI, renderCourseList,
         avatarName, raceFrozen, isRaceCardOpen, closeRaceCard, syncCourseOverlay,
         getRecState, getRaceState, getPendingRecording, getPreviewCourse,
         getGhostMode, setGhostMode, armGhost, fmtRelief, courseElevAt, worldElevAt,
         showHereHead, showHereCourse, showHereIdle, refreshHere, getHereSubject };

// auto-boot from a `?world=` query param, or wait for the panel's own load button
{
  const q = new URLSearchParams(location.search).get('world');
  boot(q || null);
}
