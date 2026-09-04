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
/* Float32Array, one terrace band per DEM cell. FLOAT, not Int, and that is the whole
   mechanism behind the graded trail corridor below. Away from paths every cell holds a
   whole band index and the ground is the terraced landscape it always was; under a trail
   the cells hold FRACTIONAL bands, so the same buildTerrainMesh() draws a fine, smoothly
   climbing bench along the corridor instead — and the cut bank and fill embankment on
   either side come out of it for free, because those are nothing but the risers between a
   fractional cell and a whole-numbered one. */
let BAND = null;
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
  BAND = Float32Array.from(WORLD.terraceGrid(STEP));
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

/* How much of a polygon's own footprint has to be claimed already before it adopts a
   neighbour's level instead of grading itself.

   THIS USED TO BE ONE CELL. The claim map exists because ~20 parking-lot polygons on the
   default map genuinely overlap, and re-levelling the second one leaves the first slab
   hovering. But the test was `for(const k of mark){ if(claimed.has(k)){ lvl=...; break; } }`
   -- a single shared cell, picked in Set iteration order, handed the whole polygon a
   level graded for something else. Areas mark their bbox expanded by one cell plus every
   cell their boundary crosses, so merely TOUCHING was enough.

   Measured on data/rrworld.json, that is exactly what happened to both ponds: each one
   shares an edge cell with a rock-formation polygon and inherited its band, landing 34 m
   and 42 m above its own terrain. A pond sitting on top of a rock formation is precisely
   the reported symptom, and it was never about water rendering -- it was the grading pass
   next door. Requiring a real majority keeps the parking-lot case (those polygons overlap
   substantially) and drops the touching case. */
const CLAIM_SHARE = 0.5;

/* Water does not sit on a plateau. Every other area kind is a slab someone levelled --
   a lot, a footprint, a bench -- so the median band under it is the right answer. A pond
   is the opposite: it is the LOW ground, and levelling it to its own median puts half the
   surface above the shore it drains from. Grading to a low percentile instead makes the
   footprint a shallow basin, which is both what water is and what "flush with the ground"
   means. Not the minimum: one noisy DEM cell in a 40 m polygon should not sink the whole
   pond a terrace. */
const WATER_PCTILE = 0.25;
function isWaterArea(a){ return a && a.kind === 'water'; }

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
    /* Adopt a neighbour's level only when this polygon is MOSTLY sitting on one, and take
       the level the most shared cells actually hold rather than whichever the Set happened
       to yield first -- an overlap can straddle two graded slabs, and picking arbitrarily
       between them is the same coin flip in a smaller place. Water never inherits at all:
       a pond that shares a boundary cell with a rock mass is not on the rock mass. */
    if(!isWaterArea(a)){
      const votes=new Map();
      let shared=0;
      for(const k of mark){
        if(!claimed.has(k)) continue;
        shared++;
        const v=claimed.get(k);
        votes.set(v,(votes.get(v)||0)+1);
      }
      if(shared/mark.size >= CLAIM_SHARE){
        let bestN=-1;
        for(const [v,n] of votes) if(n>bestN){ bestN=n; lvl=v; }
      }
    }
    if(lvl===null){
      const vals=[...mark].map(k=>BAND[k]).sort((p,q)=>p-q);
      const pct=isWaterArea(a) ? WATER_PCTILE : 0.5;
      lvl=vals[clamp(Math.floor(vals.length*pct),0,vals.length-1)];
    }
    a.groundY=(lvl*STEP-GROUND_M);   // metres, caller applies vertScale
    for(const k of mark){ BAND[k]=lvl; claimed.set(k,lvl); }
  }
}

/* Terrace band at a point — whole away from trails, fractional inside a graded corridor.
   `heightM` is the same value in metres above the datum, which is the unit the grading
   maths works in; `bandOfM` converts back. */
