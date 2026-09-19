/* Trail-specific rendering: signs, blazes, gates, POI/area models, ground shadows,
   trail ribbons. None of this exists elsewhere in the repo -- Pup City and Backyard
   Pups have no notion of a trail network, a POI, or a graded area -- so it's entirely
   trail-owned. What IS shared (toon materials, math, terrain height) comes in via
   import rather than being redefined here, unlike the standalone build this was split
   from, which had its own copies of everything.

   groundYAt/nearestTrail are passed into the two functions that need them
   (buildArea, buildAreaSign) rather than imported directly, so this module never has to
   know about World, SEG_HASH, or VERT_SCALE -- those stay owned by world.js. */
import { clamp } from '../core/math.js';
import { toon, toonTex, sharedMat, M } from '../core/materials.js';
import { pointInArea, areaBBox, areaShape } from './geom2d.js';
import { THEME } from './themes.js';

function shade(hex,f){ // darken/lighten a hex color by a multiplier, for the rock palette
  const c=new THREE.Color(hex);
  return '#'+new THREE.Color(clamp(c.r*f,0,1),clamp(c.g*f,0,1),clamp(c.b*f,0,1)).getHexString();
}
function pickTree(rng){
  let r=rng(),acc=0;
  for(const[kind,w]of THEME.trees){acc+=w;if(r<=acc)return kind;}
  return THEME.trees[0][0];
}

function ribbonGeom(pts,w,y,elevArr){
  const P=[],N=[],idx=[];
  const addV=(x,z,yy)=>{P.push(x,yy,z);N.push(0,1,0);return P.length/3-1;};
  const baseY=i=>y+(elevArr?elevArr[i]:0);
  const pushTri=(a,b,c)=>{
    const ax=P[a*3],az=P[a*3+2],bx=P[b*3],bz=P[b*3+2],cx=P[c*3],cz=P[c*3+2];
    // y-component of (b-a) x (c-a); flip when it faces down, skip when degenerate
    const ny=(bz-az)*(cx-ax)-(bx-ax)*(cz-az);
    if(Math.abs(ny)<1e-7)return;
    if(ny>0)idx.push(a,b,c); else idx.push(a,c,b);
  };
  const segs=Math.max(0,pts.length-1),corner=[];
  for(let i=0;i<segs;i++){
    const p=pts[i],q=pts[i+1],yp=baseY(i),yq=baseY(i+1);
    let dx=q[0]-p[0],dz=q[1]-p[1];const L=Math.hypot(dx,dz)||1;dx/=L;dz/=L;
    const px=-dz*w/2,pz=dx*w/2;
    const aL=addV(p[0]+px,p[1]+pz,yp), aR=addV(p[0]-px,p[1]-pz,yp),
          bL=addV(q[0]+px,q[1]+pz,yq), bR=addV(q[0]-px,q[1]-pz,yq);
    pushTri(aL,bL,aR);pushTri(bL,bR,aR);
    corner.push([aL,aR,bL,bR]);
  }
  // Round joins. A single chord triangle across the bend still leaves the arc-shaped
  // sliver between the chord and the true swept region uncovered on sharp turns. A full
  // fan disc of radius w/2 at each interior vertex covers that region by construction:
  // segment quads + vertex discs = exactly the stadium swept by a width-w brush.
  const JOIN=12;
  for(let i=1;i<segs;i++){
    const cx=pts[i][0],cz=pts[i][1],yi=baseY(i),c=addV(cx,cz,yi);
    let prevIdx=addV(cx+w/2,cz,yi);
    for(let k=1;k<=JOIN;k++){
      const th=k/JOIN*Math.PI*2;
      const cur=addV(cx+Math.cos(th)*w/2,cz+Math.sin(th)*w/2,yi);
      pushTri(c,prevIdx,cur);
      prevIdx=cur;
    }
  }
  const geo=new THREE.BufferGeometry();
  geo.setAttribute('position',new THREE.BufferAttribute(new Float32Array(P),3));
  geo.setAttribute('normal',new THREE.BufferAttribute(new Float32Array(N),3));
  geo.setIndex(idx);/* test seam (tools/smoke.js): the centreline this ribbon was built from, so an
     assertion can measure which way a painted bar actually runs rather than trusting the
     constant that was supposed to decide it. */
  geo.__ribbon = pts.map(p=>[p[0],p[1]]);
  return geo;
}
/* ---------- fill embankment under a floating ribbon ----------

   The tread is smooth (gradeProfile filters it independently of the cell grid) while the
   terrain under it is a terrace staircase, so wherever the ground drops a whole band
   faster than the trail does, the ribbon is left hanging in mid-air over the gap. You can
   walk it -- standingY follows the tread, not the ground -- but it reads as a bug, and
   worse, it hides the fact that the route IS continuous there.

   So skirt it: a strip of ground sloping down and out from each edge of the tread to
   wherever the real terrain is. That is what a fill embankment on a real trail is, and
   the angle is the point -- a vertical curtain would close the hole just as well but
   would still read as a cliff, and the player needs to see that the drop is something
   you walk down rather than something that stops you.

   FACADE ONLY. Nothing collides with it and standingY does not know it exists: off the
   tread you are on terrain, exactly as before. Making it solid would mean feeding it back
   into the height field, and the height field is the thing whose coarseness caused this.

   groundYAt is passed in rather than imported, like buildArea's -- this module stays
   ignorant of World, VERT_SCALE and the band grid. */
const FILL_MIN_DROP = 0.35;   // under this the ribbon is on the ground; no skirt
const FILL_RUN = 1.6;         // horizontal run per unit of drop, about 32 degrees
const FILL_MAX_RUN = 9;       // a huge step gets a steeper skirt, not one across the map
const FILL_STOP_GAP = 0.6;    // clear space left between a shortened skirt and the tread below
const FILL_MIN_RUN_RATIO = 0.25;  // steepest the skirt is ever allowed to get, about 76 degrees

