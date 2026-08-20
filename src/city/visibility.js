/* Two jobs:
   1. fade buildings that sit between the camera and the pup, so you're never hidden
   2. cull distant blocks so long streets stay cheap on phones */
import { camera } from '../core/render.js';
import { lerp } from '../core/math.js';
import { dogPos } from '../dog/runtime.js';
import { BUILDINGS, envG } from './world.js';
import { mode } from './modes.js';
import { QUALITY } from '../core/quality.js';

/* ---------- camera-blocking buildings fade out ---------- */
function updateBuildingFade(dt){
  const k = 1 - Math.pow(0.002, dt);
  for(const b of BUILDINGS){
    const blocking = mode !== 'lobby'
      && camera.position.z > b.z
      && dogPos.z < b.z + b.d/2 + 0.5
      && Math.abs(dogPos.x - b.x) < b.w/2 + 2
      && b.h > 2.5
      && (b.z - dogPos.z) < 14;
    const target = blocking ? 0.24 : 1;
    for(const m of b.mats){
      m.opacity = lerp(m.opacity, target, k);
    }
  }
}

/* ---------- distance culling ----------
   The city is thousands of meshes on a long block. We bucket every top-level
   child of envG by its x position at build time, then toggle whole buckets as
   the pup moves. Cheap, and it keeps 260m blocks smooth on older phones. */
let cullBuckets = {};
let alwaysVisible = [];
const BUCKET_W = 12;
const _box = new THREE.Box3();

function rebuildCullGrid(){
  cullBuckets = {};
  alwaysVisible = [];
  lastCullBucket = null;
  if(!envG) return;
  envG.updateMatrixWorld(true);
  for(const child of envG.children){
    /* Bucket by the WORLD bounding box, not child.position — buildings and
       other props are Groups sitting at the origin with their geometry offset
       inside, so position.x would put every one of them in bucket 0. */
    _box.setFromObject(child);
    if(!isFinite(_box.min.x) || _box.isEmpty()){ alwaysVisible.push(child); continue; }
    const width = _box.max.x - _box.min.x;
    if(width > 40){
      /* the ground plane, road strips and sidewalks span the whole block —
         hiding these would blink the world away */
      alwaysVisible.push(child);
      continue;
    }
    const cx = (_box.min.x + _box.max.x) / 2;
    const b = Math.floor(cx / BUCKET_W);
    (cullBuckets[b] || (cullBuckets[b] = [])).push(child);
  }
}

let lastCullBucket = null;
function updateCulling(){
  const here = Math.floor(dogPos.x / BUCKET_W);
  if(here === lastCullBucket) return;      // only recompute when we cross a bucket
  lastCullBucket = here;
  const span = Math.ceil(QUALITY.cullDist / BUCKET_W);
  for(const key in cullBuckets){
    const visible = Math.abs(+key - here) <= span;
    for(const child of cullBuckets[key]) child.visible = visible;
  }
}

export { updateBuildingFade, rebuildCullGrid, updateCulling };
