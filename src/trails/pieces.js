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
import { patchGroundRing } from './noise-ring.js';
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
  /* Joins: fill ONLY the outer wedge of each bend, at the vertex's own height.

     This used to be a full disc of radius w/2 at every interior vertex -- segment quads
     plus discs is exactly the stadium a width-w brush sweeps, so in plan it was perfect.
     In elevation it was not: the disc is flat at the vertex height while the segment
     arriving at it is sloped, so on any grade the downhill half of every disc stood
     proud of the tread it was meant to be hidden in. One visible arc per station, each
     with the ink layer's own arc outlining it -- the "fish scales" down every climb.

     Both quads meeting at vertex i end on a horizontal edge through that vertex at
     exactly baseY(i), so the gap between them on the OUTSIDE of the bend is a flat
     wedge at that one height, and a fan over just that wedge is flush with both quads by
     construction. The inside of the bend is already covered twice (the quads overlap
     there), so nothing is drawn on that side at all. */
  const segDir=i=>{
    const p=pts[i],q=pts[i+1];let dx=q[0]-p[0],dz=q[1]-p[1];const L=Math.hypot(dx,dz);
    return L>1e-9?[dx/L,dz/L]:null;
  };
  for(let i=1;i<segs;i++){
    const d1=segDir(i-1), d2=segDir(i);
    if(!d1||!d2) continue;
    const cr=d1[0]*d2[1]-d1[1]*d2[0], dt=d1[0]*d2[0]+d1[1]*d2[1];
    if(Math.abs(cr)<1e-6 && dt>0) continue;             // straight on: no gap to fill
    const n1=[-d1[1],d1[0]], n2=[-d2[1],d2[0]];
    const tx=d2[0]-d1[0], tz=d2[1]-d1[1];              // points into the bend
    const into=(n1[0]+n2[0])*tx+(n1[1]+n2[1])*tz;
    const s=into>0?-1:1;                               // the side the bend opens away from
    const a1=Math.atan2(s*n1[1],s*n1[0]), a2=Math.atan2(s*n2[1],s*n2[0]);
    let da=a2-a1; while(da>Math.PI)da-=2*Math.PI; while(da<=-Math.PI)da+=2*Math.PI;
    // the wedge bulges away from the turn, i.e. along d1-d2; a U-turn is ambiguous at
    // exactly pi, so decide it by that rather than by the sign rounding happened to give
    const mid=a1+da/2, ox=d1[0]-d2[0], oz=d1[1]-d2[1];
    if(Math.cos(mid)*ox+Math.sin(mid)*oz<0) da=da>0?da-2*Math.PI:da+2*Math.PI;
    const steps=Math.max(1,Math.ceil(Math.abs(da)/(Math.PI/10)));
    const cx=pts[i][0],cz=pts[i][1],yi=baseY(i),c=addV(cx,cz,yi);
    let prevIdx=addV(cx+Math.cos(a1)*w/2,cz+Math.sin(a1)*w/2,yi);
    for(let k=1;k<=steps;k++){
      const th=a1+da*k/steps;
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
/* NEVER OVER WATER. A skirt is ground, and ground is drawn on top of water -- so where a
   path runs along a creek, the fill sloping down its creek-side edge reached straight out
   over the channel and painted a brown bank across the stream (the Seven Bridges Trail,
   for most of its length). The same fix as for a lower tread, for the same reason: stop
   the skirt FILL_WATER_PAD short of the water's drawn edge and let it steepen. Where the
   path's own edge is already that close to the water there is no room for a fill at all,
   and the right answer is none -- a tread edge standing at the water's edge is a bank,
   not a hole that needs closing. */
const FILL_WATER_PAD = 0.35;      // clear space kept between a skirt and the water's edge
const FILL_WATER_MIN_RUN = 0.05;  // a skirt this short is a vertical bank face
const FILL_EDGE_SAMPLES = 8;      // ground checks along each quad's bottom edge
const FILL_SINK = 0.1;            // how far a foot is buried below the ground it must reach
const FILL_REACH_RATE = 1.0;      // most a skirt's reach may change per unit along the path

/* THE SKIRT SAMPLES THE GROUND DENSELY, whatever the profile does. A graded profile only
   keeps a station where the line bends, so a long straight run on Pikes Peak had stations
   6-9 units apart -- and the skirt only asked "is the ground below me?" AT stations. Both
   ends of such a run could sit near the ground while the terraces between them fell away
   under the middle of it, and the tread was left floating with no skirt at all (60% of the
   floating edge along Barr Trail). So the edge is resampled to FILL_STATION spacing
   first, with heights interpolated linearly -- exactly as the ribbon above is drawn
   between the same stations -- and every one of those points is asked. */
const FILL_STATION = 1.0;
function densifyEdge(pts, ys){
  const P=[pts[0]], Y=[ys[0]];
  for(let i=1;i<pts.length;i++){
    const a=pts[i-1], b=pts[i], L=Math.hypot(b[0]-a[0], b[1]-a[1]);
    const n=Math.max(1, Math.ceil(L/FILL_STATION));
    for(let k=1;k<=n;k++){
      const u=k/n;
      P.push([a[0]+(b[0]-a[0])*u, a[1]+(b[1]-a[1])*u]);
      Y.push(ys[i-1]+(ys[i]-ys[i-1])*u);
    }
  }
  return {pts:P, ys:Y};
}

function embankmentGeom(pts0, halfW, topYs0, groundYAt, buriesTreadAt, waterDistAt){
  if(!pts0 || pts0.length < 2 || !topYs0) return null;
  const dense = densifyEdge(pts0, topYs0), pts = dense.pts, topYs = dense.ys;
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
    const strip = [], links = [];              // stations, and the quads between them
    let touch = null;                          // the last station where the ground met the tread
    /* HOW FAR EACH STATION REACHES, smoothed along the path. The natural reach is set by
       that station's own drop, and on terraced ground the drop jumps a whole step from one
       station to the next -- so a long reach stood next to a short one and the skirt's
       outer edge came out as a row of spikes. Rate-limited instead: a station may reach
       no more than FILL_REACH_RATE further than its neighbour per unit along the path, so
       the outline changes at 45 degrees at most. Only ever SHORTENS a reach (a lower
       envelope, forwards then backwards), and a shorter skirt is still one that meets the
       ground -- steeper, never floating. Stations that need no skirt break the chain. */
    const reach = new Array(pts.length).fill(null);
    for(let i=0;i<pts.length;i++){
      const p=pts[i], q=pts[Math.min(pts.length-1,i+1)], r=pts[Math.max(0,i-1)];
      let dx=q[0]-r[0], dz=q[1]-r[1]; const L=Math.hypot(dx,dz)||1; dx/=L; dz/=L;
      const ex=p[0]-dz*side*halfW, ez=p[1]+dx*side*halfW;
      const drop=topYs[i]-groundYAt(ex,ez);
      if(drop>FILL_MIN_DROP) reach[i]=Math.min(drop*FILL_RUN, FILL_MAX_RUN);
    }
    const gapTo = i => Math.hypot(pts[i][0]-pts[i-1][0], pts[i][1]-pts[i-1][1]);
    /* Neighbours only: a station beside one that needs no skirt is not limited by it. A
       strip now CLOSES to that station (see the no-gap case below), so its end already
       comes down to the tread edge; tapering the reach to zero there as well squeezed
       every station near a break to a sliver and left the interval open again. */
    for(let i=1;i<pts.length;i++) if(reach[i]!=null && reach[i-1]!=null) reach[i]=Math.min(reach[i], reach[i-1]+gapTo(i)*FILL_REACH_RATE);
    for(let i=pts.length-2;i>=0;i--) if(reach[i]!=null && reach[i+1]!=null) reach[i]=Math.min(reach[i], reach[i+1]+gapTo(i+1)*FILL_REACH_RATE);
    for(let i=0;i<pts.length;i++){
      const p=pts[i];
      const q=pts[Math.min(pts.length-1,i+1)], r=pts[Math.max(0,i-1)];
      let dx=q[0]-r[0], dz=q[1]-r[1]; const L=Math.hypot(dx,dz)||1; dx/=L; dz/=L;
      const ox=-dz*side, oz=dx*side;                 // outward, perpendicular to the run
      const ex=p[0]+ox*halfW, ez=p[1]+oz*halfW;
      const yTop=topYs[i];
      const gEdge=groundYAt(ex,ez);
      const drop=yTop-gEdge;
      /* No gap AT this station: the ground has come up to the tread. But the ground steps
         between stations, so the interval from the last skirted station to this one could
         be open half a terrace down -- the trail floating with no skirt at all. So the strip
         runs ON to here and closes with a zero-width edge (foot at the tread's edge), and
         the foot-lowering pass below drops that foot to the lowest ground in the interval.
         Likewise a strip that starts after such a station opens from it. Only where the
         ground meets the tread: a strip cut short by a lower tread or by water still stops
         dead, because covering those is the whole thing being avoided. */
      if(!(drop>FILL_MIN_DROP)){
        if(Number.isFinite(yTop) && Number.isFinite(gEdge)){
          const yF = Math.min(yTop, gEdge);
          if(prev){
            const a=push(ex,yTop,ez), b=push(ex,yF,ez);
            strip.push({a, b, fx:ex, fz:ez, yTop});
            links.push([prev, strip[strip.length-1]]);
          }
          touch = {i, ex, ez, yTop, yF};
        }else touch = null;
        prev=null; continue;
      }
      let run=Math.min(drop*FILL_RUN, FILL_MAX_RUN, reach[i]!=null ? reach[i] : Infinity);
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
      if(waterDistAt){
        if(waterDistAt(ex,ez) < FILL_WATER_PAD){ prev=null; continue; }
        // march at a fine stride: a creek is narrow next to a long run, and a coarse
        // march steps clean over it
        const probes = Math.max(8, Math.ceil(run/0.2));
        for(let t=1;t<=probes;t++){
          const dd = run*t/probes;
          if(waterDistAt(ex+ox*dd, ez+oz*dd) < FILL_WATER_PAD){
            run = Math.max(run*(t-1)/probes, FILL_WATER_MIN_RUN);
            break;
          }
        }
      }
      const fx=ex+ox*run, fz=ez+oz*run;
      let yFoot=groundYAt(fx,fz);
      /* Ground back up at the foot means the skirt would tunnel through a rise instead of
         landing on it -- happens on the inside of a switchback, where the next terrace up
         is within a run's reach. Land at the tread edge's own ground instead. */
      if(yFoot > yTop-0.05) yFoot = gEdge;
      // open from the touching station just before, if this strip starts right after one
      if(!prev && touch && touch.i === i-1){
        const a0=push(touch.ex,touch.yTop,touch.ez), b0=push(touch.ex,touch.yF,touch.ez);
        strip.push({a:a0, b:b0, fx:touch.ex, fz:touch.ez, yTop:touch.yTop});
        prev=strip[strip.length-1];
      }
      touch = null;
      const a=push(ex,yTop,ez), b=push(fx,yFoot,fz);
      strip.push({a, b, fx, fz, yTop});
      if(prev) links.push([prev, strip[strip.length-1]]);
      prev=strip[strip.length-1];
    }
    /* A BOTTOM EDGE THAT NEVER FLOATS. Each quad's bottom runs straight from one foot to
       the next, and on terraced ground the two feet land on different terraces -- so
       wherever the ground between them steps down, that straight edge hung in the air
       over the lower terrace, and you saw daylight under the trail through a skirt torn
       into separate triangular sails (a quarter of all bottom-edge length on Pikes Peak,
       up to 10 units clear of the ground under a switchback).

       So every foot is lowered to the lowest ground found along the bottom edge on either
       side of it, and FILL_SINK below that. A straight edge between two feet that are both
       at or under the lowest ground beneath it cannot come out above that ground anywhere
       along its length. What is lower than it needs to be is inside the terrain, where it
       is hidden; what fills the step down is exactly the gap that was showing. */
    const lowest = new Map();                       // foot vertex -> lowest ground to reach
    for(const [s0, s1] of links){
      let lo = Math.min(P[s0.b*3+1], P[s1.b*3+1]);
      for(let k=1;k<FILL_EDGE_SAMPLES;k++){
        const u = k/FILL_EDGE_SAMPLES;
        lo = Math.min(lo, groundYAt(s0.fx + (s1.fx - s0.fx)*u, s0.fz + (s1.fz - s0.fz)*u));
      }
      for(const f of [s0, s1]) if(!lowest.has(f.b) || lo < lowest.get(f.b)) lowest.set(f.b, lo);
    }
    for(const [b, lo] of lowest) P[b*3+1] = Math.min(P[b*3+1], lo - FILL_SINK);
    for(const [s0, s1] of links) quad(s0.a, s0.b, s1.b, s1.a);
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

/* ---------- the sides of a stream ----------

   The channel is carved wider than the water drawn in it (world.js WATER_BANK), leaving a
   strip of bed along each margin 0.3 units below the surface -- and a water ribbon is a
   single sheet with no sides. From any low angle you looked straight in under the surface
   through that strip: at the bed beneath the water, and at a wading pup's paws, which
   were below the surface and still in plain view. It also made the water read as a sheet
   floating over a trench rather than as water filling a channel.

   So close the sides: a curtain down each edge of the surface to the bed, one quad per
   station pair. The offset direction is the one the ribbon itself uses (averaged across
   each station), so the curtain meets the surface's edge. Colour is the caller's --
   a shade deeper than the surface, reading as depth. */
function waterSideGeom(pts, halfW, topYs, bottomYs){
  if(!pts || pts.length < 2) return null;
  const P=[], I=[];
  for(const side of [1,-1]){
    const base = P.length/3;
    for(let i=0;i<pts.length;i++){
      const q=pts[Math.min(pts.length-1,i+1)], r=pts[Math.max(0,i-1)];
      let dx=q[0]-r[0], dz=q[1]-r[1]; const L=Math.hypot(dx,dz)||1; dx/=L; dz/=L;
      const x=pts[i][0]-dz*side*halfW, z=pts[i][1]+dx*side*halfW;
      P.push(x, topYs[i], z, x, Math.min(bottomYs[i], topYs[i]-0.01), z);
    }
    for(let i=0;i<pts.length-1;i++){
      const a=base+i*2, b=base+(i+1)*2;
      I.push(a, a+1, b+1, a, b+1, b);
    }
  }
  const geo=new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(P),3));
  geo.setIndex(I);
  geo.computeVertexNormals();
  geo.__waterSide = true;
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
  return sharedMat('deck|planks', () => patchGroundRing(
    new THREE.MeshToonMaterial({color:new THREE.Color('#ffffff'), vertexColors:true, gradientMap:toonTex,
      side:THREE.DoubleSide, polygonOffset:true, polygonOffsetFactor:-9, polygonOffsetUnits:-9})));
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
/* THE GAPS AT A JUNCTION, and nothing else. Every ribbon arriving at a node ends on a
   straight butt edge through the node, perpendicular to its own first segment, at the
   node's height -- so a point at radius <= r from the node is already painted by an arm
   whenever it lies AHEAD of that arm's butt line (cos(theta - armAngle) >= 0). What is
   left is the set of directions that are behind EVERY arm's butt line: the outer wedge
   between two arms meeting at an angle, or the half-disc behind a lone arm (a round end).

   This replaces the flat full discs the junction pads used to be. Those had two faults:
   they were drawn wider than the ribbons they joined (a road visibly swelled at every
   junction), and a flat disc on a graded road stands proud of the downhill arm exactly as
   the old bend joins did. A fan over only the uncovered directions is flush with every
   butt edge by construction, because each butt edge is horizontal at the node height.

   Exact: the only places coverage can change are the butt-edge directions armAngle +- 90
   degrees, so those are the interval boundaries, and each interval is tested once at its
   midpoint. */
function junctionGapGeom(cx, cz, y, angles, r){
  const P = [], I = [];
  if(!angles.length){
    // nothing arrives: a plain disc (a lone node with every arm trimmed away is filtered
    // out by the caller; this only keeps the function total)
    angles = [];
  }
  const TAU = Math.PI*2;
  const norm = a => ((a % TAU) + TAU) % TAU;
  const cuts = [];
  for(const a of angles){ cuts.push(norm(a + Math.PI/2), norm(a - Math.PI/2)); }
  cuts.sort((a, b) => a - b);
  const covered = th => angles.some(a => Math.cos(th - a) >= -1e-9);
  const spans = [];
  if(!cuts.length) spans.push([0, TAU]);
  for(let k = 0; k < cuts.length; k++){
    const a0 = cuts[k], a1 = k + 1 < cuts.length ? cuts[k + 1] : cuts[0] + TAU;
    if(a1 - a0 < 1e-6) continue;
    if(!covered((a0 + a1)/2)) spans.push([a0, a1]);
  }
  P.push(cx, y, cz);
  for(const [a0, a1] of spans){
    const steps = Math.max(1, Math.ceil((a1 - a0)/(Math.PI/10)));
    let prev = P.length/3; P.push(cx + Math.cos(a0)*r, y, cz + Math.sin(a0)*r);
    for(let k = 1; k <= steps; k++){
      const th = a0 + (a1 - a0)*k/steps;
      const cur = P.length/3; P.push(cx + Math.cos(th)*r, y, cz + Math.sin(th)*r);
      I.push(0, cur, prev);                 // counter-clockwise seen from above (+y up)
      prev = cur;
    }
  }
  if(!I.length) return null;
  const N = new Float32Array(P.length); for(let i = 1; i < N.length; i += 3) N[i] = 1;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(P), 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  geo.setIndex(I);
  geo.__junctionGap = true;
  return geo;
}

/* Depth bias for every painted path layer. The UNITS term (constant depth, scaled by
   class rank) is what orders a road under a trail where the two are coplanar. The FACTOR
   term scales with how steeply the surface is seen, and it used to scale with rank as
   well -- -8 for a trail against -2 for a road -- which at the chase camera's grazing
   angle pulled a trail's tread forward far enough to paint over the feet of anything
   standing on it. Kind order is already carried geometrically by kindLift (4.5 cm per
   rank) and by the units term, so the slope term is one small constant for every layer. */
const TRAIL_BIAS_FACTOR = -1.5;
function trailMat(color, layer){
  // DoubleSide is a safety net on top of the winding fix — cheap for a ribbon this size,
  // and guarantees the trail can never vanish again from a stray winding edge case.
  /* Shared per (colour, layer), which is the whole argument list. Every ribbon segment on
     the map used to get its own copy: 1,272 identical toon materials survived the toon()
     cache purely through this one function, because it builds its material directly
     rather than going through it. Nothing mutates a trail material after construction. */
  const L = layer || 0;
  return sharedMat('trail|'+color+'|'+L, () => patchGroundRing(
    new THREE.MeshToonMaterial({color:new THREE.Color(color),gradientMap:toonTex,side:THREE.DoubleSide,
      polygonOffset:true,polygonOffsetFactor:TRAIL_BIAS_FACTOR,polygonOffsetUnits:-2-L*3})));
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
/* Fingerpost, modelled at the old dimensions and scaled as a whole (like the gate): the
   original 3.4 m post with 3.1 m arms was sized for fire-road-width trails and, planted
   beside a metre-wide footpath, its arms reached right across the tread in front of the
   camera. SIGN_SCALE puts the post at about 2.1 m with 1.9 m arms -- a real trail
   fingerpost -- and the origin is at the foot, so it shrinks toward the ground. */
const SIGN_SCALE = 0.62;
function buildSign(node,arms){
  const g=new THREE.Group();g.position.set(node.p[0],0,node.p[1]);
  g.scale.setScalar(SIGN_SCALE);
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
  cairn:{em:'🗿',label:'Marker'},        tree:{em:'🌳',label:'Landmark tree'},
  station:{em:'🚉',label:'Station'},     memorial:{em:'🪦',label:'Memorial'},
  /* FIXTURES: built into the scene but not landmarks. world.js keeps them out of POIS --
     no discovery burst, no minimap dot, no "waiting out there" count -- unless the source
     gave one a name, in which case it is somebody's named thing and is findable. A row of
     15 pylons and 3 crossing signs are scenery, not 18 places to go and look at. */
  pylon:{em:'⚡',label:'Power pylon',fixture:true},
  crossbuck:{em:'🚦',label:'Railroad crossing',fixture:true},
  buffer:{em:'🛑',label:'Buffer stop',fixture:true},
  gate:{em:'🚧',label:'Gate',fixture:true},
  toilet:{em:'🚻',label:'Toilets',fixture:true},
  infoboard:{em:'ℹ️',label:'Information',fixture:true},
  guidepost:{em:'🪧',label:'Guidepost',fixture:true}
};
/* The pylon's wire attachment points, shared with world.js which strings the spans:
   the model and the wires must agree on where the insulators are, or every wire ends in
   mid-air a metre off its arm. Local to a pylon facing +x along its line: arms run along
   z, so a span leaves each arm tip heading roughly +/-x. */
const PYLON = {h:12.5, armY:[10.4, 8.2], armHalf:[2.3, 3.0], wireDrop:0.55};
function pylonWirePoints(){
  const out=[];
  PYLON.armY.forEach((y,i)=>{ for(const sd of [-1,1]) out.push([0, y-PYLON.wireDrop, sd*PYLON.armHalf[i]]); });
  out.push([0, PYLON.h+0.1, 0]);          // earth wire off the peak
  return out;
}
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
  /* solid: a lot is a graded pad, and where it stands above the ground beside it (the
     kerb wall's side) that face is a wall, not something to walk into. Its top is the
     slab (buildArea's solidTop), and world.js levels the slab to its entrance road, so
     the way in is flush and every other edge is a retaining wall or a cut bank. */
  parking:{fill:'#8d8578',op:0.85,em:'🅿️',paved:true,solid:true,label:'Parking'},
  /* A platform is a slab you step UP onto beside the track, so it is drawn and collided
     exactly as a very low building: `slab` is its fixed height in metres, `cap` the top
     colour, `edge` the painted safety line round the rim. A station building is a
     building with a station's colours. */
  platform:{fill:'#9d968a',op:1,em:'🚉',solid:true,slab:0.85,cap:'#c9c2b3',edge:'#e8c53a',label:'Platform'},
  depot:{fill:'#e3d3a8',op:1,em:'🚉',solid:true,roof:'#3f6b4a',label:'Station'}
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
  }else if(k==='station'){
    /* A little mountain depot: cream board walls, a green hipped roof with deep eaves, a
       concrete platform along the front. When the map also has the station's real
       footprint as an area, world.js sets `signOnly` and the building is not doubled --
       the landmark is then just the name board, beside the building it names. */
    if(!poi.signOnly){
      const w=6.4, d=3.6, hgt=3.0;
      const wall=M(new THREE.BoxGeometry(w,hgt,d),toon('#e3d3a8')); wall.position.y=hgt/2; g.add(wall);
      const trim=M(new THREE.BoxGeometry(w+0.12,0.28,d+0.12),toon('#7a4e28')); trim.position.y=0.14; g.add(trim);
      const roof=M(new THREE.ConeGeometry(Math.hypot(w,d)*0.62,1.7,4),toon('#3f6b4a'));
      roof.rotation.y=Math.PI/4; roof.scale.set(1,1,d/w*1.25); roof.position.y=hgt+0.84; g.add(roof);
      for(const sx of [-0.3,0.3]){
        const win=M(new THREE.BoxGeometry(0.9,0.9,0.06),toon('#8fd0e6')); win.position.set(sx*w,1.8,d/2+0.02); g.add(win);
      }
      const door=M(new THREE.BoxGeometry(1.0,2.0,0.06),toon('#5c3a1c')); door.position.set(0,1.0,d/2+0.03); g.add(door);
      const plat=M(new THREE.BoxGeometry(w+3,0.6,2.4),toon('#c9c2b3')); plat.position.set(0,0.3,d/2+1.2); g.add(plat);
      const edge=M(new THREE.BoxGeometry(w+3,0.04,0.2),toon('#e8c53a')); edge.position.set(0,0.62,d/2+2.3); g.add(edge);
    }
    // the running-in board: the station's name, on two posts, facing the track side
    for(const sx of [-1,1]){
      const post=M(new THREE.CylinderGeometry(0.07,0.08,2.3,6),toon('#3a3a3a')); post.position.set(sx*1.3,1.15,poi.signOnly?0:4.6); g.add(post);
    }
    const board=M(new THREE.BoxGeometry(3.0,0.7,0.1),toon('#1f3d6b')); board.position.set(0,2.1,poi.signOnly?0:4.6); g.add(board);
    // the name itself, painted on: its own textured material, not a shared toon()
    const faceMat=poi.name
      ? new THREE.MeshToonMaterial({map:plaqueTex(poi.name,'Station'),gradientMap:toonTex})
      : toon('#f2ead6');
    for(const sz of [1,-1]){            // both faces: the board is read from either platform side
      const face=M(new THREE.BoxGeometry(2.7,0.5,0.02),faceMat);
      face.position.set(0,2.1,(poi.signOnly?0:4.6)+sz*0.06); if(sz<0) face.rotation.y=Math.PI; g.add(face);
    }
  }else if(k==='memorial'){
    // stepped granite base, a dressed block, a bronze plaque on the face
    const base=M(new THREE.BoxGeometry(1.8,0.3,1.4),toon('#8f8a82')); base.position.y=0.15; g.add(base);
    const step=M(new THREE.BoxGeometry(1.4,0.25,1.0),toon('#9d978e')); step.position.y=0.42; g.add(step);
    const block=M(new THREE.BoxGeometry(1.0,1.3,0.55),toon('#a8a39a')); block.position.y=1.2; g.add(block);
    const plaque=M(new THREE.BoxGeometry(0.62,0.44,0.05),toon('#8a6a2a')); plaque.position.set(0,1.3,0.3); g.add(plaque);
  }else if(k==='pylon'){
    /* Lattice tower, facing +x along its line (world.js turns it to face its neighbours).
       Four tapering legs, horizontal bracing at three levels, two cross-arms along z with
       insulators hanging from the tips -- the tips are PYLON.armHalf out, the same
       numbers pylonWirePoints() gives world.js for the wires. */
    const steel='#8e959b', base=1.7, top=0.35;
    const lerp=(a,b,t)=>a+(b-a)*t;
    for(const sx of [-1,1])for(const sz of [-1,1]){
      const L=Math.hypot(PYLON.h, (base-top)*Math.SQRT2);
      const leg=M(new THREE.CylinderGeometry(0.07,0.1,L,4),toon(steel));
      leg.position.set(sx*(base+top)/2, PYLON.h/2, sz*(base+top)/2);
      leg.rotation.z=-sx*Math.atan((base-top)/PYLON.h); leg.rotation.x=sz*Math.atan((base-top)/PYLON.h);
      g.add(leg);
    }
    for(const t of [0.25,0.5,0.75]){
      const hw=lerp(base,top,t), y=PYLON.h*t;
      for(const ax of [0,1]){
        for(const sd of [-1,1]){
          const bar=M(new THREE.BoxGeometry(ax?0.08:hw*2,0.08,ax?hw*2:0.08),toon(steel));
          bar.position.set(ax?sd*hw:0, y, ax?0:sd*hw); g.add(bar);
        }
      }
    }
    PYLON.armY.forEach((y,i)=>{
      const arm=M(new THREE.BoxGeometry(0.22,0.22,PYLON.armHalf[i]*2),toon(steel)); arm.position.y=y; g.add(arm);
      for(const sd of [-1,1]){
        const ins=M(new THREE.CylinderGeometry(0.09,0.09,PYLON.wireDrop,6),toon('#6a8fa8'));
        ins.position.set(0, y-PYLON.wireDrop/2, sd*PYLON.armHalf[i]); g.add(ins);
      }
    });
    const peak=M(new THREE.ConeGeometry(0.4,1.4,4),toon(steel)); peak.position.y=PYLON.h-0.4; g.add(peak);
  }else if(k==='crossbuck'){
    /* A railroad crossbuck: white X boards with a dark border on a grey post, a pair of red
       lamps below. world.js stands one each side of the track, turned to face the road. */
    const post=M(new THREE.CylinderGeometry(0.08,0.09,3.4,8),toon('#b5b5b0')); post.position.y=1.7; g.add(post);
    for(const r of [Math.PI/4,-Math.PI/4]){
      const back=M(new THREE.BoxGeometry(1.95,0.36,0.05),toon('#2a2a2a')); back.position.y=3.0; back.rotation.z=r; g.add(back);
      const face=M(new THREE.BoxGeometry(1.8,0.26,0.07),toon('#f4f1e8')); face.position.y=3.0; face.rotation.z=r; g.add(face);
    }
    const bar=M(new THREE.BoxGeometry(1.1,0.1,0.1),toon('#2a2a2a')); bar.position.y=2.1; g.add(bar);
    for(const sx of [-1,1]){
      const lamp=M(new THREE.CylinderGeometry(0.17,0.17,0.12,10),toon('#c33b2c'));
      lamp.rotation.x=Math.PI/2; lamp.position.set(sx*0.5,2.1,0.08); g.add(lamp);
    }
  }else if(k==='buffer'){
    // end of the line: two posts and a red-and-white beam across the rails
    for(const sx of [-1,1]){
      const post=M(new THREE.BoxGeometry(0.28,1.0,0.28),toon('#4a4038')); post.position.set(0,0.5,sx*0.72); g.add(post);
    }
    const beam=M(new THREE.BoxGeometry(0.36,0.4,2.3),toon('#c33b2c')); beam.position.y=0.9; g.add(beam);
    for(const sz of [-0.6,0,0.6]){
      const stripe=M(new THREE.BoxGeometry(0.38,0.42,0.22),toon('#f4f1e8')); stripe.position.set(0,0.9,sz); g.add(stripe);
    }
  }else if(k==='gate'){
    /* A field gate, left OPEN: posts either side of the path, the five-bar leaf swung back
       along it -- a closed gate across a trail the player can walk through would be a lie.
       Local +x is along the path (world.js turns it); the posts stand GATE_POST_OFF out. */
    const off=poi.gateHalf || 1.2;
    for(const sd of [-1,1]){
      const post=M(new THREE.CylinderGeometry(0.1,0.12,1.5,6),toon('#6b4a2c')); post.position.set(0,0.75,sd*off); g.add(post);
    }
    const leaf=new THREE.Group(); leaf.position.set(0,0,off);
    for(let i=0;i<4;i++){
      const bar=M(new THREE.BoxGeometry(off*1.8,0.07,0.05),toon('#a9743f')); bar.position.set(-off*0.9,0.3+i*0.3,0); leaf.add(bar);
    }
    const brace=M(new THREE.BoxGeometry(Math.hypot(off*1.8,0.9),0.07,0.05),toon('#a9743f'));
    brace.position.set(-off*0.9,0.75,0); brace.rotation.z=Math.atan2(0.9,off*1.8); leaf.add(brace);
    leaf.rotation.y=-0.25; g.add(leaf);
  }else if(k==='toilet'){
    // an outhouse: plank box, sloped roof, door with the crescent moon
    const box=M(new THREE.BoxGeometry(1.3,2.1,1.3),toon('#8a6a45')); box.position.y=1.05; g.add(box);
    const roof=M(new THREE.BoxGeometry(1.6,0.12,1.7),toon('#5c4a3a')); roof.position.y=2.2; roof.rotation.x=0.12; g.add(roof);
    const door=M(new THREE.BoxGeometry(0.8,1.7,0.05),toon('#6b4a2c')); door.position.set(0,0.9,0.67); g.add(door);
    const moon=M(new THREE.TorusGeometry(0.1,0.03,5,10,Math.PI*1.2),toon('#f2e3a0')); moon.position.set(0,1.45,0.7); g.add(moon);
  }else if(k==='infoboard'){
    // a trailhead kiosk: two posts, a shingled roof, a map panel under glass
    for(const sx of [-1,1]){
      const post=M(new THREE.BoxGeometry(0.16,2.3,0.16),toon('#6b4a2c')); post.position.set(sx*0.9,1.15,0); g.add(post);
    }
    const panel=M(new THREE.BoxGeometry(1.6,1.0,0.08),toon('#6b4a2c')); panel.position.y=1.45; g.add(panel);
    const map=M(new THREE.BoxGeometry(1.4,0.82,0.1),toon('#cfe0b0')); map.position.y=1.45; g.add(map);
    const trail=M(new THREE.BoxGeometry(0.9,0.05,0.11),toon('#b0472e')); trail.position.set(0.05,1.5,0); trail.rotation.z=0.35; g.add(trail);
    const roof=M(new THREE.ConeGeometry(1.35,0.55,4),toon('#5c4a3a')); roof.rotation.y=Math.PI/4; roof.scale.set(1,1,0.4); roof.position.y=2.55; g.add(roof);
  }else if(k==='guidepost'){
    // a fingerpost: one post, arms pointing three ways
    const post=M(new THREE.CylinderGeometry(0.07,0.08,2.2,6),toon('#7a4e28')); post.position.y=1.1; g.add(post);
    [[0,1.85],[2.1,1.6],[4.2,1.35]].forEach(([a,y])=>{
      const arm=new THREE.Group(); arm.position.y=y; arm.rotation.y=a;
      const board=M(new THREE.BoxGeometry(0.9,0.2,0.05),toon('#e8d9b0')); board.position.x=0.45; arm.add(board);
      const tip=M(new THREE.ConeGeometry(0.14,0.2,3),toon('#e8d9b0')); tip.rotation.z=-Math.PI/2; tip.position.x=0.99; arm.add(tip);
      g.add(arm);
    });
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
    /* The station's own running-in board already carries its name, and a pylon's plate
       would stand under a live wire; everything else gets the usual plaque */
    if(k!=='station'){
      const plate=nameplate(poi.name,st.label,k==='building'||k==='tower'?1.5:1.1);
      plate.position.set(0,0,k==='rock'?3.4:k==='pylon'?3.2:2.4);g.add(plate);
    }
  }
  return g;
}
/* ---------- railway track ----------
   Built as a few MERGED geometries per edge rather than a mesh per sleeper: a 14 km cog
   line at 1:5 is ~4,000 sleepers, and one draw call each would be the tablet stutter the
   material cache exists to prevent. Dimensions are real metres (standard gauge), because
   the track is an object the pup stands on, like the tread widths in world.js's PATH_W.

   Stacked on the graded profile the ballast ribbon was drawn from, all offsets relative
   to it: ballast at +0.05 (the tread height every path uses), sleepers on the ballast,
   rails on the sleepers. `rack` adds the toothed centre rail of a cog railway. */
const RAIL = {gaugeHalf:0.72, railW:0.1, railH:0.13, tieLen:2.5, tieW:0.24, tieH:0.1,
              tieGap:0.65, rackW:0.16, rackH:0.1, toothGap:0.4, toothW:0.1};
function segFrame(pts, i){
  // unit direction at vertex i: the average of the segments either side (a mitre-free
  // bisector, good enough for track whose bends are gentle by construction)
  const a=pts[Math.max(0,i-1)], b=pts[Math.min(pts.length-1,i+1)];
  let dx=b[0]-a[0], dz=b[1]-a[1]; const L=Math.hypot(dx,dz)||1;
  return [dx/L, dz/L];
}
/* A solid strip along the line, offset `off` to the side: top face plus both walls,
   from y0 to y1 above the profile. Non-indexed so flat shading shows the edges. */
function stripGeom(pts, ys, off, w, y0, y1){
  const P=[];
  const at=i=>{ const [dx,dz]=segFrame(pts,i); const nx=-dz, nz=dx; return {x:pts[i][0]+nx*off, z:pts[i][1]+nz*off, nx, nz, y:ys?ys[i]:0}; };
  for(let i=0;i+1<pts.length;i++){
    const A=at(i), B=at(i+1), hw=w/2;
    const aL=[A.x+A.nx*hw, A.z+A.nz*hw], aR=[A.x-A.nx*hw, A.z-A.nz*hw];
    const bL=[B.x+B.nx*hw, B.z+B.nz*hw], bR=[B.x-B.nx*hw, B.z-B.nz*hw];
    const q=(p1,y1a,p2,y2a,p3,y3a,p4,y4a)=>P.push(p1[0],y1a,p1[1], p2[0],y2a,p2[1], p3[0],y3a,p3[1],
                                                   p1[0],y1a,p1[1], p3[0],y3a,p3[1], p4[0],y4a,p4[1]);
    q(aL,A.y+y1, bL,B.y+y1, bR,B.y+y1, aR,A.y+y1);         // top
    q(aL,A.y+y0, bL,B.y+y0, bL,B.y+y1, aL,A.y+y1);         // left wall
    q(aR,A.y+y1, bR,B.y+y1, bR,B.y+y0, aR,A.y+y0);         // right wall
  }
  if(!P.length) return null;
  const g=new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(P),3));
  g.computeVertexNormals();
  return g;
}
/* Evenly spaced stations along the polyline, `gap` apart, each with its height
   interpolated from the profile and the local direction. */