function embankmentGeom(pts, halfW, topYs, groundYAt, buriesTreadAt){
  if(!pts || pts.length < 2 || !topYs) return null;
  const P=[],N=[],idx=[];
  const push=(x,y,z)=>{ P.push(x,y,z); N.push(0,1,0); return P.length/3-1; };
  const setN=(i,nx,ny,nz)=>{ N[i*3]=nx; N[i*3+1]=ny; N[i*3+2]=nz; };
  const quad=(a,b,c,d)=>{
    /* Outward-facing winding, worked out from the actual vertices rather than assumed:
       the skirt runs down both sides of the trail and doubles back at switchbacks, so a
       fixed winding is right half the time and invisible the other half. */
    const ax=P[a*3],ay=P[a*3+1],az=P[a*3+2];
    const e1=[P[b*3]-ax,P[b*3+1]-ay,P[b*3+2]-az];
    const e2=[P[c*3]-ax,P[c*3+1]-ay,P[c*3+2]-az];
    let nx=e1[1]*e2[2]-e1[2]*e2[1], ny=e1[2]*e2[0]-e1[0]*e2[2], nz=e1[0]*e2[1]-e1[1]*e2[0];
    const L=Math.hypot(nx,ny,nz); if(L<1e-9) return;
    nx/=L; ny/=L; nz/=L;
    if(ny<0){ idx.push(a,c,b,a,d,c); nx=-nx; ny=-ny; nz=-nz; }
    else    { idx.push(a,b,c,a,c,d); }
    for(const v of [a,b,c,d]) setN(v,nx,ny,nz);
  };

  for(const side of [1,-1]){
    let prev = null;
    for(let i=0;i<pts.length;i++){
      const p=pts[i];
      const q=pts[Math.min(pts.length-1,i+1)], r=pts[Math.max(0,i-1)];
      let dx=q[0]-r[0], dz=q[1]-r[1]; const L=Math.hypot(dx,dz)||1; dx/=L; dz/=L;
      const ox=-dz*side, oz=dx*side;                 // outward, perpendicular to the run
      const ex=p[0]+ox*halfW, ez=p[1]+oz*halfW;
      const yTop=topYs[i];
      const gEdge=groundYAt(ex,ez);
      const drop=yTop-gEdge;
      // no gap here: end the strip rather than bridging across a stretch that needs no fill
      if(!(drop>FILL_MIN_DROP)){ prev=null; continue; }
      let run=Math.min(drop*FILL_RUN, FILL_MAX_RUN);
      /* STEEPEN RATHER THAN BURY. On a short switchback the next leg of the trail runs
         back underneath this one only a few metres out, and a skirt at the natural angle
         of repose reaches straight over the top of it -- the lower tread disappears under
         the upper one's embankment.

         So march out along the skirt and stop short of any tread that sits below us. The
         fill gets steeper exactly where it has to and keeps its natural angle everywhere
         else, which is better than steepening the whole map to fix the few places that
         need it. Floored rather than abandoned: a very steep skirt still closes the hole
         and still reads as ground, where no skirt at all leaves the tread hanging. */
      if(buriesTreadAt){
        const probes = 8;
        for(let t=1;t<=probes;t++){
          const dd = run*t/probes;
          if(buriesTreadAt(ex+ox*dd, ez+oz*dd, yTop)){
            run = Math.max(run*(t-1)/probes - FILL_STOP_GAP, 0);
            break;
          }
        }
        /* The march can step straight over a narrow tread between two clear probes, and
           the shortened run can still land on one. So verify the foot itself and back off
           until it is clear -- halving rather than re-marching, because by here we are
           only trimming the last stride and the answer is monotonic. A run that shrinks to
           nothing means there is no room for a fill at all, and no skirt is the right
           outcome: better a visible gap than a covered path. */
        let guard = 0;
        while(run > 0 && buriesTreadAt(ex+ox*run, ez+oz*run, yTop) && guard++ < 8) run *= 0.5;
        if(run <= FILL_STOP_GAP && buriesTreadAt(ex+ox*run, ez+oz*run, yTop)){ prev=null; continue; }
      }
      const fx=ex+ox*run, fz=ez+oz*run;
      let yFoot=groundYAt(fx,fz);
      /* Ground back up at the foot means the skirt would tunnel through a rise instead of
         landing on it -- happens on the inside of a switchback, where the next terrace up
         is within a run's reach. Land at the tread edge's own ground instead. */
      if(yFoot > yTop-0.05) yFoot = gEdge;
      const a=push(ex,yTop,ez), b=push(fx,yFoot,fz);
      if(prev) quad(prev.a, prev.b, b, a);
      prev={a,b};
    }
  }
  if(!idx.length) return null;
  const geo=new THREE.BufferGeometry();
  geo.setAttribute('position',new THREE.BufferAttribute(new Float32Array(P),3));
  geo.setAttribute('normal',new THREE.BufferAttribute(new Float32Array(N),3));
  geo.setIndex(idx);
  // test seam (tools/smoke.js): how many skirt quads this edge needed
  geo.userData = geo.userData || {};
  geo.userData.skirtQuads = idx.length/6;
  return geo;
}

/* ---------- bridges ----------

   A bridge is drawn from the SAME graded profile the path walks on (world.js raises that
   profile into a deck over the water, so standingY and the planks agree by construction)
   and consists of two meshes, however long it is:

     bridgeDeckGeom()   the walking surface -- planks laid across the deck, alternating
                        two browns through vertex colour, so a hundred planks are one draw
     bridgeFrameGeom()  everything that stands up: the stringers down each side that give
                        the deck visible thickness, and the railings (or, for a road, a
                        concrete parapet)

   Both are merged geometry built by hand rather than one Mesh per plank or post: a seven-
   bridge walk would otherwise add a few hundred meshes for furniture the eye reads as
   seven objects. Facade only -- nothing here collides; the deck profile is what you walk.

   `pts`/`ys` are the deck centreline and TOP height at each station, `width` the full
   deck width in true metres. */
const PLANK_M = 0.34;
function bridgeDeckGeom(pts, ys, width, colors){
  if(!pts || pts.length < 2) return null;
  const P=[], C=[], idx=[];
  const cA=new THREE.Color(colors[0]), cB=new THREE.Color(colors[1]);
  // walk the deck at plank spacing, carrying height and the local direction
  const arc=[0];
  for(let i=1;i<pts.length;i++) arc[i]=arc[i-1]+Math.hypot(pts[i][0]-pts[i-1][0], pts[i][1]-pts[i-1][1]);
  const total=arc[arc.length-1];
  if(!(total>0.05)) return null;
  const at=(s)=>{
    let i=1; while(i<pts.length-1 && arc[i]<s) i++;
    const t=clamp((s-arc[i-1])/Math.max(1e-9, arc[i]-arc[i-1]),0,1);
    const a=pts[i-1], b=pts[i];
    let dx=b[0]-a[0], dz=b[1]-a[1]; const L=Math.hypot(dx,dz)||1;
    return {x:a[0]+dx*t, z:a[1]+dz*t, y:ys[i-1]+(ys[i]-ys[i-1])*t, nx:-dz/L, nz:dx/L};
  };
  const n=Math.max(1, Math.round(total/PLANK_M));
  const hw=width/2, gap=Math.min(0.05, total/n*0.18);
  for(let k=0;k<n;k++){
    const s0=total*k/n + (k?gap/2:0), s1=total*(k+1)/n - (k<n-1?gap/2:0);
    const a=at(s0), b=at(s1);
    const base=P.length/3;
    P.push(a.x+a.nx*hw, a.y, a.z+a.nz*hw,  a.x-a.nx*hw, a.y, a.z-a.nz*hw,
           b.x+b.nx*hw, b.y, b.z+b.nz*hw,  b.x-b.nx*hw, b.y, b.z-b.nz*hw);
    const c=(k%2)?cA:cB;
    for(let v=0;v<4;v++) C.push(c.r,c.g,c.b);
    idx.push(base,base+2,base+1, base+2,base+3,base+1);
  }
  const N=new Float32Array(P.length); for(let i=1;i<N.length;i+=3) N[i]=1;
  const geo=new THREE.BufferGeometry();
  geo.setAttribute('position',new THREE.BufferAttribute(new Float32Array(P),3));
  geo.setAttribute('normal',new THREE.BufferAttribute(N,3));
  geo.setAttribute('color',new THREE.BufferAttribute(new Float32Array(C),3));
  geo.setIndex(idx);
  geo.userData = geo.userData || {};
  geo.userData.planks = n;       // test seam
  return geo;
}

/* Boxes into one indexed geometry. A "beam" runs from a to b (each [x,yTop,z]) with a
   horizontal cross-width `w`, hanging `h` below its top edge -- sheared rather than
   rotated when a and b differ in height, which is exactly what a rail following a
   humped deck should be. A "post" is an upright w x w column from y0 to y1. */
function pushBox(P, N, idx, corners){
  // corners: 8 [x,y,z], bottom ring 0-3 then top ring 4-7, both counter-clockwise from above
  const faces=[[0,1,2,3],[4,7,6,5],[0,4,5,1],[1,5,6,2],[2,6,7,3],[3,7,4,0]];
  let cx=0, cy=0, cz=0;
  for(const c of corners){ cx+=c[0]/8; cy+=c[1]/8; cz+=c[2]/8; }
  for(const f of faces){
    const a=corners[f[0]], b=corners[f[1]], c=corners[f[2]];
    const e1=[b[0]-a[0],b[1]-a[1],b[2]-a[2]], e2=[c[0]-a[0],c[1]-a[1],c[2]-a[2]];
    let nx=e1[1]*e2[2]-e1[2]*e2[1], ny=e1[2]*e2[0]-e1[0]*e2[2], nz=e1[0]*e2[1]-e1[1]*e2[0];
    const L=Math.hypot(nx,ny,nz)||1; nx/=L; ny/=L; nz/=L;
    /* Outward by measurement, not by trusting the corner order: a sheared beam on a
       reversed edge flips its own winding, and an inward normal lights a rail black. */
    let fx=0, fy=0, fz=0;
    for(const k of f){ fx+=corners[k][0]/4; fy+=corners[k][1]/4; fz+=corners[k][2]/4; }
    const flip=((fx-cx)*nx + (fy-cy)*ny + (fz-cz)*nz) < 0;
    if(flip){ nx=-nx; ny=-ny; nz=-nz; }
    const base=P.length/3;
    for(const k of f){ P.push(corners[k][0],corners[k][1],corners[k][2]); N.push(nx,ny,nz); }
    if(flip) idx.push(base,base+2,base+1, base,base+3,base+2);
    else     idx.push(base,base+1,base+2, base,base+2,base+3);
  }
}
function beamCorners(a, b, w, h){
  let dx=b[0]-a[0], dz=b[2]-a[2]; const L=Math.hypot(dx,dz)||1;
  const nx=-dz/L*w/2, nz=dx/L*w/2;
  const ring=(y0)=>[[a[0]+nx, y0(a), a[2]+nz],[a[0]-nx, y0(a), a[2]-nz],
                    [b[0]-nx, y0(b), b[2]-nz],[b[0]+nx, y0(b), b[2]+nz]];
  return [...ring(p=>p[1]-h), ...ring(p=>p[1])];
}
function postCorners(x, z, y0, y1, w){
  const r=w/2;
  const ring=(y)=>[[x-r,y,z-r],[x+r,y,z-r],[x+r,y,z+r],[x-r,y,z+r]];
  return [...ring(y0), ...ring(y1)];
}
/* style: 'wood' (footbridge: stringers + posts + two rails) or 'concrete' (road bridge:
   deep slab edges + a solid parapet). Returns {geo, color}. */
