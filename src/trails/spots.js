/* Saved spots: places on the map the walker asked to remember.

   WHY A MODULE AND NOT A FIELD ON `trip`. Two very different consumers need the same
   list -- main.js writes it while you walk, minimap.js draws it on both map canvases --
   and neither should own the other. This is the same shape as world.js's relationship
   with the rest of src/trails: one module owns the array, everybody else goes through
   the named functions, and the array is cleared IN PLACE (see resetSpots) because other
   modules hold the reference.

   COORDINATES ARE STORED IN REAL METRES, NOT WORLD UNITS, and that is the whole reason
   this file is more than a wrapper around an array. World scale compacts positions -- a
   point at world x=100 is 500 real metres out at 1:5 and 3200 at 1:32 -- so a spot saved
   at 1:5 and read back at 1:32 would sit six kilometres from where the walker stood.
   Storing the real-world position and converting on the way out means the pin stays on
   the same rock whatever the slider is doing. Elevation is already true metres
   everywhere in this codebase, so it needs no conversion and gets none.

   Spots are keyed by map, because a pin dropped at Garden of the Gods means nothing on a
   map of somewhere else, and localStorage does not know which one you have open.

   Persistence is best-effort. A browser with storage disabled, a private window, or a
   full quota all throw on read or write; every one of those is a reason for the pins not
   to survive a reload, and none of them is a reason for the walk to stop. So every
   access is wrapped and a failure degrades to an in-memory list for the session. */
import { getMapScale } from './world.js';

const SPOTS_KEY = 'pup-trails/spots/v1';
const MAX_SPOTS = 24;      // a map full of pins is a map you can't read

/* Cleared in place, never reassigned -- see the module header. */
const SPOTS = [];
let mapId = 'default';
let nextId = 1;

function setSpotMap(id){
  const next = String(id || 'default');
  if(next === mapId) return;
  mapId = next;
  readSpots();
}
function getSpotMap(){ return mapId; }

function storage(){
  try{ return window.localStorage || null; }catch(err){ return null; }
}

function readSpots(){
  SPOTS.length = 0;
  nextId = 1;
  const st = storage();
  if(!st) return SPOTS;
  let all = null;
  try{ all = JSON.parse(st.getItem(SPOTS_KEY) || '{}'); }
  catch(err){ all = null; }
  const mine = (all && all[mapId]) || [];
  for(const s of mine){
    if(!s || typeof s.rx !== 'number' || typeof s.rz !== 'number') continue;
    SPOTS.push({id:nextId++, name:String(s.name||'Spot'), rx:s.rx, rz:s.rz,
                yaw:+s.yaw||0, elevFt:(s.elevFt==null?null:+s.elevFt), at:+s.at||0});
  }
  return SPOTS;
}

function writeSpots(){
  const st = storage();
  if(!st) return false;
  try{
    let all = {};
    try{ all = JSON.parse(st.getItem(SPOTS_KEY) || '{}') || {}; }catch(err){ all = {}; }
    all[mapId] = SPOTS.map(s=>({name:s.name, rx:s.rx, rz:s.rz, yaw:s.yaw,
                                elevFt:s.elevFt, at:s.at}));
    st.setItem(SPOTS_KEY, JSON.stringify(all));
    return true;
  }catch(err){
    // quota, private mode, storage disabled -- the session keeps its pins regardless
    return false;
  }
}

/* World units in, real metres stored. `name` is optional: an unnamed spot is numbered,
   which is what the badge on the map shows anyway. */
function addSpot(x, z, yaw, name, elevFt){
  const s = getMapScale() || 1;
  const spot = {id:nextId++, name:String(name||'').trim() || ('Spot ' + (SPOTS.length+1)),
                rx:x/s, rz:z/s, yaw:+yaw||0,
                elevFt:(elevFt==null?null:+elevFt), at:Date.now()};
  SPOTS.push(spot);
  // oldest out first: the cap exists to keep the sheet legible, and the pin you dropped
  // ten minutes ago is likelier to matter than the one from last week
  while(SPOTS.length > MAX_SPOTS) SPOTS.shift();
  writeSpots();
  return spot;
}

function removeSpot(id){
  const i = SPOTS.findIndex(s=>s.id===id);
  if(i < 0) return false;
  SPOTS.splice(i, 1);
  writeSpots();
  return true;
}

function renameSpot(id, name){
  const s = SPOTS.find(s=>s.id===id);
  if(!s) return false;
  s.name = String(name||'').trim() || s.name;
  writeSpots();
  return true;
}

function resetSpots(){
  SPOTS.length = 0;
  writeSpots();
}

function getSpots(){ return SPOTS; }

/* Real metres back to the world units everything in src/trails draws in. Derived on
   every read rather than cached, so a spot is correct the instant the world scale
   changes -- there is no invalidation step to forget. */
function spotWorld(s){
  const k = getMapScale() || 1;
  return {x:s.rx*k, z:s.rz*k};
}

/* Is there already a pin within `radius` world units? Used to stop a held key or a
   double tap stacking three pins on one rock. */
function spotNear(x, z, radius){
  for(const s of SPOTS){
    const p = spotWorld(s);
    if(Math.hypot(p.x-x, p.z-z) <= radius) return s;
  }
  return null;
}

export { SPOTS, MAX_SPOTS, setSpotMap, getSpotMap, readSpots, writeSpots, addSpot,
         removeSpot, renameSpot, resetSpots, getSpots, spotWorld, spotNear };
