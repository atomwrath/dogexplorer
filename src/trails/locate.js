/* START WHERE I AM: the map sheet's 📍 button, and the card it opens.

   WHY A CARD AND NOT A NOTE. The first version told the walker what happened -- "outside this
   map", "location is blocked", "no fix" -- through flashSpotNote, which is a comic burst drawn in
   the 3D world. The map sheet covers the 3D world, so on a phone every one of those messages was
   drawn behind the very sheet the button is on: the button faded for a few seconds and nothing
   appeared to happen. Anything this feature has to say is said HERE, in a card over the sheet.

   THE FLOW.  Press 📍  ->  the card opens and asks the device ("finding")  ->  the best fix it
   gets is shown, with its accuracy and whether it is on this map  ("fix")  ->  Start here starts
   the walk at the nearest trail point, Edit lets the numbers be typed instead, Cancel puts it
   all away. If the device cannot say where it is
   (blocked, no signal, no GPS) the card says why and goes straight to typing ("none").

   Start here STARTS: it loads the nearest trail point exactly as a tap on the sheet would, then
   calls the function main.js handed to initLocate -- the same one the sheet's own Start here
   button calls -- so the pup is put on that point and the sheet closes, with no second press.
   The blue dot (or, off the map, the arrow on the sheet's edge) is minimap.js's; this module
   only tells it where the walker is, in lon/lat.

   watchPosition for a few seconds rather than getCurrentPosition: the first fix a phone returns
   is often a coarse cell/Wi-Fi guess and the good one arrives a little later. The best seen is
   kept, and it stops early once it is good enough. The wait for the FIRST fix is long, because
   the walker may be reading iOS's permission prompt; once one arrives the rest of the wait is short.

   Every name here starts loc or Loc: build.py flattens the modules into one scope, and `$` is
   main.js's, so the DOM is reached with document.getElementById. */
import { getMapRect, getMapScale, inMapArea, projectLonLat } from './world.js';
import { nearestPathPoint, pickTrailPointNear, setUserFix } from './minimap.js';
import { fmtFarDist, fmtLatLonDec, fmtLatLonDMS, geoCompass8, parseLatLon } from './geo-input.js';

const LOC_GOOD_M = 15;          // accurate enough to stop waiting
const LOC_FIRST_MS = 30000;     // for a first fix, prompt-reading time included
const LOC_MORE_MS = 6000;       // for a better one, once there is a first
const LOC_SNAP_MAX_M = 500;     // Start here will not reach further than this for a trail

let locMode = 'idle';           // 'idle' | 'finding' | 'fix' | 'none' | 'manual'
let locSession = 0;             // bumped by every start and every cancel; stale callbacks compare against it
let locWatchId = null, locTimer = null, locBest = null;
let locFix = null;              // {lat, lon, acc} the card is currently about
let locNote = '';               // why there is no fix, or what Start here could not do
let locWired = false;
let locStart = null;            // main.js's startFromHere: puts the pup on what the sheet has loaded

const locEl = id => document.getElementById(id);
function locStopWatch(){
  if(locWatchId !== null){ try{ navigator.geolocation.clearWatch(locWatchId); }catch(e){} locWatchId = null; }
  if(locTimer){ clearTimeout(locTimer); locTimer = null; }
}

/* Where a lon/lat is, as far as the sheet is concerned: its world point, whether that is on the
   map, and either how far the nearest trail is (on it) or how far and which way the map is (off). */
function locAnalyse(fix){
  const p = projectLonLat(fix.lon, fix.lat);
  if(!p) return null;
  const k = Math.max(1e-6, getMapScale());
  if(inMapArea(p.x, p.z)){
    const h = nearestPathPoint(p.x, p.z, null);
    return { p, inside:true, nearM: h ? h.d/k : Infinity };
  }
  const r = getMapRect();
  const dx = Math.max(r.x0 - p.x, 0, p.x - r.x1), dz = Math.max(r.z0 - p.z, 0, p.z - r.z1);
  return { p, inside:false, offM: Math.hypot(dx, dz)/k, wind: geoCompass8(p.x - (r.x0 + r.x1)/2, p.z - (r.z0 + r.z1)/2) };
}
function locWhere(a){
  if(!a) return 'That place cannot be put on this map.';
  if(a.inside) return a.nearM < 1e6 ? 'On this map. Nearest trail is ' + fmtFarDist(a.nearM) + ' away.' : 'On this map.';
  return 'Off this map: ' + fmtFarDist(a.offM) + ' ' + a.wind + ' of it. The arrow on the edge of the sheet points the way.';
}

