/* Minimap. Two views off one drawing: a corner disc while you walk, and a full-screen
   sheet on M / the 🗺 button.

   ARCHITECTURE, and why it isn't just "draw the graph each frame". A real trail network
   is thousands of polyline points plus area rings plus a DEM-wide relief image; redrawing
   that at 60 fps to fill a 190 px disc is absurd. So everything static -- relief, areas,
   trails, POIs, trailhead pins -- is rendered ONCE into an offscreen atlas at a fixed
   world-to-pixel scale, and each frame blits the sub-rectangle it needs and draws only
   the handful of things that actually move. Rebuilt when world.js's revision counter
   changes, which is the one signal that means "this is a different world now" -- so
   world.js doesn't have to know this module exists.

   NORTH-UP, not heading-up. A rotating minimap is easier to steer by and much harder to
   learn a place from, and this game is about a real place you might actually walk. The
   pup's arrow rotates instead, and the big sheet reads like the paper map at the
   trailhead kiosk -- which is also why the styling is ink-on-parchment rather than the
   usual glowing HUD: it belongs to the world, not to the interface.

   Wildlife only appears once you've WATCHED it (critters.js banks a sighting). Pinning
   an animal to your map is the reward for the sneak, and showing every critter would
   delete the mechanic outright.

   NO TRAIL NAMES ON THE SHEET. An earlier version printed each trail's name along its
   centreline the way a paper map does; on a network with real names crammed into a
   small canvas it read as clutter, not signage, so it's gone. Trailheads carry the same
   lettered badge the "Start here" list uses instead -- one glance ties the map to the
   list, and the letters stay legible at any zoom because they're drawn live, not baked
   into the atlas raster.

   The full sheet is a pick surface too: tap a lettered trailhead to start there,
   drag to pan, wheel/pinch or the ➕➖ buttons to zoom. Panning and zooming only ever
   touch the CAMERA onto the atlas (a scale + a focus point) -- the atlas itself is
   still built once per world revision, so zooming in doesn't re-render anything, it
   just draws a bigger crop of the same offscreen image. */
import { clamp } from '../core/math.js';
import { getAreas, getBBox, getGraph, getMapScale, getPOIs, getTrailheads, getWaterways, getWorldRevision, styleKey } from './world.js';
import { getSpots, spotWorld } from './spots.js';
import { coursePoints } from './courses.js';
import { reliefCanvas } from './terrain.js';
import { getCritters } from './critters.js';
import { THEME } from './themes.js';

const INK_MAP = '#3a2517';
const TRAIL_INK = {trail:'#9c6a35', track:'#8a6a45', dirtroad:'#a08a68', road:'#6f6b62',
                   paved_trail:'#9d978b', paved_track:'#8d887e'};
const WATER_INK = '#3f8fc9';
// the same magenta course-line.js paints on the ground (0xd94fa0), so the disc in the
// corner and the strip underfoot are recognisably one object seen two ways
const COURSE_MAP_INK = '#d94fa0';
const BIG_ZOOM_MIN = 1, BIG_ZOOM_MAX = 10;

let atlas = null;              // {canvas, x0, z0, w, h, ppm}
let atlasRev = -1;
let miniCv = null, miniCtx = null, bigCv = null, bigCtx = null;
let bigOpen = false;
let bigZoom = 1;               // 1 = whole atlas fit to the sheet, higher = zoomed in
let bigFocus = null;           // world {x,z} centred on the sheet; null -> atlas centre
let bigView = null;            // last-drawn transform, for pointer/wheel picking: {ox,oy,s,dpr,at,W,H}
/* Which trailhead badge the sheet should ring, as of the last frame drawn. Pushed in by
   main.js on every call to updateMinimap rather than read from world.js's getStartHead()
   the way drawTrailheadLabels used to -- getStartHead is where a walk actually BEGINS,
   and tapping a badge to read about it is not the same claim as starting there. This
   module has no way to know which of those two questions is the right one (it doesn't
   know hereSubject exists), so main.js answers it and hands over a plain index the same
   way it hands over px/pz/yaw. -1 means "highlight nothing", not "highlight head 0". */
let lastSelectedHead = -1;
let onTrailheadPick = null;    // main.js's placeAtHead, wired through initMinimap
let onSpotPick = null;         // main.js's placeAtSpot, same arrangement
let bigWired = false;          // guards against double-binding listeners if init runs twice

/* The route the walker is currently on, and the edges that belong to it.

   Drawn LIVE rather than baked into the atlas, for the same reason the trailhead badges
   are: the atlas is rebuilt only when the world is, and this changes every time you step
   from one trail onto another. Held as a small cache keyed by (route, world revision)
   because the edge list for a route is a filter over the whole graph -- cheap, but not
   cheap enough to repeat twice a frame on both canvases forever. */
