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
import { QUALITY } from '../core/quality.js';
import { areaCells, stepChannelBanks, buildTerrainMesh, flattenAreaCells, gradeProfile, setCellsHeightM, gradeTrailCells, GROUND_TILE_M, groundTexture, reliefCanvas, resample, setStep, setWorld, terrainY } from './terrain.js';

import { scene, camera, disposeGroup, sun, hemi } from '../core/render.js';
import { toon, toonTex } from '../core/materials.js';
import { loadWorldBundle, fetchWorldBundle } from '../data/world_bundle.js';
import { parseFeatures, buildGraph, ptSeg, segCross, inRect, clipLineToRect, clipRingToRect } from './geo.js';
import { pointInArea, areaBBox } from './geom2d.js';
import { resetSpatialHash, hashSeg, nearestTrail } from './spatial.js';
import { THEME, THEMES, setTheme } from './themes.js';
/* One-way: sky.js knows about the renderer's lights and the theme palette, and nothing
   about maps, graphs or bundles. That is what lets this file call into it from
   applyThemeLighting without a cycle -- the chain is themes -> sky -> world -> main. */
import { refreshSky, setSkyBackdrop, setSkyPlace } from './sky.js';
import { patchGroundRing } from './noise-ring.js';
import { patchGroundCover, setGroundCover, groundCoverAt } from './ground-cover.js';
import { ribbonGeom, junctionGapGeom, waterSideGeom, trailMat, INK, buildSign, buildBlaze, buildCrossing, buildGate, makeTree, makeRock,
         pickTree, buildPOI, buildArea, buildAreaSign, POI_STYLE, AREA_STYLE, shade,
         buildBackdrop, backdropRadius, embankmentGeom, bridgeDeckGeom, bridgeFrameGeom,
         deckMat, frameMat, railTrackGeoms, PYLON, pylonWirePoints } from './pieces.js';

let GRAPH=null, TRAILHEADS=[], POIS=[], AREAS=[], WATER=[];
/* Points that are built but are not landmarks (pieces.js POI_STYLE `fixture`): pylons,
   gates, crossing signs. Kept apart from POIS so discovery, the minimap and the landmark
   count never see them. RAIL_STATS is what the last build did with the railway, for the
   smoke harness and for anyone asking why a line has a rack rail. */
let FIXTURES=[], POWER_SPANS=[], TREE_SPOT=null;
let RAIL_STATS={edges:0, km:0, rackEdges:0, tieGap:0, ties:0};
/* Every floating area name currently in the scene. Collected at build time so the
   per-frame size cap does not have to walk the whole graph looking for sprites.
   Cleared IN PLACE on rebuild -- see the module header on shared mutable arrays. */
const AREA_LABELS=[];
/* Areas you cannot walk through: the extruded rock masses and building footprints.
   AREA_STYLE.solid is the single source of truth for which kinds those are (pieces.js),
   because the fact "this polygon has real height" is the same fact that decides both how
   it is drawn and whether it stops you.

   Cleared IN PLACE like every other shared array here -- main.js holds this same
   reference through areaBlocked, and reassigning it on a rebuild would leave the player
   walking through rocks that are visibly there.

   Each entry caches its own bbox. areaBlocked runs up to three times per frame from
   moveOffTrail and ~24k times in one smoke assertion, and a bbox reject turns almost
   every test into two comparisons instead of a ring walk. */
const AREA_SOLIDS=[];
function getAreaSolids(){ return AREA_SOLIDS; }

/* Distance from a point to a polygon's boundary, ignoring which side it is on. Used to
   give the player a BODY rather than a pen-point: standing 20 cm from a rock wall should
   already be a collision, or the avatar visibly overlaps the mass it is standing against. */
function distToRings(x,z,rings){
  let best=Infinity;
  for(const ring of rings){
    for(let i=0,j=ring.length-1;i<ring.length;j=i++){
      const ax=ring[j][0],az=ring[j][1],bx=ring[i][0],bz=ring[i][1];
      const vx=bx-ax,vz=bz-az;
      const L2=vx*vx+vz*vz;
      let t=L2>0 ? ((x-ax)*vx+(z-az)*vz)/L2 : 0;
      t=t<0?0:(t>1?1:t);
      const d=Math.hypot(x-(ax+vx*t), z-(az+vz*t));
      if(d<best) best=d;
    }
  }
  return best;
}

/* The top of whatever solid thing stands at (x,z), or null for open ground.

   THIS REPLACES A HARD COLLIDER, and the change is the whole fix for getting stuck inside
   a rock. The first version answered a boolean -- "is this blocked" -- which makes a rock
   mass a wall of infinite height with no inside and no top. Anything that ended up within
   the footprint (walking the trail that runs through Kissing Camels, then stepping off it)
   found every direction refused and was trapped, and there was no way to be on top of a
   thing whose only property was that you could not be in it.

   Answering with a HEIGHT instead makes a solid area a piece of terrain: the ground at
   that point is simply higher. Everything else then falls out of rules that already exist
   in main.js and needed no new concepts at all -- the step-up limit makes a tall face a
   wall, being airborne above the top lets you land on it, walking off the edge is a fall
   because absolute height is preserved, and anything that finds itself inside is standing
   on top rather than trapped, because the ground beneath it is the top.

   NO LONGER YIELDS TO THE TREAD, and that reversal is deliberate. The exemption existed so
   a collider could not fence off a route -- about 5 m of trail runs through the Kissing
   Camels polygon on the default map. But it meant that along those 5 m the rock was simply
   not there, so the pup walked into the middle of a formation and vanished: measured, 1.66
   units deep, rendered 7 units below the top of the mass it was standing inside.

   Worse, it fought solidEmbed. Movement carried the pup in because the ground had not
   risen; the embed check shoved it back out; the next frame carried it in again. That
   oscillation at the boundary is the "stuck at the edge of the formation" the player feels.

   A rock is now solid everywhere, tread or no tread. The cost is that a handful of metres
   of trail become impassable where the map data runs a path through a rock mass -- a
   conflict in the source polygons rather than a routing decision this code should be
   papering over, and a far smaller problem than walking through a mountain. */
function areaSolidTop(x,z){
  if(!AREA_SOLIDS.length) return null;
  let top=null;
  for(const s of AREA_SOLIDS){
    if(s.top==null) continue;
    const bb=s.bb;
    const inf=s.inflate||0;
    if(x<bb.mnx-inf||x>bb.mxx+inf||z<bb.mnz-inf||z>bb.mxz+inf) continue;
    // the bevelled skirt is part of the rock even though it lies outside the polygon
    if(!pointInArea(x,z,s.area) && !(inf>0 && distToRings(x,z,s.area.rings)<=inf)) continue;
    if(top===null||s.top>top) top=s.top;
  }
  return top;
}

/* Can you see from (ax,az) to (bx,bz)? Eye heights are above the surface at each end.

   Terrain AND solid areas, because both are things you can be behind: a hill brow and a
   rock formation occlude identically from the player's side of the screen, and a sightline
   that only knew about one of them would let you bank a sighting through a boulder.

   Walks the straight line between the two points and asks, at each sample, whether the
   ground there rises above the line of sight. That is the same test camera.js already runs
   to keep the brow of a hill out of the way of the avatar, which is where the sampling
   density comes from -- a metre or so, fine enough to catch a terrace riser and coarse
   enough to run for every animal every frame.

   The near end is skipped: the surface directly under the viewer is by definition at eye
   level minus eye height, and sampling it would make everything blind. */
function lineOfSight(ax, az, bx, bz, eyeA, eyeB){
  const dx=bx-ax, dz=bz-az;
  const L=Math.hypot(dx,dz);
  if(L<0.5) return true;
  const y0=surfaceHeight(ax,az)+(eyeA==null?1.4:eyeA);
  const y1=surfaceHeight(bx,bz)+(eyeB==null?0.8:eyeB);
  const steps=clamp(Math.ceil(L/1.2), 2, 90);
  for(let i=1;i<steps;i++){
    const t=i/steps;
    const x=ax+dx*t, z=az+dz*t;
    // a little slack, so a terrace riser exactly level with the sightline is not a wall
    if(surfaceHeight(x,z) > y0+(y1-y0)*t + 0.25) return false;
  }
  return true;
}
/* Terrain, or the top of a solid standing on it -- the surface a sightline can be stopped
   by. Deliberately NOT the player's ground function: this asks what is in the way, which
   includes solids the player could never stand on because they are too tall to climb. */
function surfaceHeight(x,z){
  const g=standingY(x,z);
  const top=areaSolidTop(x,z);
  return (top!=null && top>g) ? top : g;
}

/* The nearest climbable FACE to (x,z): the closest point on a solid's outline, the
   outward normal there, and how high that solid stands.

   Exists because a climb has to happen on the OUTSIDE. The first version moved the player
   to the interior destination and raised them from there, so the pup spent the whole ascent
   embedded in the rock with its tail poking out of the face -- correct height, wrong side
   of the wall. Hanging on a face needs the face itself: a point on the boundary and the
   direction "away from the rock", which a boolean or a height query cannot give.

   `within` bounds the search so this stays cheap; it runs every frame while a climb is
   live and once per frame while one is possible.

   Unlike areaSolidTop this does NOT exempt trail corridors. The tread-wins rule exists so
   a collider cannot fence off a route; it has nothing to say about whether you may put
   your paws on a rock that happens to stand next to a path. Exempting corridors here just
   made the faces beside a trail unclimbable, which is most of the faces a player ever
   walks up to. */
function nearestSolidFace(x,z,within){
  const R=within||3;
  let best=null;
  for(const s of AREA_SOLIDS){
    if(s.top==null) continue;
    const bb=s.bb;
    if(x<bb.mnx-R||x>bb.mxx+R||z<bb.mnz-R||z>bb.mxz+R) continue;
    for(const ring of s.area.rings){
      for(let i=0,j=ring.length-1;i<ring.length;j=i++){
        const ax=ring[j][0],az=ring[j][1],bx=ring[i][0],bz=ring[i][1];
        const vx=bx-ax,vz=bz-az;
        const L2=vx*vx+vz*vz;
        let t=L2>0 ? ((x-ax)*vx+(z-az)*vz)/L2 : 0;
        t=t<0?0:(t>1?1:t);
        const px=ax+vx*t, pz=az+vz*t;
        const d=Math.hypot(x-px,z-pz);
        if(d>R || (best && d>=best.d)) continue;
        best={d, x:px, z:pz, top:s.top, area:s.area, kind:s.kind, inflate:s.inflate||0};
      }
    }
  }
  if(!best) return null;
  /* Outward normal. Taken by stepping off the boundary point and asking which side is
     inside, rather than from the edge's winding -- rings arrive from GeoJSON with no
     guaranteed orientation, and a normal that points the wrong way puts the climber
     INSIDE the thing it is meant to be hanging off. */
  let ox=x-best.x, oz=z-best.z;
  const oL=Math.hypot(ox,oz);
  if(oL>1e-4){ ox/=oL; oz/=oL; }
  else {
    // standing exactly on the outline: probe outward along each axis for open ground
    ox=1; oz=0;
    for(const [tx,tz] of [[1,0],[-1,0],[0,1],[0,-1]]){
      if(!pointInArea(best.x+tx*0.4, best.z+tz*0.4, best.area)){ ox=tx; oz=tz; break; }
    }
  }
  if(pointInArea(best.x+ox*0.4, best.z+oz*0.4, best.area)){ ox=-ox; oz=-oz; }
  best.ox=ox; best.oz=oz;
  /* Move the reported face out onto the DRAWN surface. Callers stand the pup a fixed
     standoff off this point, and measuring that standoff from the bare polygon put it
     inside the bevelled skirt -- which is exactly how the pup ended up sunk into the rock
     it was clinging to. `d` is corrected too so proximity tests stay honest. */
  if(best.inflate>0){
    best.x+=ox*best.inflate; best.z+=oz*best.inflate;
    best.d=Math.max(0, best.d-best.inflate);
  }
  return best;
}

/* Distance from a point to ONE named solid's outline, and whether the point is inside it.
   Deliberately not "the nearest solid": the whole difficulty in deciding whether a pup is
   walking into a rock is that near a corner the nearest FACE and the face you are aimed at
   are different, so any comparison has to be against a fixed subject. */
function distToSolid(x,z,area){
  return {d: distToRings(x,z,area.rings), inside: pointInArea(x,z,area)};
}

/* If (x,z,y) is INSIDE a solid and below its top, the shortest push that gets it out.
   Returns null when there is nothing to fix, which is almost every call.

   THE LAST LINE OF DEFENCE, and it exists because "how did the player get in there" turned
   out to have more answers than the movement rules could enumerate. areaSolidTop exempts
   trail corridors so a collider cannot fence off a route -- and about 5 m of trail on the
   default map runs straight through the Kissing Camels polygon, so walking that trail
   carried the pup into the middle of the rock at tread level with only its paws showing
   through the face. Blocking every way in is whack-a-mole; asserting the invariant
   directly is not. Wherever you came from, you do not get to be inside the rock.

   Deliberately ignores corridors. The tread wins for BLOCKING, which is about not severing
   routes; it does not get to win for being inside a mountain, which is not a route
   question at all. */
function solidEmbed(x,z,y){
  for(const s of AREA_SOLIDS){
    if(s.top==null || y >= s.top-0.3) continue;
    const bb=s.bb;
    const inf=s.inflate||0;
    if(x<bb.mnx-inf||x>bb.mxx+inf||z<bb.mnz-inf||z>bb.mxz+inf) continue;
    const insidePoly=pointInArea(x,z,s.area);
    if(!insidePoly && !(inf>0 && distToRings(x,z,s.area.rings)<=inf)) continue;
    // nearest point on the outline is the shortest way out
    let best=null;
    for(const ring of s.area.rings){
      for(let i=0,j=ring.length-1;i<ring.length;j=i++){
        const ax=ring[j][0],az=ring[j][1],bx=ring[i][0],bz=ring[i][1];
        const vx=bx-ax,vz=bz-az;
        const L2=vx*vx+vz*vz;
        let t=L2>0 ? ((x-ax)*vx+(z-az)*vz)/L2 : 0;
        t=t<0?0:(t>1?1:t);
        const px=ax+vx*t, pz=az+vz*t;
        const d=Math.hypot(x-px,z-pz);
        if(!best||d<best.d) best={d,px,pz};
      }
    }
    if(!best) continue;
    let ox=x-best.px, oz=z-best.pz;
    const L=Math.hypot(ox,oz);
    if(L>1e-4){ ox/=L; oz/=L; }
    else{
      // dead on the outline: pick whichever axis leads to open ground
      ox=1; oz=0;
      for(const [tx,tz] of [[1,0],[-1,0],[0,1],[0,-1]]){
        if(!pointInArea(best.px+tx*0.5, best.pz+tz*0.5, s.area)){ ox=tx; oz=tz; break; }
      }
    }
    // outward, not inward -- the vector above points from the wall toward the player,
    // who is inside, so it needs flipping before it is a way out
    if(pointInArea(best.px+ox*0.5, best.pz+oz*0.5, s.area)){ ox=-ox; oz=-oz; }
    // clear of the DRAWN surface, not just the polygon: the skirt is solid too
    return {x:best.px+ox*((s.inflate||0)+0.6), z:best.pz+oz*((s.inflate||0)+0.6), top:s.top};
  }
  return null;
}

