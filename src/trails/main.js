/* Pup Trails entry point. Player movement is shared regardless of whether you're playing
   as the dog or a wild animal; only the two driver modules differ in what gets animated
   and where the geometry comes from (dog/runtime.js's shared rig vs. animal-models.js's
   shared quadruped()).

   THE AVATAR RULE, learned the hard way: this file owns `player`, and every driver has
   its own position store -- dog/runtime.js's `dogPos`, wild-driver.js's `pos`. Neither
   reads `player`. Any code path that moves the player MUST push x/z across to whichever
   driver is live (syncAvatar below), or the rig renders at the world origin while the
   camera follows the player, which on a 2.6 km map means it is simply never on screen.
   That was the "map loads, no dog" bug. */
import { clamp, lerp } from '../core/math.js';
import { setWildVisible, setWildYaw, spawnWild, topSpeedFor, updateWild, wildPos } from './wild-driver.js';

import { dogRunMul, dogTopSpeed, setDogPos, setDogVisible, setYaw, spawnDog, updateDog } from './dog-driver.js';

import { cameraGroundY, surfaceY } from './terrain.js';

import { addLayers, clearLayers, getBBox, getBackdrop, getExaggeration, getFogMultiplier, getGraph, getMapScale, getStartHead, getTrailheads, getVertScale, loadWorld, setFogMultiplier, setMapScale, setStartHead, setThemeById, setVertScale } from './world.js';

import { THEME, THEMES } from './themes.js';
import { renderer, scene, camera, resize } from '../core/render.js';
import { SPECIES } from '../data/species.js';
import { PRESETS } from '../creator/presets.js';
import { DEFAULTS } from '../dog/params.js';
import { addPups, kennelPups, loadKennel, parsePupFile } from '../data/kennel.js';
import { nearestTrail } from './spatial.js';

/* Trail networks run to real kilometres; Pup City's camera (far=300, tuned for one city
   block) would clip most of a trail map. Extend it rather than touch the shared file. */
// far: trail networks run to real kilometres; Pup City's far=300 (tuned for one city
// block) would clip most of a trail map. fov: Pup City's 38 deg is a tight telephoto,
// chosen for its small enclosed blocks; trails is wide open country, so a wider,
// more natural-feeling field of view suits it better.
camera.far = 4000; camera.fov = 62; camera.updateProjectionMatrix();
camera.position.set(0, 40, 60);

const $ = s => document.querySelector(s);

/* The map you get if you don't ask for one. Relative to trails/index.html, which also
   resolves correctly for dist/pup-trails.html served from the repo root and for the
   GitHub Pages deploy. `?world=` still overrides it, and the file picker still replaces
   it at runtime. Loaded through the normal path -- no special-casing -- so a failure
   here fails exactly the way a hand-picked bundle would. */
const DEFAULT_WORLD = '../data/world.json';

/* ---------- player state ---------- */
let mode = 'dog';           // 'dog' | 'wild'
let wildKey = 'fox';
let dogChoice = {label: PRESETS[0].label, params: PRESETS[0].o};
const player = { x:0, z:0, y:0, vy:0, yaw:0, speed:0, dist:0, sneaking:false, barkT:0 };
let camYaw=0, camPitch=0.32, playing=false;
/* Timestamp of the last manual look-drag (performance.now(), not the loop's own `t` --
   pointer events fire outside the loop). While recent, the auto-follow below backs off
   so it doesn't fight a hand that's actively orbiting the camera. */
let lastLookT=-Infinity;
const PITCH_MIN=0.05, PITCH_MAX=1.35;   // clamps: never flips under the ground or goes top-down
let avatarKey='';           // identity of whatever is currently built, for ensureAvatar

function currentTopSpeed(){ return mode==='dog' ? dogTopSpeed() : topSpeedFor(wildKey); }
function currentRunMul(){ return mode==='dog' ? dogRunMul() : 1.8; }

/* ---------- avatar ----------
   ensureAvatar rebuilds geometry only when the *identity* changes; syncAvatar pushes
   position every time the player moves or is teleported. Keeping them apart means
   re-placing at a trailhead, changing theme or dragging the scale slider no longer
   rebuilds and re-uploads the whole rig. */