let hiRoute = null;
let hiCache = {route:null, rev:-1, edges:[]};

function setHighlightRoute(route){ hiRoute = route || null; }
function getHighlightRoute(){ return hiRoute; }

function highlightEdges(){
  const rev = getWorldRevision();
  if(hiCache.route === hiRoute && hiCache.rev === rev) return hiCache.edges;
  const G = getGraph();
  const edges = (hiRoute && G) ? G.edges.filter(e => e.route === hiRoute) : [];
  hiCache = {route:hiRoute, rev, edges};
  return edges;
}

/* The course drawn over everything else: the one being recorded, raced or previewed.

   Held as the course OBJECT rather than as a list of screen points, so this module re-reads
   coursePoints() every frame and a course drawn here is always at the current world scale.
   That also means the live recording draws for free -- main.js hands over a bare
   {name, pts} while the trace is still growing, and nothing here has to know the difference
   between a course that is finished and one that is three seconds old.

   A separate slot from hiRoute, not a second use of it. The highlighted route is "the trail
   underfoot", which changes every time you step across a fork; the course is a deliberate
   choice that has to stay put while you run over a dozen different trails. Folding them
   together would have the course vanish the moment the race left its first trail. */
let shownCourse = null;
let raceFrac = -1;              // 0..1 along the shown course, or <0 for "not racing"

/* Held BY REFERENCE, and that is what makes the live recording free: main.js hands over
   `rec.live` once when recording starts, its `pts` array is then appended to in place, and
   every frame this module re-reads it. No per-sample push, no invalidation. drawCourse
   already declines to draw fewer than two points, so a trace one point long is not a case
   that needs handling here. */
function setCourseShown(c){ shownCourse = (c && Array.isArray(c.pts)) ? c : null; }
function getCourseShown(){ return shownCourse; }
/* Where the runner has got to, so the sheet can show the part still to come in full
   strength and the part already run dimmed. Set to <0 when no race is live. */
function setRaceFrac(f){ raceFrac = (f == null || !isFinite(f)) ? -1 : f; }
function getRaceFrac(){ return raceFrac; }

// Same lettering as main.js's start-picker (A, B, C... then plain numbers past Z) so a
// badge on the map and a card in the "Start here" list always agree. Duplicated rather
// than imported: main.js imports THIS module, and the two never need to be the same
// function, only produce the same letters for the same index.
function headLetterMM(i){ return i<26 ? String.fromCharCode(65+i) : String(i+1); }

function clampToAtlas(pt, at){
  return { x: clamp(pt.x, at.x0, at.x0+at.w), z: clamp(pt.z, at.z0, at.z0+at.h) };
}

function setBigZoom(z){ bigZoom = clamp(z, BIG_ZOOM_MIN, BIG_ZOOM_MAX); }

/* Zoom by `factor`, anchored on the atlas point currently under canvas-pixel (px,py) --
   pass the sheet's own centre (or omit) to zoom in place, since the focus point IS what
   sits at centre by construction (see the draw transform below), so a centre-anchored
   zoom needs no focus recompute at all. Wheel zoom passes the cursor instead, so the
   spot under the pointer doesn't drift out from under it as you scroll. */
function zoomBigToward(factor, px, py){
  if(!bigView){ setBigZoom(bigZoom*factor); return; }
  const {ox, oy, s, at, W, H} = bigView;
  const cx = px==null ? W/2 : px, cy = py==null ? H/2 : py;
  const kOld = at.ppm*s;
  const wx = at.x0 + (cx-ox)/kOld, wz = at.z0 + (cy-oy)/kOld;
  setBigZoom(bigZoom*factor);
  const kNew = at.ppm*bigView.baseS*bigZoom;
  bigFocus = clampToAtlas({ x: wx-(cx-W/2)/kNew, z: wz-(cy-H/2)/kNew }, at);
}

function pickTrailheadAt(px, py){
  if(!bigView || !onTrailheadPick) return false;
  const {ox, oy, s, at, dpr} = bigView;
  const k = at.ppm*s;
  const heads = getTrailheads();
  let best=-1, bestD=Infinity;
  for(let i=0;i<heads.length;i++){
    const h=heads[i];
    const d = Math.hypot(ox+(h.x-at.x0)*k-px, oy+(h.z-at.z0)*k-py);
    if(d<bestD){ bestD=d; best=i; }
  }
  const hitR = Math.max(24*(dpr||1), 34);       // generous tap target, bigger than the drawn badge
  if(best<0 || bestD>hitR) return false;
  /* CLOSING IS THE CALLBACK'S DECISION, NOT THIS FUNCTION'S. It used to close the sheet
     here, because a pick meant "take me there" and there was nothing to stay for. Now a
     trailhead pick fills a details card that lives ON the sheet, so closing it would hide
     the very thing the tap was asking to see. A pin still closes, because going there IS
     what tapping a pin means -- but that is a fact about pins, and it belongs with the
     handler that knows it rather than in the hit test. */
  onTrailheadPick(best);
  return true;
}

