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
import { cheerBlip, yipHigh, warnGrowl, bonkSound } from '../core/audio.js';
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

/* ---------- big animals stand their ground ----------

   Every animal on the map used to answer proximity the same way: flee. That makes a bear
   behave like a rabbit, which is both wrong and, worse, boring -- it removes the only
   situation on a trail where being close to wildlife should feel like a decision rather
   than a reward. So the brave ones defend instead.

   DRIVEN BY THE STATS TABLE, not by a list of species names. SPECIES.brav already ranks
   exactly the animals this is about: mountain goat 4.6, bighorn 5.6, bear 8.6, moose 9.6,
   with the next one down being a housecat at 3.2. A threshold of 4 therefore names the
   set without hardcoding it, and stays right if the roster changes.

   THE SHAPE OF THE ENCOUNTER, and each stage exists to give the player a way out:
     bristle  it has seen you and is not leaving. Head down, stamping, warning growl.
              Back off now and nothing happens.
     charge   you came closer anyway. It commits and runs you down.
     hit      contact. A headbutt or a paw slap, and you go backwards.
   Barking is the counter, and it is the reason the bark button matters out here: a bark
   inside the warn window turns a defender around and sends it off like anything else.
   Barking at a bear is a gamble that works -- which is a better rule than "never get
   close", because it is a rule you can play with. */
const DEFEND_BRAV = 4;
const BRISTLE_MUL = 1.5;          // x spook radius: where it starts warning you off
const CHARGE_MUL  = 0.85;         // x spook radius: where it commits
const CHARGE_SECONDS = 2.6;       // it does not chase you across the county
const HIT_COOLDOWN = 1.4;
/* Contact reach, in true metres like every other animal-to-player distance in this file
   (see wanderTarget's note on why positions scale and radii do not). Scaled by the
   animal's own size, because a moose can reach you from further away than a goat. */
function reachOf(c){ return 1.5 + c.S.scale*1.1; }
function defenderKeys(){ return Object.keys(SPECIES).filter(isDefender); }
function speciesStats(key){ return SPECIES[key]; }
function isDefender(key){
  const S = SPECIES[key];
  return !!S && (S.brav || 0) >= DEFEND_BRAV;
}

/* Hits are QUEUED rather than applied, because critters.js has no business knowing what a
   player is. main.js drains this each frame and turns each record into knockback on
   whatever the player happens to be. Cleared in place, same rule as CRITTERS. */
const IMPACTS = [];
function takeImpacts(){
  const out = IMPACTS.slice();
  IMPACTS.length = 0;
  return out;
}

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
    // defender state (see DEFEND_BRAV): unused by everything below the bravery threshold
    defends: isDefender(key), warnT: 0, chargeT: 0, hitT: 0, swing: 0, lunge: 0,
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

/* Stand and warn. Not a flee and not a watch: the animal squares up, drops its head and
   growls, and the encounter is now on a timer the player controls by moving. */
function bristle(c, px, pz){
  if(c.state === 'bristle' || c.state === 'charge') return;
  c.state = 'bristle';
  c.warnT = 0;
  c.alert.visible = true;
  c.yaw = Math.atan2(c.z - pz, -(c.x - px));
  warnGrowl(c.S.scale);
}

function charge(c, px, pz){
  if(c.state === 'charge') return;
  c.state = 'charge';
  c.chargeT = 0;
  c.alert.visible = true;
  warnGrowl(c.S.scale*0.85);
}

/* Contact. The verb is the animal's own: a horned or antlered animal butts, a bear
   slaps. Both send you backwards; they differ in how they look and sound, which is the
   whole point of naming them separately. */
