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
import { updateNoiseRing, setNoiseRingVisible, noiseRingRadius } from './noise-ring.js';
import { getWorld } from './terrain.js';

import { addCamPitch, addCamYaw, addCamZoom, getCamPitch, getCamYaw, getCamZoom, setCamYaw, snapChaseCam, updateChaseCam } from './camera.js';
import { getCritterStats, spawnCritters, resetCritters, updateCritters, WATCH_SECONDS, playerNoise, typicalSpookRadius } from './critters.js';
import { initMinimap, isBigMapOpen, toggleBigMap, updateMinimap } from './minimap.js';
import { comicBurst, updateFX } from '../core/fx.js';
import { cheerBlip, initAudio } from '../core/audio.js';

import { addLayers, clearLayers, getBBox, getBackdrop, getContourStep, getExaggeration, getFogMultiplier, getGraph, getMapScale, getPOIs, hasBundle, getStartHead, getTrailheads, getVertScale, loadWorld, setContourStep, setFogMultiplier, setMapScale, setStartHead, setThemeById, setVertScale, standingY } from './world.js';

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
                 /* climbT counts DOWN while the pup is scrambling up a step. It is set
                    only by an on-foot step-up (see moveOffTrail) -- never by a jump,
                    which is the whole point: jumping a ledge is the fast way over it and
                    costs nothing, walking up one costs you speed. */
                 climbT:0, climbAmt:0 };
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
const trip = { startT:0, parked:-1, paused:false, landmarks:[] };
let playing=false;
/* Timestamp of the last manual look-drag (performance.now(), not the loop's own `t` --
   pointer events fire outside the loop). While recent, the auto-follow below backs off
   so it doesn't fight a hand that's actively orbiting the camera. */
let lastLookT=-Infinity;
let avatarKey='';           // identity of whatever is currently built, for ensureAvatar

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

