/* Scene state + rebuildWorld(). Owns GRAPH, POIS, AREAS, TRAILHEADS, bboxW -- read
   elsewhere as live bindings, mutated only through the functions here, same rule as
   city/world.js's COLLIDERS/PLATFORMS/etc.

   IMPORTANT SCALE CHANGE from the standalone build: that version applied an artificial
   "World scale" slider (default 0.45) shrinking real metres down to a smaller, more
   game-convenient number, decoupled from elevation. A real DEM can't be shrunk after the
   fact without resampling the heightfield to match -- fetch_dem.py's --cell argument
   fixes the heightfield's metre-to-cell ratio at bundle-build time, and world.project()
   returns real metres. So this version plays at TRUE scale: a "953 m" trail sign means
   953 real metres to walk. That also means dog/stats.js's STATS.walk (already tuned in
   real m/s for Pup City) is correct here too, unlike the old build where speed had to be
   separately re-tuned against an arbitrary shrink factor. Only vertical exaggeration
   remains adjustable, since stretching Y alone can't misalign vectors from terrain. */
import { clamp } from '../core/math.js';
import { buildTerrainMesh, flattenAreaCells, gradeProfile, gradeTrailCells, GROUND_TILE_M, groundTexture, reliefCanvas, resample, setStep, setWorld, terrainY } from './terrain.js';

import { scene, disposeGroup, sun, hemi } from '../core/render.js';
import { toon, toonTex } from '../core/materials.js';
import { loadWorldBundle, fetchWorldBundle } from '../data/world_bundle.js';
import { parseFeatures, buildGraph, ptSeg } from './geo.js';
import { pointInArea, areaBBox } from './geom2d.js';
import { resetSpatialHash, hashSeg, nearestTrail } from './spatial.js';
import { THEME, THEMES, setTheme } from './themes.js';
import { ribbonGeom, trailMat, INK, buildSign, buildBlaze, buildCrossing, buildGate, makeTree, makeRock,
         pickTree, buildPOI, buildArea, buildAreaSign, POI_STYLE, shade,
         buildBackdrop } from './pieces.js';

let GRAPH=null, TRAILHEADS=[], POIS=[], AREAS=[], WATER=[];
/* Every floating area name currently in the scene. Collected at build time so the
   per-frame size cap does not have to walk the whole graph looking for sprites.
   Cleared IN PLACE on rebuild -- see the module header on shared mutable arrays. */
const AREA_LABELS=[];
let backdropG=null;             // horizon ring, re-centred on the camera by main.js
let bboxW={minx:0,maxx:0,minz:0,maxz:0};
let EXTRA=[];                   // raw GeoJSON FeatureCollections dropped in-session
let STEP_M=3;                   // contour step in metres, remembered across rebuilds
let SIGN_COUNT={wanted:0,built:0,minGap:0};   // last rebuild's signpost thinning tally
/* Last rebuild's road/trail interaction tally: how many nodes are genuine forks, how many
   are a path merely crossing a different class of path, and how many paths were found
   sharing another's ground. Surfaced in the panel and asserted in tools/smoke.js, so a
   regression in the crossing rules shows up as a number rather than as a screenshot. */
let PATH_MIX={forks:0, crossings:0, buried:0};

/* Local equirectangular projection used ONLY when no DEM bundle is loaded, so a plain
   pair of .geojson files (trails + areas) is playable on flat ground. It deliberately
   mirrors World.project/projectCoords's contract -- same {x,z} / [x,z] shapes, same
   +z = south convention -- so nothing downstream needs to know which one it got. Once a
   real bundle is loaded the bundle's own projection wins, because only that one is
   guaranteed to line up with the heightfield. */
function fallbackProjector(layers){
  let lo=1e9,hi=-1e9,la=1e9,ha=-1e9;
  const see=c=>{lo=Math.min(lo,c[0]);hi=Math.max(hi,c[0]);la=Math.min(la,c[1]);ha=Math.max(ha,c[1]);};
  const walk=c=>{ if(typeof c[0]==='number') see(c); else c.forEach(walk); };
  for(const L of layers) for(const f of (L.features||[])) if(f&&f.geometry&&f.geometry.coordinates) walk(f.geometry.coordinates);
  if(lo>hi) return null;
  const lat0=(la+ha)/2;
  // same horizontal scale the DEM path applies via World.setMapScale()
  const mLon=111320*Math.cos(lat0*Math.PI/180)*MAP_SCALE, mLat=110540*MAP_SCALE;
  const originLon=lo, originLat=ha;   // x >= 0 eastward, z >= 0 southward
  const proj={
    isFallback:true,
    project(lon,lat){ return {x:(lon-originLon)*mLon, z:(originLat-lat)*mLat}; },
    projectCoords(coords){
      if(typeof coords[0]==='number'){ const p=proj.project(coords[0],coords[1]); return [p.x,p.z]; }
      return coords.map(c=>proj.projectCoords(c));
    },
  };
  return proj;
}
let worldG=null;               // THREE.Group holding everything rebuildWorld() creates
let BUNDLE=null;                // the loaded World instance
let startHead=0;
/* A stable identity for "which map is this", so anything persisted between sessions --
   saved spots, today -- can be filed against the right one. Derived from the bundle's
   own projection origin rather than from the bounding box, because the box is expressed
   in world units and therefore moves every time the world-scale slider does, which would
   silently orphan a walker's pins the first time they compacted the map. Layers dropped
   without a bundle have no such anchor, so they share one key; that is a real limitation
   and an honest one. */
let MAP_ID='none';
function getMapId(){ return MAP_ID; }

/* Two independent knobs, one derived value.

   EXAG is the hill-exaggeration slider the file header describes: pure taste, safe to
   change because stretching Y alone cannot misalign vectors from terrain.

   MAP_SCALE shrinks or stretches the map horizontally. The header's warning still
   stands -- you cannot rescale vectors without resampling the heightfield to match --
   so this is NOT applied here: it is handed to World.setMapScale(), which re-derives
   the projection AND the DEM cell grid from the same constants, keeping them aligned
   by construction. A bundle at scale 0.5 is a genuinely half-size map, not a stretched
   one, and vectors still land on the right cells.

   VERT_SCALE is what every draw call in this file uses, and folds both together: a map
   shrunk to half width keeps its real-world slopes only if its hills halve too.
   Exposed unchanged as getVertScale() so terrain.js and main.js need no edits. */
/* Startup defaults -- product-chosen, not just "neutral": 1:5 shortens the walk to
   something you can preview in a few seconds, 0.25x exaggeration keeps the compacted
   terrain from reading as a wall (see the trade-off note above), and 3x fog hides the
   flat draw-distance edge on the default map without anyone touching a slider. Contour
   step's own default (STEP_M above) already matched what we want, so it's untouched. */
let EXAG=0.25;  // slider is 0..2 now; 1.8 was tuned back when MAP_SCALE divided it
let MAP_SCALE=0.2;   // "1 : N" in the UI, N = 1/MAP_SCALE -> 1:5
let VERT_SCALE=EXAG;
/* Multiplies the theme's own fogNear/fogFar (a 1.0 default reproduces the theme exactly,
   independent of the exaggeration/map-scale state above). Kept separate from EXAG and
   MAP_SCALE because it only touches scene.fog -- no geometry, no rebuild -- so it can
   apply on every slider `input` event for a genuinely live preview instead of waiting
   for `change` the way the two rebuild-triggering sliders have to. */
let FOG_MUL=3;

function setStartHead(i){ startHead=i; }
function getStartHead(){ return startHead; }
/* VERT_SCALE deliberately does NOT include MAP_SCALE.

   "World scale 1:N" is a shorten-the-walk control, not a zoom. It compacts the POSITIONS
   of the network -- how far apart the trailheads are, how long a loop takes -- and
   nothing else. Sizes stay in true metres: the pup, the trees and rocks, the width of the
   tread, and the height of the hills. Folding MAP_SCALE into VERT_SCALE (as this did)
   flattened the terrain in step with the compaction, so at 1:32 a 180 m ridge became a
   5 m mound and the pup towered over country it should have been dwarfed by.

   The trade this makes is real and worth knowing: since relief is preserved while
   footprint shrinks, the terrain gets genuinely steeper as you compact. Around 1:8 the
   slopes stop reading as hills. The slider's range is capped accordingly. */
function syncScales(){ VERT_SCALE=EXAG; }
/* 0 .. 2. The floor is 0, not 0.3: at heavy world-scale compaction the only way to keep
   real relief from becoming a wall is to flatten it, and 0 is a legitimate setting -- a
   pure plan view of the network. The ceiling came down from 4 because with VERT_SCALE no
   longer divided by the map scale, what used to read as 1.8x now reads as much more. */
function setVertScale(v){ EXAG=clamp(Number(v)||0, 0, 2); syncScales(); rebuildWorld(); }
function getVertScale(){ return VERT_SCALE; }
function getExaggeration(){ return EXAG; }
function getMapScale(){ return MAP_SCALE; }
function getFogMultiplier(){ return FOG_MUL; }
function setFogMultiplier(v){
  FOG_MUL=clamp(Number(v)||1, 0.15, 3);
  applyThemeLighting();          // fog only -- cheap enough to call straight from an input handler
}
function setMapScale(v){
  // "1 : N" in the UI is N = 1/MAP_SCALE, across the full 1..1000 range. Elevation no
  // longer compacts with the footprint (syncScales), so heavy compaction really does
  // steepen the country -- that is what the exaggeration slider is for, and it now
  // reaches 0, which flattens the map completely at any world scale.
  MAP_SCALE=clamp(Number(v)||1, 0.001, 4);
  syncScales();
  if(BUNDLE) BUNDLE.setMapScale(MAP_SCALE);
  rebuildWorld();
}

/* Switch landscape. Everything themed -- sky, fog, light, ground texture, tree and rock
   palettes, densities, the horizon -- is read during rebuildWorld(), so a theme change
   is just "set it, build it". THEME is a live binding in themes.js; reassigning it there
   is picked up here and in pieces.js without either module re-importing anything. */
function setThemeById(id){
  const t=THEMES[id]; if(!t) return false;
  setTheme(t);
  rebuildWorld();
  return true;
}
function getTheme(){ return THEME; }

/* Sky, fog and light levels are scene-wide, not part of worldG, so they are applied
   directly rather than added to the disposable group. Fog distances scale with MAP_SCALE
   (a shrunk map needs fog pulled in to match, or it would see clean across the whole
   thing) and independently with the user's own FOG_MUL on top of that. */
function applyThemeLighting(){
  scene.background=new THREE.Color(THEME.sky);
  scene.fog=new THREE.Fog(new THREE.Color(THEME.sky).getHex(),
                          THEME.fogNear*MAP_SCALE*FOG_MUL, THEME.fogFar*MAP_SCALE*FOG_MUL);
  hemi.color=new THREE.Color(THEME.hemiSky);
  hemi.groundColor=new THREE.Color(THEME.hemiGround);
  hemi.intensity=THEME.hemiInt;
  sun.intensity=THEME.sunInt;
}
function getGraph(){ return GRAPH; }
function getTrailheads(){ return TRAILHEADS; }
function getPOIs(){ return POIS; }
function getAreas(){ return AREAS; }
function getBBox(){ return bboxW; }
function getWorldGroup(){ return worldG; }

function compass(x,z){
  const cx=(bboxW.minx+bboxW.maxx)/2, cz=(bboxW.minz+bboxW.maxz)/2;
  const dx=x-cx, dz=z-cz;
  if(Math.hypot(dx,dz)<1) return 'central';
  const a=Math.atan2(-dz,dx)*180/Math.PI;
  const dirs=['east','northeast','north','northwest','west','southwest','south','southeast'];
  return dirs[(Math.round(((a+360)%360)/45))%8];
}

