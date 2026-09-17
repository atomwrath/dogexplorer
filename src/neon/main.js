/* NEON PUPS -- hoverboard racing on the same real trail maps Pup Trails walks.

   What is shared with Pup Trails: the pup-world bundle (vectors + DEM), parseFeatures and
   buildGraph from trails/geo.js, the dog builder, the animal models, the kennel, audio.
   What is NOT: terrain meshing, standingY, colliders, the whole world.js. A racer here
   never touches the ground -- it lives in track space (see track.js), on a ribbon laid
   along one automatically generated course (see routes.js), between two bumpers it
   cannot get past (see racer.js).

   Screens are one attribute, body[data-screen] = menu | count | race | finish, the same
   idea as trails/panes.js: one source of truth, CSS does the showing and hiding. */
import { clamp, lerp, mulberry32 } from '../core/math.js';
import { renderer, scene, camera, resize } from '../core/render.js';
import { initAudio, countPip, goTone, bonkSound, cheerSound, thudSound } from '../core/audio.js';
import { loadWorldBundle } from '../data/world_bundle.js';
import { SPECIES } from '../data/species.js';
import { kennelPups, loadKennel } from '../data/kennel.js';
import { PRESETS } from '../creator/presets.js';
import { parseFeatures, buildGraph } from '../trails/geo.js';
import { NEON, NEON_SKILL } from './tuning.js';
import { buildCourses } from './routes.js';
import { buildTrack, trackFrame, trackToWorld, deckY, calmestStart, rotateTrack, assembleLine } from './track.js';
import { makeRacer, stepRacer, rivalInput, resolveContacts, rankRacers, raceDistance } from './racer.js';
import { buildEnvironment, buildTrackMesh, clearTrackMesh, bumperPulse, updateScene } from './neon-scene.js';
import { makeRider, poseRider, disposeRider } from './riders.js';
import { initNeonInput, readNeonInput, resetNeonInput } from './neon-input.js';
import { startHum, setHum, stopHum } from './neon-sound.js';
import { paintMap, paintDots } from './map2d.js';

const DEFAULT_NEON_WORLD = '../data/world.json';
const NEON_STORE = 'dogexplorer.neon';
const RIVAL_COLORS = [0xff2bd6, 0xff8a1f, 0xffe14a, 0x9a6bff, 0xff4466, 0x2bffc0, 0xff9ee6, 0x4f8cff];
const PLAYER_COLOR = 0xb6ff3c;
const PHYS_DT = 1/120;

const $ = id => document.getElementById(id);
const hex = n => '#' + n.toString(16).padStart(6, '0');

/* ---------- state ---------- */
let dem = null;                 // World (has heights) or null for plain GeoJSON
let graph = null, mapBox = null, mapId = '', courses = [], coverInfo = null;
let selCourse = 0;
const trackCache = new Map();
let activeTrack = null;         // the ribbon currently in the scene
const settings = {rivals: 5, skill: 'fair', gravity: true, rider: 'p:0', map: DEFAULT_NEON_WORLD};
let bests = {};
let race = null;                // {T, racers, riders, me, phase, countT, t, mixed, shownFinish}
let neonScreen = 'menu';   // NOT `screen`: the bundle is one classic script, and a
                            // top-level `let screen` would shadow window.screen for core/quality.js
let menuS = 0, camYaw = 0, shake = 0, lastT = 0, physAcc = 0, clockT = 0;
const camPos = {x:0, y:30, z:0};

