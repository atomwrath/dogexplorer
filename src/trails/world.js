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
import { buildTerrainMesh, flattenAreaCells, groundTexture, resample, setStep, setWorld, stationHeights, terrainY } from './terrain.js';

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
let backdropG=null;             // horizon ring, re-centred on the camera by main.js
let bboxW={minx:0,maxx:0,minz:0,maxz:0};
let EXTRA=[];                   // raw GeoJSON FeatureCollections dropped in-session
let STEP_M=3;                   // contour step in metres, remembered across rebuilds

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
let EXAG=1.8;
let MAP_SCALE=1;
let VERT_SCALE=EXAG*MAP_SCALE;

function setStartHead(i){ startHead=i; }
function getStartHead(){ return startHead; }
function syncScales(){ VERT_SCALE=EXAG*MAP_SCALE; }
function setVertScale(v){ EXAG=Math.max(0.3,v); syncScales(); rebuildWorld(); }
function getVertScale(){ return VERT_SCALE; }
function getExaggeration(){ return EXAG; }
function getMapScale(){ return MAP_SCALE; }
function setMapScale(v){
  MAP_SCALE=clamp(Number(v)||1, 0.15, 4);
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
   directly rather than added to the disposable group. */
function applyThemeLighting(){
  scene.background=new THREE.Color(THEME.sky);
  scene.fog=new THREE.Fog(new THREE.Color(THEME.sky).getHex(),
                          THEME.fogNear*MAP_SCALE, THEME.fogFar*MAP_SCALE);
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

function buildTrailheads(){
  TRAILHEADS=[];
  if(!GRAPH) return;
  GRAPH.nodes.forEach((n,ni)=>{
    if(n.deg!==1) return;
    const e=GRAPH.edges.find(e=>e.a===ni||e.b===ni);
    let yaw=0;
    if(e){
      const pts=e.a===ni?e.pts:[...e.pts].reverse();
      yaw=Math.atan2(-(pts[1][1]-pts[0][1]),pts[1][0]-pts[0][0]);
    }
    TRAILHEADS.push({node:ni,x:n.p[0],z:n.p[1],yaw,
      name:e?e.name:'Trail',color:e?e.color:'#b58347',
      lenM:e?e.lenM:0,where:compass(n.p[0],n.p[1])});
  });
  if(!TRAILHEADS.length&&GRAPH.nodes.length){
    const picks=[...GRAPH.nodes.keys()].sort((a,b)=>GRAPH.nodes[a].p[1]-GRAPH.nodes[b].p[1]);
    [picks[0],picks[picks.length-1]].forEach(ni=>{
      const n=GRAPH.nodes[ni], e=GRAPH.edges.find(e=>e.a===ni||e.b===ni);
      TRAILHEADS.push({node:ni,x:n.p[0],z:n.p[1],yaw:0,name:e?e.name:'Trail',
        color:e?e.color:'#b58347',lenM:e?e.lenM:0,where:compass(n.p[0],n.p[1])});
    });
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
function setContourStep(m){ STEP_M=Math.max(0.5,m); rebuildWorld(); }

function rebuildWorld(){
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

  GRAPH=buildGraph(lines,16,6);
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
  if(BUNDLE){
    groundMat.map.repeat.set(BUNDLE.width*BUNDLE.cell/34, BUNDLE.height*BUNDLE.cell/34);
    worldG.add(new THREE.Mesh(buildTerrainMesh(VERT_SCALE), groundMat));
  }else{
    const pad=80, gw=(Mx-mx)+pad*2, gh=(Mz-mz)+pad*2;
    groundMat.map.repeat.set(gw/34, gh/34);
    const flat=new THREE.Mesh(new THREE.PlaneGeometry(gw,gh), groundMat);
    flat.rotation.x=-Math.PI/2;
    flat.position.set((mx+Mx)/2, 0, (mz+Mz)/2);
    worldG.add(flat);
  }

  flattenAreaCells(AREAS, pointInArea, areaBBox);

  const groundYAt=(x,z)=>terrainY(x,z,VERT_SCALE);

  // areas (ground cover) before trails, matching draw order in the original
  AREAS.forEach(a=>{ try{ worldG.add(buildArea(a,rng,groundYAt,nearestTrail)); }catch(err){ console.warn('area skipped',a.name,err); } });

  // Path colour/texture follows the source file's own highway/kind tag (pathKind, in
  // geo.js): a footpath stays themed dirt, a service road reads as a distinct paved grey
  // with a dashed centreline, a double-track gets worn wheel ruts instead of one groove.
  const PATH_STYLE={
    trail:{w:2.6, deco:true, tread:THEME.tread, inner:THEME.inner, shoulder:THEME.shoulder},
    track:{w:3.7, deco:true, ruts:true, tread:shade(THEME.tread,0.86), inner:shade(THEME.tread,0.6), shoulder:THEME.shoulder},
    road:{w:4.6, deco:false, dashes:true, tread:'#716d64', inner:'#8a867a', shoulder:'#4a473f'},
  };
  const mOutline=trailMat(INK);
  GRAPH.edges.forEach(e=>{
    const st=PATH_STYLE[e.kind]||PATH_STYLE.trail;
    const W=st.w;
    const rpts=resample(e.pts,3);
    const hs=stationHeights(rpts,W+2.3,VERT_SCALE);
    worldG.add(new THREE.Mesh(ribbonGeom(rpts,W+2.3,0.012,hs),mOutline));
    worldG.add(new THREE.Mesh(ribbonGeom(rpts,W+1.5,0.02,hs),trailMat(st.shoulder)));
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
    for(let i=0;i<e.pts.length-1;i++) hashSeg({a:e.pts[i],b:e.pts[i+1],edge:e});
  });

  AREAS.forEach(a=>{ if(a.name) worldG.add(buildAreaSign(a,groundYAt,nearestTrail)); });

  // junction pads + signs
  GRAPH.nodes.forEach((n,ni)=>{
    if(n.deg<1) return;
    const y=terrainY(n.p[0],n.p[1],VERT_SCALE);
    const oDisc=new THREE.Mesh(new THREE.CircleGeometry(3.5,20),mOutline);
    oDisc.rotation.x=-Math.PI/2; oDisc.position.set(n.p[0],y+0.045,n.p[1]); worldG.add(oDisc);
    const disc=new THREE.Mesh(new THREE.CircleGeometry(3.0,20),trailMat(THEME.tread));
    disc.rotation.x=-Math.PI/2; disc.position.set(n.p[0],y+0.06,n.p[1]); worldG.add(disc);
    const out=[];
    GRAPH.edges.forEach(e=>{
      if(e.a===ni) out.push({e,pts:e.pts});
      if(e.b===ni&&e.a!==e.b) out.push({e,pts:[...e.pts].reverse()});
    });
    const armOf=o=>{
      let ax=0,az=0,acc=0,i=1;
      while(i<o.pts.length&&acc<6){ax=o.pts[i][0]-n.p[0];az=o.pts[i][1]-n.p[1];acc=Math.hypot(ax,az);i++;}
      return{label:o.e.name,dist:Math.round(o.e.lenM)+' m',angle:Math.atan2(az,ax)};
    };
    if(n.deg>=3){
      const arms=[],seen=new Set();
      out.forEach(o=>{const a=armOf(o);const k=a.label+'|'+Math.round(a.angle*4);
        if(seen.has(k))return;seen.add(k);arms.push(a);});
      const sg=buildSign(n,arms); sg.position.y=y; worldG.add(sg);
    }else if(n.deg===1&&out.length){
      const sg=buildSign(n,[armOf(out[0])]); sg.position.y=y; worldG.add(sg);
    }
  });

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
    gt.position.y=terrainY(th.x,th.z,VERT_SCALE);
    worldG.add(gt);
  });
}

function mulberry(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);
  t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}

function getBackdrop(){ return backdropG; }

export { loadWorld, rebuildWorld, addLayers, clearLayers, hasBundle, setContourStep,
         setThemeById, getTheme, setMapScale, getMapScale, getExaggeration, getBackdrop,
         getGraph, getTrailheads, getPOIs, getAreas, getBBox,
         getWorldGroup, setStartHead, getStartHead, setVertScale, getVertScale, compass, THEMES, THEME };
