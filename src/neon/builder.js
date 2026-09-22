/* THE COURSE BUILDER. A map you tap, one trail segment at a time, and a course comes out.

   The whole module is about ONE idea: you point at where you want to go, not at how to
   get there. A tap names a segment; everything between the end of the course so far and
   that segment is found for you, by the same directed-edge search the automatic
   generator uses (routeSearch in routes.js), so a hand-built course obeys exactly the
   same rules about what counts as a way on -- no hairpin at a junction where a straighter
   way exists, no edge walked twice. Tapping the far end of the map from one trailhead is
   a legitimate way to build a course; you just get the sensible line between them.

   What it does NOT do is own any state the game cares about. The builder holds a list of
   directed edge states and an undo stack, and hands that list back on save. main.js turns
   it into a course object and stores it. Nothing here knows about tracks, racers, THREE
   or localStorage.

   NO CANVAS TRANSFORM. Every world point is projected by hand through `view`, because the
   same projection has to run backwards for hit testing, and a ctx.setTransform that the
   picker has to invert separately is two descriptions of one thing waiting to disagree. */
import { routeSearch, unwind } from './routes.js';

const B_PAD = 40;                  // world metres of breathing room when fitting the map
const B_PICK_PX = 22;              // how near a tap has to land, in CSS pixels
const B_ZOOM_MIN = 0.4, B_ZOOM_MAX = 40;   // multiples of the fit-the-whole-map scale

const B_COL = {
  net:    'rgba(70,110,200,0.55)',
  netHot: 'rgba(120,170,255,0.9)',
  glow:   'rgba(25,240,255,0.28)',
  line:   '#19f0ff',
  start:  '#b6ff3c',
  end:    '#ff2bd6',
  reach:  'rgba(182,255,60,0.35)',
};

let bGraph = null, bCtx = null, bCanvas = null, bBox = null;
let bStates = [], bHist = [[]], bAt = 0;
let view = {cx: 0, cz: 0, k: 1, fit: 1};
let bNote = '';

/* ---------- the graph context routeSearch wants ---------- */
function makeCtx(graph){
  const adj = graph.nodes.map(() => []);
  graph.edges.forEach((e, ei) => { adj[e.a].push({ei}); if(e.b !== e.a) adj[e.b].push({ei}); });
  /* cover and skip are the generator's bookkeeping about which trail is already spoken
     for and which twigs are too short to race. Neither applies here: you asked for this
     segment, so every segment is on the table and none of them is "already used up". */
  return {edges: graph.edges, nodes: graph.nodes, adj,
          cover: new Uint16Array(graph.edges.length), skip: new Uint8Array(graph.edges.length)};
}

/* ---------- view ---------- */
function dpr(){ return Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1); }
function bSizeCanvas(cv){
  const d = dpr();
  const w = Math.round((cv.clientWidth || 640)*d), h = Math.round((cv.clientHeight || 420)*d);
  if(cv.width !== w || cv.height !== h){ cv.width = w; cv.height = h; return true; }
  return false;
}
const bX = x => (x - view.cx)*view.k + (bCanvas ? bCanvas.width : 0)/2;
const bY = z => (z - view.cz)*view.k + (bCanvas ? bCanvas.height : 0)/2;
/* CSS pixels in (that is what a pointer event gives), world metres out. */
function bWorld(px, py){
  const d = dpr();
  return [(px*d - (bCanvas ? bCanvas.width : 0)/2)/view.k + view.cx,
          (py*d - (bCanvas ? bCanvas.height : 0)/2)/view.k + view.cz];
}
function builderFit(){
  if(!bCanvas || !bBox) return;
  bSizeCanvas(bCanvas);
  const w = bBox.x1 - bBox.x0 + B_PAD*2, h = bBox.z1 - bBox.z0 + B_PAD*2;
  view.fit = Math.min(bCanvas.width/Math.max(1, w), bCanvas.height/Math.max(1, h));
  view.k = view.fit;
  view.cx = (bBox.x0 + bBox.x1)/2;
  view.cz = (bBox.z0 + bBox.z1)/2;
}
/* Zoom about the CENTRE of the map view, not about a pinch point: the zoom control is a
   pair of buttons, and a button has no position on the map to zoom towards. */
