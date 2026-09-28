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

function resetSpatialHash(){ SEG_HASH=new Map(); SKIRT_HASH=new Map(); }
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
  let best=1e9,edge=null,y=null,hw=0,px=null,pz=null,deck=false,tx=0,tz=0;
  if(segs)for(const s of segs){
    const dx=s.b[0]-s.a[0],dz=s.b[1]-s.a[1],L2=dx*dx+dz*dz;
    let t=L2===0?0:((x-s.a[0])*dx+(z-s.a[1])*dz)/L2;t=t<0?0:(t>1?1:t);
    const qx=s.a[0]+t*dx, qz=s.a[1]+t*dz;
    const d=Math.hypot(x-qx,z-qz);
    if(d<best){
      best=d;edge=s.edge;hw=s.hw||0;px=qx;pz=qz;deck=!!s.deck;
      const L=Math.sqrt(L2); tx=L?dx/L:0; tz=L?dz/L:0;   // the segment's direction
      y=(s.ya==null||s.yb==null)?null:s.ya+(s.yb-s.ya)*t;
    }
  }
  return{d:best,edge,y,hw,px,pz,deck,tx,tz};
}

/* ---------- fill embankments as a surface ----------

   The skirts under a floating tread (pieces.js embankmentGeom) were drawn as a facade and
   nothing stood on them: off the tread the pup was on the terraces BENEATH the skirt, so
   walking up to a trail across one meant climbing the hidden staircase inside it with the
   brown slope drawn over the pup's back. Hashing their triangles makes the slope you can
   see the slope you walk on.

   Stored with each triangle's plane, so a query hands back the gradient as well as the
   height -- that is what the pup is tilted by and what slows it down, and deriving it
   from finite differences of the height instead would read the terrace steps under the
   skirt's thin edges as sudden cliffs. Near-vertical faces are left out: a skirt only
   steepens that far where it is closing a hole beside another tread, and nothing should
   be able to walk up a wall just because it is painted brown. */
const SKIRT_CELL = 3;
const SKIRT_MIN_NY = 0.2;          // steeper than about 78 degrees is a face, not a slope
let SKIRT_HASH = new Map();
function hashSkirt(geo){
  if(!geo || !geo.attributes || !geo.attributes.position || !geo.index) return 0;
  const A = geo.attributes.position.array, I = geo.index.array || geo.index;
  let n = 0;
  for(let t=0;t+2<I.length;t+=3){
    const a=I[t]*3, b=I[t+1]*3, c=I[t+2]*3;
    const ax=A[a],ay=A[a+1],az=A[a+2], bx=A[b],by=A[b+1],bz=A[b+2], cx=A[c],cy=A[c+1],cz=A[c+2];
    const e1x=bx-ax,e1y=by-ay,e1z=bz-az, e2x=cx-ax,e2y=cy-ay,e2z=cz-az;
    let nx=e1y*e2z-e1z*e2y, ny=e1z*e2x-e1x*e2z, nz=e1x*e2y-e1y*e2x;
    const L=Math.hypot(nx,ny,nz); if(L<1e-9) continue;
    nx/=L; ny/=L; nz/=L;
    if(ny<0){ nx=-nx; ny=-ny; nz=-nz; }
    if(ny<SKIRT_MIN_NY) continue;
    const tri={ax,ay,az,bx,by,bz,cx,cy,cz, gx:-nx/ny, gz:-nz/ny, ny};
    const mnx=Math.min(ax,bx,cx), mxx=Math.max(ax,bx,cx), mnz=Math.min(az,bz,cz), mxz=Math.max(az,bz,cz);
    for(let i=Math.floor(mnx/SKIRT_CELL);i<=Math.floor(mxx/SKIRT_CELL);i++)
      for(let j=Math.floor(mnz/SKIRT_CELL);j<=Math.floor(mxz/SKIRT_CELL);j++){
        const k=i+'_'+j; let arr=SKIRT_HASH.get(k); if(!arr){ arr=[]; SKIRT_HASH.set(k,arr); } arr.push(tri);
      }
    n++;
  }
  return n;
}
/* The highest skirt surface at (x,z): {y, gx, gz} with gx/gz the height gained per unit
   moved along x/z, or null where there is no skirt. Highest, because where the skirts of
   two legs overlap in plan the upper one is the one you are standing on. */
function skirtAt(x,z){
  const arr=SKIRT_HASH.get(Math.floor(x/SKIRT_CELL)+'_'+Math.floor(z/SKIRT_CELL));
  if(!arr) return null;
  let best=null;
  for(const t of arr){
    const v0x=t.bx-t.ax, v0z=t.bz-t.az, v1x=t.cx-t.ax, v1z=t.cz-t.az, v2x=x-t.ax, v2z=z-t.az;
    const den=v0x*v1z-v1x*v0z; if(Math.abs(den)<1e-12) continue;
    const u=(v2x*v1z-v1x*v2z)/den, w=(v0x*v2z-v2x*v0z)/den;
    if(u<-1e-6 || w<-1e-6 || u+w>1+1e-6) continue;
    const y=t.ay+u*(t.by-t.ay)+w*(t.cy-t.ay);
    if(!best || y>best.y) best={y, gx:t.gx, gz:t.gz};
  }
  return best;
}
function skirtTriCount(){ let n=0; const seen=new Set(); for(const arr of SKIRT_HASH.values()) for(const t of arr) if(!seen.has(t)){ seen.add(t); n++; } return n; }

export { resetSpatialHash, hashKey, hashSeg, nearestTrail, hashSkirt, skirtAt, skirtTriCount };