function bandAt(x,z){
  if(!WORLD||!BAND)return 0;
  return BAND[clamp(WORLD.cellJ(z),0,WORLD.height-1)*WORLD.width+clamp(WORLD.cellI(x),0,WORLD.width-1)];
}
function bandY(band,vertScale){ return (band*STEP-GROUND_M)*vertScale; }
function heightM(x,z){ return bandAt(x,z)*STEP-GROUND_M; }
function bandOfM(h){ return (h+GROUND_M)/STEP; }

/* ---------- graded trail corridor ----------

   THE PROBLEM THIS REPLACES. Terracing quantises elevation to whole contour bands, which
   turns every gentle grade into flat-then-cliff. On this map that is a 5.4-unit riser
   every 37 m of path -- about seven times the pup's shoulder height. Earlier versions
   argued over whether the ribbon should step with the terrain (it then hung in the air
   over the low half of each crossing) or the avatar should be lifted to meet the ribbon
   (it then floated whenever terrain merely rose nearby). Both were answers to the wrong
   question: a trail crossing a 5.4-unit cliff has no good rendering.

   What a real trail does is cut a bench -- it holds a steady grade, and the hillside is
   cut away above it and filled below. That is what these two functions do:

     gradeProfile()     smooths the DEM along the centreline into a continuous height, so
                        the path climbs at the grade the land actually has rather than in
                        whole-contour jumps.
     gradeTrailCells()  writes that height back into the band grid as a FRACTIONAL band,
                        so the ground under the corridor becomes the graded bench while
                        the terraced country either side stays terraced.

   The cut bank and the fill embankment are then just ordinary terrace risers between a
   fractional corridor cell and its whole-numbered neighbour, which means buildTerrainMesh
   already draws them. No skirt geometry, no holes to stitch, no second mesh. */

/* Ease corners a ribbon of half-width `hw` could not physically turn.

   A ribbon is drawn by offsetting the centreline sideways by its half-width. Where the
   centreline turns tighter than that half-width, the INNER offset crosses itself and the
   quad folds inside out -- on screen a chain of chevrons and scallops instead of a path.
   Digitised trail data is full of such corners (a switchback apex is a single vertex),
   and they only become a problem once the ribbon is wide relative to the turn, which on a
   compacted map it always is.

   Rather than clamp the width or special-case the geometry, relax the offending corners:
   each pass pulls a too-tight vertex toward the midpoint of its neighbours, in proportion
   to how far past the limit it is, leaving everything else untouched. Endpoints never
   move -- they are what makes edges meeting at a junction agree. */
/* Walk a polyline emitting a point every `step` of arc length. Unlike resample(), which
   keeps the input's own vertices and only subdivides long gaps, this also DISCARDS
   vertices that are closer together than `step` -- which is the half that matters here.
   A digitised trail has vertices a few metres apart in real terms; compact the map to
   1:16 and they are 25 cm apart while the ribbon is still 1.65 m wide, and no amount of
   subdividing fixes a spacing floor. Endpoints are always kept, since junction agreement
   depends on them. */
function resampleUniform(pts, step){
  if(pts.length < 2 || !(step > 0)) return pts.map(p => [p[0], p[1]]);
  const out = [[pts[0][0], pts[0][1]]];
  let carry = 0;
  for(let i = 1; i < pts.length; i++){
    const a = pts[i-1], b = pts[i];
    const dx = b[0]-a[0], dz = b[1]-a[1], L = Math.hypot(dx, dz);
    if(L < 1e-9) continue;
    let d = step - carry;
    while(d <= L){
      out.push([a[0] + dx*(d/L), a[1] + dz*(d/L)]);
      d += step;
    }
    carry = L - (d - step);
  }
  const last = pts[pts.length-1], tail = out[out.length-1];
  // replace rather than append a final point that would sit right on top of the previous
  if(Math.hypot(last[0]-tail[0], last[1]-tail[1]) < step*0.5 && out.length > 1) out.pop();
  out.push([last[0], last[1]]);
  return out;
}