function stationsAlong(pts, ys, gap){
  const out=[]; let carry=gap/2;
  for(let i=0;i+1<pts.length;i++){
    const a=pts[i], b=pts[i+1], L=Math.hypot(b[0]-a[0], b[1]-a[1]);
    if(L<1e-9) continue;
    const dx=(b[0]-a[0])/L, dz=(b[1]-a[1])/L;
    for(let t=carry; t<L; t+=gap){
      const f=t/L;
      out.push({x:a[0]+dx*t, z:a[1]+dz*t, y:ys?ys[i]+(ys[i+1]-ys[i])*f:0, dx, dz,
                slope:ys?(ys[i+1]-ys[i])/L:0});
    }
    carry=(carry-L)%gap; if(carry<0) carry+=gap;
  }
  return out;
}
/* Oriented boxes at those stations: `along` x `across` in plan, y0..y1 high. Top and the
   two long faces only -- the ends are a sleeper's 24 cm, invisible past a few metres, and
   dropping them is 40% of the vertices on the biggest mesh in the rail set. */
function boxesGeom(list, along, across, y0, y1){
  if(!list.length) return null;
  const P=new Float32Array(list.length*18*3); let o=0;
  const put=(x,y,z)=>{ P[o++]=x; P[o++]=y; P[o++]=z; };
  for(const s of list){
    const fx=s.dx*along/2, fz=s.dz*along/2, rx=-s.dz*across/2, rz=s.dx*across/2;
    const c=[[s.x-fx-rx, s.z-fz-rz],[s.x+fx-rx, s.z+fz-rz],[s.x+fx+rx, s.z+fz+rz],[s.x-fx+rx, s.z-fz+rz]];
    /* Tilted WITH the grade, as a real sleeper is: the rails climb, so what they sit on
       climbs. A level box on a 25% line has one edge in the air and the other in the
       ballast. c1,c2 are the forward pair (+along), c0,c3 the back. */
    const k=(s.slope||0)*along/2;
    const Tb=s.y+y1-k, Tf=s.y+y1+k, Bb=s.y+y0-k, Bf=s.y+y0+k;
    const T=[Tb,Tf,Tf,Tb], B=[Bb,Bf,Bf,Bb];
    // top
    put(c[0][0],T[0],c[0][1]); put(c[2][0],T[2],c[2][1]); put(c[1][0],T[1],c[1][1]);
    put(c[0][0],T[0],c[0][1]); put(c[3][0],T[3],c[3][1]); put(c[2][0],T[2],c[2][1]);
    /* the two long faces: c1->c2 and c3->c0 run ACROSS the track (the `across` span), so
       they face up and down the line. (c0->c1 and c2->c3 are the short ends, dropped.) */
    put(c[1][0],B[1],c[1][1]); put(c[1][0],T[1],c[1][1]); put(c[2][0],T[2],c[2][1]);
    put(c[1][0],B[1],c[1][1]); put(c[2][0],T[2],c[2][1]); put(c[2][0],B[2],c[2][1]);
    put(c[3][0],B[3],c[3][1]); put(c[3][0],T[3],c[3][1]); put(c[0][0],T[0],c[0][1]);
    put(c[3][0],B[3],c[3][1]); put(c[0][0],T[0],c[0][1]); put(c[0][0],B[0],c[0][1]);
  }
  const g=new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(P,3));
  g.computeVertexNormals();
  return g;
}
/* Everything drawn on top of the ballast, as {ties, rails, rack, teeth} geometries (any
   may be null). `lift` is the edge's class lift, `tieGap` the sleeper spacing world.js
   chose under its budget. Sleepers run ACROSS the track: along = sleeper width. */