function syncAvatar(dt, t, jumpY, speed, sneaking, barking, run){
  // standingY, not terrainY: it is the ONE definition of "what am I standing on",
  // shared with the critters and with everything world.js plants on a path. Off-trail it
  // is plain terrain; on-trail it reads the tread's own profile out of the spatial hash,
  // so the avatar can't clip through the ribbon inside the short ramps at a terrace step.
  const groundY = standingY(player.x, player.z);
  // eased 0..1: full while the scramble timer runs, decaying once it expires, so the
  // pose settles back into the walk instead of popping flat the instant the step is done
  const climb = player.climbT > 0 ? player.climbAmt : 0;
  /* Airborne: 1 once the pup is clear of the ground, so the drivers can hold a leap
     spread instead of running in mid-air. The threshold is a hair above zero because
     `player.y` is exactly 0 while grounded (the gravity clamp guarantees it) -- anything
     larger would miss the start of a hop, and anything smaller would flicker on the
     frame it lands. `rise` is vertical velocity normalised, so the pose knows whether it
     is still going up or already reaching for the landing. */
  const leap = jumpY > 0.02 ? 1 : 0;
  const rise = clamp(player.vy/7, -1, 1);
  let radius = 0.5;
  if(mode==='dog'){
    setDogPos(player.x, player.z);
    setYaw(player.yaw);
    updateDog(dt, t, groundY, jumpY, speed, sneaking, barking, run, climb, leap, rise);
    radius = dogShadowRadius();
  }else{
    wildPos.set(player.x, 0, player.z);
    setWildYaw(player.yaw);
    updateWild(dt, t, groundY, jumpY, speed, sneaking, barking, climb, leap, rise);
    radius = wildShadowRadius();
  }
  updateShadow(player.x, player.z, groundY, jumpY, radius, true);
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

function moveOffTrail(stepX, stepZ){
  const lim = stepUpLimit();
  const gHere = standingY(player.x, player.z);
  const feet = gHere + player.y;
  const tryMove = (dx, dz)=>{
    if(!dx && !dz) return false;
    const nx=player.x+dx, nz=player.z+dz;
    const gThere = standingY(nx, nz);
    const rise = gThere - gHere;
    // walkable if it is at most a single step up, or if we are already airborne high
    // enough to clear it -- which is precisely what makes jumping the answer to a ledge
    const airborneOver = feet >= gThere - 0.05;
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
     Math.abs(standingY(player.x+stepX, player.z+stepZ) - standingY(player.x, player.z)) <= stepUpLimit()){
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
  if(!playing) return;
  // while the arrival card is up only Escape does anything -- barking or jumping through
  // a summary screen you can't see the effect of is just confusing
  if(trip.paused){
    if(e.code==='Escape') closeArrival();
    return;
  }
  if(e.code==='Space'){ e.preventDefault(); if(player.y===0) player.vy=9.5; }
  if(e.code==='KeyC') player.sneaking=!player.sneaking;
  if(e.code==='KeyB'){ initAudio(); player.barkT=1; }
  if(e.code==='KeyM') toggleBigMap();
  // Esc closes the map first if it's open -- quitting the whole walk because you wanted
  // to put the map away is the kind of thing you only forgive once
  if(e.code==='Escape'){ if(isBigMapOpen()) toggleBigMap(false); else exitPlay(); }
});
addEventListener('keyup', e=> trailKeys[e.code]=false);

/* Two independent pointer zones, split by which half of the canvas a drag STARTS in --
   the standard twin-stick split (move on one side, look on the other), which needs no
   touch/mouse detection and works the same for a mouse drag as for two thumbs. Each zone
   tracks its own pointer id, so one finger on each half works simultaneously; a mouse
   only ever occupies one at a time, which is fine since WASD covers movement for it. */
const stick = {active:false,id:null,dx:0,dy:0};
const look  = {active:false,id:null,lastX:0,lastY:0};
const YAW_SENS=0.0055, PITCH_SENS=0.0042;

renderer.domElement.addEventListener('pointerdown', e=>{
  if(!playing) return;
  const rect=renderer.domElement.getBoundingClientRect();
  const rightHalf = (e.clientX-rect.left) > rect.width*0.5;
  if(rightHalf && !look.active){
    look.active=true; look.id=e.pointerId; look.lastX=e.clientX; look.lastY=e.clientY;
  }else if(!rightHalf && !stick.active){
    stick.active=true; stick.id=e.pointerId; stick.ox=e.clientX; stick.oy=e.clientY; stick.dx=stick.dy=0;
  }
});
addEventListener('pointermove', e=>{
  if(stick.active && e.pointerId===stick.id){
    let dx=e.clientX-stick.ox, dy=e.clientY-stick.oy;
    const L=Math.hypot(dx,dy), max=52;
    if(L>max){dx*=max/L;dy*=max/L;}
    stick.dx=dx/max; stick.dy=dy/max;
  }else if(look.active && e.pointerId===look.id){
    const dx=e.clientX-look.lastX, dy=e.clientY-look.lastY;
    look.lastX=e.clientX; look.lastY=e.clientY;
    addCamYaw(-dx*YAW_SENS);
    addCamPitch(-dy*PITCH_SENS);
    lastLookT = performance.now();
  }
});
const endPointer=e=>{
  if(stick.active&&e.pointerId===stick.id){ stick.active=false; stick.dx=stick.dy=0; }
  if(look.active&&e.pointerId===look.id){ look.active=false; }
};
addEventListener('pointerup', endPointer); addEventListener('pointercancel', endPointer);

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
  const fS=Math.sin(getCamYaw()), fC=Math.cos(getCamYaw());
  const wx=-fC*ix-fS*iz, wz=fS*ix-fC*iz;
  const moving=mag>0.03&&(wx||wz);

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
  const surf = nearTrail ? 1 : 0.6;
  if(player.climbT > 0) player.climbT = Math.max(0, player.climbT - dt);
  // scrambling drags the top speed down; it does NOT touch the jump, which is what makes
  // "jump the big steps" the faster line through broken ground
  const climbDrag = player.climbT > 0 ? CLIMB_SLOW : 1;
  const top = currentTopSpeed()*(player.sneaking?0.5:(run?currentRunMul():1))*surf*climbDrag*(stick.active?mag:1);
  player.speed = lerp(player.speed, moving?top:0, 1-Math.pow(0.0009,dt));
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
  player.vy-=26*dt; player.y=Math.max(0,player.y+player.vy*dt);
  if(player.y===0) player.vy=Math.max(0,player.vy);
  player.barkT=Math.max(0,player.barkT-dt*2);

  const groundY = syncAvatar(dt,t,player.y,player.speed,player.sneaking,player.barkT>0,run);

  /* Boom length. Pulled in from 11 to 8.5: the pup is only about a metre nose to tail at
     TRAIL_DOG_SCALE, and from 11 m back it was a small shape in a large landscape. */
  updateChaseCam(dt, player.x, player.z, groundY, player.y, player.speed, getVertScale(), 8.5);

  updateCritters(dt, t, player.x, player.z, player.speed, noiseReference(),
                 player.sneaking, player.barkT>0);
  /* Same call the critters just used, so the circle on the ground is the rule they are
     actually being judged by rather than a second guess at it. */
  updateNoiseRing(dt, player.x, player.z,
                  playerNoise(player.speed, noiseReference(), player.sneaking, player.barkT>0),
                  typicalSpookRadius(), standingY, true);
  updateAreaLabels(camera.position.x, camera.position.y, camera.position.z);
  updateFX(dt, t);
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
    if(nh.d < 5 && player.dist > 20 && trip.parked !== nh.i){
      trip.parked = nh.i;
      showArrival(nh.i);
    }
  }

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
  playing=true;
  document.body.classList.add('play');
  updateTrailHud();
}
function exitPlay(){
  playing=false;
  trip.paused=false;
  toggleBigMap(false);
  closeArrival();
  resetCritters();
  document.body.classList.remove('play');
  placeAtHead(getStartHead());
}

