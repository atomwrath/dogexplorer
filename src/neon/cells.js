/* BOOST CELLS. Free charge lying on the racing line, and the reason the line is worth
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
      r.battery = Math.min(1, r.battery + NEON.cellGive);
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
  const ringGeo = new THREE.TorusGeometry(1.15*K, 0.12*K, 6, 18);
  const coreGeo = new THREE.OctahedronGeometry(0.42*K);
  const mat = new THREE.MeshBasicMaterial({color, transparent:true, opacity:0.95,
    blending: THREE.AdditiveBlending, depthWrite:false});
  const softMat = new THREE.MeshBasicMaterial({color, transparent:true, opacity:0.18,
    blending: THREE.AdditiveBlending, depthWrite:false});
  for(const c of cells){
    const f = trackFrame(T, c.s, {});
    const g = new THREE.Group();
    const ring = new THREE.Mesh(ringGeo, mat);
    const halo = new THREE.Mesh(ringGeo, softMat);
    halo.scale.setScalar(1.7);
    const core = new THREE.Mesh(coreGeo, mat);
    g.add(ring, halo, core);
    g.position.set(f.x - Math.sin(f.yaw)*c.d, deckY(T, f.elev, baseM) + 1.25*K, f.z - Math.cos(f.yaw)*c.d);
    g.rotation.y = f.yaw + Math.PI/2;       // the torus faces down the track
    g.userData.cell = c;
    g.userData.core = core;
    cellGroup.add(g);
    cellMeshes.push(g);
  }
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
    g.userData.core.rotation.y = t*2.2;
    g.userData.core.rotation.x = t*1.4;
    g.position.y += Math.sin(t*2 + c.i)*0.004;
  }
}
function clearCells(){
  if(cellGroup){ scene.remove(cellGroup); disposeGroup(cellGroup); }
  cellGroup = null; cellMeshes = [];
}

export { placeCells, stepCells, buildCellMeshes, updateCellMeshes, clearCells };