function builderZoom(mul){
  const k = view.k*mul;
  view.k = Math.max(view.fit*B_ZOOM_MIN, Math.min(view.fit*B_ZOOM_MAX, k));
  return view.k;
}
function builderPan(dxPx, dyPx){
  const d = dpr();
  view.cx -= dxPx*d/view.k;
  view.cz -= dyPx*d/view.k;
}
const builderView = () => ({cx: view.cx, cz: view.cz, k: view.k, fit: view.fit});

/* ---------- picking ---------- */
function segDist(px, pz, ax, az, bx, bz){
  const vx = bx-ax, vz = bz-az;
  const L2 = vx*vx + vz*vz;
  let t = L2 > 0 ? ((px-ax)*vx + (pz-az)*vz)/L2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + vx*t), pz - (az + vz*t));
}
/* Nearest edge to a tap, or -1. The threshold is in screen pixels converted to metres, so
   it stays a thumb's width whatever the zoom: zoomed out, trails are close together and
   you have to be accurate; zoomed in, you do not. */
function builderPickAt(pxCss, pyCss){
  if(!bGraph) return -1;
  const [wx, wz] = bWorld(pxCss, pyCss);
  const lim = B_PICK_PX*dpr()/view.k;
  let best = -1, bestD = lim;
  bGraph.edges.forEach((e, ei) => {
    const pts = e.pts;
    for(let i = 1; i < pts.length; i++){
      const d = segDist(wx, wz, pts[i-1][0], pts[i-1][1], pts[i][0], pts[i][1]);
      if(d < bestD){ bestD = d; best = ei; }
    }
  });
  return best;
}

/* ---------- the course so far ---------- */
const stateEnd   = s => { const e = bGraph.edges[s>>1]; return (s&1) ? e.a : e.b; };
const stateStart = s => { const e = bGraph.edges[s>>1]; return (s&1) ? e.b : e.a; };
function builderStates(){ return bStates.slice(); }
function builderLenM(){ return bStates.reduce((a, s) => a + bGraph.edges[s>>1].lenM, 0); }
function builderClosed(){
  return bStates.length > 1 && stateStart(bStates[0]) === stateEnd(bStates[bStates.length-1]);
}
function builderNote(){ return bNote; }
function builderCanUndo(){ return bAt > 0; }
function builderCanRedo(){ return bAt < bHist.length-1; }

function push(states){
  bHist = bHist.slice(0, bAt+1);
  bHist.push(states.slice());
  bAt = bHist.length-1;
  bStates = states.slice();
}

/* THE ONE INTERESTING FUNCTION. Add the segment you tapped, and whatever it takes to get
   there from where the course currently ends.

   The first tap is special: a lone segment has no direction yet, because direction is
   only meaningful once there is somewhere to go next. So it is stored a->b and the SECOND
   tap gets to flip it -- the search is run from both orientations of the first segment and
   the cheaper one wins. Without that, starting a course on a segment and then tapping
   "backwards" along the trail would either fail or leave the course facing the wrong way
   with no way to say so. */
function builderAdd(ei){
  bNote = '';
  if(!bGraph || ei < 0 || ei >= bGraph.edges.length){ bNote = 'Tap a trail.'; return false; }
  const e = bGraph.edges[ei];
  if(bStates.some(s => (s>>1) === ei)){
    bNote = 'That stretch is already on the course.';
    return false;
  }
  if(!bStates.length){ push([ei*2]); return true; }

  const banned = new Uint8Array(bGraph.edges.length);
  for(const s of bStates) banned[s>>1] = 1;
  const starts = bStates.length === 1 ? [bStates[0], bStates[0]^1] : [bStates[bStates.length-1]];
  let best = null;
  for(const from of starts){
    const R = routeSearch(bCtx, from, banned, null);
    for(const t of [ei*2, ei*2+1]){
      if(!isFinite(R.dist[t])) continue;
      if(!best || R.dist[t] < best.d - 1e-9){
        best = {d: R.dist[t], add: unwind(R.prev, t, from), from};
      }
    }
  }
  if(!best){
    /* Two different failures, and they want different advice: the course may be in its
       own way, or that trail may simply not join this one anywhere on the map. Ask the
       search again with nothing banned to tell which. */
    const free = new Uint8Array(bGraph.edges.length);
    const R = routeSearch(bCtx, starts[0], free, null);
    bNote = (isFinite(R.dist[ei*2]) || isFinite(R.dist[ei*2+1]))
      ? 'No way to get there without crossing the course. Try a nearer stretch.'
      : 'That trail does not join this one anywhere on the map.';
    return false;
  }
  const head = bStates.slice(0, -1).concat([best.from]);   // the flip, if the search took it
  push(head.concat(best.add));
  return true;
}
function builderUndo(){ if(bAt > 0){ bAt--; bStates = bHist[bAt].slice(); bNote = ''; return true; } return false; }
function builderRedo(){ if(bAt < bHist.length-1){ bAt++; bStates = bHist[bAt].slice(); bNote = ''; return true; } return false; }
function builderClear(){ push([]); bNote = ''; }