/* A saved pin is a pick target on the same sheet as the trailheads, and it wins ties.
   It is drawn on top, it is the thing the walker deliberately put there, and there are
   at most a couple of dozen of them against eight trailheads -- so a tap that could mean
   either almost always means the pin. */
function pickSpotAt(px, py){
  if(!bigView || !onSpotPick) return false;
  const {ox, oy, s, at, dpr} = bigView;
  const k = at.ppm*s;
  const spots = getSpots();
  let best=null, bestD=Infinity;
  for(const sp of spots){
    const p = spotWorld(sp);
    const d = Math.hypot(ox+(p.x-at.x0)*k-px, oy+(p.z-at.z0)*k-py);
    if(d<bestD){ bestD=d; best=sp; }
  }
  const hitR = Math.max(22*(dpr||1), 30);
  if(!best || bestD>hitR) return false;
  onSpotPick(best);             // the handler closes the sheet; see pickTrailheadAt above
  return true;
}

/* One tap, two kinds of target. Spots first (see above), trailheads second. */
function pickOnSheet(px, py){
  return pickSpotAt(px, py) || pickTrailheadAt(px, py);
}

/* Drag-to-pan + tap-to-pick, as one pointer sequence: a real drag pans, a pointer that
   never moved past a small threshold is a tap and tries to pick a trailhead instead.
   Wheel zooms toward the cursor. Buttons zoom in place (see zoomBigToward above). */
function wireBigMapControls(){
  if(bigWired || !bigCv) return;
  bigWired = true;
  const toCanvasPt = e=>{
    const rect = bigCv.getBoundingClientRect();
    const dpr = bigCv.width / Math.max(1, rect.width);
    return { x:(e.clientX-rect.left)*dpr, y:(e.clientY-rect.top)*dpr, dpr };
  };
  let drag = null;
  bigCv.addEventListener('pointerdown', e=>{
    const p = toCanvasPt(e);
    drag = { id:e.pointerId, sx:e.clientX, sy:e.clientY, moved:false, dpr:p.dpr,
             focus0: bigFocus ? {...bigFocus} : null };
    bigCv.setPointerCapture?.(e.pointerId);
  });
  bigCv.addEventListener('pointermove', e=>{
    if(!drag || e.pointerId!==drag.id || !bigView) return;
    const dx=e.clientX-drag.sx, dy=e.clientY-drag.sy;
    if(!drag.moved && Math.hypot(dx,dy) < 5) return;
    drag.moved = true;
    const {s, at} = bigView, k = at.ppm*s;
    const base = drag.focus0 || bigFocus || {x:at.x0+at.w/2, z:at.z0+at.h/2};
    bigFocus = clampToAtlas({ x: base.x-(dx*drag.dpr)/k, z: base.z-(dy*drag.dpr)/k }, at);
  });
  const endDrag = e=>{
    if(!drag || e.pointerId!==drag.id) return;
    if(!drag.moved){ const p=toCanvasPt(e); pickOnSheet(p.x, p.y); }
    drag = null;
  };
  bigCv.addEventListener('pointerup', endDrag);
  bigCv.addEventListener('pointercancel', ()=>{ drag=null; });
  bigCv.addEventListener('wheel', e=>{
    e.preventDefault();
    const p = toCanvasPt(e);
    zoomBigToward(e.deltaY<0 ? 1.2 : 1/1.2, p.x, p.y);
  }, {passive:false});
  document.getElementById('bigZoomIn')?.addEventListener('click', ()=> zoomBigToward(1.4));
  document.getElementById('bigZoomOut')?.addEventListener('click', ()=> zoomBigToward(1/1.4));
}

/* `onPick(i)` is main.js's placeAtHead -- called with a trailhead index when the sheet
   is tapped on one. Kept as a callback rather than an import so this module never needs
   to know about player state, avatars or cameras, only "which trailhead". */
/* `onPick` may be a plain function (trailhead picked -- the original contract) or an
   options object carrying both handlers. Kept polymorphic rather than versioned because
   the trailhead callback is the one this module cannot work without and the spot one is
   genuinely optional: a caller with no saved-spot feature should not have to pass null. */
function initMinimap(onPick){
  const opts = (typeof onPick === 'function') ? {onTrailhead:onPick} : (onPick || {});
  onTrailheadPick = opts.onTrailhead || null;
  onSpotPick = opts.onSpot || null;
  miniCv = document.getElementById('minimap');
  bigCv = document.getElementById('bigmap');
  if(miniCv) miniCtx = miniCv.getContext('2d');
  if(bigCv) bigCtx = bigCv.getContext('2d');
  wireBigMapControls();
}