function dogParams(){ return Object.assign({}, DEFAULTS, dogChoice.params); }

function ensureAvatar(){
  const key = mode==='dog' ? 'dog:'+dogChoice.label : 'wild:'+wildKey;
  if(key === avatarKey) return;
  avatarKey = key;
  if(mode==='dog'){
    spawnDog(dogParams());
  }else{
    // stable seed per species: the same fox should look the same every time you pick it
    let h=0; for(let i=0;i<wildKey.length;i++) h=(h*31+wildKey.charCodeAt(i))|0;
    spawnWild(wildKey, Math.abs(h)||1);
  }
  setDogVisible(mode==='dog');
  setWildVisible(mode==='wild');
}

function syncAvatar(dt, t, jumpY, speed, sneaking, barking, run){
  // surfaceY, not terrainY: the trail ribbon is deliberately built on the highest band
  // across its own width (terrain.js), so the avatar has to read ground the same way or
  // it visually sinks below the tread anywhere terrain rises to one side of the path --
  // see terrain.js's surfaceY doc comment for the full story.
  const groundY = surfaceY(player.x, player.z, getVertScale());
  if(mode==='dog'){
    setDogPos(player.x, player.z);
    setYaw(player.yaw);
    updateDog(dt, t, groundY, jumpY, speed, sneaking, barking, run);
  }else{
    wildPos.set(player.x, 0, player.z);
    setWildYaw(player.yaw);
    updateWild(dt, t, groundY, jumpY, speed, sneaking, barking);
  }
  return groundY;
}

/* Drop the player at trailhead `i`. Falls back to the middle of the map when a set of
   layers has no degree-1 node to make a trailhead out of -- an avatar standing in the
   centre of the map is far more debuggable than no avatar at all. */
function placeAtHead(i){
  const heads = getTrailheads();
  if(heads.length){
    setStartHead(clamp(i,0,heads.length-1));
    const h = heads[getStartHead()];
    player.x=h.x; player.z=h.z; player.yaw=h.yaw;
  }else{
    const bb=getBBox();
    player.x=(bb.minx+bb.maxx)/2; player.z=(bb.minz+bb.maxz)/2; player.yaw=0;
  }
  player.y=0; player.vy=0; player.dist=0; player.speed=0;
  camYaw = Math.atan2(Math.cos(player.yaw), -Math.sin(player.yaw));
  ensureAvatar();
  const groundY = syncAvatar(0,0,0,0,false,false,false);
  if(!playing) frameAvatar(groundY);
  renderStartPicker();
}

/* In the lobby the camera used to sit at its boot position looking at the origin, so
   even a correctly-placed avatar was off screen until you pressed Play. Snap the camera
   behind the avatar instead -- you should be able to see who you picked. */
function frameAvatar(groundY){
  const camD=13*camZoom;
  camera.position.set(
    player.x-Math.sin(camYaw)*camD*Math.cos(camPitch),
    groundY+2+camD*Math.sin(camPitch),
    player.z-Math.cos(camYaw)*camD*Math.cos(camPitch));
  camera.lookAt(player.x, groundY+1.4, player.z);
}

/* ---------- input: trail-owned, not core/input.js (that module is wired directly to
   Pup City's player-state/modes/pickups -- creator has its own for the same reason) --- */
const keys = {};
addEventListener('keydown', e=>{
  keys[e.code]=true;
  if(!playing) return;
  if(e.code==='Space'){ e.preventDefault(); if(player.y===0) player.vy=9.5; }
  if(e.code==='KeyC') player.sneaking=!player.sneaking;
  if(e.code==='KeyB') player.barkT=1;
  if(e.code==='Escape') exitPlay();
});
addEventListener('keyup', e=> keys[e.code]=false);

/* Two independent pointer zones, split by which half of the canvas a drag STARTS in --
   the standard twin-stick split (move on one side, look on the other), which needs no
   touch/mouse detection and works the same for a mouse drag as for two thumbs. Each zone
   tracks its own pointer id, so one finger on each half works simultaneously; a mouse
   only ever occupies one at a time, which is fine since WASD covers movement for it. */
const stick = {active:false,id:null,dx:0,dy:0};
const look  = {active:false,id:null,lastX:0,lastY:0};
const YAW_SENS=0.0055, PITCH_SENS=0.0042;