function bridgeFrameGeom(pts, ys, width, style){
  if(!pts || pts.length < 2) return null;
  const P=[], N=[], idx=[];
  const off=(i, side, inset)=>{
    const q=pts[Math.min(pts.length-1,i+1)], r=pts[Math.max(0,i-1)];
    let dx=q[0]-r[0], dz=q[1]-r[1]; const L=Math.hypot(dx,dz)||1;
    const d=width/2 - inset;
    return [pts[i][0]-dz/L*d*side, ys[i], pts[i][1]+dx/L*d*side];
  };
  const concrete = style==='concrete';
  const slabH = concrete ? 0.7 : 0.36, slabW = concrete ? 0.4 : 0.2;
  const railTop = concrete ? 0.75 : 0.95;
  for(const side of [-1,1]){
    let acc=1e9;
    for(let i=0;i<pts.length;i++){
      const here=off(i, side, slabW/2);
      if(i>0){
        const prev=off(i-1, side, slabW/2);
        acc+=Math.hypot(here[0]-prev[0], here[2]-prev[2]);
        // stringer / slab edge
        pushBox(P,N,idx, beamCorners(prev, here, slabW, slabH));
        if(concrete){
          // parapet: a solid low wall standing on the slab edge
          pushBox(P,N,idx, beamCorners([prev[0],prev[1]+railTop,prev[2]], [here[0],here[1]+railTop,here[2]], slabW*0.8, railTop));
        }else{
          // top and mid rail
          pushBox(P,N,idx, beamCorners([prev[0],prev[1]+railTop,prev[2]], [here[0],here[1]+railTop,here[2]], 0.1, 0.09));
          pushBox(P,N,idx, beamCorners([prev[0],prev[1]+railTop*0.52,prev[2]], [here[0],here[1]+railTop*0.52,here[2]], 0.08, 0.07));
        }
      }
      if(!concrete && (acc>=1.3 || i===0 || i===pts.length-1)){
        pushBox(P,N,idx, postCorners(here[0], here[2], here[1]-slabH, here[1]+railTop+0.04, 0.13));
        acc=0;
      }
    }
  }
  if(!idx.length) return null;
  const geo=new THREE.BufferGeometry();
  geo.setAttribute('position',new THREE.BufferAttribute(new Float32Array(P),3));
  geo.setAttribute('normal',new THREE.BufferAttribute(new Float32Array(N),3));
  geo.setIndex(idx);
  geo.userData = geo.userData || {};
  geo.userData.bridgeFrame = style;   // test seam
  return geo;
}
/* Planks need vertex colour, which no other trail material uses, so they get their own
   shared material rather than a variant of trailMat. Layer 2 bias, like a trail tread:
   the deck is painted over whatever ribbon it covers. */
function frameMat(color){
  return sharedMat('bridgeframe|'+color, () =>
    new THREE.MeshToonMaterial({color:new THREE.Color(color), gradientMap:toonTex, side:THREE.DoubleSide}));
}
function deckMat(){
  return sharedMat('deck|planks', () =>
    new THREE.MeshToonMaterial({color:new THREE.Color('#ffffff'), vertexColors:true, gradientMap:toonTex,
      side:THREE.DoubleSide, polygonOffset:true, polygonOffsetFactor:-9, polygonOffsetUnits:-9}));
}

/* `layer` is the path's CLASS rank (0 road, 1 track, 2 trail) -- see world.js's
   PATH_RANK. Every ribbon used to share one polygon offset, which is fine while nothing
   overlaps but is exactly wrong where a footpath crosses a service road: the two ribbons
   are near-coplanar, the depth test has no tie-break, and the crossing renders as a
   flickering patchwork that changes with camera angle. Biasing by class makes the answer
   deterministic and, more importantly, CORRECT -- the dirt path is painted on top of the
   tarmac, because that is what a path crossing a road looks like. world.js also lifts
   each class by a few centimetres (kindLift) so the ordering survives on hardware that
   clamps polygon offset; neither is visible as float at that size. */
function trailMat(color, layer){
  // DoubleSide is a safety net on top of the winding fix — cheap for a ribbon this size,
  // and guarantees the trail can never vanish again from a stray winding edge case.
  /* Shared per (colour, layer), which is the whole argument list. Every ribbon segment on
     the map used to get its own copy: 1,272 identical toon materials survived the toon()
     cache purely through this one function, because it builds its material directly
     rather than going through it. Nothing mutates a trail material after construction. */
  const L = layer || 0;
  return sharedMat('trail|'+color+'|'+L, () =>
    new THREE.MeshToonMaterial({color:new THREE.Color(color),gradientMap:toonTex,side:THREE.DoubleSide,
      polygonOffset:true,polygonOffsetFactor:-2-L*3,polygonOffsetUnits:-2-L*3}));
}
const INK='#3a2517';
function signText(label,dist,flip){
  const c=document.createElement('canvas');c.width=512;c.height=104;
  const x=c.getContext('2d');
  x.fillStyle='#b07c46';
  x.beginPath();
  if(!flip){x.moveTo(6,10);x.lineTo(430,10);x.lineTo(506,52);x.lineTo(430,94);x.lineTo(6,94);}
  else{x.moveTo(506,10);x.lineTo(82,10);x.lineTo(6,52);x.lineTo(82,94);x.lineTo(506,94);}
  x.closePath();x.fill();
  x.lineWidth=9;x.strokeStyle='#3d2a20';x.stroke();
  x.fillStyle='#8a5c30';for(let i=0;i<5;i++)x.fillRect(40+i*95,16,5,72);
  x.fillStyle='#2c1d14';x.textBaseline='middle';x.textAlign='left';
  const tx=flip?96:20;
  x.font='bold 40px "Comic Sans MS","Chalkboard SE",sans-serif';
  x.fillText(label.length>17?label.slice(0,16)+'…':label,tx,44);
  x.font='bold 26px "Comic Sans MS","Chalkboard SE",sans-serif';
  x.fillStyle='#5a3d24';x.fillText(dist,tx,80);
  const t=new THREE.CanvasTexture(c);t.minFilter=THREE.LinearFilter;return t;
}
function buildSign(node,arms){
  const g=new THREE.Group();g.position.set(node.p[0],0,node.p[1]);
  /* test seam: lets tools/smoke.js find every fingerpost in the scene and check none of
     them ended up planted in a carriageway. */
  g.__sign = true;
  const post=M(new THREE.CylinderGeometry(0.14,0.17,3.4,8),toon('#7a4e28'));
  post.position.y=1.7;g.add(post);
  const cap=M(new THREE.SphereGeometry(0.19,10,8),toon('#5c3a1c'));
  cap.position.y=3.42;g.add(cap);
  arms.slice(0,5).forEach((arm,i)=>{
    const grp=new THREE.Group();grp.rotation.y=-arm.angle;grp.position.y=3.0-i*0.52;
    const front=M(new THREE.PlaneGeometry(3.1,0.62),
      new THREE.MeshBasicMaterial({map:signText(arm.label,arm.dist,false),transparent:true}));
    front.position.set(1.62,0,0.045);grp.add(front);
    const back=M(new THREE.PlaneGeometry(3.1,0.62),
      new THREE.MeshBasicMaterial({map:signText(arm.label,arm.dist,true),transparent:true}));
    back.position.set(1.62,0,-0.045);back.rotation.y=Math.PI;grp.add(back);
    g.add(grp);
  });
  return g;
}
/* A road crossing, built as a piece of INFRASTRUCTURE rather than left to whatever the
   survey data happened to record.

   The source geometry crosses a service road at whatever angle the digitiser drew, which
   on a real map is often a long oblique smear where two ribbons overlap for fifteen
   metres and neither reads as passing over the other. Depth ordering makes that legible
   but not GOOD: it is still a diagonal scrape across a road with no indication of where
   a walker is meant to cross. Every real trail network solves this the same way, and it
   is a solved visual language -- square the path up to the kerb, stripe the carriageway,
   put a landing either side. So that is what gets built, and the exact survey angle is
   given up to get it. That trade is the whole point: you can see where to cross.

   `dir` is the road's axis (unit), `n` the walking direction across it. See below on why
   the markings run along `dir` and repeat along `n` rather than the other way round. */