/* Called by panes.js and nothing else. `bigOpen` is no longer an answer to "is the map
   showing" -- panes.js owns that -- it is only this module's DRAW GATE, so updateMinimap
   can skip a sheet nobody is looking at. It stopped touching body.bigmap for the same
   reason: two writers of one class is how the class and the flag end up disagreeing.

   The rising edge still resets zoom and focus, so every open is a fresh fit-to-screen
   rather than wherever you happened to leave the camera three walks ago. */
function setBigMapOpen(on){
  const next = !!on;
  if(next && !bigOpen){ bigZoom = 1; bigFocus = null; }
  bigOpen = next;
}

// Test seam, same reason main.js exports trailIsPlaying/getTrailPlayer/getTripState:
// `bigView` is a top-level `let`, invisible to tools/smoke.js once flattened into the
// built bundle, so a plain getter is the only way the harness can compute an exact
// on-screen trailhead position and drive a real tap-to-pick end to end.
function getBigView(){ return bigView; }

// Same test seam, same reason: `lastSelectedHead` is a top-level `let`, invisible to
// tools/smoke.js once flattened, so this is the only way the harness can confirm a tap
// actually changed what the sheet is about to ring on its next draw.
function getSelectedHead(){ return lastSelectedHead; }

/* ---------- the static atlas ---------- */

function buildAtlas(){
  const G = getGraph();
  if(!G) { atlas = null; return; }
  const bb = getBBox(), pad = 70*getMapScale();
  const wx = (bb.maxx - bb.minx) + pad*2, wz = (bb.maxz - bb.minz) + pad*2;
  if(!(wx > 0 && wz > 0)) { atlas = null; return; }
  // cap the long side so a 3 km network doesn't allocate a 12k-pixel canvas
  const ppm = clamp(Math.min(2000/wx, 2000/wz), 0.06, 4);
  const cv = document.createElement('canvas');
  cv.width = Math.max(2, Math.round(wx*ppm));
  cv.height = Math.max(2, Math.round(wz*ppm));
  const g = cv.getContext('2d');
  if(!g){ atlas = null; return; }
  const x0 = bb.minx - pad, z0 = bb.minz - pad;
  const X = x => (x - x0)*ppm, Z = z => (z - z0)*ppm;

  g.fillStyle = '#e9dcbe';
  g.fillRect(0, 0, cv.width, cv.height);

  // relief underlay, straight from the same band grid the terrain mesh is built from
  const relief = reliefCanvas(THEME);
  if(relief){
    g.save();
    g.globalAlpha = 0.85;
    g.imageSmoothingEnabled = true;
    g.drawImage(relief.canvas, X(relief.x0), Z(relief.z0), relief.w*ppm, relief.h*ppm);
    g.restore();
  }

  // areas: a wash of colour with a dashed boundary, the way a park map prints them
  const AREA_TINT = {water:'#79b7d6', forest:'#5c7f52', meadow:'#9fae62',
                     parking:'#b9ae97', rock:'#a6866c', building:'#a08b76'};
  g.lineWidth = Math.max(1, ppm*1.1);
  for(const a of getAreas()){
    if(!a.rings || !a.rings.length) continue;
    g.beginPath();
    for(const ring of a.rings){
      ring.forEach((p, i) => i ? g.lineTo(X(p[0]), Z(p[1])) : g.moveTo(X(p[0]), Z(p[1])));
      g.closePath();
    }
    g.fillStyle = AREA_TINT[a.kind] || '#a8b184';
    g.globalAlpha = a.kind === 'water' ? 0.75 : 0.4;
    g.fill();
    g.globalAlpha = 0.7;
    g.strokeStyle = INK_MAP;
    g.setLineDash([ppm*3, ppm*2.4]);
    g.stroke();
    g.setLineDash([]);
  }
  g.globalAlpha = 1;

  // creeks under the trails, so a bridge reads as the path passing over the water
  g.lineCap = 'round'; g.lineJoin = 'round';
  for(const w of getWaterways()){
    const pts = (w.prof && w.prof.pts) || w.pts;
    if(!pts || pts.length < 2) continue;
    g.beginPath();
    pts.forEach((p, i) => i ? g.lineTo(X(p[0]), Z(p[1])) : g.moveTo(X(p[0]), Z(p[1])));
    g.lineWidth = Math.max(1.4, ppm*Math.max(2.2, w.width*1.4));
    g.strokeStyle = WATER_INK;
    g.globalAlpha = w.intermittent ? 0.55 : 0.9;
    g.stroke();
  }
  g.globalAlpha = 1;

  // trails: ink casing then fill, so crossings read cleanly at any zoom
  const strokeEdges = (width, colorOf) => {
    g.lineCap = 'round'; g.lineJoin = 'round';
    for(const e of G.edges){
      if(e.pts.length < 2) continue;
      g.beginPath();
      e.pts.forEach((p, i) => i ? g.lineTo(X(p[0]), Z(p[1])) : g.moveTo(X(p[0]), Z(p[1])));
      g.lineWidth = width;
      g.strokeStyle = colorOf(e);
      g.stroke();
    }
  };
  strokeEdges(Math.max(2.2, ppm*4.2), () => INK_MAP);
  strokeEdges(Math.max(1.2, ppm*2.4), e => TRAIL_INK[styleKey(e)] || TRAIL_INK.trail);

  // points of interest
  for(const p of getPOIs()){
    const r = Math.max(2, ppm*2.6);
    g.beginPath(); g.arc(X(p.x), Z(p.z), r, 0, 7);
    g.fillStyle = '#fff8e6'; g.fill();
    g.lineWidth = Math.max(1, ppm*0.9); g.strokeStyle = INK_MAP; g.stroke();
  }
  // trailheads get a square so they never read as just another POI
  for(const h of getTrailheads()){
    const r = Math.max(2.6, ppm*3.2);
    g.fillStyle = '#e8743a'; g.strokeStyle = INK_MAP; g.lineWidth = Math.max(1, ppm);
    g.fillRect(X(h.x)-r, Z(h.z)-r, r*2, r*2);
    g.strokeRect(X(h.x)-r, Z(h.z)-r, r*2, r*2);
  }

  /* SENTINEL PIXEL, top-left, opaque, a colour nothing else paints.
     It sits in the map's padding margin, outside the bbox of anything drawn, so it costs
     one pixel of blank border and is never visible at any zoom. Its only job is to be
     readable later -- see atlasIntact. */
  g.fillStyle = ATLAS_SENTINEL_CSS;
  g.fillRect(0, 0, 1, 1);

  atlas = {canvas: cv, x0, z0, w: wx, h: wz, ppm};
}

