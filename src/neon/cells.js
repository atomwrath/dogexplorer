/* BOOST CELLS (drawn as nitro tanks). Free charge lying on the racing line, and the reason the line is worth
   arguing about: the fast way through a corner and the way past the cell on its outside
   are rarely the same, so a lap is a series of small bargains.

   Placed deterministically from the course, like everything else here -- a best time is
   only a record if the next run is the same course with the same cells in the same
   places. Logic and mesh live together because they are the same object seen twice; the
   scene half no-ops if THREE is absent, which is what lets the pure parts be tested.  */
import { scene, disposeGroup } from '../core/render.js';
import { NEON } from './tuning.js';
import { trackFrame, deckY } from './track.js';

/* One cell every NEON.cellEveryM, placed where the track is straight enough to reach for
   it, and set left/right/centre in a fixed rotation so a lap is never a straight line. */
function placeCells(T){
  const cells = [];
  const n = Math.max(1, Math.round(T.L/NEON.cellEveryM));
  const step = T.L/n;
  for(let i = 0; i < n; i++){
    // nudge off the exact multiple so a cell never lands on the start line itself
    let s = (i + 0.5)*step;
    let best = s, bestK = Infinity;
    for(let o = -step*0.3; o <= step*0.3; o += Math.max(2, step*0.1)){
      const f = trackFrame(T, s + o, {});
      const k = Math.abs(f.k);
      if(k < bestK){ bestK = k; best = s + o; }
    }
    const f = trackFrame(T, best, {});
    const lim = f.halfW - (T.bodyWide || NEON.bodyWide);
    const lane = [0, 1, -1, 0, -1, 1][i % 6];
    cells.push({s: T.closed ? ((best % T.L) + T.L) % T.L : Math.min(T.L - 5, Math.max(5, best)),
                d: lane*lim*0.62, live: true, backT: 0, i});
  }
  return cells;
}

/* Anyone passing through a live cell takes it. Returns the cells taken this step, so the
   caller can make a noise about the ones the player got. */
function stepCells(cells, racers, T, dt){
  const took = [];
  for(const c of cells){
    if(!c.live){
      c.backT -= dt;
      if(c.backT <= 0) c.live = true;
      continue;
    }
    for(const r of racers){
      if(r.done || r.isGhost) continue;
      let gap = r.s - c.s;
      if(T.closed){ gap = ((gap % T.L) + T.L) % T.L; if(gap > T.L/2) gap -= T.L; }
      // the window has to cover a whole frame of travel or a fast board steps over it
      if(Math.abs(gap) > Math.max(2.5, r.v*dt*1.2)) continue;
      if(Math.abs(r.d - c.d) > NEON.cellGrab + (T.bodyWide || NEON.bodyWide)*0.5) continue;
      if(r.fuel >= NEON.fuelMax) continue;         // a full rack leaves it for someone else
      r.fuel++;
      r.cells = (r.cells || 0) + 1;
      c.live = false; c.backT = NEON.cellBackS;
      took.push({cell: c, racer: r});
      break;
    }
  }
  return took;
}

/* ---- the visible half ---- */
let cellGroup = null, cellMeshes = [];