/* The course as a polyline, for the preview and for drawing. */
function builderLine(){
  const out = [];
  for(const s of bStates){
    const pts = bGraph.edges[s>>1].pts;
    const seq = (s&1) ? pts.slice().reverse() : pts;
    for(let i = (out.length ? 1 : 0); i < seq.length; i++) out.push(seq[i]);
  }
  return out;
}

/* ---------- drawing ---------- */
function builderDraw(){
  if(!bCanvas) return;
  bSizeCanvas(bCanvas);
  const g = bCanvas.getContext('2d');
  if(!g) return;
  const S = bCanvas.width/900;                   // one scale for every stroke width
  g.clearRect(0, 0, bCanvas.width, bCanvas.height);
  g.lineCap = 'round'; g.lineJoin = 'round';

  /* The network, and then the segments you could add next in a brighter shade. Knowing
     what is tappable without tapping is most of what makes this feel like a map rather
     than a guessing game. */
  const hot = new Set();
  if(bStates.length){
    const at = stateEnd(bStates[bStates.length-1]);
    bGraph.edges.forEach((e, ei) => {
      if(bStates.some(s => (s>>1) === ei)) return;
      if(e.a === at || e.b === at) hot.add(ei);
    });
  }
  const pass = (want, col, w) => {
    g.strokeStyle = col; g.lineWidth = Math.max(1, w*S);
    g.beginPath();
    bGraph.edges.forEach((e, ei) => {
      if(!want(ei)) return;
      e.pts.forEach((p, i) => { if(i) g.lineTo(bX(p[0]), bY(p[1])); else g.moveTo(bX(p[0]), bY(p[1])); });
    });
    g.stroke();
  };
  pass(ei => !hot.has(ei), B_COL.net, 1.4);
  pass(ei => hot.has(ei), B_COL.netHot, 2.2);

  const line = builderLine();
  if(line.length > 1){
    for(const [color, w] of [[B_COL.glow, 9], [B_COL.line, 3]]){
      g.strokeStyle = color; g.lineWidth = Math.max(1, w*S);
      g.beginPath();
      line.forEach((p, i) => { if(i) g.lineTo(bX(p[0]), bY(p[1])); else g.moveTo(bX(p[0]), bY(p[1])); });
      g.stroke();
    }
  }
  if(line.length){
    const closed = builderClosed();
    const s = line[0], f = line[line.length-1];
    g.fillStyle = B_COL.start;
    g.beginPath(); g.arc(bX(s[0]), bY(s[1]), 6*S, 0, 7); g.fill();
    if(!closed){
      g.fillStyle = B_COL.end;
      g.beginPath(); g.arc(bX(f[0]), bY(f[1]), 6*S, 0, 7); g.fill();
    }
  }
}

function builderOpen(graph, box, canvas, states){
  bGraph = graph; bBox = box; bCanvas = canvas;
  bCtx = makeCtx(graph);
  bStates = (states || []).filter(s => (s>>1) < graph.edges.length);
  bHist = [bStates.slice()]; bAt = 0; bNote = '';
  builderFit();
  builderDraw();
}
function builderClose(){ bGraph = null; bCtx = null; bCanvas = null; bStates = []; bHist = [[]]; bAt = 0; }

export { builderOpen, builderClose, builderAdd, builderPickAt, builderUndo, builderRedo,
         builderClear, builderDraw, builderFit, builderZoom, builderPan, builderView,
         builderStates, builderLine, builderClosed, builderLenM, builderNote,
         builderCanUndo, builderCanRedo, B_PICK_PX };
