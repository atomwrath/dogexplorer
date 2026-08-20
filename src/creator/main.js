/* Backyard Pups — the character creator.
   buildDog and DEFAULTS come from ../dog/, shared byte-for-byte with Pup City. */
import { canvas, renderer, scene, camera, resize, disposeGroup } from '../core/render.js';
import { toon, M } from '../core/materials.js';
import { clamp, lerp, mulberry32 } from '../core/math.js';
import { DEFAULTS, FURS } from '../dog/params.js';
import { buildDog } from '../dog/build.js';
import { PRESETS } from './presets.js';
import { YARD, STREAM, GARDEN, BOWL_POS, BOWL_MAX, ball } from './scene.js';
import { registerServiceWorker } from '../city/pwa.js';

let P = Object.assign({}, DEFAULTS);

/* ---------- current dog instance ---------- */
let dog = null, R = null;
let dogYaw = -0.5;                     // editor spin
const dogPos = new THREE.Vector3(0,0,0);

let rebuildQueued = false;
function scheduleRebuild(){
  if(rebuildQueued) return;
  rebuildQueued = true;
  requestAnimationFrame(()=>{ rebuildQueued = false; rebuild(); });
}
function rebuild(){
  if(dog){ scene.remove(dog); disposeGroup(dog); }
  const b = buildDog(P);
  dog = b.group; R = b.refs;
  dog.position.copy(dogPos);
  dog.rotation.y = dogYaw;
  scene.add(dog);
}

/* =========================================================
   UI — control panel generated from a schema
   ========================================================= */
const panel = document.getElementById('panel');
const uiRefs = {};   // key -> updater fn to sync UI after preset/load/randomize

function section(title, emoji, open=true){
  const s = document.createElement('div');
  s.className = 'section' + (open? '' : ' closed');
  s.innerHTML = `<h2><span class="em">${emoji}</span>${title}<span class="caret">▾</span></h2><div class="sec-body"></div>`;
  s.querySelector('h2').addEventListener('click', ()=> s.classList.toggle('closed'));
  panel.appendChild(s);
  return s.querySelector('.sec-body');
}
function addRange(parent, key, label, min, max, step=0.01){
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = `<label>${label}<span class="val"></span></label><input type="range" min="${min}" max="${max}" step="${step}">`;
  const inp = row.querySelector('input'), val = row.querySelector('.val');
  const show = ()=> val.textContent = (+P[key]).toFixed(step>=1?0:2);
  inp.value = P[key]; show();
  inp.addEventListener('input', ()=>{ P[key] = +inp.value; show(); scheduleRebuild(); });
  uiRefs[key] = ()=>{ inp.value = P[key]; show(); };
  parent.appendChild(row);
}
function addColor(parent, key, label){
  const row = document.createElement('div');
  row.className = 'row color-row';
  row.innerHTML = `<span>${label}</span><input type="color">`;
  const inp = row.querySelector('input');
  inp.value = P[key];
  inp.addEventListener('input', ()=>{ P[key] = inp.value; scheduleRebuild(); });
  uiRefs[key] = ()=> inp.value = P[key];
  parent.appendChild(row);
}
function addToggle(parent, key, label){
  const row = document.createElement('div');
  row.className = 'row toggle-row';
  row.innerHTML = `<span>${label}</span><div class="switch" role="switch" tabindex="0"></div>`;
  const sw = row.querySelector('.switch');
  const sync = ()=> sw.classList.toggle('on', !!P[key]);
  const flip = ()=>{ P[key] = !P[key]; sync(); scheduleRebuild(); };
  sw.addEventListener('click', flip);
  sw.addEventListener('keydown', e=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); flip(); }});
  sync();
  uiRefs[key] = sync;
  parent.appendChild(row);
}
function addSegment(parent, key, label, options){
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = `<label>${label}<span class="val"></span></label><div class="seg"></div>`;
  const seg = row.querySelector('.seg');
  options.forEach(([v, text])=>{
    const b = document.createElement('button');
    b.textContent = text;
    b.addEventListener('click', ()=>{ P[key] = v; sync(); scheduleRebuild(); });
    b.dataset.v = v;
    seg.appendChild(b);
  });
  const sync = ()=> seg.querySelectorAll('button').forEach(b=> b.classList.toggle('on', b.dataset.v===String(P[key])));
  sync();
  uiRefs[key] = sync;
  parent.appendChild(row);
}

/* --- Base pups --- */
{
  const b = section('Base pups — start here', '🐶');
  const grid = document.createElement('div');
  grid.className = 'presets';
  PRESETS.forEach(pr=>{
    const c = document.createElement('div');
    c.className = 'preset';
    c.innerHTML = `<div class="dot"></div><div class="nm">${pr.label}</div><div class="sub">${pr.sub}</div>`;
    const dot = c.querySelector('.dot');
    dot.style.background = pr.o.spots
      ? `radial-gradient(circle at 30% 30%, ${pr.o.spotColor} 24%, ${pr.o.furColor} 26%)`
      : `linear-gradient(135deg, ${pr.o.furColor} 55%, ${pr.o.bellyColor} 56%)`;
    c.addEventListener('click', ()=>{
      const keepName = P.name;
      P = Object.assign({}, DEFAULTS, pr.o, {name:keepName});
      syncAllUI(); scheduleRebuild();
      toast(`${pr.label} loaded — now make it yours!`);
    });
    grid.appendChild(c);
  });
  b.appendChild(grid);
  const note = document.createElement('div');
  note.className = 'hint-note';
  note.textContent = 'Pick a starting pup, then tweak every slider below to match your dog.';
  b.appendChild(note);
}

