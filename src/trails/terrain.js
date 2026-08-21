/* Terraced terrain, sourced from a real DEM via data/world_bundle.js — NOT from Z
   draped onto the trail vertices in QGIS. That was pup-trails' first approach; it read
   elevation from the same vector coordinates it also used for trail topology, which
   meant no elevation signal anywhere the vectors didn't reach, and forced an ad-hoc
   runtime IDW reconstruction (with all the switchback and grid-resolution problems that
   involved). A `pup-world/1` bundle separates the two concerns properly: real elevation
   from AWS terrain tiles (tools/fetch_dem.py), independent of what the vector layers
   happen to trace. `World.heightAt/groundAt` already do exactly the terracing this game
   wants, and document the same "flat cell, not bilinear ramp" reasoning independently.

   This module owns two things World does NOT provide: a per-band terrace level array
   (World's own heights are the raw, unquantised DEM) and the actual renderable mesh. */
import { clamp } from '../core/math.js';

let WORLD = null;   // the loaded World instance (see data/world_bundle.js)
let STEP = 3;        // contour step, in metres — matches --cell intent from fetch_dem.py
let BAND = null;     // Int32Array, one terrace band index per DEM cell (mutable copy)
let GROUND_M = 0;    // WORLD.minM cached, the datum: 0 in-game = the map's lowest point

function setWorld(w){ WORLD = w; GROUND_M = w ? w.minM : 0; rebuildBands(); }
function setStep(m){ STEP = Math.max(0.5, m); rebuildBands(); }
function getWorld(){ return WORLD; }
function getStep(){ return STEP; }

function rebuildBands(){
  if(!WORLD){ BAND = null; return; }
  // World.terraceGrid(step) already gives band indices in the same row-major layout as
  // World.heights — copy it so area grading below can edit bands without mutating the
  // shared World instance, which other systems may also be reading from.
  BAND = Int32Array.from(WORLD.terraceGrid(STEP));
}

/* World-units ground height at (x,z): terrace band -> metres above datum -> VERT_SCALE.
   VERT_SCALE folds together the game's horizontal world-scale and the hill-exaggeration
   slider, exactly like the draped-Z version did; only the elevation SOURCE changed. */
function terrainY(x,z,vertScale){
  if(!WORLD||!BAND)return 0;
  const i=WORLD.cellI(x), j=WORLD.cellJ(z);
  const band=BAND[j*WORLD.width+i];
  return (band*STEP - GROUND_M) * vertScale;
}
function rawGroundY(x,z){ // un-terraced, for reference / minimap shading if ever needed
  return WORLD ? WORLD.heightAt(x,z) - GROUND_M : 0;
}

/* Flatten every DEM cell under an area polygon to one shared terrace band — the same
   grading pass as before, now operating on the band array instead of a bespoke grid.
   Overlapping polygons (this project has ~20 parking-lot polygons that touch) adopt a
   level already claimed rather than re-levelling it, or the second grading would leave
   the first slab hovering over ground it no longer matches. */
function flattenAreaCells(areas, pointInArea, areaBBox){
  if(!WORLD||!BAND)return;
  const claimed=new Map();
  for(const a of areas){
    const bb=areaBBox(a);
    const i0=clamp(WORLD.cellI(bb.mnx)-1,0,WORLD.width-1), i1=clamp(WORLD.cellI(bb.mxx)+1,0,WORLD.width-1);
    const j0=clamp(WORLD.cellJ(bb.mnz)-1,0,WORLD.height-1), j1=clamp(WORLD.cellJ(bb.mxz)+1,0,WORLD.height-1);
    const mark=new Set();
    for(let j=j0;j<=j1;j++)for(let i=i0;i<=i1;i++){
      const c=WORLD.cellCentre(i,j);
      if(pointInArea(c.x,c.z,a))mark.add(j*WORLD.width+i);
    }
    const grain=WORLD.cell/2;
    for(const ring of a.rings)for(let k=0;k<ring.length;k++){
      const p=ring[k],q=ring[(k+1)%ring.length];
      const L=Math.hypot(q[0]-p[0],q[1]-p[1]);
      const n2=Math.max(1,Math.ceil(L/grain));
      for(let s=0;s<=n2;s++){
        const t=s/n2;
        const i=WORLD.cellI(p[0]+(q[0]-p[0])*t), j=WORLD.cellJ(p[1]+(q[1]-p[1])*t);
        mark.add(j*WORLD.width+i);
      }
    }
    if(!mark.size)continue;
    let lvl=null;
    for(const k of mark){ if(claimed.has(k)){ lvl=claimed.get(k); break; } }
    if(lvl===null){
      const vals=[...mark].map(k=>BAND[k]).sort((p,q)=>p-q);
      lvl=vals[Math.floor(vals.length/2)];
    }
    a.groundY=(lvl*STEP-GROUND_M);   // metres, caller applies vertScale
    for(const k of mark){ BAND[k]=lvl; claimed.set(k,lvl); }
  }
}