/* Convex hull (monotone chain) of the whole network, used below to tell an OUTER
   dead-end from an interior one. Returned counter-clockwise; degenerate inputs come back
   as-is, which the caller treats as "no opinion". */
function hullOf(pts){
  if(pts.length < 3) return pts.slice();
  const p = pts.slice().sort((a,b)=> a[0]-b[0] || a[1]-b[1]);
  const cross = (o,a,b)=> (a[0]-o[0])*(b[1]-o[1]) - (a[1]-o[1])*(b[0]-o[0]);
  const half = src => {
    const out = [];
    for(const q of src){
      while(out.length >= 2 && cross(out[out.length-2], out[out.length-1], q) <= 0) out.pop();
      out.push(q);
    }
    out.pop();
    return out;
  };
  return half(p).concat(half(p.slice().reverse()));
}
function distToHull(x, z, hull){
  let best = Infinity;
  for(let i = 0; i < hull.length; i++){
    const a = hull[i], b = hull[(i+1)%hull.length];
    const dx = b[0]-a[0], dz = b[1]-a[1], L2 = dx*dx+dz*dz;
    let t = L2 ? ((x-a[0])*dx + (z-a[1])*dz)/L2 : 0;
    t = t<0?0:(t>1?1:t);
    best = Math.min(best, Math.hypot(x-(a[0]+t*dx), z-(a[1]+t*dz)));
  }
  return best;
}

/* Trailheads: where you can ENTER or LEAVE the network.

   Previously every degree-1 node became one, which on a real map is far too many -- a
   trail network is full of interior dead-ends (a spur to an overlook, a stub where the
   surveyor's line stopped, one side of a switchback that didn't quite connect) and none
   of those is a place you arrive from a car park. It also meant the arrival screen fired
   constantly, since you are never far from some dead-end.

   Two filters, in order:
     OUTER    the node must sit near the convex hull of the whole network. An interior
              spur can be a long way from anything else and still not be on the outside,
              which is exactly the distinction "distance from the centre" fails to make.
     SPREAD   greedily thin what survives so no two trailheads sit within a tenth of the
              map's diagonal, keeping whichever serves the longer trail. Two dead-ends
              either side of a car park are one trailhead, not two.

   Falls back to the old every-dead-end behaviour if the filters leave fewer than two,
   which is what happens on a small or single-path map. */
const TH_HULL_FRAC = 0.055, TH_SPREAD_FRAC = 0.10, TH_MAX = 8;

function buildTrailheads(){
  TRAILHEADS=[];
  if(!GRAPH) return;
  const mk = ni => {
    const n=GRAPH.nodes[ni];
    const e=GRAPH.edges.find(e=>e.a===ni||e.b===ni);
    let yaw=0;
    if(e){
      const pts=e.a===ni?e.pts:[...e.pts].reverse();
      yaw=Math.atan2(-(pts[1][1]-pts[0][1]),pts[1][0]-pts[0][0]);
    }
    return {node:ni,x:n.p[0],z:n.p[1],yaw,name:e?e.name:'Trail',
            color:e?e.color:'#b58347',lenM:e?e.lenM:0,where:compass(n.p[0],n.p[1])};
  };
  const ends=[];
  GRAPH.nodes.forEach((n,ni)=>{ if(n.deg===1) ends.push(ni); });

  const diag=Math.hypot(bboxW.maxx-bboxW.minx, bboxW.maxz-bboxW.minz)||1;
  const all=[]; GRAPH.edges.forEach(e=>e.pts.forEach(p=>all.push(p)));
  const hull=hullOf(all);

  let cand = ends.map(mk);
  if(hull.length>=3){
    cand = cand.filter(t=> distToHull(t.x,t.z,hull) <= diag*TH_HULL_FRAC);
  }
  cand.sort((a,b)=> b.lenM-a.lenM);
  const kept=[];
  for(const t of cand){
    if(kept.length>=TH_MAX) break;
    if(kept.some(k=>Math.hypot(k.x-t.x,k.z-t.z) < diag*TH_SPREAD_FRAC)) continue;
    kept.push(t);
  }
  TRAILHEADS = kept.length>=2 ? kept : ends.map(mk);

  if(!TRAILHEADS.length&&GRAPH.nodes.length){
    const picks=[...GRAPH.nodes.keys()].sort((a,b)=>GRAPH.nodes[a].p[1]-GRAPH.nodes[b].p[1]);
    [picks[0],picks[picks.length-1]].forEach(ni=>TRAILHEADS.push(mk(ni)));
  }
  TRAILHEADS.sort((a,b)=>a.name.localeCompare(b.name)||a.where.localeCompare(b.where));
  if(startHead>=TRAILHEADS.length) startHead=0;
}

/* Load a pup-world/1 bundle (from fetch_dem.py) and rebuild the whole scene from it.
   `extraLayers` are additional raw GeoJSON FeatureCollections the user drops in-session,
   on top of whatever the bundle itself already carries in bundle.layers -- both get
   projected through the SAME World instance, so they can never drift apart. */
async function loadWorld(urlOrBundleObj, extraLayers, stepMetres){
  BUNDLE = (typeof urlOrBundleObj==='string')
    ? await fetchWorldBundle(urlOrBundleObj)
    : loadWorldBundle(urlOrBundleObj);
  BUNDLE.setMapScale(MAP_SCALE);
  if(extraLayers) EXTRA = extraLayers.slice();
  if(stepMetres) STEP_M = stepMetres;
  rebuildWorld();
  return BUNDLE;
}

/* Add plain GeoJSON layers (a trails file, an areas-of-interest file, ...) without a DEM
   bundle, or on top of one. Each call rebuilds so the map appears immediately. */
function addLayers(layers){
  EXTRA.push(...layers.filter(Boolean));
  rebuildWorld();
}
function clearLayers(){ EXTRA=[]; rebuildWorld(); }
function hasBundle(){ return !!BUNDLE; }
function setContourStep(m){ STEP_M=clamp(Number(m)||3, 0.5, 20); rebuildWorld(); }
function getContourStep(){ return STEP_M; }
function getSignCount(){ return SIGN_COUNT; }
function getPathMix(){ return PATH_MIX; }
function getAreaLabels(){ return AREA_LABELS; }

/* Cap how big a floating area name may get on screen.

   A three.js Sprite is sized in WORLD units, so its apparent size is proportional to
   scale/distance -- which grows without limit as you walk up to a landmark, until the
   name is wider than the viewport and its ends are cut off. That is the "gets so close
   it clips off screen" problem, and it cannot be fixed by choosing a smaller base size:
   any fixed world size is too big at SOME distance.

   So hold apparent size constant instead, below a near threshold: keep the world scale
   proportional to distance, which makes scale/distance -- the thing the eye actually
   sees -- constant. Above the threshold the sprite behaves normally and recedes with
   distance like the landmark it labels. */
const LABEL_HOLD_DIST = 26;
function updateAreaLabels(camX, camY, camZ){
  for(const spr of AREA_LABELS){
    const base = spr.userData.baseScale || 6;
    // world position: the sprite sits at a local offset inside its area group
    const px = spr.parent ? spr.parent.position.x + spr.position.x : spr.position.x;
    const py = spr.parent ? spr.parent.position.y + spr.position.y : spr.position.y;
    const pz = spr.parent ? spr.parent.position.z + spr.position.z : spr.position.z;
    const dist = Math.hypot(px-camX, py-camY, pz-camZ);
    /* No floor on k. A floor would re-break the very guarantee this exists for: below it
       the world scale stops tracking distance and apparent size starts climbing again.
       Letting it go to zero is correct -- the label shrinks out of the way as you walk
       into the place it names -- and the opacity fade below finishes the job so it bows
       out instead of lingering as a speck. */
    const k = Math.min(1, dist/LABEL_HOLD_DIST);
    const w = base*k;
    spr.scale.set(w, w*0.25, 1);
    if(spr.material) spr.material.opacity = clamp((dist - 2.5)/4, 0, 1);
  }
}

/* Tread width in real metres per path kind, hoisted out of rebuildWorld's PATH_STYLE
   because the terrain-carving pass needs the widths BEFORE the ribbon loop runs (it has
   to cut the bench before buildTerrainMesh bakes the grid), and both must agree on the
   number or the carve and the ribbon end up different widths. */
const PATH_W = {trail:1.1, track:1.9, road:3.0};
/* True metres, NOT scaled by MAP_SCALE. A tread is an object with a size, and the pup
   has to stay the right size relative to it however compact the network is.

   These are real trail widths. The previous set (2.6 / 3.7 / 4.6 m of tread, plus a flat
   +2.3 m of ink on top) drew every footpath at the width of a fire road -- about five
   dog-lengths across -- which is what made a graded corridor read as a stack of pancakes
   rather than a path: the bench had to be wider still, so each cell-sized step in it was
   a five-metre brown plateau. Singletrack is about a metre. */
function pathWidth(kind){ return PATH_W[kind]||PATH_W.trail; }
/* Full painted width including the ink outline -- what the bench underneath has to cover
   if the ribbon isn't to spill off its own graded corridor onto stepped ground. */
function pathOutlineWidth(kind){ return pathWidth(kind)*OUTLINE_MUL; }
const OUTLINE_MUL = 1.5, SHOULDER_MUL = 1.24;

/* Which surface wins where two paths occupy the same ground.

   The rule is the real-world one: the bigger, more built surface is the ground, and the
   smaller one is painted on top of it. A footpath crosses a service road; a service road
   does not cross a footpath. Rank 0 is "most built", so a lower rank is further down the
   stack -- which is also the order the bench and the ribbons are drawn in.

   Two mechanisms enforce it, because one is not enough. pieces.js's trailMat biases the
   depth test by rank, which is what actually stops the flicker; kindLift adds a few real
   centimetres on top so the ordering still holds if a driver clamps polygon offset, and
   so the ink outline of the upper path visibly overlaps the lower surface rather than
   fighting it. 4.5 cm is under a twentieth of a tread width -- invisible as float, plenty
   for a depth buffer. */
const PATH_RANK = {road:0, track:1, trail:2};
function pathRank(kind){ return PATH_RANK[kind] == null ? PATH_RANK.trail : PATH_RANK[kind]; }
const KIND_LIFT_M = 0.045;
function kindLift(kind){ return pathRank(kind)*KIND_LIFT_M; }

/* Paths that run ALONG another path rather than across it.

   Crossing and overlapping are different problems with different answers, and only the
   first one is solved by depth ordering. A signed route that follows a service road for
   200 m is TWO pieces of geometry describing ONE piece of ground: draw both ribbon stacks
   and you get a dirt strip painted down the middle of the tarmac, complete with its own
   ink outline, shoulder and edge stones -- which is not what that place looks like, and
   which no amount of z-ordering improves. On the default map 13 edges (0.9 km of 52.8)
   are like this; measured, not guessed.

   So: find them, and render the upper one as a ROUTE MARKER instead of a surface -- a
   slim coloured line in the trail's own blaze colour, laid on the road. The topology is
   untouched, so it still walks, still routes, still shows on the map and still gets its
   name on a signpost. Only the second helping of tarmac goes away.

   `buried` holds the HOST edge (not just a flag) so the renderer can lift the marker to
   the host's surface, and so the panel can say what a route shares its ground with. */