/* --- Body --- */
{
  const b = section('Body', '🦴');
  addRange(b,'size','Overall size',0.55,1.6);
  addRange(b,'bodyLength','Body length',0.7,1.6);
  addRange(b,'girth','Chunkiness',0.7,1.5);
  addRange(b,'build','Build (lean ↔ buff)',0.35,2);
  addRange(b,'legLength','Leg length',0.45,1.55);
  addRange(b,'legThick','Leg thickness',0.6,1.7);
}
/* --- Head --- */
{
  const b = section('Head & face', '👀');
  addRange(b,'headSize','Head size',0.7,1.5);
  addRange(b,'snoutLength','Snout length',0.4,1.7);
  addRange(b,'snoutWidth','Snout width',0.6,1.5);
  addRange(b,'eyeSize','Eye size',0.6,1.7);
  addColor(b,'eyeColor','Eye color');
  addSegment(b,'faceMask','Face marking',[['none','None'],['blaze','⚡ Blaze'],['mask','🎭 Mask']]);
  addToggle(b,'brows','Eyebrows');
  addColor(b,'browColor','Eyebrow color');
  addToggle(b,'blush','Blushy cheeks');
  addToggle(b,'freckles','Muzzle freckles');
  addToggle(b,'tongue','Tongue out (blep)');
}
/* --- Ears --- */
{
  const b = section('Ears', '🐰');
  addSegment(b,'earStyle','Ear style',[['pointy','⛰ Pointy'],['floppy','🍂 Floppy'],['long','🍃 Long'],['round','🍡 Round']]);
  addRange(b,'earSize','Ear size',0.6,1.7);
}
/* --- Tail --- */
{
  const b = section('Tail', '➰');
  addSegment(b,'tailStyle','Tail style',[['straight','📏 Straight'],['curly','🌀 Curly'],['plume','🪶 Plume'],['stub','⚪ Stub']]);
  addRange(b,'tailLength','Tail length',0.5,1.7);
  addRange(b,'tailThick','Tail thickness',0.5,2);
}
/* --- Coat --- */
{
  const b = section('Coat & markings', '🎨');
  addColor(b,'furColor','Fur color');
  addColor(b,'bellyColor','Belly & chest');
  addColor(b,'accentColor','Ears & tail tip');
  addColor(b,'noseColor','Nose');
  addToggle(b,'muzzlePatch','Light muzzle');
  addToggle(b,'socks','Sock paws');
  addColor(b,'sockColor','Sock color');
  addSegment(b,'eyePatch','Eye patch',[['none','None'],['left','Left eye'],['right','Right eye']]);
  addToggle(b,'spots','Spots');
  addColor(b,'spotColor','Spot color');
  addRange(b,'spotCount','Spot count',0,26,1);
  addRange(b,'spotSize','Spot size',0.5,2.2);
  const shuffleRow = document.createElement('div');
  shuffleRow.className = 'row';
  const shBtn = document.createElement('button');
  shBtn.className = 'btn small'; shBtn.textContent = '🔀 Shuffle spot pattern';
  shBtn.addEventListener('click', ()=>{ P.spotSeed = Math.floor(Math.random()*9999); scheduleRebuild(); });
  shuffleRow.appendChild(shBtn);
  b.appendChild(shuffleRow);
}
/* --- Extras --- */
{
  const b = section('Extras', '✨');
  addToggle(b,'collar','Collar');
  addColor(b,'collarColor','Collar color');
}
/* --- Save & load --- */
{
  const b = section('Save & load pups', '💾');
  const nameRow = document.createElement('div');
  nameRow.className = 'row name-row';
  nameRow.innerHTML = `<input type="text" maxlength="20" placeholder="Pup's name"><button class="btn small primary">💾 Save</button>`;
  const nameInp = nameRow.querySelector('input');
  nameInp.value = P.name;
  nameInp.addEventListener('input', ()=>{ P.name = nameInp.value || 'Pup'; });
  uiRefs.name = ()=> nameInp.value = P.name;
  nameRow.querySelector('button').addEventListener('click', saveCurrent);
  b.appendChild(nameRow);

  const list = document.createElement('div');
  list.id = 'savedList';
  b.appendChild(list);

  const io = document.createElement('div');
  io.className = 'io-row';
  io.innerHTML = `<button class="btn small" id="exportBtn">⬇ Export file</button>
                  <button class="btn small" id="importBtn">⬆ Import file</button>
                  <input type="file" id="importFile" accept=".json,application/json" style="display:none">`;
  b.appendChild(io);
  const note = document.createElement('div');
  note.className = 'hint-note';
  note.textContent = 'Saved pups live in this session. Export a .json file to keep them forever, then import it any time.';
  b.appendChild(note);

  io.querySelector('#exportBtn').addEventListener('click', exportSaves);
  const fileInp = io.querySelector('#importFile');
  io.querySelector('#importBtn').addEventListener('click', ()=> fileInp.click());
  fileInp.addEventListener('change', importSaves);
}

function syncAllUI(){ Object.values(uiRefs).forEach(f=>f()); }

/* =========================================================
   SAVE / LOAD (in-memory + JSON file export/import)
   ========================================================= */