function railTrackGeoms(pts, ys, lift, tieGap, rack){
  const base=lift+0.05;
  const tieTop=base+RAIL.tieH, railTop=tieTop+RAIL.railH;
  const ties=boxesGeom(stationsAlong(pts, ys, tieGap), RAIL.tieW, RAIL.tieLen, base, tieTop);
  const parts=[stripGeom(pts, ys, RAIL.gaugeHalf, RAIL.railW, tieTop, railTop),
               stripGeom(pts, ys, -RAIL.gaugeHalf, RAIL.railW, tieTop, railTop)].filter(Boolean);
  let rails=null;
  if(parts.length){
    const n=parts.reduce((m,g)=>m+g.attributes.position.array.length,0), P=new Float32Array(n); let o=0;
    for(const g of parts){ P.set(g.attributes.position.array,o); o+=g.attributes.position.array.length; }
    rails=new THREE.BufferGeometry(); rails.setAttribute('position', new THREE.BufferAttribute(P,3)); rails.computeVertexNormals();
  }
  let rackG=null, teeth=null;
  if(rack){
    rackG=stripGeom(pts, ys, 0, RAIL.rackW, tieTop, tieTop+RAIL.rackH);
    teeth=boxesGeom(stationsAlong(pts, ys, RAIL.toothGap), RAIL.toothW, RAIL.rackW*1.25,
                    tieTop+RAIL.rackH, tieTop+RAIL.rackH+0.05);
  }
  return {ties, rails, rack:rackG, teeth};
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
  // climbable rock: the ring lands on it the way it lands on the ground
  const mat=palette.map(c=>patchGroundRing(toon(c)));
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
/* Vertical skirt round each ring of an area, in the group's own space: top at `topY`,
   bottom a little below `groundLocal(x,z)` (terrain height relative to the group). Sampled
   at a metre so the bottom edge follows every terrace step; the bottom is taken as the
   LOWER of the ground at the outline and just outside it, since the outside is where the
   ground drops away. A wall that ends up inside a bank is simply hidden by it. */
const AREA_WALL_STEP = 1.0, AREA_WALL_SINK = 0.35;
function areaWallGeom(rings, topY, groundLocal){
  const P=[], I=[];
  for(const ring of rings){
    if(!ring || ring.length<3) continue;
    // signed area: which side of each edge is outside
    let A=0; for(let k=0;k<ring.length;k++){ const p=ring[k], q=ring[(k+1)%ring.length]; A+=p[0]*q[1]-q[0]*p[1]; }
    const out=A>0?-1:1;
    const pts=[];
    for(let k=0;k<ring.length;k++){
      const p=ring[k], q=ring[(k+1)%ring.length];
      const L=Math.hypot(q[0]-p[0], q[1]-p[1]);
      const n=Math.max(1, Math.ceil(L/AREA_WALL_STEP));
      const nx=L>1e-9?-(q[1]-p[1])/L*out:0, nz=L>1e-9?(q[0]-p[0])/L*out:0;
      for(let s=0;s<n;s++){ const t=s/n; pts.push([p[0]+(q[0]-p[0])*t, p[1]+(q[1]-p[1])*t, nx, nz]); }
    }
    if(pts.length<3) continue;
    const base=P.length/3;
    for(const [x,z,nx,nz] of pts){
      const g=Math.min(groundLocal(x,z), groundLocal(x+nx*0.6, z+nz*0.6));
      const bot=Math.min(topY-0.02, g-AREA_WALL_SINK);
      P.push(x,topY,z, x,bot,z);
    }
    const m=pts.length;
    for(let i=0;i<m;i++){
      const a=base+i*2, b=base+((i+1)%m)*2;
      I.push(a,a+1,b+1, a,b+1,b);
    }
  }
  if(!I.length) return null;
  const geo=new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(P),3));
  geo.setIndex(I);
  geo.computeVertexNormals();
  geo.__areaWall=true;
  return geo;
}

