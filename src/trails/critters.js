/* Wildlife you meet ON the trail -- as distinct from wild-driver.js, which is the animal
   you PLAY as. Two different jobs, so two modules: this one owns a population with its
   own AI, that one owns a single player-controlled rig.

   Not a reuse of city/animals.js, though the behaviour rhymes. That module is welded to
   downtown: pointBlocked/inWater/LEVEL/ENV for its world, play/modes for its game state,
   ui.js for its HUD, and a scoring model where scaring things IS the objective. Out here
   the objective is the opposite -- the interesting verb is getting close enough to watch
   something without it noticing, and chasing it off is the failure case you can also
   choose on purpose. What IS shared is everything that should be: the rig
   (makeAnimalModel), the alert bubble, the stats table (SPECIES) and the spook-radius
   curve (spookRadiusFor), all imported rather than re-derived.

   THE TWO VERBS
     Watch  -- hold still inside a critter's notice radius without spooking it, and a
               meter fills. Sneaking (C) roughly triples how close you can get, which is
               what makes the sneak button worth pressing on a trail.
     Chase  -- run at one, or bark, and it bolts. Counted separately from sightings,
               because the game should be able to tell you which kind of walk you had. */
import { clamp, lerp, mulberry32 } from '../core/math.js';
import { scene, disposeGroup } from '../core/render.js';
import { makeAnimalModel, makeAlert } from '../city/animal-models.js';
import { comicBurst } from '../core/fx.js';
import { cheerBlip, yipHigh } from '../core/audio.js';
import { SPECIES } from '../data/species.js';
import { spookRadiusFor } from './wild-driver.js';
import { makeShadow } from './pieces.js';
import { THEME } from './themes.js';
import { getBBox, getGraph, getMapScale, standingY } from './world.js';

const CRITTERS = [];              // live population; cleared in place, never reassigned
let sightings = 0, spooked = 0;
/* Per-species tally for the arrival screen's sightings log. A Map rather than a count on
   each critter, because a critter that flees is respawned elsewhere with its sighting
   flag cleared -- the log has to outlive the individual animal. */
const SIGHTED = new Map();
let watchBest = null;             // {name, progress 0..1} for the HUD meter, per frame

const WATCH_SECONDS = 3.2;        // how long you must hold still to bank a sighting
const POPULATION = 14;

function getCritters(){ return CRITTERS; }
function getCritterStats(){
  const log = [...SIGHTED.entries()]
    .map(([key, n]) => ({key, n, nm: (SPECIES[key]||{}).nm || key, emo: (SPECIES[key]||{}).emo || '\ud83d\udc3e'}))
    .sort((a, b) => b.n - a.n || a.nm.localeCompare(b.nm));
  return {sightings, spooked, watching: watchBest, log};
}

/* Cleared in place. Other modules (minimap.js) hold this same array reference, and
   reassigning it here would leave them reading a detached copy forever -- the repo's
   one load-bearing mutation rule, and it applies to new arrays as much as old ones. */
function resetCritters(){
  while(CRITTERS.length){
    const c = CRITTERS.pop();
    scene.remove(c.g); disposeGroup(c.g);
  }
  sightings = 0; spooked = 0; watchBest = null; SIGHTED.clear();
}

/* Somewhere plausible for an animal to be: near enough to a trail that you'll actually
   run into it, far enough off it that it isn't standing in the tread. Sampling along the
   graph rather than uniformly over the bbox matters on a real map -- a trail network
   covers a small fraction of its own bounding box, and uniform scatter puts most of the
   wildlife somewhere you will never walk. */
function pickSpot(rnd){
  const G = getGraph();
  const bb = getBBox();
  if(!G || !G.edges.length) return null;
  const S = getMapScale();
  for(let attempt = 0; attempt < 30; attempt++){
    const e = G.edges[Math.floor(rnd()*G.edges.length)];
    if(!e || e.pts.length < 2) continue;
    const i = Math.floor(rnd()*(e.pts.length-1));
    const a = e.pts[i], b = e.pts[i+1], t = rnd();
    const x0 = a[0]+(b[0]-a[0])*t, z0 = a[1]+(b[1]-a[1])*t;
    const ang = rnd()*Math.PI*2, r = (9 + rnd()*26)*S;
    const x = x0 + Math.cos(ang)*r, z = z0 + Math.sin(ang)*r;
    if(x < bb.minx || x > bb.maxx || z < bb.minz || z > bb.maxz) continue;
    return {x, z};
  }
  return null;
}