/* Station heights for a trail ribbon: the highest terrace under the ribbon's own
   footprint at each vertex, guaranteeing the tread can't be buried by construction —
   same technique as the draped-Z version, reading from the DEM-derived bands instead. */
function stationHeights(rpts,w,vertScale){
  if(!WORLD||!BAND)return null;
  const n=rpts.length,out=new Array(n);
  const seg=new Array(n-1);
  for(let i=0;i<n-1;i++){
    const p=rpts[i],q=rpts[i+1],r=w/2;
    const i0=clamp(WORLD.cellI(Math.min(p[0],q[0])-r),0,WORLD.width-1),
          i1=clamp(WORLD.cellI(Math.max(p[0],q[0])+r),0,WORLD.width-1),
          j0=clamp(WORLD.cellJ(Math.min(p[1],q[1])-r),0,WORLD.height-1),
          j1=clamp(WORLD.cellJ(Math.max(p[1],q[1])+r),0,WORLD.height-1);
    const dqx=q[0]-p[0],dqz=q[1]-p[1],L2=dqx*dqx+dqz*dqz||1,reach=r+WORLD.cell*0.75;
    let m=-Infinity;
    for(let j=j0;j<=j1;j++)for(let k=i0;k<=i1;k++){
      const c=WORLD.cellCentre(k,j);
      let t=((c.x-p[0])*dqx+(c.z-p[1])*dqz)/L2;t=t<0?0:(t>1?1:t);
      if(Math.hypot(c.x-(p[0]+t*dqx),c.z-(p[1]+t*dqz))>reach)continue;
      const band=BAND[j*WORLD.width+k];
      if(band>m)m=band;
    }
    if(!isFinite(m))m=BAND[WORLD.cellJ(p[1])*WORLD.width+WORLD.cellI(p[0])];
    seg[i]=m;
  }
  for(let i=0;i<n;i++){
    const a=i>0?seg[i-1]:-Infinity,b=i<n-1?seg[i]:-Infinity;
    let band=Math.max(a,b);
    if(!isFinite(band))band=BAND[WORLD.cellJ(rpts[i][1])*WORLD.width+WORLD.cellI(rpts[i][0])];
    out[i]=(band*STEP-GROUND_M)*vertScale;
  }
  return out;
}

/* Resample a polyline so no gap exceeds `step`, keeping every original vertex. */
function resample(pts,step){
  if(pts.length<2)return pts.map(p=>p.slice());
  const out=[pts[0].slice()];
  for(let i=1;i<pts.length;i++){
    const a=pts[i-1],b=pts[i],L=Math.hypot(b[0]-a[0],b[1]-a[1]);
    const n=Math.max(1,Math.ceil(L/step));
    for(let k=1;k<=n;k++){
      const t=k/n;
      out.push([a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t]);
    }
  }
  return out;
}

/* Self-orienting quad builder, carried over unchanged from the standalone build: it
   computes a quad's own winding from its vertex positions and flips it to match the
   direction it needs to face, rather than hand-picking vertex order per branch. That
   hand-picking is exactly what left two of four riser cases backface-culled — verified
   by cross product, not assumed — leaking sky through the ground in a checkerboard. */