renderer.domElement.addEventListener('pointerdown', e=>{
  if(!playing) return;
  const rect=renderer.domElement.getBoundingClientRect();
  const rightHalf = (e.clientX-rect.left) > rect.width*0.5;
  if(rightHalf && !look.active){
    look.active=true; look.id=e.pointerId; look.lastX=e.clientX; look.lastY=e.clientY;
  }else if(!rightHalf && !stick.active){
    stick.active=true; stick.id=e.pointerId; stick.ox=e.clientX; stick.oy=e.clientY; stick.dx=stick.dy=0;
  }
});
addEventListener('pointermove', e=>{
  if(stick.active && e.pointerId===stick.id){
    let dx=e.clientX-stick.ox, dy=e.clientY-stick.oy;
    const L=Math.hypot(dx,dy), max=52;
    if(L>max){dx*=max/L;dy*=max/L;}
    stick.dx=dx/max; stick.dy=dy/max;
  }else if(look.active && e.pointerId===look.id){
    const dx=e.clientX-look.lastX, dy=e.clientY-look.lastY;
    look.lastX=e.clientX; look.lastY=e.clientY;
    camYaw -= dx*YAW_SENS;
    camPitch = clamp(camPitch - dy*PITCH_SENS, PITCH_MIN, PITCH_MAX);
    lastLookT = performance.now();
  }
});
const endPointer=e=>{
  if(stick.active&&e.pointerId===stick.id){ stick.active=false; stick.dx=stick.dy=0; }
  if(look.active&&e.pointerId===look.id){ look.active=false; }
};
addEventListener('pointerup', endPointer); addEventListener('pointercancel', endPointer);

/* Scroll to zoom -- a natural companion to free-look, and cheap: `camZoom` just scales
   the existing orbit radius (camD) everywhere it's used, both in the lobby framing and
   the play-loop follow, so this is the only place zoom needs to be taught about. */
let camZoom=1;
renderer.domElement.addEventListener('wheel', e=>{
  if(!playing) return;
  e.preventDefault();
  camZoom = clamp(camZoom + Math.sign(e.deltaY)*0.08, 0.5, 2.2);
}, {passive:false});