/* ---------- surviving a discarded backing store ----------

   THE BUG: every so often the map would come up blank except for the trail and the
   trailhead badges, and changing the environment fixed it. That shape is the whole
   diagnosis. The trail and the badges are the only things drawn LIVE on top each frame;
   everything else -- relief, contours, roads, POIs -- is baked into the atlas once. So
   the live layer was fine and the baked layer was gone. Changing the environment bumps
   the world revision, which rebuilds the atlas, which is why it "fixed" it.

   Mobile Safari discards the backing store of a large offscreen canvas under memory
   pressure, most often while the tab is backgrounded. The canvas ELEMENT survives with
   its width and height intact -- so `atlas` is still a perfectly good-looking object and
   the `!atlas` check in ensureAtlas never fires -- but its pixels come back transparent.
   A cache keyed only on the world revision has no way to notice.

   So check the pixels, not the object. One getImageData of a single pixel is a trivial
   readback, and it is rate-limited to twice a second because it is guarding against an
   OS event, not a code path. A canvas that has been discarded reads back transparent
   black, which is why the sentinel is opaque: alpha alone is enough to tell them apart,
   and the colour comparison catches a partial restore too.

   visibilitychange is the belt to that braces: backgrounding is when the discard usually
   happens, so invalidate on the way back in rather than waiting up to 500 ms for the next
   probe to notice. Neither path rebuilds anything by itself -- both just clear the cache
   so the next ensureAtlas does the work, on the frame that actually needs it. */
const ATLAS_SENTINEL_CSS = '#ff00ff';
const ATLAS_SENTINEL = [255, 0, 255, 255];
const ATLAS_PROBE_MS = 500;
let lastProbe = 0;

function atlasIntact(at){
  const now = Date.now();
  if(now - lastProbe < ATLAS_PROBE_MS) return true;
  lastProbe = now;
  try{
    const g = at.canvas.getContext('2d');
    if(!g || typeof g.getImageData !== 'function') return true;   // headless: nothing to check
    const d = g.getImageData(0, 0, 1, 1).data;
    return d[3] === ATLAS_SENTINEL[3] && d[0] === ATLAS_SENTINEL[0] &&
           d[1] === ATLAS_SENTINEL[1] && d[2] === ATLAS_SENTINEL[2];
  }catch(err){
    /* A readback that throws tells us nothing about the pixels, and rebuilding a
       2000px atlas every frame on a browser that refuses getImageData would be far
       worse than the bug. Assume intact and let the revision counter do its job. */
    return true;
  }
}

function invalidateAtlas(){ atlas = null; atlasRev = -1; }

if(typeof document !== 'undefined' && document.addEventListener){
  document.addEventListener('visibilitychange', () => {
    if(!document.hidden) invalidateAtlas();
  });
}

function ensureAtlas(){
  const rev = getWorldRevision();
  if(rev !== atlasRev || !atlas){ atlasRev = rev; buildAtlas(); return atlas; }
  if(!atlasIntact(atlas)) buildAtlas();
  return atlas;
}