function locOpen(){ const c = locEl('locCard'); if(c) c.hidden = false; }
function locClose(clearMarker){
  locSession++; locStopWatch();
  locMode = 'idle'; locNote = '';
  if(clearMarker){ locFix = null; setUserFix(null); }
  const c = locEl('locCard'); if(c) c.hidden = true;
  const i = locEl('locInput'); if(i) i.blur();
}

function locRender(){
  const card = locEl('locCard'); if(!card) return;
  const title = locEl('locTitle'), body = locEl('locBody'), edit = locEl('locEdit'), parsed = locEl('locParsed');
  const go = locEl('locGo'), input = locEl('locInput');
  const lines = [];     // [text, className]
  let t = '📍 Your location', canGo = false, typing = false;
  if(locMode === 'finding'){
    t = '📍 Finding you…';
    lines.push(['Asking this device where it is. If it asks permission, tap Allow.', '']);
    if(locBest) lines.push(['Best so far: within ' + Math.round(locBest.coords.accuracy) + ' m', 'loc-dim']);
  }else if(locMode === 'fix' && locFix){
    t = '📍 Here you are';
    lines.push([fmtLatLonDMS(locFix.lat, locFix.lon), 'loc-main']);
    lines.push([fmtLatLonDec(locFix.lat, locFix.lon), 'loc-main']);
    if(locFix.acc > 0) lines.push(['Accurate to about ' + Math.round(locFix.acc) + ' m' + (locFix.acc > 100 ? ' (rough: check the flag)' : ''), 'loc-dim']);
    const a = locAnalyse(locFix);
    lines.push([locWhere(a), '']);
    canGo = !!(a && a.inside);
  }else if(locMode === 'none'){
    t = '📍 No location received';
    lines.push([locNote, '']);
    lines.push(['You can type where you are instead.', '']);
    typing = true;
  }else if(locMode === 'manual'){
    t = '✏️ Enter a location';
    typing = true;
  }
  if(typing){
    const r = parseLatLon(input ? input.value : '');
    if(r){
      const a = locAnalyse({lat:r.lat, lon:r.lon});
      if(parsed) parsed.textContent = fmtLatLonDec(r.lat, r.lon) + '. ' + locWhere(a);
      canGo = !!(a && a.inside);
    }else if(parsed){
      parsed.textContent = input && input.value.trim()
        ? 'That is not a latitude and longitude yet. Try 38°51′17″ N  104°52′8″ W, or 38.8547, -104.8689.'
        : 'Latitude and longitude, like 38°51′17″ N  104°52′8″ W, or 38.8547, -104.8689.';
    }
  }
  if(locMode === 'fix' || locMode === 'manual' || locMode === 'none'){
    if(locNote && locMode !== 'none') lines.push([locNote, 'loc-warn']);
  }
  if(title) title.textContent = t;
  if(body){
    body.textContent = '';
    for(const [txt, cls] of lines){
      const p = document.createElement('p'); p.className = 'loc-line' + (cls ? ' ' + cls : ''); p.textContent = txt; body.appendChild(p);
    }
  }
  if(edit) edit.hidden = !typing;
  if(go) go.disabled = !canGo;
}
function locNone(why, err){
  locStopWatch();
  locMode = 'none'; locBest = null; locFix = null; setUserFix(null);
  locNote = why + (err ? ' (' + [err.code != null ? 'code ' + err.code : '', err.message || ''].filter(Boolean).join(': ') + ')' : '');
  locOpen(); locRender();
}
function locErrText(err){
  if(err && err.code === 1) return 'Location is blocked for this page. On iPhone: Settings, Privacy & Security, Location Services, Safari Websites, While Using. Then reload.';
  if(err && err.code === 3) return 'Your device took too long to find its location. Try again outdoors.';
  return 'Your device could not work out where it is. Try again outdoors.';
}

function locGotFix(pos){
  locStopWatch();
  const c = pos.coords;
  locFix = { lat:c.latitude, lon:c.longitude, acc:c.accuracy || 0 };
  locMode = 'fix'; locNote = '';
  setUserFix(locFix);
  locOpen(); locRender();
}
function locFinish(){
  if(locMode !== 'finding') return;
  if(locBest) locGotFix(locBest);
  else locNone('No location came back.');
}