/* ---------- game loop ---------- */
let lastT=0;
function loop(t){
  requestAnimationFrame(loop);
  const dt=Math.min(0.05,(t-lastT)/1000||0.016); lastT=t;

  // the horizon ring is a sky dome: keep it centred on the camera so it can't be reached
  const bd=getBackdrop();
  if(bd) bd.position.set(camera.position.x, 0, camera.position.z);

  if(!playing || !getGraph()){
    // idle: no movement, but keep the avatar breathing so the lobby isn't a still frame
    if(avatarKey) syncAvatar(dt, t, 0, 0, player.sneaking, false, false);
    renderer.render(scene,camera);
    return;
  }

  let ix=0,iz=0,run=false;
  if(keys.KeyW||keys.ArrowUp) iz-=1;
  if(keys.KeyS||keys.ArrowDown) iz+=1;
  if(keys.KeyA||keys.ArrowLeft) ix-=1;
  if(keys.KeyD||keys.ArrowRight) ix+=1;
  run=(keys.ShiftLeft||keys.ShiftRight) && !player.sneaking;
  let mag=Math.hypot(ix,iz);
  if(mag>0){ix/=mag;iz/=mag;mag=1;}
  if(stick.active){
    const L=Math.hypot(stick.dx,stick.dy); mag=clamp(L,0,1);
    if(mag>0.06){ix=stick.dx/L;iz=stick.dy/L;run=mag>0.92&&!player.sneaking;} else {ix=iz=0;mag=0;}
  }
  const fS=Math.sin(camYaw), fC=Math.cos(camYaw);
  const wx=-fC*ix-fS*iz, wz=fS*ix-fC*iz;
  const moving=mag>0.03&&(wx||wz);

  const nt = nearestTrail(player.x,player.z);
  const surf = nt.d<1.5 ? 1 : 0.6;
  const top = currentTopSpeed()*(player.sneaking?0.5:(run?currentRunMul():1))*surf*(stick.active?mag:1);
  player.speed = lerp(player.speed, moving?top:0, 1-Math.pow(0.0009,dt));
  if(moving){
    const L=Math.hypot(wx,wz);
    player.x+=wx/L*player.speed*dt; player.z+=wz/L*player.speed*dt; player.dist+=player.speed*dt;
    const targetYaw=Math.atan2(-wz/L,wx/L);
    let dy=targetYaw-player.yaw; while(dy>Math.PI)dy-=Math.PI*2; while(dy<-Math.PI)dy+=Math.PI*2;
    player.yaw+=dy*Math.min(1,dt*10);
    // convenience auto-follow: swing the camera in behind the direction you're walking,
    // but only when nobody's hand is on it -- otherwise every step yanks the view back
    // out from under a manual look-drag, which is worse than not auto-following at all.
    if(performance.now()-lastLookT>900){
      const headYaw=Math.atan2(wx/L,wz/L);
      let dc=headYaw-camYaw; while(dc>Math.PI)dc-=Math.PI*2; while(dc<-Math.PI)dc+=Math.PI*2;
      camYaw+=dc*Math.min(1,dt*2.2);
    }
  }
  const bb=getBBox(), F=55;
  player.x=clamp(player.x,bb.minx-F,bb.maxx+F); player.z=clamp(player.z,bb.minz-F,bb.maxz+F);
  player.vy-=26*dt; player.y=Math.max(0,player.y+player.vy*dt);
  if(player.y===0) player.vy=Math.max(0,player.vy);
  player.barkT=Math.max(0,player.barkT-dt*2);

  const groundY = syncAvatar(dt,t,player.y,player.speed,player.sneaking,player.barkT>0,run);

  // camGroundY: smoothed terrain height for the camera RIG's own altitude only -- using
  // the true (stepped) groundY here is what made the camera hop every time the avatar
  // crossed a terrace cell boundary. lookAt below still targets the exact avatar
  // position, so the avatar itself stays precisely framed; only the viewpoint's own
  // bob is damped.
  const camD=11*camZoom;
  const camY = cameraGroundY(player.x, player.z, getVertScale());
  camera.position.lerp(new THREE.Vector3(
    player.x-Math.sin(camYaw)*camD*Math.cos(camPitch),
    camY+2+camD*Math.sin(camPitch),
    player.z-Math.cos(camYaw)*camD*Math.cos(camPitch)
  ), 1-Math.pow(0.001,dt));
  camera.lookAt(player.x, groundY+player.y+1.4, player.z);

  // exit at any trailhead once you've walked away from your own start
  const nh=getTrailheads().reduce((b,h,i)=>{const d=Math.hypot(h.x-player.x,h.z-player.z);
    return(!b||d<b.d)?{d,i}:b;},null);
  if(nh && nh.d<4.5 && player.dist>20) exitPlay();

  renderer.render(scene,camera);
}

function enterPlay(){
  if(!getGraph()){ return; }
  placeAtHead(getStartHead());
  playing=true;
  document.body.classList.add('play');
}
function exitPlay(){
  playing=false;
  document.body.classList.remove('play');
  placeAtHead(getStartHead());
}

/* ---------- UI wiring ----------
   Sighting log, exit-gate stats screen and full minimap drawing from the standalone
   build are still not ported -- flagged rather than silently dropped. */

/* --- who's exploring ---
   Two rosters, not one mixed grid: the premade pups and any pups saved in the creator
   are one kind of choice, the wildlife is another. Both are populated on boot with no
   file to import and no map required -- picking a dog before a map has loaded stands it
   at the origin rather than doing nothing, which is also how you can tell the picker
   works when a map fails. The live choice carries `.sel`, because a button that silently
   does its job is indistinguishable from a button that is broken. */
function rosterKey(){ return mode==='dog' ? 'dog:'+dogChoice.label : 'wild:'+wildKey; }

