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
import { parseFeatures, buildGraph } from './geo.js';
import { pointInArea, areaBBox } from './geom2d.js';
import { resetSpatialHash, hashSeg, nearestTrail } from './spatial.js';
import { THEME, THEMES, setTheme } from './themes.js';
import { ribbonGeom, trailMat, INK, buildSign, buildBlaze, buildGate, makeTree, makeRock,
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
  const mOutline=trailMat(INK);
  GRAPH.edges.forEach(e=>{
    const st=PATH_STYLE[e.kind]||PATH_STYLE.trail;
    /* Layer widths are MULTIPLES of the tread, not the tread plus a constant. The old
       +2.3 m outline was invisible on a 4.6 m road and overwhelming on a footpath, and it
       is why narrowing the tread alone wouldn't have fixed the pancakes. */
    const W=pathWidth(e.kind);
    // e.prof is the graded profile the ground beneath was benched to, shared by every
    // layer below plus the spatial hash. Sharing one profile is load-bearing: when each
    // layer sampled terrain at its own slightly-offset vertex positions they disagreed by
    // a whole terrace at any step and z-fought along the entire trail.
    const rpts=e.prof.pts, hs=e.prof.ys;
    worldG.add(new THREE.Mesh(ribbonGeom(rpts,W*OUTLINE_MUL,0.012,hs),mOutline));
    worldG.add(new THREE.Mesh(ribbonGeom(rpts,W*SHOULDER_MUL,0.02,hs),trailMat(st.shoulder)));
    worldG.add(new THREE.Mesh(ribbonGeom(rpts,W,0.05,hs),trailMat(st.tread)));
    if(st.ruts){
      const rutMat=trailMat(shade(st.tread,0.55));
      [-1,1].forEach(sd=>{
        const off=rpts.map((p,i)=>{
          const q=rpts[Math.min(rpts.length-1,i+1)],pr=rpts[Math.max(0,i-1)];
          let dx=q[0]-pr[0],dz=q[1]-pr[1];const L=Math.hypot(dx,dz)||1;
          return[p[0]-dz/L*W*0.27*sd,p[1]+dx/L*W*0.27*sd];
        });
        worldG.add(new THREE.Mesh(ribbonGeom(off,0.5,0.075,hs),rutMat));
      });
    }else{
      worldG.add(new THREE.Mesh(ribbonGeom(rpts,W*0.44,0.08,hs),trailMat(st.inner)));
    }
    if(st.dashes){
      const dashMat=trailMat('#e8dcae');
      for(let i=1;i<rpts.length;i+=2){
        worldG.add(new THREE.Mesh(ribbonGeom([rpts[i-1],rpts[i]],0.22,0.09,hs?[hs[i-1],hs[i]]:null),dashMat));
      }
    }
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
  const signWanted=[];      // collected here, thinned and built after the loop (see below)
  GRAPH.nodes.forEach((n,ni)=>{
    if(n.deg<1) return;
    const y=standingY(n.p[0],n.p[1]);
    if(n.deg>=3){
      let hw=0;
      GRAPH.edges.forEach(e=>{ if(e.a===ni||e.b===ni) hw=Math.max(hw,pathOutlineWidth(e.kind)/2); });
      const r=Math.max(hw*1.2,0.4);
      const oDisc=new THREE.Mesh(new THREE.CircleGeometry(r,20),mOutline);
      oDisc.rotation.x=-Math.PI/2; oDisc.position.set(n.p[0],y+0.045,n.p[1]); worldG.add(oDisc);
      const disc=new THREE.Mesh(new THREE.CircleGeometry(r*0.84,20),trailMat(THEME.tread));
      disc.rotation.x=-Math.PI/2; disc.position.set(n.p[0],y+0.06,n.p[1]); worldG.add(disc);
    }
    const out=[];
    GRAPH.edges.forEach(e=>{
      if(e.a===ni) out.push({e,pts:e.pts});
      if(e.b===ni&&e.a!==e.b) out.push({e,pts:[...e.pts].reverse()});
    });
    const armOf=o=>{
      let ax=0,az=0,acc=0,i=1;
      while(i<o.pts.length&&acc<6){ax=o.pts[i][0]-n.p[0];az=o.pts[i][1]-n.p[1];acc=Math.hypot(ax,az);i++;}
      /* lenM is measured on the COMPACTED network, so it is world units, not metres --
         at 1:5 a real 500 m trail measures 100. Signposts were printing that raw as
         "100 m". Divide by the map scale so a signpost states the trail's real length,
         which is the only reading that makes sense on a map advertising real trails. */
      return{label:o.e.name,dist:Math.round(o.e.lenM/Math.max(1e-6,MAP_SCALE))+' m',angle:Math.atan2(az,ax)};
    };
    if(n.deg>=3){
      const arms=[],seen=new Set();
      out.forEach(o=>{const a=armOf(o);const k=a.label+'|'+Math.round(a.angle*4);
        if(seen.has(k))return;seen.add(k);arms.push(a);});
      signWanted.push({n, y, arms, deg:n.deg});
    }else if(n.deg===1&&out.length){
      signWanted.push({n, y, arms:[armOf(out[0])], deg:1});
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
    const score = s => {
      const names = new Set(s.arms.map(a=>a.label)).size;
      return names*1000 + s.deg*10 + Math.min(9, s.arms.length);
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
    kept.forEach(c=>{ const sg=buildSign(c.s.n, c.s.arms); sg.position.y=c.s.y; worldG.add(sg); });
    SIGN_COUNT = {wanted:signWanted.length, built:kept.length, minGap};
  }

  // decorative edge stones + blaze posts
  const stoneMat=toon(THEME.rocks[0]);
  GRAPH.edges.forEach(e=>{
    const st=PATH_STYLE[e.kind]||PATH_STYLE.trail;
    if(!st.deco) return;
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
          s.position.set(sx+nx*sd*(st.w*0.62+rng()*0.4),sy+0.08,sz+nz*sd*(st.w*0.62+rng()*0.4));
          s.scale.y=0.6; worldG.add(s);
        }
      }
      if(blazeAcc>42){
        blazeAcc=0;
        const nx=-(b[1]-a[1])/L, nz=(b[0]-a[0])/L;
        const bx=a[0]+nx*(st.w*0.85), bz=a[1]+nz*(st.w*0.85);
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
         standingY, getWorldRevision, pathWidth, getContourStep, getSignCount,
         getAreaLabels, updateAreaLabels,
         setThemeById, getTheme, setMapScale, getMapScale, getExaggeration, getBackdrop,
         setFogMultiplier, getFogMultiplier,
         getGraph, getTrailheads, getPOIs, getAreas, getBBox,
         getWorldGroup, setStartHead, getStartHead, setVertScale, getVertScale, compass, THEMES, THEME };
