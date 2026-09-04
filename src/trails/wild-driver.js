/* Playing AS a wild animal, not just watching one, is new — neither Pup City (wildlife
   is AI-only) nor Backyard Pups (dogs only) has a player-controlled non-dog creature,
   so there's no existing "runtime" module to plug into the way dog-driver.js plugs into
   dog/runtime.js. What IS shared is the art and the balance data: makeAnimalModel()
   and SPECIES. This file is the trail-only equivalent of dog/runtime.js — same
   "one live instance, mutate via functions, never reassign the group" shape — scoped to
   trails because that's the only game that needs it. */
import { clamp, lerp, mulberry32 } from '../core/math.js';
import { scene, disposeGroup } from '../core/render.js';
import { makeAnimalModel } from '../city/animal-models.js';
import { SPECIES } from '../data/species.js';
import { gaitStep, climbPose, wallPose, leapPose, legSwingValue, gallopAmount } from './gait.js';

let group = null, refs = null, speciesKey = null, S = null;
let wildLegPhase = 0, wildBodyBaseY = 0, wildClimbAmt = 0, wildLeapAmt = 0;
let wildLegLen = 0.4;      // hip pivot height above ground, WORLD units (see dog-driver)
const wildPos = new THREE.Vector3(0,0,0);
let yaw = 0;

function spawnWild(key, seed){
  if(group){ scene.remove(group); disposeGroup(group); }
  speciesKey = key; S = SPECIES[key];
  const rnd = mulberry32((seed|0) || 1);
  const built = makeAnimalModel(key, rnd);
  group = built.g; refs = built.refs;
  group.position.copy(wildPos);
  group.rotation.y = yaw;
  scene.add(group);
  wildLegPhase = 0; wildClimbAmt = 0; wildLeapAmt = 0;
  wildBodyBaseY = refs.bodyG ? refs.bodyG.position.y : 0;
  wildLegLen = measureWildLegLen();
}

/* Same rule as the dog: the foot-lock is only correct if this is the pivot's height in
   WORLD units, after whatever scale makeAnimalModel baked into the group. */
function measureWildLegLen(){
  if(!refs || !refs.legs || !refs.legs.length || !group) return 0.4;
  const local = wildBodyBaseY + (refs.legs[0].position.y || 0);
  return Math.max(0.05, local*(group.scale ? group.scale.x : 1));
}
function wildLegLength(){ return wildLegLen; }
function wildShadowRadius(){ return wildLegLen*1.25; }

function setWildYaw(v){ yaw = v; if(group) group.rotation.y = yaw; }
function setWildVisible(v){ if(group) group.visible = !!v; }

function topSpeedFor(key){
  // SPECIES.speed is Pup City's fleeing/wander speed, tuned for a much smaller play
  // area; trails covers real distances, so it's scaled up rather than reused directly.
  return (SPECIES[key]?.speed || 2.2) * 1.7;
}
function spookRadiusFor(key){
  const s = SPECIES[key];
  if(!s) return 8;
  // brav (bravery, 1-9.6 in SPECIES) is inverted here: a brave bear needs you much
  // closer before it reacts, same direction the dog-side spook radius already uses.
  return clamp(16 - s.brav*1.3, 4, 14) * (s.scale||1);
}

function updateWild(dt, t, groundY, jumpY, speed, sneaking, barking, climb, leap, rise, onWall){
  if(!group || !refs) return;
  group.position.set(wildPos.x, groundY + jumpY, wildPos.z);
  group.rotation.y = yaw;
  const hop = !!S?.hopper;
  /* Foot-locked, exactly as the dog is -- see gait.js. A hopper is the one honest
     exception: both hind legs move together and the animal is airborne for much of the
     cycle, so it covers more ground per stride than a pendulum sweep can account for.
     It gets a longer stride ratio and a lower cadence rather than a free-running phase. */
  const g = gaitStep(wildLegLen, speed, dt,
    hop ? {maxRatio:2.6, cadence:1.7} : (sneaking ? {maxRatio:1.05, cadence:2.9} : null));
  const swing = hop ? Math.min(0.95, g.swing*1.25) : g.swing;

  // see dog-driver: airborne freezes the cycle and holds a spread instead
  wildLeapAmt  = lerp(wildLeapAmt,  clamp(leap||0, 0, 1),  1-Math.pow(0.000002,dt));
  wildClimbAmt = lerp(wildClimbAmt, clamp(climb||0, 0, 1), 1-Math.pow(0.0001,dt));
  const legs = refs.legs||[];
  const lp = wildLeapAmt  > 0.002 ? leapPose(wildLeapAmt, rise||0, legs.length) : null;
  /* A wall cling and a kerb scramble share the climbT timer but not the pose: one stands
     the pup vertically against the stone, the other tips it a few degrees over a step. */
  const cp = onWall ? wallPose(t, legs.length)
           : (wildClimbAmt > 0.002 ? climbPose(wildClimbAmt, t, legs.length) : null);

  wildLegPhase += g.dPhase*(1 - (lp ? lp.freeze : 0));

  /* A hopper keeps its own pattern (both hind legs together, always) -- it has no trot
     to leave and no gallop to enter. Everything else gallops at its own top end. */
  const gal = hop ? 0 : gallopAmount(speed, topSpeedFor(speciesKey)*0.55, topSpeedFor(speciesKey));
  legs.forEach((leg,i)=>{
    let z;
    if(hop){
      z = Math.sin(wildLegPhase + (i>1?Math.PI:0))*swing;
    }else{
      z = legSwingValue(i, wildLegPhase, gal)*swing;
    }
    if(cp) z = lerp(z, cp.legs[i], wildClimbAmt);
    if(lp) z = lerp(z, lp.legs[i], wildLeapAmt);
    leg.rotation.z = z;
  });
  if(refs.tailG) refs.tailG.rotation.y = Math.sin(t*0.01)*0.4 + (barking?Math.sin(t*0.05)*0.7:0);
  if(refs.headG) refs.headG.rotation.z = barking?0.2:(sneaking?-0.1:Math.sin(t*0.0025)*0.05);
  if(refs.bodyG){
    // absolute, not accumulated -- set relative to the base height captured at spawn,
    // or the bob would compound every frame instead of oscillating around one baseline
    // see dog-driver: the bound is what makes the airborne part of a gallop legible.
    // A hopper already bounds by nature, so it gets a bigger one.
    const bound = g.bound*wildLegLen*(hop?0.75:(0.42+0.5*gal))*Math.max(0, Math.sin(wildLegPhase))*(1-wildLeapAmt);
    const flex  = gal*0.16*Math.sin(wildLegPhase - Math.PI*0.5)*(1-wildLeapAmt);
    refs.bodyG.position.y = wildBodyBaseY
      + Math.abs(Math.sin(wildLegPhase))*clamp(speed*(hop?0.02:0.01),0,hop?0.3:0.12)*(1-wildLeapAmt)
      + bound + (cp ? cp.rise*wildLegLen : 0);
    let pitch = (cp ? cp.pitch : 0) + flex;
    if(lp) pitch = lerp(pitch, lp.pitch, wildLeapAmt);
    refs.bodyG.rotation.z = pitch;
    /* Roll into whichever diagonal is reaching. Only the climb sets it, so this is zero on
       every other frame and the body rests flat -- but without it a scramble is perfectly
       bilateral, which is the thing that made the old pose read as a statue. */
    refs.bodyG.rotation.x = cp ? cp.roll : 0;
  }
}

export { spawnWild, updateWild, setWildYaw, setWildVisible, topSpeedFor, spookRadiusFor,
         wildPos, wildLegLength, wildShadowRadius };