function renderRoster(){
  const dogs=$('#dogGrid'), wild=$('#animalGrid');
  const live=rosterKey();
  const pick=(grid,label,key,cls,onClick)=>{
    if(!grid) return null;
    const b=document.createElement('button');
    b.className=cls+(key===live?' sel':'');
    b.textContent=label;
    b.addEventListener('click',()=>{ onClick(); renderRoster(); placeAtHead(getStartHead()); });
    grid.appendChild(b);
    return b;
  };
  if(dogs){
    dogs.innerHTML='';
    kennelPups.forEach(k=>{
      const b=pick(dogs,'⭐ '+k.name,'dog:saved:'+k.name,'saved',()=>{
        mode='dog'; dogChoice={label:'saved:'+k.name, params:k.params};
      });
      if(b && k.params.furColor) b.style.borderColor=k.params.furColor;
    });
    PRESETS.forEach(p=>{
      pick(dogs,'🐶 '+p.label,'dog:'+p.label,'',()=>{
        mode='dog'; dogChoice={label:p.label, params:p.o};
      });
    });
  }
  if(wild){
    wild.innerHTML='';
    // every species in the shared roster, theme-appropriate ones first so the list reads
    // as "what you'd meet out here" before "everything that exists"
    const local=(THEME.wildlife||[]);
    const keys=[...local, ...Object.keys(SPECIES).filter(k=>!local.includes(k))];
    for(const key of keys){
      if(!SPECIES[key]) continue;
      pick(wild,SPECIES[key].nm,'wild:'+key,'wild',()=>{ mode='wild'; wildKey=key; });
    }
  }
  const note=$('#pupNote');
  if(note) note.textContent = kennelPups.length
    ? `${kennelPups.length} saved pup${kennelPups.length>1?'s':''} from the creator, plus the ${PRESETS.length} starters.`
    : `${PRESETS.length} starter pups. Make your own in Backyard Pups — they show up here automatically — or import a backyard-pups.json below.`;
}

/* --- environment --- */
function renderThemePicker(){
  const grid=$('#envGrid'); if(!grid) return;
  grid.innerHTML='';
  Object.values(THEMES).forEach(t=>{
    const b=document.createElement('button');
    b.className='envcard'+(t.id===THEME.id?' sel':'');
    b.style.background=t.sky;
    b.innerHTML=`<span class="em">${t.em}</span><span class="nm">${t.label}</span>`;
    b.addEventListener('click',()=>{
      if(!setThemeById(t.id)) return;
      renderThemePicker();
      renderRoster();
      placeAtHead(getStartHead());     // rebuild dropped the old scene; re-seat the player
    });
    grid.appendChild(b);
  });
}

/* --- scale ---
   Both sliders rebuild the world, which is expensive, so the label updates on `input`
   and the rebuild only fires on `change` (pointer release / arrow-key commit). */
function wireScale(){
  const map=$('#mapScale'), mapV=$('#mapScaleVal');
  const ex=$('#vertScale'), exV=$('#vertScaleVal');
  if(map && mapV){
    map.value=getMapScale();
    const show=v=>{ mapV.textContent = (+v).toFixed(2)+'\u00d7'; };
    show(map.value);
    map.addEventListener('input', e=> show(e.target.value));
    map.addEventListener('change', e=>{
      setMapScale(+e.target.value);
      show(getMapScale());
      placeAtHead(getStartHead());
    });
  }
  if(ex && exV){
    ex.value=getExaggeration();
    const show=v=>{ exV.textContent = (+v).toFixed(1)+'\u00d7'; };
    show(ex.value);
    ex.addEventListener('input', e=> show(e.target.value));
    ex.addEventListener('change', e=>{
      setVertScale(+e.target.value);
      show(getExaggeration());
      placeAtHead(getStartHead());
    });
  }
  // fog touches scene.fog only -- no rebuild, so it applies live on every `input` tick
  // instead of waiting for `change` the way the two rebuild-triggering sliders above do.
  const fog=$('#fogAmt'), fogV=$('#fogAmtVal');
  if(fog && fogV){
    fog.value=getFogMultiplier();
    const show=v=>{ fogV.textContent = (+v).toFixed(2)+'\u00d7'; };
    show(fog.value);
    fog.addEventListener('input', e=>{
      setFogMultiplier(+e.target.value);
      show(getFogMultiplier());
    });
  }
}