/* ---------- trailhead arrival ---------- */

/* Deliberately legible rather than tuned: distance is the base, watching an animal is
   worth about 300 m of walking, a landmark about 200, and spooking something costs a
   little. The point is that a slow, quiet walk out-scores a fast noisy one. */
function tripScore(st){
  return Math.max(0, Math.round(
    player.dist*0.2 + st.sightings*60 + trip.landmarks.length*40 - st.spooked*10));
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
  set('#arrSub', 'The ' + th.where + ' trailhead \u2014 rest here or head back out.');
  set('#arrScore', tripScore(st));
  // same conversion as the HUD, or the summary would contradict the number the player
  // watched tick up for the whole walk
  set('#arrDist', formatTravelled(realMetres(player.dist)));
  set('#arrTime', Math.floor(secs/60)+':'+String(secs%60).padStart(2,'0'));
  set('#arrSeen', st.sightings);
  set('#arrSpooked', st.spooked);

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

  const elev = $('#hudElev');
  if(elev){
    const ft = elevationFt(player.x, player.z);
    elev.textContent = ft==null ? '\u26f0 \u2014' : '\u26f0 ' + Math.round(ft).toLocaleString() + ' ft';
  }
  const dist = $('#hudDist');
  if(dist) dist.textContent = '\ud83d\udc63 ' + formatTravelled(realMetres(player.dist));
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
    const n = playerNoise(player.speed, noiseReference(), player.sneaking, player.barkT>0);
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
  b.addEventListener('click', ()=>{ onClick(); renderRoster(); placeAtHead(getStartHead()); });
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
  renderPupToggle(); renderRoster(); placeAtHead(getStartHead());
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
      placeAtHead(getStartHead());     // rebuild dropped the old scene; re-seat the player
    });
    grid.appendChild(b);
  });
}

/* --- scale ---
   All three sliders below can rebuild the world, which is expensive, so the label
   updates on `input` and the rebuild only fires on `change` (pointer release /
   arrow-key commit) -- except fog, which is cheap enough to apply live (see below). */