const BURY_FRAC = 0.6;          // share of a path's vertices that must sit inside a host
function markBuriedEdges(){
  if(!GRAPH) return 0;
  /* *MAP_SCALE, and this is the whole correctness of the pass.

     "Does this route share that road's ground" is a question about the REAL WORLD, and it
     has one answer for a given map. Positions here are compacted by the world scale;
     tread widths deliberately are NOT (a path stays a path-width whatever the slider
     says, same rule as the pup and the trees). Comparing the two directly therefore asks
     a different question at every slider position, and measured on the default map the
     answer runs away with it: 11 edges buried at 1:1, 49 at 1:16, 205 of 316 at 1:100 --
     two thirds of the network silently demoted to waymarks because somebody shortened
     their walk. Scaling the corridor to match the coordinates it is tested against pins
     the answer at 11 edges (0.68 km) at every scale, which is what the source data
     actually says. That matters more now than it would have last month: the world-scale
     slider is a live mid-walk control, so a scale-dependent answer here would change how
     the map is DRAWN under a walker's feet. */
  const corridor = kind => (pathOutlineWidth(kind)/2)*MAP_SCALE;
  const cell = Math.max(12*MAP_SCALE, 1e-3);
  // hash only the paths that can HOST one: a footpath is never the ground another
  // footpath is painted on, so trails are excluded from the index entirely
  const H = new Map();
  for(const e of GRAPH.edges){
    if(pathRank(e.kind) >= PATH_RANK.trail) continue;
    const r = corridor(e.kind);
    for(let i=0;i<e.pts.length-1;i++){
      const a=e.pts[i], b=e.pts[i+1], s={a,b,e,r};
      const x0=Math.min(a[0],b[0])-r, x1=Math.max(a[0],b[0])+r;
      const z0=Math.min(a[1],b[1])-r, z1=Math.max(a[1],b[1])+r;
      for(let cx=Math.floor(x0/cell);cx<=Math.floor(x1/cell);cx++)
        for(let cz=Math.floor(z0/cell);cz<=Math.floor(z1/cell);cz++){
          const k=cx+'_'+cz; let arr=H.get(k); if(!arr){arr=[];H.set(k,arr);} arr.push(s);
        }
    }
  }
  let n=0;
  for(const e of GRAPH.edges){
    e.buried = null;
    if(!H.size || pathRank(e.kind)===0 || e.pts.length<2) continue;
    let hit=0, host=null;
    for(const p of e.pts){
      const cand=H.get(Math.floor(p[0]/cell)+'_'+Math.floor(p[1]/cell));
      if(!cand) continue;
      let best=Infinity, bestE=null;
      for(const s of cand){
        if(pathRank(s.e.kind) >= pathRank(e.kind)) continue;
        const d=ptSeg(p, s.a, s.b).d;
        if(d < s.r && d < best){ best=d; bestE=s.e; }
      }
      if(bestE){ hit++; if(!host) host=bestE; }
    }
    if(hit/e.pts.length >= BURY_FRAC){ e.buried = host; n++; }
  }
  return n;
}

/* ---------- crossings, as designed infrastructure ----------

   Depth ordering (see PATH_RANK) made a road/trail crossing legible. It did not make it
   GOOD. The survey geometry crosses at whatever angle the digitiser drew, so a footpath
   meets a service road at 20 degrees and the two ribbons share fifteen metres of ground
   at a slant -- correct to the metre, and unreadable as a place to cross. Real networks
   solve this with a small, universally understood vocabulary: square the path up to the
   kerb, stripe the carriageway, land it on a pad either side. This builds that, and
   spends the survey angle to buy it.

   TWO REWRITES, and they are separate problems with separate answers:

     squareApproach()  turns the last few metres of each path arm at a crossing to meet
                       the road at ninety degrees, blending back to the recorded line so
                       there is no kink where the correction ends.
     asSidewalk()      takes a path that runs ALONG a road (markBuriedEdges found 11 of
                       them) and moves it off the centreline onto the verge, where a
                       footway beside a road actually is. The previous version drew it as
                       a stripe down the middle of the carriageway, which is where the
                       data says it is and nowhere a person would walk.

   Both mutate e.pts before anything is graded, hashed or drawn, so the bench, the
   spatial hash, the ribbons and the minimap all agree by construction -- there is no
   second copy of the geometry to keep in step. */
const CROSSINGS = [];        // cleared in place; drawn during rebuild, asserted in smoke

/* Arc length along a polyline, and the unit direction leaving vertex 0. */
function armDir(pts){
  for(let i=1;i<pts.length;i++){
    const dx=pts[i][0]-pts[0][0], dz=pts[i][1]-pts[0][1];
    const L=Math.hypot(dx,dz);
    if(L>1e-6) return [dx/L, dz/L];
  }
  return [1,0];
}

/* Rewrite the start of `pts` (which begins AT the node) so the path leaves along
   [ux,uz] -- square to the road -- and eases back onto the recorded line.

   RESAMPLES rather than nudging the existing vertices, and that is the whole correctness
   of it. The first version moved each vertex inside the apron toward where a square
   approach would put it, weighted by how far along it was. It did nothing at all, and the
   measurement said so: the angles at crossings stayed spread from 0 to 90 degrees instead
   of clustering at 90. The reason is upstream -- buildGraph runs Douglas-Peucker over
   every line, so a path's vertices are metres apart and its FIRST segment is routinely
   longer than the whole apron. There were no vertices inside the apron to nudge; the loop
   hit its bound on the first iteration and returned having touched nothing.

   So the apron gets its own vertices. The path holds a true perpendicular for the first
   45% -- long enough to actually read as arriving square, and to give the kerb something
   to meet at a right angle -- then smoothsteps onto the recorded geometry, which reaches
   it with matching position and near-matching direction. Everything past the apron is the
   survey line untouched.

   Returns a NEW array; the caller assigns it. pts[0] is copied by value and never moved,
   because an endpoint is the edge's claim on a graph node and shifting it detaches the
   edge from the junction it belongs to (see asSidewalk's note -- same bug, caught by the
   same assertion). */
const APRON_SAMPLES = 8, APRON_HOLD = 0.45;
function squareApproach(pts, ux, uz, apron){
  if(pts.length < 2 || !(apron > 0)) return pts;
  const arc = [0];
  for(let i=1;i<pts.length;i++)
    arc[i] = arc[i-1] + Math.hypot(pts[i][0]-pts[i-1][0], pts[i][1]-pts[i-1][1]);
  const total = arc[arc.length-1];
  /* An edge with a crossing at BOTH ends is squared twice, from opposite directions.
     Capping each correction at 40% of the edge leaves recorded line in the middle, so the
     two never fight over the same stretch and a short connector between two road
     crossings does not become an S-bend. */
  apron = Math.min(apron, total*0.4);
  if(!(apron > 0)) return pts;

  const at = s => {
    for(let i=1;i<pts.length;i++){
      if(arc[i] >= s){
        const t = (s-arc[i-1])/Math.max(1e-9, arc[i]-arc[i-1]);
        return [pts[i-1][0]+(pts[i][0]-pts[i-1][0])*t, pts[i-1][1]+(pts[i][1]-pts[i-1][1])*t];
      }
    }
    return pts[pts.length-1].slice();
  };

  const out = [pts[0].slice()];
  for(let k=1;k<=APRON_SAMPLES;k++){
    const f = k/APRON_SAMPLES, s = apron*f;
    const ideal = [pts[0][0]+ux*s, pts[0][1]+uz*s];
    const orig = at(s);
    // 1 while holding square, falling to 0 at the apron edge; smoothstepped so there is
    // no corner where the blend starts or ends
    const w = f <= APRON_HOLD ? 1 : 1 - (f-APRON_HOLD)/(1-APRON_HOLD);
    const e = w*w*(3-2*w);
    out.push([ideal[0]+(orig[0]-ideal[0])*(1-e), ideal[1]+(orig[1]-ideal[1])*(1-e)]);
  }
  for(let i=1;i<pts.length;i++) if(arc[i] > apron) out.push(pts[i].slice());
  return out;
}

/* Nearest point on a polyline, with the local direction there. */
function projectOnPolyline(pts, x, z){
  let best={d:Infinity, px:x, pz:z, dir:[1,0]};
  for(let i=0;i<pts.length-1;i++){
    const r=ptSeg([x,z], pts[i], pts[i+1]);
    if(r.d<best.d){
      let dx=pts[i+1][0]-pts[i][0], dz=pts[i+1][1]-pts[i][1];
      const L=Math.hypot(dx,dz)||1;
      best={d:r.d, px:r.q[0], pz:r.q[1], dir:[dx/L, dz/L]};
    }
  }
  return best;
}

/* Move a buried path onto the verge of its host: a divided sidewalk rather than a stripe
   down the middle of the road. The side is decided ONCE, from the average signed offset
   of the whole path, rather than per vertex -- per-vertex would let a footway that wanders
   across the centreline flip sides mid-block and zigzag through the traffic. */
function asSidewalk(e, offset){
  const host=e.buried;
  if(!host || host.pts.length<2) return false;
  let sum=0, n=0;
  const proj=[];
  for(const p of e.pts){
    const pr=projectOnPolyline(host.pts, p[0], p[1]);
    const nx=-pr.dir[1], nz=pr.dir[0];
    const side=(p[0]-pr.px)*nx + (p[1]-pr.pz)*nz;
    sum+=side; n++;
    proj.push({pr, nx, nz});
  }
  if(!n) return false;
  const sd = sum>=0 ? 1 : -1;

  /* TAPER THE OFFSET IN AND OUT AT THE ENDS, and this is not cosmetic.

     Moving every vertex onto the verge moves the two ENDPOINTS as well -- and an
     endpoint is not just a point, it is the edge's claim on a graph node. world.js grades
     each edge with its ends pinned to the average height every edge meeting at that node
     asked for; shift an endpoint a couple of metres sideways and it is no longer at the
     node, so the consensus it contributes to is taken at one place and applied at
     another. The smoke suite caught it immediately as junctions whose ribbons arrived at
     different heights -- the exact class of bug the grading pass exists to prevent.

     Tapering also happens to be right on its own terms: a footway beside a road does
     rejoin the carriageway at the junction at either end. So the offset ramps up over a
     short run, holds along the block, and ramps back down. */
  const arc=[0];
  for(let i=1;i<e.pts.length;i++)
    arc[i]=arc[i-1]+Math.hypot(e.pts[i][0]-e.pts[i-1][0], e.pts[i][1]-e.pts[i-1][1]);
  const total=arc[arc.length-1];
  if(!(total>0)) return false;
  const taper=Math.min(offset*2.5, total*0.35);
  for(let i=0;i<e.pts.length;i++){
    const {pr, nx, nz}=proj[i];
    const s=arc[i];
    const w = taper>0 ? clamp(Math.min(s, total-s)/taper, 0, 1) : 1;
    // lerp between the recorded line and the verge, so w=0 leaves the endpoint exactly
    // where the graph put it
    const tx = pr.px + nx*sd*offset, tz = pr.pz + nz*sd*offset;
    e.pts[i][0] += (tx - e.pts[i][0])*w;
    e.pts[i][1] += (tz - e.pts[i][1])*w;
  }
  e.sidewalk = {side:sd, offset};
  return true;
}

/* Plan every road crossing on the map, and rewrite the geometry that meets it. Runs after
   markBuriedEdges (a path that FOLLOWS the road is a sidewalk, not a crossing, and must
   not be squared up to it) and before grading. */