function placeCritter(key, rnd){
  const S = SPECIES[key];
  if(!S) return;
  const spot = pickSpot(rnd);
  if(!spot) return;
  const model = makeAnimalModel(key, rnd);
  model.g.scale.setScalar(S.scale);
  const alert = makeAlert();
  alert.position.y = S.scale*1.6 + 0.55;
  alert.visible = false;
  model.g.add(alert);
  // the shadow is what sells "standing on that terrace" over "hovering near it" -- the
  // same reason pieces.js built it for the POI props
  const shadow = makeShadow(0.55*S.scale);
  shadow.position.y = 0.02;
  model.g.add(shadow);
  scene.add(model.g);
  CRITTERS.push({
    key, S, g: model.g, refs: model.refs, alert,
    hopper: !!S.hopper,
    x: spot.x, z: spot.z, y: standingY(spot.x, spot.z), yaw: rnd()*6.28,
    state: 'graze', timer: rnd()*3, walkPh: rnd()*6, hop: rnd()*6,
    target: {x: spot.x, z: spot.z},
    home: {x: spot.x, z: spot.z},
    watchT: 0, sighted: false, fledT: 0,
  });
}

/* Roster comes from the theme, so a red-rock map gets bighorn and a forest gets bears --
   the same list that already drives the scenery, rather than a second parallel one. */
function spawnCritters(seed){
  resetCritters();
  const G = getGraph();
  if(!G || !G.edges.length) return;
  const rnd = mulberry32((seed|0) || 20260821);
  const roster = (THEME.wildlife && THEME.wildlife.length) ? THEME.wildlife : ['rabbit','squirrel','deer'];
  for(let i = 0; i < POPULATION; i++) placeCritter(roster[i % roster.length], rnd);
}

/* Move one critter toward a point; returns remaining distance. No obstacle map out here
   (there is no pointBlocked on a trail map), so this is a straight seek with a bbox
   clamp -- open country, nothing to steer around but the scenery. */
function seek(c, tx, tz, sp, dt){
  const dx = tx - c.x, dz = tz - c.z;
  const dist = Math.hypot(dx, dz) || 1e-4;
  const ang = Math.atan2(dz, dx);
  c.x += Math.cos(ang)*sp*dt;
  c.z += Math.sin(ang)*sp*dt;
  c.yaw = Math.atan2(-Math.sin(ang), Math.cos(ang));
  return dist;
}

function wanderTarget(c, rnd){
  const S = getMapScale();
  // *S: this is a POSITION on the compacted network, so it shrinks with it. The spook and
  // notice radii below deliberately do not -- those are distances between the pup and an
  // animal, both of which stay true size at any world scale.
  const ang = rnd()*Math.PI*2, r = (2 + rnd()*7)*S;
  return {x: c.home.x + Math.cos(ang)*r, z: c.home.z + Math.sin(ang)*r};
}

function bolt(c, px, pz){
  if(c.state === 'flee') return;
  c.state = 'flee';
  c.fledT = 0;
  const away = Math.atan2(c.z - pz, c.x - px);
  c.target = {x: c.x + Math.cos(away)*140, z: c.z + Math.sin(away)*140};
  c.alert.visible = true;
  c.watchT = 0;
  spooked++;
  yipHigh(0.7);
}

/* Per frame. `topSpeed` is the player's own top speed, so "how fast am I moving" is
   normalised against the animal you happen to be playing as -- a sprinting moose and a
   sprinting rabbit should be equally alarming. */
/* How loud you are right now. Sneaking is the whole point of the mechanic, so it gets
   the biggest single multiplier; barking overrides everything, because a bark should
   always cost you the animal you were creeping up on.

   Exported because the on-screen noise ring draws THIS number. Two copies of a rule the
   player is being shown a picture of would drift apart, and the picture would quietly
   start lying -- which is worse than not drawing it. */
function playerNoise(speed, topSpeed, sneaking, barking){
  const pace = clamp(speed/Math.max(0.1, topSpeed), 0, 1);
  return barking ? 2.4 : (sneaking ? 0.34 : 0.55 + pace*1.15);
}

/* A representative spook radius for the wildlife actually on this map, so the ring means
   something concrete rather than being a bare multiplier. Mean over the live population,
   falling back to the theme roster before anything has spawned. */
function typicalSpookRadius(){
  if(CRITTERS.length){
    let sum = 0;
    for(const c of CRITTERS) sum += spookRadiusFor(c.key);
    return sum/CRITTERS.length;
  }
  const keys = (THEME.wildlife||[]);
  if(!keys.length) return 9;
  let sum = 0;
  for(const k of keys) sum += spookRadiusFor(k);
  return sum/keys.length;
}