function wireScale(){
  /* World scale, shown as "1 : N" (N = 1..1000, matching real map-scale notation --
     N=1 is true size, bigger N is more compacted) rather than the old "0.25x..2x"
     multiplier. N spans three orders of magnitude, so the <input type=range> itself
     runs over a plain 0..1000 "slider position" and is mapped through log10 rather than
     used as N directly -- linear would put every value between 1:1 and 1:50 (the range
     most trail networks actually need) into the first 5% of the handle's travel. */
  const map=$('#worldScale'), mapV=$('#worldScaleVal');
  /* Full 1:1 .. 1:1000. Elevation no longer compacts alongside the footprint, so heavy
     compaction genuinely steepens the country -- the Hill exaggeration slider (which now
     reaches 0) is the counterweight, rather than the range being clipped for you. */
  const posToN = t => Math.max(1, Math.round(Math.pow(10, t/1000*3)));   // 0..1000 -> 1..1000
  const nToPos = n => clamp(Math.log10(Math.max(1,n))/3*1000, 0, 1000);  // inverse of posToN
  if(map && mapV){
    map.min=0; map.max=1000; map.step=1;
    map.value=nToPos(Math.round(1/getMapScale()));
    const show=n=>{ mapV.textContent = '1 : '+n; };
    show(posToN(map.value));
    map.addEventListener('input', e=> show(posToN(+e.target.value)));
    map.addEventListener('change', e=>{
      setMapScale(1/posToN(+e.target.value));
      show(Math.round(1/getMapScale()));
      placeAtHead(getStartHead());
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
      placeAtHead(getStartHead());
    });
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
      placeAtHead(getStartHead());
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

function renderStartPicker(){
  const list=$('#startList'); if(!list) return;
  const heads=getTrailheads();
  list.innerHTML='';
  const surprise=$('#surpriseBtn');
  if(!heads.length){
    list.innerHTML='<p class="hint">— load a map first —</p>';
    if(surprise) surprise.disabled=true;
    return;
  }
  if(surprise) surprise.disabled=false;
  const current=getStartHead();
  heads.forEach((h,i)=>{
    const b=document.createElement('button');
    b.className='headcard'+(i===current?' sel':'');
    b.innerHTML=`<span class="hc-badge">${headLetter(i)}</span>` +
      `<span class="hc-text"><span class="hc-name">${h.name}</span>` +
      `<span class="hc-sub">${h.where} end${h.lenM?` · ${Math.round(h.lenM)} m to the next fork`:''}</span></span>`;
    b.addEventListener('click', ()=> placeAtHead(i));
    list.appendChild(b);
  });
}
$('#surpriseBtn')?.addEventListener('click', ()=>{
  const n=getTrailheads().length; if(!n) return;
  placeAtHead(Math.floor(Math.random()*n));
});

/* --- map stats + trail list (Trail map card) ---
   Computed straight from the graph rebuildWorld() already built -- no separate tally
   kept in sync by hand, so this can never drift from what's actually on screen. */
function renderMapStats(){
  const box=$('#mapStats'), list=$('#trailList');
  const g=getGraph();
  if(!box) return;
  if(!g || !g.edges.length){ box.innerHTML=''; if(list) list.innerHTML=''; return; }
  const names=new Set(g.edges.map(e=>e.name));
  const km=g.edges.reduce((s,e)=>s+(e.lenM||0),0)/1000;
  const junctions=g.nodes.filter(n=>n.deg>=3).length;   // matches world.js's own sign condition
  box.innerHTML = `${names.size} named trail${names.size===1?'':'s'} · ${g.edges.length} segment${g.edges.length===1?'':'s'}<br>` +
    `${junctions} signed junction${junctions===1?'':'s'} · ${getTrailheads().length} trailhead${getTrailheads().length===1?'':'s'}<br>` +
    `${km.toFixed(1)} km of real trail` +
    `<span class="flat">${hasBundle()?'elevation from DEM bundle':'flat — no elevation (Z) in this file'}</span>`;
  if(list){
    list.innerHTML='';
    [...names].sort().forEach(name=>{
      const e=g.edges.find(e=>e.name===name);
      const row=document.createElement('div');
      row.className='tl-row';
      row.innerHTML=`<span class="tl-dot" style="background:${e?e.color:'#999'}"></span>${name}`;
      list.appendChild(row);
    });
  }
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
      renderFileChips(); renderStartPicker(); renderMapStats();
      if(getGraph()) placeAtHead(0);
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
  initMinimap(i => placeAtHead(i));
  await loadMap(bundleUrl || DEFAULT_WORLD, !bundleUrl);
  renderRoster();
  renderStartPicker();
  renderMapStats();
  // seat an avatar unconditionally. With a map that means the chosen trailhead; without
  // one, the middle of an empty world -- either way you can see who you picked, which is
  // what tells you the roster works when the map does not.
  placeAtHead(getStartHead());
  resize();
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
  if(await loadMap(DEFAULT_WORLD, true)){ renderStartPicker(); renderMapStats(); placeAtHead(0); }
});
$('#mapBtn')?.addEventListener('click', ()=> toggleBigMap());
$('#bigmapClose')?.addEventListener('click', ()=> toggleBigMap(false));
// mobile only (see trails.css's body.nopanel rule): slides the options panel off-screen
// so the live pup/minimap preview underneath is reachable without leaving the setup
// screen. Desktop never shows this button (icon.btn is display:none above 760px).
$('#panelBtn')?.addEventListener('click', ()=>{
  document.body.classList.toggle('nopanel');
  setTimeout(resize, 380);
});

$('#playBtn')?.addEventListener('click', enterPlay);
$('#exitBtn')?.addEventListener('click', exitPlay);
$('#arrStay')?.addEventListener('click', closeArrival);
$('#arrFinish')?.addEventListener('click', exitPlay);
$('#clearLayersBtn')?.addEventListener('click', ()=>{
  loadedFiles=[];
  clearLayers();
  renderFileChips(); renderStartPicker(); renderMapStats();
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
  renderStartPicker();
  renderMapStats();
  placeAtHead(0);
}

/* Test seams. build.py flattens every module into one classic script, where top-level
   `let`/`const` bindings are NOT reachable from outside but function declarations are --
   so tools/smoke.js can call getGraph() but could never see `playing` or `player`. These
   three exist so the harness can drive and inspect a walk without main.js having to
   promote its state to globals. */
function trailIsPlaying(){ return playing; }
function getTrailPlayer(){ return player; }
function getTripState(){ return trip; }

export { boot, enterPlay, exitPlay, placeAtHead, trailIsPlaying, getTrailPlayer, getTripState };

// auto-boot from a `?world=` query param, or wait for the panel's own load button
{
  const q = new URLSearchParams(location.search).get('world');
  boot(q || null);
}