/* Is (x,z) inside -- or within `rad` of -- something solid? Kept because it answers a
   question areaSolidTop cannot: "am I touching this at all", regardless of height. Used by
   the smoke suite to assert the footprints are where they should be, and available to any
   caller that wants presence rather than a surface. Movement does NOT use it -- see
   areaSolidTop for why a boolean was the wrong shape for that job. */
function areaBlocked(x,z,rad){
  const r=rad||0;
  for(const s of AREA_SOLIDS){
    const bb=s.bb;
    if(x<bb.mnx-r||x>bb.mxx+r||z<bb.mnz-r||z>bb.mxz+r) continue;
    if(pointInArea(x,z,s.area)) return true;
    if(r>0 && distToRings(x,z,s.area.rings)<r) return true;
  }
  return false;
}
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
    /* zSign and unproject exist only to match World's shape, so whoever needs to turn
       world metres back into lon/lat -- the time-zone lookup for the sky clock, today --
       can do it without asking which projector it got. Same contract, same sign
       convention: +z south, hence zSign 1. */
    zSign:1,
    project(lon,lat){ return {x:(lon-originLon)*mLon, z:(originLat-lat)*mLat}; },
    unproject(x,z){ return {lon:originLon+x/mLon, lat:originLat-z/mLat}; },
    projectCoords(coords){
      if(typeof coords[0]==='number'){ const p=proj.project(coords[0],coords[1]); return [p.x,p.z]; }
      return coords.map(c=>proj.projectCoords(c));
    },
  };
  return proj;
}
let worldG=null;               // THREE.Group holding everything rebuildWorld() creates
let BUNDLE=null;                // the loaded World instance
/* What the last rebuild cut away at the DEM edge -- features clipped or dropped, per layer
   kind. Read by the smoke harness (getCropStats); zeros on a map that fits its DEM. */
let CROP={lines:0, points:0, areas:0, waterways:0};
/* The heightfield's own rectangle in projected world units, the exact region terrain.js
   answers from real cells rather than a clamped edge (World.contains). */
function demRect(W){
  return {x0:W.originX, z0:W.originZ, x1:W.originX+W.width*W.cell, z1:W.originZ+W.height*W.cell};
}
function getCropStats(){ return Object.assign({}, CROP); }
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
/* Where the loaded map sits on the globe -- {lat, lon, zSouth} for the centre of the
   network, or null when there is no map or its projector cannot be inverted. Written by
   rebuildWorld, read by the sky clock (which needs a latitude for the sun and a longitude
   for the time zone) and by the panel, which says which place the clock is telling the
   time at. */
let MAP_LATLON=null;
function getMapLatLon(){ return MAP_LATLON; }

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
  /* Upper bound matches the slider in trails/index.html. Raising the input's max alone
     did nothing -- the value arrived here and was clamped straight back to 3, so the
     handle moved and the view did not. Both ends of that have to agree. */
  FOG_MUL=clamp(Number(v)||1, 0.15, 5);
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
/* THE FAR PLANE IS A FUNCTION OF THE FOG, not a constant, and that is a performance fix
   rather than a tidy-up.

   main.js used to pin camera.far at 4000 so a kilometres-wide trail network would not get
   clipped. But fog goes fully opaque at THEME.fogFar*MAP_SCALE*FOG_MUL -- 192 on the
   default Garden of the Gods map -- so the frustum was roughly twenty times deeper than
   anything the player can actually see. Measured on that map: 6,366 meshes in the scene,
   4,927 of them (77%) more than 200 units from the player. Every one of those sat INSIDE
   the frustum whenever the camera faced across the valley, and three.js creates a mesh's
   GPU resources lazily on its first render -- so cresting a ridge meant a few thousand
   first-time material initialisations and buffer uploads landing inside a single frame.
   That is what the stutter was. Culling them costs nothing, because fog had already
   painted them out.

   Two floors under it, both real:
     - the fog wall itself, with 15% of headroom so nothing pops at the point where it
       would have been 100% sky-coloured anyway;
     - the horizon backdrop, which is deliberately exempt from fog (see buildBackdrop) and
       therefore is the one thing that must survive past it. 1.35x its outer radius covers
       the skirt corner, which is the furthest vertex on it.
   FOG_MUL clamps as low as 0.15, so without the backdrop floor a player who pulled fog
   right in would have clipped the sky dome off.

   Side benefit worth recording, because it fixes a bug the comments in shadow.js are
   still apologising for: depth-buffer precision is spread across near..far, and hauling
   far in from 4000 to a couple of hundred is a large precision win at ground level. The
   polygonOffset hack keeping the pup's blob shadow from strobing is no longer fighting a
   depth buffer stretched over four kilometres. */
function applyFarPlane(){
  const fogFar = THEME.fogFar*MAP_SCALE*FOG_MUL;
  const far = Math.max(fogFar*1.15, backdropRadius(THEME, MAP_SCALE)*1.35, 60);
  if(camera.far !== far){ camera.far = far; camera.updateProjectionMatrix(); }
}
function applyThemeLighting(){
  scene.background=new THREE.Color(THEME.sky);
  scene.fog=new THREE.Fog(new THREE.Color(THEME.sky).getHex(),
                          THEME.fogNear*MAP_SCALE*FOG_MUL, THEME.fogFar*MAP_SCALE*FOG_MUL);
  applyFarPlane();
  hemi.color=new THREE.Color(THEME.hemiSky);
  hemi.groundColor=new THREE.Color(THEME.hemiGround);
  hemi.intensity=THEME.hemiInt;
  sun.intensity=THEME.sunInt;
  /* THE THEME IS THE BASE, THE CLOCK IS THE OVERLAY, and they are applied in that order
     from one place so no caller can get one without the other. In default lighting mode
     this call restores the fixed key light and returns; in day/night it mixes everything
     above away from the theme toward the time of day. Fog DISTANCES stay ours -- sky.js
     only ever touches the fog's colour. */
  refreshSky();
}
function getGraph(){ return GRAPH; }
function getTrailheads(){ return TRAILHEADS; }
function getPOIs(){ return POIS; }
function getFixtures(){ return FIXTURES; }
function treeSpotOK(x,z){ return TREE_SPOT ? TREE_SPOT(x,z) : true; }
function getPowerSpans(){ return POWER_SPANS; }

/* ---------- fixtures: aligned to what they belong to ----------
   rot uses three.js's convention: rotation.y = t turns local +z to world (sin t, cos t)
   and local +x to (cos t, -sin t). */
const faceZ = (vx, vz) => Math.atan2(vx, vz);          // local +z points along (vx,vz)
const faceX = (dx, dz) => Math.atan2(-dz, dx);         // local +x points along (dx,dz)
/* Nearest point on any edge of the given kinds within `reach` world units, with the
   edge's direction there and the side of the line the query point is on. */
function nearestOnEdges(x, z, kinds, reach){
  let best=null;
  for(const e of GRAPH ? GRAPH.edges : []){
    if(kinds && !kinds.has(e.kind)) continue;
    const r=projectOnPolyline(e.pts, x, z);
    if(r.d<=reach && (!best || r.d<best.d)) best=Object.assign(r, {edge:e});
  }
  if(best){
    const nx=-best.dir[1], nz=best.dir[0];
    best.side=((x-best.px)*nx+(z-best.pz)*nz)>=0 ? 1 : -1;
    best.n=[nx*best.side, nz*best.side];               // unit normal toward the query point
  }
  return best;
}
const RAIL_KINDS=new Set(['rail']);
const STATION_REACH_M=40, FIXTURE_REACH_M=15, DEPOT_NEAR_M=30;
function placeStation(p){
  p.signOnly = AREAS.some(a=>{
    if(a.kind!=='depot' && a.kind!=='platform') return false;
    const bb=areaBBox(a), m=DEPOT_NEAR_M*MAP_SCALE;
    return p.x>=bb.mnx-m && p.x<=bb.mxx+m && p.z>=bb.mnz-m && p.z<=bb.mxz+m;
  });
  const t=nearestOnEdges(p.x, p.z, RAIL_KINDS, STATION_REACH_M*MAP_SCALE);
  if(!t) return null;
  /* True metres from the centreline: half the ballast's outline, then the model's own
     depth -- the depot's platform front is 4.2 m in front of its origin, the lone board is
     a pace off the ballast. Offsets are real metres like the model, not MAP_SCALE'd. */
  const back=pathOutlineWidth('rail')/2 + (p.signOnly ? 1.5 : 4.2);
  return {x:t.px+t.n[0]*back, z:t.pz+t.n[1]*back, rot:faceZ(-t.n[0], -t.n[1])};
}
function buildFixtures(){
  const frng=mulberry(4242);   // its own sequence: fixtures never shift the scenery's
  POWER_SPANS=[];
  const pylons=[];
  for(const f of FIXTURES){
    let x=f.x, z=f.z, rot=frng()*6.28;
    const extra=[];
    /* A gate, a crossing sign or a buffer stop only means something ON the way it belongs
       to. The source often has the node but not the way (BarrTrailWorld.json: 4 of 6 gates
       sit on driveways its line layer never included), and one standing alone in the
       trees, turned at random, reads as litter. Those are skipped, and counted. */
    const needsPath = f.kind==='gate' || f.kind==='buffer' || f.kind==='crossbuck';
    if(f.kind==='gate'){
      const t=nearestOnEdges(x, z, null, FIXTURE_REACH_M*MAP_SCALE);
      if(t){ x=t.px; z=t.pz; rot=faceX(t.dir[0], t.dir[1]); f.gateHalf=pathOutlineWidth(t.edge.kind)/2+0.25; f.on=t.edge.kind; }
    }else if(f.kind==='buffer'){
      const t=nearestOnEdges(x, z, RAIL_KINDS, FIXTURE_REACH_M*MAP_SCALE);
      if(t){ x=t.px; z=t.pz; rot=faceX(t.dir[0], t.dir[1]); f.on='rail'; }
    }else if(f.kind==='crossbuck'){
      /* One each side of the track, diagonally opposite (each on the right of the road
         for traffic approaching it), boards turned to face along the road -- i.e. across
         the rails. */
      const t=nearestOnEdges(x, z, RAIL_KINDS, FIXTURE_REACH_M*MAP_SCALE);
      if(t){
        const off=pathOutlineWidth('rail')/2+1.4, along=2.2;
        const [dx,dz]=t.dir, [nx,nz]=[-dz,dx];
        x=t.px+nx*off-dx*along; z=t.pz+nz*off-dz*along; rot=faceZ(nx,nz);
        extra.push({x:t.px-nx*off+dx*along, z:t.pz-nz*off+dz*along, rot:faceZ(-nx,-nz)});
        f.on='rail';
      }
    }else if(f.kind==='pylon'){
      pylons.push(f); continue;          // turned once its neighbours are known, below
    }
    if(needsPath && !f.on){ f.skipped=true; continue; }
    for(const at of [{x,z,rot}, ...extra]){
      const grp=buildPOI(f, frng);
      grp.position.set(at.x, terrainY(at.x,at.z,VERT_SCALE), at.z); grp.rotation.y=at.rot;
      grp.name='fixture:'+f.kind; worldG.add(grp);
    }
    f.x=x; f.z=z; f.rot=rot;
  }
  buildPowerLine(pylons, frng);
}
/* POWER LINES FROM PYLONS ALONE. A raw export carries power=tower nodes but not always the
   power=line way through them, and pylons standing unconnected read as broken. Their
   minimum spanning tree reproduces a single line exactly (consecutive towers are each
   other's nearest), and a span longer than any real one is refused rather than drawn
   across a valley between two different lines. Each pylon then turns to face along its
   own spans, so its arms stand square to the wires. */
const MAX_SPAN_M = 450;
function buildPowerLine(pylons, frng){
  const n=pylons.length;
  if(!n) return;
  const maxD=MAX_SPAN_M*MAP_SCALE, inTree=new Array(n).fill(false), best=new Array(n).fill(Infinity), from=new Array(n).fill(-1);
  const nbr=pylons.map(()=>[]);
  best[0]=0;
  for(let it=0; it<n; it++){
    let u=-1; for(let i=0;i<n;i++) if(!inTree[i] && (u<0 || best[i]<best[u])) u=i;
    if(best[u]===Infinity){ best[u]=0; from[u]=-1; }   // a new, separate line starts here
    inTree[u]=true;
    if(from[u]>=0){ nbr[u].push(from[u]); nbr[from[u]].push(u); POWER_SPANS.push([from[u], u]); }
    for(let v=0; v<n; v++){
      if(inTree[v]) continue;
      const d=Math.hypot(pylons[u].x-pylons[v].x, pylons[u].z-pylons[v].z);
      if(d<=maxD && d<best[v]){ best[v]=d; from[v]=u; }
    }
  }
  // face along the line: average of the unit directions to each neighbour, the second
  // flipped so a straight run through the tower adds rather than cancels
  pylons.forEach((p,i)=>{
    let dx=0, dz=0;
    nbr[i].forEach((j,k)=>{
      let ux=pylons[j].x-p.x, uz=pylons[j].z-p.z; const L=Math.hypot(ux,uz)||1; ux/=L; uz/=L;
      if(k>0 && ux*dx+uz*dz<0){ ux=-ux; uz=-uz; }
      dx+=ux; dz+=uz;
    });
    p.rot = (dx||dz) ? faceX(dx, dz) : frng()*6.28;
    p.y = terrainY(p.x, p.z, VERT_SCALE);
    const grp=buildPOI(p, frng);
    grp.position.set(p.x, p.y, p.z); grp.rotation.y=p.rot; grp.name='fixture:pylon';
    worldG.add(grp);
  });
  if(!POWER_SPANS.length) return;
  /* Wires: from each attachment point to its partner on the next tower, sagging in a
     parabola. Partners are matched by side -- if the two towers' +z axes point opposite
     ways, left pairs with right -- so no wire crosses its neighbour mid-span. */
  const W=pylonWirePoints(), SEG=10, P=[];
  const world=(p,l)=>{ const c=Math.cos(p.rot), sn=Math.sin(p.rot); return [p.x+l[0]*c+l[2]*sn, p.y+l[1], p.z-l[0]*sn+l[2]*c]; };
  for(const [i,j] of POWER_SPANS){
    const A=pylons[i], B=pylons[j];
    const flip=(Math.sin(A.rot)*Math.sin(B.rot)+Math.cos(A.rot)*Math.cos(B.rot))<0;
    for(const l of W){
      const a=world(A,l), b=world(B, flip ? [l[0],l[1],-l[2]] : l);
      const span=Math.hypot(b[0]-a[0], b[2]-a[2]);
      const sag=clamp(span*0.035, 0.3, 6);
      let prev=a;
      for(let k=1;k<=SEG;k++){
        const t=k/SEG;
        const q=[a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t - 4*sag*t*(1-t), a[2]+(b[2]-a[2])*t];
        P.push(prev[0],prev[1],prev[2], q[0],q[1],q[2]); prev=q;
      }
    }
  }
  const geo=new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(P),3));
  const wires=new THREE.LineSegments(geo, new THREE.LineBasicMaterial({color:new THREE.Color('#2e3236')}));
  wires.name='power-wires';
  worldG.add(wires);
}
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
/* HOW BIG A TERRAIN MESH THIS DEVICE WILL ACCEPT, counted in quads.
 *
 * Every DEM cell becomes a quad, plus another wherever the terrace band changes, and each
 * quad is four vertices in the buffer. Measured at the shipped contour step:
 *
 *   world.json       356x428  ->   254k quads ->  1.0M verts ->  39 MB of buffers
 *   rrworld.json     514x726  ->   488k quads ->  2.0M verts ->  74 MB
 *   pikesworld.json 1132x938  -> 2.63M quads -> 10.5M verts -> 400 MB
 *
 * The first two load on a tablet today; the third kills the tab. 600,000 sits just above
 * rrworld on purpose -- the budget must not touch a map that already works, and rrworld
 * is the largest grid we have direct evidence for. pikesworld lands on stride 3
 * (377x312, 45 m cells, 329k quads, 50 MB), comfortably inside the envelope of the two
 * maps known to be fine, for a map covering 17 km of Pikes Peak where 45 m cells are
 * proportionate anyway.
 *
 * Desktop is not budgeted at all. There is no reason to degrade a map on hardware that
 * loads it fine, and tying the number to QUALITY.tier means the same watchdog that drops
 * shadows on a struggling device also decides this.
 *
 * Deliberately NOT re-applied on a quality tier change: the grid is baked into BUNDLE at
 * load, and silently rebuilding the terrain under a player mid-walk to a different shape
 * of ground is worse than leaving a map at the resolution it was opened with. */
