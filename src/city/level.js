/* buildLevel — the seeded downtown generator.
   Same length + seed always produces the same city. */
import { M, toon } from '../core/materials.js';
import { scene, disposeGroup } from '../core/render.js';
import { mulberry32, clamp, pickR } from '../core/math.js';
import { dogPos, dog, dogYaw, setDogYaw } from '../dog/runtime.js';
import {
  envG, setEnvG, resetWorld, LEVEL, ENV, STREETS, HALF_ST, BLOCK,
  WATER, DOCK_TOPS, SPOTS, patch, blocker, pointBlocked, inWater,
} from './world.js';
import {
  lampPost, hydrant, bench, planter, dumpster, trashcan, mailbox, treeGrate,
  cafeSet, newsstand, crateStack, loadingDock, trafficLight, parkedCar, mudPit,
} from './props.js';
import { building, parkCell, CHECKER_TEX } from './buildings.js';
import { animals, placeAnimal, clearAnimals, resetScared, attachWantedStar } from './animals.js';
import { clearActors } from './actors.js';
import { spawnCars } from './traffic.js';
import { spawnPeeps, resetGrumbles } from './peeps.js';
import { spawnPickups } from './pickups.js';
import { updateBadges, updateHud } from './ui.js';
import { rebuildCullGrid } from './visibility.js';

/* =========================================================
   buildLevel
   ========================================================= */