/* --- starting point --- */
function renderStartPicker(){
  const sel=$('#startSel'); if(!sel) return;
  const heads=getTrailheads();
  sel.innerHTML='';
  if(!heads.length){
    sel.innerHTML='<option>— load a map first —</option>';
    sel.disabled=true;
    return;
  }
  sel.disabled=false;
  heads.forEach((h,i)=>{
    const o=document.createElement('option');
    o.value=String(i);
    o.textContent=`${h.name} · ${h.where}${h.lenM?` · ${Math.round(h.lenM)} m`:''}`;
    sel.appendChild(o);
  });
  sel.value=String(getStartHead());
}

async function boot(bundleUrl){
  loadKennel();
  renderThemePicker();
  wireScale();
  await loadMap(bundleUrl || DEFAULT_WORLD, !bundleUrl);
  renderRoster();
  renderStartPicker();
  // seat an avatar unconditionally. With a map that means the chosen trailhead; without
  // one, the middle of an empty world -- either way you can see who you picked, which is
  // what tells you the roster works when the map does not.
  placeAtHead(getStartHead());
  resize();
  requestAnimationFrame(loop);
}

/* One place that loads a map by URL, so the boot path, the reload button and any future
   map list all report success and failure identically. */
async function loadMap(url, isDefault){
  const note=$('#mapNote');
  if(note) note.textContent='Loading map…';
  try{
    await loadWorld(url, [], 3);
    if(note) note.textContent = (isDefault?'Default map: ':'Loaded: ')+url.split('/').pop()
      + ` · ${getTrailheads().length} trailhead${getTrailheads().length===1?'':'s'}`;
    return true;
  }catch(err){
    console.error('could not load world:', url, err);
    if(note) note.textContent = isDefault
      ? 'Default map could not load — serve the repo over http (python3 build.py --serve), or pick a bundle below.'
      : 'That map could not be loaded — see the console.';
    return false;
  }
}

$('#defaultMapBtn')?.addEventListener('click', async ()=>{
  if(await loadMap(DEFAULT_WORLD, true)){ renderStartPicker(); placeAtHead(0); }
});
$('#playBtn')?.addEventListener('click', enterPlay);
$('#exitBtn')?.addEventListener('click', exitPlay);
$('#clearLayersBtn')?.addEventListener('click', ()=>{ clearLayers(); renderStartPicker(); });
$('#startSel')?.addEventListener('change', e=> placeAtHead(+e.target.value));

$('#worldFile')?.addEventListener('change', async e=>{
  const files=[...e.target.files];
  e.target.value='';
  await loadFiles(files);
});
$('#pupFile')?.addEventListener('change', async e=>{
  const files=[...e.target.files];
  e.target.value='';
  let n=0;
  for(const f of files) n += addPups(parsePupFile(await f.text()));
  renderRoster();
  if(!n) console.warn('no pups found in that file');
});

/* One picker for everything. A pup-world/1 bundle, a plain .geojson and a
   backyard-pups.json are all just JSON, so detect by content rather than by extension --
   QGIS writes .geojson, fetch_dem.py writes .json, and users rename both. Layers are
   batched so dropping trails + areas together rebuilds once, not twice. */
async function loadFiles(files){
  if(!files.length) return;
  const layers=[];
  let gotPups=0;
  for(const f of files){
    let obj;
    try{ obj=JSON.parse(await f.text()); }
    catch(err){ console.error('not valid JSON:',f.name,err); continue; }
    if(obj && obj.format==='pup-world/1'){
      try{ await loadWorld(obj, [], 3); }
      catch(err){ console.error('bad world bundle:',f.name,err); }
    }else if(obj && (obj.type==='FeatureCollection' || obj.type==='Feature')){
      layers.push(obj.type==='Feature' ? {type:'FeatureCollection',features:[obj]} : obj);
    }else if(obj && (obj.backyardPups || obj.pups || obj.furColor)){
      gotPups += addPups(parsePupFile(obj));
    }else{
      console.error('unrecognised file (expected a pup-world/1 bundle, GeoJSON or a pup file):', f.name);
    }
  }
  if(layers.length) addLayers(layers);
  if(gotPups) renderRoster();
  if(!getGraph()) return;
  renderStartPicker();
  placeAtHead(0);
}

export { boot, enterPlay, exitPlay, placeAtHead };

// auto-boot from a `?world=` query param, or wait for the panel's own load button
{
  const q = new URLSearchParams(location.search).get('world');
  boot(q || null);
}