function buildCrossing(rec, groundYAt){
  const g = new THREE.Group();
  const {x, z, dir, roadW, walkW, lift} = rec;
  const nx = -dir[1], nz = dir[0];      // across the carriageway = the walking direction

  /* CONTINENTAL ("ladder") MARKINGS, not a UK zebra -- the bars run ALONG the road and
     repeat ACROSS it. The first version had them the other way round, which is what the
     screenshot showed as a crosswalk rotated ninety degrees. Both patterns are real, but
     they are not interchangeable: this is a US trail network (Garden of the Gods), and a
     US crosswalk is a ladder. Getting it backwards makes the markings read as being for
     traffic rather than for the walker, which is exactly the wrong signal at the one
     place a walker has to decide whether to step out. */
  const BARS = 5;
  const acrossHalf = roadW*0.5;                 // markings stop at the carriageway edge
  const barW = (roadW*0.86)/(BARS*2 - 1);       // bar + equal gap, inset from the kerbs
  const bar = (offAcross) => {
    const cx = x + nx*offAcross, cz = z + nz*offAcross;
    const a = [cx - dir[0]*walkW*0.5, cz - dir[1]*walkW*0.5];
    const b = [cx + dir[0]*walkW*0.5, cz + dir[1]*walkW*0.5];
    const ys = [groundYAt(a[0], a[1]), groundYAt(b[0], b[1])];
    return new THREE.Mesh(ribbonGeom([a, b], barW, lift + 0.10, ys), trailMat('#f2ead6', 2));
  };
  for(let i = 0; i < BARS; i++) g.add(bar((i - (BARS-1)/2)*barW*2));

  /* Kerb + landing, one each side. The kerb gives the carriageway an edge for the
     markings to end at and the path a place to arrive; the landing is the pad the trail
     ribbon now stops on, since it no longer runs across the road. */
  const kerbW = Math.max(0.28, roadW*0.09);
  for(const sd of [-1, 1]){
    const kx = x + nx*sd*(acrossHalf + kerbW*0.5), kz = z + nz*sd*(acrossHalf + kerbW*0.5);
    const a = [kx - dir[0]*walkW*0.72, kz - dir[1]*walkW*0.72];
    const b = [kx + dir[0]*walkW*0.72, kz + dir[1]*walkW*0.72];
    const ys = [groundYAt(a[0], a[1]), groundYAt(b[0], b[1])];
    g.add(new THREE.Mesh(ribbonGeom([a, b], kerbW, lift + 0.105, ys), trailMat('#cdc3ad', 2)));
    const px = kx + nx*sd*(kerbW*0.5 + walkW*0.30), pz = kz + nz*sd*(kerbW*0.5 + walkW*0.30);
    const padGeo = new THREE.CircleGeometry(walkW*0.44, 18); padGeo.__circle = 'landing';
    const pad = new THREE.Mesh(padGeo, trailMat(THEME.tread, 2));
    pad.rotation.x = -Math.PI/2;
    pad.position.set(px, groundYAt(px, pz) + lift + 0.115, pz);
    g.add(pad);
  }
  return g;
}

/* short blaze post: reads as "you are on THIS trail" from a distance */
function buildBlaze(x,z,color){
  const g=new THREE.Group();g.position.set(x,0,z);
  const post=M(new THREE.CylinderGeometry(0.075,0.09,1.25,7),toon('#8a5c30'));
  post.position.y=0.62;g.add(post);
  const band=M(new THREE.CylinderGeometry(0.105,0.105,0.3,8),toon(color));
  band.position.y=1.06;g.add(band);
  const cap=M(new THREE.SphereGeometry(0.1,8,6),toon(THEME.blaze));
  cap.position.y=1.28;g.add(cap);
  return g;
}
function gateText(letter,name){
  const c=document.createElement('canvas');c.width=512;c.height=160;
  const x=c.getContext('2d');
  x.fillStyle='#c08d52';x.fillRect(0,0,512,160);
  x.lineWidth=12;x.strokeStyle='#3d2a20';x.strokeRect(6,6,500,148);
  x.fillStyle='#2c1d14';x.textAlign='center';x.textBaseline='middle';
  x.font='bold 52px "Comic Sans MS","Chalkboard SE",sans-serif';
  x.fillText('TRAILHEAD '+letter,256,54);
  x.font='bold 30px "Comic Sans MS","Chalkboard SE",sans-serif';
  x.fillStyle='#5a3d24';
  x.fillText((name.length>24?name.slice(0,23)+'…':name),256,102);
  x.font='bold 26px "Comic Sans MS","Chalkboard SE",sans-serif';
  x.fillStyle='#8a3b1e';x.fillText('▲ EXIT HERE ▲',256,136);
  const t=new THREE.CanvasTexture(c);t.minFilter=THREE.LinearFilter;return t;
}
/* A walk-through arch straddling the trail at each outer end — this is the exit. */
/* Scaled as a whole rather than by editing every dimension: the arch was modelled at
   about 4.3 m tall with a 5.5 m beam, which suited the old fire-road-width trails and
   towers over a metre-wide footpath. 0.55 puts the beam at roughly 2.4 m -- a trailhead
   arch you could walk under. Scaling the group works because its origin sits on the
   ground, so everything shrinks toward the feet rather than floating. */