function roundCorners(pts, hw){
  if(!(hw > 0) || pts.length < 3) return pts;
  let cur = pts.map(p => [p[0], p[1]]);
  for(let pass = 0; pass < 8; pass++){
    const next = cur.map(p => [p[0], p[1]]);
    let moved = false;
    for(let i = 1; i < cur.length-1; i++){
      const a = cur[i-1], b = cur[i], c = cur[i+1];
      const a1 = Math.atan2(b[1]-a[1], b[0]-a[0]), a2 = Math.atan2(c[1]-b[1], c[0]-b[0]);
      let d = a2-a1; while(d > Math.PI) d -= 2*Math.PI; while(d < -Math.PI) d += 2*Math.PI;
      if(Math.abs(d) < 1e-6) continue;
      const seg = (Math.hypot(b[0]-a[0], b[1]-a[1]) + Math.hypot(c[0]-b[0], c[1]-b[1]))/2;
      const R = seg/Math.abs(d);                 // local turn radius
      if(R >= hw) continue;
      const k = Math.min(0.5, (1 - R/hw)*0.5);   // how hard to pull it in
      next[i][0] = b[0] + ((a[0]+c[0])/2 - b[0])*k;
      next[i][1] = b[1] + ((a[1]+c[1])/2 - b[1])*k;
      moved = true;
    }
    cur = next;
    if(!moved) break;
  }
  return cur;
}

/* Smooth the DEM along a centreline into a continuous, walkable profile.

   Both ends are pinned to the raw terrain height, with the smoothing tapered in over the
   window length. That is not cosmetic -- it is what makes junctions work. Two edges
   meeting at a node read the same raw band there, so with the ends pinned they arrive at
   the SAME height and their ribbons meet flush. Smooth straight through the ends instead
   and each edge lands on its own idea of where the junction is, off by up to a full band.

   The window is expressed in DEM cells rather than world units so it means the same thing
   at any map scale -- the same reason resample's step and the graph tolerances are. */
