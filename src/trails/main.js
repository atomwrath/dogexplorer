/* Pup Trails entry point. Player movement is shared regardless of whether you're playing
   as the dog or a wild animal; only the two driver modules differ in what gets animated
   and where the geometry comes from (dog/runtime.js's shared rig vs. animal-models.js's
   shared quadruped()). */
import { clamp, lerp } from '../core/math.js';
import { setWildYaw, spawnWild, topSpeedFor, updateWild, wildPos } from './wild-driver.js';

import { dogRunMul, dogTopSpeed, setYaw, spawnDog, updateDog } from './dog-driver.js';

import { terrainY } from './terrain.js';

import { addLayers, clearLayers, getBBox, getGraph, getStartHead, getTrailheads, getVertScale, loadWorld, setStartHead } from './world.js';

import { renderer, scene, camera, resize } from '../core/render.js';
import { SPECIES } from '../data/species.js';
import { PRESETS } from '../creator/presets.js';
import { nearestTrail } from './spatial.js';

/* Trail networks run to real kilometres; Pup City's camera (far=300, tuned for one city
   block) would clip most of a trail map. Extend it rather than touch the shared file. */
camera.far = 4000; camera.updateProjectionMatrix();
camera.position.set(0, 40, 60);

const $ = s => document.querySelector(s);

/* ---------- player state ---------- */
let mode = 'dog';           // 'dog' | 'wild'
let wildKey = 'fox';
let dogPresetIdx = 0;
const player = { x:0, z:0, y:0, vy:0, yaw:0, speed:0, dist:0, sneaking:false, barkT:0 };
let camYaw=0, camPitch=0.32, playing=false;

function currentTopSpeed(){ return mode==='dog' ? dogTopSpeed() : topSpeedFor(wildKey); }
function currentRunMul(){ return mode==='dog' ? dogRunMul() : 1.8; }

function placeAtHead(i){
  const heads = getTrailheads();
  if(!heads.length) return;
  setStartHead(clamp(i,0,heads.length-1));
  const h = heads[getStartHead()];
  player.x=h.x; player.z=h.z; player.y=0; player.vy=0; player.dist=0; player.yaw=h.yaw;
  camYaw = Math.atan2(Math.cos(player.yaw), -Math.sin(player.yaw));
  if(mode==='dog'){
    spawnDog(PRESETS[clamp(dogPresetIdx,0,PRESETS.length-1)].o);
    setYaw(player.yaw);
    updateDog(0,0, terrainY(player.x,player.z,getVertScale()), 0, 0, false, false, false);
  }else{
    wildPos.set(player.x,0,player.z);
    setWildYaw(player.yaw);
    spawnWild(wildKey, Math.floor(Math.random()*1e6));
  }
}

/* ---------- input: trail-owned, not core/input.js (that module is wired directly to
   Pup City's player-state/modes/pickups -- creator has its own for the same reason) --- */
const keys = {};
addEventListener('keydown', e=>{
  keys[e.code]=true;
  if(!playing) return;
  if(e.code==='Space') e.preventDefault();
  if(e.code==='KeyC') player.sneaking=!player.sneaking;
  if(e.code==='KeyB') player.barkT=1;
  if(e.code==='Escape') exitPlay();
});
addEventListener('keyup', e=> keys[e.code]=false);

const stick = {active:false,id:null,dx:0,dy:0};
renderer.domElement.addEventListener('pointerdown', e=>{
  if(!playing) return;
  stick.active=true; stick.id=e.pointerId; stick.ox=e.clientX; stick.oy=e.clientY; stick.dx=stick.dy=0;
});
addEventListener('pointermove', e=>{
  if(!stick.active||e.pointerId!==stick.id) return;
  let dx=e.clientX-stick.ox, dy=e.clientY-stick.oy;
  const L=Math.hypot(dx,dy), max=52;
  if(L>max){dx*=max/L;dy*=max/L;}
  stick.dx=dx/max; stick.dy=dy/max;
});
const endStick=e=>{ if(stick.active&&e.pointerId===stick.id){ stick.active=false; stick.dx=stick.dy=0; } };
addEventListener('pointerup', endStick); addEventListener('pointercancel', endStick);