const TERRAIN_QUAD_BUDGET_MOBILE = 600000;
/* Test seam. The shipped maps are all either well inside the budget or well outside it,
   so nothing in the suite exercises a DECIMATED grid unless it can ask for one -- and the
   bugs the budget introduced (ungraded cells under a trail) only appear there. Overriding
   lets tools/smoke.js reload the default map at a stride it would never reach on its own.
   null restores normal behaviour. */
let QUAD_BUDGET_OVERRIDE = null;
function setTerrainQuadBudget(n){ QUAD_BUDGET_OVERRIDE = (n == null) ? null : Number(n); }
function terrainQuadBudget(){
  if(QUAD_BUDGET_OVERRIDE != null) return QUAD_BUDGET_OVERRIDE;
  return QUALITY.tier === 'high' ? 0 : TERRAIN_QUAD_BUDGET_MOBILE;   // 0 = no limit
}

async function loadWorld(urlOrBundleObj, extraLayers, stepMetres){
  const opts = {maxQuads: terrainQuadBudget(), terraceStep: stepMetres || STEP_M};
  BUNDLE = (typeof urlOrBundleObj==='string')
    ? await fetchWorldBundle(urlOrBundleObj, opts)
    : loadWorldBundle(urlOrBundleObj, opts);
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
/* 1 when the loaded bundle is at its native DEM resolution, higher when the quad budget
   decimated it. Read by tools/smoke.js; also the honest thing to surface in the map note
   if the panel ever wants to say a big map was coarsened to fit. */
function getDemStride(){ return BUNDLE ? BUNDLE.demStride : null; }
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
const PATH_W = {trail:1.1, track:1.9, dirtroad:2.8, road:3.0, rail:2.6};
/* rail: the sleeper length of standard gauge. The tread ribbon IS the ballast bed, so the
   bench, the spatial hash and the walkable corridor are all exactly the width of the track
   the pup can see -- it walks the sleepers, between the rails. */
/* dirtroad is a graded dirt/gravel road (Gold Camp Road, Rampart Range Road): nearly a
   road's width, but a track in every way that matters to the rest of this file -- no
   kerb, no crosswalk, nothing trimmed back from it. See geo.js's pathKind. */
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
/* "Is there a trail tread here, and is it below us?" -- the test embankmentGeom uses to
   stop a fill from burying the next leg of a switchback. Asks the spatial hash rather
   than the graph, so it catches a lower leg of the SAME edge, which is exactly the case a
   same-edge comparison would miss and exactly the case switchbacks produce. The 0.6
   margin keeps a skirt from stopping against its own tread where the hash's corridor is
   wider than the painted outline. */
function buriesTread(x, z, yTop){
  const nt = nearestTrail(x, z);
  return nt.y != null && nt.d <= nt.hw && nt.y < yTop - 0.6;
}

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
const PATH_RANK = {road:0, dirtroad:1, track:1, rail:1, trail:2};
/* rail sits with the tracks: a footpath that crosses it is painted over it (it is the
   smaller surface), and a road it crosses is the ground its rails lie on -- which is how a
   level crossing actually looks, rails set into the tarmac. */
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
      if(!c.crossing) continue;
      /* An arm surveyed running ALONG the road into a crossing used to be left alone, so
         the crosswalk was built square and the path slid into it at a shallow angle. It
         is squared too now, over a longer apron the more oblique it arrives, so the turn
         onto the markings is a curve rather than a kink. */
      const apronHere = a.along > ALONG_MAX ? apron*(1 + 1.5*a.along) : apron;
      // orient the arm so pts[0] is this node, square it up, then write it back the way
      // round it came. squareApproach returns a new array (it inserts vertices), so the
      // assignment is not optional the way an in-place nudge would have been.
      const pts = a.flip ? [...w.pts].reverse() : w.pts;
      const squared = squareApproach(pts, c.nx*a.side, c.nz*a.side, apronHere);
      w.pts = a.flip ? squared.reverse() : squared;
      // kept so clearOfWiderPaths can put the square back after it resamples and nudges
      // the line -- otherwise the displacement pass quietly rounds the apron off again
      const sq = {ux:c.nx*a.side, uz:c.nz*a.side, apron:apronHere};
      if(a.flip) w.squareB = sq; else w.squareA = sq;
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
  /* An anchor's box, cached against the exact array it was measured from: anchors are
     themselves displaced earlier in this same walk (a track moves for a road), which
     replaces their pts array, and a stale box would then be a wrong one. */
  const boxCache = new Map();
  const anchorBox = o => {
    const c = boxCache.get(o);
    if(c && c.pts === o.pts) return c.box;
    const box = polylineBox(o.pts, 0);
    boxCache.set(o, {pts:o.pts, box});
    return box;
  };

  for(const e of order){
    /* Buried paths are not drawn as surfaces at all -- they are route markers laid on
       their host (markBuriedEdges) -- and asSidewalk has already placed them exactly
       where they belong on the verge. Pushing one again would shove a sidewalk off the
       road it is meant to follow. */
    if(e.buried || e.pts.length < 2) continue;
    const half = pathOutlineWidth(e.kind)/2 + CLEAR_MARGIN;
    /* Only anchors whose box comes within reach of this edge's box. A push only ever
       happens inside `clear` of an anchor, so an anchor further than that from every
       vertex cannot push anything. (It could still have been the nearest anchor for a
       vertex's frozen side, which only matters for a vertex that is never pushed; the
       default map's overlap measure moved by one metre in 120 when this went in.) It mattered once real roads appeared on
       the Pikes Peak map: every trail was being projected onto every road, vertex by
       vertex, round by round, and the load went from 1.0 s to 7 s. REACH is generous so
       a vertex nudged a little during the rounds still sees the anchors it could meet. */
    const REACH = half + pathOutlineWidth('road')/2 + 8;
    const eb = polylineBox(e.pts, REACH);
    const anchors = GRAPH.edges.filter(o =>
      o !== e && o.pts.length >= 2 && pathRank(o.kind) < pathRank(e.kind) &&
      boxesMeet(eb, anchorBox(o)));
    if(!anchors.length) continue;

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
    if(e.pts.length < 3){ resquare(e); continue; }   // too short to have an interior; leave it alone
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
    if(!(total>0)){ resquare(e); continue; }

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
    /* One frozen side PER ANCHOR, not one per vertex. The first version froze each
       vertex's side against its NEAREST anchor and then pushed it off whichever anchor it
       overlapped WORST -- and where those were two different roads, or the near and far
       legs of one loop road, the sign belonged to the wrong line and the vertex was
       pushed straight through the carriageway. That is where the crossings with no node
       came from at 1:12 (Juniper Way Loop, three of them). */
    const sideOf = e.pts.map(()=>new Map());
    {
      const sums = new Map();
      for(let i=0;i<e.pts.length;i++){
        const p=e.pts[i];
        for(const o of anchors){
          const pr=projectOnPolyline(o.pts, p[0], p[1]);
          const off=(p[0]-pr.px)*(-pr.dir[1]) + (p[1]-pr.pz)*pr.dir[0];
          sums.set(o, (sums.get(o)||0) + off);
          if(Math.abs(off) > 1e-3) sideOf[i].set(o, off>0?1:-1);
        }
      }
      for(let i=0;i<e.pts.length;i++)
        for(const o of anchors) if(!sideOf[i].has(o)) sideOf[i].set(o, (sums.get(o)||0)>=0?1:-1);
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
          const b = anchorBox(o);
          if(p[0] < b.x0-clear || p[0] > b.x1+clear || p[1] < b.z0-clear || p[1] > b.z1+clear) continue;
          const pr = projectOnPolyline(o.pts, p[0], p[1]);
          const over = clear - pr.d;
          if(over > worstOver){ worstOver=over; worst={pr, clear, o}; }
        }
        if(!worst) continue;
        const {pr, clear}=worst;
        const nx=-pr.dir[1], nz=pr.dir[0];
        const sd = sideOf[i].get(worst.o);
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
    /* NEVER TRADE AN OVERLAP FOR A CROSSING. Sidedness per anchor stops the pass pushing
       a path through the thing it is clearing, but not through a THIRD path it was never
       measuring against. A crossing with no node is worse than an overlap -- it cannot be
       crosswalked, graded to a shared height or routed -- so if the displaced line crosses
       anything more often than the recorded one did, back the displacement off by halves
       until it doesn't, and keep the survey line if nothing short of it works. */
    if(touched){
      const shifted = e.pts.map(p=>p.slice());
      const others = GRAPH.edges.filter(o => o!==e && o.pts.length>=2 &&
                                             boxesMeet(eb, anchorBox(o)));
      const before = crossCount(recorded, e, others);
      let ok = crossCount(shifted, e, others) <= before;
      for(let f=0.5; !ok && f>=0.125; f*=0.5){
        const trial = recorded.map((p,i)=>[p[0]+(shifted[i][0]-p[0])*f, p[1]+(shifted[i][1]-p[1])*f]);
        if(crossCount(trial, e, others) <= before){ e.pts = trial; ok = true; }
      }
      if(!ok){ e.pts = recorded.map(p=>p.slice()); touched = false; }
    }
    if(touched){ moved++; e.displaced=true; e.recorded=recorded; }
    resquare(e);
  }
  return moved;
}

/* Re-apply planCrossings' square approach to either end of `e` that has one. Displacement
   resamples every edge near an anchor and tapers its push toward the ends; both bend the
   last metre off square, and at a crosswalk that metre is the whole point. squareApproach
   leaves pts[0] where it is, so the junction is untouched. */
function resquare(e){
  if(e.squareA) e.pts = squareApproach(e.pts, e.squareA.ux, e.squareA.uz, e.squareA.apron);
  if(e.squareB){
    const r = squareApproach([...e.pts].reverse(), e.squareB.ux, e.squareB.uz, e.squareB.apron);
    e.pts = r.reverse();
  }
}

/* Proper crossings between polyline `pts` (standing in for edge e) and every edge in
   `others` that does not share a node with e. segCross is open on both intervals, so two
   lines meeting exactly at a shared node never count. */