/* A polygon terrain.js left as COVER (too much hill under it to be a slab -- see
   flattenAreaCells). Nothing is drawn as a floor, extruded, or made solid: the ground IS
   the DEM hillside, and what makes it read as a forest or a scree field is what stands on
   it. Every piece is planted at its own terrain height, so the group itself stays at 0 --
   one rigid shift to a single height is precisely what cannot work across a mountain.

   Sampled uniformly over the polygon, capped. The cap is higher than a slab's because a
   cover polygon is by definition big; it is still a cap, not a density, since the tablet
   pays for every mesh and the largest of these spans most of a map. Trees keep off the
   trail corridor exactly as a slab's do. Water as cover gets nothing: a polygon with that
   much hill under it is not a surface water could have, whatever it is tagged. */
const COVER_MAX_PIECES = 160;
function buildCoverArea(a,st,rng,groundYAt,nearestTrail){
  const g=new THREE.Group();
  const bb=areaBBox(a);
  const rock=!!st.landform;
  const want=a.kind==='water' ? 0 : Math.min(COVER_MAX_PIECES, Math.round(bb.w*bb.h/(rock?90:70)));
  const rockMat=rock ? [toon(st.fill), toon(shade(st.fill,1.16)), toon(shade(st.fill,0.8))] : null;
  let placed=0,tries=0;
  while(placed<want&&tries++<want*12){
    const x=bb.mnx+rng()*bb.w,z=bb.mnz+rng()*bb.h;
    if(!pointInArea(x,z,a))continue;
    if(nearestTrail(x,z).d<4)continue;
    let o;
    if(a.kind==='forest') o=makeTree((1.2+rng()*1.5)*THEME.treeScale,pickTree(rng),rng);
    else if(rock){
      const r=0.4+rng()*1.1;
      o=M(new THREE.DodecahedronGeometry(r,0), rockMat[(rng()*rockMat.length)|0]);
      o.scale.set(1, 0.55+rng()*0.4, 1); o.rotation.y=rng()*6.28;
      o.position.y=r*0.25;
    }else{
      o=M(new THREE.ConeGeometry(0.17,0.55,5),toon(THEME.tuft)); o.position.y=0.25;
    }
    const holder=new THREE.Group();
    holder.position.set(x, groundYAt(x,z), z);
    holder.add(o); g.add(holder); placed++;
  }
  if(a.name){
    const label=buildFloatingLabel(a.name,st.em,Math.max(7,a.name.length*0.7),3.5);
    label.position.x=bb.cx; label.position.z=bb.cz;
    label.position.y+=groundYAt(bb.cx,bb.cz);
    g.add(label);
  }
  g.position.y=0;
  g.userData.cover=true;
  return g;
}