/* Is this node a place where a path goes ACROSS the road, or merely a place where a path
   TOUCHES it? The two want opposite furniture, and the old rule -- "a road arm and a walk
   arm meet here" -- could not tell them apart. Measured on the default map it built 43
   crossings of which 11 were real: the other 32 were trails ending on the verge, trails
   whose endpoint splitT welded to a road it merely passed within 16 m of, and paths
   running ALONG the carriageway whose arm direction voted an arbitrary side.

   A crossing needs both halves of the word:
     - the road must CONTINUE past the node (>= 2 road arms). One road arm means the road
       stops here; there is nothing on the far side to cross to.
     - a walk arm must leave on EACH side of the road axis. That is the whole definition,
       and it is what the caller asked for: stripe the tarmac only when there is a trail
       on both sides of it.
   Arms running along the road within ALONG_MAX of its axis are excluded from the side
   census before it is taken. Their normal component is nearly zero, so which side they
   "leave on" is decided by digitiser noise -- and a path following a road is a sidewalk
   (asSidewalk, above), never a crossing.

   Returns null for a non-crossing, with the road axis still filled in, because the caller
   needs it either way: a path stopping at the verge still has to have its ribbon trimmed
   back to the kerb. */
const ALONG_MAX = 0.8;
function roadContact(ni, adj){
  const here=adj[ni]||[];
  const roads=here.filter(x=>x.kind==='road');
  const walks=here.filter(x=>x.kind!=='road' && !x.buried);
  if(!roads.length || !walks.length) return null;

  /* The road's axis. Averaged over the road arms as an UNDIRECTED line (arms leaving in
     opposite directions must not cancel to zero), which is why each arm's direction is
     flipped into a common half-plane before it is summed. */
  let ax=0, az=0, ref=null;
  for(const r of roads){
    const pts = r.a===ni ? r.pts : [...r.pts].reverse();
    let d = armDir(pts);
    if(!ref) ref=d;
    if(d[0]*ref[0]+d[1]*ref[1] < 0) d=[-d[0],-d[1]];
    ax+=d[0]; az+=d[1];
  }
  const L=Math.hypot(ax,az);
  if(L<1e-6) return null;
  const dir=[ax/L, az/L], nx=-dir[1], nz=dir[0];

  const arms=[];
  let pos=0, neg=0;
  for(const w of walks){
    const flip = w.b===ni && w.a!==ni;
    const pts = flip ? [...w.pts].reverse() : w.pts;
    const d = armDir(pts);
    const along = Math.abs(d[0]*dir[0] + d[1]*dir[1]);
    const side = (d[0]*nx + d[1]*nz) >= 0 ? 1 : -1;
    arms.push({w, flip, side, along});
    if(along > ALONG_MAX) continue;
    if(side > 0) pos++; else neg++;
  }
  const roadW = Math.max(...roads.map(r=>pathWidth(r.kind)));
  const walkW = Math.max(...walks.map(w=>pathWidth(w.kind)))*2.1;
  return {dir, nx, nz, roads, walks, arms, roadW, walkW,
          crossing: roads.length>=2 && pos>0 && neg>0};
}

function planCrossings(adj){
  CROSSINGS.length=0;
  if(!GRAPH) return 0;
  const roadHalf = kind => pathOutlineWidth(kind)/2;

  // sidewalks first: a buried path moved onto the verge changes where it meets the road
  for(const e of GRAPH.edges){
    if(!e.buried) continue;
    asSidewalk(e, roadHalf(e.buried.kind) + pathWidth(e.kind)*0.75);
  }

  for(let ni=0; ni<GRAPH.nodes.length; ni++){
    const c = roadContact(ni, adj);
    if(!c) continue;
    const n=GRAPH.nodes[ni];
    const apron = Math.max(c.roadW*1.8, c.walkW*1.6);

    /* Where the trail's SURFACE has to stop. The path still runs to the node -- the graph
       edge is what makes the crossing walkable and routable -- but its ribbon ends at the
       kerb, and the crosswalk carries it across. Drawing both was what put a dirt track
       over the tarmac in the screenshot: two surfaces claiming the same carriageway, one
       of which is the marked crossing that exists precisely to say who has it.

       TRIMMING IS NOT CONDITIONAL ON THE CROSSING. Separating the two decisions is the
       point of roadContact: a trail that merely ends on the verge paints over the
       carriageway just as badly as one crossing it, and it was only ever trimmed by
       accident, because the old rule called it a crossing too. Tightening that rule
       without splitting the trim out would have fixed 32 spurious crosswalks by putting
       32 dirt ribbons back on the tarmac. */
    const kerbW = Math.max(0.28, c.roadW*0.09);
    const trim = c.roadW*0.5 + kerbW + c.walkW*0.06;

    for(const a of c.arms){
      const w = a.w;
      if(a.flip) w.trimB = Math.max(w.trimB||0, trim);
      else       w.trimA = Math.max(w.trimA||0, trim);
      /* Squaring up is crossing-only. A path CROSSING a road wants to meet it at ninety
         degrees, because that is what the stripes and the two landings are drawn square
         to. A path that merely ends at the verge has no far side to line up with, and
         turning its last few metres to face the traffic would invent a geometry the
         survey never recorded and no walker would follow. */
      if(!c.crossing || a.along > ALONG_MAX) continue;
      // orient the arm so pts[0] is this node, square it up, then write it back the way
      // round it came. squareApproach returns a new array (it inserts vertices), so the
      // assignment is not optional the way an in-place nudge would have been.
      const pts = a.flip ? [...w.pts].reverse() : w.pts;
      const squared = squareApproach(pts, c.nx*a.side, c.nz*a.side, apron);
      w.pts = a.flip ? squared.reverse() : squared;
    }

    if(!c.crossing) continue;
    CROSSINGS.push({x:n.p[0], z:n.p[1], dir:c.dir, roadW:c.roadW, walkW:c.walkW, trim,
                    lift:kindLift('road'), node:ni});
  }
  return CROSSINGS.length;
}

function getCrossings(){ return CROSSINGS; }

/* ---------- displacement: keep painted surfaces off each other ----------

   Widths are true metres and never compact (PATH_W's note); positions do. So the
   clearance a ribbon needs, measured in the coordinates it is actually drawn in, GROWS as
   the world scale shrinks: two centrelines have to be 3.08 units apart for a trail not to
   paint over a road, which is 15.4 real metres at 1:5 and 30.8 at 1:10. A footpath on a
   road verge is three to ten real metres off the centreline. The survey cannot satisfy
   that and was never asked to.

   Measured on the default map: 331 real metres of path overlap another path's painted
   surface at 1:1, 929 at 1:5, 4735 at 1:10. So this is not purely a compaction artifact
   -- the survey really does run some paths within a tread's width of each other -- but
   compaction is what turns a handful of touches into the pile-up in the screenshot.

   THE TRADE, STATED PLAINLY. Geographic accuracy is spent to buy spatial legibility: a
   trail beside a road is drawn beside the road rather than at its recorded offset. That
   is the ordinary cartographic answer to symbols outgrowing their scale, and it is the
   right one here, because what this map is FOR is walking a network -- a claim about what
   runs next to what, not about coordinates.

   WIDER PATHS ARE ANCHORS. An edge is pushed off anything of lower pathRank than itself
   and never off its equals, so roads move for nothing, tracks move only for roads, and
   trails move for both. That makes each conflict one-sided -- a single movable body --
   which is why this converges in three short passes instead of needing a two-body
   relaxation. It also keeps roads registered to the area polygons (parking lots,
   buildings) that flattenAreaCells benches the terrain for, and it reuses the ranking the
   burial pass and the depth ordering already agree on rather than inventing a second one.

   SIDEDNESS IS PRESERVED BY CONSTRUCTION. Every vertex is pushed out along the sign of the
   offset it ALREADY has, so a trail can never be shoved through a carriageway to the far
   side. That invariant is the whole of "keep the spatial relation, not the coordinate",
   and it is what tools/smoke.js asserts -- not the displacement distance, which is a
   consequence, but the sidedness, which is the promise.

   Runs after planCrossings -- which rewrites approach geometry and decides which paths are
   sidewalks -- and before grading, for the reason the adjacency comment gives: there is
   one copy of the geometry and it must be finished being edited before the bench, the
   spatial hash and the ribbons are all built from it. */
const CLEAR_MARGIN = 0.2;     // breathing room on top of the two painted half-widths
const CLEAR_ROUNDS = 3;       // push/smooth cycles

function clearOfWiderPaths(){
  if(!GRAPH) return 0;
  let moved = 0;

  /* WIDEST FIRST. An anchor has to be in its final position before anything is pushed off
     it, and a track is both an anchor (for trails) and movable (for roads). Walking the
     edge array in its own order cleared trails against a track that then moved out from
     under them -- measured, that left a 1.6u conflict standing between a track and a trail
     that had each been correctly displaced, just in the wrong order. Ranking the walk
     makes each edge final before anything reads it. */
  const order = GRAPH.edges.slice().sort((a,b)=>pathRank(a.kind)-pathRank(b.kind));

  for(const e of order){
    /* Buried paths are not drawn as surfaces at all -- they are route markers laid on
       their host (markBuriedEdges) -- and asSidewalk has already placed them exactly
       where they belong on the verge. Pushing one again would shove a sidewalk off the
       road it is meant to follow. */
    if(e.buried || e.pts.length < 2) continue;
    const anchors = GRAPH.edges.filter(o =>
      o !== e && o.pts.length >= 2 && pathRank(o.kind) < pathRank(e.kind));
    if(!anchors.length) continue;
    const half = pathOutlineWidth(e.kind)/2 + CLEAR_MARGIN;

    /* RESAMPLE FIRST, and this is the whole reason the pass does anything at all.

       buildGraph runs Douglas-Peucker over every line, so a straight fragment keeps only
       its two endpoints -- 85 of the 208 drawable non-road edges on the default map are
       exactly two points long. Both of those are graph nodes and neither may move (see
       below), so a push that only nudges existing vertices has nothing to touch on 40% of
       the network and silently returns having done nothing. That is not a new hazard:
       squareApproach's comment records the same bug being found the same way, which is
       why it inserts its own apron vertices instead of nudging.

       Station spacing matches rebuildWorld's minStep -- 60% of the painted width -- so the
       displaced line is sampled at least as finely as the ribbon that will be drawn from
       it, and no conflict can hide between two stations. */
    e.pts = resample(e.pts, pathOutlineWidth(e.kind)*0.6);
    if(e.pts.length < 3) continue;   // too short to have an interior; leave it alone
    const recorded = e.pts.map(p=>p.slice());

    /* Endpoints never move. An endpoint is the edge's claim on a graph node -- shift it
       and the edge is no longer at the junction it belongs to, which is the bug
       asSidewalk's taper note documents and the smoke suite catches as junctions whose
       ribbons arrive at different heights. The push therefore tapers to zero at both
       ends, which is also right on its own terms: a trail that MEETS a road should touch
       it, and planCrossings has already trimmed its ribbon back to the kerb. */
    const arc=[0];
    for(let i=1;i<e.pts.length;i++)
      arc[i]=arc[i-1]+Math.hypot(e.pts[i][0]-e.pts[i-1][0], e.pts[i][1]-e.pts[i-1][1]);
    const total=arc[arc.length-1];
    if(!(total>0)) continue;

    /* WHICH SIDE OF WHAT: frozen here, from the RECORDED geometry, before anything moves.

       This is the invariant the whole pass exists to keep, so it must not be re-derived
       from geometry the pass is itself editing. Recomputing the sign each round let a
       vertex that had been nudged across a centreline adopt its new, wrong side and keep
       going -- measured, five of 127 near-anchor stretches ended up on the opposite side
       of the thing they were displaced from. Freezing the signs makes "the trail stays on
       the side of the road it was surveyed on" true by construction rather than by luck.

       Per vertex, not per edge, because a path that genuinely CROSSES an anchor has to be
       allowed to have a different sign either side of the crossing. A vertex sitting
       almost exactly on the centreline has no reliable opinion of its own, so it borrows
       the edge's majority instead of voting with rounding noise -- the same reasoning
       asSidewalk applies to a footway wandering over a road's centreline. */
    const sideOf = new Array(e.pts.length).fill(0);
    {
      let sum = 0;
      for(let i=0;i<e.pts.length;i++){
        const p=e.pts[i];
        let near=null, nd=Infinity;
        for(const o of anchors){
          const pr=projectOnPolyline(o.pts, p[0], p[1]);
          if(pr.d < nd){ nd=pr.d; near=pr; }
        }
        if(!near) continue;
        const off=(p[0]-near.px)*(-near.dir[1]) + (p[1]-near.pz)*near.dir[0];
        sum += off;
        sideOf[i] = Math.abs(off) > 1e-3 ? (off>0?1:-1) : 0;
      }
      const majority = sum>=0 ? 1 : -1;
      for(let i=0;i<sideOf.length;i++) if(!sideOf[i]) sideOf[i]=majority;
    }

    let touched=false;
    /* Push, smooth, push again. Smoothing is what keeps the corrected stretch from
       kinking where it rejoins the recorded line, but it also drags the vertices it
       smooths back toward the anchor it just cleared -- measured, that left four
       conflicts standing at up to 1.3u after a single pass. Re-projecting after each
       smooth settles it: the last round pushes without smoothing, so the clearance the
       ribbon is finally drawn at is the one that was actually enforced. */
    for(let round=0; round<CLEAR_ROUNDS; round++){
      const pushed=new Array(e.pts.length).fill(false);
      for(let i=0;i<e.pts.length;i++){
        const p=e.pts[i];
        let worst=null, worstOver=0;
        for(const o of anchors){
          const clear = half + pathOutlineWidth(o.kind)/2;
          const pr = projectOnPolyline(o.pts, p[0], p[1]);
          const over = clear - pr.d;
          if(over > worstOver){ worstOver=over; worst={pr, clear}; }
        }
        if(!worst) continue;
        const {pr, clear}=worst;
        const nx=-pr.dir[1], nz=pr.dir[0];
        const sd = sideOf[i];
        // taper scaled to the size of the correction, so a small nudge unwinds quickly
        // and a large one is spread over enough of the edge to stay smooth
        const taper=Math.min(Math.max(worstOver*3, 2), total*0.4);
        const w = clamp(Math.min(arc[i], total-arc[i])/taper, 0, 1);
        if(w<=0) continue;
        const tx=pr.px + nx*sd*clear, tz=pr.pz + nz*sd*clear;
        e.pts[i][0] += (tx-e.pts[i][0])*w;
        e.pts[i][1] += (tz-e.pts[i][1])*w;
        pushed[i]=true; touched=true;
      }
      if(round === CLEAR_ROUNDS-1) break;      // never smooth after the final push
      const src=e.pts.map(p=>p.slice());
      for(let i=1;i<e.pts.length-1;i++){
        if(!pushed[i]) continue;
        e.pts[i][0]=src[i][0]*0.5 + (src[i-1][0]+src[i+1][0])*0.25;
        e.pts[i][1]=src[i][1]*0.5 + (src[i-1][1]+src[i+1][1])*0.25;
      }
    }
    /* Keep the recorded line. It costs one array per moved edge and it is the only way
       the sidedness invariant can be CHECKED rather than asserted by the code that
       enforces it -- tools/smoke.js reads it to confirm no vertex ended up on the far
       side of the anchor from where the survey put it. */
    if(touched){ moved++; e.displaced=true; e.recorded=recorded; }
  }
  return moved;
}


