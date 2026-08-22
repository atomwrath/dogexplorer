/* Nearest-trail spatial hash.

   It DOES carry elevation again. The previous version dropped the per-segment height on
   the reasoning that "the tread's height already equals the ground's height wherever it
   counts" -- which was true only because the ribbons were being lifted to a corridor
   maximum and the avatar was being lifted to match. Now that gradeProfile gives each
   trail a continuous height and gradeTrailCells benches the ground to it (terrain.js),
   the tread has its own honest height -- close to the cell height beneath it, but not
   identical, since the bench is a staircase of cell-sized treads and the ribbon is the
   smooth line through them. world.js's standingY reads it to keep anything walking there
   on top of the tread rather than through it.

   Segments are hashed from the SAME profile the ribbon geometry is built from, so `y`
   below is the tread's actual rendered height, not a re-derivation of it. */
const HASH_CELL=14;
let SEG_HASH=new Map();

function resetSpatialHash(){ SEG_HASH=new Map(); }
function hashKey(x,z){return(Math.floor(x/HASH_CELL))+'_'+(Math.floor(z/HASH_CELL));}
function hashSeg(seg){
  const minx=Math.min(seg.a[0],seg.b[0])-6,maxx=Math.max(seg.a[0],seg.b[0])+6;
  const minz=Math.min(seg.a[1],seg.b[1])-6,maxz=Math.max(seg.a[1],seg.b[1])+6;
  for(let cx=Math.floor(minx/HASH_CELL);cx<=Math.floor(maxx/HASH_CELL);cx++)
    for(let cz=Math.floor(minz/HASH_CELL);cz<=Math.floor(maxz/HASH_CELL);cz++){
      const k=cx+'_'+cz;if(!SEG_HASH.has(k))SEG_HASH.set(k,[]);SEG_HASH.get(k).push(seg);
    }
}
/* {d, edge, y, hw}: distance to the centreline, the edge it belongs to, the tread height
   interpolated along that segment, and the corridor half-width. `y` is null when the
   segment was hashed without a height profile (the flat, no-DEM fallback path), which
   callers must treat as "no opinion", not as "height zero". */
function nearestTrail(x,z){
  const segs=SEG_HASH.get(hashKey(x,z));
  let best=1e9,edge=null,y=null,hw=0;
  if(segs)for(const s of segs){
    const dx=s.b[0]-s.a[0],dz=s.b[1]-s.a[1],L2=dx*dx+dz*dz;
    let t=L2===0?0:((x-s.a[0])*dx+(z-s.a[1])*dz)/L2;t=t<0?0:(t>1?1:t);
    const d=Math.hypot(x-(s.a[0]+t*dx),z-(s.a[1]+t*dz));
    if(d<best){
      best=d;edge=s.edge;hw=s.hw||0;
      y=(s.ya==null||s.yb==null)?null:s.ya+(s.yb-s.ya)*t;
    }
  }
  return{d:best,edge,y,hw};
}

export { resetSpatialHash, hashKey, hashSeg, nearestTrail };
