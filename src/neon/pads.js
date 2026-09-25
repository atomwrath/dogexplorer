/* BOOST PADS. Chevrons painted on the deck: ride over one and it lights a burn exactly the
   way a nitro tank does -- same thrust, same length, same flame -- except it costs nothing
   and it never runs out. Everybody can use every pad, every pass.

   Where they go is the whole design. A free burn into a hairpin is a trap, not a gift, so
   pads only sit where the next burn's worth of track is either STRAIGHT or a CLIMB that
   is not also a hard bend (a climb is where a burn pays back most, and the one place a
   rider is most tempted to save a tank). At most one pad per NEON.padEveryM, kept clear of
   the nitro sets so the two never pile up in one spot.

   Deterministic from the track, like the cells: a best time is only a record if the next
   run is the same course with the same pads in the same places. Logic and mesh together,
   the scene half no-ops without THREE, same as cells.js. */
import { scene, disposeGroup } from '../core/render.js';
import { NEON } from './tuning.js';
import { trackFrame, deckY } from './track.js';
import { inGrab } from './cells.js';

/* How good a place s is for a pad: null if it does not qualify, else a score (higher is
   better). Reads the run of track AHEAD in the direction of travel -- T.slope is already
   signed for the way the course is being raced (reverseTrack flips it). */
function padSiteScore(T, s){
  const steps = Math.max(2, Math.ceil(NEON.padRunM/T.ds));
  let kMax = 0, slope = 0, n = 0;
  for(let q = 0; q <= steps; q++){
    let i = Math.floor(s/T.ds) + q;
    if(T.closed) i = ((i % T.n) + T.n) % T.n; else if(i >= T.n) return null;
    kMax = Math.max(kMax, Math.abs(T.k[i]));
    slope += T.slope[i]; n++;
  }
  slope /= n;
  const straight = kMax <= NEON.padStraightK;
  const climb = slope >= NEON.padClimbMin && kMax <= NEON.padClimbK;
  if(!straight && !climb) return null;
  // climbs first, then the straightest straights
  return (climb ? 1 + slope*10 : 0) + (1 - kMax/NEON.padClimbK);
}

function placePads(T, cells){
  const pads = [];
  const bins = Math.max(1, Math.floor(T.L/NEON.padEveryM));
  const bin = T.L/bins;
  const nearCells = s => (cells || []).some(c => {
    let gap = Math.abs(c.s - s);
    if(T.closed) gap = Math.min(gap, T.L - gap);
    return gap < NEON.padClearM;
  });
  // never two within half the spacing of each other -- across the start line too, on a
  // circuit, where the last bin's best spot can sit right behind the first bin's
  const tooClose = s => pads.some(p => {
    let gap = Math.abs(p.s - s);
    if(T.closed) gap = Math.min(gap, T.L - gap);
    return gap < NEON.padEveryM*0.5;
  });
  for(let b = 0; b < bins; b++){
    let best = null, bestScore = -Infinity;
    for(let s = b*bin + T.ds; s < (b + 1)*bin; s += T.ds){
      // nothing on the grid (a circuit lines up behind the line) or in the last stretch
      // before a sprint's flag
      if(!T.closed && (s < 25 || s > T.L - NEON.padRunM - 10)) continue;
      if(T.closed && (s < 20 || s > T.L - 70)) continue;
      if(nearCells(s) || tooClose(s)) continue;
      const sc = padSiteScore(T, s);
      if(sc != null && sc > bestScore){ bestScore = sc; best = s; }
    }
    if(best == null) continue;
    const f = trackFrame(T, best, {});
    const lim = f.halfW - (T.bodyWide || NEON.bodyWide);
    // off-centre in a fixed rotation, so taking one is a line choice, not a gimme
    const lane = [0, 1, -1][pads.length % 3];
    pads.push({s: T.closed ? ((best % T.L) + T.L) % T.L : best, d: lane*lim*0.45, i: pads.length});
  }
  return pads;
}

/* Anyone riding over a pad gets a burn. Returns [{pad, racer}] for this step. A pad does
   not refire for the same rider within padAgainS, so crawling across one at walking pace
   is one burn, not a burn every frame. A spinning board gets nothing. */