/* Shove a point out of any road it is standing in.

   Signs were being moved off the carriageway only at nodes the crossing planner had
   flagged, which handled the case in the screenshot and missed the general one: a trail
   fork can sit a metre from a road without being a crossing at all, and its post lands in
   the traffic lane just the same. 14 posts on the default map, found by asserting it
   rather than by looking at another screenshot.

   Pushes perpendicular to the offending road, to whichever side it is already nearer, far
   enough to clear the painted surface plus a margin. Iterating every road edge is fine at
   this scale -- a couple of dozen posts against a few dozen roads, once per rebuild. */
function pushOffRoad(x, z, margin){
  if(!GRAPH) return [x, z];
  let px=x, pz=z;
  for(let pass=0; pass<3; pass++){
    let worst=null, worstOver=0;
    for(const e of GRAPH.edges){
      if(e.kind!=='road' || e.pts.length<2) continue;
      const clear = pathOutlineWidth(e.kind)/2 + (margin||0);
      for(let i=0;i<e.pts.length-1;i++){
        const a=e.pts[i], b=e.pts[i+1];
        if(Math.min(a[0],b[0])-clear > px || Math.max(a[0],b[0])+clear < px) continue;
        if(Math.min(a[1],b[1])-clear > pz || Math.max(a[1],b[1])+clear < pz) continue;
        const r=ptSeg([px,pz], a, b);
        const over = clear - r.d;
        if(over > worstOver){ worstOver=over; worst={r, a, b, clear}; }
      }
    }
    if(!worst) break;
    let dx=worst.b[0]-worst.a[0], dz=worst.b[1]-worst.a[1];
    const L=Math.hypot(dx,dz)||1;
    let nx=-dz/L, nz=dx/L;
    // away from the centreline on the side it is already on; a post exactly on the line
    // has no preferred side, so pick one rather than dividing by zero
    let sx=px-worst.r.q[0], sz=pz-worst.r.q[1];
    const side = (sx*nx + sz*nz) >= 0 ? 1 : -1;
    px = worst.r.q[0] + nx*side*worst.clear*1.06;
    pz = worst.r.q[1] + nz*side*worst.clear*1.06;
  }
  return [px, pz];
}

function crossingAt(ni){
  for(const c of CROSSINGS) if(c.node===ni) return c;
  return null;
}

/* Drop the first `a` and last `b` units of a profile, so a ribbon can stop short of its
   own endpoint without the edge being shortened for anything else. The graph keeps its
   full geometry -- routing, the walkable bench and the spatial hash all still run to the
   node -- and only the painted surface is cut back. Returns null when there is nothing
   left worth drawing, which is the right answer for a connector shorter than the road it
   crosses: that stub IS the crossing, and the crosswalk already draws it. */
function trimProfile(prof, a, b){
  const pts=prof.pts, ys=prof.ys;
  if(!pts || pts.length<2) return null;
  const arc=[0];
  for(let i=1;i<pts.length;i++)
    arc[i]=arc[i-1]+Math.hypot(pts[i][0]-pts[i-1][0], pts[i][1]-pts[i-1][1]);
  const total=arc[arc.length-1];
  const lo=Math.max(0, a||0), hi=total-Math.max(0, b||0);
  if(!(hi-lo > 0.35)) return null;
  const outP=[], outY=[];
  const at=(s)=>{
    for(let i=1;i<pts.length;i++){
      if(arc[i]>=s){
        const t=(s-arc[i-1])/Math.max(1e-9, arc[i]-arc[i-1]);
        return [[pts[i-1][0]+(pts[i][0]-pts[i-1][0])*t, pts[i-1][1]+(pts[i][1]-pts[i-1][1])*t],
                ys ? ys[i-1]+(ys[i]-ys[i-1])*t : 0];
      }
    }
    return [pts[pts.length-1].slice(), ys ? ys[ys.length-1] : 0];
  };
  let e0=at(lo); outP.push(e0[0]); outY.push(e0[1]);
  for(let i=0;i<pts.length;i++) if(arc[i]>lo && arc[i]<hi){ outP.push(pts[i]); outY.push(ys?ys[i]:0); }
  let e1=at(hi); outP.push(e1[0]); outY.push(e1[1]);
  return {pts:outP, ys:ys?outY:null};
}

/* Distinct SIGNABLE routes meeting at a node -- what a walker actually has to choose
   between. Roads are excluded, because a fingerpost is trail signage: a path crossing a
   service road offers no choice, it just crosses, and listing the road turns a crossing
   into a four-armed junction that isn't one. When a node has nothing BUT roads it is a
   road junction on its own terms and the roads are all it can name, so they come back.
   Buried routes count -- following a route down a road is still a choice. */
function signRoutesAt(ni, adj){
  const arms = adj[ni] || [];
  const walk = arms.filter(e => e.kind !== 'road');
  const src = walk.length ? walk : arms;
  const out = [];
  for(const e of src) if(!out.includes(e.route)) out.push(e.route);
  return out;
}

/* How far along this arm before the walker has to choose again.

   Follows one route through the fragments splitT cut it into, hopping node to node for as
   long as (a) the node offers no real choice and (b) exactly one edge carries the same
   route onward. Stops at a fork, at a dead end, and at any ambiguity. Bounded three ways
   -- an edge-visited set, a hop cap, and the single-continuation requirement -- because a
   loop trail closing on itself would otherwise walk forever. */
function armReach(ni, e0, adj){
  let cur=ni, e=e0, acc=0, hops=0;
  const seen=new Set([e0]);
  while(e && hops++ < 500){
    acc += e.lenM;
    const nxt = (e.a===cur) ? e.b : e.a;
    if(signRoutesAt(nxt, adj).length >= 2) return {node:nxt, dist:acc};
    const cont = (adj[nxt]||[]).filter(o => o!==e && o.route===e.route && !seen.has(o));
    if(cont.length !== 1) return {node:nxt, dist:acc};
    seen.add(cont[0]); cur=nxt; e=cont[0];
  }
  return {node:cur, dist:acc};
}

/* World units -> a real-world distance a signpost can print.

   lenM is measured on the COMPACTED network, so at 1:5 a real 500 m trail measures 100
   units. Dividing by the map scale is what makes a signpost state the trail's real
   length, which is the only reading that makes sense on a map advertising real trails. */
function distLabel(u){
  const m = u/Math.max(1e-6, MAP_SCALE);
  return m>=1000 ? (m/1000).toFixed(1)+' km' : Math.round(m)+' m';
}

/* Which arms actually go on the post, out of everything that meets here.

   THREE FILTERS, in order, each removing a specific kind of clutter seen on the default
   map. Roads first: a fingerpost is trail signage, so unless there is nothing but roads
   here, the road arms come off -- that alone is what stops a trail crossing a service
   road being signed as a four-way junction. Then routes: 153 of the 162 junctions had
   arms repeating a label, because a route running straight through contributes two arms,
   so at most two arms survive per route (the two directions) and the shorter is dropped
   when the two lead somewhere similar, which is the difference between "left 900 m,
   right 1.4 km round the loop" and "Juniper Way Loop, twice". Finally rank: a post holds
   five arms and named trails earn the slots before invented spur labels do. */
function pickArms(arms){
  const nonRoad=arms.filter(a=>a.kind!=='road');
  const src=nonRoad.length>=2 ? nonRoad : arms;
  const byRoute=new Map();
  for(const a of src){
    const g=byRoute.get(a.route)||[]; g.push(a); byRoute.set(a.route, g);
  }
  const kept=[];
  for(const g of byRoute.values()){
    g.sort((x,y)=>y.distU-x.distU);
    kept.push(g[0]);
    // a second arm on the same route is worth printing only when it leads somewhere
    // meaningfully different -- otherwise it is the same trail named twice
    if(g[1] && g[1].distU < g[0].distU*0.75) kept.push(g[1]);
  }
  kept.sort((a,b)=> (b.named-a.named) || (b.distU-a.distU));
  const post=kept.slice(0,4);

  /* Last pass, and the one that fixes what the screenshot actually showed.

     Everything above dedupes by ROUTE, which is right -- two unnamed paths meeting here
     are two choices and both belong on the post. But they may still PRINT the same thing,
     because SPUR_NAMES has twelve labels for the map's 91 unnamed ways, and a post
     reading "Juniper Link 19 m" above "Juniper Link 49 m" is worse than useless: it looks
     like one trail contradicting itself. A real name never collides this way (two ways
     called Palmer Trail ARE Palmer Trail, and share a route). So where an invented label
     repeats across different routes on one post, the weaker one drops the pretence and
     says what it is. Honest beats charming on a sign. */
  const seen=new Map();
  for(const a of post){
    const prev=seen.get(a.label);
    if(prev!=null && prev!==a.route && !a.named) a.label='Unmarked path';
    else seen.set(a.label, a.route);
  }
  return post;
}