/* ---------- game loop ---------- */
let lastT=0;
function loop(t){
  requestAnimationFrame(loop);
  const dt=Math.min(0.05,(t-lastT)/1000||0.016); lastT=t;
  if(!playing || !getGraph()){ renderer.render(scene,camera); return; }

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
    const headYaw=Math.atan2(wx/L,wz/L);
    let dc=headYaw-camYaw; while(dc>Math.PI)dc-=Math.PI*2; while(dc<-Math.PI)dc+=Math.PI*2;
    camYaw+=dc*Math.min(1,dt*2.2);
  }
  const bb=getBBox(), F=55;
  player.x=clamp(player.x,bb.minx-F,bb.maxx+F); player.z=clamp(player.z,bb.minz-F,bb.maxz+F);
  player.vy-=26*dt; player.y=Math.max(0,player.y+player.vy*dt);
  if(player.y===0) player.vy=Math.max(0,player.vy);
  player.barkT=Math.max(0,player.barkT-dt*2);

  const groundY=terrainY(player.x,player.z,getVertScale());
  if(mode==='dog'){
    setYaw(player.yaw);
    updateDog(dt,t,groundY,player.y,player.speed,player.sneaking,player.barkT>0,run);
  }else{
    wildPos.set(player.x,0,player.z);
    setWildYaw(player.yaw);
    updateWild(dt,t,groundY,player.y,player.speed,player.sneaking,player.barkT>0);
  }

  const camD=11;
  camera.position.lerp(new THREE.Vector3(
    player.x-Math.sin(camYaw)*camD*Math.cos(camPitch),
    groundY+2+camD*Math.sin(camPitch),
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

/* ---------- UI wiring (minimal: species picker, play/exit, theme) ----------
   Sighting log, exit-gate stats screen and full minimap drawing from the standalone
   build are not ported in this pass -- flagged in the integration notes rather than
   silently dropped. Core loop (movement, dog/wildlife switch, sneak/run/bark/jump,
   trailhead placement and exit) is complete and verified. */
function renderSpeciesPicker(){
  const grid=$('#speciesGrid'); if(!grid) return;
  grid.innerHTML='';
  PRESETS.forEach((p,i)=>{
    const b=document.createElement('button');
    b.textContent='🐶 '+p.label;
    b.addEventListener('click',()=>{mode='dog';dogPresetIdx=i;placeAtHead(getStartHead());});
    grid.appendChild(b);
  });
  for(const key of ['fox','coyote','bobcat','deer','goat','bighorn','bear','moose','rabbit','squirrel']){
    if(!SPECIES[key]) continue;
    const b=document.createElement('button');
    b.textContent=SPECIES[key].nm;
    b.addEventListener('click',()=>{mode='wild';wildKey=key;placeAtHead(getStartHead());});
    grid.appendChild(b);
  }
}

async function boot(bundleUrl){
  if(bundleUrl){
    await loadWorld(bundleUrl, [], 3);
  }
  renderSpeciesPicker();
  resize();
  requestAnimationFrame(loop);
}

$('#playBtn')?.addEventListener('click', enterPlay);
$('#exitBtn')?.addEventListener('click', exitPlay);
$('#clearLayersBtn')?.addEventListener('click', ()=>{ clearLayers(); });

$('#worldFile')?.addEventListener('change', async e=>{
  await loadFiles([...e.target.files]);
  e.target.value='';
});

/* One picker for everything. A pup-world/1 bundle and a plain .geojson are both just
   JSON, so detect by content (bundle.format) rather than by extension -- QGIS writes
   .geojson, fetch_dem.py writes .json, and users rename both. Layers are batched so
   dropping trails + areas together rebuilds once, not twice. */
async function loadFiles(files){
  if(!files.length) return;
  const layers=[];
  for(const f of files){
    let obj;
    try{ obj=JSON.parse(await f.text()); }
    catch(err){ console.error('not valid JSON:',f.name,err); continue; }
    if(obj && obj.format==='pup-world/1'){
      try{ await loadWorld(obj, [], 3); }
      catch(err){ console.error('bad world bundle:',f.name,err); }
    }else if(obj && (obj.type==='FeatureCollection' || obj.type==='Feature')){
      layers.push(obj.type==='Feature' ? {type:'FeatureCollection',features:[obj]} : obj);
    }else{
      console.error('unrecognised file (expected a pup-world/1 bundle or GeoJSON):', f.name);
    }
  }
  if(layers.length) addLayers(layers);
  if(!getGraph()) return;
  renderSpeciesPicker();
  placeAtHead(0);
}

export { boot, enterPlay, exitPlay, placeAtHead };

// auto-boot from a `?world=` query param, or wait for the panel's own load button
{
  const q = new URLSearchParams(location.search).get('world');
  boot(q || null);
}