function stepPads(pads, racers, T, dt){
  const fired = [];
  for(const p of pads){
    for(const r of racers){
      if(r.done || r.isGhost || r.spinT > 0) continue;
      if(!inGrab(T, r, p.s, p.d, dt)) continue;
      if(!r.padT) r.padT = {};
      const last = r.padT[p.i];
      if(last != null && (r.time || 0) - last < NEON.padAgainS) continue;
      r.padT[p.i] = r.time || 0;
      r.burnT = NEON.burnS;            // the same burn a tank lights, minus the tank
      r.padBurn = true;                // for the HUD: nothing came off the rack
      r.pads = (r.pads || 0) + 1;
      fired.push({pad: p, racer: r});
    }
  }
  return fired;
}

/* ---- the visible half ---- */
let padGroup = null, padMeshes = [];
const PAD_COLOR = 0xff9a3c;            // the colour of the flame it lights

function padMat(color, opacity){
  return new THREE.MeshBasicMaterial({color, transparent:true, opacity,
    blending: THREE.AdditiveBlending, depthWrite:false, side: THREE.DoubleSide});
}
function buildPadMeshes(T, pads, baseM){
  clearPads();
  if(typeof THREE === 'undefined') return null;
  padGroup = new THREE.Group(); padGroup.name = 'neonPads';
  // the drawn pad IS the trigger area: along +-2.5 m, across the grab distance each side
  const K = 1/(T.widthK || 1);
  const half = NEON.cellGrab + (T.bodyWide || NEON.bodyWide)*0.5;
  const len = 5, wide = half*2;
  const baseGeo = new THREE.PlaneGeometry(len, wide);
  const edgeGeo = new THREE.BoxGeometry(len, 0.03, 0.12*K);
  const arm = 0.9*K, reach = half*0.72;
  const armLen = Math.hypot(arm, reach);
  const armGeo = new THREE.BoxGeometry(armLen, 0.03, 0.22*K);
  const armAng = Math.atan2(reach, arm);
  for(const p of pads){
    const f = trackFrame(T, p.s, {});
    // follow the deck's pitch, or a pad on a climb is half buried and half floating
    const yA = deckY(T, trackFrame(T, p.s - 2, {}).elev, baseM);
    const yB = deckY(T, trackFrame(T, p.s + 2, {}).elev, baseM);
    const g = new THREE.Group();
    g.position.set(f.x - Math.sin(f.yaw)*p.d, deckY(T, f.elev, baseM) + 0.1, f.z - Math.cos(f.yaw)*p.d);
    g.rotation.y = f.yaw;              // local +X is down the track (see trackToWorld)
    const tilt = new THREE.Group();
    tilt.rotation.z = Math.atan2(yB - yA, 4);
    g.add(tilt);
    const base = new THREE.Mesh(baseGeo, padMat(PAD_COLOR, 0.16));
    base.rotation.x = -Math.PI/2;
    tilt.add(base);
    for(const side of [-1, 1]){
      const edge = new THREE.Mesh(edgeGeo, padMat(PAD_COLOR, 0.85));
      edge.position.z = side*half;
      tilt.add(edge);
    }
    const chevs = [];
    for(let j = 0; j < 3; j++){
      const c = new THREE.Group();
      const mat = padMat(0xffd2a0, 0.5);
      for(const side of [-1, 1]){
        const a = new THREE.Mesh(armGeo, mat);
        a.position.set(-arm*0.5, 0.01, side*reach*0.5);
        a.rotation.y = side*armAng;
        c.add(a);
      }
      c.position.x = -1.4 + j*1.4 + arm*0.5;
      c.userData.mat = mat;
      tilt.add(c);
      chevs.push(c);
    }
    g.userData.pad = p;
    g.userData.chevs = chevs;
    padGroup.add(g);
    padMeshes.push(g);
  }
  // after the deck (renderOrder 1) and its paint, before the pickups (7)
  padGroup.traverse(o => { o.renderOrder = 6; o.frustumCulled = false; });
  scene.add(padGroup);
  return padGroup;
}
/* The chevrons light in sequence down the track, so a pad reads as "this way, faster"
   from a long way off rather than as a flat orange patch. */
function updatePadMeshes(t){
  for(const g of padMeshes){
    const chevs = g.userData.chevs;
    for(let j = 0; j < chevs.length; j++){
      const u = ((t*1.8 - j*0.28) % 1 + 1) % 1;
      chevs[j].userData.mat.opacity = 0.3 + 0.65*Math.pow(1 - u, 2);
    }
  }
}
function clearPads(){
  if(padGroup){ scene.remove(padGroup); disposeGroup(padGroup); }
  padGroup = null; padMeshes = [];
}

export { padSiteScore, placePads, stepPads, buildPadMeshes, updatePadMeshes, clearPads };
