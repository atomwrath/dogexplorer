/* The live dog instance, shared across every system.
   This module OWNS: P, dog, R, dogYaw, STATS.
   Other modules read them as live bindings and mutate only via the setters. */
import { scene, disposeGroup } from '../core/render.js';
import { buildDog } from './build.js';
import { computeStats } from './stats.js';
import { DEFAULTS } from './params.js';

let P = null;
let dog = null, R = null;
let dogYaw = 0;
let STATS = computeStats(1);
const dogPos = new THREE.Vector3(0, 0, 0);

/* Systems that need to react to a new pup (stat readouts, badges) register here.
   This keeps runtime.js from importing the UI, which would create a cycle. */
const dogListeners = [];
function onDogChange(fn){ dogListeners.push(fn); }

function setDogYaw(v){ dogYaw = v; }
function addDogYaw(v){ dogYaw += v; }

function setDog(params){
  P = Object.assign({}, DEFAULTS, params);
  STATS = computeStats(P.size);
  if(dog){ scene.remove(dog); disposeGroup(dog); }
  const b = buildDog(P);
  dog = b.group; R = b.refs;
  dog.position.copy(dogPos);
  dog.rotation.y = dogYaw;
  scene.add(dog);
  for(const fn of dogListeners) fn(P);
}

export { P, dog, R, dogPos, dogYaw, STATS, setDog, setDogYaw, addDogYaw, onDogChange };