function landHit(c, px, pz){
  const away = Math.atan2(pz - c.z, px - c.x);
  const verb = (c.key === 'bear') ? 'slap' : 'butt';
  IMPACTS.push({
    x: c.x, z: c.z, key: c.key, name: c.S.nm, verb,
    // heavier animals hit harder; the exponent keeps a moose from being a catapult
    force: 7.5 + Math.pow(c.S.scale, 1.4)*4.2,
    dirX: Math.cos(away), dirZ: Math.sin(away),
  });
  c.hitT = HIT_COOLDOWN;
  c.swing = 1;                       // drives the lunge pose below
  bonkSound(c.S.scale);
  comicBurst((verb === 'slap' ? '\ud83d\udc3e ' : '\ud83d\udca5 ') + c.S.nm + '!',
             c.x, c.y + c.S.scale*1.8, c.z, '#e2453f');
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

/* Everything that turns one critter's STATE into a pose, in one place.

   Extracted because the defender branch needs it too and `continue`s past the rest of the
   loop -- a bristling bear that skipped the posing code stood frozen mid-stride, which is
   the least threatening thing an animal can do. Two callers, one body, no chance of the
   two drifting into different-looking animals. */
function poseCritter(c, dt, t, i, rnd){
  const still = c.state === 'watchful' || c.state === 'bristle' ||
                (c.state === 'graze' && c.timer > 0.6 && rnd() < 0);
  const fleeing = c.state === 'flee';
  const charging = c.state === 'charge';
  const bristling = c.state === 'bristle';

  /* The lunge. `swing` is set to 1 on contact and decays, and it drives a whole-body
     shove forward along the animal's own heading plus a hard head snap -- so the hit is
     something you SEE happen to you, from an animal that visibly threw its weight, rather
     than a number applied to the player while a model stands still. Bristling gets a
     smaller, rhythmic version of the same motion: the stamp. */
  const stamp = bristling ? Math.sin(t*0.011)*0.5 + 0.5 : 0;
  c.lunge = lerp(c.lunge || 0, charging ? 0.55 : (bristling ? stamp*0.16 : 0),
                 1 - Math.pow(0.004, dt));
  const push = c.lunge*0.32*c.S.scale + c.swing*0.85*c.S.scale;
  const fx = Math.cos(c.yaw), fz = -Math.sin(c.yaw);

  if(c.hopper){
    c.hop += dt*(fleeing ? 11 : 2.4);
    c.g.position.set(c.x, c.y + (still ? 0 : Math.abs(Math.sin(c.hop))*0.22*c.S.scale), c.z);
  }else{
    // a charging animal's legs run hard; a bristling one paws the ground rather than walks
    if(!still || bristling) c.walkPh += dt*(fleeing ? 13 : (charging ? 15 : (bristling ? 6 : 4)));
    const amp = charging ? 0.78 : (bristling ? 0.2 + stamp*0.22 : (still ? 0 : (fleeing ? 0.62 : 0.26)));
    (c.refs.legs||[]).forEach((leg, li)=>{
      leg.rotation.z = Math.sin(c.walkPh + ((li===0||li===3) ? 0 : Math.PI))*amp;
    });
    c.g.position.set(c.x + fx*push, c.y + c.swing*0.22*c.S.scale, c.z + fz*push);
  }
  c.g.rotation.y = c.yaw;
  /* Head. Grazing is down and idle; watched is up and level; bristling is DOWN AND
     FORWARD, which is the universal read for "I am about to use this" whether the animal
     is carrying horns or not; the contact frame throws it through. */
  if(c.refs.headG){
    const want = c.swing > 0.02 ? -0.9*c.swing
      : bristling ? 0.52 + stamp*0.16
      : charging ? 0.34
      : (c.state === 'graze' && !fleeing) ? 0.6 + Math.sin(t*0.0016 + i)*0.12
      : 0;
    const rate = c.swing > 0.02 ? 0.00001 : 0.02;    // snap on the hit, ease otherwise
    c.refs.headG.rotation.z = lerp(c.refs.headG.rotation.z, want, 1 - Math.pow(rate, dt));
  }
  // a defender leans into it: roll the whole body forward on the swing
  c.g.rotation.z = lerp(c.g.rotation.z || 0, -c.swing*0.3, 1 - Math.pow(0.01, dt));
  if(c.refs.tailG) c.refs.tailG.rotation.x = Math.sin(t*0.005 + i)*(fleeing ? 0.4 : (charging ? 0.5 : 0.16));
  if(c.alert.material) c.alert.material.opacity = c.sighted ? 0.35 : 1;
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

    if(c.hitT > 0) c.hitT = Math.max(0, c.hitT - dt);
    c.swing = Math.max(0, c.swing - dt*3.2);

    /* THE DEFENDER BRANCH, taken before the ordinary spook check below.

       A brave animal inside its own spook radius does NOT bolt -- that check is what made
       a bear behave like a rabbit. It bristles, then charges, then hits. Two ways out,
       and the player chooses which: back off past the bristle ring, or bark. Barking is
       checked FIRST and at the wider radius, so it works as a warning shot rather than
       only as a last resort -- which is what makes it worth pressing early. */
    if(c.defends && c.state !== 'flee'){
      const bristleR = spookRadiusFor(c.key)*BRISTLE_MUL;
      const chargeR = spookRadiusFor(c.key)*CHARGE_MUL;
      if(dist < bristleR*1.25 && barking){
        // a bark drives even a bear off -- and costs you the sighting, like any spook
        bolt(c, px, pz);
      }else if(c.state === 'charge'){
        c.chargeT += dt;
        seek(c, px, pz, c.S.speed*2.1, dt);
        if(dist < reachOf(c) && c.hitT <= 0) landHit(c, px, pz);
        if(c.chargeT > CHARGE_SECONDS || dist > bristleR*2.2){
          c.state = 'bristle'; c.warnT = 0; c.target = {x:c.home.x, z:c.home.z};
        }
      }else if(dist < chargeR){
        charge(c, px, pz);
      }else if(dist < bristleR){
        bristle(c, px, pz);
        c.warnT += dt;
        c.yaw = Math.atan2(dz, -dx);
        // a second growl if you loiter inside the warning ring without closing
        if(c.warnT > 1.9){ c.warnT = 0; warnGrowl(c.S.scale); }
      }else if(c.state === 'bristle'){
        c.state = 'graze'; c.alert.visible = false; c.warnT = 0;
        c.target = wanderTarget(c, rnd);
      }
      if(c.state === 'bristle' || c.state === 'charge'){
        // it is standing its ground, so none of the ordinary flee/watch logic applies
        const gy0 = standingY(c.x, c.z);
        c.y = lerp(c.y, gy0, 1 - Math.pow(0.0008, dt));
        poseCritter(c, dt, t, i, rnd);
        continue;
      }
    }

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

    poseCritter(c, dt, t, i, rnd);
  }
}

export { CRITTERS, getCritters, getCritterStats, spawnCritters, resetCritters,
         updateCritters, WATCH_SECONDS, playerNoise, typicalSpookRadius,
         takeImpacts, isDefender, defenderKeys, speciesStats, reachOf, DEFEND_BRAV, BRISTLE_MUL, CHARGE_MUL };