const MAX_STATIONS = 3000, MAX_BENCH_CELLS = 7;
function gradeProfile(pts, vertScale, stepCells = 0.7, windowCells = 8, minStepM = 0, endA = null, endB = null){
  /* Station spacing follows the DEM cell, but with a floor derived from the line's own
     length. World scale runs to 1:1000, where a 3 m cell becomes 3 mm -- sampling at
     0.7 of that would put a third of a million stations on a single trail and hang the
     rebuild. The floor caps it at MAX_STATIONS with no effect at any sane scale. */
  let lineLen = 0;
  for(let i = 1; i < pts.length; i++) lineLen += Math.hypot(pts[i][0]-pts[i-1][0], pts[i][1]-pts[i-1][1]);
  const stepM = Math.max(WORLD ? WORLD.cell*stepCells : 3, lineLen/MAX_STATIONS, minStepM);
  /* Resample, relax the corners, resample again. The second pass matters: roundCorners
     pulls tight vertices toward their neighbours' midpoint, which shortens the line
     locally and undoes some of the even spacing the first pass established -- and even
     spacing is precisely what keeps the join discs from piling up. The rounding target is
     1.3x the half-width rather than exactly it, so corners land clear of the fold
     threshold instead of right on it. */
  const rp = resampleUniform(
    roundCorners(resampleUniform(pts, stepM), (minStepM/0.6/2)*1.3), stepM);
  const n = rp.length;
  if(!WORLD || !BAND || n < 2) return {pts: rp, ys: new Array(n).fill(0), hm: new Array(n).fill(0)};

  const arc = new Float64Array(n);
  for(let i = 1; i < n; i++) arc[i] = arc[i-1] + Math.hypot(rp[i][0]-rp[i-1][0], rp[i][1]-rp[i-1][1]);
  const raw = new Float64Array(n);
  for(let i = 0; i < n; i++) raw[i] = heightM(rp[i][0], rp[i][1]);

  /* Two box passes over a sliding arc-length window approximate a Gaussian at a fraction
     of the cost, and the running sum keeps each pass linear in the station count.

     The window is at least six stations wide. Sizing it from the DEM cell alone was a
     silent failure at compacted world scale: the cell shrinks with the map but station
     spacing now has a floor in true metres (it has to clear the ribbon's own width), so
     past about 1:20 the window was NARROWER than one station. A box filter over a single
     sample is the identity -- the profile came back as raw quantised terrain, and every
     terrace cliff the grading exists to remove was still there, with nothing in the code
     looking obviously wrong. */
  const win = Math.max(WORLD.cell*windowCells, stepM*6);
  let cur = raw;
  for(let pass = 0; pass < 2; pass++){
    const out = new Float64Array(n);
    let lo = 0, hi = 0, sum = 0, cnt = 0;
    for(let i = 0; i < n; i++){
      while(hi < n && arc[hi] <= arc[i] + win){ sum += cur[hi]; cnt++; hi++; }
      while(arc[lo] < arc[i] - win){ sum -= cur[lo]; cnt--; lo++; }
      out[i] = cnt ? sum/cnt : cur[i];
    }
    cur = out;
  }

  /* Pin the ends by adding a DECAYING OFFSET, not by blending toward a target height.

     Blending toward the target was the obvious way and it was wrong: it drags the last
     window's worth of every edge onto a value the smoothing exists to replace, which put
     a full terrace cliff right where trails converge. Offsetting keeps the smooth shape
     everywhere and just slides its ends, spreading the correction over the window.

     WHAT to pin to matters as much. Pinning to RAW terrain height (what this did first)
     makes the offset as large as the difference between a smoothed profile and the
     quantised ground under its endpoint -- which on steep or compacted ground is several
     terraces. Spread over a short edge that is a cliff again, just relocated: a two-metre
     connector has room for two stations, so the whole offset lands between them. Callers
     therefore pass endA/endB: a height agreed between all edges meeting at that node, so
     the offset is the small disagreement between neighbours rather than the large gap to
     raw ground. endA/endB null falls back to raw, which is right for a genuine dead-end
     with nothing to agree with.

     The window still stretches to swallow a big offset if one turns up (SAFE_GRADE), so a
     pathological input degrades to a ramp rather than a step. */
  let total = arc[n-1] || 1;
  const tA = endA == null ? raw[0] : endA, tB = endB == null ? raw[n-1] : endB;
  const offA = tA - cur[0], offB = tB - cur[n-1];
  const SAFE_GRADE = 0.35;
  const need = Math.max(Math.abs(offA), Math.abs(offB))/SAFE_GRADE;
  const w2 = Math.min(Math.max(win, need), total/2) || total/2 || 1;
  const hm = new Array(n), ys = new Array(n);
  for(let i = 0; i < n; i++){
    const a = 1 - clamp(arc[i]/w2, 0, 1), b = 1 - clamp((total - arc[i])/w2, 0, 1);
    hm[i] = cur[i] + offA*a + offB*b;
    ys[i] = hm[i]*vertScale;
  }
  // smoothed (unpinned) end heights, so the caller can build the node consensus above
  return {pts: rp, ys, hm, smA: cur[0], smB: cur[n-1]};
}

/* Write the graded profiles into the band grid, so the ground under each corridor IS the
   bench its ribbon sits on. Runs in the same slot flattenAreaCells does and for the same
   reason: buildTerrainMesh bakes the grid into geometry the moment it is called.

   Every profile is resolved in ONE pass over a shared claim map keyed by cell, keeping
   whichever station sits closest to that cell's centre. Per-profile last-write-wins would
   hand a cell to whichever trail happened to be processed last rather than to the trail
   actually running through it — which goes wrong exactly where it is most visible, at
   junctions and wherever two trails run close together. */