/* ---------- live markers ---------- */

function drawPup(g, cx, cy, yaw, scale){
  // world yaw: 0 faces +x, and +z is south, so screen angle is -yaw with y down
  g.save();
  g.translate(cx, cy);
  g.rotate(-yaw + Math.PI/2);
  g.beginPath();
  g.moveTo(0, -9*scale); g.lineTo(6.4*scale, 7*scale);
  g.lineTo(0, 3.4*scale); g.lineTo(-6.4*scale, 7*scale);
  g.closePath();
  g.fillStyle = '#e8743a'; g.fill();
  g.lineWidth = 2.4*scale; g.strokeStyle = '#fff8e6'; g.stroke();
  g.lineWidth = 1.2*scale; g.strokeStyle = INK_MAP; g.stroke();
  g.restore();
}

function drawSighted(g, X, Z, scale){
  for(const c of getCritters()){
    if(!c.sighted) continue;
    const x = X(c.x), y = Z(c.z);
    g.beginPath(); g.arc(x, y, 4.2*scale, 0, 7);
    g.fillStyle = '#ffd94a'; g.fill();
    g.lineWidth = 1.4*scale; g.strokeStyle = INK_MAP; g.stroke();
  }
}

/* "Which of these is the one I'm on." A network of fifty named trails printed in one ink
   colour answers that question no better than the ground does, which is the whole reason
   a walker pulls the map out at a fork. So the route underfoot is over-stroked in a
   bright casing: a wide pale halo first, then the route's OWN blaze colour on top -- the
   same colour as the posts along it, so the map and the world agree without a legend.

   Over-stroked rather than redrawn: the atlas underneath keeps the trail's casing and
   fill, so a highlighted trail still reads as a trail rather than as a coloured line
   that happens to lie on one. */
function drawHighlight(g, X, Z, scale){
  const edges = highlightEdges();
  if(!edges.length) return;
  g.save();
  g.lineCap = 'round'; g.lineJoin = 'round';
  const trace = () => {
    g.beginPath();
    for(const e of edges){
      if(e.pts.length < 2) continue;
      e.pts.forEach((p, i) => i ? g.lineTo(X(p[0]), Z(p[1])) : g.moveTo(X(p[0]), Z(p[1])));
    }
  };
  trace();
  g.globalAlpha = 0.55;
  g.lineWidth = 7.5*scale; g.strokeStyle = '#fff8e6'; g.stroke();
  g.globalAlpha = 1;
  trace();
  g.lineWidth = 3.2*scale; g.strokeStyle = edges[0].color || '#e8743a'; g.stroke();
  g.restore();
}

/* The course line. Drawn ON TOP of the route highlight and under every marker, in an ink
   nothing else on this map uses (the same magenta course-line.js paints on the ground, so
   the disc in the corner and the strip underfoot are recognisably one thing).

   Dashed rather than solid, and that is not decoration: a solid bright line over a network
   of solid trail lines is one more line, whereas a dashed one reads as an overlay at a
   glance even where it runs along a trail for a kilometre -- which is the normal case,
   since a course is by construction made of trails.

   While a race is live the stretch already run is drawn faint and the stretch still to come
   full strength, so the sheet answers "how much is left" without a number. */