const GATE_SCALE = 0.55;
function buildGate(h,i){
  const g=new THREE.Group();
  g.position.set(h.x,0,h.z);
  g.scale.setScalar(GATE_SCALE);
  g.rotation.y=h.yaw; // +X of the group runs up the trail, so posts sit on ±Z
  const wood=toon('#7a4e28'),beamC=toon('#8a5c30');
  for(const sd of[-1,1]){
    const post=M(new THREE.CylinderGeometry(0.2,0.24,4.2,8),wood);
    post.position.set(0,2.1,sd*2.5);g.add(post);
    const foot=M(new THREE.CylinderGeometry(0.34,0.4,0.3,8),toon(INK));
    foot.position.set(0,0.15,sd*2.5);g.add(foot);
  }
  const beam=M(new THREE.BoxGeometry(0.42,0.4,5.5),beamC);
  beam.position.y=4.1;g.add(beam);
  const tex=gateText(String.fromCharCode(65+i),h.name);
  for(const face of[1,-1]){
    const board=M(new THREE.PlaneGeometry(3.4,1.06),
      new THREE.MeshBasicMaterial({map:tex,transparent:true}));
    board.position.set(face*0.24,3.35,0);
    board.rotation.y=face>0?Math.PI/2:-Math.PI/2;
    g.add(board);
  }
  const pad=M(new THREE.CircleGeometry(3.0,24),
    new THREE.MeshBasicMaterial({color:new THREE.Color(h.color),transparent:true,opacity:0.32,depthWrite:false}));
  pad.rotation.x=-Math.PI/2;pad.position.y=0.1;g.add(pad);
  return g;
}
function makeTree(scale,kind,rng){
  const g=new THREE.Group();
  const trunk=M(new THREE.CylinderGeometry(0.14*scale,0.2*scale,1.1*scale,7),toon('#6b4728'));
  trunk.position.y=0.55*scale;g.add(trunk);
  const forest=THEME.id==='forest';
  if(kind==='pine'){
    const cols=forest?['#27492f','#2f5636','#1f3d27']:['#3f7a4a','#468a53','#38693f'];
    for(let i=0;i<3;i++){
      const cone=M(new THREE.ConeGeometry((1.15-i*0.28)*scale,1.1*scale,8),toon(cols[i]));
      cone.position.y=(1.3+i*0.7)*scale;g.add(cone);
    }
  }else if(kind==='blob'){
    const blob=M(new THREE.SphereGeometry(0.9*scale,10,8),toon(forest?'#33562f':'#5f8f47'));
    blob.scale.y=0.8;blob.position.y=1.5*scale;g.add(blob);
  }else{
    const blob=M(new THREE.SphereGeometry(0.75*scale,9,7),toon(THEME.id==='redrock'?'#41603f':'#4d7a54'));
    blob.scale.set(1.15,0.65,1.15);blob.position.y=1.0*scale;g.add(blob);
  }
  return g;
}
function makeRock(scale,rng){
  const col=THEME.rocks[(rng()*THEME.rocks.length)|0];
  if(THEME.rockStyle==='fin'){
    const g=new THREE.Group();
    const h=scale*(2.6+rng()*3.4);
    const fin=M(new THREE.BoxGeometry(scale*(0.7+rng()),h,scale*(2.2+rng()*2)),toon(col));
    fin.position.y=h/2;fin.rotation.y=rng()*3;fin.rotation.z=(rng()-0.5)*0.16;g.add(fin);
    const cap=M(new THREE.DodecahedronGeometry(scale*0.9,0),toon(col));
    cap.position.y=h;cap.scale.set(0.8,0.5,1.5);g.add(cap);
    return g;
  }
  const r=M(new THREE.DodecahedronGeometry(scale,0),toon(col));
  r.scale.y=0.55+rng()*0.3;r.rotation.y=rng()*7;r.position.y=scale*0.28;
  if(THEME.rockStyle==='mossy'){
    const moss=M(new THREE.SphereGeometry(scale*0.92,9,7,0,6.3,0,1.1),toon('#4b6b3a'));
    moss.position.y=scale*0.06;r.add(moss);
  }
  return r;
}

/* ============================================================
   POINTS & AREAS OF INTEREST
   ============================================================ */
const POI_STYLE={
  building:{em:'🏚️',label:'Building'}, tower:{em:'🗼',label:'Lookout'},
  rock:{em:'🪨',label:'Rock formation'}, viewpoint:{em:'🔭',label:'Viewpoint'},
  picnic:{em:'🧺',label:'Picnic spot'},  ruin:{em:'🏛️',label:'Ruin'},
  camp:{em:'⛺',label:'Campsite'},       water:{em:'💧',label:'Spring'},
  cairn:{em:'🗿',label:'Marker'},        tree:{em:'🌳',label:'Landmark tree'}
};
/* `solid` is a PHYSICS fact and it lives here, beside the drawing, because the two have
   to agree: an area is solid exactly when this table gives it real height off the ground.
   The landforms are extruded rock masses and a building is an extruded footprint with a
   roof cap -- you can see they are there, so walking through them reads as a bug. Every
   other kind is paint on the floor (a lot, a meadow, a pond), and blocking those would
   fence the map off with lines the player cannot see.

   Enforced OFF-TRAIL ONLY -- see world.js's areaBlocked and main.js's moveOffTrail. The
   default map has ~5 m of trail crossing the Kissing Camels polygon and rrworld ~2 m
   crossing a rock mass, so a collider that did not yield to the tread would wall off a
   route the map is drawn as though you can walk. The tread wins, as it does everywhere
   else in this game. */