function gradeTrailCells(profiles){
  if(!WORLD || !BAND) return;
  const claim = new Map();
  for(const {pts, hm, halfWidth} of profiles){
    /* Reach a cell centre either side, so the bench is wider than the tread it carries --
       but never more than MAX_BENCH_CELLS of them. Tread widths are true metres and do
       NOT shrink with world scale (that is the point of the control), so at heavy
       compaction the ratio of trail width to cell size explodes: at 1:1000 an unclamped
       radius covers about 240,000 cells per station. The clamp costs nothing at any scale
       where the trail is narrower than the map, and past that the map is a blob anyway. */
    const r = Math.min(halfWidth + WORLD.cell*0.5, WORLD.cell*MAX_BENCH_CELLS);
    for(let i = 0; i < pts.length; i++){
      const p = pts[i];
      const i0 = clamp(WORLD.cellI(p[0]-r),0,WORLD.width-1), i1 = clamp(WORLD.cellI(p[0]+r),0,WORLD.width-1),
            j0 = clamp(WORLD.cellJ(p[1]-r),0,WORLD.height-1), j1 = clamp(WORLD.cellJ(p[1]+r),0,WORLD.height-1);
      for(let j = j0; j <= j1; j++) for(let k = i0; k <= i1; k++){
        const c = WORLD.cellCentre(k, j);
        const d = Math.hypot(c.x-p[0], c.z-p[1]);
        if(d > r) continue;
        const key = j*WORLD.width + k, prev = claim.get(key);
        if(!prev || d < prev.d) claim.set(key, {d, h: hm[i]});
      }
    }
  }
  for(const [key, v] of claim) BAND[key] = bandOfM(v.h);
}

/* Smoothed height for camera framing ONLY -- never for placing anything on the ground.
   The terrace mesh is deliberately low-poly (a stylistic choice), which means the true
   ground height jumps a whole step the instant you cross a cell boundary. Feeding that
   straight into the camera's target height reads as jittery/jumpy vertical motion, even
   though the same steps look intentional and fine as geometry. Averaging several nearby
   bands, weighted by distance, gives a height that drifts as you walk instead of
   snapping -- each cell entering or leaving the sample radius nudges the average rather
   than replacing it outright. Radius is expressed in cells, not metres, so it keeps the
   same amount of smoothing at any --map-scale. */