function buildTerrainMesh(vertScale){
  const W=WORLD;
  const P=[],N=[],UV=[],idx=[];
  const put=(x,y,z,nx,ny,nz)=>{
    P.push(x,y,z);N.push(nx,ny,nz);
    UV.push((x-W.originX)/(W.width*W.cell),(z-W.originZ)/(W.height*W.cell));
    return P.length/3-1;
  };
  const pushQuad=(p0,p1,p2,p3,dir)=>{
    const e1=[p1[0]-p0[0],p1[1]-p0[1],p1[2]-p0[2]];
    const e2=[p2[0]-p0[0],p2[1]-p0[1],p2[2]-p0[2]];
    let cx=e1[1]*e2[2]-e1[2]*e2[1], cy=e1[2]*e2[0]-e1[0]*e2[2], cz=e1[0]*e2[1]-e1[1]*e2[0];
    const dot=cx*dir[0]+cy*dir[1]+cz*dir[2];
    let order=[p0,p1,p2,p3];
    if(dot<0){order=[p0,p3,p2,p1];cx=-cx;cy=-cy;cz=-cz;}
    const L=Math.hypot(cx,cy,cz)||1,nx=cx/L,ny=cy/L,nz=cz/L;
    const a=put(order[0][0],order[0][1],order[0][2],nx,ny,nz),
          b=put(order[1][0],order[1][1],order[1][2],nx,ny,nz),
          c=put(order[2][0],order[2][1],order[2][2],nx,ny,nz),
          d=put(order[3][0],order[3][1],order[3][2],nx,ny,nz);
    idx.push(a,b,c,a,c,d);
  };
  const yOf=b=>(b*STEP-GROUND_M)*vertScale;
  for(let j=0;j<W.height;j++)for(let i=0;i<W.width;i++){
    const y=yOf(BAND[j*W.width+i]);
    const x0=W.originX+i*W.cell,x1=x0+W.cell,z0=W.originZ+j*W.cell,z1=z0+W.cell;
    pushQuad([x0,y,z0],[x0,y,z1],[x1,y,z1],[x1,y,z0],[0,1,0]);
    const yr=i<W.width-1?yOf(BAND[j*W.width+i+1]):y;
    if(yr!==y){
      const lo=Math.min(y,yr),hi=Math.max(y,yr),outDir=yr<y?[1,0,0]:[-1,0,0];
      pushQuad([x1,lo,z0],[x1,lo,z1],[x1,hi,z1],[x1,hi,z0],outDir);
    }
    const yb=j<W.height-1?yOf(BAND[(j+1)*W.width+i]):y;
    if(yb!==y){
      const lo=Math.min(y,yb),hi=Math.max(y,yb),outDir=yb<y?[0,0,1]:[0,0,-1];
      pushQuad([x0,lo,z1],[x1,lo,z1],[x1,hi,z1],[x0,hi,z1],outDir);
    }
  }
  const geo=new THREE.BufferGeometry();
  geo.setAttribute('position',new THREE.BufferAttribute(new Float32Array(P),3));
  geo.setAttribute('normal',new THREE.BufferAttribute(new Float32Array(N),3));
  geo.setAttribute('uv',new THREE.BufferAttribute(new Float32Array(UV),2));
  geo.setIndex(idx);
  return geo;
}

function groundTexture(theme){
  const c=document.createElement('canvas');c.width=c.height=256;
  const x=c.getContext('2d');
  x.fillStyle=theme.grass[0];x.fillRect(0,0,256,256);
  for(let i=0;i<1000;i++){
    x.fillStyle=theme.grass[1+(i%3)];
    x.beginPath();x.arc(Math.random()*256,Math.random()*256,2+Math.random()*7,0,7);x.fill();
  }
  for(let i=0;i<80;i++){
    x.fillStyle=theme.dust;
    x.beginPath();x.arc(Math.random()*256,Math.random()*256,6+Math.random()*17,0,7);x.fill();
  }
  const t=new THREE.CanvasTexture(c);t.wrapS=t.wrapT=THREE.RepeatWrapping;return t;
}

export { setWorld, setStep, getWorld, getStep, terrainY, rawGroundY, flattenAreaCells,
         stationHeights, resample, buildTerrainMesh, groundTexture };
