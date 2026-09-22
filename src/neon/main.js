/* NEON PUPS -- hoverboard racing on the same real trail maps Pup Trails walks.

   What is shared with Pup Trails: the pup-world bundle (vectors + DEM), parseFeatures and
   buildGraph from trails/geo.js, the dog builder, the animal models, the kennel, audio.
   What is NOT: terrain meshing, standingY, colliders, the whole world.js. A racer here
   never touches the ground -- it lives in track space (see track.js), on a ribbon laid
   along one automatically generated course (see routes.js), between two bumpers it
   cannot get past (see racer.js).

   Screens are one attribute, body[data-screen] = menu | build | count | race | finish, the
   same idea as trails/panes.js: one source of truth, CSS does the showing and hiding.

   COURSES COME FROM ONE OF TWO PLACES, and settings.mode says which. AUTO is routes.js
   reading the trail graph. CUSTOM is a list you built yourself on the build screen and
   that lives in localStorage; see the custom-courses section below. Everything downstream
   -- tracks, ghosts, best times, rivals -- takes a course object and does not care which
   end of this file it came from. */
import { clamp, lerp, mulberry32 } from '../core/math.js';
import { renderer, scene, camera, resize } from '../core/render.js';
import { initAudio, countPip, goTone, bonkSound, cheerSound, thudSound } from '../core/audio.js';
import { loadWorldBundle } from '../data/world_bundle.js';
import { SPECIES } from '../data/species.js';
import { kennelPups, loadKennel } from '../data/kennel.js';
import { PRESETS } from '../creator/presets.js';
import { parseFeatures, buildGraph } from '../trails/geo.js';
import { NEON, NEON_SKILL, NEON_CLASS, NEON_CAM, miles, feet, mph } from './tuning.js';
import { buildCourses, routeTargetM, bridgeGaps, ROUTE_MAX_LAPS } from './routes.js';
import { builderOpen, builderClose, builderAdd, builderPickAt, builderUndo, builderRedo,
         builderClear, builderDraw, builderFit, builderZoom, builderPan, builderView,
         builderStates, builderClosed, builderLenM, builderNote,
         builderCanUndo, builderCanRedo } from './builder.js';
import { buildTrack, reverseTrack, widthFactor, trackFrame, trackToWorld, deckY, calmestStart, rotateTrack, assembleLine } from './track.js';
import { makeRacer, stepRacer, rivalInput, resolveContacts, rankRacers, raceDistance, topSpeed } from './racer.js';
import { buildEnvironment, buildTrackMesh, clearTrackMesh, bumperPulse, updateScene, clearSmoke, setGridStyle } from './neon-scene.js';
import { makeRider, poseRider, disposeRider } from './riders.js';
import { initNeonInput, readNeonInput, resetNeonInput, resetSteerTouch } from './neon-input.js';
import { startHum, setHum, stopHum, burnSound, cellSound } from './neon-sound.js';
import { placeCells, stepCells, buildCellMeshes, updateCellMeshes, clearCells } from './cells.js';
import { makeRecorder, recordFrame, finishRecording, bestGhosts, keepGhost,
         makeGhostRacer, stepGhost } from './ghosts.js';
import { paintMap, paintDots } from './map2d.js';

const DEFAULT_NEON_WORLD = '../data/world.json';
const NEON_STORE = 'dogexplorer.neon';
const GHOST_COLORS = [0x8fd0ff, 0xc0a8ff, 0x9fe0c8, 0xd8d0a0, 0xb0c0e0, 0xe0b0d0];
const RIVAL_COLORS = [0xff2bd6, 0xff8a1f, 0xffe14a, 0x9a6bff, 0xff4466, 0x2bffc0, 0xff9ee6, 0x4f8cff];
const PLAYER_COLOR = 0xb6ff3c;
const PHYS_DT = 1/120;
/* A hand-built course still has to be a race: this is its floor in TRACK metres, the same
   judgement the generator makes in routeTargetM, just applied to something you drew. */
const BUILD_MIN_M = 300;
/* One slider step of grid thickness, as a fraction of a grid cell. At 10 steps a line is a
   twelfth of the cell it borders -- bold up close, and still one pixel at a distance,
   because the shader never draws a line thinner than a pixel (see neon-scene.js). */
const GRID_THICK_STEP = 0.008;
const GRID_THICK_MAX = 10;

const $ = id => document.getElementById(id);
const hex = n => '#' + n.toString(16).padStart(6, '0');

/* ---------- state ---------- */
let dem = null;                 // World (has heights) or null for plain GeoJSON
let graph = null, mapAreas = [], mapBox = null, mapId = '', courses = [], coverInfo = null;
let selCourse = 0;
const trackCache = new Map();
const trackMeta = new Map();    // sig|scale -> {L, climb, ok}: filled in by the menu scan
let scanQueue = [];
let activeTrack = null;         // the ribbon currently in the scene
const settings = {rivals: 5, skill: 'fair', gravity: true, reverse: false, scale: 1, mode: 'auto',
                  cls: 'standard', cam: 'normal', ghosts: true, rider: 'p:0', course: '', map: DEFAULT_NEON_WORLD,
                  // touch control position: how far the steer pad and buttons sit from the
                  // screen edges (ctlInset) and above the bottom edge (ctlBottom), in px
                  ctlInset: 24, ctlBottom: 16,    // ctlInset defaults AT the swipe-safe floor, not below it
                  steerMode: 'pad',               // 'pad' (drag) or 'buttons' (left/right)
                  // background grid: line thickness in slider steps (0 = always one pixel)
                  // and a hue turn in degrees (0 = the original colours)
                  gridThick: 2, gridHue: 0, gridGlow: 100};   // gridGlow: percent, 0..200
let bests = {}, ghostStore = {};
let customStore = {};           // mapId -> [{name, states, fp}]: the courses you built
let customStale = 0;            // saved courses that no longer fit this map's trail data
let graphTotalM = 0;            // raceable metres on the current map, for lapping customs
let buildIdx = -1;              // which stored course the build screen is editing, -1 = new
let race = null;                // {T, racers, riders, me, phase, t, grav, scale, reverse, ...}
let neonScreen = 'menu';   // NOT `screen`: the bundle is one classic script, and a
                            // top-level `let screen` would shadow window.screen for core/quality.js
let mapLabel = '';
let menuS = 0, camYaw = 0, shake = 0, lastT = 0, physAcc = 0, clockT = 0;
const camPos = {x:0, y:30, z:0};