function cameraGroundY(x,z,vertScale){
  if(!WORLD||!BAND)return 0;
  const radius=WORLD.cell*1.8;
  const i0=clamp(WORLD.cellI(x-radius),0,WORLD.width-1), i1=clamp(WORLD.cellI(x+radius),0,WORLD.width-1),
        j0=clamp(WORLD.cellJ(z-radius),0,WORLD.height-1), j1=clamp(WORLD.cellJ(z+radius),0,WORLD.height-1);
  let sum=0,wsum=0;
  for(let j=j0;j<=j1;j++)for(let k=i0;k<=i1;k++){
    const c=WORLD.cellCentre(k,j);
    const d=Math.hypot(c.x-x,c.z-z); if(d>radius)continue;
    const wgt=1-d/radius;
    sum+=BAND[j*WORLD.width+k]*wgt; wsum+=wgt;
  }
  const band = wsum>0 ? sum/wsum : BAND[WORLD.cellJ(z)*WORLD.width+WORLD.cellI(x)];
  return (band*STEP-GROUND_M)*vertScale;
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
/* Metres per texture repeat. Chosen deliberately NOT equal to the DEM cell size (8 m by
   default) -- matching it would line the grass pattern up with the terrace grid and look
   artificially regular. Fixed in world units (not derived from the map's own extent, see
   below), so it stays the same apparent size next to the avatar at any --map-scale. */
const GROUND_TILE_M = 9;

function buildTerrainMesh(vertScale){
  const W=WORLD;
  const P=[],N=[],UV=[],idx=[];
  /* UV from absolute world x/z, not normalised to the map's bounding box. The previous
     formula -- (x-originX)/(full map width) -- gave every vertex a UV in [0,1] across
     the WHOLE terrain in one pass, so one 256x256 canvas got stretched over the entire
     map: every fold of the low-poly terrace mesh showed through the pattern like a rug
     draped over furniture, and a bigger map just stretched it further. Dividing by a
     fixed tile size instead repeats the real texture at a constant real-world scale --
     it sits on the ground rather than wrapping around whatever shape is underneath, and
     is already seamless across risers and terrace steps since RepeatWrapping is set on
     the texture (groundTexture, below) and x/z vary continuously across them. */
  const put=(x,y,z,nx,ny,nz)=>{
    P.push(x,y,z);N.push(nx,ny,nz);
    UV.push(x/GROUND_TILE_M,z/GROUND_TILE_M);
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

/* One-off top-down relief image of the band grid, for the minimap to use as its base
   layer. Drawn once per world rebuild (minimap.js caches it against world.js's revision
   counter) rather than per frame, because it is a full pass over the DEM.

   Two channels of information, both derived from the SAME band array the terrain mesh is
   built from, so the map can never disagree with the ground you're standing on: a
   hypsometric tint (low = the theme's own grass, high = its rock) and a west-lit
   hillshade from the band difference with the neighbour uphill. Contour lines fall out
   for free -- a band change IS a contour crossing -- so they're stroked at every band
   edge instead of being computed separately. */
function reliefCanvas(theme){
  if(!WORLD || !BAND) return null;
  const W = WORLD.width, H = WORLD.height;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  // headless runs (tools/smoke.js's canvas stub, jsdom without the canvas package) give
  // back either nothing or a partial context -- bail rather than half-draw
  if(!g || typeof g.createImageData !== 'function') return null;
  const img = g.createImageData(W, H);
  if(!img || !img.data) return null;
  let lo = Infinity, hi = -Infinity;
  for(let i = 0; i < BAND.length; i++){ if(BAND[i] < lo) lo = BAND[i]; if(BAND[i] > hi) hi = BAND[i]; }
  const span = Math.max(1, hi - lo);
  const low = new THREE.Color(theme.grass ? theme.grass[0] : '#5c7f42');
  const high = new THREE.Color(theme.rocks ? theme.rocks[0] : '#a8836a');
  for(let j = 0; j < H; j++) for(let i = 0; i < W; i++){
    const b = BAND[j*W+i];
    const t = (b - lo)/span;
    // hillshade: compare with the neighbour to the north-west, the light direction the
    // scene's own sun already comes from
    const bn = BAND[Math.max(0, j-1)*W + Math.max(0, i-1)];
    const shade = clamp(1 + (b - bn)*0.16, 0.72, 1.3);
    // rounded: without it the fractional bands along a graded corridor would ink a
    // contour line at every single cell down the length of every trail
    const rb = Math.round(b);
    const edge = (rb !== Math.round(BAND[j*W + Math.min(W-1, i+1)]) ||
                  rb !== Math.round(BAND[Math.min(H-1, j+1)*W + i])) ? 0.78 : 1;
    const o = (j*W+i)*4;
    img.data[o]   = clamp((low.r + (high.r-low.r)*t) * 255 * shade * edge, 0, 255);
    img.data[o+1] = clamp((low.g + (high.g-low.g)*t) * 255 * shade * edge, 0, 255);
    img.data[o+2] = clamp((low.b + (high.b-low.b)*t) * 255 * shade * edge, 0, 255);
    img.data[o+3] = 255;
  }
  g.putImageData(img, 0, 0);
  // world-space rect the image covers, so the minimap never has to know the grid layout
  return {canvas: c, x0: WORLD.originX, z0: WORLD.originZ, w: W*WORLD.cell, h: H*WORLD.cell};
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

export { setWorld, setStep, getWorld, getStep, terrainY, cameraGroundY, rawGroundY, flattenAreaCells,
         bandAt, bandY, heightM, bandOfM, gradeProfile, gradeTrailCells, reliefCanvas,
         resample, buildTerrainMesh, groundTexture, GROUND_TILE_M };