const AREA_STYLE={
  water:{fill:'#5c9fd6',op:0.72,em:'💧',label:'Water'},
  forest:{fill:'#3f6b40',op:0.5,em:'🌲',label:'Forest'},
  meadow:{fill:'#86a852',op:0.36,em:'🌾',label:'Meadow'},
  rock:{fill:'#8a7360',op:0.6,em:'🪨',landform:true,solid:true,label:'Rock formation'},
  redrock:{fill:'#8a3e2c',op:0.65,em:'🪨',landform:true,solid:true,label:'Red rock formation'},
  lightrock:{fill:'#c9a87e',op:0.65,em:'🪨',landform:true,solid:true,label:'Light rock formation'},
  building:{fill:'#b08a63',op:1,em:'🏚️',solid:true,label:'Building'},
  parking:{fill:'#8d8578',op:0.85,em:'🅿️',paved:true,label:'Parking'}
};
function plaqueTex(title,sub){
  const c=document.createElement('canvas');c.width=384;c.height=112;
  const x=c.getContext('2d');
  x.fillStyle='#f2e3c4';x.fillRect(0,0,384,112);
  x.lineWidth=10;x.strokeStyle='#3d2a20';x.strokeRect(5,5,374,102);
  x.fillStyle='#2c1d14';x.textAlign='center';x.textBaseline='middle';
  x.font='bold 34px "Comic Sans MS","Chalkboard SE",sans-serif';
  x.fillText(title.length>18?title.slice(0,17)+'…':title,192,44);
  x.font='bold 22px "Comic Sans MS","Chalkboard SE",sans-serif';
  x.fillStyle='#6b4a2c';x.fillText(sub,192,80);
  const t=new THREE.CanvasTexture(c);t.minFilter=THREE.LinearFilter;return t;
}
/* a small double-sided plaque on a post, same trick as the trail signs */
function nameplate(text,sub,y){
  const g=new THREE.Group();
  const post=M(new THREE.CylinderGeometry(0.07,0.08,y,6),toon('#7a4e28'));
  post.position.y=y/2;g.add(post);
  const tex=plaqueTex(text,sub);
  for(const f of[1,-1]){
    const b=M(new THREE.PlaneGeometry(2.0,0.58),
      new THREE.MeshBasicMaterial({map:tex,transparent:true}));
    b.position.set(0,y+0.28,f*0.03);if(f<0)b.rotation.y=Math.PI;g.add(b);
  }
  return g;
}
function buildPOI(poi,rng){
  const g=new THREE.Group();
  const k=poi.kind;
  if(k==='building'||k==='ruin'){
    const w=2.6+rng()*1.4,d=2.2+rng()*1.2,hgt=k==='ruin'?1.5:2.6;
    const wall=M(new THREE.BoxGeometry(w,hgt,d),toon(k==='ruin'?'#9b8e7a':'#c49a6a'));
    wall.position.y=hgt/2;g.add(wall);
    if(k!=='ruin'){
      const roof=M(new THREE.ConeGeometry(Math.max(w,d)*0.82,1.5,4),toon('#8c4a33'));
      roof.rotation.y=Math.PI/4;roof.position.y=hgt+0.72;g.add(roof);
      const door=M(new THREE.BoxGeometry(0.06,1.15,0.7),toon('#5c3a1c'));
      door.position.set(w/2,0.58,0);g.add(door);
      for(const sd of[-1,1]){
        const win=M(new THREE.BoxGeometry(0.06,0.6,0.6),toon('#8fd0e6'));
        win.position.set(w/2,1.6,sd*d*0.28);g.add(win);
      }
    }else{ // knock a corner out so a ruin reads as ruined
      const gap=M(new THREE.BoxGeometry(w*0.42,hgt*0.75,d*0.42),toon(THEME.grass[0]));
      gap.position.set(w*0.3,hgt*0.7,d*0.3);g.add(gap);
    }
  }else if(k==='tower'){
    for(const sx of[-1,1])for(const sz of[-1,1]){
      const leg=M(new THREE.CylinderGeometry(0.11,0.14,4.6,6),toon('#7a4e28'));
      leg.position.set(sx*0.85,2.3,sz*0.85);leg.rotation.x=sz*0.05;leg.rotation.z=-sx*0.05;g.add(leg);
    }
    const deck=M(new THREE.BoxGeometry(2.6,0.22,2.6),toon('#a9743f'));
    deck.position.y=4.7;g.add(deck);
    const cab=M(new THREE.BoxGeometry(1.9,1.3,1.9),toon('#d9c39a'));
    cab.position.y=5.45;g.add(cab);
    const roof=M(new THREE.ConeGeometry(1.7,0.8,4),toon('#8c4a33'));
    roof.rotation.y=Math.PI/4;roof.position.y=6.5;g.add(roof);
  }else if(k==='rock'){
    const n=3+((rng()*3)|0);
    for(let i=0;i<n;i++){
      const s=0.9+rng()*1.9;
      const r=makeRock(s,rng);
      r.position.set((rng()-0.5)*4.2,r.position.y,(rng()-0.5)*4.2);
      g.add(r);
    }
    const spire=M(new THREE.ConeGeometry(1.1,4.2+rng()*2.4,6),
      toon(THEME.rocks[(rng()*THEME.rocks.length)|0]));
    spire.position.y=2.1+rng()*1.2;spire.rotation.y=rng()*3;g.add(spire);
  }else if(k==='viewpoint'){
    const rail=M(new THREE.BoxGeometry(0.16,0.16,3.4),toon('#7a4e28'));
    rail.position.y=1.0;g.add(rail);
    for(const sd of[-1,1]){
      const post=M(new THREE.CylinderGeometry(0.1,0.12,1.1,6),toon('#7a4e28'));
      post.position.set(0,0.55,sd*1.6);g.add(post);
    }
    const scope=M(new THREE.CylinderGeometry(0.13,0.18,0.9,8),toon('#4a5560'));
    scope.rotation.z=Math.PI/2.6;scope.position.set(-0.5,1.5,0);g.add(scope);
    const stand=M(new THREE.CylinderGeometry(0.08,0.12,1.3,6),toon('#4a5560'));
    stand.position.set(-0.5,0.65,0);g.add(stand);
  }else if(k==='picnic'){
    const top=M(new THREE.BoxGeometry(2.2,0.14,1.0),toon('#a9743f'));
    top.position.y=0.78;g.add(top);
    for(const sd of[-1,1]){
      const bench=M(new THREE.BoxGeometry(2.2,0.1,0.4),toon('#a9743f'));
      bench.position.set(0,0.45,sd*0.78);g.add(bench);
      const leg=M(new THREE.BoxGeometry(0.14,0.78,1.7),toon('#7a4e28'));
      leg.position.set(sd*0.85,0.39,0);g.add(leg);
    }
  }else if(k==='camp'){
    const tent=M(new THREE.ConeGeometry(1.4,1.8,4),toon('#c46a4a'));
    tent.rotation.y=Math.PI/4;tent.position.y=0.9;g.add(tent);
    const ring=M(new THREE.TorusGeometry(0.6,0.12,6,14),toon('#6b6357'));
    ring.rotation.x=-Math.PI/2;ring.position.set(2.2,0.12,0);g.add(ring);
    for(let i=0;i<3;i++){
      const log=M(new THREE.CylinderGeometry(0.07,0.07,0.8,6),toon('#7a4e28'));
      log.rotation.z=Math.PI/2;log.rotation.y=i*1.1;log.position.set(2.2,0.16,0);g.add(log);
    }
  }else if(k==='water'){
    const pool=M(new THREE.CircleGeometry(1.5,20),
      new THREE.MeshToonMaterial({color:new THREE.Color('#5c9fd6'),gradientMap:toonTex,
        transparent:true,opacity:0.85}));
    pool.rotation.x=-Math.PI/2;pool.position.y=0.07;g.add(pool);
    for(let i=0;i<7;i++){
      const s=makeRock(0.28+rng()*0.3,rng);
      const a=i/7*6.28;s.position.set(Math.cos(a)*1.75,s.position.y,Math.sin(a)*1.75);g.add(s);
    }
  }else if(k==='tree'){
    const t=makeTree(2.6*THEME.treeScale,'blob',rng);g.add(t);
  }else{ // cairn / generic marker
    let y=0;
    for(let i=0;i<5;i++){
      const s=0.55-i*0.075;
      const st=M(new THREE.DodecahedronGeometry(s,0),
        toon(THEME.rocks[(rng()*THEME.rocks.length)|0]));
      st.scale.y=0.6;st.position.y=y+s*0.3;st.rotation.y=rng()*3;g.add(st);
      y+=s*0.62;
    }
  }
  if(poi.name){
    const st=POI_STYLE[k]||POI_STYLE.cairn;
    const plate=nameplate(poi.name,st.label,k==='building'||k==='tower'?1.5:1.1);
    plate.position.set(0,0,k==='rock'?3.4:2.4);g.add(plate);
  }
  return g;
}
let PAVE_TEX=null;
function pavementTexture(){
  if(PAVE_TEX)return PAVE_TEX;
  const c=document.createElement('canvas');c.width=c.height=256;
  const x=c.getContext('2d');
  x.fillStyle='#84796c';x.fillRect(0,0,256,256);
  for(let i=0;i<600;i++){
    x.fillStyle=Math.random()<0.5?'rgba(50,46,40,.14)':'rgba(205,200,190,.09)';
    x.beginPath();x.arc(Math.random()*256,Math.random()*256,1+Math.random()*2.6,0,7);x.fill();
  }
  x.strokeStyle='rgba(255,255,255,.24)';x.lineWidth=3;
  for(let i=0;i<4;i++){const xx=24+i*64;x.beginPath();x.moveTo(xx,8);x.lineTo(xx,248);x.stroke();}
  const t=new THREE.CanvasTexture(c);t.wrapS=t.wrapT=THREE.RepeatWrapping;
  PAVE_TEX=t;return t;
}
/* Turns the actual QGIS-digitised footprint into a raised, jagged rock mass instead of a
   flat tinted patch with props scattered around it — the "basic shape creation" ask.
   Extruding the real polygon means Kissing Camels reads as the shape someone traced,
   not a generic prefab dropped at its centroid. */
function buildLandform(a,st,shape,bb,rng){
  const g=new THREE.Group();
  const hgt=clamp(2.6+Math.min(bb.w,bb.h)*0.1+rng()*3,2.6,15);
  const bevel=Math.min(1.0,Math.min(bb.w,bb.h)*0.1);
  const geo=new THREE.ExtrudeGeometry(shape,{depth:hgt,bevelEnabled:true,
    bevelThickness:bevel,bevelSize:bevel*0.75,bevelSegments:2});
  const palette=[st.fill,shade(st.fill,1.16),shade(st.fill,0.8)];
  const mat=palette.map(c=>toon(c));
  const m=M(geo,mat[(rng()*mat.length)|0]);
  // rotation.x=-90° maps local z (0..depth, the extrude axis) straight onto world y
  // (0..depth) with no extra vertical offset needed — the base already lands on y=0.
  // The previous position.y=hgt double-counted that height, lifting the whole mass
  // clean off the ground by its own height.
  m.rotation.x=-Math.PI/2;g.add(m);
  const nSpire=clamp(Math.round(bb.w*bb.h/150),2,10);
  let topY=hgt,placed=0,tries=0;
  while(placed<nSpire&&tries++<nSpire*12){
    const x=bb.mnx+rng()*bb.w,z=bb.mnz+rng()*bb.h;
    if(!pointInArea(x,z,a))continue;
    const s=0.9+rng()*1.8,sh=s*(2.2+rng()*1.6);
    const spire=M(new THREE.ConeGeometry(s*0.5,sh,6),mat[(rng()*mat.length)|0]);
    spire.position.set(x,hgt+sh/2-0.5,z);spire.rotation.y=rng()*6.28;g.add(spire);placed++;
    topY=Math.max(topY,hgt+sh-0.5);
  }
  /* Two different heights, and conflating them is what would put the player standing in
     mid-air on top of a spire tip. `topY` is the tallest thing in the group and is what
     the floating label clears. `slabY` is the flat extruded mass underneath -- the only
     part of a landform that is actually a surface -- and is what world.js registers as
     the walkable top. */
  /* THE MESH IS BIGGER THAN THE POLYGON, and every collision test in world.js needs to
     know by how much. ExtrudeGeometry's bevel pushes the surface `bevelSize` OUTWARD from
     the shape's outline and `bevelThickness` beyond each end of the extrusion -- so a rock
     drawn from a given polygon occupies bevel*0.75 more ground in every direction and
     stands bevel taller than `depth`.

     Nothing accounted for that, so the collision outline was the bare polygon and the pup
     could stand up to 0.75 units inside the visible stone. That is the reported screenshot:
     a pup clinging to a face with its body sunk into the rock, and a pup with only its head
     out of a wall. Reporting `inflate` here, from the same numbers that build the geometry,
     is what keeps the bounds and the mesh from drifting apart. */
  return{group:g,topY,slabY:hgt+bevel,inflate:bevel*0.75};
}
function floatingLabelTex(name,em){
  const c=document.createElement('canvas');c.width=512;c.height=128;
  const x=c.getContext('2d');
  x.textAlign='center';x.textBaseline='middle';
  x.font='bold 56px "Comic Sans MS","Chalkboard SE",sans-serif';
  x.lineWidth=15;x.strokeStyle='rgba(253,243,227,.95)';
  x.strokeText(em+' '+name,256,64);
  x.fillStyle='#3d2a20';x.fillText(em+' '+name,256,64);
  const t=new THREE.CanvasTexture(c);t.minFilter=THREE.LinearFilter;return t;
}
/* A camera-facing Sprite, not a flat ground plane — this is what makes it readable from
   far away: it billboards automatically (three.js does this for free with Sprite).

   depthTest is ON, which it was not. With it off, every area name floated on top of the
   whole scene, so a meadow two ridges away read as though it were in front of the hill
   you were looking at -- the labels stopped being landmarks and became a HUD that
   happened to move. Occluding them restores the depth cue: if you cannot see the place,
   you cannot see its name, and cresting a rise reveals both together.

   `label.baseScale` is stashed for world.js's per-frame pass, which caps how large the
   sprite may get up close. A Sprite is sized in WORLD units, so its on-screen size grows
   without bound as you approach -- walk up to a landmark and the name grows past the
   viewport, which is the "clips off screen" problem. The base size here is also smaller
   than it was (a 0.62 multiplier and a lower ceiling); it was competing with the terrain
   for attention. */