function buildCellMeshes(T, cells, baseM, color){
  clearCells();
  if(typeof THREE === 'undefined') return null;
  cellGroup = new THREE.Group(); cellGroup.name = 'neonCells';
  const K = 1/(T.widthK || 1);
  /* A PICKUP LOOKS LIKE WHAT IT GIVES YOU: the same nitro tank that sits on the HUD rack.
     A capsule body with a band, a valve on top and a glowing gauge window down its side,
     inside a halo ring that is what you actually spot from 200 m. */
  const bodyGeo = new THREE.CylinderGeometry(0.28*K, 0.28*K, 0.9*K, 14);
  const capGeo  = new THREE.SphereGeometry(0.28*K, 14, 8);
  const bandGeo = new THREE.CylinderGeometry(0.31*K, 0.31*K, 0.12*K, 14);
  const neckGeo = new THREE.CylinderGeometry(0.09*K, 0.11*K, 0.22*K, 8);
  const valveGeo = new THREE.BoxGeometry(0.34*K, 0.08*K, 0.08*K);
  const gaugeGeo = new THREE.BoxGeometry(0.06*K, 0.5*K, 0.14*K);
  const haloGeo = new THREE.TorusGeometry(1.25*K, 0.11*K, 6, 16);
  const mat = new THREE.MeshBasicMaterial({color, transparent:true, opacity:0.95,
    blending: THREE.AdditiveBlending, depthWrite:false});
  const softMat = new THREE.MeshBasicMaterial({color, transparent:true, opacity:0.38,
    blending: THREE.AdditiveBlending, depthWrite:false});
  const gaugeMat = new THREE.MeshBasicMaterial({color: 0x19f0ff, transparent:true, opacity:0.8,
    blending: THREE.AdditiveBlending, depthWrite:false});
  for(const c of cells){
    const f = trackFrame(T, c.s, {});
    const g = new THREE.Group();
    const core = new THREE.Group();
    const body = new THREE.Mesh(bodyGeo, mat);
    const top = new THREE.Mesh(capGeo, mat); top.position.y = 0.45*K; top.scale.y = 0.6;
    const bot = new THREE.Mesh(capGeo, mat); bot.position.y = -0.45*K; bot.scale.y = 0.6;
    const band = new THREE.Mesh(bandGeo, mat); band.position.y = 0.18*K;
    const neck = new THREE.Mesh(neckGeo, mat); neck.position.y = 0.7*K;
    const valve = new THREE.Mesh(valveGeo, mat); valve.position.y = 0.82*K;
    const gauge = new THREE.Mesh(gaugeGeo, gaugeMat); gauge.position.set(0.27*K, -0.08*K, 0);
    core.add(body, top, bot, band, neck, valve, gauge);
    const halo = new THREE.Mesh(haloGeo, softMat);
    halo.rotation.x = Math.PI/2;
    g.add(core, halo);
    g.position.set(f.x - Math.sin(f.yaw)*c.d, deckY(T, f.elev, baseM) + 1.25*K, f.z - Math.cos(f.yaw)*c.d);
    g.rotation.y = f.yaw + Math.PI/2;
    g.userData.cell = c;
    g.userData.core = core;
    g.userData.gauge = gauge;
    cellGroup.add(g);
    cellMeshes.push(g);
  }
  /* DRAWN AFTER THE DECK. Every part is additive with depthWrite off, and the deck is a
     0.94-opacity sheet at renderOrder 1 that DOES write depth. At the default renderOrder
     of 0 the pickup went first and the deck was then painted over it: invisible against
     sky at a distance, it simply faded out as you closed in and the deck came to fill the
     pixels behind it. After the deck and the bumpers (4), it sits on top as it should. */
  cellGroup.traverse(o => { o.renderOrder = 7; });
  cellGroup.traverse(o => { o.frustumCulled = false; });
  scene.add(cellGroup);
  return cellGroup;
}
function updateCellMeshes(t){
  for(const g of cellMeshes){
    const c = g.userData.cell;
    g.visible = c.live || c.backT < NEON.cellBackS*0.35;
    if(!g.visible) continue;
    const coming = c.live ? 1 : 1 - c.backT/(NEON.cellBackS*0.35);
    g.scale.setScalar(0.35 + 0.65*coming);
    g.userData.core.rotation.y = t*1.6;
    g.userData.core.rotation.z = Math.sin(t*1.1 + c.i)*0.18;
    g.userData.gauge.scale.set(1, 0.6 + 0.4*Math.abs(Math.sin(t*3 + c.i)), 1);
    g.position.y += Math.sin(t*2 + c.i)*0.004;
  }
}
function clearCells(){
  if(cellGroup){ scene.remove(cellGroup); disposeGroup(cellGroup); }
  cellGroup = null; cellMeshes = [];
}

export { placeCells, stepCells, buildCellMeshes, updateCellMeshes, clearCells };