function updateCritters(dt, t, px, pz, speed, topSpeed, sneaking, barking){
  const rnd = Math.random;
  const S = getMapScale();
  const bb = getBBox();
  watchBest = null;

  for(let i = CRITTERS.length - 1; i >= 0; i--){
    const c = CRITTERS[i];
    const dx = c.x - px, dz = c.z - pz;
    const dist = Math.hypot(dx, dz);

    const noise = playerNoise(speed, topSpeed, sneaking, barking);
    const spookR = spookRadiusFor(c.key)*noise;
    const noticeR = spookRadiusFor(c.key)*2.4;

    if(c.state !== 'flee'){
      if(dist < spookR){
        bolt(c, px, pz);
      }else if(dist < noticeR){
        /* Watchful: it has clocked you and is standing, head up, facing you. Holding
           this state is what banks a sighting -- so the reward for sneaking is that the
           watchful window exists at all, instead of going straight to flee. */
        c.state = 'watchful';
        c.yaw = Math.atan2(dz, -dx);
        c.alert.visible = true;
        if(!c.sighted){
          c.watchT += dt;
          const p = clamp(c.watchT/WATCH_SECONDS, 0, 1);
          if(!watchBest || p > watchBest.progress) watchBest = {name: c.S.nm, progress: p};
          if(c.watchT >= WATCH_SECONDS){
            c.sighted = true;
            sightings++;
            SIGHTED.set(c.key, (SIGHTED.get(c.key)||0) + 1);
            comicBurst('✨ ' + c.S.nm + '!', c.x, c.y + c.S.scale*1.7, c.z, '#ffd94a');
            cheerBlip();
          }
        }
      }else if(c.state === 'watchful'){
        c.state = 'graze';
        c.alert.visible = false;
        c.watchT = Math.max(0, c.watchT - dt*0.6);   // decays, so you can't bank it in sips
        c.target = wanderTarget(c, rnd);
      }
    }

    if(c.state === 'flee'){
      c.fledT += dt;
      seek(c, c.target.x, c.target.z, c.S.speed*2.9, dt);
      // gone: respawn somewhere else on the network so the map doesn't slowly empty out
      if(c.fledT > 7 || dist > 130 ||
         c.x < bb.minx || c.x > bb.maxx || c.z < bb.minz || c.z > bb.maxz){
        const spot = pickSpot(rnd);
        if(spot){
          c.x = spot.x; c.z = spot.z; c.home = {x: spot.x, z: spot.z};
          c.target = {x: spot.x, z: spot.z};
        }
        c.state = 'graze'; c.fledT = 0; c.watchT = 0; c.sighted = false;
        c.alert.visible = false;
      }
    }else if(c.state === 'graze'){
      c.timer -= dt;
      if(c.timer <= 0){
        c.timer = 1.6 + rnd()*3.4;
        c.target = wanderTarget(c, rnd);
      }
      if(seek(c, c.target.x, c.target.z, c.S.speed*0.34, dt) < 0.5) c.timer = Math.min(c.timer, 0.6);
    }

    /* Ground follow. standingY is the same surface the player reads, so a critter on the
       trail stands on the tread and one beside it stands on the dirt -- and both step
       with the terraces rather than through them. Lerped rather than assigned because a
       terrace crossing is a step input here too, just a less conspicuous one. */
    const gy = standingY(c.x, c.z);
    c.y = lerp(c.y, gy, 1 - Math.pow(0.0008, dt));

    const still = c.state === 'watchful' || (c.state === 'graze' && c.timer > 0.6 && rnd() < 0);
    const fleeing = c.state === 'flee';
    if(c.hopper){
      c.hop += dt*(fleeing ? 11 : 2.4);
      c.g.position.set(c.x, c.y + (still ? 0 : Math.abs(Math.sin(c.hop))*0.22*c.S.scale), c.z);
    }else{
      if(!still) c.walkPh += dt*(fleeing ? 13 : 4);
      const amp = still ? 0 : (fleeing ? 0.62 : 0.26);
      (c.refs.legs||[]).forEach((leg, li)=>{
        leg.rotation.z = Math.sin(c.walkPh + ((li===0||li===3) ? 0 : Math.PI))*amp;
      });
      c.g.position.set(c.x, c.y, c.z);
    }
    c.g.rotation.y = c.yaw;
    // head down to feed while grazing, up and alert while watched -- the read that tells
    // you at a glance whether you've been noticed
    if(c.refs.headG){
      const want = (c.state === 'graze' && !fleeing) ? 0.6 + Math.sin(t*0.0016 + i)*0.12 : 0;
      c.refs.headG.rotation.z = lerp(c.refs.headG.rotation.z, want, 1 - Math.pow(0.02, dt));
    }
    if(c.refs.tailG) c.refs.tailG.rotation.x = Math.sin(t*0.005 + i)*(fleeing ? 0.4 : 0.16);
    if(c.alert.material) c.alert.material.opacity = c.sighted ? 0.35 : 1;
  }
}

export { CRITTERS, getCritters, getCritterStats, spawnCritters, resetCritters,
         updateCritters, WATCH_SECONDS, playerNoise, typicalSpookRadius };