function buildFloatingLabel(name,em,width,topY){
  const tex=floatingLabelTex(name,em);
  const mat=new THREE.SpriteMaterial({map:tex,transparent:true,depthTest:true,depthWrite:false});
  const spr=new THREE.Sprite(mat);
  const w=clamp(width*0.62,4.5,12);
  spr.scale.set(w,w*0.25,1);
  spr.position.set(0,topY,0);
  spr.renderOrder=999;
  spr.userData.baseScale=w;      // read by world.js's updateAreaLabels
  spr.userData.areaLabel=true;
  return spr;
}
function buildArea(a,rng,groundYAt,nearestTrail,vertScale){
  const g=new THREE.Group();
  const st=AREA_STYLE[a.kind]||AREA_STYLE.meadow;
  const shape=areaShape(a);
  const bb=areaBBox(a);
  let labelY=3.5; // flat ground cover: just enough clearance to read as floating signage
  /* The height of the walkable top, in the group's own space -- null for anything that is
     paint on the floor. world.js turns it into an absolute world height once the group has
     been placed, and main.js stands the player on it (see areaSolidTop). Recorded here
     because this is the function that decides how tall these things are drawn, and a
     second opinion about it living anywhere else would be a surface that does not match
     the mesh under it. */
  let solidTop=null;
  // how far the drawn surface reaches past the polygon outline -- see buildLandform
  let solidInflate=0;
  if(st.landform){
    const built=buildLandform(a,st,shape,bb,rng);
    g.add(built.group);labelY=built.topY+2.2;
    solidTop=built.slabY;
    solidInflate=built.inflate;
  }else if(a.kind==='building'){
    const hgt=clamp(+(a.props.height||a.props.levels*3||0)||3.4,1.5,14);
    solidTop=hgt;
    const geo=new THREE.ExtrudeGeometry(shape,{depth:hgt,bevelEnabled:false});
    const m=M(geo,toon(st.fill));
    // see buildLandform: rotation alone maps the extrude's base to y=0, no offset needed
    m.rotation.x=-Math.PI/2;g.add(m);
    const capGeo=new THREE.ShapeGeometry(shape);
    const cap=M(capGeo,toon('#8c4a33'));
    cap.rotation.x=-Math.PI/2;cap.position.y=hgt+0.03;g.add(cap);
    labelY=hgt+2.4;
  }else{
    const geo=new THREE.ShapeGeometry(shape);
    const mat=new THREE.MeshToonMaterial({color:new THREE.Color(st.paved?'#ffffff':st.fill),
      map:st.paved?pavementTexture():null,gradientMap:toonTex,
      transparent:st.op<1,opacity:st.op,side:THREE.DoubleSide,
      polygonOffset:true,polygonOffsetFactor:-1,polygonOffsetUnits:-1});
    if(st.paved)mat.map.repeat.set(Math.max(1,bb.w/9),Math.max(1,bb.h/9));
    const m=M(geo,mat);
    m.rotation.x=-Math.PI/2;m.position.y=a.kind==='water'?0.09:0.03;
    g.add(m);
    // scatter matching cover inside the polygon, skipping the trail corridor
    const want=a.kind==='forest'?Math.min(90,bb.w*bb.h/70)
             :a.kind==='meadow'?Math.min(70,bb.w*bb.h/60):0;
    let placed=0,tries=0;
    while(placed<want&&tries++<want*12){
      const x=bb.mnx+rng()*bb.w,z=bb.mnz+rng()*bb.h;
      if(!pointInArea(x,z,a))continue;
      if(nearestTrail(x,z).d<4)continue;
      const o=a.kind==='forest'?makeTree((1.2+rng()*1.5)*THEME.treeScale,pickTree(rng),rng)
        :(()=>{const t=M(new THREE.ConeGeometry(0.17,0.55,5),toon(THEME.tuft));t.position.y=0.25;return t;})();
      o.position.x=x;o.position.z=z;g.add(o);placed++;
    }
  }
  if(a.name){
    const label=buildFloatingLabel(a.name,st.em,Math.max(7,a.name.length*0.7),labelY);
    label.position.x=bb.cx;label.position.z=bb.cz;g.add(label);
  }
  // sit the whole footprint at its local terrain height — a rigid shift rather than
  // draping every vertex individually, which is a fair simplification at the size most
  // of these polygons are (parking lots, groves, single buildings), and keeps a
  // building's walls vertical instead of trying to bend them with the slope.
  // a.groundY is set by terrain.js's flattenAreaCells in raw METRES -- its own comment
  // says so explicitly ("caller applies vertScale") -- but nothing was multiplying by
  // vertScale here, while groundYAt's fallback (terrainY) already bakes it in. The
  // mismatch (raw metres vs. metres*vertScale, a ~1.8x gap at the default exaggeration)
  // is what put every area with a claimed band floating above -- or sunk below -- the
  // ground mesh, which IS built with vertScale applied (buildTerrainMesh(VERT_SCALE)).
  g.position.y=(a.groundY!=null)?a.groundY*vertScale:groundYAt(bb.cx,bb.cz);
  // absolute now that the group is placed, which is the form every consumer wants
  if(solidTop!=null){
    g.userData.solidTop=g.position.y+solidTop;
    g.userData.solidInflate=solidInflate;   // 0 for buildings: their extrude has no bevel
  }
  return g;
}
function areaSignTex(title,sub){
  const c=document.createElement('canvas');c.width=448;c.height=140;
  const x=c.getContext('2d');
  x.fillStyle='#eddcb0';x.fillRect(0,0,448,140);
  x.lineWidth=10;x.strokeStyle='#3d2a20';x.strokeRect(5,5,438,130);
  x.fillStyle='#2c1d14';x.textAlign='center';x.textBaseline='middle';
  x.font='bold 38px "Comic Sans MS","Chalkboard SE",sans-serif';
  x.fillText(title.length>18?title.slice(0,17)+'…':title,224,56);
  x.font='bold 23px "Comic Sans MS","Chalkboard SE",sans-serif';
  x.fillStyle='#6b4a2c';x.fillText(sub,224,96);
  const t=new THREE.CanvasTexture(c);t.minFilter=THREE.LinearFilter;return t;
}
/* A signpost planted at whichever boundary point sits closest to the trail network, facing
   outward so it reads from the path — must run AFTER trails are hashed (nearestTrail needs
   SEG_HASH populated), unlike buildArea's ground cover which can go down any time. */