/* Bumped on every rebuildWorld so cached derived data (minimap.js's relief image, the
   critter roster) can tell "same world, new frame" from "whole world replaced" without
   world.js needing to know those consumers exist. */
let WORLD_REV = 0;
function getWorldRevision(){ return WORLD_REV; }

/* Height something STANDS on: the ground, or the trail tread when inside a trail's
   corridor. Now that the ground under a trail is benched to the ribbon's own graded
   height (terrain.js), the two agree to within the bench's cell-sized staircase and this
   max() only smooths that last fraction of a unit away. It is the
   single answer for the player, the critters and anything world.js plants on a path, so
   they can't drift apart the way the avatar and the ribbons did.

   Off-trail it is plain terrainY: no inflation, no floating near a rise. */
function standingY(x,z){
  const g = terrainY(x,z,VERT_SCALE);
  const nt = nearestTrail(x,z);
  if(nt.y == null || !(nt.d <= nt.hw)) return g;
  // ease over the outer 40 cm of the corridor so stepping onto a trail that sits a hair
  // proud of the dirt isn't a visible pop. Unscaled, like the corridor width it eases
  // across -- both are true metres now.
  const k = clamp((nt.hw - nt.d)/0.4, 0, 1);
  return Math.max(g, g + (nt.y - g)*k);
}

