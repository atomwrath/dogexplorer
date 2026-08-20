/* Street furniture. Every builder is pure: it adds meshes to envG and
   registers its own collision, so the generator just calls them. */
import { M, toon } from '../core/materials.js';
import { pickR } from '../core/math.js';
import { envG, blocker, boxBlocker, platform, patch, HAZARDS, DOCK_TOPS, SPOTS } from './world.js';

/* ---------- street props ---------- */
function lampPost(x, z){
  const pole = M(new THREE.CylinderGeometry(0.09,0.12,4.2,8), toon('#3f4a52'));
  pole.position.set(x,2.1,z); envG.add(pole);
  const lamp = M(new THREE.SphereGeometry(0.24,10,8), new THREE.MeshBasicMaterial({color:'#fff3c0'}), false);
  lamp.position.set(x,4.3,z); envG.add(lamp);
  blocker(x,z,0.32);
}
function hydrant(x, z){
  const b1 = M(new THREE.CylinderGeometry(0.22,0.26,0.62,10), toon('#e2453f')); b1.position.set(x,0.31,z); envG.add(b1);
  const cap = M(new THREE.SphereGeometry(0.2,10,8), toon('#e2453f')); cap.position.set(x,0.66,z); envG.add(cap);
  blocker(x,z,0.4,0.78);
  SPOTS.push({x, z});
}
function bench(x, z, rot=0){
  const g = new THREE.Group();
  const seat = M(new THREE.BoxGeometry(1.9,0.14,0.6), toon('#a06a3c')); seat.position.y=0.55; g.add(seat);
  const back = M(new THREE.BoxGeometry(1.9,0.5,0.1), toon('#a06a3c')); back.position.set(0,0.95,0.26); g.add(back);
  [[-0.75],[0.75]].forEach(([o])=>{ const leg=M(new THREE.BoxGeometry(0.12,0.55,0.5),toon('#3f4a52')); leg.position.set(o,0.27,0); g.add(leg); });
  g.position.set(x,0,z); g.rotation.y = rot; envG.add(g);
  blocker(x,z,1.0,1.05);
}
function planter(x, z){
  const pl = M(new THREE.BoxGeometry(1.5,0.6,0.9), toon('#8a5a35')); pl.position.set(x,0.3,z); envG.add(pl);
  const b = M(new THREE.SphereGeometry(0.55,12,10), toon('#5da84e')); b.scale.y=0.7; b.position.set(x,0.9,z); envG.add(b);
  blocker(x,z,1.0,1.15);
  SPOTS.push({x, z});
}
function dumpster(x, z, rot){
  const b = M(new THREE.BoxGeometry(2,1.2,1.1), toon('#3e7a5e')); b.position.set(x,0.7,z); b.rotation.y = rot; envG.add(b);
  const lid = M(new THREE.BoxGeometry(2.05,0.14,1.15), toon('#2c5c46')); lid.position.set(x,1.34,z); lid.rotation.y = rot; lid.rotation.x = -0.12; envG.add(lid);
  platform(x, z, 2, 1.1, 1.42);
  SPOTS.push({x, z});
}
function trashcan(x, z){
  const c = M(new THREE.CylinderGeometry(0.32,0.27,0.75,10), toon('#6a7178')); c.position.set(x,0.38,z); envG.add(c);
  const lid = M(new THREE.CylinderGeometry(0.35,0.35,0.09,10), toon('#525960')); lid.position.set(x,0.8,z); envG.add(lid);
  blocker(x,z,0.45,0.85);
  SPOTS.push({x, z});
}
function mailbox(x, z){
  const b = M(new THREE.BoxGeometry(0.6,0.7,0.5), toon('#4d8fd1')); b.position.set(x,0.75,z); envG.add(b);
  const topC = M(new THREE.CylinderGeometry(0.25,0.25,0.62,10), toon('#4d8fd1'));
  topC.rotation.x = Math.PI/2; topC.rotation.z = Math.PI/2; topC.position.set(x,1.12,z); envG.add(topC);
  const legs = M(new THREE.BoxGeometry(0.45,0.4,0.35), toon('#33414d')); legs.position.set(x,0.2,z); envG.add(legs);
  blocker(x,z,0.42,1.2);
}
function treeGrate(x, z, rnd){
  patch('#5a615f', 1.6, 1.6, x, z, 0.013);
  const s = 0.85 + rnd()*0.35;
  const trunk = M(new THREE.CylinderGeometry(0.14*s, 0.2*s, 2.2*s, 8), toon('#7a5230'));
  trunk.position.set(x, 1.1*s, z); envG.add(trunk);
  const lm = toon('#4ea94a');
  [[0,2.6,0,1.0],[-0.6,2.2,0.25,0.7],[0.55,2.3,-0.25,0.72]].forEach(([a,b,c2,d])=>{
    const m = M(new THREE.SphereGeometry(d*s,12,10), lm); m.position.set(x+a*s, b*s, z+c2*s); envG.add(m);
  });
  blocker(x, z, 0.4);
}
function cafeSet(x, z, rnd){
  const tbl = M(new THREE.CylinderGeometry(0.55,0.55,0.08,12), toon('#f5ede0')); tbl.position.set(x,0.72,z); envG.add(tbl);
  const leg = M(new THREE.CylinderGeometry(0.06,0.09,0.7,8), toon('#3f4a52')); leg.position.set(x,0.36,z); envG.add(leg);
  const um = M(new THREE.ConeGeometry(1.05,0.55,8), toon(pickR(['#e2453f','#f0b429','#67c6f2'], rnd)));
  um.position.set(x,2.0,z); envG.add(um);
  const pole = M(new THREE.CylinderGeometry(0.04,0.04,1.4,7), toon('#3f4a52')); pole.position.set(x,1.35,z); envG.add(pole);
  for(const a of [0.8, 2.4, 4.2]){
    const st = M(new THREE.CylinderGeometry(0.26,0.26,0.5,9), toon('#a06a3c'));
    st.position.set(x + Math.cos(a)*0.95, 0.25, z + Math.sin(a)*0.95); envG.add(st);
    blocker(st.position.x, st.position.z, 0.32, 0.55);
  }
  blocker(x, z, 0.62, 999);
}
function newsstand(x, z){
  const b = M(new THREE.BoxGeometry(1.7,1.7,1.2), toon('#2e6f4e')); b.position.set(x,0.85,z); envG.add(b);
  const aw = M(new THREE.BoxGeometry(1.9,0.08,0.8), toon('#f0b429')); aw.position.set(x,1.75,z+0.75); aw.rotation.x=0.25; envG.add(aw);
  const mag = M(new THREE.BoxGeometry(1.3,0.7,0.06), toon('#f5ede0')); mag.position.set(x,0.95,z+0.62); envG.add(mag);
  boxBlocker(x,z,1.7,1.2,999);
}
function crateStack(x, z, rnd){
  const n = 1 + Math.floor(rnd()*2);
  let top = 0;
  for(let i=0;i<n;i++){
    const s = 1.15 - i*0.16;
    const c = M(new THREE.BoxGeometry(s, 0.8, s), toon(i%2? '#c08b4e' : '#a9763e'));
    c.position.set(x + (rnd()-0.5)*0.2, 0.4 + i*0.8, z + (rnd()-0.5)*0.2);
    c.rotation.y = (rnd()-0.5)*0.4;
    envG.add(c);
    top = 0.8 + i*0.8;
  }
  platform(x, z, 1.15, 1.15, top);
  DOCK_TOPS.push({x, z, top});
}
function loadingDock(x, z, w, d, top){
  const b = M(new THREE.BoxGeometry(w, top, d), toon('#9aa0a6'));
  b.position.set(x, top/2, z); envG.add(b);
  const lip = M(new THREE.BoxGeometry(w*1.03, 0.12, d*1.03), toon('#c4cace'));
  lip.position.set(x, top, z); envG.add(lip);
  platform(x, z, w, d, top);
  DOCK_TOPS.push({x, z, top});
}
function trafficLight(x, z, rot){
  const pole = M(new THREE.CylinderGeometry(0.08,0.1,3.4,8), toon('#33414d'));
  pole.position.set(x,1.7,z); envG.add(pole);
  const box = M(new THREE.BoxGeometry(0.34,0.9,0.3), toon('#2b333a'));
  box.position.set(x,3.2,z); box.rotation.y = rot; envG.add(box);
  ['#e2453f','#f0b429','#7cc860'].forEach((c,i)=>{
    const l = M(new THREE.CircleGeometry(0.09,10), new THREE.MeshBasicMaterial({color:c}), false);
    l.position.set(x + Math.sin(rot)*0.16, 3.5 - i*0.26, z + Math.cos(rot)*0.16);
    l.rotation.y = rot;
    envG.add(l);
  });
  blocker(x,z,0.3);
}
function parkedCar(x, z, rnd, along=true){
  const col = pickR(['#e2564a','#4d8fd1','#f0b429','#7cc860','#b48bff','#d9d9d9','#5b6570'], rnd);
  const g = new THREE.Group();
  const body = M(new THREE.BoxGeometry(2.6,0.62,1.25), toon(col)); body.position.y=0.55; g.add(body);
  const cab = M(new THREE.BoxGeometry(1.4,0.5,1.1), toon(col)); cab.position.set(-0.15,1.06,0); g.add(cab);
  const win = M(new THREE.BoxGeometry(1.2,0.34,1.14), toon('#bfe3f2'), false); win.position.set(-0.15,1.06,0); g.add(win);
  for(const [wx,wz] of [[0.85,0.62],[0.85,-0.62],[-0.85,0.62],[-0.85,-0.62]]){
    const w = M(new THREE.CylinderGeometry(0.26,0.26,0.2,10), toon('#2b2b2b'));
    w.rotation.x = Math.PI/2; w.position.set(wx,0.26,wz); g.add(w);
  }
  g.position.set(x,0,z);
  if(!along) g.rotation.y = Math.PI/2;
  envG.add(g);
  along ? boxBlocker(x, z, 2.7, 1.35, 1.36) : boxBlocker(x, z, 1.35, 2.7, 1.36);
}
function waterTower(bx, bz, h){
  const g = new THREE.Group();
  const tank = M(new THREE.CylinderGeometry(0.85,0.95,1.4,10), toon('#8a5a35')); tank.position.y = 1.3; g.add(tank);
  const capC = M(new THREE.ConeGeometry(1.0,0.7,10), toon('#6e4527')); capC.position.y = 2.35; g.add(capC);
  for(const a of [0.6, 2.2, 3.8, 5.4]){
    const leg = M(new THREE.CylinderGeometry(0.06,0.06,0.9,6), toon('#4a3a30'));
    leg.position.set(Math.cos(a)*0.7, 0.45, Math.sin(a)*0.7); g.add(leg);
  }
  g.position.set(bx, h, bz);
  envG.add(g);
}
function mudPit(x, z, r, rnd){
  const rim = M(new THREE.CircleGeometry(r*1.14, 18), toon('#67c6f2'), false, true);
  rim.rotation.x = -Math.PI/2; rim.position.set(x, 0.013, z); envG.add(rim);
  const c = M(new THREE.CircleGeometry(r, 18), toon('#4a565e'), false, true);
  c.rotation.x = -Math.PI/2; c.position.set(x, 0.015, z); envG.add(c);
  const swirl = M(new THREE.RingGeometry(r*0.3, r*0.42, 14), toon('#6a7d8a'), false, true);
  swirl.rotation.x = -Math.PI/2; swirl.position.set(x - r*0.2, 0.017, z - r*0.15); envG.add(swirl);
  HAZARDS.push({type:'slow', x, z, r});
}

export { lampPost, hydrant, bench, planter, dumpster, trashcan, mailbox, treeGrate,
         cafeSet, newsstand, crateStack, loadingDock, trafficLight, parkedCar,
         waterTower, mudPit };