function neonReadStore(){
  try{
    const s = JSON.parse(localStorage.getItem(NEON_STORE) || 'null');
    if(s && s.settings) Object.assign(settings, s.settings);
    if(s && s.bests) bests = s.bests;
  }catch(e){ /* private mode: play without persistence */ }
}
function neonWriteStore(){
  try{ localStorage.setItem(NEON_STORE, JSON.stringify({settings, bests})); }catch(e){}
}
function setScreen(name){ neonScreen = name; document.body.setAttribute('data-screen', name); }
function fmtTime(t){
  if(t == null || !isFinite(t)) return '—';
  const m = Math.floor(t/60), s = t - m*60;
  return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
}
function strHash(s){ let h = 2166136261; for(let i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
const bestKey = (c, grav) => mapId + '|' + c.sig + '|g' + (grav ? 1 : 0);

/* ---------- map loading ---------- */
/* A plain GeoJSON drop has no DEM and no projection constants, so make the simplest
   honest one: equirectangular about the data's own centre. Flat ground; gravity then
   has nothing to pull on, and the menu says so. */
function flatProjector(docs){
  let lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
  const walk = c => { if(typeof c[0] === 'number'){ lo = [Math.min(lo[0], c[0]), Math.min(lo[1], c[1])]; hi = [Math.max(hi[0], c[0]), Math.max(hi[1], c[1])]; } else c.forEach(walk); };
  for(const d of docs) for(const f of (d.features || [])) if(f.geometry && f.geometry.coordinates) walk(f.geometry.coordinates);
  const lon0 = (lo[0]+hi[0])/2, lat0 = (lo[1]+hi[1])/2;
  const mLat = 111320, mLon = 111320*Math.cos(lat0*Math.PI/180);
  const pc = c => typeof c[0] === 'number' ? [(c[0]-lon0)*mLon, (lat0-c[1])*mLat] : c.map(pc);
  return {layers: docs, projectCoords: pc};
}
async function loadNeonMap(src, label){
  $('startBtn').disabled = true;
  $('mapLine').textContent = 'Loading ' + (label || 'map') + '…';
  let docs;
  if(typeof src === 'string'){
    const res = await fetch(src);
    if(!res.ok) throw new Error('Could not load ' + src + ' (' + res.status + ')');
    docs = [await res.json()];
    mapId = src.replace(/^.*\//, '');
  }else{
    docs = src;
    mapId = 'drop:' + strHash(JSON.stringify(docs.map(d => (d.features || []).length + ':' + (d.generated || '')))).toString(36);
  }
  const bundle = docs.find(d => d && d.format === 'pup-world/1');
  let proj;
  if(bundle){ dem = loadWorldBundle(bundle); proj = dem; }
  else{ dem = null; proj = flatProjector(docs.filter(d => d && (d.type === 'FeatureCollection' || d.type === 'Feature'))); }

  const lines = [];
  for(const layer of proj.layers){
    for(const l of parseFeatures(layer).lines) lines.push({name: l.name, kind: l.kind, pts: proj.projectCoords(l.pts)});
  }
  if(!lines.length) throw new Error('No trail lines in that file.');
  graph = buildGraph(lines, 16, 6);
  mapBox = {x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity};
  for(const e of graph.edges) for(const p of e.pts){
    mapBox.x0 = Math.min(mapBox.x0, p[0]); mapBox.x1 = Math.max(mapBox.x1, p[0]);
    mapBox.z0 = Math.min(mapBox.z0, p[1]); mapBox.z1 = Math.max(mapBox.z1, p[1]);
  }
  const made = buildCourses(graph, dem ? (x, z) => dem.heightAt(x, z) : null);
  courses = made.courses; coverInfo = made;
  trackCache.clear();
  buildEnvironment(dem, graph, mapBox);
  $('mapLine').textContent = (label || mapId) + ' · ' + courses.length + ' courses covering '
    + Math.round(made.coverage*100) + '% of ' + (made.totalM/1000).toFixed(1) + ' km'
    + (dem ? '' : ' · no elevation data: flat');
  selCourse = clamp(selCourse, 0, Math.max(0, courses.length-1));
  renderCourseList();
  selectCourse(selCourse);
  $('startBtn').disabled = !courses.length;
}

function trackFor(course){
  let T = trackCache.get(course.sig);
  if(!T){
    T = buildTrack(graph, course, dem);
    rotateTrack(T, calmestStart(T, 70));
    trackCache.set(course.sig, T);
  }
  return T;
}
const baseM = () => dem ? dem.minM : 0;

/* ---------- menu ---------- */
function renderCourseList(){
  const box = $('courseList');
  box.textContent = '';
  courses.forEach((c, i) => {
    const b = document.createElement('button');
    b.className = 'btn course' + (i === selCourse ? ' on' : '');
    b.setAttribute('role', 'option');
    b.dataset.course = String(i);
    const best = bests[bestKey(c, settings.gravity)];
    const nm = document.createElement('span'); nm.className = 'nm';
    const tag = document.createElement('span'); tag.className = 'tag';
    tag.textContent = c.kind === 'circuit' ? '◯' : '→';
    nm.append(tag, c.name);
    const meta = document.createElement('span'); meta.className = 'meta';
    meta.textContent = (c.lenM/1000).toFixed(2) + ' km' + (c.laps > 1 ? ' × ' + c.laps + ' laps' : '')
      + (c.kind === 'circuit' ? ' · circuit' : ' · sprint');
    const bt = document.createElement('span'); bt.className = 'best';
    bt.textContent = best ? '★ ' + fmtTime(best) : '';
    b.append(nm, meta, bt);
    b.addEventListener('click', () => selectCourse(i));
    box.appendChild(b);
  });
}
function selectCourse(i){
  if(!courses.length) return;
  selCourse = i;
  document.querySelectorAll('#courseList .course').forEach((el, k) => el.classList.toggle('on', k === i));
  const c = courses[i], T = trackFor(c);
  showTrack(T);
  menuS = 0;
  $('courseInfo').textContent = (T.L/1000).toFixed(2) + ' km' + (T.laps > 1 ? ' × ' + T.laps : '')
    + (dem ? ' · ↗ ' + Math.round(T.climb) + ' m climb' + (T.closed ? '' : ' · ' + (T.elev[T.n-1] < T.elev[0] ? '▼ ' : '▲ ')
        + Math.abs(Math.round(T.elev[T.n-1]-T.elev[0])) + ' m net') : '')
    + ' · ' + (T.twistPerKm > 9 ? 'twisty' : T.twistPerKm > 5 ? 'flowing' : 'fast');
  const line = assembleLine(graph, c).pts;
  paintMap($('preview'), graph, mapBox, line, T.closed, 'pv|' + mapId + '|' + c.sig, false);
}
function showTrack(T){
  if(activeTrack === T) return;
  activeTrack = T;
  buildTrackMesh(T, baseM());
}
function riderChoices(){
  const out = [];
  kennelPups.forEach((k, i) => out.push({v: 'k:' + i, group: 'My pups', label: k.name || ('Pup ' + (i+1)), who: {kind: 'dog', params: k.params}}));
  PRESETS.forEach((p, i) => out.push({v: 'p:' + i, group: 'Starter pups', label: p.label, who: {kind: 'dog', params: p.o}}));
  Object.keys(SPECIES).forEach(key => out.push({v: 'w:' + key, group: 'Wildlife', label: SPECIES[key].nm, who: {kind: 'wild', key}}));
  return out;
}
function fillRiderSelect(){
  const sel = $('riderSel');
  sel.textContent = '';
  const groups = new Map();
  for(const c of riderChoices()){
    if(!groups.has(c.group)){ const og = document.createElement('optgroup'); og.label = c.group; groups.set(c.group, og); sel.appendChild(og); }
    const o = document.createElement('option'); o.value = c.v; o.textContent = c.label;
    groups.get(c.group).appendChild(o);
  }
  if(!riderChoices().some(c => c.v === settings.rider)) settings.rider = 'p:0';
  sel.value = settings.rider;
}
function syncMenu(){
  $('rivalsVal').textContent = String(settings.rivals);
  document.querySelectorAll('#skillSeg .btn').forEach(b => b.classList.toggle('on', b.dataset.skill === settings.skill));
  document.querySelectorAll('#gravSeg .btn').forEach(b => b.classList.toggle('on', (b.dataset.grav === '1') === settings.gravity));
  const gb = $('gravBtn');
  gb.textContent = 'GRAVITY ' + (settings.gravity ? 'ON' : 'OFF');
  gb.classList.toggle('off', !settings.gravity);
}
function setGravity(on){
  if(settings.gravity === !!on) return;
  settings.gravity = !!on;
  /* Flipping it mid-race is allowed -- that is half the fun on a long climb -- but a run
     that used both is not comparable with either leaderboard, so it sets no record. */
  if(race && race.phase === 'go' && !race.racers[race.me].done) race.mixed = true;
  syncMenu(); neonWriteStore();
  if(neonScreen === 'menu') renderCourseList();
}

/* ---------- race ---------- */
function pickRivals(n, course, playerWho){
  const keys = Object.keys(SPECIES).filter(k => !(playerWho.kind === 'wild' && playerWho.key === k));
  const rnd = mulberry32(strHash(course.sig) || 1);
  for(let i = keys.length-1; i > 0; i--){ const j = Math.floor(rnd()*(i+1)); const t = keys[i]; keys[i] = keys[j]; keys[j] = t; }
  let lo = Infinity, hi = -Infinity;
  for(const k in SPECIES){ lo = Math.min(lo, SPECIES[k].speed); hi = Math.max(hi, SPECIES[k].speed); }
  return keys.slice(0, n).map((key, i) => ({
    key, name: SPECIES[key].nm, color: RIVAL_COLORS[i % RIVAL_COLORS.length],
    // a deer is quicker than a possum, but only just: this is a board race, not a footrace
    paceMul: 0.95 + 0.07*(SPECIES[key].speed - lo)/Math.max(0.01, hi - lo),
    seed: 1 + Math.floor(rnd()*1e6),
  }));
}
function endRace(){
  if(!race) return;
  for(const R of race.riders) disposeRider(R);
  race = null;
  stopHum();
}
function startRace(){
  if(!courses.length) return;
  initAudio();
  endRace();
  const course = courses[selCourse], T = trackFor(course);
  showTrack(T);
  const choice = riderChoices().find(c => c.v === settings.rider) || riderChoices()[0];
  const cast = pickRivals(settings.rivals, course, choice.who);
  const racers = [], riders = [];
  const total = cast.length + 1;
  // grid: two columns, rows 7 m apart. Rivals fill from the front; you start at the back.
  const place = (k, o) => {
    /* circuits line up BEHIND the line: row 0 is nearest it */
    const row = Math.floor(k/2), col = k % 2 ? -1 : 1;
    const s = T.closed ? T.L - 5 - row*7 : 5 + (Math.ceil(total/2) - 1 - row)*7;
    const f = trackFrame(T, s, {});
    return makeRacer(Object.assign({s, d: col*(f.halfW - NEON.bodyWide)*0.5, yaw: f.yaw,
      lap: T.closed ? -1 : 0}, o));
  };
  cast.forEach((c, i) => {
    racers.push(place(i, {name: c.name, skill: NEON_SKILL[settings.skill], paceMul: c.paceMul,
      lane: ((i % 4) - 1.5)/2.2, seed: c.seed % 1000, color: c.color, emo: SPECIES[c.key].emo}));
    riders.push(makeRider({kind: 'wild', key: c.key}, c.color, c.seed));
  });
  racers.push(place(cast.length, {name: choice.label, isPlayer: true, color: PLAYER_COLOR}));
  riders.push(makeRider(choice.who, PLAYER_COLOR, 7));
  riders[riders.length-1].tag.visible = false;
  for(const r of racers) r.prog = (r.lap|0)*T.L + r.s;
  race = {T, course, racers, riders, me: racers.length-1, phase: 'count', countT: 3.4, lastPip: 4,
          t: 0, mixed: false, finishShown: false, doneCount: 0, line: assembleLine(graph, course).pts};
  rankRacers(racers);
  resetNeonInput();
  camYaw = racers[race.me].yaw;
  physAcc = 0;
  $('placeOf').textContent = '/' + racers.length;
  const best = bests[bestKey(course, settings.gravity)];
  $('hudBest').textContent = 'BEST ' + fmtTime(best);
  $('count').textContent = '3';
  setScreen('count');
  snapCamera();
  startHum();
}
function quitToMenu(){
  endRace();
  setScreen('menu');
  renderCourseList();
  selectCourse(selCourse);
}

function stepRace(dt){
  const R = race, T = R.T, env = {gravity: settings.gravity};
  if(R.phase === 'count'){
    R.countT -= dt;
    const n = Math.ceil(R.countT - 0.4);
    if(n !== R.lastPip && n >= 1 && n <= 3){ R.lastPip = n; $('count').textContent = String(n); countPip(n); }
    if(R.countT <= 0.4 && R.phase === 'count'){
      R.phase = 'go'; goTone(); $('count').textContent = 'GO'; R.goFlash = 0.7;
    }
    return;
  }
  if(R.goFlash > 0){ R.goFlash -= dt; if(R.goFlash <= 0 && neonScreen === 'count') setScreen('race'); }
  R.t += dt;
  const me = R.racers[R.me];
  const input = readNeonInput(dt);
  for(const r of R.racers){
    const inp = r.isPlayer ? input : rivalInput(r, T, R.racers, env, R.t);
    // rubber band, gently: nobody should be a dot on the horizon either way
    if(!r.isPlayer && !r.done){
      const gap = me.prog - r.prog;
      r.paceBand = clamp(gap/400, -0.06, 0.08);
      if(inp.throttle && r.paceBand < 0 && r.v > 8) inp.throttle = 1 + r.paceBand*2;
      if(r.paceBand > 0.02) inp.boost = inp.boost || (gap > 60 && r.battery > 0.3);
    }
    const ev = stepRacer(r, T, inp, env, dt);
    if(ev) onBump(r, ev);
  }
  resolveContacts(R.racers, T);
}
function onBump(r, ev){
  const T = race.T, me = race.racers[race.me];
  let gap = Math.abs(r.s - me.s); if(T.closed) gap = Math.min(gap, T.L - gap);
  if(!r.isPlayer && gap > 160) return;
  const f = trackToWorld(T, r.s, ev.bump*(trackFrame(T, r.s, {}).halfW), {});
  bumperPulse(f.wx, deckY(T, f.elev, baseM()), f.wz, f.yaw, ev.bump, ev.hard);
  if(r.isPlayer){ bonkSound(0.8 + ev.hard*0.6); shake = Math.max(shake, 0.25 + 0.5*ev.hard); }
}

function finishPlayer(){
  const R = race, me = R.racers[R.me], key = bestKey(R.course, settings.gravity);
  const old = bests[key];
  let note = '';
  if(R.mixed) note = 'Gravity was switched mid-race — no record set.';
  else if(!old || me.finishT < old){ bests[key] = +me.finishT.toFixed(2); neonWriteStore(); note = old ? '★ New best! (was ' + fmtTime(old) + ')' : '★ First time on the board.'; }
  else note = 'Best ' + fmtTime(old) + ' · +' + (me.finishT - old).toFixed(1) + ' s';
  $('finTitle').textContent = me.place === 1 ? '🏁 YOU WIN' : '🏁 P' + me.place + ' OF ' + R.racers.length;
  $('finTime').textContent = fmtTime(me.finishT);
  $('finNote').textContent = note + ' · gravity ' + (settings.gravity ? 'on' : 'off');
  if(me.place === 1) cheerSound(); else thudSound();
  renderBoard();
  setScreen('finish');
}
function renderBoard(){
  const R = race, ol = $('finBoard');
  ol.textContent = '';
  for(const r of rankRacers(R.racers)){
    const li = document.createElement('li');
    if(r.isPlayer) li.className = 'me';
    const a = document.createElement('span'), dot = document.createElement('i');
    dot.style.background = hex(r.color);
    a.append(dot, r.place + '. ' + (r.emo ? r.emo + ' ' : '') + r.name);
    const b = document.createElement('span');
    b.textContent = r.done ? fmtTime(r.finishT) : '…';
    li.append(a, b);
    ol.appendChild(li);
  }
}

/* ---------- camera ---------- */
const _cf = {}, _cb = {};
function chaseTarget(){
  const R = race, T = R.T, me = R.racers[R.me];
  const f = trackToWorld(T, me.s, me.d, _cf);
  const y = deckY(T, f.elev, baseM());
  const dist = 7.5 + me.v*0.13, high = 3.1 + me.v*0.035;
  const x = f.wx - Math.cos(camYaw)*dist, z = f.wz + Math.sin(camYaw)*dist;
  // never let a crest come between the lens and the board
  const behind = trackFrame(T, T.closed ? me.s - dist : Math.max(0, me.s - dist), _cb);
  const floorY = deckY(T, behind.elev, baseM()) + 1.6;
  return {x, y: Math.max(y + high, floorY), z, px: f.wx, py: y, pz: f.wz};
}
function snapCamera(){
  if(!race) return;
  const c = chaseTarget();
  camPos.x = c.x; camPos.y = c.y; camPos.z = c.z;
}
function updateCamera(dt){
  if(race){
    const me = race.racers[race.me];
    let dy = me.yaw - camYaw; while(dy > Math.PI) dy -= 2*Math.PI; while(dy < -Math.PI) dy += 2*Math.PI;
    camYaw += dy*Math.min(1, dt*5.5);
    const c = chaseTarget();
    const k = Math.min(1, dt*9);
    camPos.x = lerp(camPos.x, c.x, k); camPos.y = lerp(camPos.y, c.y, k); camPos.z = lerp(camPos.z, c.z, k);
    shake = Math.max(0, shake - dt*2.2);
    const sx = (Math.random()-0.5)*shake*0.7, sy = (Math.random()-0.5)*shake*0.7;
    camera.position.set(camPos.x + sx, camPos.y + sy, camPos.z);
    camera.lookAt(c.px + Math.cos(camYaw)*9, c.py + 1.3, c.pz - Math.sin(camYaw)*9);
    const want = 60 + 18*clamp(me.v/28, 0, 1) + (me.boosting ? 6 : 0);
    camera.fov = lerp(camera.fov, want, Math.min(1, dt*4));
  }else if(activeTrack){
    // menu: a slow fly-over of the selected course
    const T = activeTrack;
    menuS += dt*32;
    if(!T.closed && menuS > T.L) menuS = 0;
    const s = T.closed ? menuS % T.L : menuS;
    const f = trackFrame(T, s, _cf);
    const y = deckY(T, f.elev, baseM());
    let dy = f.yaw - camYaw; while(dy > Math.PI) dy -= 2*Math.PI; while(dy < -Math.PI) dy += 2*Math.PI;
    camYaw += dy*Math.min(1, dt*1.5);
    const k = Math.min(1, dt*2.5);
    camPos.x = lerp(camPos.x, f.x - Math.cos(camYaw)*26, k);
    camPos.y = lerp(camPos.y, y + 16, k);
    camPos.z = lerp(camPos.z, f.z + Math.sin(camYaw)*26, k);
    camera.position.set(camPos.x, camPos.y, camPos.z);
    camera.lookAt(f.x + Math.cos(f.yaw)*14, y, f.z - Math.sin(f.yaw)*14);
    camera.fov = lerp(camera.fov, 58, Math.min(1, dt*3));
  }
  camera.updateProjectionMatrix();
}

/* ---------- frame ---------- */
const _pf = {}, _pa = {};
function drawRace(dt){
  const R = race, T = R.T, b = baseM();
  R.racers.forEach((r, i) => {
    const f = trackToWorld(T, r.s, r.d, _pf);
    // pitch from the deck itself (exaggerated heights), along the way the board is pointing
    const a = trackFrame(T, r.s + 3, _pa);
    const rise = (a.elev - f.elev)*NEON.vertScale;
    const pitch = Math.atan2(rise, 3)*Math.cos(r.yaw - f.yaw);
    poseRider(R.riders[i], r, f.wx, deckY(T, f.elev, b), f.wz, pitch, clockT, dt);
  });
  const me = R.racers[R.me];
  $('placeVal').textContent = String(me.place);
  $('lapVal').textContent = T.closed ? Math.min(T.laps, Math.max(1, me.lap+1)) + '/' + T.laps
                                     : Math.round(100*clamp(me.s/T.L, 0, 1)) + '%';
  $('hudClock').textContent = fmtTime(me.done ? me.finishT : me.time);
  $('speedVal').textContent = String(Math.round(me.v*3.6));
  $('battFill').style.width = Math.round(me.battery*100) + '%';
  const pct = Math.round(me.slope*100);
  $('slopeVal').textContent = !settings.gravity ? 'gravity off' : pct > 1 ? '▲ ' + pct + '%' : pct < -1 ? '▼ ' + (-pct) + '%' : '';
  setHum(me.v, me.boosting);
  const fit = paintMap($('minimap'), graph, mapBox, R.line, T.closed, 'mm|' + mapId + '|' + R.course.sig, true);
  const dots = R.racers.map(r => { const f = trackToWorld(T, r.s, r.d, {}); return {x: f.wx, z: f.wz, color: hex(r.color), big: r.isPlayer}; });
  dots.sort((p, q) => (p.big ? 1 : 0) - (q.big ? 1 : 0));
  paintDots($('minimap'), fit, dots);
}
function frame(ms){
  requestAnimationFrame(frame);
  const now = ms/1000;
  const dt = Math.min(0.05, Math.max(0, now - lastT)); lastT = now;
  clockT += dt;
  if(race){
    physAcc += dt;
    let guard = 0;
    while(physAcc >= PHYS_DT && guard++ < 12){ stepRace(PHYS_DT); physAcc -= PHYS_DT; }
    rankRacers(race.racers);
    const me = race.racers[race.me];
    const doneNow = race.racers.filter(r => r.done).length;
    if(me.done && !race.finishShown){ race.finishShown = true; race.doneCount = doneNow; finishPlayer(); }
    else if(race.finishShown && doneNow !== race.doneCount){ race.doneCount = doneNow; renderBoard(); }
    drawRace(dt);
  }
  updateCamera(dt);
  updateScene(dt);
  renderer.render(scene, camera);
}

/* ---------- boot ---------- */
function wireUI(){
  $('startBtn').addEventListener('click', startRace);
  $('againBtn').addEventListener('click', startRace);
  $('menuBtn').addEventListener('click', quitToMenu);
  $('quitBtn').addEventListener('click', quitToMenu);
  $('gravBtn').addEventListener('click', () => setGravity(!settings.gravity));
  $('rivalsDn').addEventListener('click', () => { settings.rivals = clamp(settings.rivals-1, 0, 7); syncMenu(); neonWriteStore(); });
  $('rivalsUp').addEventListener('click', () => { settings.rivals = clamp(settings.rivals+1, 0, 7); syncMenu(); neonWriteStore(); });
  document.querySelectorAll('#skillSeg .btn').forEach(b => b.addEventListener('click', () => { settings.skill = b.dataset.skill; syncMenu(); neonWriteStore(); }));
  document.querySelectorAll('#gravSeg .btn').forEach(b => b.addEventListener('click', () => setGravity(b.dataset.grav === '1')));
  $('riderSel').addEventListener('change', e => { settings.rider = e.target.value; neonWriteStore(); });
  $('mapSel').addEventListener('change', e => {
    settings.map = e.target.value; neonWriteStore(); selCourse = 0;
    loadNeonMap(settings.map, e.target.selectedOptions[0].textContent).catch(showLoadError);
  });
  $('worldFile').addEventListener('change', async e => {
    const files = [...e.target.files]; e.target.value = '';
    if(!files.length) return;
    try{
      const docs = [];
      for(const f of files) docs.push(JSON.parse(await f.text()));
      selCourse = 0;
      await loadNeonMap(docs, files.map(f => f.name).join(' + '));
    }catch(err){ showLoadError(err); }
  });
  initNeonInput({
    gravity: () => setGravity(!settings.gravity),
    restart: () => { if(race) startRace(); },
    quit: () => { if(neonScreen !== 'menu') quitToMenu(); },
    confirm: () => { if(neonScreen === 'menu' && !$('startBtn').disabled) startRace(); else if(neonScreen === 'finish') startRace(); },
  });
}
function showLoadError(err){
  $('mapLine').textContent = '⚠ ' + (err && err.message ? err.message : 'Could not load that map.');
}
async function bootNeon(){
  neonReadStore();
  loadKennel();
  wireUI();
  fillRiderSelect();
  syncMenu();
  resize();
  const q = new URLSearchParams(location.search).get('world');
  const src = q || settings.map || DEFAULT_NEON_WORLD;
  const sel = $('mapSel');
  if([...sel.options].some(o => o.value === src)) sel.value = src;
  requestAnimationFrame(frame);
  try{
    await loadNeonMap(src, q ? q.replace(/^.*\//, '') : sel.selectedOptions[0].textContent);
  }catch(err){
    showLoadError(err);
    if(src !== DEFAULT_NEON_WORLD){ try{ await loadNeonMap(DEFAULT_NEON_WORLD, 'Garden of the Gods'); }catch(e2){ showLoadError(e2); } }
  }
}
/* test seam (tools/smoke-neon.js reads the bundle's globals directly, but one tidy
   snapshot keeps the assertions short) */
function neonState(){
  return {screen: neonScreen, tuning: NEON, graph, mapId, courses, coverInfo, selCourse, settings, race, activeTrack, bests, hasDem: !!dem};
}
bootNeon();

export { bootNeon, loadNeonMap, startRace, quitToMenu, setGravity, selectCourse, neonState, stepRace, trackFor };