function buildArea(a,rng,groundYAt,nearestTrail,vertScale){
  const st=AREA_STYLE[a.kind]||AREA_STYLE.meadow;
  if(a.cover) return buildCoverArea(a,st,rng,groundYAt,nearestTrail);
  const g=new THREE.Group();
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
  }else if(a.kind==='building'||a.kind==='depot'||a.kind==='platform'){
    const hgt=st.slab ? st.slab : clamp(+(a.props.height||a.props.levels*3||a.props['building:levels']*3||0)||3.4,1.5,14);
    solidTop=hgt;
    const geo=new THREE.ExtrudeGeometry(shape,{depth:hgt,bevelEnabled:false});
    const m=M(geo,toon(st.fill));
    // see buildLandform: rotation alone maps the extrude's base to y=0, no offset needed
    m.rotation.x=-Math.PI/2;g.add(m);
    const capGeo=new THREE.ShapeGeometry(shape);
    const cap=M(capGeo,toon(st.cap||st.roof||'#8c4a33'));
    cap.rotation.x=-Math.PI/2;cap.position.y=hgt+0.03;g.add(cap);
    if(st.edge){
      // the safety line round the rim, as painted on a real platform. Outer ring only; the
      // group sits at x=z=0 (only y is shifted below), so the ring is used as it stands
      const ring=a.rings[0], closed=ring.length>1 && ring[0][0]===ring[ring.length-1][0] && ring[0][1]===ring[ring.length-1][1];
      const pts=closed ? ring.slice(0,-1) : ring.slice();
      if(pts.length>=3) g.add(M(ribbonGeom([...pts, pts[0]], 0.22, hgt+0.05, null), toon(st.edge)));
    }
    labelY=hgt+2.4;
  }else{
    const geo=new THREE.ShapeGeometry(shape);
    const mat=new THREE.MeshToonMaterial({color:new THREE.Color(st.paved?'#ffffff':st.fill),
      map:st.paved?pavementTexture():null,gradientMap:toonTex,
      transparent:st.op<1,opacity:st.op,side:THREE.DoubleSide,
      polygonOffset:true,polygonOffsetFactor:-1,polygonOffsetUnits:-1});
    if(a.kind!=='water') patchGroundRing(mat);   // the ring lies on a lot or a meadow like any ground
    if(st.paved)mat.map.repeat.set(Math.max(1,bb.w/9),Math.max(1,bb.h/9));
    const m=M(geo,mat);
    m.rotation.x=-Math.PI/2;m.position.y=a.kind==='water'?0.09:0.03;
    g.add(m);
    /* A PAVED lot is a built thing, so it gets sides. The slab is flat at the area's graded
       height, but the ground round it is not: a road bench cut through the entrance, or a
       slope falling away along one edge, left the edge of the lot hanging in mid-air with
       daylight under it. A kerb wall round every ring, from the surface down to just
       below the ground at each point, makes it read as one solid pad on the hillside. */
    if(st.paved){
      // the walkable top is the slab itself (world.js's LOT_SURFACE_LIFT matches this)
      solidTop=0.03;
      const baseY=(a.groundY!=null)?a.groundY*vertScale:groundYAt(bb.cx,bb.cz);
      const wall=areaWallGeom(a.rings, 0.03, (x,z)=>groundYAt(x,z)-baseY);
      // its own material: double-sided (ring winding varies by source file), and toon()'s
      // cached materials are shared, so they must not be mutated
      if(wall) g.add(M(wall, patchGroundRing(new THREE.MeshToonMaterial({color:new THREE.Color(shade(st.fill,0.72)),
                                                         gradientMap:toonTex, side:THREE.DoubleSide}))));
    }
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
/* An area's name board, at the edge of the area nearest a path so you pass it on the way
   in. It used to step 1.1 m OUTWARD from the area's centre past that nearest outline
   vertex -- and for a lot beside a road the nearest vertex is the entrance, on the road
   edge, so outward was straight into the carriageway ("overlook parking" planted on the
   centre line of Ridge Road). It now steps INWARD, onto the area's own ground, and then
   `clear` (world.js pushOffPaths) moves it off any painted path it still touches. It
   still faces outward, toward the path it is read from. */
function buildAreaSign(a,groundYAt,nearestTrail,clear){
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
  let signX=anchor[0]-dx*1.4,signZ=anchor[1]-dz*1.4;
  if(clear){ const c=clear(signX,signZ); signX=c[0]; signZ=c[1]; }
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

/* THE RIDGELINE. It used to be 64 random heights with every other one knocked down to
   72% -- a perfectly regular sawtooth, identical tooth width all the way round, which is
   what made the skyline read as a paper cut-out rather than as distant country. A real
   ridge is self-similar: a few big summits, shoulders on those, and small notches on the
   shoulders. So: periodic value noise (it has to close seamlessly round the ring) summed
   over octaves, sharpened with a power so summits are peaks and valleys are broad, at
   enough segments that the small octave is visible as texture, not as teeth.

   Mesas keep their flat-topped runs -- that IS the silhouette of mesa country -- but the
   run heights now come from the same noise, so neighbouring tables relate instead of
   jumping at random, and each run is stepped down at its ends as a talus shoulder. */
const RIDGE_SEGS = 192;
function ridgeProfile(segs, peakH, mesas, rng){
  // periodic 1-D value noise: `cells` random values round the ring, smoothstep between
  const octave = cells => {
    const v = Array.from({length: cells}, () => rng());
    return i => {
      const t = i/segs*cells, k = Math.floor(t), f = t - k, u = f*f*(3 - 2*f);
      return v[k % cells] + (v[(k + 1) % cells] - v[k % cells])*u;
    };
  };
  const o1 = octave(7), o2 = octave(19), o3 = octave(53);
  const raw = i => Math.pow(0.58*o1(i) + 0.30*o2(i) + 0.12*o3(i), 1.6);
  const h = new Array(segs + 1);
  if(mesas){
    let i = 0;
    while(i < segs){
      const run = 6 + Math.floor(rng()*10);
      const top = peakH*(0.35 + 0.65*raw(i + run/2));
      for(let k = 0; k < run && i < segs; k++, i++){
        const edge = Math.min(k, run - 1 - k);
        h[i] = edge === 0 ? top*0.78 : top;           // a shoulder step either side
      }
    }
  }else{
    for(let i = 0; i < segs; i++) h[i] = peakH*(0.22 + 0.78*raw(i));
  }
  h[segs] = h[0];                                     // close the ring seamlessly
  return h;
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
    const segs = RIDGE_SEGS;
    const h = ridgeProfile(segs, peakH, mesas, rng);
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
    m.userData.band = b; m.userData.bands = bands;   // sky.js scales its haze by depth
    g.add(m);
  }
  return g;
}


export { ribbonGeom, junctionGapGeom, waterSideGeom, densifyEdge, embankmentGeom, trailMat, INK, buildSign, buildBlaze, buildCrossing, buildGate, makeTree, makeRock,
         POI_STYLE, AREA_STYLE, PYLON, pylonWirePoints, railTrackGeoms, nameplate, buildPOI, pavementTexture, buildLandform,
         buildFloatingLabel, buildArea, buildAreaSign, makeShadow, pickTree, shade,
         buildBackdrop, backdropRadius, ridgeProfile, bridgeDeckGeom, bridgeFrameGeom, deckMat, frameMat };
