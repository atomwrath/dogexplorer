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

let group = null, refs = null, speciesKey = null, S = null;
let wildLegPhase = 0, wildBodyBaseY = 0;
const pos = new THREE.Vector3(0,0,0);
let yaw = 0;

function spawnWild(key, seed){
  if(group){ scene.remove(group); disposeGroup(group); }
  speciesKey = key; S = SPECIES[key];
  const rnd = mulberry32((seed|0) || 1);
  const built = makeAnimalModel(key, rnd);
  group = built.g; refs = built.refs;
  group.position.copy(pos);
  group.rotation.y = yaw;
  scene.add(group);
  wildLegPhase = 0;
  wildBodyBaseY = refs.bodyG ? refs.bodyG.position.y : 0;
}

function setWildYaw(v){ yaw = v; if(group) group.rotation.y = yaw; }

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

function updateWild(dt, t, groundY, jumpY, speed, sneaking, barking){
  if(!group || !refs) return;
  group.position.set(pos.x, groundY + jumpY, pos.z);
  group.rotation.y = yaw;
  const hop = !!S?.hopper;
  const strideRate = 2.2 / clamp((S?.scale||1),0.4,2.2);
  wildLegPhase += speed*dt*strideRate*(sneaking?0.85:1);
  const swing = clamp(speed*(hop?0.16:0.1),0,hop?0.9:0.78);
  (refs.legs||[]).forEach((leg,i)=>{
    const phase = hop ? (i>1?Math.PI:0) : ((i%2?Math.PI:0)+(i>1?Math.PI*0.5:0));
    leg.rotation.z = Math.sin(wildLegPhase+phase)*swing;
  });
  if(refs.tailG) refs.tailG.rotation.y = Math.sin(t*0.01)*0.4 + (barking?Math.sin(t*0.05)*0.7:0);
  if(refs.headG) refs.headG.rotation.z = barking?0.2:(sneaking?-0.1:Math.sin(t*0.0025)*0.05);
  if(refs.bodyG){
    // absolute, not accumulated -- set relative to the base height captured at spawn,
    // or the bob would compound every frame instead of oscillating around one baseline
    refs.bodyG.position.y = wildBodyBaseY + Math.abs(Math.sin(wildLegPhase))*clamp(speed*(hop?0.02:0.01),0,hop?0.3:0.12);
  }
}

export { spawnWild, updateWild, setWildYaw, topSpeedFor, spookRadiusFor, pos as wildPos, lerp };