function buildLevel(){
  if(envG){ scene.remove(envG); disposeGroup(envG); }
  clearAnimals(); clearActors();
  resetWorld();
  setEnvG(new THREE.Group());
  scene.add(envG);

  const rnd = mulberry32((LEVEL.seed|0) * 2654435 + LEVEL.length * 97 + 11);
  const len = LEVEL.length, hz = ENV.W/2;
  const cols = Math.round(len / BLOCK);

  scene.background = new THREE.Color(ENV.sky);
  scene.fog = new THREE.Fog(new THREE.Color(ENV.sky).getHex(), ENV.fog[0], ENV.fog[1]);

  // ground + avenues + cross streets
  const g = M(new THREE.PlaneGeometry(len+80, ENV.W + 90), toon(ENV.ground), false, true);
  g.rotation.x = -Math.PI/2; g.position.set(len/2, 0, 0); envG.add(g);
  for(const sz of STREETS){
    patch('#6d747a', len + 16, HALF_ST*2, len/2 - 3, sz, 0.011);
    for(let x=-4; x<len+6; x+=3) patch('#f2e14c', 1.2, 0.2, x, sz, 0.019);
  }
  const canalCol = Math.max(1, Math.min(cols-1, Math.round(cols*(0.42+rnd()*0.2))));
  const canalX = canalCol * BLOCK;
  for(let ci=1; ci<cols; ci++){
    const cxr = ci * BLOCK;
    if(ci === canalCol) continue;
    patch('#6d747a', HALF_ST*2, hz*2, cxr, 0, 0.011);
    for(let z=-hz+1.5; z<hz-1; z+=3) patch('#f2e14c', 0.2, 1.2, cxr, z, 0.019);
    // crosswalks + a traffic light where it meets each avenue
    for(const sz of STREETS){
      for(let i=0;i<5;i++) patch('#e8ecef', 0.55, HALF_ST*2-0.8, cxr - 1.2 + i*0.6, sz, 0.02);
      trafficLight(cxr + HALF_ST + 0.7, sz + HALF_ST + 0.7, rnd()*0.5 - 2);
    }
  }

  // sidewalks flanking every avenue
  for(const sz of STREETS){
    patch('#b9bfc4', len + 16, 2.4, len/2 - 3, sz - (HALF_ST + 1.2), 0.012);
    patch('#b9bfc4', len + 16, 2.4, len/2 - 3, sz + (HALF_ST + 1.2), 0.012);
  }

  // ---- the canal: a cross-street of water, bridged by every avenue ----
  {
    const spans = [[5.5, 11.5], [-11.5, -5.5]];
    for(const [z0, z1] of spans){
      if(z1 - z0 < 1) continue;
      const wm = M(new THREE.BoxGeometry(4.4, 0.12, z1-z0), toon('#3f7fa5'), false, true);
      wm.position.set(canalX, 0.05, (z0+z1)/2); envG.add(wm);
      for(const s of [-1,1]){
        const bank = M(new THREE.BoxGeometry(0.5, 0.3, z1-z0), toon('#8a8f94'));
        bank.position.set(canalX + s*2.45, 0.15, (z0+z1)/2); envG.add(bank);
      }
      const sp = M(new THREE.BoxGeometry(2, 0.02, 0.35), toon('#ffffff'), false);
      sp.position.set(canalX, 0.13, (z0+z1)/2); envG.add(sp);
      WATER.push({x:canalX, w:4.4, z0, z1, deep:true});
    }
    // road decks over the canal
    for(const sz of STREETS){
      const deck = M(new THREE.BoxGeometry(6.2, 0.14, 11), toon('#7d848b'));
      deck.position.set(canalX, 0.07, sz); envG.add(deck);
      for(const s of [-1,1]){
        const rail = M(new THREE.BoxGeometry(6.2, 0.5, 0.14), toon('#5b6570'));
        rail.position.set(canalX, 0.42, sz + s*5.5); envG.add(rail);
      }
    }
  }

  // ---- blocks: buildings + one park ----
  const bands = [
    {z:-8.5, d:3.4, face:1},   {z:8.5, d:3.4, face:-1},    // inner rows (doors face the center avenue)
    {z:-25.2, d:3.4, face:1},  {z:25.2, d:3.4, face:-1},   // outer rows at the map edge
  ];
  const parkPick = {col:1 + Math.floor(rnd()*Math.max(1,(cols-1))), band:Math.floor(rnd()*2)};
  if(parkPick.col === canalCol) parkPick.col = Math.max(1, parkPick.col - 1);
  for(let ci=0; ci<cols; ci++){
    const cx = ci*BLOCK + BLOCK/2;
    if(Math.abs(cx - canalX) < BLOCK*0.35) continue;
    bands.forEach((bd, bi)=>{
      const w = BLOCK - HALF_ST*2 - 2.6;
      patch('#b9bfc4', w + 2.2, bd.d + 2, cx, bd.z, 0.0115);
      if(bi === parkPick.band && ci === parkPick.col){
        parkCell(cx, bd.z, w, bd.d, rnd);
        return;
      }
      const outer = bi >= 2;
      const h = outer ? (bd.z < 0 ? 9 + rnd()*7 : 6 + rnd()*3) : 5 + rnd()*4.5;
      const nB = rnd() < 0.4 ? 2 : 1;
      for(let k=0;k<nB;k++){
        const bw = nB===1 ? w - 1 : w/2 - 1.1;
        const bcx = nB===1 ? cx : cx + (k? 1:-1)*(w/4 + 0.1);
        building(bcx, bd.z, bw, bd.d - 0.4, outer ? h + (rnd()-0.5)*2 : h + (rnd()-0.5)*3, rnd, bd.face);
      }
      // loading docks & crates tucked against some fronts
      if(rnd() < 0.5){
        const side = bd.face;
        const dz = bd.z + side*(bd.d/2 + 1.15);
        rnd() < 0.5 ? loadingDock(cx + (rnd()-0.5)*w*0.5, dz, 2.6, 1.5, 0.6 + rnd()*0.7)
                    : crateStack(cx + (rnd()-0.5)*w*0.5, dz, rnd);
      }
    });
  }
  // tall backdrop skyline to the north
  for(let bx=-6; bx<len+10; bx+=9){
    const h = 12 + rnd()*9, w = 6 + rnd()*2;
    const bm = M(new THREE.BoxGeometry(w, h, 5), toon(pickR(['#7a84a0','#8a93b0','#6b7590','#9aa3bd'], rnd)));
    bm.position.set(bx + rnd()*3, h/2, -(hz + 8 + rnd()*4));
    envG.add(bm);
  }

  // ---- street furniture + parked cars + puddles along each avenue ----
  for(const sz of STREETS){
    let x = 6 + rnd()*5;
    while(x < len - 5){
      if(Math.abs(x - canalX) > 4.5){
        const side = rnd()<0.5 ? -1 : 1;
        const wz = sz + side*(HALF_ST + 1.2);
        const r = rnd();
        r<0.15 ? hydrant(x, wz) : r<0.3 ? trashcan(x, wz) : r<0.44 ? bench(x, wz + side*0.2)
          : r<0.56 ? planter(x, wz) : r<0.66 ? mailbox(x, wz) : r<0.8 ? treeGrate(x, wz, rnd)
          : r<0.9 ? cafeSet(x, wz + side*0.3, rnd) : newsstand(x, wz);
        if(rnd() < 0.4) lampPost(x + 2.2, sz + side*(HALF_ST + 0.5));
      }
      x += 7.5 + rnd()*7;
    }
    // parked cars hug the curbs
    let px = 4 + rnd()*7;
    while(px < len - 4){
      if(Math.abs(px - canalX) > 5.5 && rnd() < 0.6){
        parkedCar(px, sz + (rnd()<0.5?-1:1)*(HALF_ST - 1.15), rnd);
      }
      px += 8.5 + rnd()*7;
    }
    // dumpsters in the cross streets
  }
  for(let ci=1; ci<cols; ci++){
    if(ci === canalCol) continue;
    const cxr = ci*BLOCK;
    if(rnd() < 0.7) dumpster(cxr + (rnd()<0.5?-2.7:2.7), (rnd()<0.5?-1:1)*(6 + rnd()*3), rnd()*3);
  }
  // oil slicks on the roads
  {
    let hx = 12 + rnd()*9;
    while(hx < len - 10){
      if(Math.abs(hx - canalX) > 6){
        mudPit(hx, STREETS[Math.floor(rnd()*3)] + (rnd()*2-1)*1.8, 1.15+rnd()*0.6, rnd);
      }
      hx += 17 + rnd()*13;
    }
  }

  // ---- start & finish on the center avenue ----
  patch('#f5ede0', 0.5, 7, 0.5, 0, 0.024);
  const mat = toon('#e2453f');
  const p1 = M(new THREE.CylinderGeometry(0.16,0.2,3.6,10), mat); p1.position.set(len, 1.8, -3.4); envG.add(p1);
  const p2 = M(new THREE.CylinderGeometry(0.16,0.2,3.6,10), mat); p2.position.set(len, 1.8, 3.4); envG.add(p2);
  const ball1 = M(new THREE.SphereGeometry(0.3,10,8), toon('#f0b429')); ball1.position.set(len, 3.7, -3.4); envG.add(ball1);
  const ball2 = ball1.clone(); ball2.position.z = 3.4; envG.add(ball2);
  const banner = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 7.3),
    new THREE.MeshBasicMaterial({map:CHECKER_TEX, side:THREE.DoubleSide}));
  banner.rotation.x = Math.PI/2; banner.rotation.z = Math.PI/2;
  banner.position.set(len, 3.35, 0); envG.add(banner);
  patch('#ffffff', 0.32, ENV.W, len, 0, 0.023);
  LEVEL.gateZ = 0;

  // ---- wildlife (validated placement near hangout spots) ----
  const N = clamp(Math.round(len/7), 8, 26);
  for(let i=0;i<N;i++){
    let x, z, ok = false;
    for(let tr=0; tr<10 && !ok; tr++){
      if(SPOTS.length && rnd() < 0.6){
        const s = SPOTS[Math.floor(rnd()*SPOTS.length)];
        x = s.x + (rnd()*2-1)*2.4; z = s.z + (rnd()*2-1)*2.4;
      } else {
        x = 8 + rnd()*(len-16);
        z = (rnd()*2-1)*(hz-2);
      }
      ok = !pointBlocked(x, z, 0.7) && !inWater(x, z) && x > 4 && x < len-3 && Math.abs(z) < hz-1.5;
    }
    if(ok) placeAnimal(pickR(ENV.species, rnd), x, z, rnd);
  }
  LEVEL.total = animals.length;

  // the WANTED pest
  if(animals.length){
    const idx = Math.floor(rnd()*animals.length);
    animals[idx].wanted = true;
    attachWantedStar(animals[idx]);
    LEVEL.wantedNm = animals[idx].S.nm;
  }

  // ---- pickups: golden bone (climb for it!) + tennis balls ----
  spawnPickups(rnd);

  // ---- moving cars + dog-walkers ----
  spawnCars(rnd);
  spawnPeeps(rnd, canalX);

  dogPos.set(0, 0, 0); setDogYaw(0);
  if(dog){ dog.position.copy(dogPos); dog.rotation.y = dogYaw; }
  resetScared(); resetGrumbles();
  rebuildCullGrid();
  updateBadges(); updateHud();
}

export { buildLevel };
