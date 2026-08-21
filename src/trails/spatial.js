/* Nearest-trail spatial hash. No elevation field on segments any more -- the old
   standalone build stored per-vertex Z here so the player could match the tread's exact
   drape; now that elevation comes from the DEM (terrain.js), the tread's height already
   equals the ground's height wherever it counts, so this only needs 2D position. */
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
function nearestTrail(x,z){
  const segs=SEG_HASH.get(hashKey(x,z));let best=1e9,edge=null;
  if(segs)for(const s of segs){
    const dx=s.b[0]-s.a[0],dz=s.b[1]-s.a[1],L2=dx*dx+dz*dz;
    let t=L2===0?0:((x-s.a[0])*dx+(z-s.a[1])*dz)/L2;t=t<0?0:(t>1?1:t);
    const d=Math.hypot(x-(s.a[0]+t*dx),z-(s.a[1]+t*dz));
    if(d<best){best=d;edge=s.edge;}
  }
  return{d:best,edge};
}

export { resetSpatialHash, hashKey, hashSeg, nearestTrail };