function buildAreaSign(a,groundYAt,nearestTrail){
  const bb=areaBBox(a);
  let best=null;
  for(const c of a.rings[0]){
    const nt=nearestTrail(c[0],c[1]);
    if(!best||nt.d<best.d)best={d:nt.d,pt:c};
  }
  const anchor=best?best.pt:a.rings[0][0];
  let dx=anchor[0]-bb.cx,dz=anchor[1]-bb.cz;
  const L=Math.hypot(dx,dz)||1;dx/=L;dz/=L;
  const st=AREA_STYLE[a.kind]||AREA_STYLE.meadow;
  const g=new THREE.Group();
  const signX=anchor[0]+dx*1.1,signZ=anchor[1]+dz*1.1;
  g.position.set(signX,groundYAt(signX,signZ),signZ);
  g.rotation.y=Math.atan2(dx,dz);
  const post=M(new THREE.CylinderGeometry(0.09,0.11,1.9,7),toon('#7a4e28'));
  post.position.y=0.95;g.add(post);
  const tex=areaSignTex(a.name,st.label||'Area');
  for(const f of[1,-1]){
    const b=M(new THREE.PlaneGeometry(2.5,0.78),
      new THREE.MeshBasicMaterial({map:tex,transparent:true}));
    b.position.set(0,1.65,f*0.035);if(f<0)b.rotation.y=Math.PI;g.add(b);
  }
  return g;
}

/* ---------- wildlife NPCs (built from the same rig) ---------- */
/* Soft radial-gradient blob, not a hard-edged circle — cheap, and it's the single
   biggest cue for "this animal is on the ground here" vs floating over the terrain. */
let SHADOW_TEX=null;
function shadowTexture(){
  if(SHADOW_TEX)return SHADOW_TEX;
  const c=document.createElement('canvas');c.width=c.height=128;
  const x=c.getContext('2d');
  const grad=x.createRadialGradient(64,64,0,64,64,64);
  grad.addColorStop(0,'rgba(20,14,10,.5)');grad.addColorStop(0.7,'rgba(20,14,10,.28)');
  grad.addColorStop(1,'rgba(20,14,10,0)');
  x.fillStyle=grad;x.fillRect(0,0,128,128);
  const t=new THREE.CanvasTexture(c);SHADOW_TEX=t;return t;
}
function makeShadow(radius){
  const m=M(new THREE.PlaneGeometry(radius*2,radius*2),
    new THREE.MeshBasicMaterial({map:shadowTexture(),transparent:true,depthWrite:false}));
  m.rotation.x=-Math.PI/2;
  return m;
}

/* ---------- horizon backdrop ----------
   The themes have carried `mountain` / `mountainStyle` since they were written, but
   nothing ever drew them, so "Deep forest" and "Red rock" only differed at your feet.
   This is the skyline that makes the choice read from the first frame.

   Three deliberate choices, each avoiding a bug this file has hit before:
   - side:DoubleSide. This is a decorative shell with no interior to see, so winding
     order is made irrelevant by construction rather than reasoned about. (Both the
     trail ribbons and the terraced terrain shipped with invisible backface-culled
     faces at some point; there is no reason to re-earn that lesson here.)
   - depthTest:false + renderOrder -1. Painted before anything else and never writing
     depth, so real terrain always draws on top of it however far away that terrain is.
     No z-fighting with the ground, no chance of a distant ridge poking through.
   - fog:false, with each band pre-blended toward the sky colour. Fog is tuned for a
     few hundred metres of trail; a backdrop that far out would be solid fog. Blending
     by hand gives the same aerial-perspective read at any fog setting.
   The group is re-centred on the camera every frame (main.js), so it behaves as a sky
   dome: you can never walk up to it. */
function mixHex(a, b, t){
  const ca=new THREE.Color(a), cb=new THREE.Color(b);
  return new THREE.Color(ca.r+(cb.r-ca.r)*t, ca.g+(cb.g-ca.g)*t, ca.b+(cb.b-ca.b)*t);
}
/* The outer band's radius, and the single source of truth for how far away the horizon
   ring sits. world.js sizes the camera's far plane off this, because the backdrop is the
   only thing in the scene that has to survive out beyond the fog wall -- everything else
   is fog-coloured mush by the time it gets there. Kept here, next to the geometry it
   describes, so the two cannot drift apart. */
function backdropRadius(theme, mapScale=1){
  const bands = (theme && theme.mountain && theme.mountain.length) || 3;
  return 900 * mapScale * (1 + (bands-1)*0.07);
}

function buildBackdrop(theme, rng, mapScale=1){
  const g = new THREE.Group();
  g.name = 'backdrop';
  const mesas = theme.mountainStyle === 'mesas';
  /* PROPORTIONAL TO THE RING, not a flat -600.

     The skirt only has to reach below the horizon line on screen; it was never meant to
     be a wall six hundred metres tall. The flat value was harmless while the far plane
     sat at 4000, and became load-bearing the moment the far plane came in to meet the
     fog: a vertex 600 below the camera is ~628 away from it, so a frustum sized for a
     192-metre fog wall would have clipped the bottom of the sky dome clean off.

     Tying it to R keeps the skirt the same shape at any map scale AND keeps the whole
     backdrop inside a sphere of radius ~1.2R, which is exactly what world.js sizes the
     far plane against. */
  const BASE_Y = -backdropRadius(theme, mapScale) * 0.55;
  const bands = theme.mountain.length;
  for(let b=0; b<bands; b++){
    const R = 900 * mapScale * (1 + b*0.07);
    const segs = 64;
    const peakH = (150 + b*55) * mapScale;
    const mat = new THREE.MeshBasicMaterial({
      color: mixHex(theme.mountain[b], theme.sky, 0.28 + b*0.17),
      /* REAL DEPTH NOW, where this used to be depthTest:false, depthWrite:false with
         renderOrder faking the layering by hand. That was fine as long as nothing but
         these bands themselves needed to agree with the ring's distance -- but sky.js's
         sun and moon sit at roughly this same radius (see its skyVector/placeBody) and
         need the ring to actually occlude them as they cross behind a ridge, which a
         depth-disabled paint can never do: it always wins by submission order, never by
         which surface is nearer. Turning depth back on is what lets a setting sun
         disappear behind the silhouette instead of floating in front of it.

         This also fixes a smaller, pre-existing wrong: with depth off, a FAR band drawn
         after a NEAR one simply overpainted it wherever both covered the same pixel, so
         the hazier outer ring occasionally showed through solid nearer rock. Real z gets
         that right too -- the closer band wins because it actually is closer. */
      side: THREE.DoubleSide, fog:false, depthTest:true, depthWrite:true,
    });
    // ridge profile: one height per segment, flat-topped runs for mesas, spikes for peaks
    const h = new Array(segs+1);
    let runH = 0, runLeft = 0;
    for(let i=0; i<=segs; i++){
      if(mesas){
        if(runLeft<=0){ runLeft = 3 + Math.floor(rng()*4); runH = peakH*(0.45+rng()*0.55); }
        runLeft--; h[i] = runH;
      }else{
        h[i] = peakH*(0.35 + rng()*0.65) * (i%2 ? 1 : 0.72);
      }
    }
    h[segs] = h[0];                        // close the ring seamlessly
    const P=[], idx=[];
    for(let i=0; i<=segs; i++){
      const a = i/segs*Math.PI*2;
      const x = Math.cos(a)*R, z = Math.sin(a)*R;
      P.push(x, BASE_Y, z, x, h[i], z);
    }
    for(let i=0; i<segs; i++){
      const v = i*2;
      idx.push(v, v+1, v+3, v, v+3, v+2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(P), 3));
    geo.setIndex(idx);
    const m = new THREE.Mesh(geo, mat);
    // no longer load-bearing for correctness (real depth settles overlaps now), kept as
    // a stable submission order -- cheapest first, in case the driver ever cares
    m.renderOrder = -10 + b;
    m.frustumCulled = false;               // it surrounds the camera; culling it is wrong
    g.add(m);
  }
  return g;
}


export { ribbonGeom, embankmentGeom, trailMat, INK, buildSign, buildBlaze, buildCrossing, buildGate, makeTree, makeRock,
         POI_STYLE, AREA_STYLE, nameplate, buildPOI, pavementTexture, buildLandform,
         buildFloatingLabel, buildArea, buildAreaSign, makeShadow, pickTree, shade,
         buildBackdrop, backdropRadius, bridgeDeckGeom, bridgeFrameGeom, deckMat, frameMat };