function neonReadStore(){
  try{
    const s = JSON.parse(localStorage.getItem(NEON_STORE) || 'null');
    if(s && s.settings) Object.assign(settings, s.settings);
    if(s && s.bests) bests = s.bests;
    if(s && s.ghosts) ghostStore = s.ghosts;
    if(s && s.custom) customStore = s.custom;
  }catch(e){ /* private mode: play without persistence */ }
}
function neonWriteStore(){
  try{ localStorage.setItem(NEON_STORE, JSON.stringify({settings, bests, ghosts: ghostStore, custom: customStore})); }
  catch(e){
    /* Ghost recordings are the only thing here big enough to fill a quota. If they do,
       drop them all and keep the settings and the times, which are what the player would
       actually miss. */
    ghostStore = {};
    try{ localStorage.setItem(NEON_STORE, JSON.stringify({settings, bests, ghosts: {}, custom: customStore})); }catch(e2){}
  }
}
function setScreen(name){ neonScreen = name; document.body.setAttribute('data-screen', name); }
function fmtTime(t){
  if(t == null || !isFinite(t)) return '—';
  const m = Math.floor(t/60), s = t - m*60;
  return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
}
function strHash(s){ let h = 2166136261; for(let i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
/* A best time belongs to one way round one course at one scale with gravity one way, so
   all four are in the key. Changing any of them is a different race, not a slower lap. */
/* A best time belongs to one way round one course at one scale in one speed class with
   gravity one way, so all five are in the key. Changing any of them is a different race,
   not a slower lap. Rivals and camera are not: they change who you are racing and what
   you can see, never what the board can do. */
const bestKey = (c, st) => mapId + '|' + c.sig + '|g' + (st.gravity ? 1 : 0)
  + '|s' + st.scale + (st.reverse ? '|rev' : '') + '|c' + st.cls;
const fmtMi = m => miles(m).toFixed(m < 1609 ? 2 : 2) + ' mi';
const fmtFt = m => Math.round(feet(m)).toLocaleString() + ' ft';

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

/* THE MAP LIST COMES FROM data/maps.json, not this file. Adding a map to the game is a
   commit and one line in that manifest -- see its own comment for the format -- and
   nothing here needs to know a map exists until this fetch finds it. The three <option>s
   already sitting in neon/index.html are the fallback for a plain file:// open or an
   offline dev server where the fetch can't land: on failure they are left exactly as
   they are, so the dropdown still has something in it and still works, it just doesn't
   show anything added since. On success they are replaced outright, in the manifest's
   own order, and whichever value SETTINGS.MAP already names is preserved as the current
   selection if the new list still contains it. */
async function loadMapList(){
  const sel = $('mapSel');
  if(!sel) return;
  const keep = sel.value;
  try{
    const res = await fetch('../data/maps.json');
    if(!res.ok) throw new Error('maps.json ' + res.status);
    const manifest = await res.json();
    const list = Array.isArray(manifest && manifest.maps) ? manifest.maps : null;
    if(!list || !list.length) throw new Error('maps.json has no maps');
    sel.textContent = '';
    for(const m of list){
      if(!m || !m.url) continue;
      const o = document.createElement('option');
      o.value = m.url;
      o.textContent = m.name || m.url.replace(/^.*\//, '');
      sel.appendChild(o);
    }
    if(!sel.options.length) throw new Error('maps.json had no usable entries');
    if([...sel.options].some(o => o.value === keep)) sel.value = keep;
  }catch(err){
    // offline, no server, or a malformed file: keep the three built-in options as they are
    console.warn('could not load ../data/maps.json, using the built-in map list:', err);
  }
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
  mapAreas = [];
  for(const layer of proj.layers){
    const p = parseFeatures(layer);
    for(const l of p.lines) lines.push({name: l.name, kind: l.kind, pts: proj.projectCoords(l.pts)});
    for(const a of p.areas) mapAreas.push({kind: a.kind, name: a.name, rings: a.rings.map(r => proj.projectCoords(r))});
  }
  if(!lines.length) throw new Error('No trail lines in that file.');
  graph = buildGraph(lines, 16, 6);
  bridgeGaps(graph);              // near-miss breaks in the mapping; see routes.js
  mapBox = {x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity};
  for(const e of graph.edges) for(const p of e.pts){
    mapBox.x0 = Math.min(mapBox.x0, p[0]); mapBox.x1 = Math.max(mapBox.x1, p[0]);
    mapBox.z0 = Math.min(mapBox.z0, p[1]); mapBox.z1 = Math.max(mapBox.z1, p[1]);
  }
  graphTotalM = graph.edges.reduce((a, e) => a + (e.bridge ? 0 : e.lenM), 0);
  rebuildCourses();
  trackCache.clear();
  rebuildEnvironment();
  mapLabel = label || mapId;
  syncMapLine();
  const remembered = courses.findIndex(c => c.sig === settings.course);
  if(remembered >= 0) selCourse = remembered;
  selCourse = clamp(selCourse, 0, Math.max(0, courses.length-1));
  trackMeta.clear();
  renderCourseList();
  startScan();
  selectCourse(selCourse);
  if(!courses.length) $('startBtn').disabled = true;
}

/* ---------- custom courses ----------
   A course you built is stored as what you actually chose: the directed edge states, in
   order, of the map's own trail graph. Not a polyline -- the line is re-derived from the
   graph, so a course drawn on this map behaves exactly like a generated one (same
   ribbon, same clipping, same everything) instead of being a second kind of thing.

   THE PRICE OF THAT IS THAT EDGE INDICES ARE NOT PORTABLE. They are positions in an array
   built by geo.js from the map file; refetch the DEM, resimplify, edit the GeoJSON, and
   edge 114 is somewhere else entirely. So every saved course carries a fingerprint of the
   graph it was drawn on, and one drawn on a graph that no longer exists is set aside
   rather than raced -- a course whose indices have shifted under it would put you on a
   line through trails you never picked, which is worse than losing it. The connectivity
   check is the belt to the fingerprint's braces: a course that does not still join up is
   not a course, whatever the fingerprint says. */
/* Over geo.js's own edges only. Bridges are appended after them and so never move an
   index, and a map that gains a bridge must not strand every course drawn on it before. A
   course that USES a bridge is still held to chainOk, which is what catches one that
   moved. */
function graphFp(g){
  if(!g) return '';
  let m = 0, n = 0;
  for(const e of g.edges) if(!e.bridge){ m += e.lenM; n++; }
  return n + ':' + g.nodes.length + ':' + Math.round(m);
}
const stStart = s => { const e = graph.edges[s>>1]; return (s&1) ? e.b : e.a; };
const stEnd   = s => { const e = graph.edges[s>>1]; return (s&1) ? e.a : e.b; };
function chainOk(st){
  const seen = new Set();
  for(let i = 0; i < st.length; i++){
    if(!Number.isInteger(st[i]) || st[i] < 0 || (st[i]>>1) >= graph.edges.length) return false;
    if(seen.has(st[i]>>1)) return false;
    seen.add(st[i]>>1);
    if(i && stEnd(st[i-1]) !== stStart(st[i])) return false;
  }
  return st.length > 0;
}
const customEntries = () => (customStore[mapId] || []);
function customCourse(en, st, idx){
  const closed = st.length > 1 && stStart(st[0]) === stEnd(st[st.length-1]);
  const lenM = st.reduce((a, s) => a + graph.edges[s>>1].lenM, 0);
  /* A loop you drew gets laps for the same reason a generated one does: a 600 m circuit
     raced once is a countdown, a corner and a finish line. */
  const target = routeTargetM(graphTotalM, settings.scale);
  return {kind: closed ? 'circuit' : 'sprint',
          steps: st.map(s => ({ei: s>>1, fwd: !(s&1)})),
          laps: closed ? Math.max(1, Math.min(ROUTE_MAX_LAPS, Math.round(target/lenM))) : 1,
          lenM, clip: null, name: en.name || 'Course', sig: 'x:' + st.join('.'),
          custom: true, idx};
}
function buildCustomCourses(){
  const fp = graphFp(graph);
  customStale = 0;
  const out = [];
  customEntries().forEach((en, i) => {
    const st = (en && en.states) || [];
    if(en && en.fp === fp && chainOk(st)) out.push(customCourse(en, st, i));
    else customStale++;
  });
  out.forEach((c, i) => { c.id = i; });
  return out;
}
/* The one place that decides what the course list IS. Every caller that changes the map,
   the scale or the mode goes through here, so there is no path by which the list and the
   mode can disagree. */
function rebuildCourses(){
  if(!graph){ courses = []; coverInfo = null; return; }
  if(settings.mode === 'custom'){
    courses = buildCustomCourses();
    coverInfo = {custom: true, totalM: graphTotalM, stale: customStale, coverage: 0};
  }else{
    const made = buildCourses(graph, dem ? (x, z) => dem.heightAt(x, z) : null, {scale: settings.scale});
    courses = made.courses; coverInfo = made;
  }
}

/* Cached per course AND per (scale, direction): those are three different racetracks that
   happen to share a route. Reversal is derived from the forward track rather than built
   from scratch, so the two directions are guaranteed the same line. */
function trackFor(course, opt){
  const sc = (opt && opt.scale) || settings.scale;
  const rev = opt && 'reverse' in opt ? opt.reverse : settings.reverse;
  const key = course.sig + '|s' + sc + (rev ? '|rev' : '');
  let T = trackCache.get(key);
  if(!T){
    const fwdKey = course.sig + '|s' + sc;
    let F = trackCache.get(fwdKey);
    if(!F){
      F = buildTrack(graph, course, dem, sc);
      rotateTrack(F, calmestStart(F, 70/Math.sqrt(sc)));
      trackCache.set(fwdKey, F);
    }
    T = rev ? reverseTrack(F) : F;
    trackCache.set(key, T);
  }
  return T;
}
const baseM = () => dem ? dem.minM/settings.scale : 0;
function rebuildEnvironment(){
  if(!graph) return;
  const sc = settings.scale;
  buildEnvironment(dem, graph, mapAreas, {x0: mapBox.x0/sc, x1: mapBox.x1/sc, z0: mapBox.z0/sc, z1: mapBox.z1/sc}, sc);
}
function syncMapLine(){
  if(!coverInfo) return;
  /* Custom has nothing to say about coverage -- it is your list, however long it is --
     but it does have to own up to anything set aside as no longer fitting the map. */
  $('mapLine').textContent = mapLabel + ' · '
    + (coverInfo.custom
        ? (courses.length ? courses.length + (courses.length === 1 ? ' course you built' : ' courses you built')
                          : 'no courses yet — tap New course')
          + (coverInfo.stale ? ' · ' + coverInfo.stale + ' set aside: drawn on older trail data' : '')
        : courses.length + ' courses covering ' + Math.round(coverInfo.coverage*100)
          + '% of ' + fmtMi(coverInfo.totalM) + ' of trail')
    + (settings.scale > 1 ? ' · scaled 1:' + settings.scale : '')
    + (dem ? '' : ' · no elevation data: flat');
}

/* ---------- menu ---------- */
const metaKey = c => c.sig + '|s' + settings.scale;
/* THE MENU SCAN. A course's real length, climb and even whether it can be raced at all
   are only known once its ribbon has been built, and building every ribbon on a big map
   at 1:4 is seconds of work -- far too long to hold the menu for. So the list goes up
   immediately with lengths estimated from the route, and one course per frame is built in
   the background; each row corrects itself as its turn comes, and anything that turns out
   unraceable at this scale is struck out. Clicking a row jumps its build to the front,
   so the course you actually chose is never the one you are waiting for. */
function scanStep(){
  while(scanQueue.length){
    const i = scanQueue.shift();
    const c = courses[i];
    if(!c || trackMeta.has(metaKey(c))) continue;
    const T = trackFor(c, {reverse: false});
    trackMeta.set(metaKey(c), {L: T.L, climb: T.climb, ok: T.ok});
    paintRow(i);
    return;
  }
}
function startScan(){
  scanQueue = courses.map((_, i) => i);
}
function paintRow(i){
  const el = document.querySelectorAll('#courseList .course')[i];
  const c = courses[i];
  if(!el || !c) return;
  const m = trackMeta.get(metaKey(c));
  const meta = el.querySelector('.meta'), best = el.querySelector('.best');
  el.classList.toggle('off', !!m && !m.ok);
  if(m && !m.ok){
    meta.textContent = 'too tight to race at 1:' + settings.scale;
  }else{
    meta.textContent = fmtMi(m ? m.L : c.lenM/settings.scale)
      + (c.laps > 1 ? ' × ' + c.laps + ' laps' : '')
      + (c.kind === 'circuit' ? ' · circuit' : ' · sprint')
      + (m && dem ? ' · ↗ ' + fmtFt(m.climb) : '');
  }
  const b = bests[bestKey(c, settings)];
  best.textContent = b ? '★ ' + fmtTime(b) : '';
}
function renderCourseList(){
  const box = $('courseList');
  box.textContent = '';
  courses.forEach((c, i) => {
    const b = document.createElement('button');
    b.className = 'btn course' + (i === selCourse ? ' on' : '');
    b.setAttribute('role', 'option');
    b.dataset.course = String(i);
    const nm = document.createElement('span'); nm.className = 'nm';
    const tag = document.createElement('span'); tag.className = 'tag';
    tag.textContent = c.kind === 'circuit' ? '◯' : '→';
    nm.append(tag, c.name);
    const meta = document.createElement('span'); meta.className = 'meta';
    const bt = document.createElement('span'); bt.className = 'best';
    b.append(nm, meta, bt);
    b.addEventListener('click', () => selectCourse(i));
    box.appendChild(b);
    paintRow(i);
  });
}
function selectCourse(i){
  if(!courses.length) return;
  selCourse = i;
  /* Remembered BY SIGNATURE, not by index: the course list is regenerated whenever the
     scale changes, and an index would quietly point at a different race. Coming back to
     the game on the course you were last racing is the difference between seeing your
     best time and seeing an empty board. */
  if(courses[i] && settings.course !== courses[i].sig){ settings.course = courses[i].sig; neonWriteStore(); }
  document.querySelectorAll('#courseList .course').forEach((el, k) => el.classList.toggle('on', k === i));
  const c = courses[i], T = trackFor(c);
  if(!trackMeta.has(metaKey(c))){
    trackMeta.set(metaKey(c), {L: T.L, climb: T.climb, ok: T.ok});
    paintRow(i);
  }
  $('startBtn').disabled = !T.ok;
  showTrack(T);
  menuS = 0;
  $('courseInfo').textContent = !T.ok ? 'Too tight to race at 1:' + settings.scale + ' — try a bigger scale.' : fmtMi(T.L) + (T.laps > 1 ? ' × ' + T.laps + ' laps' : '')
    + (dem ? ' · ↗ ' + fmtFt(T.climb) + ' climb' + (T.closed ? '' : ' · ' + (T.elev[T.n-1] < T.elev[0] ? '▼ ' : '▲ ')
        + fmtFt(Math.abs(T.elev[T.n-1]-T.elev[0])) + ' net') : '')
    + ' · ' + (T.twistPerKm > 9 ? 'twisty' : T.twistPerKm > 5 ? 'flowing' : 'fast')
    + (settings.reverse ? ' · reverse' : '');
  const line = assembleLine(graph, c).pts;
  if(settings.reverse) line.reverse();
  // zoomToCourse: true -- the start-screen preview used to fit the WHOLE map, which made
  // a 2 km circuit a few pixels of cyan on a huge network of grey trails. It frames the
  // selected course instead, the same way the in-race minimap already does.
  paintMap($('preview'), graph, mapBox, line, T.closed, 'pv|' + mapId + '|' + c.sig + (settings.reverse ? '|r' : ''), true);
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
const riderWho = id => (riderChoices().find(c => c.v === id) || {}).who;
/* A ghost is a recording, so it is drawn as one: the same rider, cooled to a pale trace of
   itself in its own colour.

   TWO THINGS HERE ARE LOAD-BEARING. The single-material case must stay a single material:
   an earlier version wrapped every mesh's material in an array and then failed to unwrap
   it (the Array.isArray check it used was testing the array it had just built), and a mesh
   with an array material but no geometry groups draws NOTHING -- which is why the ghosts
   were invisible except for the marker sprite hanging over the track, the "tiny orb" they
   were reported as. And the opacity has to stay well up: at 0.3 a toon-shaded pup on a
   dark deck is a smudge. 0.82, tinted towards the ghost's colour, reads clearly as a
   rider you can chase without being mistaken for a solid one. */
function fadeRider(R, color){
  const tint = new THREE.Color(color);
  R.root.traverse(o => {
    if(!o.material || o.isSprite) return;
    const one = !Array.isArray(o.material);
    const mats = (one ? [o.material] : o.material).map(m => {
      const c = m.clone ? m.clone() : m;
      // the rocket flame and its glow are animated from zero; fading them means nothing
      if(m.opacity != null && m.opacity < 0.05) return c;
      c.transparent = true;
      c.opacity = (m.opacity == null ? 1 : m.opacity)*0.82;
      /* DEPTH WRITE STAYS ON. A rider is dozens of separate meshes -- legs, body, board
         deck, kicks, hover pads -- and Three.js sorts transparent objects only by their
         centroid distance to the camera, not per pixel. With depthWrite off, that sort is
         unstable across a model with this many overlapping parts: a leg drawn before the
         belly it sits in front of gets painted over by it, and the parts near the board
         end up reading faint while the parts near the head don't. At 0.82 opacity a ghost
         is mostly-opaque anyway, so writing depth lets each part occlude the ghost's OWN
         farther parts correctly -- which is what actually fixed the top-bright,
         bottom-faint look -- at the minor cost of a ghost no longer softly blending with
         something directly behind it (it sits over open track, so that never shows). */
      c.depthWrite = true;
      if(c.color) c.color.lerp(tint, 0.4);
      if(c.emissive) c.emissive.lerp(tint, 0.4);
      return c;
    });
    o.material = one ? mats[0] : mats;
  });
  if(R.tag) R.tag.material.opacity = 0.7;
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
  document.querySelectorAll('#dirSeg .btn').forEach(b => b.classList.toggle('on', (b.dataset.dir === 'rev') === settings.reverse));
  document.querySelectorAll('#classSeg .btn').forEach(b => b.classList.toggle('on', b.dataset.cls === settings.cls));
  document.querySelectorAll('#modeSeg .btn').forEach(b => b.classList.toggle('on', b.dataset.mode === settings.mode));
  const custom = settings.mode === 'custom';
  $('customBar').hidden = !custom;
  $('editCourse').disabled = !(custom && courses[selCourse] && courses[selCourse].custom);
  $('modeNote').textContent = custom
    ? 'Custom: courses you built yourself on this map.'
    : 'Auto: the map cut into races of a good length, covering everything.';
  document.querySelectorAll('#camSeg .btn').forEach(b => b.classList.toggle('on', b.dataset.cam === settings.cam));
  $('scaleSel').value = String(settings.scale);
  document.querySelectorAll('#ghostSeg .btn').forEach(b => b.classList.toggle('on', (b.dataset.ghost === '1') === settings.ghosts));
  $('ghostNote').textContent = settings.ghosts
    ? 'The fastest ghost of every rider who has raced this course lines up with the field.'
    : '';
}

/* CONTROL LAYOUT. Where the steer pad and the brake/burn buttons sit is a CSS custom
   property, not a class or an inline style per element -- one variable moves both
   clusters together (ctlInset, the margin from each side edge) and one moves the whole
   bar up off the bottom edge (ctlBottom), so a single stepper click repaints instantly
   with no per-element math. Read on boot, written on every change, and there is nothing
   else in this file that touches #touchCtl's position. */
/* CTL_INSET_MIN is not 0, on purpose. A drag that starts within a platform's reserved
   edge zone can trigger the browser or OS's own "swipe to go back" gesture -- iOS Safari's
   edge-swipe and Android's gesture-nav back zone both live in roughly the outer 20-24 px
   of the screen, and neither respects a page's `overscroll-behavior` (that CSS property
   only reaches Chrome/Edge's OWN overscroll-navigation, a different mechanism). The one
   thing that reliably avoids all of them is not putting a drag surface there: the steer
   pad is exactly that kind of surface, so its minimum distance from either edge is floored
   here regardless of how far a player drags the In/Out stepper. */
const CTL_INSET_MIN = 24, CTL_INSET_MAX = 110, CTL_INSET_STEP = 10;
const CTL_BOTTOM_MIN = 0, CTL_BOTTOM_MAX = 220, CTL_BOTTOM_STEP = 12;
function applyControlLayout(){
  const root = document.documentElement.style;
  root.setProperty('--ctl-inset', settings.ctlInset + 'px');
  root.setProperty('--ctl-bottom', settings.ctlBottom + 'px');
}
function setCtlInset(v){
  settings.ctlInset = clamp(Math.round(v/CTL_INSET_STEP)*CTL_INSET_STEP, CTL_INSET_MIN, CTL_INSET_MAX);
  applyControlLayout(); neonWriteStore(); syncPauseCard();
}
function setCtlBottom(v){
  settings.ctlBottom = clamp(Math.round(v/CTL_BOTTOM_STEP)*CTL_BOTTOM_STEP, CTL_BOTTOM_MIN, CTL_BOTTOM_MAX);
  applyControlLayout(); neonWriteStore(); syncPauseCard();
}
/* A direct assignment, not setCtlInset(16)/setCtlBottom(16): those round to the nearest
   step (10px / 12px), and 16 is not a multiple of either -- routing the default through
   the steppers would silently snap it to 20/12 the moment someone hit Reset. */
function resetControlLayout(){
  settings.ctlInset = 24; settings.ctlBottom = 16;
  applyControlLayout(); neonWriteStore(); syncPauseCard();
}
function syncPauseCard(){
  $('ctlInVal').textContent = settings.ctlInset + 'px';
  $('ctlUpVal').textContent = settings.ctlBottom + 'px';
  $('ctlInDn').disabled = settings.ctlInset <= CTL_INSET_MIN;
  $('ctlInUp').disabled = settings.ctlInset >= CTL_INSET_MAX;
  $('ctlUpDn').disabled = settings.ctlBottom <= CTL_BOTTOM_MIN;
  $('ctlUpUp').disabled = settings.ctlBottom >= CTL_BOTTOM_MAX;
}
/* STEER MODE: the drag pad or the two buttons -- a body class picks which one #touchCtl
   shows (see the CSS), so switching repaints instantly with nothing here to rebuild. Two
   copies of the seg exist (menu and pause, like the grid sliders), kept in step by class
   rather than id. Unlike gravity/direction/scale this is just which control is on screen,
   not what the course is, so -- also unlike them -- it is free to change mid-race. */
function applySteerMode(){
  document.body.classList.toggle('steer-buttons', settings.steerMode === 'buttons');
  document.querySelectorAll('.steerSeg .btn').forEach(b => b.classList.toggle('on', b.dataset.steer === settings.steerMode));
}
function setSteerMode(mode){
  if((mode !== 'pad' && mode !== 'buttons') || settings.steerMode === mode) return;
  settings.steerMode = mode;
  resetSteerTouch();               // a drag or a button held at the moment of the switch can't stick
  applySteerMode(); neonWriteStore();
}
/* Gravity, direction and scale are set BEFORE the lights go out and hold for the whole
   race. They change what the course is, not how you are driving it, so mid-race they
   would just invalidate the run against everyone else's -- which is why the old in-race
   toggle is gone and the HUD only reports what was chosen. */
function setGravity(on){
  if(settings.gravity === !!on) return;
  settings.gravity = !!on;
  syncMenu(); neonWriteStore(); renderCourseList();
}
function setReverse(on){
  if(settings.reverse === !!on) return;
  settings.reverse = !!on;
  syncMenu(); neonWriteStore(); renderCourseList(); selectCourse(selCourse);
}
function setScale(n){
  const sc = clamp(Math.round(n), 1, 6);
  if(settings.scale === sc) return;
  settings.scale = sc;
  /* Every track in the cache is in the old scene metres, and so is the scenery. */
  trackCache.clear(); trackMeta.clear(); activeTrack = null;
  syncMenu(); neonWriteStore();
  /* The course set itself depends on the scale: a good race is a few minutes long
     whatever the map is doing, so at 1:4 the generator looks for routes four times as
     long in real metres (see routeTargetM). */
  rebuildCourses();
  const kept = courses.findIndex(c => c.sig === settings.course);
  if(kept >= 0) selCourse = kept;
  selCourse = clamp(selCourse, 0, Math.max(0, courses.length-1));
  syncMapLine(); rebuildEnvironment(); renderCourseList(); startScan(); selectCourse(selCourse);
}
/* THE COURSE MODE. Not a race setting -- it decides what the list of courses IS, so it
   does the work a scale change does minus the geometry: rebuild the list, keep the track
   caches (a track is keyed by signature, and a signature means the same racetrack whoever
   proposed it), and hold onto the selected course if the new mode happens to offer it.
   Deliberately NOT part of bestKey, for the same reason. */
function setCourseMode(name){
  if((name !== 'auto' && name !== 'custom') || settings.mode === name) return;
  settings.mode = name;
  rebuildCourses();
  const kept = courses.findIndex(c => c.sig === settings.course);
  selCourse = clamp(kept >= 0 ? kept : 0, 0, Math.max(0, courses.length-1));
  syncMenu(); neonWriteStore(); syncMapLine(); renderCourseList(); startScan();
  if(courses.length) selectCourse(selCourse);
  else { $('startBtn').disabled = true; clearTrackMesh(); activeTrack = null; }
}

/* ---------- build screen ----------
   Open it, tap the map, save. main.js owns the screen, the store and the naming; the
   builder module owns the map, the picking and the undo stack, and nothing crosses. */
function openBuild(idx){
  if(!graph) return;
  buildIdx = idx == null ? -1 : idx;
  const en = buildIdx >= 0 ? customEntries()[buildIdx] : null;
  builderOpen(graph, mapBox, $('buildMap'), en ? en.states : []);
  $('buildName').value = en ? (en.name || '') : '';
  $('buildTitle').textContent = en ? 'Edit course' : 'New course';
  $('buildDelete').hidden = !en;
  setScreen('build');
  syncBuild();
}
function closeBuild(){
  builderClose();
  buildIdx = -1;
  setScreen('menu');
}
function syncBuild(){
  const n = builderStates().length;
  const lenM = builderLenM();
  const enough = n > 0 && lenM >= BUILD_MIN_M*settings.scale;
  $('buildUndo').disabled = !builderCanUndo();
  $('buildRedo').disabled = !builderCanRedo();
  $('buildClear').disabled = !n;
  $('buildSave').disabled = !enough;
  const note = builderNote();
  $('buildInfo').textContent = note ? note
    : !n ? 'Tap a trail to start. Tap further along and the way there is filled in for you.'
    : fmtMi(lenM/settings.scale) + ' · ' + n + (n === 1 ? ' stretch' : ' stretches')
      + (builderClosed() ? ' · closes a loop' : '')
      + (enough ? '' : ' · too short to race yet');
  builderDraw();
}
/* Named after the trail it spends most of its length on, which is what you would call it
   yourself, with a number if you have built that one before. */
function buildDefaultName(st){
  const by = new Map();
  for(const s of st){
    const e = graph.edges[s>>1];
    const k = e.name || 'Trail';
    by.set(k, (by.get(k) || 0) + e.lenM);
  }
  const top = [...by.entries()].sort((p, q) => q[1]-p[1] || (p[0] < q[0] ? -1 : 1));
  const base = top.length ? top[0][0] : 'Course';
  const taken = new Set(customEntries().map((en, i) => i === buildIdx ? '' : (en.name || '')));
  let name = base, k = 2;
  while(taken.has(name)) name = base + ' ' + (k++);
  return name;
}
function saveBuild(){
  const st = builderStates();
  if(!st.length || builderLenM() < BUILD_MIN_M*settings.scale) return false;
  const name = ($('buildName').value || '').trim() || buildDefaultName(st);
  const list = customEntries().slice();
  const en = {name, states: st, fp: graphFp(graph)};
  if(buildIdx >= 0) list[buildIdx] = en; else list.push(en);
  customStore[mapId] = list;
  /* Select what you just built. By signature, like every other selection here, so it
     survives the rebuild that is about to replace every course object in the list. */
  settings.course = 'x:' + st.join('.');
  neonWriteStore();
  closeBuild();
  setCourseListTo('custom');
  return true;
}
function deleteBuild(){
  if(buildIdx < 0) return false;
  const list = customEntries().slice();
  list.splice(buildIdx, 1);
  customStore[mapId] = list;
  neonWriteStore();
  closeBuild();
  setCourseListTo('custom');
  return true;
}
/* Saving or deleting always lands you in Custom mode looking at the result, whichever
   mode the menu was in when you opened the builder. */
function setCourseListTo(name){
  if(settings.mode !== name){ setCourseMode(name); return; }
  rebuildCourses();
  const kept = courses.findIndex(c => c.sig === settings.course);
  selCourse = clamp(kept >= 0 ? kept : 0, 0, Math.max(0, courses.length-1));
  syncMenu(); syncMapLine(); renderCourseList(); startScan();
  if(courses.length) selectCourse(selCourse);
  else { $('startBtn').disabled = true; clearTrackMesh(); activeTrack = null; }
}
/* A tap picks a segment; a drag pans the map. Distinguished by distance, not by which
   button or how long: a thumb never lands perfectly still, and on a tablet every pick
   would otherwise be a one-pixel pan. */
function bindBuildMap(){
  const cv = $('buildMap');
  if(!cv) return;
  let P = null;
  cv.addEventListener('pointerdown', e => {
    P = {id: e.pointerId, x: e.clientX, y: e.clientY, moved: 0};
    if(cv.setPointerCapture) try{ cv.setPointerCapture(e.pointerId); }catch(err){ /* jsdom */ }
  });
  cv.addEventListener('pointermove', e => {
    if(!P || e.pointerId !== P.id) return;
    const dx = e.clientX - P.x, dy = e.clientY - P.y;
    P.x = e.clientX; P.y = e.clientY; P.moved += Math.hypot(dx, dy);
    if(P.moved > 6){ builderPan(dx, dy); builderDraw(); }
  });
  const end = e => {
    if(!P || e.pointerId !== P.id) return;
    if(P.moved <= 6){
      const r = cv.getBoundingClientRect ? cv.getBoundingClientRect() : {left: 0, top: 0};
      builderAdd(builderPickAt(e.clientX - r.left, e.clientY - r.top));
      syncBuild();
    }
    P = null;
  };
  cv.addEventListener('pointerup', end);
  cv.addEventListener('pointercancel', e => { P = null; });
  $('zoomIn').addEventListener('click', () => { builderZoom(1.6); builderDraw(); });
  $('zoomOut').addEventListener('click', () => { builderZoom(1/1.6); builderDraw(); });
  $('zoomFit').addEventListener('click', () => { builderFit(); builderDraw(); });
  $('buildUndo').addEventListener('click', () => { builderUndo(); syncBuild(); });
  $('buildRedo').addEventListener('click', () => { builderRedo(); syncBuild(); });
  $('buildClear').addEventListener('click', () => { builderClear(); syncBuild(); });
  $('buildSave').addEventListener('click', saveBuild);
  $('buildDelete').addEventListener('click', deleteBuild);
  $('buildCancel').addEventListener('click', closeBuild);
  $('newCourse').addEventListener('click', () => openBuild(-1));
  $('editCourse').addEventListener('click', () => {
    const c = courses[selCourse];
    if(c && c.custom) openBuild(c.idx);
  });
}

function setClass(name){
  if(!NEON_CLASS[name] || settings.cls === name) return;
  settings.cls = name;
  syncMenu(); neonWriteStore(); renderCourseList();
}
function setGhosts(on){
  if(settings.ghosts === !!on) return;
  settings.ghosts = !!on;
  syncMenu(); neonWriteStore();
}
function setCam(name){
  if(!NEON_CAM[name] || settings.cam === name) return;
  settings.cam = name;
  syncMenu(); neonWriteStore();
}
function cycleCam(){
  const order = ['close', 'normal', 'far'];
  setCam(order[(order.indexOf(settings.cam) + 1) % order.length]);
}
function modeChip(){
  const bits = [NEON_CLASS[settings.cls].label.toUpperCase()];
  if(settings.mode === 'custom') bits.push('CUSTOM');
  if(settings.scale > 1) bits.push('1:' + settings.scale);
  if(settings.reverse) bits.push('REVERSE');
  bits.push(settings.gravity ? 'GRAVITY' : 'NO GRAVITY');
  return bits.join(' · ');
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
  clearCells();
  clearSmoke();
  race = null;
  stopHum();
}
function startRace(){
  if(!courses.length || !trackFor(courses[selCourse]).ok) return;
  initAudio();
  endRace();
  const course = courses[selCourse], T = trackFor(course);
  showTrack(T);
  const choice = riderChoices().find(c => c.v === settings.rider) || riderChoices()[0];
  const cast = pickRivals(settings.rivals, course, choice.who);
  const speedK = NEON_CLASS[settings.cls].top;
  // riders shrink with the ribbon, so a six-board pack fills the same share of it at 1:6
  const sizeK = 1/widthFactor(settings.scale);
  const racers = [], riders = [];
  const total = cast.length + 1;
  // grid: two columns, rows 7 m apart. Rivals fill from the front; you start at the back.
  const place = (k, o) => {
    /* circuits line up BEHIND the line: row 0 is nearest it */
    const row = Math.floor(k/2), col = k % 2 ? -1 : 1;
    const gap = 7/Math.sqrt(settings.scale);          // rows closer together on a small map
    const s = T.closed ? T.L - 5 - row*gap : 5 + (Math.ceil(total/2) - 1 - row)*gap;
    const f = trackFrame(T, s, {});
    return makeRacer(Object.assign({s, d: col*(f.halfW - T.bodyWide)*0.5, yaw: f.yaw,
      lap: T.closed ? -1 : 0}, o));
  };
  cast.forEach((c, i) => {
    racers.push(place(i, {name: c.name, skill: NEON_SKILL[settings.skill], paceMul: c.paceMul, speedK,
      lane: ((i % 4) - 1.5)/2.2, seed: c.seed % 1000, color: c.color, emo: SPECIES[c.key].emo,
      riderId: 'w:' + c.key}));
    riders.push(makeRider({kind: 'wild', key: c.key}, c.color, c.seed, sizeK));
  });
  racers.push(place(cast.length, {name: choice.label, isPlayer: true, color: PLAYER_COLOR, speedK, riderId: choice.v}));
  riders.push(makeRider(choice.who, PLAYER_COLOR, 7, sizeK));
  riders[riders.length-1].tag.visible = false;
  for(const r of racers) if(!r.isGhost) r.prog = (r.lap|0)*T.L + r.s;
  /* GHOSTS RIDE AT FIERCE. They are the point of the setting: every rider who has set a
     time on exactly this course, in this class, this way round, at this scale, with this
     gravity, lines up as the run that set it. They are SOLID to everyone but their own
     rider (see racer.js resolveContacts): a shove costs them time, so blocking one is
     fair play. They are ranked with everyone else -- beating a ghost is beating the time. */
  const ghosts = settings.ghosts ? bestGhosts(ghostStore, bestKey(course, settings)) : [];
  ghosts.forEach((g, i) => {
    const gr = makeGhostRacer(g, T, GHOST_COLORS[i % GHOST_COLORS.length]);
    racers.push(gr);
    const R = makeRider(riderWho(g.rider) || choice.who, gr.color, 40 + i, sizeK);
    R.isGhost = true;
    fadeRider(R, gr.color);
    riders.push(R);
  });
  const line = assembleLine(graph, course).pts;
  if(settings.reverse) line.reverse();
  const cells = placeCells(T);
  buildCellMeshes(T, cells, baseM(), 0xffe14a);
  race = {T, course, racers, riders, me: cast.length, phase: 'count', countT: 3.4, lastPip: 4,
          t: 0, finishShown: false, doneCount: 0, line, cells, rec: makeRecorder(),
          riderId: choice.v, riderLabel: choice.label, ghosts: ghosts.length,
          gravity: settings.gravity, scale: settings.scale, reverse: settings.reverse,
          cls: settings.cls, sizeK};
  rankRacers(racers);
  resetNeonInput();
  camYaw = racers[race.me].yaw;
  physAcc = 0;
  $('placeOf').textContent = '/' + racers.length;
  const best = bests[bestKey(course, settings)];
  $('hudBest').textContent = 'BEST ' + fmtTime(best);
  $('hudMode').textContent = modeChip();
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

/* PAUSE is a hold on an in-progress race, not a mode of its own -- 'race' keeps existing
   with its own `paused` flag, and the screen just borrows the 'pause' state to show the
   overlay over a HUD that never disappears. Guarded to the 'go' phase and not-yet-finished
   so a countdown or a just-crossed finish line can't be caught mid-transition. */
function pauseRace(){
  if(!race || race.phase !== 'go' || race.paused || race.racers[race.me].done) return;
  race.paused = true;
  setScreen('pause');
  stopHum();
  syncPauseCard();
}
function resumeRace(){
  if(!race || !race.paused) return;
  race.paused = false;
  setScreen('race');
  startHum();
}
function togglePause(){
  if(race && race.paused) resumeRace(); else pauseRace();
}

function stepRace(dt){
  const R = race, T = R.T, env = {gravity: R.gravity};
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
  env.cells = R.cells;
  for(const r of R.racers){
    if(r.isGhost){ r.lastDt = dt; stepGhost(r, T, dt); continue; }
    const inp = r.isPlayer ? input : rivalInput(r, T, R.racers, env, R.t);
    // rubber band, gently: nobody should be a dot on the horizon either way
    if(!r.isPlayer && !r.done){
      const gap = me.prog - r.prog;
      /* Only a long way clear does a rival ease off, and only a little: the band is here
         so a runaway leader stays on screen, not to hand the race back. */
      r.paceBand = clamp(gap/700, -0.03, 0.08);
      if(inp.throttle && r.paceBand < 0 && r.v > 8) inp.throttle = 1 + r.paceBand*2;
      if(r.paceBand > 0.02) inp.boost = inp.boost || (gap > 60 && r.fuel >= 1);
    }
    const ev = stepRacer(r, T, inp, env, dt);
    if(ev) onBump(r, ev);
    if(r.burnFired && r === me) burnSound();
  }
  resolveContacts(R.racers, T);
  for(const t of stepCells(R.cells, R.racers, T, dt)) if(t.racer === me) cellSound();
  if(!me.done) recordFrame(R.rec, me, dt);
}
function onBump(r, ev){
  const T = race.T, me = race.racers[race.me];
  let gap = Math.abs(r.s - me.s); if(T.closed) gap = Math.min(gap, T.L - gap);
  if(!r.isPlayer && gap > 160) return;
  const f = trackToWorld(T, r.s, ev.bump*(trackFrame(T, r.s, {}).halfW), {});
  bumperPulse(f.wx, deckY(T, f.elev, baseM()), f.wz, f.yaw, ev.bump, ev.hard);
  if(r.isPlayer){
    bonkSound(0.8 + ev.hard*0.6 + (ev.streak >= 2 ? 0.3 : 0));
    shake = Math.max(shake, ev.spin ? 1.1 : 0.25 + 0.5*ev.hard + (ev.streak >= 2 ? 0.25 : 0));
    if(ev.spin) thudSound();
  }
}

function finishPlayer(){
  const R = race, me = R.racers[R.me], key = bestKey(R.course, R);
  const old = bests[key];
  let note = '';
  const ghost = finishRecording(R.rec, me, {id: R.riderId, label: R.riderLabel});
  const keptGhost = keepGhost(ghostStore, key, ghost);
  if(!old || me.finishT < old){ bests[key] = +me.finishT.toFixed(2); note = old ? '★ New best! (was ' + fmtTime(old) + ')' : '★ First time on the board.'; }
  else note = 'Best ' + fmtTime(old) + ' · +' + (me.finishT - old).toFixed(1) + ' s';
  if(keptGhost) note += ' · ghost saved';
  neonWriteStore();
  $('finTitle').textContent = me.place === 1 ? '🏁 YOU WIN' : '🏁 P' + me.place + ' OF ' + R.racers.length;
  $('finTime').textContent = fmtTime(me.finishT);
  $('finNote').textContent = note + ' · ' + modeChip().toLowerCase();
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
    a.append(dot, r.place + '. ' + (r.emo ? r.emo + ' ' : '') + r.name + (r.isGhost ? ' 👻' : ''));
    const b = document.createElement('span');
    b.textContent = r.done ? fmtTime(r.finishT) : '…';
    li.append(a, b);
    ol.appendChild(li);
  }
}

/* THE NITRO RACK. One icon per tank on board, spent ones left as empty outlines so the
   rack reads as "two of five used" at a glance rather than a bar that could be anything.
   Rebuilt only when the count changes -- this runs every frame. */
function paintFuel(me){
  const box = $('fuelRack');
  const lit = me.fuel, max = NEON.fuelMax;
  if(box.childElementCount !== max){
    box.textContent = '';
    for(let i = 0; i < max; i++){
      const el = document.createElement('i');
      el.className = 'tank';
      box.appendChild(el);
    }
    box.dataset.lit = '';
  }
  const key = lit + (me.burnT > 0 ? 'b' : '');
  if(box.dataset.lit === key) return;
  box.dataset.lit = key;
  [...box.children].forEach((el, i) => {
    el.classList.toggle('on', i < lit);
    el.classList.toggle('firing', me.burnT > 0 && i === lit);
  });
}

/* ---------- camera ---------- */
const _cf = {}, _cb = {};
function chaseTarget(){
  const R = race, T = R.T, me = R.racers[R.me];
  const f = trackToWorld(T, me.s, me.d, _cf);
  const y = deckY(T, f.elev, baseM());
  /* The part of the chase distance that frames the BOARD scales with the board; the part
     that buys you a view of the corner ahead is about speed, and speed does not scale. */
  const K = R.sizeK || 1;
  const cam = NEON_CAM[settings.cam] || NEON_CAM.normal;
  const dist = (7.5*K + me.v*0.13)*cam.dist, high = (3.1*K + me.v*0.035)*cam.high;
  const x = f.wx - Math.cos(camYaw)*dist, z = f.wz + Math.sin(camYaw)*dist;
  // never let a crest come between the lens and the board
  const behind = trackFrame(T, T.closed ? me.s - dist : Math.max(0, me.s - dist), _cb);
  const floorY = deckY(T, behind.elev, baseM()) + 1.6*K;
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
    camera.lookAt(c.px + Math.cos(camYaw)*9, c.py + 1.3*(race.sizeK || 1), c.pz - Math.sin(camYaw)*9);
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
  const f = trackFrame(T, me.s, _pf);
  $('placeVal').textContent = String(me.place);
  $('lapVal').textContent = T.closed ? Math.min(T.laps, Math.max(1, me.lap+1)) + '/' + T.laps
                                     : Math.round(100*clamp(me.s/T.L, 0, 1)) + '%';
  $('hudClock').textContent = fmtTime(me.done ? me.finishT : me.time);
  $('speedVal').textContent = String(Math.round(mph(me.v)));
  paintFuel(me);
  const pct = Math.round(me.slope*100);
  $('slopeVal').textContent = !R.gravity ? '' : pct > 1 ? '▲ ' + pct + '%' : pct < -1 ? '▼ ' + (-pct) + '%'
    : (dem ? Math.round(feet(f.elev)) + ' ft' : '');
  setHum(me.v, me.burnT > 0 ? Math.min(1, me.burnT/NEON.burnS + 0.35) : 0);
  $('burnPip').textContent = me.spinT > 0 ? 'SPUN OUT' : me.burnT > 0 ? 'NITRO' : me.fuel ? '' : 'OUT OF NITRO';
  $('burnPip').classList.toggle('hot', me.burnT > 0);
  const fit = paintMap($('minimap'), graph, mapBox, R.line, T.closed, 'mm|' + mapId + '|' + R.course.sig, true);
  const sc = R.scale;
  const dots = R.racers.map(r => { const w = trackToWorld(T, r.s, r.d, {}); return {x: w.wx*sc, z: w.wz*sc, color: hex(r.color), big: r.isPlayer}; });
  for(const c of R.cells){
    if(!c.live) continue;
    const w = trackToWorld(T, c.s, c.d, {});
    dots.push({x: w.wx*sc, z: w.wz*sc, color: '#ffe14a', small: true});
  }
  dots.sort((p, q) => (p.big ? 1 : 0) - (q.big ? 1 : 0));
  paintDots($('minimap'), fit, dots);
}
function frame(ms){
  requestAnimationFrame(frame);
  const now = ms/1000;
  const dt = Math.min(0.05, Math.max(0, now - lastT)); lastT = now;
  clockT += dt;
  if(!race && scanQueue.length) scanStep();
  /* PAUSE freezes the race, not the loop: rAF keeps running (so `lastT` never falls
     behind and a resume can't produce a giant catch-up dt), the camera keeps its gentle
     drift, and the scene's ambient motion (stars, cell pulse) keeps going -- only the
     physics step and the HUD's per-frame numbers stop advancing. That is also why pause
     lives here and nowhere in stepRace itself: everything stepRace touches (input,
     racers, the clock) simply never runs while paused, so there is no separate "is this
     safe to do while paused" question to answer inside it. */
  if(race && !race.paused){
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
  if(race) updateCellMeshes(clockT);
  renderer.render(scene, camera);
}

/* ---------- boot ---------- */
function wireUI(){
  $('startBtn').addEventListener('click', startRace);
  $('againBtn').addEventListener('click', startRace);
  $('menuBtn').addEventListener('click', quitToMenu);
  $('quitBtn').addEventListener('click', quitToMenu);
  $('pauseBtn').addEventListener('click', togglePause);
  $('resumeBtn').addEventListener('click', resumeRace);
  $('pauseQuitBtn').addEventListener('click', quitToMenu);
  $('ctlInDn').addEventListener('click', () => setCtlInset(settings.ctlInset - CTL_INSET_STEP));
  $('ctlInUp').addEventListener('click', () => setCtlInset(settings.ctlInset + CTL_INSET_STEP));
  $('ctlUpDn').addEventListener('click', () => setCtlBottom(settings.ctlBottom - CTL_BOTTOM_STEP));
  $('ctlUpUp').addEventListener('click', () => setCtlBottom(settings.ctlBottom + CTL_BOTTOM_STEP));
  $('ctlResetBtn').addEventListener('click', resetControlLayout);
  $('rivalsDn').addEventListener('click', () => { settings.rivals = clamp(settings.rivals-1, 0, 7); syncMenu(); neonWriteStore(); });
  $('rivalsUp').addEventListener('click', () => { settings.rivals = clamp(settings.rivals+1, 0, 7); syncMenu(); neonWriteStore(); });
  document.querySelectorAll('#skillSeg .btn').forEach(b => b.addEventListener('click', () => { settings.skill = b.dataset.skill; syncMenu(); neonWriteStore(); }));
  document.querySelectorAll('#gravSeg .btn').forEach(b => b.addEventListener('click', () => setGravity(b.dataset.grav === '1')));
  document.querySelectorAll('#classSeg .btn').forEach(b => b.addEventListener('click', () => setClass(b.dataset.cls)));
  document.querySelectorAll('#modeSeg .btn').forEach(b => b.addEventListener('click', () => setCourseMode(b.dataset.mode)));
  bindGridSliders();
  bindBuildMap();
  document.querySelectorAll('#camSeg .btn').forEach(b => b.addEventListener('click', () => setCam(b.dataset.cam)));
  document.querySelectorAll('#ghostSeg .btn').forEach(b => b.addEventListener('click', () => setGhosts(b.dataset.ghost === '1')));
  document.querySelectorAll('#dirSeg .btn').forEach(b => b.addEventListener('click', () => setReverse(b.dataset.dir === 'rev')));
  document.querySelectorAll('.steerSeg .btn').forEach(b => b.addEventListener('click', () => setSteerMode(b.dataset.steer)));
  $('scaleSel').addEventListener('change', e => setScale(+e.target.value));
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
    // only on the menu: a race is run at the settings it started with
    gravity: () => { if(neonScreen === 'menu') setGravity(!settings.gravity); },
    reverse: () => { if(neonScreen === 'menu') setReverse(!settings.reverse); },
    // the one setting that is safe to change mid-race -- but not while you are building,
    // where the camera is not even on screen and C is a letter someone is typing
    camera: () => { if(neonScreen !== 'build') cycleCam(); },
    pause: () => { if(neonScreen !== 'build') togglePause(); },
    restart: () => { if(race && !race.paused && neonScreen !== 'build') startRace(); },
    quit: () => { if(neonScreen === 'build') closeBuild(); else if(neonScreen !== 'menu') quitToMenu(); },
    confirm: () => { if(neonScreen === 'build') saveBuild();
      else if(neonScreen === 'menu' && !$('startBtn').disabled) startRace();
      else if(neonScreen === 'finish') startRace();
      else if(neonScreen === 'pause') resumeRace(); },
  });
}
function showLoadError(err){
  $('mapLine').textContent = '⚠ ' + (err && err.message ? err.message : 'Could not load that map.');
}
/* The three grid sliders exist twice, in the menu and on the pause card -- the pause card
   because "hard to see up close" is a judgement you make on the track, not in the menu's
   fly-over. Both are the same setting; every copy is found by class and kept in step. */
function applyGrid(){
  settings.gridThick = clamp(Math.round(+settings.gridThick || 0), 0, GRID_THICK_MAX);
  settings.gridHue = ((Math.round(+settings.gridHue || 0) % 360) + 360) % 360;
  settings.gridGlow = clamp(Math.round((settings.gridGlow == null ? 100 : +settings.gridGlow || 0)/5)*5, 0, 200);
  setGridStyle(settings.gridThick*GRID_THICK_STEP, settings.gridHue*Math.PI/180, settings.gridGlow/100);
  document.querySelectorAll('.gridThick').forEach(el => { el.value = settings.gridThick; });
  document.querySelectorAll('.gridHue').forEach(el => { el.value = settings.gridHue; });
  document.querySelectorAll('.gridGlow').forEach(el => { el.value = settings.gridGlow; });
}
function bindGridSliders(){
  for(const [cls, key] of [['gridThick', 'gridThick'], ['gridHue', 'gridHue'], ['gridGlow', 'gridGlow']]){
    document.querySelectorAll('.' + cls).forEach(el => {
      el.addEventListener('input', () => { settings[key] = +el.value; applyGrid(); });   // live
      el.addEventListener('change', () => neonWriteStore());                          // on release
    });
  }
}

async function bootNeon(){
  neonReadStore();
  applyControlLayout();
  applyGrid();
  applySteerMode();
  loadKennel();
  wireUI();
  fillRiderSelect();
  syncMenu();
  syncPauseCard();
  await loadMapList();
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
  return {screen: neonScreen, tuning: NEON, graph, areas: mapAreas, mapId, courses, trackMeta, scanLeft: scanQueue.length, ghostStore, coverInfo, selCourse, settings, race, activeTrack, bests, hasDem: !!dem, customStore, customStale, buildIdx};
}
bootNeon();

export { bootNeon, loadNeonMap, loadMapList, startRace, quitToMenu, setGravity, setReverse, setScale, setClass, setCam, setGhosts, cycleCam,
         setCourseMode, openBuild, closeBuild, saveBuild, deleteBuild, syncBuild, neonReadStore, applyGrid,
         pauseRace, resumeRace, togglePause, setCtlInset, setCtlBottom, resetControlLayout, setSteerMode,
         selectCourse, neonState, stepRace, trackFor, modeChip };