function rebuildWorld(){
  WORLD_REV++;
  if(worldG){ scene.remove(worldG); disposeGroup(worldG); }
  worldG=new THREE.Group(); scene.add(worldG);
  backdropG=null;
  resetSpatialHash();

  const layers=[...(BUNDLE ? (BUNDLE.layers||[]) : []), ...EXTRA];
  MAP_ID = BUNDLE
    ? 'dem:'+(+BUNDLE.originLon).toFixed(4)+','+(+BUNDLE.originLat).toFixed(4)
    : (layers.length ? 'geojson:'+layers.length : 'none');
  if(!layers.length){ applyThemeLighting(); return; }
  // A bundle's own projection is authoritative whenever one is loaded; the fallback only
  // covers the no-DEM case, where there's no heightfield to stay aligned with anyway.
  const PROJ = BUNDLE || fallbackProjector(layers);
  if(!PROJ) return;

  // merge the bundle's own layers with anything dropped in-session, classify each
  // feature, then project every coordinate through the bundle's own projection so
  // vectors and the heightfield are guaranteed aligned
  const rawLines=[], rawPoints=[], rawAreas=[];
  for(const layer of layers){
    const F=parseFeatures(layer);
    rawLines.push(...F.lines); rawPoints.push(...F.points); rawAreas.push(...F.areas);
  }
  const lines=rawLines.map(L=>({name:L.name,kind:L.kind,pts:PROJ.projectCoords(L.pts)}));
  const points=rawPoints.map(P=>({name:P.name,kind:P.kind,props:P.props,p:PROJ.project(P.ll[0],P.ll[1])}));
  // projectCoords() already returns plain [x,z] pairs at every leaf (verified against
  // world_bundle.js: it recurses until coords[0] is a number, then returns [p.x,p.z] --
  // never {x,z} objects). Re-mapping through .x/.z here, as areas previously did, reads
  // undefined off a plain array and collapses every polygon to NaN bounds -- confirmed by
  // running the real pipeline against a synthetic bundle, not assumed.
  const areasProjected=rawAreas.map(A=>({name:A.name,kind:A.kind,props:A.props,
    rings:A.rings.map(r=>PROJ.projectCoords(r))}));

  // *MAP_SCALE: `lines` above are already projected at the current scale, so a FIXED
  // snap/simplify tolerance here would mean a different real-world tolerance at every
  // World scale setting -- 16 world-units is 16 real metres at 1:1, but 512 real metres
  // at 1:32, silently merging trailheads and junctions that are genuinely far apart.
  // Scaling both keeps the topology (what merges into what) a function of real distance,
  // not of how compacted the display happens to be.
  GRAPH=buildGraph(lines,16*MAP_SCALE,6*MAP_SCALE);
  /* Adjacency, built once and used by everything below -- the crossing planner, the
     junction pads, the sign arms and the destination walk all need "what meets here".
     It has to exist BEFORE the geometry passes, not after, because those passes rewrite
     the very points the bench, the spatial hash and the ribbons are all built from: the
     one way to guarantee they agree is that there is only ever one copy of the geometry
     and it is finished being edited before any of them reads it. */
  const adj=GRAPH.nodes.map(()=>[]);
  GRAPH.edges.forEach(e=>{ adj[e.a].push(e); if(e.b!==e.a) adj[e.b].push(e); });
  // decide which paths share another's ground, THEN square the rest up to the kerb --
  // a path that follows a road is a sidewalk, not a crossing, and must not be squared
  PATH_MIX={forks:0, crossings:0, buried:markBuriedEdges(), crossingsBuilt:0, displaced:0};
  PATH_MIX.crossingsBuilt = planCrossings(adj);
  /* Displacement LAST of the three geometry passes, and the order is load-bearing in both
     directions. It must follow markBuriedEdges (a path that shares a road is a marker on
     that road, not a surface to be pushed off it) and planCrossings (which decides where
     approaches meet the kerb, and whose squared-up geometry is what should then be
     cleared). It must precede everything below, for the reason the adjacency comment
     gives: there is one copy of the geometry and it has to be finished being edited
     before the bench, the spatial hash, the ribbons and the minimap all read it. */
  PATH_MIX.displaced = clearOfWiderPaths();
  POIS=points.map(p=>({name:p.name,kind:p.kind,props:p.props,x:p.p.x,z:p.p.z,found:false}));
  AREAS=areasProjected;
  WATER=AREAS.filter(a=>a.kind==='water');

  let mx=1e9,Mx=-1e9,mz=1e9,Mz=-1e9;
  const grow=(x,z)=>{mx=Math.min(mx,x);Mx=Math.max(Mx,x);mz=Math.min(mz,z);Mz=Math.max(Mz,z);};
  GRAPH.edges.forEach(e=>e.pts.forEach(p=>grow(p[0],p[1])));
  POIS.forEach(p=>grow(p.x,p.z));
  AREAS.forEach(a=>a.rings[0].forEach(c=>grow(c[0],c[1])));
  bboxW={minx:mx,maxx:Mx,minz:mz,maxz:Mz};
  const rng=mulberry(1337);

  applyThemeLighting();
  backdropG=buildBackdrop(THEME,rng,MAP_SCALE);
  worldG.add(backdropG);

  setWorld(BUNDLE || null);
  setStep(STEP_M);

  // ground: with a DEM the terrace mesh IS the heightfield, already in real-metre world
  // coordinates. Without one, a single flat plane covering the map's extent -- so a bare
  // pair of .geojson files is still playable, just level.
  const groundMat=new THREE.MeshToonMaterial({map:groundTexture(THEME),
    gradientMap:toonTex, polygonOffset:true, polygonOffsetFactor:2, polygonOffsetUnits:2});
  // buildTerrainMesh now writes UVs straight from world x/z (see its own comment) at a
  // fixed real-world tile size, so the texture is already correctly scaled by
  // construction -- no separate repeat.set() needed, and one WOULD be wrong here: it
  // would multiply UVs that already encode real tiling by a second, unrelated map-size
  // factor, shrinking every tile far below its intended size.
  // Flatten the terrain UNDER each area polygon before building the visible ground mesh
  // from it -- not after. flattenAreaCells mutates the shared band grid (a parking lot
  // or building footprint shouldn't be stair-stepped), and buildTerrainMesh() bakes
  // whatever the grid says into real geometry at the moment it's called. Building the
  // ground first and flattening second meant the ground mesh baked in the OLD (stepped)
  // heights while every area object below (buildArea uses groundYAt, which reads the
  // NOW-flattened grid) was placed using the NEW ones -- typically higher, since
  // flattening claims the tallest band under the footprint the same way trail corridors
  // do. The visible result was exactly what it sounds like: areas of interest hovering
  // above ground that had already been drawn one terrace step below them.
  flattenAreaCells(AREAS, pointInArea, areaBBox);

  /* Trail benches, for the same before-the-mesh reason as the area flatten above, and in
     this order relative to it: an area polygon (a parking lot) is a bigger, flatter claim
     on the terrain than a path crossing it, so it grades first and the trail then follows
     whatever level the lot ended up at.

     One pass, unlike the version this replaces. That one measured, carved, then measured
     again, because carving quantised heights could shift the band under a neighbouring
     switchback. Grading writes a continuous height instead, and gradeProfile pins both
     ends of every edge to raw terrain, so edges meeting at a node already agree without
     needing a second look at the carved grid. */
  /* minStep = 60% of the painted width. Station spacing otherwise follows the DEM cell
     alone, which shrinks with world scale while the tread does not -- at 1:16 the ribbon
     is 12x wider than the gap between its own vertices, so every join disc overlaps a
     dozen neighbours and the trail renders as a scalloped smear. */
  const minStep = e => pathOutlineWidth(e.kind)*0.6;

  /* Two passes, to agree on junction heights.

     Pass one grades every edge on its own. Pass two re-grades with each end pinned to the
     average of what all edges meeting at that node wanted -- so ribbons converging on a
     junction arrive together, and the correction each one carries is a small disagreement
     with its neighbours rather than the large gap between a smoothed profile and the
     quantised ground beneath its endpoint. Pinning to that raw ground was the first
     attempt and it reintroduced terrace cliffs on short connectors, where the whole
     offset has only a station or two to unwind in. */
  GRAPH.edges.forEach(e=>{ e.prof = gradeProfile(e.pts, VERT_SCALE, 0.7, 8, minStep(e)); });
  const nodeH = new Map();
  const wantH = (id, h)=>{ if(id==null) return; const a=nodeH.get(id)||[]; a.push(h); nodeH.set(id,a); };
  GRAPH.edges.forEach(e=>{ wantH(e.a, e.prof.smA); wantH(e.b, e.prof.smB); });
  const agreed = new Map();
  for(const [id, hs] of nodeH) agreed.set(id, hs.reduce((x,y)=>x+y,0)/hs.length);
  GRAPH.edges.forEach(e=>{
    e.prof = gradeProfile(e.pts, VERT_SCALE, 0.7, 8, minStep(e),
                          agreed.has(e.a)?agreed.get(e.a):null,
                          agreed.has(e.b)?agreed.get(e.b):null);
    // half the PAINTED width, not the tread: the bench has to reach at least as far as
    // the ink outline, or the ribbon's edges hang off the corridor onto stepped ground
    e.prof.halfWidth = pathOutlineWidth(e.kind)/2;
  });
  gradeTrailCells(GRAPH.edges.map(e=>e.prof));
  // hash before any geometry: buildArea's ground-cover scatter and buildAreaSign both
  // call nearestTrail, and standingY now needs tread heights too
  GRAPH.edges.forEach(e=>{
    const pr = e.prof, hw = (pathWidth(e.kind)+1.5)/2;
    for(let i=0;i<pr.pts.length-1;i++)
      hashSeg({a:pr.pts[i], b:pr.pts[i+1], edge:e, ya:pr.ys[i], yb:pr.ys[i+1], hw});
  });

  if(BUNDLE){
    const groundMesh = new THREE.Mesh(buildTerrainMesh(VERT_SCALE), groundMat);
    groundMesh.name = 'ground';    // identifies it for tools/smoke.js's height probe
    worldG.add(groundMesh);
  }else{
    const pad=80, gw=(Mx-mx)+pad*2, gh=(Mz-mz)+pad*2;
    const flat=new THREE.Mesh(new THREE.PlaneGeometry(gw,gh), groundMat);
    flat.rotation.x=-Math.PI/2;
    flat.position.set((mx+Mx)/2, 0, (mz+Mz)/2);
    // PlaneGeometry's default UVs are also [0,1] across the whole plane -- same problem,
    // same fix: rewrite them from absolute world x/z at the same tile size as the DEM
    // path, so the flat fallback ground and real terrain always look the same close up.
    // rotation.x=-90deg maps local (x,y,0) -> world (posX+x, posY, posZ-y); local Z is
    // always 0 on a fresh PlaneGeometry, so that's the whole transform that matters here.
    const uv=flat.geometry.attributes.uv, pos=flat.geometry.attributes.position;
    for(let i=0;i<uv.count;i++){
      const wx=flat.position.x+pos.getX(i), wz=flat.position.z-pos.getY(i);
      uv.setXY(i, wx/GROUND_TILE_M, wz/GROUND_TILE_M);
    }
    uv.needsUpdate=true;
    worldG.add(flat);
  }

  const groundYAt=(x,z)=>terrainY(x,z,VERT_SCALE);

  // areas (ground cover) before trails, matching draw order in the original
  AREA_LABELS.length=0;
  AREAS.forEach((a,ai)=>{ try{
    const ag=buildArea(a,rng,groundYAt,nearestTrail,VERT_SCALE); ag.name='area:'+ai; worldG.add(ag);
    ag.traverse(o=>{ if(o.userData && o.userData.areaLabel) AREA_LABELS.push(o); });
  }catch(err){ console.warn('area skipped',a.name,err); } });

  // Path colour/texture follows the source file's own highway/kind tag (pathKind, in
  // geo.js): a footpath stays themed dirt, a service road reads as a distinct paved grey
  // with a dashed centreline, a double-track gets worn wheel ruts instead of one groove.
  const PATH_STYLE={
    trail:{deco:true, tread:THEME.tread, inner:THEME.inner, shoulder:THEME.shoulder},
    track:{deco:true, ruts:true, tread:shade(THEME.tread,0.86), inner:shade(THEME.tread,0.6), shoulder:THEME.shoulder},
    road:{deco:false, dashes:true, tread:'#716d64', inner:'#8a867a', shoulder:'#4a473f'},
  };
  // one ink material per class rank, so the outline of a path sitting on top of another
  // carries the same depth bias as the surface it belongs to
  const inkMats=[0,1,2].map(L=>trailMat(INK,L));
  /* Draw the most-built surface first and the least-built last. Depth bias already
     decides who wins, but painter's order costs nothing and makes the result stable even
     where two surfaces are exactly coplanar and the bias ties. */
  const drawOrder=GRAPH.edges.slice().sort((a,b)=>pathRank(a.kind)-pathRank(b.kind));
  drawOrder.forEach(e=>{
    const st=PATH_STYLE[e.kind]||PATH_STYLE.trail;
    /* Layer widths are MULTIPLES of the tread, not the tread plus a constant. The old
       +2.3 m outline was invisible on a 4.6 m road and overwhelming on a footpath, and it
       is why narrowing the tread alone wouldn't have fixed the pancakes. */
    const W=pathWidth(e.kind);
    const rank=pathRank(e.kind), lift=kindLift(e.kind);
    // e.prof is the graded profile the ground beneath was benched to, shared by every
    // layer below plus the spatial hash. Sharing one profile is load-bearing: when each
    // layer sampled terrain at its own slightly-offset vertex positions they disagreed by
    // a whole terrace at any step and z-fought along the entire trail.
    /* Cut the ribbon back to the kerb at any crossing this edge runs into. The bench,
       the spatial hash and the graph are all untouched -- you still walk straight over --
       but the marked crossing is the only surface drawn on the carriageway. */
    let prof=e.prof;
    if(e.trimA || e.trimB){
      prof = trimProfile(e.prof, e.trimA, e.trimB);
      if(!prof) return;          // the whole edge was crossing; the crosswalk covers it
    }
    const rpts=prof.pts, hs=prof.ys;

    /* Sharing another path's ground: a marker, not a surface. Two thin ribbons -- an ink
       casing and the route's own blaze colour -- laid on top of the host, the way a route
       is waymarked down a road in the real world. Everything else about the edge is
       unchanged: it walks, it routes, it appears on the map and on signs. */
    /* A route that follows a road is now a SIDEWALK: planCrossings has already moved its
       centreline onto the verge, so what gets drawn here is a real (narrow) footway --
       kerb, casing, tread -- rather than the coloured stripe down the carriageway the
       first version painted. Narrower than a trail because a footway beside a road is,
       and because the space between kerb and verge is genuinely tight. */
    if(e.buried){
      const fw=W*0.72, kerb=Math.max(0.22,fw*0.28);
      const sd=e.sidewalk ? e.sidewalk.side : 1;
      // kerb strip on the road side, so the footway has an edge rather than fading into dirt
      const kerbPts=rpts.map((p,i)=>{
        const q=rpts[Math.min(rpts.length-1,i+1)], pr=rpts[Math.max(0,i-1)];
        let dx=q[0]-pr[0], dz=q[1]-pr[1]; const L=Math.hypot(dx,dz)||1;
        return [p[0]+dz/L*sd*(fw*0.5+kerb*0.5), p[1]-dx/L*sd*(fw*0.5+kerb*0.5)];
      });
      worldG.add(new THREE.Mesh(ribbonGeom(kerbPts,kerb,lift+0.03,hs),trailMat('#cdc3ad',rank)));
      worldG.add(new THREE.Mesh(ribbonGeom(rpts,fw*1.35,lift+0.012,hs),inkMats[rank]));
      worldG.add(new THREE.Mesh(ribbonGeom(rpts,fw,lift+0.05,hs),trailMat(st.tread,rank)));
      return;
    }

    worldG.add(new THREE.Mesh(ribbonGeom(rpts,W*OUTLINE_MUL,lift+0.012,hs),inkMats[rank]));
    worldG.add(new THREE.Mesh(ribbonGeom(rpts,W*SHOULDER_MUL,lift+0.02,hs),trailMat(st.shoulder,rank)));
    worldG.add(new THREE.Mesh(ribbonGeom(rpts,W,lift+0.05,hs),trailMat(st.tread,rank)));
    if(st.ruts){
      const rutMat=trailMat(shade(st.tread,0.55),rank);
      [-1,1].forEach(sd=>{
        const off=rpts.map((p,i)=>{
          const q=rpts[Math.min(rpts.length-1,i+1)],pr=rpts[Math.max(0,i-1)];
          let dx=q[0]-pr[0],dz=q[1]-pr[1];const L=Math.hypot(dx,dz)||1;
          return[p[0]-dz/L*W*0.27*sd,p[1]+dx/L*W*0.27*sd];
        });
        worldG.add(new THREE.Mesh(ribbonGeom(off,0.5,lift+0.075,hs),rutMat));
      });
    }else{
      worldG.add(new THREE.Mesh(ribbonGeom(rpts,W*0.44,lift+0.08,hs),trailMat(st.inner,rank)));
    }
    if(st.dashes){
      const dashMat=trailMat('#e8dcae',rank);
      for(let i=1;i<rpts.length;i+=2){
        worldG.add(new THREE.Mesh(ribbonGeom([rpts[i-1],rpts[i]],0.22,lift+0.09,hs?[hs[i-1],hs[i]]:null),dashMat));
      }
    }
  });

  /* Crossings go on AFTER every ribbon, because they are markings painted on a finished
     road: standingY (not terrainY) so the stripes sit on the tread the road actually
     rendered at rather than on the terrace underneath it. */
  CROSSINGS.forEach(rec=>{
    try{ worldG.add(buildCrossing(rec, standingY)); }
    catch(err){ console.warn('crossing skipped', err); }
  });

  AREAS.forEach(a=>{ if(a.name) worldG.add(buildAreaSign(a,groundYAt,nearestTrail)); });

  // junction pads + signs
  // These discs are the ONLY thing that covers the seam where two edges meet: each
  // edge's own ribbon ends in a flat, un-rounded cut (ribbonGeom only rounds interior
  // bends within one edge, not its two endpoints), so without a pad sitting flush on
  // top, every junction -- including a loop trail whose ends snap into one node -- shows
  // a hard edge where the ribbons butt together. That only works if the pad is at the
  /* Junction pads hide the seam where several ribbons converge. Two things about them
     were wrong once trails narrowed from fire-road width to a metre:

     SIZE. The radius was a hardcoded 3.5, chosen to cover the widest ribbon of the old
     set. That is a 7 m brown disc, and the widest ribbon is now 4.5 m. Derived from the
     edges that actually meet here instead.

     COUNT. Every node with degree >= 1 got one, which includes every degree-2 node --
     the plain continuations buildGraph creates wherever two digitised segments join, of
     which a real network has hundreds. Their ribbons already meet flush, so the pad was
     covering a seam that wasn't there. On a compacted map the discs merge into a
     continuous brown field over the whole network. Only real junctions get one now. */
  /* Junction pads, ONE PER SURFACE rather than one per node.

     A pad exists to hide the seam where several ribbons butt together, and a seam belongs
     to a surface. At a node where a footpath crosses a service road there are two seams
     at two different heights, and the old single dirt-coloured disc covered the wrong one
     -- a brown circle stamped on the middle of the tarmac, which is the disc visible in
     the screenshot that started this. Drawing one pad per class present, each at its own
     class lift, in its own tread colour, sized to its own widest ribbon, gets both.

     Buried edges are excluded from the census: they have no ribbon to seam, only a marker
     line, so a node where the only trail arms are buried gets a road pad and nothing
     else -- which is what "the route follows the road through here" should look like. */
  const signWanted=[];      // collected here, thinned and built after the loop (see below)
  GRAPH.nodes.forEach((n,ni)=>{
    if(n.deg<1) return;
    const y=standingY(n.p[0],n.p[1]);
    const here=adj[ni];
    if(n.deg>=3){
      const xing=crossingAt(ni);
      const byKind=new Map();
      for(const e of here){
        if(e.buried) continue;
        /* At a marked crossing the walking surfaces stop at the kerb, so a pad for them
           would be a dirt disc floating in the middle of the road with nothing to join --
           the crosswalk and its two landings are the junction here. The ROAD still gets
           its pad: its own ribbons really do meet at this node. */
        if(xing && e.kind!=='road') continue;
        byKind.set(e.kind, Math.max(byKind.get(e.kind)||0, pathOutlineWidth(e.kind)/2));
      }
      for(const [kind, hw] of byKind){
        const rank=pathRank(kind), lift=kindLift(kind);
        const st=PATH_STYLE[kind]||PATH_STYLE.trail;
        const r=Math.max(hw*1.2,0.4);
        const oDisc=new THREE.Mesh(new THREE.CircleGeometry(r,20),inkMats[rank]);
        oDisc.rotation.x=-Math.PI/2; oDisc.position.set(n.p[0],y+lift+0.045,n.p[1]); worldG.add(oDisc);
        const disc=new THREE.Mesh(new THREE.CircleGeometry(r*0.84,20),trailMat(st.tread,rank));
        disc.rotation.x=-Math.PI/2; disc.position.set(n.p[0],y+lift+0.06,n.p[1]); worldG.add(disc);
      }
    }

    const routes=signRoutesAt(ni,adj);
    const isFork = routes.length>=2;
    if(n.deg>=3){
      if(isFork) PATH_MIX.forks++;
      else if(n.kinds && n.kinds.length>1) PATH_MIX.crossings++;
    }

    const out=[];
    for(const e of here){
      if(e.a===ni) out.push({e,pts:e.pts});
      if(e.b===ni&&e.a!==e.b) out.push({e,pts:[...e.pts].reverse()});
    }
    const armOf=o=>{
      let ax=0,az=0,acc=0,i=1;
      while(i<o.pts.length&&acc<6){ax=o.pts[i][0]-n.p[0];az=o.pts[i][1]-n.p[1];acc=Math.hypot(ax,az);i++;}
      /* Distance is now to the NEXT DECISION, not the length of this one graph edge.
         splitT cuts every line wherever anything touches it, so an edge is a fragment
         between two cuts -- on the default map the median fragment is 76 m and the tenth
         percentile is 24 m. Printing that raw is what put "Juniper Way Loop 19 m" on a
         signpost: not a wrong number, but an answer to a question nobody asked. armReach
         walks the fragments of one route together until the walker actually has to choose
         again, which is the distance a fingerpost is for. */
      const reach=armReach(ni,o.e,adj);
      return{label:o.e.name, route:o.e.route, kind:o.e.kind, named:!!o.e.named,
             distU:reach.dist, dist:distLabel(reach.dist), angle:Math.atan2(az,ax)};
    };
    /* WHERE THE POST GOES, worked out once for both kinds of sign.

       A fingerpost belongs on the verge, not in the road. At a crossing there is a right
       answer -- the landing beside the markings -- and everywhere else there is a catch
       all: shove it clear of any carriageway it happens to be standing in. Applied to
       trailhead posts too, which is the bit that was missed first time round: a trailhead
       at a roadside car park is exactly the sign most likely to be planted in tarmac, and
       four of them were. */
    let sx=n.p[0], sz=n.p[1];
    const xing=crossingAt(ni);
    if(xing){
      const nxr=-xing.dir[1], nzr=xing.dir[0];
      const off=xing.trim + xing.walkW*0.5;
      sx=n.p[0]+nxr*off; sz=n.p[1]+nzr*off;
    }
    const clearPt=pushOffRoad(sx, sz, 0.8);
    sx=clearPt[0]; sz=clearPt[1];
    const sy=standingY(sx, sz);

    if(n.deg>=3 && isFork){
      signWanted.push({n, y:sy, sx, sz, arms:pickArms(out.map(armOf)), deg:n.deg, routes:routes.length});
    }else if(n.deg===1&&out.length){
      signWanted.push({n, y:sy, sx, sz, arms:[armOf(out[0])], deg:1, routes:1});
    }
  });

  /* Thin the signposts before building any of them.

     Every junction wanting its own sign is right on a sparse network and absurd on a real
     one: the default map has 162 junctions, many of them metres apart where a single
     trail is cut repeatedly by side spurs, so a walker arrives at a thicket of identical
     posts all naming the same two trails. (Connecting trails properly -- see geo.js's
     splitT -- roughly doubled the junction count, which made this worse, not better: the
     topology is now correct and the signage has to catch up with it.)

     Greedy spatial thinning, best-first. "Best" is the sign that tells you the most:
     the number of DISTINCT trail names it can point at, then the junction's degree, then
     total trail length through it -- so where a cluster gets one sign, it is the one at
     the genuinely informative fork rather than whichever node happened to be first in
     the array. A kept sign then suppresses every candidate inside its radius.

     Two radii, and the larger wins. SIGN_MIN_M is a real-world distance, so at true scale
     signs are a sensible walk apart; SIGN_MIN_U is a floor in world units, because sign
     posts are true-metre objects whose size does NOT shrink with world scale (the same
     rule as the pup and the trees), so at heavy compaction a purely real-world spacing
     would still let them overlap physically.

     Dead ends are exempt from being suppressed BY the radius only when they are
     trailheads -- the "you are here" post at the map's entrances is the one sign nobody
     wants deduplicated away. */
  {
    const SIGN_MIN_M = 70, SIGN_MIN_U = 9;
    const minGap = Math.max(SIGN_MIN_M*MAP_SCALE, SIGN_MIN_U);
    const isHead = (n)=>TRAILHEADS.some(h=>Math.hypot(h.x-n.p[0], h.z-n.p[1]) < 0.5);
    /* Ranked by ROUTE count, not label count: two unnamed paths sharing a SPUR_NAMES
       label are two choices, and a route running straight through and appearing twice is
       one. Counting labels got both backwards. */
    const score = s => {
      const routes = new Set(s.arms.map(a=>a.route||a.label)).size;
      return routes*1000 + s.deg*10 + Math.min(9, s.arms.length);
    };
    const ranked = signWanted.map(s=>({s, head:isHead(s.n), sc:score(s)}))
      // trailheads first, then the most informative junctions
      .sort((a,b)=> (b.head-a.head) || (b.sc-a.sc));
    const kept=[];
    for(const c of ranked){
      const p=c.s.n.p;
      // a trailhead post is always placed; everything else must clear the kept ones
      if(!c.head && kept.some(k=>Math.hypot(k.s.n.p[0]-p[0], k.s.n.p[1]-p[1]) < minGap)) continue;

      kept.push(c);
    }
    kept.forEach(c=>{
      /* buildSign positions itself from the node it is handed, so a post that has been
         moved off the carriageway is given a stand-in carrying the moved point. The real
         node is left alone -- it is the graph's, and the arm ANGLES were measured from it. */
      const at = (c.s.sx==null || (c.s.sx===c.s.n.p[0] && c.s.sz===c.s.n.p[1]))
        ? c.s.n : {p:[c.s.sx, c.s.sz], deg:c.s.n.deg};
      const sg=buildSign(at, c.s.arms); sg.position.y=c.s.y; worldG.add(sg);
    });
    SIGN_COUNT = {wanted:signWanted.length, built:kept.length, minGap};
  }

  // decorative edge stones + blaze posts
  const stoneMat=toon(THEME.rocks[0]);
  GRAPH.edges.forEach(e=>{
    const st=PATH_STYLE[e.kind]||PATH_STYLE.trail;
    if(!st.deco) return;
    // A route sharing a road's ground has no verge to line with stones and no post to
    // plant a blaze beside -- it is paint on tarmac. Its marker line carries the colour.
    if(e.buried) return;
    /* PATH_STYLE has never had a `w` key. `st.w` was therefore undefined, every offset
       below evaluated to NaN, and every edge stone and blaze post on the map has been
       placed at NaN -- silently, because three.js neither throws nor draws. The width
       these want is the tread's, which pathWidth() already owns. */
    const halfW=pathWidth(e.kind)/2, lift=kindLift(e.kind);
    let acc=0,blazeAcc=999;
    for(let i=1;i<e.pts.length;i++){
      const a=e.pts[i-1],b=e.pts[i];
      const L=Math.hypot(b[0]-a[0],b[1]-a[1]);
      acc+=L; blazeAcc+=L;
      if(acc>9){
        acc=0;
        const sx=(a[0]+b[0])/2, sz=(a[1]+b[1])/2;
        const nx=-(b[1]-a[1])/L, nz=(b[0]-a[0])/L, sy=terrainY(sx,sz,VERT_SCALE);
        for(const sd of[-1,1]){
          if(rng()<0.45) continue;
          const s=new THREE.Mesh(new THREE.DodecahedronGeometry(0.16+rng()*0.2,0),stoneMat);
          const off=halfW+0.25+rng()*0.4;
          s.position.set(sx+nx*sd*off,sy+lift+0.08,sz+nz*sd*off);
          s.scale.y=0.6; worldG.add(s);
        }
      }
      if(blazeAcc>42){
        blazeAcc=0;
        const nx=-(b[1]-a[1])/L, nz=(b[0]-a[0])/L;
        const bo=halfW+0.45;
        const bx=a[0]+nx*bo, bz=a[1]+nz*bo;
        const bz3=buildBlaze(bx,bz,e.color); bz3.position.y=terrainY(bx,bz,VERT_SCALE); worldG.add(bz3);
      }
    }
  });

  // POIs
  POIS.forEach(p=>{
    const grp=buildPOI(p,rng);
    grp.position.set(p.x,terrainY(p.x,p.z,VERT_SCALE),p.z);
    grp.rotation.y=rng()*6.28;
    worldG.add(grp);
  });

  // scenery
  const clearOfPOI=(x,z,r)=>!POIS.some(p=>Math.hypot(p.x-x,p.z-z)<r);
  const inWater=(x,z)=>WATER.some(a=>pointInArea(x,z,a));
  const offTrail=(x,z,r)=>nearestTrail(x,z).d>r&&clearOfPOI(x,z,7)&&!inWater(x,z);
  const pad=70, W=Mx-mx+pad*2, H=Mz-mz+pad*2;
  let placed=0,tries=0;
  const targetTrees=Math.min(560,W*H/450*THEME.treeDensity);
  while(placed<targetTrees&&tries++<targetTrees*7){
    const x=mx-pad+rng()*W, z=mz-pad+rng()*H;
    if(!offTrail(x,z,4.2)) continue;
    const t=makeTree((1.1+rng()*1.6)*THEME.treeScale,pickTree(rng),rng);
    t.position.set(x,terrainY(x,z,VERT_SCALE),z); t.rotation.y=rng()*7;
    worldG.add(t); placed++;
  }
  placed=0; tries=0;
  const targetRocks=Math.round(60*THEME.rockDensity);
  while(placed<targetRocks&&tries++<targetRocks*10){
    const x=mx-pad+rng()*W, z=mz-pad+rng()*H;
    if(!offTrail(x,z,THEME.rockStyle==='fin'?9:3.2)) continue;
    const r=makeRock(0.5+rng()*1.2,rng);
    r.position.set(x,terrainY(x,z,VERT_SCALE),z);
    worldG.add(r); placed++;
  }
  placed=0; tries=0;
  const tuftMat=toon(THEME.tuft);
  while(placed<THEME.tuftCount&&tries++<THEME.tuftCount*6){
    const x=mx+rng()*(Mx-mx), z=mz+rng()*(Mz-mz);
    const nd=nearestTrail(x,z).d;
    if(nd<2.4||nd>10) continue;
    const tuft=new THREE.Mesh(new THREE.ConeGeometry(0.16,0.5,5),tuftMat);
    tuft.position.set(x,terrainY(x,z,VERT_SCALE)+0.22,z);
    worldG.add(tuft); placed++;
  }

  buildTrailheads();
  TRAILHEADS.forEach((th,i)=>{
    const gt=buildGate(th,i);
    // same reasoning as the junction pads above: a trailhead sits at the end of a
    // ribbon, so it needs the ribbon's own (corridor-max) height, not the raw cell.
    gt.position.y=standingY(th.x,th.z);
    worldG.add(gt);
  });
}

function mulberry(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);
  t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}

function getBackdrop(){ return backdropG; }

export { loadWorld, rebuildWorld, addLayers, clearLayers, hasBundle, setContourStep,
         standingY, getWorldRevision, pathWidth, getContourStep, getSignCount, getPathMix, getMapId, getCrossings,
         pathRank, kindLift, pathOutlineWidth,
         getAreaLabels, updateAreaLabels,
         setThemeById, getTheme, setMapScale, getMapScale, getExaggeration, getBackdrop,
         setFogMultiplier, getFogMultiplier,
         getGraph, getTrailheads, getPOIs, getAreas, getBBox,
         getWorldGroup, setStartHead, getStartHead, setVertScale, getVertScale, compass, THEMES, THEME };