let savedPups = [];
function renderSaved(){
  const list = document.getElementById('savedList');
  list.innerHTML = '';
  if(!savedPups.length){
    list.innerHTML = '<div class="saved-empty">No saved pups yet — hit Save!</div>';
    return;
  }
  savedPups.forEach((s, i)=>{
    const chip = document.createElement('div');
    chip.className = 'saved-chip';
    chip.innerHTML = `<div class="dot"></div><div class="nm"></div>
      <button class="btn small">Load</button><button class="btn small icon">✕</button>`;
    chip.querySelector('.dot').style.background =
      `linear-gradient(135deg, ${s.params.furColor} 55%, ${s.params.bellyColor} 56%)`;
    chip.querySelector('.nm').textContent = s.params.name;
    const [loadB, delB] = chip.querySelectorAll('button');
    loadB.addEventListener('click', ()=>{
      P = Object.assign({}, DEFAULTS, s.params);
      syncAllUI(); scheduleRebuild();
      toast(`${P.name} is back!`);
    });
    delB.addEventListener('click', ()=>{
      savedPups.splice(i,1); renderSaved();
    });
    list.appendChild(chip);
  });
}
function saveCurrent(){
  const snap = Object.assign({}, P);
  const existing = savedPups.findIndex(s=> s.params.name === snap.name);
  if(existing >= 0) savedPups[existing] = {params:snap};
  else savedPups.push({params:snap});
  renderSaved();
  toast(`${snap.name} saved!`);
}
function exportSaves(){
  const data = savedPups.length? savedPups : [{params:Object.assign({},P)}];
  const blob = new Blob([JSON.stringify({backyardPups:1, pups:data}, null, 2)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'backyard-pups.json';
  a.click();
  setTimeout(()=> URL.revokeObjectURL(a.href), 2000);
  toast('Pup file downloaded!');
}
function importSaves(e){
  const file = e.target.files[0];
  if(!file) return;
  const rd = new FileReader();
  rd.onload = ()=>{
    try{
      const data = JSON.parse(rd.result);
      const pups = data.pups || (Array.isArray(data)? data : [data]);
      let n = 0;
      pups.forEach(pp=>{
        const params = pp.params || pp;
        if(params && params.furColor){
          savedPups.push({params:Object.assign({}, DEFAULTS, params)});
          n++;
        }
      });
      renderSaved();
      toast(n? `Imported ${n} pup${n>1?'s':''}!` : 'No pups found in that file.');
    }catch(err){
      toast('That file could not be read.');
    }
  };
  rd.readAsText(file);
  e.target.value = '';
}
renderSaved();

/* ---------- randomize ---------- */
function randomize(){
  const rnd = Math.random;
  const pick = a=> a[Math.floor(rnd()*a.length)];
  const fur = pick(FURS);
  P = Object.assign({}, DEFAULTS, {
    name: P.name,
    size: 0.6+rnd()*0.9,
    bodyLength: 0.75+rnd()*0.8, girth: 0.75+rnd()*0.7,
    legLength: 0.5+rnd()*1.0, legThick: 0.65+rnd()*0.95,
    headSize: 0.75+rnd()*0.7, snoutLength: 0.45+rnd()*1.2, snoutWidth: 0.65+rnd()*0.8,
    eyeSize: 0.7+rnd()*0.9,
    earStyle: pick(['pointy','floppy','long','round']),
    earSize: 0.7+rnd()*0.9,
    tailStyle: pick(['straight','curly','plume','stub']),
    tailLength: 0.6+rnd()*1.0,
    furColor: fur,
    bellyColor: pick(['#f2e2c3','#ffffff','#f8e6bd','#e8cfa1','#d9c1a3']),
    accentColor: pick([fur,'#43332a','#2b2b2b','#96652f','#d29a3f','#8a705c']),
    spots: rnd()<0.45,
    spotColor: pick(['#5c4126','#2b2b2b','#43332a','#a63d2e','#7d5a3c']),
    spotCount: 4+Math.floor(rnd()*18),
    spotSize: 0.6+rnd()*1.2,
    spotSeed: Math.floor(rnd()*9999),
    eyePatch: pick(['none','none','none','left','right']),
    socks: rnd()<0.4,
    sockColor: pick(['#f2e2c3','#ffffff','#e8cfa1']),
    muzzlePatch: rnd()<0.6,
    collar: rnd()<0.8,
    collarColor: pick(['#e2453f','#4d8fd1','#2e6f4e','#f0b429','#7a4fd1','#ff6fa5']),
    tongue: rnd()<0.4,
    build: 0.5+rnd()*1.3,
    tailThick: 0.6+rnd()*1.1,
    eyeColor: pick(['#5a4632','#4d6a8f','#3c2e24','#2e5d3a','#6a4a26','#7a5a8f']),
    brows: rnd()<0.3,
    browColor: pick(['#2e2018','#171310','#4a3325']),
    blush: rnd()<0.2,
    freckles: rnd()<0.3,
    faceMask: pick(['none','none','none','blaze','mask']),
  });
  syncAllUI(); scheduleRebuild();
  toast('A brand new pup appears!');
}
document.getElementById('randomBtn').addEventListener('click', randomize);
document.getElementById('panelBtn').addEventListener('click', ()=>{ document.body.classList.toggle('nopanel'); setTimeout(resize, 380); });

/* ---------- toast ---------- */
let toastT = null;
function toast(msg){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(()=> t.classList.remove('show'), 1800);
}

/* =========================================================
   MODES — editor <-> play
   ========================================================= */
let mode = 'edit';
function setMode(m){
  mode = m;
  document.body.classList.toggle('play', m==='play');
  if(m==='play'){
    document.getElementById('playName').textContent = `🐶 ${P.name}`;
    syncBowl();
    dogPos.set(0,0,0);
    play.vy = 0; play.jumpY = 0;
    initAudio();
  } else {
    dogPos.set(0,0,0);
    dogYaw = -0.5;
    if(dog){ dog.position.copy(dogPos); dog.rotation.y = dogYaw; }
  }
  setTimeout(resize, 380);   // after panel slide
}
document.getElementById('playBtn').addEventListener('click', ()=> setMode('play'));
document.getElementById('backBtn').addEventListener('click', ()=> setMode('edit'));

/* ---------- editor drag-to-spin ---------- */
let dragging = false, lastX = 0;
canvas.addEventListener('pointerdown', e=>{
  if(mode!=='edit') return;
  dragging = true; lastX = e.clientX;
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', e=>{
  if(!dragging || mode!=='edit') return;
  dogYaw += (e.clientX - lastX) * 0.012;
  lastX = e.clientX;
});
canvas.addEventListener('pointerup', ()=> dragging = false);
canvas.addEventListener('pointercancel', ()=> dragging = false);

/* =========================================================
   PLAY — input, movement, jump, bark
   ========================================================= */
const keys = {};
const play = {
  vy: 0, jumpY: 0, grounded: true,
  barkT: 0, squash: 0, splashT: 0,
  phase: 0, speedNow: 0,
  runToggle: false,
};
window.addEventListener('keydown', e=>{
  const k = e.key.toLowerCase();
  if(mode==='play'){
    if(['arrowup','arrowdown','arrowleft','arrowright',' '].includes(e.key.toLowerCase()) || e.key===' ') e.preventDefault();
    if(e.key===' '){ e.preventDefault(); tryJump(); }
    if(k==='b') bark();
    if(k==='f') fillBowl();
    if(e.key==='Escape') setMode('edit');
  }
  keys[k] = true;
});
window.addEventListener('keyup', e=>{ keys[e.key.toLowerCase()] = false; });

/* on-screen pad */
document.querySelectorAll('#dpad .pbtn').forEach(b=>{
  const k = {up:'arrowup', down:'arrowdown', left:'arrowleft', right:'arrowright'}[b.dataset.k];
  const on = e=>{ e.preventDefault(); keys[k] = true; b.classList.add('held'); };
  const off = e=>{ keys[k] = false; b.classList.remove('held'); };
  b.addEventListener('pointerdown', on);
  b.addEventListener('pointerup', off);
  b.addEventListener('pointerleave', off);
  b.addEventListener('pointercancel', off);
});
document.getElementById('jumpBtn').addEventListener('pointerdown', e=>{ e.preventDefault(); tryJump(); });
document.getElementById('barkBtn').addEventListener('pointerdown', e=>{ e.preventDefault(); bark(); });
document.getElementById('fillBtn').addEventListener('pointerdown', e=>{ e.preventDefault(); fillBowl(); });
document.getElementById('runBtn').addEventListener('click', function(){
  play.runToggle = !play.runToggle;
  this.classList.toggle('on', play.runToggle);
});

function tryJump(){
  if(mode!=='play' || !play.grounded) return;
  play.vy = 7.2 / Math.sqrt(P.size);
  play.grounded = false;
  yip(1.4);
}

/* ---------- audio (WebAudio synth barks) ---------- */
let AC = null;
function initAudio(){
  if(!AC){
    try{ AC = new (window.AudioContext || window.webkitAudioContext)(); }catch(e){}
  }
  if(AC && AC.state === 'suspended') AC.resume();
}
function woofBurst(when, pitchMul, dur=0.14){
  if(!AC) return;
  const o = AC.createOscillator();
  const f = AC.createBiquadFilter();
  const gn = AC.createGain();
  o.type = 'sawtooth';
  const base = 320 * pitchMul;
  o.frequency.setValueAtTime(base, when);
  o.frequency.exponentialRampToValueAtTime(base*0.28, when+dur);
  f.type = 'lowpass';
  f.frequency.setValueAtTime(900*pitchMul, when);
  f.frequency.exponentialRampToValueAtTime(240, when+dur);
  f.Q.value = 4;
  gn.gain.setValueAtTime(0.0001, when);
  gn.gain.exponentialRampToValueAtTime(0.5, when+0.015);
  gn.gain.exponentialRampToValueAtTime(0.0001, when+dur);
  o.connect(f).connect(gn).connect(AC.destination);
  o.start(when); o.stop(when+dur+0.02);
}
function bark(){
  if(mode!=='play') return;
  initAudio();
  play.barkT = 0.55;
  if(AC){
    const t = AC.currentTime;
    const pm = 1/Math.sqrt(P.size);            // small dogs yip higher
    woofBurst(t, pm);
    woofBurst(t+0.18, pm*0.94);
  }
  // barking sends nearby critters running
  critters.forEach(c=>{
    if(Math.hypot(c.pos.x - dogPos.x, c.pos.z - dogPos.z) < 8) startFlee(c);
  });
  // scare the ball a little if close
  const d = ball.mesh.position.clone().sub(dogPos); d.y = 0;
  if(d.length() < 3.2*P.size + 1){
    d.normalize();
    ball.vel.addScaledVector(d, 3.2);
    ball.vel.y = 2.2;
  }
}
function yip(pitch){
  initAudio();
  if(!AC) return;
  woofBurst(AC.currentTime, pitch/Math.sqrt(P.size), 0.09);
}

/* =========================================================
   PARTICLES
   ========================================================= */
const particles = [];
const partGeo = new THREE.SphereGeometry(1, 6, 5);
const partMats = {};
function pmat(c){ return partMats[c] || (partMats[c] = new THREE.MeshBasicMaterial({color:c})); }
function spawnParticle(x,y,z, vx,vy,vz, r, color, life){
  const m = new THREE.Mesh(partGeo, pmat(color));
  m.scale.setScalar(r);
  m.position.set(x,y,z);
  scene.add(m);
  particles.push({m, v:new THREE.Vector3(vx,vy,vz), r, life, total:life});
}
function updateParticles(dt){
  for(let i=particles.length-1;i>=0;i--){
    const p = particles[i];
    p.life -= dt;
    if(p.life <= 0){ scene.remove(p.m); particles.splice(i,1); continue; }
    p.v.y -= 9*dt;
    p.m.position.addScaledVector(p.v, dt);
    if(p.m.position.y < 0.02){ p.m.position.y = 0.02; p.v.set(0,0,0); }
    p.m.scale.setScalar(p.r * Math.max(0.15, p.life/p.total));
  }
}

/* =========================================================
   FLOWERS — trample & regrow
   ========================================================= */
function popFlower(f, eaten){
  f.alive = false;
  f.head.visible = false;
  if(f.core) f.core.visible = false;
  f.g.scale.y = 0.3;
  f.timer = (eaten? 18 : 14) + Math.random()*12;
  f.claimed = null;
  eaten? munchSound(0.9) : popSound();
  const n = eaten? 5 : 8;
  for(let i=0;i<n;i++){
    spawnParticle(f.pos.x, 0.55, f.pos.z,
      (Math.random()-0.5)*2.6, 1.4+Math.random()*2.2, (Math.random()-0.5)*2.6,
      0.045+Math.random()*0.04, i<n-2? f.color : '#4ea94a', 0.65+Math.random()*0.25);
  }
}
function freeFlower(f){
  if(f.alive){ f.head.visible = true; if(f.core) f.core.visible = true; }
}
function updateFlowers(dt){
  for(const f of FLOWERS){
    if(!f.alive){
      f.timer -= dt;
      if(f.timer <= 0){ f.alive = true; f.head.visible = true; if(f.core) f.core.visible = true; syncBowl(); }
    } else {
      if(f.g.scale.y < 1) f.g.scale.y = Math.min(1, f.g.scale.y + dt*1.5);
      if(mode==='play' && play.grounded && play.speedNow > 0.5){
        const dx = f.pos.x - dogPos.x, dz = f.pos.z - dogPos.z;
        const rr = 0.55 + 0.45*P.size;
        if(dx*dx + dz*dz < rr*rr){ popFlower(f, false); syncBowl(); }
      }
    }
  }
}

/* =========================================================
   BOWL — kibble the squirrels want
   ========================================================= */
function syncBowl(){
  BOWL.kibbles.forEach((k,i)=> k.visible = i < BOWL.count);
  const st = document.getElementById('yardStatus');
  if(st){
    const blooms = FLOWERS.filter(f=>f.alive).length;
    st.innerHTML = `🍖 ${BOWL.count}/${BOWL_MAX} &nbsp;·&nbsp; 🌷 ${blooms}/${FLOWERS.length}`;
  }
}
function fillBowl(){
  if(BOWL.count >= BOWL_MAX){ toast('The bowl is already full.'); return; }
  BOWL.count = BOWL_MAX;
  syncBowl();
  BOWL.pop = 0.35;
  munchSound(1.5);
  toast('Bowl filled with kibble!');
}
function takeKibble(){
  if(BOWL.count <= 0) return false;
  BOWL.count--;
  syncBowl();
  BOWL.pop = 0.2;
  return true;
}
function updateBowl(dt){
  if(BOWL.pop > 0){
    BOWL.pop = Math.max(0, BOWL.pop - dt*1.8);
    BOWL.group.scale.setScalar(1 + BOWL.pop*0.5);
  }
  if(mode !== 'play') return;
  // dog eats when it stands at the bowl
  BOWL.eatCd = (BOWL.eatCd || 0) - dt;
  const near = Math.hypot(dogPos.x - BOWL.pos.x, dogPos.z - BOWL.pos.z) < 1.1 + 0.6*P.size;
  if(near && play.grounded && play.speedNow < 1.6 && BOWL.count > 0 && BOWL.eatCd <= 0){
    BOWL.eatCd = 0.75;
    takeKibble();
    munchSound(1);
    play.eatT = 0.4;
    for(let i=0;i<4;i++){
      spawnParticle(BOWL.pos.x + (Math.random()-0.5)*0.5, 0.45, BOWL.pos.z + (Math.random()-0.5)*0.5,
        (Math.random()-0.5)*1.4, 0.8+Math.random()*1.2, (Math.random()-0.5)*1.4,
        0.04, '#a9722f', 0.45);
    }
  }
}

/* =========================================================
   CRITTERS — rabbits raid the garden, squirrels raid the bowl
   ========================================================= */
const critters = [];
let critterTimer = 4;
function makeRabbit(){
  const g = new THREE.Group();
  const c = ['#e8e2d8','#b9aa97','#cdbfa8'][Math.floor(Math.random()*3)];
  const fur = toon(c);
  const body = M(new THREE.SphereGeometry(0.3, 14, 12), fur);
  body.scale.set(1.15, 0.92, 0.85); body.position.y = 0.3; g.add(body);
  const head = M(new THREE.SphereGeometry(0.2, 12, 10), fur);
  head.position.set(0.3, 0.52, 0); g.add(head);
  [-1,1].forEach(sd=>{
    const ear = M(new THREE.SphereGeometry(0.11, 10, 8), fur);
    ear.scale.set(0.5, 2.3, 0.35);
    ear.position.set(0.22, 0.86, sd*0.09);
    ear.rotation.x = sd*0.18; ear.rotation.z = 0.28;
    g.add(ear);
    const eye = M(new THREE.SphereGeometry(0.032, 6, 5), new THREE.MeshBasicMaterial({color:'#1c1310'}), false);
    eye.position.set(0.46, 0.56, sd*0.11); g.add(eye);
  });
  const tail = M(new THREE.SphereGeometry(0.1, 8, 8), toon('#ffffff'));
  tail.position.set(-0.32, 0.36, 0); g.add(tail);
  const nose = M(new THREE.SphereGeometry(0.035, 6, 5), toon('#e58a9a'), false);
  nose.position.set(0.5, 0.5, 0); g.add(nose);
  const loot = M(new THREE.SphereGeometry(0.11, 8, 6), toon('#ff8bb0'), false);
  loot.position.set(0.52, 0.44, 0); loot.visible = false; g.add(loot);
  return {g, tailG:null, loot, head:null};
}
function makeSquirrel(){
  const g = new THREE.Group();
  const c = ['#a4653a','#8a5230','#b3764a'][Math.floor(Math.random()*3)];
  const fur = toon(c);
  const body = M(new THREE.SphereGeometry(0.22, 12, 10), fur);
  body.scale.set(1.2, 0.9, 0.8); body.position.y = 0.22; g.add(body);
  const head = M(new THREE.SphereGeometry(0.15, 12, 10), fur);
  head.position.set(0.26, 0.4, 0); g.add(head);
  [-1,1].forEach(sd=>{
    const ear = M(new THREE.ConeGeometry(0.05, 0.1, 6), fur);
    ear.position.set(0.22, 0.55, sd*0.08); g.add(ear);
    const eye = M(new THREE.SphereGeometry(0.028, 6, 5), new THREE.MeshBasicMaterial({color:'#1c1310'}), false);
    eye.position.set(0.38, 0.43, sd*0.09); g.add(eye);
  });
  const belly = M(new THREE.SphereGeometry(0.15, 10, 8), toon('#e8d3b8'), false);
  belly.scale.set(0.9, 0.75, 0.7); belly.position.set(0.08, 0.17, 0); g.add(belly);
  // big arched tail
  const tailG = new THREE.Group();
  tailG.position.set(-0.24, 0.2, 0);
  const pts = [[0,0.05],[-0.1,0.25],[-0.12,0.48],[-0.04,0.66],[0.1,0.74]];
  pts.forEach(([tx,ty],i)=>{
    const s = M(new THREE.SphereGeometry(0.085 + 0.035*Math.sin(i/4*Math.PI), 10, 8),
      i===pts.length-1? toon('#c99569') : fur);
    s.position.set(tx, ty, 0);
    tailG.add(s);
  });
  g.add(tailG);
  const loot = M(new THREE.SphereGeometry(0.1, 8, 6), toon('#a9722f'), false);
  loot.scale.set(1, 0.7, 1.15);
  loot.position.set(0.42, 0.36, 0); loot.visible = false; g.add(loot);
  return {g, tailG, loot};
}
function randomInterior(){
  return {x:(Math.random()*2-1)*(YARD.x-1), z:(Math.random()*2-1)*(YARD.z-1)};
}
// a rabbit picks an unclaimed bloom to nibble
function pickFlower(c){
  const open = FLOWERS.filter(f=> f.alive && (!f.claimed || f.claimed===c));
  if(!open.length) return null;
  const f = open[Math.floor(Math.random()*open.length)];
  f.claimed = c;
  return f;
}
function chooseGoal(c){
  if(c.type === 'squirrel'){
    if(BOWL.count > 0){
      c.state = 'goal';
      c.goalKind = 'bowl';
      c.target = {x: BOWL.pos.x + (Math.random()-0.5)*0.7, z: BOWL.pos.z + 0.95};
      return;
    }
  } else {
    const f = pickFlower(c);
    if(f){
      c.state = 'goal';
      c.goalKind = 'flower';
      c.flower = f;
      c.target = {x: f.pos.x, z: f.pos.z + 0.55};
      return;
    }
  }
  c.state = 'wander';
  c.goalKind = null;
  c.target = randomInterior();
}
function spawnCritter(){
  const type = Math.random() < 0.5 ? 'rabbit' : 'squirrel';
  const made = type==='rabbit' ? makeRabbit() : makeSquirrel();
  const side = Math.floor(Math.random()*4);
  const pos = side===0 ? {x:-(YARD.x+1.8), z:(Math.random()*2-1)*YARD.z}
            : side===1 ? {x:(YARD.x+1.8),  z:(Math.random()*2-1)*YARD.z}
            : side===2 ? {x:(Math.random()*2-1)*YARD.x, z:-(YARD.z+1.8)}
            :            {x:(Math.random()*2-1)*YARD.x, z:(YARD.z+1.8)};
  made.g.position.set(pos.x, 0, pos.z);
  scene.add(made.g);
  const c = {
    ...made, type, pos, yaw:0, hop:Math.random()*6,
    state:'wander', goalKind:null, flower:null, target:randomInterior(),
    speed: type==='rabbit' ? 1.5 : 2.1, timer:0, meals:0, carrying:false,
  };
  critters.push(c);
  chooseGoal(c);
}
function startFlee(c){
  if(c.state==='flee') return;
  if(c.flower){ if(c.flower.claimed===c) c.flower.claimed = null; c.flower = null; }
  c.state = 'flee';
  c.goalKind = null;
  const exitX = Math.abs(c.pos.x)/YARD.x > Math.abs(c.pos.z)/YARD.z;
  c.target = exitX
    ? {x: Math.sign(c.pos.x || 1)*(YARD.x+2.5), z: c.pos.z}
    : {x: c.pos.x, z: Math.sign(c.pos.z || 1)*(YARD.z+2.5)};
}
function removeCritter(i){
  const c = critters[i];
  if(c.flower && c.flower.claimed===c) c.flower.claimed = null;
  scene.remove(c.g);
  disposeGroup(c.g);
  critters.splice(i,1);
}
function updateCritters(dt, t){
  critterTimer -= dt;
  if(critterTimer <= 0){
    critterTimer = 7 + Math.random()*8;
    if(critters.length < 2) spawnCritter();
  }
  for(let i=critters.length-1; i>=0; i--){
    const c = critters[i];
    const dd = Math.hypot(c.pos.x - dogPos.x, c.pos.z - dogPos.z);
    if(c.state !== 'flee' && dd < 3.6) startFlee(c);

    // the prize may vanish while they're en route
    if(c.state==='goal' && c.goalKind==='bowl' && BOWL.count<=0) chooseGoal(c);
    if(c.state==='goal' && c.goalKind==='flower' && (!c.flower || !c.flower.alive)){
      if(c.flower && c.flower.claimed===c) c.flower.claimed = null;
      c.flower = null;
      chooseGoal(c);
    }

    if(c.state === 'pause'){
      c.timer -= dt;
      if(c.timer <= 0) chooseGoal(c);
    } else if(c.state === 'nibble'){
      c.timer -= dt;
      // crumbs while they work
      if(Math.random() < dt*7){
        const col = c.goalKind==='flower' ? (c.flower? c.flower.color : '#ff8bb0') : '#a9722f';
        spawnParticle(c.pos.x + (Math.random()-0.5)*0.3, 0.45, c.pos.z + (Math.random()-0.5)*0.3,
          (Math.random()-0.5)*0.9, 0.5+Math.random(), (Math.random()-0.5)*0.9, 0.032, col, 0.4);
      }
      if(c.timer <= 0){
        if(c.goalKind === 'flower'){
          if(c.flower && c.flower.alive){
            popFlower(c.flower, true);
            c.meals++;
            if(c.loot){ c.loot.material = toon(c.flower.color); }
          }
          c.flower = null;
          if(c.meals >= 2 + Math.floor(Math.random()*2)){
            if(c.loot) c.loot.visible = true;
            startFlee(c);
          } else chooseGoal(c);
        } else if(c.goalKind === 'bowl'){
          if(takeKibble()){
            c.carrying = true;
            if(c.loot) c.loot.visible = true;
            munchSound(1.3);
          }
          startFlee(c);
        } else chooseGoal(c);
      }
    } else {
      const dx = c.target.x - c.pos.x, dz = c.target.z - c.pos.z;
      const dist = Math.hypot(dx, dz);
      const sp = c.speed * (c.state==='flee' ? 3.0 : c.state==='goal' ? 1.25 : 1);
      if(dist < 0.3){
        if(c.state === 'flee'){ removeCritter(i); continue; }
        if(c.state === 'goal'){
          c.state = 'nibble';
          c.timer = c.goalKind==='flower' ? 1.6 + Math.random()*1.2 : 1.2 + Math.random()*0.8;
          if(c.goalKind === 'flower' && c.flower){
            c.yaw = Math.atan2(-(c.flower.pos.z - c.pos.z), c.flower.pos.x - c.pos.x);
          } else {
            c.yaw = Math.atan2(-(BOWL.pos.z - c.pos.z), BOWL.pos.x - c.pos.x);
          }
        } else if(Math.random() < 0.5){ c.state = 'pause'; c.timer = 0.7 + Math.random()*1.4; }
        else chooseGoal(c);
      } else {
        c.pos.x += dx/dist * sp * dt;
        c.pos.z += dz/dist * sp * dt;
        c.yaw = Math.atan2(-dz/dist, dx/dist);
      }
      // fled past the fence: gone
      if(Math.abs(c.pos.x) > YARD.x+1.2 || Math.abs(c.pos.z) > YARD.z+1.2){
        if(c.state === 'flee'){ removeCritter(i); continue; }
      }
    }
    const still = (c.state==='pause' || c.state==='nibble');
    c.hop += dt * (still ? 2 : c.speed * (c.state==='flee' ? 9 : 5.5));
    const hopH = still ? 0
      : Math.abs(Math.sin(c.hop)) * (c.type==='rabbit' ? 0.24 : 0.12);
    c.g.position.set(c.pos.x, hopH, c.pos.z);
    c.g.rotation.y = c.yaw;
    c.g.rotation.z = c.state==='nibble' ? 0.24 + Math.sin(t*16)*0.09 : 0;
    if(c.tailG) c.tailG.rotation.x = Math.sin(t*6 + i)*0.18;
  }
}

/* ---------- extra sounds ---------- */
let noiseBuf = null;
function getNoise(){
  if(!AC) return null;
  if(!noiseBuf){
    noiseBuf = AC.createBuffer(1, AC.sampleRate*0.25, AC.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for(let i=0;i<d.length;i++) d[i] = Math.random()*2-1;
  }
  return noiseBuf;
}
function splashSound(vol=0.15){
  initAudio();
  if(!AC) return;
  const src = AC.createBufferSource();
  src.buffer = getNoise();
  const f = AC.createBiquadFilter();
  f.type = 'lowpass'; f.frequency.value = 1300; f.Q.value = 0.8;
  const gn = AC.createGain();
  const tNow = AC.currentTime;
  gn.gain.setValueAtTime(vol, tNow);
  gn.gain.exponentialRampToValueAtTime(0.0001, tNow + 0.22);
  src.connect(f).connect(gn).connect(AC.destination);
  src.start(tNow); src.stop(tNow + 0.24);
}
function munchSound(pitch=1){
  initAudio();
  if(!AC) return;
  const src = AC.createBufferSource();
  src.buffer = getNoise();
  src.playbackRate.value = 0.6*pitch;
  const f = AC.createBiquadFilter();
  f.type = 'bandpass'; f.frequency.value = 700*pitch; f.Q.value = 1.6;
  const gn = AC.createGain();
  const tNow = AC.currentTime;
  gn.gain.setValueAtTime(0.0001, tNow);
  gn.gain.exponentialRampToValueAtTime(0.12, tNow + 0.02);
  gn.gain.exponentialRampToValueAtTime(0.0001, tNow + 0.16);
  src.connect(f).connect(gn).connect(AC.destination);
  src.start(tNow); src.stop(tNow + 0.18);
}
function popSound(){
  initAudio();
  if(!AC) return;
  const o = AC.createOscillator();
  const gn = AC.createGain();
  const tNow = AC.currentTime;
  o.type = 'triangle';
  o.frequency.setValueAtTime(480, tNow);
  o.frequency.exponentialRampToValueAtTime(950, tNow + 0.07);
  gn.gain.setValueAtTime(0.18, tNow);
  gn.gain.exponentialRampToValueAtTime(0.0001, tNow + 0.09);
  o.connect(gn).connect(AC.destination);
  o.start(tNow); o.stop(tNow + 0.1);
}

/* =========================================================
   MAIN LOOP
   ========================================================= */
const clock = new THREE.Clock();
const camTarget = new THREE.Vector3();
const camPosGoal = new THREE.Vector3();
let blinkT = 2.5;

function animate(){
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;

  // clouds drift + water flows
  CLOUDS.forEach((c,i)=>{
    c.position.x += dt * (0.25 + i*0.06);
    if(c.position.x > 40) c.position.x = -44;
  });
  WATER.tex.offset.y -= dt*0.35;
  updateFlowers(dt);
  updateParticles(dt);
  updateBowl(dt);
  updateCritters(dt, t);

  if(dog && R){
    /* -------- movement -------- */
    let moveX = 0, moveZ = 0;
    if(mode==='play'){
      if(keys['w']||keys['arrowup'])    moveZ -= 1;
      if(keys['s']||keys['arrowdown'])  moveZ += 1;
      if(keys['a']||keys['arrowleft'])  moveX -= 1;
      if(keys['d']||keys['arrowright']) moveX += 1;
    }
    const moving = (moveX||moveZ);
    const running = moving && (keys['shift'] || play.runToggle);
    const inStream = Math.abs(dogPos.x - STREAM.x) < STREAM.w*0.5 + 0.1;
    const targetSpeed = moving ? (running? 7.0 : 3.1) * (0.75+0.35*P.size) * (inStream? 0.62 : 1) : 0;
    play.speedNow = lerp(play.speedNow, targetSpeed, 1-Math.pow(0.0001, dt));

    if(moving){
      const len = Math.hypot(moveX, moveZ);
      const dx = moveX/len, dz = moveZ/len;
      dogPos.x = clamp(dogPos.x + dx*play.speedNow*dt, -YARD.x, YARD.x);
      dogPos.z = clamp(dogPos.z + dz*play.speedNow*dt, -YARD.z, YARD.z);
      const targetYaw = Math.atan2(-dz, dx);
      let dy = targetYaw - dogYaw;
      while(dy > Math.PI) dy -= Math.PI*2;
      while(dy < -Math.PI) dy += Math.PI*2;
      dogYaw += dy * (1-Math.pow(0.0005, dt));
    }

    /* -------- jump physics -------- */
    if(!play.grounded){
      play.vy -= 22 * dt;
      play.jumpY += play.vy * dt;
      if(play.jumpY <= 0){
        play.jumpY = 0; play.grounded = true;
        play.squash = 0.28;
        if(Math.abs(dogPos.x - STREAM.x) < STREAM.w*0.5 + 0.25){
          splashSound(0.3);
          for(let i=0;i<12;i++){
            spawnParticle(dogPos.x, 0.15, dogPos.z,
              (Math.random()-0.5)*3.6, 1.6+Math.random()*2.6, (Math.random()-0.5)*3.6,
              0.05+Math.random()*0.05, i%3? '#bfe9ff' : '#e9f8ff', 0.55+Math.random()*0.25);
          }
        }
      }
    }
    play.squash = Math.max(0, play.squash - dt*1.6);

    /* -------- gait animation -------- */
    const gaitRate = running? 15 : 9.5;
    if(play.speedNow > 0.2) play.phase += dt * gaitRate * (0.5 + play.speedNow/6);
    const amp = play.grounded ? clamp(play.speedNow/6.5, 0, 1) * (running? 0.85 : 0.55) : 0;
    R.legs.forEach((leg,i)=>{
      const off = (i===0||i===3)? 0 : Math.PI;                   // diagonal pairs
      const target = play.grounded
        ? Math.sin(play.phase + off) * amp
        : (i<2? -0.7 : 0.75);                                    // tucked jump pose
      leg.rotation.z = lerp(leg.rotation.z, target, 1-Math.pow(0.0001, dt));
    });

    // body bob + breathing + squash/stretch
    const bob = play.grounded ? Math.abs(Math.sin(play.phase)) * amp * 0.14 : 0;
    const breathe = Math.sin(t*2.2) * 0.012;
    R.bodyG.position.y = R.bodyBaseY + bob;
    const sq = play.squash;
    const airStretch = !play.grounded ? clamp(Math.abs(play.vy)*0.02, 0, 0.12) : 0;
    R.bodyG.scale.set(1 + sq*0.5 - airStretch*0.5, 1 - sq*0.6 + breathe + airStretch, 1 + sq*0.5 - airStretch*0.5);

    // tail wag: happy while moving or barking, gentle idle sway
    const wagRate = (moving || play.barkT>0)? 14 : 3.2;
    const wagAmp  = (moving || play.barkT>0)? 0.55 : 0.22;
    R.tail.rotation.x = Math.sin(t*wagRate) * wagAmp;

    // ears react — floppy/long flap outward, upright ears just twitch
    const floppy = (R.earStyle==='floppy' || R.earStyle==='long');
    R.ears.forEach((e,i)=>{
      const ud = e.userData;
      const sway = Math.sin(t*wagRate*0.7 + i*2.1) * (moving? 0.12 : 0.04);
      if(floppy){
        const lift = (moving? 0.18*clamp(play.speedNow/6,0,1) : 0) + (!play.grounded? 0.3 : 0);
        e.rotation.x = lerp(e.rotation.x, ud.baseX - ud.sd*(lift + Math.abs(sway)*0.5), 1-Math.pow(0.002, dt));
        e.rotation.y = sway;
      } else {
        e.rotation.x = ud.baseX + sway*0.4;
        e.rotation.y = sway*0.5;
      }
    });

    // head: slight lookahead while running, tilt up in jump/bark
    let headRZ = 0;
    if(!play.grounded) headRZ = 0.18;
    if(play.barkT>0)   headRZ = -0.22;
    play.eatT = Math.max(0, (play.eatT||0) - dt);
    if(play.eatT > 0) headRZ = 0.55 + Math.sin(t*22)*0.12;
    R.head.rotation.z = lerp(R.head.rotation.z, headRZ, 1-Math.pow(0.001, dt));

    // bark: jaw + bubble
    if(play.barkT > 0){
      play.barkT -= dt;
      const open = Math.max(0, Math.sin((0.55-play.barkT)/0.55 * Math.PI));
      R.jaw.rotation.z = open * 0.5;
      R.tongue.visible = true;
      R.tongue.rotation.z = R.tongueBaseRot - open*0.3 + Math.sin(t*40)*0.06*open;
      R.bubble.visible = true;
      const pop = clamp((0.55-play.barkT)*8, 0, 1);
      const bs = pop / Math.max(P.size, 0.6);
      R.bubble.scale.set(2.2*bs, 1.4*bs, 1);
    } else {
      R.jaw.rotation.z = lerp(R.jaw.rotation.z, 0, 1-Math.pow(0.001, dt));
      R.tongue.visible = R.tongueDefault;
      R.tongue.rotation.z = lerp(R.tongue.rotation.z, R.tongueBaseRot, 1-Math.pow(0.001, dt));
      R.bubble.visible = false;
    }

    // blink
    blinkT -= dt;
    if(blinkT < 0) blinkT = 2 + Math.random()*3.5;
    const blinking = blinkT < 0.12;
    R.pupils.forEach(pp=> pp.scale.y = blinking? 0.12 : 1);

    // editor idle spin hint
    if(mode==='edit' && !dragging) dogYaw += dt*0.12;

    dog.position.set(dogPos.x, play.jumpY, dogPos.z);
    dog.rotation.y = dogYaw;

    // wading splashes
    if(mode==='play' && inStream && play.grounded && play.speedNow > 0.6){
      play.splashT -= dt;
      if(play.splashT <= 0){
        play.splashT = 0.13;
        splashSound(0.07);
        for(let i=0;i<3;i++){
          spawnParticle(dogPos.x + (Math.random()-0.5)*0.6, 0.12, dogPos.z + (Math.random()-0.5)*0.6,
            (Math.random()-0.5)*2.2, 1.2+Math.random()*1.6, (Math.random()-0.5)*2.2,
            0.04+Math.random()*0.035, i? '#bfe9ff' : '#e9f8ff', 0.5);
        }
      }
    }

    /* -------- ball physics -------- */
    const bp = ball.mesh.position;
    ball.vel.y -= 14*dt;
    bp.addScaledVector(ball.vel, dt);
    if(bp.y < ball.r){ bp.y = ball.r; if(ball.vel.y < -0.5) ball.vel.y *= -0.55; else ball.vel.y = 0; }
    ball.vel.x *= Math.pow(0.35, dt); ball.vel.z *= Math.pow(0.35, dt);
    if(Math.abs(bp.x) > YARD.x){ bp.x = clamp(bp.x,-YARD.x,YARD.x); ball.vel.x *= -0.7; }
    if(Math.abs(bp.z) > YARD.z){ bp.z = clamp(bp.z,-YARD.z,YARD.z); ball.vel.z *= -0.7; }
    // dog pushes ball
    const dvec = bp.clone().sub(new THREE.Vector3(dogPos.x, ball.r, dogPos.z));
    const minD = ball.r + 1.15*P.size;
    if(play.grounded && dvec.length() < minD){
      dvec.y = 0; dvec.normalize();
      bp.x = dogPos.x + dvec.x*minD;
      bp.z = dogPos.z + dvec.z*minD;
      ball.vel.addScaledVector(dvec, Math.max(2.5, play.speedNow*1.15));
      ball.vel.y = Math.max(ball.vel.y, play.speedNow*0.35);
    }
    // gentle current pushes the ball downstream
    if(Math.abs(bp.x - STREAM.x) < STREAM.w*0.5) ball.vel.z += 2.0*dt;
    // roll
    const sp = Math.hypot(ball.vel.x, ball.vel.z);
    if(sp > 0.05){
      ball.spinAxis.set(ball.vel.z, 0, -ball.vel.x).normalize();
      ball.mesh.rotateOnWorldAxis(ball.spinAxis, sp*dt/ball.r);
    }

    /* -------- camera -------- */
    const focusY = R.hipHeight + 0.4;
    if(mode==='edit'){
      camPosGoal.set(dogPos.x + 4.6*Math.max(1,P.size*0.9), 2.6 + 1.6*P.size, dogPos.z + 7.4*Math.max(1,P.size*0.9));
      camTarget.set(dogPos.x, focusY*0.85, dogPos.z);
    } else {
      camPosGoal.set(dogPos.x, 7.6, dogPos.z + 11.5);
      camTarget.set(dogPos.x, play.jumpY*0.5 + 1.0, dogPos.z);
    }
    camera.position.lerp(camPosGoal, 1-Math.pow(0.002, dt));
    camera.lookAt(camTarget);
  }

  renderer.render(scene, camera);
}

/* ---------- boot ---------- */
rebuild();
syncBowl();
registerServiceWorker();
resize();
animate();
toast('Welcome! Pick a base pup and start sculpting 🐾');