function drawCourse(g, X, Z, scale, withEnds){
  const c = shownCourse;
  if(!c) return;
  const pts = coursePoints(c);
  if(pts.length < 2) return;
  g.save();
  g.lineCap = 'round'; g.lineJoin = 'round';

  // cut the polyline at the runner's position, so the two halves can be stroked apart
  const cut = raceFrac >= 0 ? Math.max(0, Math.min(1, raceFrac)) : 0;
  const arc = [0];
  for(let i=1;i<pts.length;i++)
    arc[i] = arc[i-1] + Math.hypot(pts[i][0]-pts[i-1][0], pts[i][1]-pts[i-1][1]);
  const total = arc[arc.length-1] || 1;
  const cutS = cut*total;

  const strokeRange = (fromS, toS) => {
    g.beginPath();
    let started = false;
    for(let i=0;i<pts.length-1;i++){
      const a0 = arc[i], a1 = arc[i+1];
      if(a1 < fromS || a0 > toS) continue;
      const seg = a1-a0;
      const t0 = seg > 0 ? Math.max(0, (fromS-a0)/seg) : 0;
      const t1 = seg > 0 ? Math.min(1, (toS-a0)/seg) : 1;
      const px0 = pts[i][0] + (pts[i+1][0]-pts[i][0])*t0;
      const pz0 = pts[i][1] + (pts[i+1][1]-pts[i][1])*t0;
      const px1 = pts[i][0] + (pts[i+1][0]-pts[i][0])*t1;
      const pz1 = pts[i][1] + (pts[i+1][1]-pts[i][1])*t1;
      if(!started){ g.moveTo(X(px0), Z(pz0)); started = true; }
      else g.lineTo(X(px0), Z(pz0));
      g.lineTo(X(px1), Z(pz1));
    }
    return started;
  };

  // pale casing under the whole thing, so the dashes stay legible over dark relief
  g.setLineDash([]);
  g.globalAlpha = 0.5;
  g.lineWidth = 7*scale; g.strokeStyle = '#fff8e6';
  if(strokeRange(0, total)) g.stroke();

  g.setLineDash([9*scale, 6*scale]);
  if(raceFrac >= 0 && cutS > 0){
    g.globalAlpha = 0.28;
    g.lineWidth = 3*scale; g.strokeStyle = COURSE_MAP_INK;
    if(strokeRange(0, cutS)) g.stroke();
  }
  g.globalAlpha = 1;
  g.lineWidth = 3.4*scale; g.strokeStyle = COURSE_MAP_INK;
  if(strokeRange(raceFrac >= 0 ? cutS : 0, total)) g.stroke();
  g.setLineDash([]);

  if(withEnds){
    const a = pts[0], b = pts[pts.length-1];
    const r = 6*scale;
    // start: a solid disc. finish: a ring, so the two are told apart by shape and not
    // only by colour -- on a loop they land within a few metres of each other.
    g.beginPath(); g.arc(X(a[0]), Z(a[1]), r, 0, 7);
    g.fillStyle = '#4f9d4f'; g.fill();
    g.lineWidth = Math.max(1.4, 1.8*scale); g.strokeStyle = INK_MAP; g.stroke();
    g.beginPath(); g.arc(X(b[0]), Z(b[1]), r, 0, 7);
    g.fillStyle = '#fff8e6'; g.fill();
    g.lineWidth = Math.max(1.8, 2.4*scale); g.strokeStyle = INK_MAP; g.stroke();
    g.beginPath(); g.arc(X(b[0]), Z(b[1]), r*0.42, 0, 7);
    g.fillStyle = INK_MAP; g.fill();
  }
  g.restore();
}

/* Saved pins, numbered in the order they were dropped so the badge on the sheet matches
   the row in the list beside it. Drawn as a teardrop rather than a disc so a pin can
   never be mistaken for a trailhead badge or a sighted animal at a glance -- three kinds
   of marker on one map is two too many to distinguish by colour alone. */
function drawSpots(g, X, Z, scale, withLabels){
  const spots = getSpots();
  if(!spots.length) return;
  spots.forEach((sp, i)=>{
    const p = spotWorld(sp);
    const x = X(p.x), y = Z(p.z);
    const r = 6.4*scale;
    g.save();
    g.beginPath();
    // circular head with a point at the bottom, meeting the ground at (x, y)
    g.arc(x, y - r*1.35, r, Math.PI*0.82, Math.PI*0.18);
    g.lineTo(x, y);
    g.closePath();
    g.fillStyle = '#4f8fd6'; g.fill();
    g.lineWidth = Math.max(1.4, 1.8*scale); g.strokeStyle = INK_MAP; g.stroke();
    if(withLabels){
      g.font = `bold ${8.4*scale}px "Comic Sans MS","Chalkboard SE",sans-serif`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillStyle = '#fff8e6';
      g.fillText(String(i+1), x, y - r*1.35);
    }
    g.restore();
  });
}

/* Lettered, tappable trailhead badges for the full sheet -- constant SCREEN size
   regardless of zoom (like a map pin), same lettering as the "Start here" list so the
   two always agree. The selected one gets a bright ring so "which one am I looking at"
   reads at a glance -- see lastSelectedHead above for why that is not always the same
   trailhead a walk would actually begin at. Drawn live rather than baked into the atlas: a
   handful of circles is cheap every frame, and it keeps the letters crisp at any zoom
   instead of blurring along with the raster underneath them. */
