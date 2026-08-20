/* The world registry: collision, platforms, water, and the actor lists.
   Every system reads these; only level.js repopulates them. */
import { M, toon } from '../core/materials.js';

let envG = null;
function setEnvG(g){ envG = g; }
const COLLIDERS = [], PLATFORMS = [], WATER = [], HAZARDS = [];
const BUILDINGS = [], CARS = [], PEEPS = [], PICKUPS = [], DOCK_TOPS = [], SPOTS = [];
/* NEVER reassign these arrays — other modules hold the same reference.
   resetWorld() empties them in place. */
function resetWorld(){
  for(const a of [COLLIDERS, PLATFORMS, WATER, HAZARDS, BUILDINGS, DOCK_TOPS, SPOTS]) a.length = 0;
}
const LEVEL = {length:140, seed:1234, total:0};
const ENV = {
  label:'Downtown', em:'🏙', sky:'#a8d4ee', fog:[58,150], ground:'#8f969c',
  W:50, scoreMode:'max',
  goal:'🎯 Pest patrol — scare the strays, spare the neighbors!',
  species:['cat','cat','raccoon','raccoon','squirrel','squirrel','possum','possum','rabbit'],
};
const STREETS = [0, -17, 17];
const HALF_ST = 4.2, BLOCK = 22;

function patch(color, w, d, x, z, y=0.012, rotY=0){
  const p = M(new THREE.PlaneGeometry(w, d), toon(color), false, true);
  p.rotation.x = -Math.PI/2; p.rotation.z = rotY;
  p.position.set(x, y, z);
  envG.add(p);
  return p;
}
function blocker(x, z, r, h=999){ COLLIDERS.push({x, z, r, h}); }
function boxBlocker(x, z, w, d, h=999){ COLLIDERS.push({x, z, w, d, h, rect:true}); }
function platform(x, z, w, d, top, solid=true){
  PLATFORMS.push({x, z, w, d, top});
  if(solid && top > 0.45) boxBlocker(x, z, w, d, top);
}
function supportAt(x, z, y){
  let best = 0;
  for(const pf of PLATFORMS){
    if(Math.abs(x - pf.x) < pf.w/2 && Math.abs(z - pf.z) < pf.d/2){
      if(pf.top <= y + 0.42 && pf.top > best) best = pf.top;
    }
  }
  return best;
}
function inWater(x, z){
  for(const w of WATER){
    if(Math.abs(x - w.x) < w.w/2 && z > w.z0 && z < w.z1) return w;
  }
  return null;
}
function pointBlocked(x, z, rad){
  for(const c of COLLIDERS){
    if(c.rect){
      if(Math.abs(x - c.x) < c.w/2 + rad && Math.abs(z - c.z) < c.d/2 + rad) return true;
    } else if(Math.hypot(x - c.x, z - c.z) < c.r + rad) return true;
  }
  return false;
}

export { envG, setEnvG, resetWorld, COLLIDERS, PLATFORMS, WATER, HAZARDS, BUILDINGS,
         CARS, PEEPS, PICKUPS, DOCK_TOPS, SPOTS, LEVEL, ENV, STREETS, HALF_ST, BLOCK,
         patch, blocker, boxBlocker, platform, supportAt, inWater, pointBlocked };
