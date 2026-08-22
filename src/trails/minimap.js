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
   delete the mechanic outright. */
import { clamp } from '../core/math.js';
import { getAreas, getBBox, getGraph, getMapScale, getPOIs, getTrailheads, getWorldRevision } from './world.js';
import { reliefCanvas } from './terrain.js';
import { getCritters } from './critters.js';
import { THEME } from './themes.js';

const INK_MAP = '#3a2517';
const TRAIL_INK = {trail:'#9c6a35', track:'#8a6a45', road:'#6f6b62'};

let atlas = null;              // {canvas, x0, z0, w, h, ppm}
let atlasRev = -1;
let miniCv = null, miniCtx = null, bigCv = null, bigCtx = null;
let bigOpen = false;

function isBigMapOpen(){ return bigOpen; }

function initMinimap(){
  miniCv = document.getElementById('minimap');
  bigCv = document.getElementById('bigmap');
  if(miniCv) miniCtx = miniCv.getContext('2d');
  if(bigCv) bigCtx = bigCv.getContext('2d');
}

function toggleBigMap(force){
  bigOpen = (force === undefined) ? !bigOpen : !!force;
  document.body.classList.toggle('bigmap', bigOpen);
}

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
  strokeEdges(Math.max(1.2, ppm*2.4), e => TRAIL_INK[e.kind] || TRAIL_INK.trail);

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

  atlas = {canvas: cv, x0, z0, w: wx, h: wz, ppm};
}

function ensureAtlas(){
  const rev = getWorldRevision();
  if(rev !== atlasRev || !atlas){ atlasRev = rev; buildAtlas(); }
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

function updateMinimap(px, pz, yaw){
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
    drawSighted(g, X, Z, dpr);
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
      const s = Math.min(W/(at.w*at.ppm), H/(at.h*at.ppm));
      const dw = at.w*at.ppm*s, dh = at.h*at.ppm*s;
      const ox = (W-dw)/2, oy = (H-dh)/2;
      g.imageSmoothingEnabled = true;
      g.drawImage(at.canvas, ox, oy, dw, dh);
      const X = x => ox + (x - at.x0)*at.ppm*s, Z = z => oy + (z - at.z0)*at.ppm*s;
      drawSighted(g, X, Z, dpr*1.6);
      drawPup(g, X(px), Z(pz), yaw, dpr*2.2);
      // trail names along the sheet, which the corner disc has no room for
      g.font = `bold ${13*dpr}px "Comic Sans MS","Chalkboard SE",sans-serif`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      const seen = new Set();
      for(const e of (getGraph()?.edges || [])){
        if(!e.name || seen.has(e.name) || e.pts.length < 3) continue;
        seen.add(e.name);
        const m = e.pts[Math.floor(e.pts.length/2)];
        g.lineWidth = 4*dpr; g.strokeStyle = 'rgba(255,248,230,.9)';
        g.strokeText(e.name, X(m[0]), Z(m[1]) - 11*dpr);
        g.fillStyle = INK_MAP;
        g.fillText(e.name, X(m[0]), Z(m[1]) - 11*dpr);
      }
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

export { initMinimap, updateMinimap, toggleBigMap, isBigMapOpen };
