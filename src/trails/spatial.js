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
/* {d, edge, y, hw, px, pz, deck}: distance to the centreline, the edge it belongs to, the tread
   height interpolated along that segment, the corridor half-width, and the point on the
   centreline itself. `y` is null when the segment was hashed without a height profile (the
   flat, no-DEM fallback path), which callers must treat as "no opinion", not as "height
   zero"; px/pz are null when nothing was found at all, for the same reason.

   px/pz is what "snap to paths" means. The course recorder cannot store where the player
   WAS, because a recorded line has to be raceable by somebody running a different line
   through the same corridor -- two walkers on opposite verges of one trail would otherwise
   trace two courses that never meet. The projection is already computed here to get `d`,
   so handing it back costs nothing and means the recorder and the "am I on a trail" test
   can never disagree about which point on which trail they are talking about.

   `deck` is true when that stretch of tread is a bridge (world.js marks the segments it
   hashes from a deck span), so the footstep voice can hear planks without a second
   lookup against the bridge list. */
function nearestTrail(x,z){
  const segs=SEG_HASH.get(hashKey(x,z));
  let best=1e9,edge=null,y=null,hw=0,px=null,pz=null,deck=false;
  if(segs)for(const s of segs){
    const dx=s.b[0]-s.a[0],dz=s.b[1]-s.a[1],L2=dx*dx+dz*dz;
    let t=L2===0?0:((x-s.a[0])*dx+(z-s.a[1])*dz)/L2;t=t<0?0:(t>1?1:t);
    const qx=s.a[0]+t*dx, qz=s.a[1]+t*dz;
    const d=Math.hypot(x-qx,z-qz);
    if(d<best){
      best=d;edge=s.edge;hw=s.hw||0;px=qx;pz=qz;deck=!!s.deck;
      y=(s.ya==null||s.yb==null)?null:s.ya+(s.yb-s.ya)*t;
    }
  }
  return{d:best,edge,y,hw,px,pz,deck};
}

export { resetSpatialHash, hashKey, hashSeg, nearestTrail };
