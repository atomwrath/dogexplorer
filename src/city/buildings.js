/* Buildings, the park cell, and the finish-line checker texture. */
import { M, toon } from '../core/materials.js';
import { pickR } from '../core/math.js';
import { envG, boxBlocker, blocker, patch, BUILDINGS, SPOTS } from './world.js';
import { treeGrate, bench, waterTower } from './props.js';

/* ---------- buildings ---------- */
const BLD_COLS = ['#e2564a','#4d8fd1','#f0b429','#7cc860','#b48bff','#ff8f8f','#67c6f2','#e8b45f'];
function building(cx, bz, w, d, h, rnd, faceDir){
  const grp = new THREE.Group();
  const mats = [];
  const col = BLD_COLS[Math.floor(rnd()*BLD_COLS.length)];
  const bm = toon(col); bm.transparent = true; mats.push(bm);
  const b = M(new THREE.BoxGeometry(w, h, d), bm);
  b.position.set(cx, h/2, bz); grp.add(b);
  const trim = toon('#f5ede0'); trim.transparent = true; mats.push(trim);
  const cornice = M(new THREE.BoxGeometry(w+0.24, 0.3, d+0.24), trim);
  cornice.position.set(cx, h-0.15, bz); grp.add(cornice);
  const win = toon('#fff3c0'); win.transparent = true; mats.push(win);
  const rows = Math.min(4, Math.floor((h-2.2)/1.9));
  for(let ry=0; ry<rows; ry++) for(let wx=-w/2+0.9; wx<w/2-0.45; wx+=2.2){
    const wm = M(new THREE.BoxGeometry(0.66, 0.85, 0.06), win, false);
    wm.position.set(cx+wx, 2.3+ry*1.9, bz + faceDir*(d/2+0.04));
    grp.add(wm);
  }
  // door + awning + sign on the street face
  const doorM = toon('#6e4527'); doorM.transparent = true; mats.push(doorM);
  const dx = cx + (rnd()-0.5)*w*0.4;
  const door = M(new THREE.BoxGeometry(1.0, 1.5, 0.08), doorM, false);
  door.position.set(dx, 0.75, bz + faceDir*(d/2+0.05)); grp.add(door);
  const awnM = toon(pickR(['#e2453f','#2e6f4e','#f0b429','#4d8fd1'], rnd)); awnM.transparent = true; mats.push(awnM);
  const awn = M(new THREE.BoxGeometry(1.9, 0.07, 1.0), awnM, false);
  awn.position.set(dx, 1.85, bz + faceDir*(d/2+0.5)); awn.rotation.x = faceDir*0.28; grp.add(awn);
  if(rnd() < 0.5){
    const signM = toon(pickR(BLD_COLS, rnd)); signM.transparent = true; mats.push(signM);
    const sign = M(new THREE.BoxGeometry(1.6, 0.5, 0.1), signM, false);
    sign.position.set(cx - w*0.22, 2.6, bz + faceDir*(d/2+0.08)); grp.add(sign);
  }
  envG.add(grp);
  if(h > 7 && rnd() < 0.35) waterTower(cx + (rnd()-0.5)*w*0.3, bz - faceDir*d*0.16, h);
  boxBlocker(cx, bz, w, d, h);
  BUILDINGS.push({x:cx, z:bz, w, d, h, mats});
  return grp;
}
function parkCell(cx, bz, w, d, rnd){
  patch('#6fb659', w+1.5, d+1.5, cx, bz, 0.011);
  // fountain
  const rim = M(new THREE.CylinderGeometry(1.5,1.6,0.42,16), toon('#b9bfc4')); rim.position.set(cx,0.21,bz); envG.add(rim);
  const wat = M(new THREE.CircleGeometry(1.35,16), toon('#59b4e6'), false); wat.rotation.x=-Math.PI/2; wat.position.set(cx,0.44,bz); envG.add(wat);
  const spout = M(new THREE.ConeGeometry(0.3,0.8,10), toon('#8fd4f5')); spout.position.set(cx,0.85,bz); envG.add(spout);
  blocker(cx,bz,1.75,999);
  for(let i=0;i<3;i++){
    const a = i*2.1 + rnd();
    treeGrate(cx + Math.cos(a)*(w*0.32), bz + Math.sin(a)*(d*0.3), rnd);
    SPOTS.push({x:cx + Math.cos(a)*(w*0.28), z:bz + Math.sin(a)*(d*0.26)});
  }
  bench(cx - w*0.3, bz + d*0.32, 0.3);
  bench(cx + w*0.28, bz - d*0.3, -2.6);
  for(let i=0;i<7;i++){
    const f = M(new THREE.SphereGeometry(0.09,7,6), toon(pickR(['#ff6fa5','#f0b429','#e2453f'], rnd)), false);
    f.position.set(cx + (rnd()*2-1)*w*0.42, 0.14, bz + (rnd()*2-1)*d*0.42);
    envG.add(f);
    const st = M(new THREE.CylinderGeometry(0.02,0.02,0.14,5), toon('#4f9a3f'), false);
    st.position.set(f.position.x, 0.06, f.position.z); envG.add(st);
  }
  SPOTS.push({x:cx - w*0.25, z:bz - d*0.25});
}

/* ---------- checker for the finish ---------- */
const CHECKER_TEX = (()=>{
  const cv = document.createElement('canvas');
  cv.width = 96; cv.height = 24;
  const x = cv.getContext('2d');
  for(let i=0;i<8;i++) for(let j=0;j<2;j++){
    x.fillStyle = (i+j)%2 ? '#1c1310' : '#ffffff';
    x.fillRect(i*12, j*12, 12, 12);
  }
  return new THREE.CanvasTexture(cv);
})();

export { BLD_COLS, building, parkCell, CHECKER_TEX };