function drawTrailheadLabels(g, X, Z, scale, selectedIdx){
  const heads = getTrailheads();
  const r = 9*scale;
  heads.forEach((h, i)=>{
    const x = X(h.x), y = Z(h.z);
    const sel = i===selectedIdx;
    if(sel){
      g.beginPath(); g.arc(x, y, r+4*scale, 0, 7);
      g.lineWidth = Math.max(1.5, 2*scale); g.strokeStyle = '#ffd94a'; g.stroke();
    }
    g.beginPath(); g.arc(x, y, r, 0, 7);
    g.fillStyle = sel ? '#ffd94a' : '#e8743a';
    g.fill();
    g.lineWidth = Math.max(1.5, 2*scale); g.strokeStyle = INK_MAP; g.stroke();
    g.font = `bold ${11*scale}px "Comic Sans MS","Chalkboard SE",sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = sel ? INK_MAP : '#fff8e6';
    g.fillText(headLetterMM(i), x, y + 0.5*scale);
  });
}

/* Fit the backing store to the element's real pixel size. Called every frame because the
   corner map lives in a flex layout and iOS's visual viewport resizes underneath it
   without firing anything useful; the early-out makes the common case free. */
function fitCanvas(cv){
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.round(cv.clientWidth*dpr), h = Math.round(cv.clientHeight*dpr);
  if(w < 2 || h < 2) return false;
  if(cv.width !== w || cv.height !== h){ cv.width = w; cv.height = h; }
  return true;
}

function updateMinimap(px, pz, yaw, selectedHead){
  const at = ensureAtlas();

  if(miniCv && miniCtx && miniCv.clientWidth > 0 && fitCanvas(miniCv)){
    const g = miniCtx, W = miniCv.width, H = miniCv.height;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);
    const span = 230*getMapScale();          // metres across the disc
    const ppx = W/span;
    g.save();
    g.beginPath(); g.arc(W/2, H/2, Math.min(W, H)/2, 0, 7); g.clip();
    g.fillStyle = '#e9dcbe'; g.fillRect(0, 0, W, H);
    if(at){
      const sx = (px - span/2 - at.x0)*at.ppm, sy = (pz - span/2 - at.z0)*at.ppm;
      const sw = span*at.ppm;
      g.imageSmoothingEnabled = true;
      g.drawImage(at.canvas, sx, sy, sw, sw*(H/W), 0, 0, W, H);
    }
    const X = x => (x - px)*ppx + W/2, Z = z => (z - pz)*ppx + H/2;
    const dpr = W/miniCv.clientWidth;
    drawHighlight(g, X, Z, dpr*0.85);
    drawCourse(g, X, Z, dpr*0.85, true);
    drawSighted(g, X, Z, dpr);
    drawSpots(g, X, Z, dpr*1.05, false);
    drawPup(g, W/2, H/2, yaw, dpr*1.15);
    g.restore();
  }

  if(bigOpen && bigCv && bigCtx && fitCanvas(bigCv)){
    const g = bigCtx, W = bigCv.width, H = bigCv.height;
    const dpr = W/bigCv.clientWidth;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);
    g.fillStyle = '#e9dcbe'; g.fillRect(0, 0, W, H);
    if(at){
      // fit-to-screen scale, then the user's own zoom on top of it; centred on bigFocus
      // (default: the atlas centre) rather than always the bbox centre, so panning and
      // zooming compose the same way a real map app's camera does.
      const baseS = Math.min(W/(at.w*at.ppm), H/(at.h*at.ppm));
      const s = baseS*bigZoom;
      if(!bigFocus) bigFocus = { x: at.x0+at.w/2, z: at.z0+at.h/2 };
      const ox = W/2 - (bigFocus.x-at.x0)*at.ppm*s;
      const oy = H/2 - (bigFocus.z-at.z0)*at.ppm*s;
      const dw = at.w*at.ppm*s, dh = at.h*at.ppm*s;
      g.imageSmoothingEnabled = true;
      g.drawImage(at.canvas, ox, oy, dw, dh);
      bigView = {ox, oy, s, baseS, at, W, H, dpr};
      const X = x => ox + (x - at.x0)*at.ppm*s, Z = z => oy + (z - at.z0)*at.ppm*s;
      drawHighlight(g, X, Z, dpr*1.4);
      drawCourse(g, X, Z, dpr*1.4, true);
      lastSelectedHead = (selectedHead == null || selectedHead < 0) ? -1 : selectedHead;
      drawTrailheadLabels(g, X, Z, dpr*1.3, lastSelectedHead);
      drawSighted(g, X, Z, dpr*1.6);
      drawSpots(g, X, Z, dpr*1.9, true);
      drawPup(g, X(px), Z(pz), yaw, dpr*2.2);
    } else {
      bigView = null;
    }
    // north arrow
    g.save();
    g.translate(W - 42*dpr, 42*dpr);
    g.beginPath(); g.moveTo(0, -17*dpr); g.lineTo(8*dpr, 12*dpr); g.lineTo(0, 6*dpr); g.lineTo(-8*dpr, 12*dpr);
    g.closePath();
    g.fillStyle = INK_MAP; g.fill();
    g.font = `bold ${13*dpr}px "Comic Sans MS","Chalkboard SE",sans-serif`;
    g.textAlign = 'center'; g.fillText('N', 0, -24*dpr);
    g.restore();
  }
}

export { initMinimap, updateMinimap, setBigMapOpen, getBigView, getSelectedHead,
         setHighlightRoute, getHighlightRoute, highlightEdges, pickSpotAt, pickOnSheet,
         setCourseShown, getCourseShown, setRaceFrac, getRaceFrac };