function locateMe(){
  const s = ++locSession;
  locStopWatch();
  locBest = null; locFix = null; locNote = ''; setUserFix(null);
  locOpen();
  const inp = locEl('locInput'); if(inp) inp.value = '';
  if(!navigator.geolocation){ locNone('This browser cannot share a location.'); return; }
  if(!window.isSecureContext){ locNone('Location only works on a secure (https) page.'); return; }
  locMode = 'finding'; locRender();
  locTimer = setTimeout(()=>{ if(s === locSession) locFinish(); }, LOC_FIRST_MS);
  let id = null;
  try{
    id = navigator.geolocation.watchPosition(pos=>{
      if(s !== locSession || locMode !== 'finding') return;
      const first = !locBest;
      if(first || pos.coords.accuracy < locBest.coords.accuracy) locBest = pos;
      if(locBest.coords.accuracy <= LOC_GOOD_M){ locFinish(); return; }
      if(first){ clearTimeout(locTimer); locTimer = setTimeout(()=>{ if(s === locSession) locFinish(); }, LOC_MORE_MS); }
      locRender();
    }, err=>{
      if(s !== locSession || locMode !== 'finding') return;
      if(locBest) locFinish(); else locNone(locErrText(err), err);
    }, {enableHighAccuracy:true, timeout:20000, maximumAge:0});
  }catch(e){ locNone('This browser refused the location request.', e); return; }
  /* A browser may call back before watchPosition has returned its id (the harness does): by
     then this attempt is already over, so the id has to be cleared here. */
  if(s === locSession && locMode === 'finding') locWatchId = id;
  else { try{ navigator.geolocation.clearWatch(id); }catch(e){} }
}

/* Edit: stop asking the device and let the numbers be typed, starting from what it said. */
function locEnterManual(){
  locSession++; locStopWatch();
  locMode = 'manual'; locNote = '';
  const inp = locEl('locInput');
  if(inp && locFix && !inp.value) inp.value = fmtLatLonDMS(locFix.lat, locFix.lon);
  locOpen(); locRender();
  if(inp){ try{ inp.focus(); inp.select(); }catch(e){} }
}
function locOnInput(){
  const inp = locEl('locInput');
  const r = parseLatLon(inp ? inp.value : '');
  locNote = '';
  if(r){ locFix = { lat:r.lat, lon:r.lon, acc:0 }; setUserFix(locFix); }
  else { locFix = null; setUserFix(null); }
  locRender();
}

/* Start here: the nearest trail point to the place on the card is loaded the way a tap on the
   sheet loads it, and then the walk is started on it. Refusals are said ON THE CARD, which
   stays up. (Named locGo for the button's id, which the harness presses.) */
function locGo(){
  let fix = locFix;
  if(locMode === 'manual' || locMode === 'none'){
    const inp = locEl('locInput'), r = parseLatLon(inp ? inp.value : '');
    if(!r){ locNote = 'That is not a latitude and longitude yet.'; locRender(); return; }
    fix = locFix = { lat:r.lat, lon:r.lon, acc:0 };
    setUserFix(fix);
  }
  if(!fix) return;
  const a = locAnalyse(fix);
  if(!a){ locNote = 'That place cannot be put on this map.'; locRender(); return; }
  if(!a.inside){ locNote = 'That spot is off this map, so there is nowhere to start.'; locRender(); return; }
  const k = Math.max(1e-6, getMapScale());
  const r = pickTrailPointNear(a.p.x, a.p.z, LOC_SNAP_MAX_M*k);
  if(!r.ok){
    locNote = 'No trail within ' + LOC_SNAP_MAX_M + ' m of that spot (the nearest is ' + fmtFarDist(r.d/k) + ' away).';
    locRender(); return;
  }
  locClose(false);      // the dot stays on the sheet, beside the flag
  if(locStart) locStart();
}
function locCancel(){ locClose(true); }

function initLocate(startFn){
  if(typeof startFn === 'function') locStart = startFn;
  if(locWired) return;
  locWired = true;
  const on = (id, fn) => { const el = locEl(id); if(el) el.addEventListener('click', fn); };
  on('mapLocate', locateMe); on('locGo', locGo); on('locEditBtn', locEnterManual); on('locCancel', locCancel);
  const inp = locEl('locInput');
  if(inp){
    inp.addEventListener('input', locOnInput);
    // the walk's key table is fed by every keydown on the window: a W or an S typed here would
    // otherwise be the pup walking, an E would start auto-walk, and Esc would quit the walk
    inp.addEventListener('keydown', e=>{
      e.stopPropagation();
      if(e.key === 'Enter'){ e.preventDefault(); locGo(); }
      else if(e.key === 'Escape'){ e.preventDefault(); locCancel(); }
    });
    inp.addEventListener('keyup', e=> e.stopPropagation());
  }
}

/* test seam: a top-level let is invisible to the harness once the modules are flattened */
function getLocateState(){ return { mode:locMode, fix:locFix, note:locNote, open: !!(locEl('locCard') && !locEl('locCard').hidden) }; }

export { initLocate, locateMe, locGo, locCancel, locEnterManual, getLocateState };