function crossCount(pts, e, others){
  let n=0;
  for(const o of others){
    if(o.a===e.a || o.a===e.b || o.b===e.a || o.b===e.b) continue;
    for(let a=0;a<pts.length-1;a++)
      for(let b=0;b<o.pts.length-1;b++)
        if(segCross(pts[a], pts[a+1], o.pts[b], o.pts[b+1])) n++;
  }
  return n;
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

/* Shove a point clear of EVERY drawn path, not only roads -- the general form of
   pushOffRoad, for sign posts. A fork of two footpaths is exactly where a post used to
   stand in the tread. Same push (perpendicular, to the side it is already on), iterated
   because clearing one path can land the point on a neighbour; in a gap too narrow to
   clear both it settles on the last push, which is still off the path it was pushed from. */
const POST_CLEAR = 0.45;
// an area board is 2.5 m wide and hangs square to the path it faces, so its post needs a
// little more room than a fingerpost for the board edge to clear the verge
const AREA_SIGN_CLEAR = 0.6;
function pushOffPaths(x, z, margin){
  if(!GRAPH) return [x, z];
  let px=x, pz=z;
  for(let pass=0; pass<5; pass++){
    let worst=null, worstOver=0;
    for(const e of GRAPH.edges){
      if(e.pts.length<2) continue;
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
    const dx=worst.b[0]-worst.a[0], dz=worst.b[1]-worst.a[1];
    const L=Math.hypot(dx,dz)||1;
    const nx=-dz/L, nz=dx/L;
    const sx=px-worst.r.q[0], sz=pz-worst.r.q[1];
    const side = (sx*nx + sz*nz) >= 0 ? 1 : -1;
    px = worst.r.q[0] + nx*side*worst.clear*1.04;
    pz = worst.r.q[1] + nz*side*worst.clear*1.04;
  }
  /* Pinned between two paths closer together than a post plus two verges, the pushes
     just trade one path for the other. Then search outward in rings for the NEAREST
     point that is clear of everything, which is where a real post would be dug in. */
  if(pathOverlap(px, pz, margin) > 0){
    for(let r=0.6; r<=6; r+=0.6){
      let best=null, bd=Infinity;
      for(let k=0;k<16;k++){
        const a=k/16*Math.PI*2, cx=px+Math.cos(a)*r, cz=pz+Math.sin(a)*r;
        if(pathOverlap(cx, cz, margin) > 0) continue;
        const d=Math.hypot(cx-x, cz-z);
        if(d<bd){ bd=d; best=[cx,cz]; }
      }
      if(best) return best;
    }
  }
  return [px, pz];
}
/* How far (x,z) sits inside the nearest drawn path's painted edge plus `margin`; <= 0 is
   clear. */
function pathOverlap(x, z, margin){
  let worst=0;
  for(const e of GRAPH.edges){
    if(e.pts.length<2) continue;
    const clear = pathOutlineWidth(e.kind)/2 + (margin||0);
    for(let i=0;i<e.pts.length-1;i++){
      const a=e.pts[i], b=e.pts[i+1];
      if(Math.min(a[0],b[0])-clear > x || Math.max(a[0],b[0])+clear < x) continue;
      if(Math.min(a[1],b[1])-clear > z || Math.max(a[1],b[1])+clear < z) continue;
      const over = clear - ptSeg([x,z], a, b).d;
      if(over > worst) worst = over;
    }
  }
  return worst;
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
  /* The deck mask travels with the stations, so a trimmed ribbon still knows which of
     its stretches are bridge (no skirt under those). A cut end takes the flag of the
     station it falls just before. */
  const dk=prof.deck, outD=[];
  const deckNear=(s)=>{ if(!dk) return false; for(let i=0;i<pts.length;i++) if(arc[i]>=s) return !!dk[i]; return !!dk[pts.length-1]; };
  let e0=at(lo); outP.push(e0[0]); outY.push(e0[1]); outD.push(deckNear(lo));
  for(let i=0;i<pts.length;i++) if(arc[i]>lo && arc[i]<hi){ outP.push(pts[i]); outY.push(ys?ys[i]:0); outD.push(dk?!!dk[i]:false); }
  let e1=at(hi); outP.push(e1[0]); outY.push(e1[1]); outD.push(deckNear(hi));
  return {pts:outP, ys:ys?outY:null, deck:dk?outD:null};
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

/* ---------- water, and the bridges that carry paths over it ----------

   Creeks and rivers come out of geo.js as their own bucket (waterKind), never as lines:
   they are not part of the walking network, so they have no nodes, no signposts, no
   place in the route list and no corridor in the spatial hash. What they DO have is
   ground: each one gets a graded channel profile, written into the band grid by the same
   pass that benches the trails (terrain.js's gradeTrailCells), so a creek is a notch in
   the hillside that runs downhill rather than a blue line draped over terrace steps.

   A BRIDGE is wherever a path crosses a channel -- found geometrically, not read off the
   source, because the source's own bridge ways do not survive into the graph. OSM draws
   each of the seven bridges on the seven-bridges map as a separate two-point way a few
   metres long; buildGraph's endpoint snap (16 m of real distance) collapses every one of
   them into a single node and drops the edge. So the bridge tags are kept aside as HINTS
   and matched to the geometric crossings afterwards: a hint over a detected crossing
   lengthens that span to the surveyed bridge, and a hint with no water under it (a dry
   gully the export did not include) still gets a deck.

   A bridge changes three things, all through data the rest of the file already shares:

     - the path's graded profile rises into a deck over the water (raiseBridgeDecks), so
       the ribbon, the spatial hash and standingY all walk the deck with no special case;
     - the ground under the span is the channel, not the path's bench (zones, passed to
       gradeTrailCells), so the water runs UNDER the deck instead of into a dam;
     - the ribbon draws no fill embankment along the span -- a skirt there is the dam
       again, drawn instead of graded -- and a deck and railings go on top.

   Every length here is true metres unless it says otherwise, for the same reason tread
   widths are: a creek, a plank and a handrail are objects the pup has to be the right
   size next to at any world scale. Positions compact; these do not. */
const WATERWAYS = [];            // cleared in place; read by the minimap and the smoke suite
const BRIDGES = [];              // cleared in place
let WATER_HASH = new Map();
const WATER_HASH_CELL = 12;
/* These four are WORLD UNITS, like the widths, not real metres of elevation. Relief is
   compacted by VERT_SCALE (0.25 at the default 1:5), so a real 0.9 m creek bank would be a
   22 cm notch beside a pup-sized pup -- and a deck clearance measured the same way would put
   the planks on the water. The grading maths works in metres, so each use divides by
   VERT_SCALE (vm() below). */
const CHANNEL_DEPTH_U = 0.9;     // bed below the valley floor the channel runs through
const WATER_U = 0.3;             // water surface above the bed
const DECK_CLEAR_U = 0.8;        // deck above the water
const MAX_HUMP_U = 1.4;          // most a path climbs to clear a creek; past that the creek dips
const vm = u => u/Math.max(1e-6, VERT_SCALE);
const BRIDGE_MIN_HALF = 2.4;     // shortest half-span
const BRIDGE_ABUT = 1.1;         // deck reaches this far past each bank
const WATER_BANK = 0.55;         // exposed bed either side of the water
const MIN_CROSS_SIN = 0.35;      // an oblique crossing is spanned as if at ~20 degrees, no flatter

function channelHalf(w){ return w.width/2 + WATER_BANK; }

/* Nearest profile station to (x,z), by index. Profiles are dense (stations under a metre
   apart), so the nearest station is as good as the nearest point for everything here. */
function nearestStation(pts, x, z){
  let bi=-1, bd=Infinity;
  for(let i=0;i<pts.length;i++){
    const d=Math.hypot(pts[i][0]-x, pts[i][1]-z);
    if(d<bd){ bd=d; bi=i; }
  }
  return {i:bi, d:bd};
}
function distToPolyline(pts, x, z){
  let best=Infinity;
  for(let i=0;i<pts.length-1;i++){ const d=ptSeg([x,z], pts[i], pts[i+1]).d; if(d<best) best=d; }
  return best;
}
function polylineBox(pts, pad){
  let x0=Infinity,x1=-Infinity,z0=Infinity,z1=-Infinity;
  for(const p of pts){ x0=Math.min(x0,p[0]); x1=Math.max(x1,p[0]); z0=Math.min(z0,p[1]); z1=Math.max(z1,p[1]); }
  return {x0:x0-pad, x1:x1+pad, z0:z0-pad, z1:z1+pad};
}
const boxesMeet=(a,b)=>!(a.x1<b.x0||a.x0>b.x1||a.z1<b.z0||a.z0>b.z1);

/* Find every place a path crosses water, fold in the source's own bridge ways, and decide
   which edges each bridge carries. Runs after every geometry pass (burial, crossings,
   displacement) because it records positions on the FINAL centrelines. */
function planBridges(hints){
  BRIDGES.length=0;
  if(!GRAPH) return 0;
  const addOrMerge=(x, z, half, water, e)=>{
    for(const b of BRIDGES){
      if(Math.hypot(b.x-x, b.z-z) < Math.max(b.half, half)){
        if(half>b.half) b.half=half;
        // a crossing with water beats a dry hint for where the span is centred
        if(water && !b.water){ b.water=water; b.x=x; b.z=z; }
        if(e && !b.edges.includes(e)) b.edges.push(e);
        return b;
      }
    }
    const b={x, z, half, water:water||null, edges:e?[e]:[], hinted:false};
    BRIDGES.push(b);
    return b;
  };

  const wbox=WATERWAYS.map(w=>polylineBox(w.pts, channelHalf(w)));
  for(const e of GRAPH.edges){
    if(e.pts.length<2 || e.ford) continue;
    const eb=polylineBox(e.pts, 0);
    WATERWAYS.forEach((w, wi)=>{
      if(!boxesMeet(eb, wbox[wi])) return;
      for(let i=0;i<e.pts.length-1;i++){
        for(let k=0;k<w.pts.length-1;k++){
          const c=segCross(e.pts[i], e.pts[i+1], w.pts[k], w.pts[k+1]);
          if(!c) continue;
          const ax=e.pts[i+1][0]-e.pts[i][0], az=e.pts[i+1][1]-e.pts[i][1];
          const bx=w.pts[k+1][0]-w.pts[k][0], bz=w.pts[k+1][1]-w.pts[k][1];
          const sin=Math.abs(ax*bz-az*bx)/((Math.hypot(ax,az)*Math.hypot(bx,bz))||1);
          const half=Math.max(BRIDGE_MIN_HALF,
            channelHalf(w)/Math.max(MIN_CROSS_SIN, sin) + BRIDGE_ABUT);
          addOrMerge(c.q[0], c.q[1], half, w, e);
        }
      }
    });
  }

  /* Hints: the surveyed bridge ways. A hint stretches a detected span to the bridge's
     real length, or -- if nothing was detected there -- becomes a dry bridge on whichever
     paths run through it. */
  for(const h of hints){
    if(!h || h.length<2) continue;
    let len=0; for(let i=1;i<h.length;i++) len+=Math.hypot(h[i][0]-h[i-1][0], h[i][1]-h[i-1][1]);
    const m=h[Math.floor((h.length-1)/2)], m2=h[Math.ceil((h.length-1)/2)];
    const mx=(m[0]+m2[0])/2, mz=(m[1]+m2[1])/2;
    const half=Math.max(BRIDGE_MIN_HALF, len/2 + BRIDGE_ABUT*0.5);
    let near=null;
    for(const b of BRIDGES) if(Math.hypot(b.x-mx, b.z-mz) < Math.max(b.half, half) + 1.5){ near=b; break; }
    if(near){ near.half=Math.max(near.half, half); near.hinted=true; continue; }
    const carriers=GRAPH.edges.filter(e=>!e.ford && e.pts.length>=2 &&
      distToPolyline(e.pts, mx, mz) <= pathOutlineWidth(e.kind)/2 + 0.6);
    if(!carriers.length) continue;
    const b=addOrMerge(mx, mz, half, null, null);
    b.hinted=true;
    carriers.forEach(e=>{ if(!b.edges.includes(e)) b.edges.push(e); });
  }

  /* Every edge that actually passes through a span rides it -- in particular both halves
     of a trail that buildGraph cut at a node sitting on the bank, and a sidewalk beside a
     road bridge. Without this only the one edge whose segment happened to straddle the
     water would rise, and its neighbour would meet it a metre lower at the node. */
  for(const b of BRIDGES){
    for(const e of GRAPH.edges){
      if(b.edges.includes(e) || e.ford || e.pts.length<2) continue;
      if(distToPolyline(e.pts, b.x, b.z) <= Math.max(0.6, pathWidth(e.kind)*0.5)) b.edges.push(e);
    }
  }
  return BRIDGES.length;
}

/* Grade each channel: smoothed along its length like a trail, then pushed down into a
   bed and made to run downhill. The profile stored is the BED (what gradeTrailCells
   benches), with the water surface kept alongside for drawing. */
function gradeWaterways(){
  for(const w of WATERWAYS){
    w.prof=null;
    if(w.pts.length<2) continue;
    const pr=gradeProfile(w.pts, VERT_SCALE, 0.7, 10, Math.max(0.7, w.width*0.5));
    const n=pr.pts.length;
    if(n<2) continue;
    /* never above the ground it runs through, and never uphill. Which end is upstream is
       read from the profile rather than trusted from the digitising direction: OSM draws
       waterways downstream, but a QGIS merge or reverse can silently flip one. */
    const ground=pr.pts.map(p=>terrainY(p[0],p[1],1));
    const down = pr.hm[0] >= pr.hm[n-1];
    const bed=new Array(n);
    let run=Infinity;
    for(let k=0;k<n;k++){
      const i = down ? k : n-1-k;
      const h=Math.min(pr.hm[i], ground[i]) - vm(CHANNEL_DEPTH_U);
      run=Math.min(run, h);
      bed[i]=run;
    }
    w.prof={pts:pr.pts, hm:bed, halfWidth:channelHalf(w)};
  }
}

/* Lift each bridge's paths into a deck, dip the creek if the path cannot climb far
   enough, and return the zones where the channel owns the ground. Mutates e.prof in
   place (hm, ys, and the new hmGround / deck arrays) -- the one shared profile every
   consumer reads, which is what keeps the planks, the tread and standingY agreed. */
function raiseBridgeDecks(){
  const zones=[];
  const smooth=u=>u*u*(3-2*u);
  for(const b of BRIDGES){
    const riders=b.edges.filter(e=>e.prof && e.prof.pts && e.prof.pts.length>=2);
    if(!riders.length) continue;
    let sum=0, n=0;
    for(const e of riders){
      const k=nearestStation(e.prof.pts, b.x, b.z);
      if(k.i>=0 && k.d<=b.half){ sum+=e.prof.hm[k.i]; n++; }
    }
    if(!n) continue;
    const pathM=sum/n;
    let deckM=pathM, waterM=null;
    const w=b.water;
    if(w && w.prof){
      const k=nearestStation(w.prof.pts, b.x, b.z);
      waterM=w.prof.hm[k.i] + vm(WATER_U);
      const need=waterM + vm(DECK_CLEAR_U);
      if(need>pathM){
        deckM=pathM + Math.min(need-pathM, vm(MAX_HUMP_U));
        const short=need-deckM;
        if(short>0){
          /* The path is too far below the water to clear it with a walkable hump -- a
             creek perched on a terrace above the road. Drop the creek under the deck
             instead, easing back over a few spans either side. */
          const R=b.half*2.5;
          for(let j=0;j<w.prof.pts.length;j++){
            const d=Math.hypot(w.prof.pts[j][0]-b.x, w.prof.pts[j][1]-b.z);
            if(d>=R) continue;
            w.prof.hm[j]-=short*smooth(1-d/R);
          }
          waterM-=short;
        }
      }
    }
    b.deckM=deckM; b.pathM=pathM; b.waterM=waterM;
    for(const e of riders){
      const pr=e.prof;
      if(!pr.hmGround){ pr.hmGround=pr.hm.slice(); pr.deck=new Array(pr.pts.length).fill(false); }
      for(let i=0;i<pr.pts.length;i++){
        const d=Math.hypot(pr.pts[i][0]-b.x, pr.pts[i][1]-b.z);
        if(d>b.half) continue;
        /* flat across the middle 55% of the span, easing down to the path at each end --
           a humped footbridge, and a ramp the step-up limit never notices */
        const u=d/b.half;
        const wgt = u<=0.55 ? 1 : smooth((1-u)/0.45);
        const lift=Math.max(0, deckM-pr.hm[i])*wgt;
        pr.hm[i]+=lift;
        pr.ys[i]=pr.hm[i]*VERT_SCALE;
        pr.deck[i]=true;
      }
    }
    /* Only a crossing with water hands its ground to the channel. The zone is the span
       itself, so the abutments either side stay the path's bench. */
    if(w && w.prof) zones.push({x:b.x, z:b.z, r:b.half});
  }
  return zones;
}

function hashWater(){
  WATER_HASH=new Map();
  for(const w of WATERWAYS){
    const pts=w.prof ? w.prof.pts : w.pts, hw=w.width/2;
    // the drawn water surface at each end (the same wetY the water ribbon is built from),
    // so standingY can put a wading pup's paws under it; null without a graded profile
    const wet = w.prof ? w.prof.hm.map(h => h*VERT_SCALE + WATER_U) : null;
    for(let i=0;i<pts.length-1;i++){
      const a=pts[i], b=pts[i+1], seg={a, b, hw, ya: wet ? wet[i] : null, yb: wet ? wet[i+1] : null,
                                     w, i, wet};
      const x0=Math.floor((Math.min(a[0],b[0])-hw)/WATER_HASH_CELL), x1=Math.floor((Math.max(a[0],b[0])+hw)/WATER_HASH_CELL);
      const z0=Math.floor((Math.min(a[1],b[1])-hw)/WATER_HASH_CELL), z1=Math.floor((Math.max(a[1],b[1])+hw)/WATER_HASH_CELL);
      for(let cx=x0;cx<=x1;cx++) for(let cz=z0;cz<=z1;cz++){
        const k=cx+'_'+cz; let arr=WATER_HASH.get(k); if(!arr){ arr=[]; WATER_HASH.set(k,arr); } arr.push(seg);
      }
    }
  }
}
/* Distance past the water's edge (negative inside the water) to the nearest channel,
   or Infinity with none near. `pad` widens the test, for "keep scenery out of the creek". */
function waterEdgeDist(x, z){
  const arr=WATER_HASH.get(Math.floor(x/WATER_HASH_CELL)+'_'+Math.floor(z/WATER_HASH_CELL));
  if(!arr) return Infinity;
  let best=Infinity;
  for(const s of arr){ const d=ptSeg([x,z], s.a, s.b).d - s.hw; if(d<best) best=d; }
  return best;
}
/* Standing in a creek? For the footstep voice. Off-tread only -- on a bridge you are on
   the deck, whatever is underneath. */
function inWaterway(x, z){ return waterEdgeDist(x, z) <= 0; }
/* The drawn water surface at (x,z), or null when (x,z) is not in a channel. Taken from
   the nearest channel segment that actually contains the point, interpolated along it. */
function waterSurfaceAt(x, z){
  const w = waterSurfaceInfo(x, z);
  return w ? w.y : null;
}
/* The same, plus the surface's fall per unit along the channel there -- the slope of THIS
   stretch of water, which is what a pup standing in it spans. */
function waterSurfaceInfo(x, z){
  const arr=WATER_HASH.get(Math.floor(x/WATER_HASH_CELL)+'_'+Math.floor(z/WATER_HASH_CELL));
  if(!arr) return null;
  let best=null, bd=Infinity;
  for(const s of arr){
    if(s.ya == null) continue;
    const r=ptSeg([x,z], s.a, s.b);
    if(r.d > s.hw || r.d >= bd) continue;
    const L=Math.hypot(s.b[0]-s.a[0], s.b[1]-s.a[1]) || 1;
    bd=r.d; best={y: s.ya + (s.yb - s.ya)*r.t, slope: Math.abs(s.yb - s.ya)/L, seg: s, t: r.t};
  }
  return best;
}

/* WADING. The channel is carved WATER_U below the surface it is drawn at, but only across
   the carved bed: the drawn water is wider than the cut, so along both margins the ground
   is the bank, level with or above the surface, and a pup standing there walked ON the
   water with its paws in plain view. In the middle it had the opposite problem -- 0.3u of
   water over a 0.24u leg is swimming, not wading.

   So wherever water is VISIBLE (the ground there is not above the surface), anything
   standing off a path stands WADE_FRACTION of a leg below the surface: paws hidden, body
   clear, the same wherever in the creek you are. Deeper than that and it is held at that
   depth (a pool reads as wading, not a pup vanishing); shallower and it is let down to it.
   Where the ground rises above the drawn surface the water is buried there anyway, and
   the pup stands on the ground as before.

   The depth is a fraction of the actual pup's leg, pushed in by main.js whenever a pup is
   spawned, since leg length varies with size. Critters stand on standingY too, so they
   wade at the same depth -- by the pup's leg rather than their own, which at these sizes
   is close enough to read right. */
const WADE_FRACTION = 0.45, WATER_SHOWS = 0.02;
/* THE WHOLE FOOTPRINT, NOT THE CENTRE. On a steep creek the surface falls several
   centimetres across one pup's length, so a depth measured at the centre left the
   downhill paws' tops above their own water. The wading surface is the lowest the water
   gets under the paws: walk THIS creek's own profile WADE_REACH up and down the channel
   from where the pup stands and take the lowest surface met -- the distance from centre
   to farthest paw, 0.6 of a leg, measured off the rig (the paws span about +-0.15u on a
   0.24u leg). Not a whole body length: that over-reached, and on a 35% creek it sank the
   pup to its chest. Along the profile, not round a circle or along one segment's slope:
   a circle at a tight bend reaches into a lower stretch of the same creek that is not
   under the pup, and one segment's slope misses the gradient changing at the next. Taken from the channel's gradient
   rather than by sampling round the pup, because at a tight bend a sampling circle
   reaches across into another stretch of the same creek, lower down, and sank the pup to
   its chest in water that is not under it. */
const WADE_REACH_PER_LEG = 0.6, WADE_MAX_DROP = 0.5;
let WADE_DEPTH = 0.24*WADE_FRACTION, WADE_REACH = 0.24*WADE_REACH_PER_LEG;
function setWadeLegLength(legLen){
  if(Number.isFinite(legLen) && legLen > 0){
    WADE_DEPTH = legLen*WADE_FRACTION;
    WADE_REACH = legLen*WADE_REACH_PER_LEG;
  }
}
function wadeDepth(){ return WADE_DEPTH; }
function wadeReach(){ return WADE_REACH; }
function wadeSurfaceAt(x, z){
  const w = waterSurfaceInfo(x, z);
  if(!w) return null;
  const pr = w.seg.w.prof, wet = w.seg.wet, pts = pr.pts, n = pts.length;
  // cumulative arc along this creek, cached on its profile (rebuilt with the world)
  if(!pr.__arc || pr.__arc.length !== n){
    const A = [0];
    for(let k=1;k<n;k++) A[k] = A[k-1] + Math.hypot(pts[k][0]-pts[k-1][0], pts[k][1]-pts[k-1][1]);
    pr.__arc = A;
  }
  const A = pr.__arc, i0 = w.seg.i;
  const here = A[i0] + (A[i0+1] - A[i0])*w.t;
  const at = s0 => {                                   // surface at arc position s0
    s0 = clamp(s0, 0, A[n-1]);
    let k = 0; while(k < n-2 && A[k+1] < s0) k++;
    const f = (A[k+1] - A[k]) > 1e-9 ? (s0 - A[k])/(A[k+1] - A[k]) : 0;
    return wet[k] + (wet[k+1] - wet[k])*f;
  };
  let lo = Math.min(w.y, at(here - WADE_REACH), at(here + WADE_REACH));
  for(let k=0;k<n;k++) if(A[k] > here - WADE_REACH && A[k] < here + WADE_REACH && wet[k] < lo) lo = wet[k];
  /* A CASCADE IS NOT WADED. Where the creek falls faster than the paws can follow (one
     67% step on the seven-bridges map), following the lowest surface under the paws
     would put the pup in over its back. The extra depth stops at WADE_MAX_DROP of a leg:
     on a cascade the uphill paws may meet the falling water, which is what it looks like
     to stand in one. */
  const leg = WADE_DEPTH/WADE_FRACTION;
  return Math.max(lo, w.y - leg*WADE_MAX_DROP);
}
function getWaterways(){ return WATERWAYS; }
function getBridges(){ return BRIDGES; }

/* RAILWAY PLANNING, once per build, before any track is drawn.

   RACK OR ADHESION. An ordinary railway cannot climb much past 4-6%: the wheels slip.
   Anything steeper is a rack (cog) railway, with a toothed centre rail the locomotive's
   pinion climbs -- and the Manitou and Pike's Peak line runs at up to 25%. The source
   rarely says so (railway:rack is seldom tagged, and this export kept no tags at all), but
   the DEM does: take each named line's steepest sustained grade over RACK_WINDOW_M of real
   distance, and a line that exceeds RACK_GRADE anywhere gets the rack along its whole
   length -- a cog railway does not drop its rack on the flat bits of the timetable.
   An explicit railway:rack tag, or "cog" in the name, decides it outright.

   SLEEPER BUDGET. Real spacing is 0.65 m, but a long line at 1:1 would be 20,000+
   sleepers; the spacing opens up just enough to keep the whole network under
   RAIL_TIE_BUDGET, so a short spur looks exactly right and a mountain railway at full
   scale still draws on a tablet. */
const RACK_GRADE = 0.08, RACK_WINDOW_M = 40, RAIL_TIE_BUDGET = 6000, RAIL_TIE_GAP_M = 0.65;
function steepestGrade(pr){
  if(!pr || !pr.hm || pr.pts.length<2) return 0;
  const d=[0];
  for(let i=1;i<pr.pts.length;i++) d.push(d[i-1]+Math.hypot(pr.pts[i][0]-pr.pts[i-1][0], pr.pts[i][1]-pr.pts[i-1][1])/MAP_SCALE);
  let worst=0, j=0;
  for(let i=0;i<pr.pts.length;i++){
    while(j<pr.pts.length-1 && d[j]-d[i]<RACK_WINDOW_M) j++;
    const run=d[j]-d[i];
    if(run>=RACK_WINDOW_M*0.5) worst=Math.max(worst, Math.abs(pr.hm[j]-pr.hm[i])/run);
  }
  return worst;
}
function planRails(edges){
  const rails=edges.filter(e=>e.kind==='rail' && e.prof);
  const byLine=new Map();
  for(const e of rails){ const k=e.name||'#'+e.a+'-'+e.b; if(!byLine.has(k)) byLine.set(k,[]); byLine.get(k).push(e); }
  const rack=new Set();
  for(const [name, list] of byLine){
    const tagged=list.some(e=>e.rackTag) || /\bcog\b/i.test(name);
    const steep=Math.max(0, ...list.map(e=>steepestGrade(e.prof)));
    if(tagged || steep>RACK_GRADE) for(const e of list) rack.add(e);
  }
  let len=0;
  for(const e of rails) for(let i=1;i<e.prof.pts.length;i++)
    len+=Math.hypot(e.prof.pts[i][0]-e.prof.pts[i-1][0], e.prof.pts[i][1]-e.prof.pts[i-1][1]);
  const tieGap=Math.max(RAIL_TIE_GAP_M, len/RAIL_TIE_BUDGET);
  RAIL_STATS={edges:rails.length, km:+(len/MAP_SCALE/1000).toFixed(2), rackEdges:rack.size,
              tieGap:+tieGap.toFixed(3), ties:0,
              rackNames:[...new Set([...rack].map(e=>e.name||''))],
              steepest:+Math.max(0,...rails.map(e=>steepestGrade(e.prof))).toFixed(3)};
  return {rack, tieGap};
}
function getRailStats(){ return Object.assign({}, RAIL_STATS); }

/* The rendering class of an edge: its kind, refined by surface. A concrete cycleway is a
   trail to everything else in this file, but it is not brown. */
function styleKey(e){
  if(e.paved && (e.kind==='trail' || e.kind==='track')) return 'paved_'+e.kind;
  return PATH_STYLE_KEYS.has(e.kind) ? e.kind : 'trail';
}
const PATH_STYLE_KEYS = new Set(['trail','track','dirtroad','road','rail','paved_trail','paved_track']);

/* Bumped on every rebuildWorld so cached derived data (minimap.js's relief image, the
   critter roster) can tell "same world, new frame" from "whole world replaced" without
   world.js needing to know those consumers exist. */
let WORLD_REV = 0;
function getWorldRevision(){ return WORLD_REV; }

/* ---------- lots level with the road into them ----------

   flattenAreaCells levels every area to the MEDIAN terrace band under it, which is right
   for a building footprint and wrong for a car park: the car has to get in. Ridge Road
   passes the overlook lot 0.97 units below its surface -- more than a whole contour step
   -- so the lot stood on a plinth the road ran along the bottom of, and on other maps a lot
   sat as far below the path that serves it. A real lot is graded flush with its drive.

   So each paved lot is re-levelled to its ENTRANCE: the graded profile of the path its
   outline comes closest to, preferring a road or dirt road (what a car arrives on) over a
   footpath within ENTRY_TRAIL_BIAS of it, taken to the top of that path's paint so the
   tarmac meets the tarmac. The lot's cells are then set to that height exactly (a
   fractional band, as a path corridor is), so the slab lies flush on its own ground; where
   the hillside falls away, pieces.js's kerb wall is the retaining wall, and where it rises
   the terrain itself is the cut bank.

   Touching areas move TOGETHER. flattenAreaCells deliberately gave polygons that share
   cells a shared level (this map has lots drawn as several adjoining polygons, and
   buildings standing on lots); re-levelling one member alone would put a step through the
   middle of the car park. Rock formations and water are never pulled in -- a rock is not
   graded to a road, and a pond is the low ground by definition. */
const ENTRY_REACH = 2.5, ENTRY_TRAIL_BIAS = 2.0;
function lotEntrance(members){
  let best = null;
  for(const e of GRAPH.edges){
    if(e.buried || !e.prof || e.prof.pts.length < 2) continue;
    const pr = e.prof, reach = pathOutlineWidth(e.kind)/2 + ENTRY_REACH;
    const isRoad = e.kind === 'road' || e.kind === 'dirtroad';
    const top = drawnTopLifts(e, pr);
    for(const a of members){
      const bb = areaBBox(a);
      for(let i=0;i<pr.pts.length-1;i++){
        const p = pr.pts[i], q = pr.pts[i+1];
        if(Math.max(p[0],q[0]) < bb.mnx - reach || Math.min(p[0],q[0]) > bb.mxx + reach) continue;
        if(Math.max(p[1],q[1]) < bb.mnz - reach || Math.min(p[1],q[1]) > bb.mxz + reach) continue;
        for(const ring of a.rings) for(let k=0;k<ring.length;k++){
          const c = ring[k], d2 = ring[(k+1)%ring.length];
          // nearest approach between the path segment and the outline edge: endpoints of
          // each against the other is exact for non-crossing segments, and a crossing
          // (the road running INTO the lot) is distance zero
          const cands = [
            [ptSeg(c, p, q), 'onPath', c], [ptSeg(d2, p, q), 'onPath', d2],
            [ptSeg(p, c, d2), 'atStation', 0], [ptSeg(q, c, d2), 'atStation', 1],
          ];
          const X = segCross(p, q, c, d2);
          for(const [r, how, which] of cands){
            let d = r.d, t;
            if(how === 'onPath') t = r.t; else t = which;
            if(X){ d = 0; t = X.t != null ? X.t : t; }
            if(d > reach) continue;
            const score = d + (isRoad ? 0 : ENTRY_TRAIL_BIAS);
            if(!best || score < best.score){
              const y = pr.ys[i] + (pr.ys[i+1]-pr.ys[i])*t + top[i] + (top[i+1]-top[i])*t;
              best = {score, d, y, edge:e, x:p[0]+(q[0]-p[0])*t, z:p[1]+(q[1]-p[1])*t};
            }
          }
        }
      }
    }
  }
  return best;
}
function levelLotsToEntrances(){
  const V = VERT_SCALE;
  const flat = a => {
    const st = AREA_STYLE[a.kind];
    return st && !st.landform && a.kind !== 'water' && a.groundY != null;
  };
  const lots = AREAS.filter(a => { const st = AREA_STYLE[a.kind]; return st && st.paved && a.groundY != null; });
  if(!lots.length) return 0;
  const cells = new Map();
  const cellsOf = a => { if(!cells.has(a)) cells.set(a, areaCells(a, pointInArea, areaBBox)); return cells.get(a); };
  const touches = (a, b) => { const A = cellsOf(a), B = cellsOf(b); for(const k of A) if(B.has(k)) return true; return false; };
  const done = new Set();
  let moved = 0;
  for(const seed of lots){
    if(done.has(seed)) continue;
    // grow the group: every flat area sharing a cell with any member
    const group = [seed]; done.add(seed);
    for(let gi=0; gi<group.length; gi++){
      for(const b of AREAS){
        if(done.has(b) || !flat(b)) continue;
        if(touches(group[gi], b)){ group.push(b); done.add(b); }
      }
    }
    const paved = group.filter(a => lots.includes(a));
    const ent = lotEntrance(paved);
    if(!ent) continue;
    // the drawn slab sits LOT_SURFACE_LIFT over its group origin; land that on the paint
    const gy = (ent.y - LOT_SURFACE_LIFT)/V;           // back to raw metres, as groundY is kept
    for(const a of group){
      a.groundY = gy;
      a.entrance = {edge: ent.edge.name, kind: ent.edge.kind, y: ent.y, x: ent.x, z: ent.z};
      setCellsHeightM(cellsOf(a), gy);
    }
    moved += group.length;
  }
  return moved;
}
/* A PATH THAT CROSSES A LOT IS GRADED TO IT. Levelling a lot to its entrance is only half
   of it: other paths can run through the same polygon at the height the hillside had,
   and once the lot is solid a path 2 units below its surface is a path into a wall
   (Juniper Link through central parking), while one a step above it hangs over the lot.
   A real footpath across a car park is at car-park level, so every station of any path
   that lies inside a lot is moved to the lot's surface, and the difference is eased out
   over a ramp either side -- the path walks down (or up) onto the lot instead of meeting
   a kerb.

   The ramp grade is a REAL-WORLD grade, 12% (a steep car-park ramp), converted to world
   units for the current scales: heights scale by VERT_SCALE and horizontal distance by
   MAP_SCALE, so at the default 0.25x elevation the same 12% is 0.15 world-units-per-unit
   at 1:5 and 0.03 at 1:1. A
   fixed world-unit grade was a 25% slope at one scale and a cliff at another.

   If a ramp reaches the end of its edge, the other edges at that node are given the same
   correction, easing out from the node, so a junction beside a lot does not become a step
   between an adjusted edge and its unadjusted neighbours. One level of propagation: a
   ramp longer than a whole neighbouring edge is not a situation this map produces. */
const LOT_RAMP_GRADE = 0.12, LOT_RAMP_MIN = 1.5;
function gradePathsThroughLots(){
  const V = VERT_SCALE;
  const lots = AREAS.filter(a => { const st = AREA_STYLE[a.kind]; return st && st.paved && a.entrance; });
  if(!lots.length) return 0;
  const smooth = t => { t = clamp(t, 0, 1); return t*t*(3 - 2*t); };
  const arcOf = pts => { const A=[0]; for(let i=1;i<pts.length;i++) A[i]=A[i-1]+Math.hypot(pts[i][0]-pts[i-1][0], pts[i][1]-pts[i-1][1]); return A; };
  const adj = new Map();
  for(const e of GRAPH.edges){
    for(const id of [e.a, e.b]){ if(id==null) continue; if(!adj.has(id)) adj.set(id, []); adj.get(id).push(e); }
  }
  let touched = 0;
  for(const a of lots){
    const surf = a.groundY*V + LOT_SURFACE_LIFT;
    const nodeDelta = new Map();       // node id -> {delta, ramp, from edge}
    for(const e of GRAPH.edges){
      const pr = e.prof;
      if(!pr || pr.pts.length < 2) continue;
      const n = pr.pts.length;
      const inside = pr.pts.map(p => pointInArea(p[0], p[1], a));
      if(!inside.some(Boolean)) continue;
      /* Per station, the painted top that station actually has (drawnTopLifts): a stretch
         trimmed back at a road contact shows the ROAD's surface, not the trail's, and
         aiming it at the trail's lift left it 0.09 below the lot. */
      const top = drawnTopLifts(e, pr);
      const T = i => surf - top[i];
      let D = 0;
      for(let i=0;i<n;i++) if(inside[i]) D = Math.max(D, Math.abs(T(i) - pr.ys[i]));
      if(D < 1e-4) continue;
      const ramp = Math.max(LOT_RAMP_MIN, D/(LOT_RAMP_GRADE*V/MAP_SCALE));
      const arc = arcOf(pr.pts);
      const ins = []; for(let i=0;i<n;i++) if(inside[i]) ins.push(arc[i]);
      const old0 = pr.ys[0], oldN = pr.ys[n-1];
      for(let i=0;i<n;i++){
        let sd = Infinity; for(const s0 of ins) sd = Math.min(sd, Math.abs(arc[i]-s0));
        const w = inside[i] ? 1 : smooth(1 - sd/ramp);
        if(w <= 0) continue;
        pr.ys[i] += (T(i) - pr.ys[i])*w;
        pr.hm[i] = pr.ys[i]/V;
      }
      if(Math.abs(pr.ys[0]-old0) > 1e-4 && e.a != null) nodeDelta.set(e.a, {delta: pr.ys[0]-old0, ramp, from: e});
      if(Math.abs(pr.ys[n-1]-oldN) > 1e-4 && e.b != null) nodeDelta.set(e.b, {delta: pr.ys[n-1]-oldN, ramp, from: e});
      touched++;
    }
    for(const [id, nd] of nodeDelta){
      for(const f of (adj.get(id) || [])){
        if(f === nd.from || !f.prof) continue;
        const pr = f.prof, n = pr.pts.length;
        // skip edges this lot already graded (their own ramp set their end)
        if(pr.pts.some(p => pointInArea(p[0], p[1], a))) continue;
        const arc = arcOf(pr.pts), L = arc[n-1];
        for(let i=0;i<n;i++){
          const fromNode = f.a === id ? arc[i] : L - arc[i];
          const w = smooth(1 - fromNode/nd.ramp);
          if(w <= 0) continue;
          pr.ys[i] += nd.delta*w;
          pr.hm[i] = pr.ys[i]/V;
        }
        touched++;
      }
    }
  }
  return touched;
}
// must match pieces.js buildArea's paved slab offset (m.position.y = 0.03)
const LOT_SURFACE_LIFT = 0.03;

/* HOW HIGH THE PAINTED SURFACE IS above an edge's graded profile, per station.

   The profile (e.prof.ys) is the bench the ground was graded to; the ribbons are stacked
   ABOVE it -- casing, shoulder, tread, then the inner stripe or ruts -- and each class is
   lifted again by kindLift so a trail reads on top of a road. Standing on the profile
   therefore put every walker INSIDE that stack, and by a different amount per class: 0.08
   below the top of a road, 0.17 below the top of a trail. That difference is the whole of
   "the trail covers the dog's back paw but the road doesn't".

   So the surface the spatial hash reports is the top of what was actually drawn there:
     - an ordinary stretch: kindLift + TREAD_TOP (the inner stripe / ruts)
     - a footway beside a road: its tread, which is all it draws
     - a deck: the planks, which sit PLANK_LIFT over the tread line
     - a stretch trimmed back at a road contact: the road's own top, because that is the
       surface painted under your feet there (the crosswalk bars sit a hair above it). */
const TREAD_TOP = 0.08, FOOTWAY_TOP = 0.05, PLANK_LIFT = 0.1;
function drawnTopLifts(e, pr){
  const n = pr.pts.length, out = new Array(n);
  const lift = kindLift(e.kind);
  const base = e.buried ? lift + FOOTWAY_TOP : lift + TREAD_TOP;
  const roadTop = kindLift('road') + TREAD_TOP;
  let arc = 0, total = 0;
  for(let i=1;i<n;i++) total += Math.hypot(pr.pts[i][0]-pr.pts[i-1][0], pr.pts[i][1]-pr.pts[i-1][1]);
  const ta = e.trimA || 0, tb = e.trimB || 0;
  for(let i=0;i<n;i++){
    if(i) arc += Math.hypot(pr.pts[i][0]-pr.pts[i-1][0], pr.pts[i][1]-pr.pts[i-1][1]);
    let v = base;
    if(!e.buried && ((ta > 0 && arc < ta) || (tb > 0 && arc > total - tb))) v = roadTop;
    if(pr.deck && pr.deck[i]) v = lift + PLANK_LIFT;
    out[i] = v;
  }
  return out;
}

/* The graded bench itself, with no paint on it: what the crosswalk markings are laid on,
   since they are drawn at their own fixed offsets above it like every other ribbon. */
function benchY(x,z){
  const g = terrainY(x,z,VERT_SCALE);
  const nt = nearestTrail(x,z);
  if(nt.y == null || !(nt.d <= nt.hw) || !nt.edge) return g;
  const e = nt.edge, pr = e.prof;
  if(!pr) return g;
  // undo the drawn lift nearest this point; the lift only varies station to station
  let bi = 0, bd = Infinity;
  for(let i=0;i<pr.pts.length;i++){
    const d = Math.hypot(pr.pts[i][0]-x, pr.pts[i][1]-z);
    if(d < bd){ bd = d; bi = i; }
  }
  const y = nt.y - drawnTopLifts(e, pr)[bi];
  const k = clamp((nt.hw - nt.d)/0.4, 0, 1);
  return g + (y - g)*k;
}

/* Height something STANDS on: the ground, or the trail tread when inside a trail's
   corridor.

   INSIDE THE CORRIDOR THE TREAD WINS OUTRIGHT. This used to be max(ground, tread), on the
   reasoning that the benched ground and the ribbon agree to within a fraction of a unit
   so the max only smoothed off the last of the difference. That reasoning holds only as
   long as EVERY cell under a trail actually got graded, and a cell has many ways to miss:
   the bench claim is a radius test against cell centres, the profile is sampled at
   stations rather than continuously, and both get looser as the DEM is decimated. One
   missed cell is a whole raw band sitting above the ribbon that runs across it, and max()
   turned that into a wall the walker had to climb -- measured at up to 11 units on a
   decimated map, against a step-up limit near 1.

   The ribbon is the thing the player can see and the thing they are walking on, and it is
   smooth by construction (gradeProfile resamples and box-filters it, independent of the
   cell grid). So trust it. The grading fixes below still matter -- they keep the terrain
   from poking up THROUGH the tread, which is a visual problem -- but traversal no longer
   depends on them being perfect, which is the difference between a bug that blocks a walk
   and a bug that looks untidy.

   The 40 cm ease across the corridor edge is unchanged and now carries the whole
   transition: off-trail you get plain terrain, on-trail you get the tread, and the blend
   between them is short enough to read as a kerb rather than a ramp. Where the ground
   beside a trail stands well above it the ease is steep, but that edge is a cut bank and
   moveOffTrail's step-up limit already refuses to walk up it -- which is correct, and is a
   different thing from being unable to walk ALONG the trail.

   Off-trail it is plain terrainY: no inflation, no floating near a rise. */
function standingY(x,z){
  let g = terrainY(x,z,VERT_SCALE);
  // in visible water, stand at wading depth (see WADE_FRACTION); a path over or through
  // the water still wins below, because its tread is what you are on there
  const ws = waterSurfaceAt(x,z);
  if(ws != null && g < ws + WATER_SHOWS) g = wadeSurfaceAt(x,z) - WADE_DEPTH;
  const nt = nearestTrail(x,z);
  if(nt.y == null || !(nt.d <= nt.hw)) return g;
  // ease over the outer 40 cm of the corridor so stepping onto a trail that sits a hair
  // proud of the dirt isn't a visible pop. Unscaled, like the corridor width it eases
  // across -- both are true metres now.
  const k = clamp((nt.hw - nt.d)/0.4, 0, 1);
  return g + (nt.y - g)*k;
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
  if(!layers.length){ MAP_LATLON=null; setSkyPlace(null, null, true); applyThemeLighting(); return; }
  // A bundle's own projection is authoritative whenever one is loaded; the fallback only
  // covers the no-DEM case, where there's no heightfield to stay aligned with anyway.
  const PROJ = BUNDLE || fallbackProjector(layers);
  if(!PROJ) return;

  // merge the bundle's own layers with anything dropped in-session, classify each
  // feature, then project every coordinate through the bundle's own projection so
  // vectors and the heightfield are guaranteed aligned
  const rawLines=[], rawPoints=[], rawAreas=[], rawWaters=[];
  for(const layer of layers){
    const F=parseFeatures(layer);
    rawLines.push(...F.lines); rawPoints.push(...F.points); rawAreas.push(...F.areas);
    rawWaters.push(...(F.waters||[]));
  }
  /* CROPPED TO THE DEM whenever a bundle is loaded. Outside the heightfield rectangle
     terrain.js reads the clamped edge cell, so anything past the edge sits on a smeared
     copy of the rim -- and a polygon reaching past it gets graded against those copies
     too. The rectangle is the bundle's own, in the same projected units as everything
     below, so this holds at every World scale. Without a bundle there is nothing to crop
     to and every layer is kept whole. Done here, before the graph, so topology, the
     minimap, the bbox and every later pass see one cropped copy of the geometry. */
  const R = BUNDLE ? demRect(BUNDLE) : null;
  CROP = {lines:0, points:0, areas:0, waterways:0};
  let lines=[];
  for(const L of rawLines){
    const pts=PROJ.projectCoords(L.pts);
    const runs=R ? clipLineToRect(pts,R) : [pts];
    if(R && pts.some(c=>!inRect(c[0],c[1],R))) CROP.lines++;
    for(const run of runs) lines.push({name:L.name,kind:L.kind,paved:L.paved,ford:L.ford,rackTag:!!L.rackTag,bridge:!!L.bridge,pts:run});
  }
  // the source's own bridge ways, kept aside: buildGraph snaps most of them out of
  // existence (see planBridges), so they survive only as hints for where spans go
  const bridgeHints=lines.filter(L=>L.bridge).map(L=>L.pts);
  WATERWAYS.length=0;
  for(const W of rawWaters){
    const pts=PROJ.projectCoords(W.pts);
    const runs=R ? clipLineToRect(pts,R) : [pts];
    if(R && pts.some(c=>!inRect(c[0],c[1],R))) CROP.waterways++;
    for(const run of runs)
      WATERWAYS.push({name:W.name, kind:W.kind, width:W.width, intermittent:!!W.intermittent,
                      pts:run, prof:null});
  }
  const points=[];
  for(const P of rawPoints){
    const p=PROJ.project(P.ll[0],P.ll[1]);
    if(R && !inRect(p.x,p.z,R)){ CROP.points++; continue; }
    points.push({name:P.name,kind:P.kind,props:P.props,p});
  }
  // projectCoords() already returns plain [x,z] pairs at every leaf (verified against
  // world_bundle.js: it recurses until coords[0] is a number, then returns [p.x,p.z] --
  // never {x,z} objects). Re-mapping through .x/.z here, as areas previously did, reads
  // undefined off a plain array and collapses every polygon to NaN bounds -- confirmed by
  // running the real pipeline against a synthetic bundle, not assumed.
  /* A polygon's outer ring decides whether it survives; a hole cut away to nothing is
     simply dropped, which is what a hole entirely off the map should do. */
  const areasProjected=[];
  for(const A of rawAreas){
    let rings=A.rings.map(r=>PROJ.projectCoords(r));
    if(R){
      const outer=clipRingToRect(rings[0],R);
      if(!outer){ CROP.areas++; continue; }
      if(outer.length!==rings[0].length || !rings[0].every(c=>inRect(c[0],c[1],R))) CROP.areas++;
      rings=[outer, ...rings.slice(1).map(r=>clipRingToRect(r,R)).filter(Boolean)];
    }
    areasProjected.push({name:A.name,kind:A.kind,props:A.props,rings});
  }

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
  PATH_MIX.bridges = planBridges(bridgeHints);
  /* Landmarks and fixtures part here. A fixture kind with a NAME stays a landmark: an
     unnamed pylon is scenery, but "Barr Camp Information Board" is somewhere. */
  const isFixture=p=>{ const st=POI_STYLE[p.kind]; return !!(st && st.fixture) && !p.name; };
  POIS=points.filter(p=>!isFixture(p)).map(p=>({name:p.name,kind:p.kind,props:p.props,x:p.p.x,z:p.p.z,found:false}));
  FIXTURES=points.filter(isFixture).map(p=>({name:p.name,kind:p.kind,props:p.props,x:p.p.x,z:p.p.z}));
  AREAS=areasProjected;
  // WATER is taken after flattenAreaCells below: a polygon it leaves as cover has no
  // surface drawn, so it must not count as somewhere to wade

  let mx=1e9,Mx=-1e9,mz=1e9,Mz=-1e9;
  const grow=(x,z)=>{mx=Math.min(mx,x);Mx=Math.max(Mx,x);mz=Math.min(mz,z);Mz=Math.max(Mz,z);};
  GRAPH.edges.forEach(e=>e.pts.forEach(p=>grow(p[0],p[1])));
  POIS.forEach(p=>grow(p.x,p.z));
  AREAS.forEach(a=>a.rings[0].forEach(c=>grow(c[0],c[1])));
  bboxW={minx:mx,maxx:Mx,minz:mz,maxz:Mz};
  const rng=mulberry(1337);

  /* WHERE ON EARTH THIS MAP IS, taken from the centre of what was actually built rather
     than from the projection origin. The origin is a corner of the DEM and can sit a
     kilometre or two off the trail network; the centre of the bbox is where the walking
     happens, and it is the point the sun, the moon and the time zone should be computed
     for. Run through whichever projector built the map, so a bundle and a bare pair of
     .geojson files answer identically. Before applyThemeLighting, because that is what
     asks sky.js to relight the scene and it should do so knowing where it is. */
  MAP_LATLON = null;
  if(typeof PROJ.unproject === 'function'){
    const c = PROJ.unproject((mx+Mx)/2, (mz+Mz)/2);
    if(c && Number.isFinite(c.lat) && Number.isFinite(c.lon))
      MAP_LATLON = {lat:c.lat, lon:c.lon, zSouth: (PROJ.zSign == null ? 1 : PROJ.zSign) >= 0};
  }
  setSkyPlace(MAP_LATLON ? MAP_LATLON.lat : null,
              MAP_LATLON ? MAP_LATLON.lon : null,
              MAP_LATLON ? MAP_LATLON.zSouth : true);

  applyThemeLighting();
  backdropG=buildBackdrop(THEME,rng,MAP_SCALE);
  worldG.add(backdropG);
  /* The horizon ring is rebuilt here and nowhere else, and it is the one thing in the
     scene that has to be re-tinted by hand at night (MeshBasicMaterial, fog-exempt: see
     sky.js's tintBackdrop). Handing the new group over at the moment it is created keeps
     that a push rather than a per-frame lookup. */
  setSkyBackdrop(backdropG);

  setWorld(BUNDLE || null);
  setStep(STEP_M);

  // ground: with a DEM the terrace mesh IS the heightfield, already in real-metre world
  // coordinates. Without one, a single flat plane covering the map's extent -- so a bare
  // pair of .geojson files is still playable, just level.
  // the TERRAIN alone gets cover painting (ground-cover.js): paths, lots and decks keep their own surfaces
  const groundMat=patchGroundCover(patchGroundRing(new THREE.MeshToonMaterial({map:groundTexture(THEME),
    gradientMap:toonTex, polygonOffset:true, polygonOffsetFactor:2, polygonOffsetUnits:2})));
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
  WATER=AREAS.filter(a=>a.kind==='water' && !a.cover);
  /* Scree ground: every rock-family polygon left as COVER paints its cells as broken
     stone (ground-cover.js). A graded rock is an extruded mass and already looks like
     rock; a cover one is a hillside, and the hillside is what has to change. */
  { const scree=AREAS.filter(a=>a.cover && AREA_STYLE[a.kind] && AREA_STYLE[a.kind].landform);
    setGroundCover(BUNDLE && scree.length ? BUNDLE : null,
                   scree.length ? (x,z)=>scree.some(a=>pointInArea(x,z,a)) : null); }

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
  /* Channels are graded from the same untouched band grid the paths just read, then the
     bridges lift their paths over them -- which needs both profiles -- and only then does
     anything get written back into the grid. */
  /* Lots level with the road into them -- after the path profiles exist (the entrance
     height IS a graded profile) and before the benches are written back, so a road's own
     bench still wins the cells it runs over. */
  PATH_MIX.lotsLevelled = levelLotsToEntrances();
  PATH_MIX.lotRamps = gradePathsThroughLots();
  gradeWaterways();
  const bridgeZones = raiseBridgeDecks();
  const claimedCells = gradeTrailCells(GRAPH.edges.map(e=>e.prof),
                  WATERWAYS.map(w=>w.prof).filter(Boolean), bridgeZones);
  // creek banks step down to the water instead of standing as slot walls (terrain.js);
  // a graded area (a lot, a building pad) keeps its own level
  PATH_MIX.bankCells = stepChannelBanks(WATERWAYS.map(w=>w.prof).filter(Boolean), claimedCells, vm(WATER_U),
    (x,z) => AREAS.some(a => a.groundY != null && a.kind !== 'water' && pointInArea(x, z, a)));
  hashWater();
  // hash before any geometry: buildArea's ground-cover scatter and buildAreaSign both
  // call nearestTrail, and standingY now needs tread heights too
  GRAPH.edges.forEach(e=>{
    const pr = e.prof, hw = (pathWidth(e.kind)+1.5)/2;
    const top = drawnTopLifts(e, pr);
    for(let i=0;i<pr.pts.length-1;i++)
      hashSeg({a:pr.pts[i], b:pr.pts[i+1], edge:e, ya:pr.ys[i]+top[i], yb:pr.ys[i+1]+top[i+1], hw,
               deck: !!(pr.deck && pr.deck[i] && pr.deck[i+1])});
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
  /* Registered from the SAME list, in the same pass, as the meshes -- so a polygon that
     failed to build (the catch below) never leaves an invisible wall behind it. */
  AREA_SOLIDS.length=0;
  AREAS.forEach((a,ai)=>{ try{
    const ag=buildArea(a,rng,groundYAt,nearestTrail,VERT_SCALE); ag.name='area:'+ai; worldG.add(ag);
    ag.traverse(o=>{ if(o.userData && o.userData.areaLabel) AREA_LABELS.push(o); });
    const st=AREA_STYLE[a.kind];
    // `top` comes off the built group, so the surface the player stands on is by
    // construction the top of the mesh they can see -- see pieces.js's buildArea
    // cover has no mass to stand on or bump into -- see flattenAreaCells
    if(st && st.solid && !a.cover) AREA_SOLIDS.push({area:a, kind:a.kind, bb:areaBBox(a),
                                         top:ag.userData ? ag.userData.solidTop : null,
                                         // the drawn surface reaches this far past the
                                         // outline; see pieces.js's buildLandform
                                         inflate:(ag.userData && ag.userData.solidInflate) || 0});
  }catch(err){ console.warn('area skipped',a.name,err); } });

  // Path colour/texture follows the source file's own highway/kind tag (pathKind, in
  // geo.js): a footpath stays themed dirt, a service road reads as a distinct paved grey
  // with a dashed centreline, a double-track gets worn wheel ruts instead of one groove.
  /* Surface decides the palette as much as class does. A dirt road is the theme's own
     dirt lightened toward gravel, so it belongs to the landscape it runs through; a
     sealed footpath or cycleway is pale concrete with no ruts, stones or blazes, which is
     how a paved path in a park actually reads next to a singletrack. */
  const gravel = (hex, f) => {
    const c = new THREE.Color(hex), g = new THREE.Color('#a39a8a');
    const mix = (a, b) => clamp((a + (b-a)*0.45)*f, 0, 1);
    return '#'+new THREE.Color(mix(c.r,g.r), mix(c.g,g.g), mix(c.b,g.b)).getHexString();
  };
  const PATH_STYLE={
    trail:{deco:true, tread:THEME.tread, inner:THEME.inner, shoulder:THEME.shoulder},
    track:{deco:true, ruts:true, tread:shade(THEME.tread,0.86), inner:shade(THEME.tread,0.6), shoulder:THEME.shoulder},
    dirtroad:{deco:false, ruts:true, tread:gravel(THEME.tread,1.0), inner:gravel(THEME.inner,1.0),
              rut:gravel(THEME.tread,0.72), shoulder:shade(THEME.shoulder,0.95)},
    road:{deco:false, dashes:true, tread:'#716d64', inner:'#8a867a', shoulder:'#4a473f'},
    paved_trail:{deco:false, tread:'#b4aea2', inner:'#c3bdb1', shoulder:'#6e695f'},
    paved_track:{deco:false, tread:'#9a958b', inner:'#aca79c', shoulder:'#5c584f'},
    /* Railway: the tread is the ballast bed (crushed grey stone, a shade warmer than the
       tarmac so the two never read as one where they meet), the shoulder its sloping
       edge. No inner stripe, ruts or dashes -- the sleepers and rails drawn on top ARE the
       detail. */
    rail:{deco:false, rail:true, tread:'#8a847a', inner:'#8a847a', shoulder:'#6a655d',
          tie:'#5b4331', steel:'#b9bcc0', rackCol:'#4a4c50', tooth:'#9ea2a8'},
  };
  const styleOf = e => PATH_STYLE[styleKey(e)] || PATH_STYLE.trail;
  // one ink material per class rank, so the outline of a path sitting on top of another
  // carries the same depth bias as the surface it belongs to
  const inkMats=[0,1,2].map(L=>trailMat(INK,L));
  /* Draw the most-built surface first and the least-built last. Depth bias already
     decides who wins, but painter's order costs nothing and makes the result stable even
     where two surfaces are exactly coplanar and the bias ties. */
  const drawOrder=GRAPH.edges.slice().sort((a,b)=>pathRank(a.kind)-pathRank(b.kind));
  const railPlan=planRails(GRAPH.edges);
  /* Deck and railings over every run of bridge stations on this edge. Built from the
     (possibly trimmed) profile the ribbon itself was drawn from, so the planks sit exactly
     on the tread they cover. A paved road gets a concrete slab and parapet and keeps its
     own tarmac as the surface; everything else gets planks. */
  const PLANKS=['#9b6b3e','#86593a'];
  function buildDecks(e, pr, W, lift){
    if(!pr || !pr.deck || !pr.ys) return;
    const concrete = e.kind==='road';
    let i=0;
    while(i<pr.pts.length){
      if(!pr.deck[i]){ i++; continue; }
      let j=i;
      while(j+1<pr.pts.length && pr.deck[j+1]) j++;
      if(j>i){
        const pts=pr.pts.slice(i, j+1), ys=pr.ys.slice(i, j+1);
        const width=W*OUTLINE_MUL*1.08;
        if(!concrete){
          const dg=bridgeDeckGeom(pts, ys.map(y=>y+lift+0.1), width, PLANKS);
          if(dg){ const m=new THREE.Mesh(dg, deckMat()); m.name='bridge-deck'; worldG.add(m); }
        }
        const fg=bridgeFrameGeom(pts, ys.map(y=>y+lift+(concrete?0.06:0.1)), width,
                                 concrete?'concrete':'wood');
        if(fg){
          const m=new THREE.Mesh(fg, frameMat(concrete?'#b1aba0':'#6f4726'));
          m.name='bridge-frame'; worldG.add(m);
        }
      }
      i=j+1;
    }
  }
  drawOrder.forEach(e=>{
    const st=styleOf(e);
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
    /* Top heights for a fill embankment, with every bridge station knocked out: NaN
       fails embankmentGeom's drop test, which ends the strip there. A skirt under a deck
       is a dam across the creek. */
    const skirtTops = (pr, add) => pr.ys.map((v,i)=> (pr.deck && pr.deck[i]) ? NaN : v+add);
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
      // a footway beside a road floats over a drop exactly as a trail does; skirt it too
      if(hs){
        const sk = embankmentGeom(rpts, fw*1.35*0.5, skirtTops(prof, lift+0.01),
                                  (x,z)=>terrainY(x,z,VERT_SCALE), buriesTread, waterEdgeDist);
        if(sk) worldG.add(new THREE.Mesh(sk, trailMat(shade(st.shoulder,0.86),rank)));
      }
      // a kerb belongs to tarmac; a path beside a dirt road just runs along its edge
      if(e.buried.kind==='road')
        worldG.add(new THREE.Mesh(ribbonGeom(kerbPts,kerb,lift+0.03,hs),trailMat('#cdc3ad',rank)));
      worldG.add(new THREE.Mesh(ribbonGeom(rpts,fw*1.35,lift+0.012,hs),inkMats[rank]));
      worldG.add(new THREE.Mesh(ribbonGeom(rpts,fw,lift+0.05,hs),trailMat(st.tread,rank)));
      buildDecks(e, prof, fw, lift);
      return;
    }

    /* Skirt FIRST, under everything else: it is ground, and the casing and tread are
       painted on top of ground. Built from the outline width so the fill starts where the
       ink ends and no ribbon layer overhangs it. */
    if(hs){
      const skirt = embankmentGeom(rpts, W*OUTLINE_MUL*0.5, skirtTops(prof, lift+0.01),
                                   (x,z)=>terrainY(x,z,VERT_SCALE), buriesTread, waterEdgeDist);
      if(skirt) worldG.add(new THREE.Mesh(skirt, trailMat(shade(st.shoulder,0.86),rank)));
    }
    worldG.add(new THREE.Mesh(ribbonGeom(rpts,W*OUTLINE_MUL,lift+0.012,hs),inkMats[rank]));
    worldG.add(new THREE.Mesh(ribbonGeom(rpts,W*SHOULDER_MUL,lift+0.02,hs),trailMat(st.shoulder,rank)));
    worldG.add(new THREE.Mesh(ribbonGeom(rpts,W,lift+0.05,hs),trailMat(st.tread,rank)));
    if(st.rail){
      const tg=railTrackGeoms(rpts, hs, lift, railPlan.tieGap, railPlan.rack.has(e));
      const add=(geo,col,name)=>{ if(!geo) return; const m=new THREE.Mesh(geo,toon(col)); m.name=name; worldG.add(m); };
      add(tg.ties, st.tie, 'rail-ties');
      add(tg.rails, st.steel, 'rail-rails');
      add(tg.rack, st.rackCol, 'rail-rack');
      add(tg.teeth, st.tooth, 'rail-teeth');
      if(tg.ties) RAIL_STATS.ties += tg.ties.attributes.position.count/18;
      buildDecks(e, prof, W, lift);
      return;
    }
    if(st.ruts){
      const rutMat=trailMat(st.rut || shade(st.tread,0.55),rank);
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
    buildDecks(e, prof, W, lift);
  });

  /* Creeks. Bed first (wet gravel, the full channel width, lying in the notch the bench
     cut), then the water, then a narrow pale band down the middle -- the toon shader's
     answer to a glint. Rank 0 bias, below every path: where a creek runs under a verge the
     verge wins, and under a bridge there is nothing at path level to fight. */
  const WATER_COL = AREA_STYLE.water ? AREA_STYLE.water.fill : '#5c9fd6';
  for(const w of WATERWAYS){
    const pr=w.prof;
    if(!pr || pr.pts.length<2) continue;
    const bedY=pr.hm.map(h=>h*VERT_SCALE);
    const wetY=bedY.map(y=>y+WATER_U);
    const col = w.intermittent ? '#7fa9bf' : WATER_COL;
    const bed = new THREE.Mesh(ribbonGeom(pr.pts, channelHalf(w)*2, 0.03, bedY), trailMat(shade(THEME.shoulder,0.8),0));
    bed.name='water-bed';
    worldG.add(bed);
    const water = new THREE.Mesh(ribbonGeom(pr.pts, w.width, 0.0, wetY), trailMat(col,0));
    water.name='water';
    worldG.add(water);
    // the sides, down to the bed (pieces.js waterSideGeom): without them the margin strip
    // of bed let you see in under the surface, wading paws included
    const sides = waterSideGeom(pr.pts, w.width/2, wetY, bedY.map(y=>y+0.03));
    if(sides){ const m = new THREE.Mesh(sides, trailMat(shade(col,0.82),0)); m.name='water-side'; worldG.add(m); }
    worldG.add(new THREE.Mesh(ribbonGeom(pr.pts, w.width*0.28, 0.03, wetY), trailMat(shade(col,1.35),0)));
  }

  /* Crossings go on AFTER every ribbon, because they are markings painted on a finished
     road: standingY (not terrainY) so the stripes sit on the tread the road actually
     rendered at rather than on the terrace underneath it. */
  CROSSINGS.forEach(rec=>{
    try{ worldG.add(buildCrossing(rec, benchY)); }
    catch(err){ console.warn('crossing skipped', err); }
  });

  AREAS.forEach(a=>{ if(a.name){
    const sg=buildAreaSign(a,groundYAt,nearestTrail,(x,z)=>pushOffPaths(x,z,AREA_SIGN_CLEAR));
    sg.__areaSign=true;               // test seam: found by the smoke harness like fingerposts
    worldG.add(sg);
  } });

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
    const here=adj[ni];
    /* JUNCTION FILLS, one per drawn style, covering only what the arms' own ribbons
       leave open (pieces.js junctionGapGeom). An arm is left out when it was TRIMMED at
       this node: a trail cut back to the verge of a road no longer reaches the node, so
       giving it a pad there put a dirt disc in the middle of the tarmac -- which is what
       used to happen at every road contact that was not a marked crossing (the crossing
       case had its own exception; this is the general rule it was a special case of).
       Each layer is filled at its own width and height, so nothing is wider than the
       ribbon it joins, and the fill sits at the arms' end height, flush with their butt
       edges. Also run at degree 2 now: two edges of one road meeting at a bend node
       leave the same outer wedge as a bend inside an edge does. */
    if(n.deg>=2){
      const groups=new Map();
      for(const e of here){
        if(e.buried || !e.prof || e.prof.pts.length<2) continue;
        const ends=[];
        if(e.a===ni && !(e.trimA>0)) ends.push('a');
        if(e.b===ni && !(e.trimB>0)) ends.push('b');
        for(const end of ends){
          const pp=e.prof.pts, ys=e.prof.ys;
          const p0=end==='a'?pp[0]:pp[pp.length-1], p1=end==='a'?pp[1]:pp[pp.length-2];
          const y0=end==='a'?ys[0]:ys[ys.length-1];
          const key=styleKey(e);
          const g=groups.get(key)||{kind:e.kind, key, angs:[], ys:[]};
          g.angs.push(Math.atan2(p1[1]-p0[1], p1[0]-p0[0])); g.ys.push(y0);
          groups.set(key,g);
        }
      }
      for(const g of groups.values()){
        // a style with a single arm here gets a half-disc: the path's rounded end where
        // it meets a different kind of path
        const rank=pathRank(g.kind), lift=kindLift(g.kind);
        const st=PATH_STYLE[g.key]||PATH_STYLE.trail;
        const W=pathWidth(g.kind);
        const yb=g.ys.reduce((a,b)=>a+b,0)/g.ys.length;
        const layers=[[W*OUTLINE_MUL/2, 0.012, inkMats[rank]],
                      [W*SHOULDER_MUL/2, 0.02, trailMat(st.shoulder,rank)],
                      [W/2, 0.05, trailMat(st.tread,rank)]];
        for(const [r, dy, mat] of layers){
          const geo=junctionGapGeom(n.p[0], n.p[1], yb+lift+dy, g.angs, r);
          // test seam: which kind of path this fill belongs to, and the ribbon width it matches
          if(geo){ geo.__gapKind=g.kind; geo.__gapR=r; worldG.add(new THREE.Mesh(geo, mat)); }
        }
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
      // tx/tz: the point the arm is aimed AT, kept so the angle can be re-measured from
      // wherever the post finally stands rather than from the node it was set back from
      return{label:o.e.name, route:o.e.route, kind:o.e.kind, named:!!o.e.named,
             distU:reach.dist, dist:distLabel(reach.dist), angle:Math.atan2(az,ax),
             tx:n.p[0]+ax, tz:n.p[1]+az, buried:!!o.e.buried};
    };
    /* WHERE THE POST GOES. A fingerpost stands BESIDE the paths it names, never on one.

       It used to be planted on the node itself -- dead centre of the junction, in the
       tread -- and only moved if that happened to be a road. At a crossing the landing
       beside the markings is still the answer. Everywhere else the post goes into the
       widest open wedge between the arms, set back along that wedge's bisector just far
       enough that the nearest arm's painted edge clears it by POST_CLEAR -- a narrow wedge
       needs a longer set-back to get the same clearance, which is the sin() below. A dead
       end (trailhead) is a one-armed junction whose open wedge is everything behind it,
       so the same rule puts its post off to one side of the gate. Then a general push
       clear of every drawn path, since the wedge only knows about the arms at THIS node. */
    let sx=n.p[0], sz=n.p[1];
    const xing=crossingAt(ni);
    if(xing){
      const nxr=-xing.dir[1], nzr=xing.dir[0];
      const off=xing.trim + xing.walkW*0.5;
      sx=n.p[0]+nxr*off; sz=n.p[1]+nzr*off;
    }else if(out.length){
      const angs=[]; let hwMax=0;
      for(const o of out){
        let ax=0,az=0,acc=0,i=1;
        while(i<o.pts.length&&acc<2.5){ax=o.pts[i][0]-n.p[0];az=o.pts[i][1]-n.p[1];acc=Math.hypot(ax,az);i++;}
        if(acc>1e-6) angs.push(Math.atan2(az,ax));
        hwMax=Math.max(hwMax, pathOutlineWidth(o.e.kind)/2);
      }
      angs.sort((a,b)=>a-b);
      let gap=2*Math.PI, bis=0;
      if(angs.length===1){ gap=2*Math.PI; bis=angs[0]+Math.PI; }
      else if(angs.length>1){
        gap=-1;
        for(let k=0;k<angs.length;k++){
          const a=angs[k], b=k+1<angs.length?angs[k+1]:angs[0]+2*Math.PI;
          if(b-a>gap){ gap=b-a; bis=(a+b)/2; }
        }
      }
      if(angs.length){
        // a trailhead post goes to the SIDE of the path (the gate straddles the end), a
        // little way up it so it is not in the arch's footprint
        if(angs.length===1){
          const a=angs[0], side=Math.PI/2;
          const r=hwMax+POST_CLEAR+0.5;
          sx=n.p[0]+Math.cos(a+side)*r+Math.cos(a)*1.6;
          sz=n.p[1]+Math.sin(a+side)*r+Math.sin(a)*1.6;
        }else{
          const half=Math.max(gap/2, 0.35);
          const r=Math.min((hwMax+POST_CLEAR)/Math.sin(Math.min(half, Math.PI/2)), (hwMax+POST_CLEAR)*3);
          sx=n.p[0]+Math.cos(bis)*r; sz=n.p[1]+Math.sin(bis)*r;
        }
      }
    }
    const clearPt=pushOffPaths(sx, sz, POST_CLEAR);
    sx=clearPt[0]; sz=clearPt[1];
    const sy=terrainY(sx, sz, VERT_SCALE);

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
      // re-aim every arm from where the post actually stands: measured from the node, an
      // arm on a set-back post points a metre or two off its trail
      const arms = c.s.arms.map(a => (a.tx==null) ? a :
        Object.assign({}, a, {angle:Math.atan2(a.tz-at.p[1], a.tx-at.p[0])}));
      const sg=buildSign(at, arms); sg.position.y=c.s.y; worldG.add(sg);
    });
    SIGN_COUNT = {wanted:signWanted.length, built:kept.length, minGap};
  }

  // decorative edge stones + blaze posts
  const stoneMat=toon(THEME.rocks[0]);
  GRAPH.edges.forEach(e=>{
    const st=styleOf(e);
    if(!st.deco) return;
    // no edge stones on a deck, and no blaze post planted in the creek below it
    const spans=BRIDGES.filter(b=>b.edges.includes(e));
    const onSpan=(x,z)=>spans.some(b=>Math.hypot(b.x-x, b.z-z) < b.half+0.8);
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
        if(onSpan(sx,sz)) continue;
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
        if(onSpan(bx,bz) || waterEdgeDist(bx,bz) < 0.4){ blazeAcc=30; continue; }
        const bz3=buildBlaze(bx,bz,e.color); bz3.position.y=terrainY(bx,bz,VERT_SCALE); worldG.add(bz3);
      }
    }
  });

  // POIs
  POIS.forEach(p=>{
    /* A station stands beside its track, not on it: it is turned to face the nearest
       railway and set back so its platform edge meets the ballast. If the map also has
       the station's own footprint (a depot or platform area close by), only the name
       board goes up -- the real building is already there. Rotation for a station comes
       from the track; every other landmark keeps its random turn. The draws are made in the
       original order (model, then turn) whether or not the turn is used, so neither the
       models here nor the scenery after this loop shift on any existing map. */
    const place=p.kind==='station' ? placeStation(p) : null;   // no rng: before or after is moot
    const grp=buildPOI(p,rng);
    const spin=rng()*6.28;                                      // same draw, same order as always
    p.at = place;                     // test seam: where a station actually went
    if(place){ grp.position.set(place.x,terrainY(place.x,place.z,VERT_SCALE),place.z); grp.rotation.y=place.rot; }
    else{ grp.position.set(p.x,terrainY(p.x,p.z,VERT_SCALE),p.z); grp.rotation.y=spin; }
    worldG.add(grp);
  });
  buildFixtures();

  // scenery
  const clearOfPOI=(x,z,r)=>!POIS.some(p=>Math.hypot(p.x-x,p.z-z)<r) && !FIXTURES.some(p=>Math.hypot(p.x-x,p.z-z)<r);
  const inWater=(x,z)=>WATER.some(a=>pointInArea(x,z,a));
  const offTrail=(x,z,r)=>nearestTrail(x,z).d>r&&clearOfPOI(x,z,7)&&!inWater(x,z)
                          &&waterEdgeDist(x,z)>Math.min(r,2.5);
  const pad=70, W=Mx-mx+pad*2, H=Mz-mz+pad*2;
  let placed=0,tries=0;
  const targetTrees=Math.min(560,W*H/450*THEME.treeDensity);
  /* Where a scenery tree may stand: off the paths and water, and not on scree -- scree is
     above the tree line. One predicate, kept as TREE_SPOT for the harness, so the rule is
     tested directly rather than by hoping a random tree lands in the wrong place. */
  const treeSpot=(x,z)=>offTrail(x,z,4.2) && !groundCoverAt(x,z);
  TREE_SPOT=treeSpot;
  while(placed<targetTrees&&tries++<targetTrees*7){
    const x=mx-pad+rng()*W, z=mz-pad+rng()*H;
    if(!treeSpot(x,z)) continue;
    const t=makeTree((1.1+rng()*1.6)*THEME.treeScale,pickTree(rng),rng);
    t.position.set(x,terrainY(x,z,VERT_SCALE),z); t.rotation.y=rng()*7;
    t.name='scenery-tree';              // test seam: the harness checks where these grow
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
    if(waterEdgeDist(x,z)<0.3) continue;
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

  markReceivers();
}

/* THE LANDSCAPE CATCHES SHADOWS; the avatar only casts them.

   Until day/night lighting there was nothing in this game with receiveShadow set, on any
   mesh, anywhere -- so the renderer was rendering a shadow map every frame on medium and
   high tier that not one draw call ever sampled. Turning receiving ON here is the half of
   that fix that lives in the world; sky.js owns the other half (where the light is, and
   whether it casts at all).

   ONE TRAVERSE OVER EVERYTHING IN worldG, rather than picking out the ground mesh. A
   shadow that stops dead at the edge of a trail is worse than no shadow: the ribbons sit
   five centimetres above the terrain and are exactly where a walker is looking, so a pine
   throwing a shadow across the tread has to land on the tread. Rocks and trees receiving
   as well costs nothing extra and means a stand of pines shades itself.

   The one cost worth naming: three.js keys its shader programs partly on receiveShadow,
   so a toon material shared between a tree here (receiving) and the pup's rig (not)
   compiles twice. That is a handful of the ~85 shared materials, paid once at warm-up
   behind the loader, against a shadow pass that currently renders for nothing.

   Deliberately NOT applied to the horizon ring: it is MeshBasicMaterial, which has no
   lighting model to receive into, and it is ten thousand units away from any shadow
   camera. sky.js tints it by hand instead. */
function markReceivers(){
  if(!worldG) return;
  worldG.traverse(o=>{
    if(!o.isMesh) return;
    if(backdropG && o.parent === backdropG) return;
    o.receiveShadow = true;
  });
}

function mulberry(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);
  t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}

function getBackdrop(){ return backdropG; }

export { loadWorld, rebuildWorld, addLayers, clearLayers, hasBundle, setContourStep,
         standingY, getWorldRevision, pathWidth, getContourStep, getSignCount, getPathMix, getMapId, getMapLatLon, getCrossings,
         pathRank, kindLift, pathOutlineWidth, getWaterways, getBridges, inWaterway, waterSurfaceAt, waterSurfaceInfo, wadeSurfaceAt, setWadeLegLength, wadeDepth, wadeReach, styleKey,
         getAreaLabels, updateAreaLabels, getAreaSolids, areaBlocked, areaSolidTop, lineOfSight, nearestSolidFace, solidEmbed, distToSolid,
         setThemeById, getTheme, setMapScale, getMapScale, getExaggeration, getBackdrop,
         setFogMultiplier, getFogMultiplier, setTerrainQuadBudget, getDemStride, applyThemeLighting,
         getGraph, getTrailheads, getPOIs, getFixtures, treeSpotOK, getPowerSpans, getRailStats, getAreas, getBBox, getCropStats,
         getWorldGroup, setStartHead, getStartHead, setVertScale, getVertScale, compass, THEMES, THEME };
