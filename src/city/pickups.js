/* Carryables and the CHOMP action. */
import { M, toon } from '../core/materials.js';
import { scene } from '../core/render.js';
import { PICKUPS, DOCK_TOPS, LEVEL, STREETS, HALF_ST, supportAt, pointBlocked, inWater } from './world.js';
import { dogPos, dogYaw, P, R } from '../dog/runtime.js';
import { play } from './player-state.js';
import { mode } from './modes.js';
import { comicBurst } from '../core/fx.js';
import { chompSound } from '../core/audio.js';
import { toast, updateHud } from './ui.js';

let carried = null;
function setCarried(v){ carried = v; }
function makeBoneMesh(){
  const g = new THREE.Group();
  const gold = toon('#f0c040');
  const bar = M(new THREE.CylinderGeometry(0.08,0.08,0.55,8), gold);
  bar.rotation.z = Math.PI/2; g.add(bar);
  for(const s of [-1,1]) for(const o of [-0.09, 0.09]){
    const k = M(new THREE.SphereGeometry(0.11,9,7), gold);
    k.position.set(s*0.3, o, 0); g.add(k);
  }
  return g;
}
function makeBallMesh(){
  const g = new THREE.Group();
  const b = M(new THREE.SphereGeometry(0.16,12,10), toon('#c8e64c'));
  g.add(b);
  const seam = M(new THREE.TorusGeometry(0.16, 0.015, 6, 16), toon('#f5ede0'));
  seam.rotation.x = 1.1; g.add(seam);
  return g;
}
function spawnPickups(rnd){
  // golden bone: up on something, if there's anything to climb
  let bx, bz, by = 0;
  if(DOCK_TOPS.length){
    const d = DOCK_TOPS[Math.floor(rnd()*DOCK_TOPS.length)];
    bx = d.x; bz = d.z; by = d.top;
  } else {
    bx = LEVEL.length*(0.3+rnd()*0.4); bz = (rnd()<0.5?-1:1)*8.5;
  }
  const bone = makeBoneMesh();
  bone.position.set(bx, by + 0.25, bz);
  scene.add(bone);
  PICKUPS.push({kind:'bone', nm:'golden bone', g:bone, x:bx, z:bz, baseY:by + 0.25, held:false, banked:false});
  // tennis balls, just for the joy of it
  for(let i=0;i<4;i++){
    let x, z, ok=false;
    for(let tr=0;tr<8 && !ok;tr++){
      x = 6 + rnd()*(LEVEL.length-12);
      z = (rnd()<0.5?-1:1)*(HALF_ST + 1.2) + STREETS[Math.floor(rnd()*3)];
      ok = !pointBlocked(x, z, 0.4) && !inWater(x, z);
    }
    if(!ok) continue;
    const ball = makeBallMesh();
    ball.position.set(x, 0.16, z);
    scene.add(ball);
    PICKUPS.push({kind:'ball', nm:'tennis ball', g:ball, x, z, baseY:0.16, held:false});
  }
}
function chomp(){
  if(mode!=='play' || play.stunT > 0) return;
  play.chompT = 0.32;
  chompSound();
  if(carried){
    // drop it just ahead
    const fx = Math.cos(dogYaw), fz = -Math.sin(dogYaw);
    carried.x = dogPos.x + fx*0.8;
    carried.z = dogPos.z + fz*0.8;
    carried.baseY = supportAt(carried.x, carried.z, play.jumpY) + (carried.kind==='ball'? 0.16 : 0.25);
    carried.g.position.set(carried.x, carried.baseY, carried.z);
    carried.held = false;
    toast(`Dropped the ${carried.nm}.`);
    setCarried(null);
    updateHud();
    return;
  }
  let best = null, bd = 1.35 + 0.4*P.size;
  for(const it of PICKUPS){
    if(it.held || it.banked) continue;
    const d = Math.hypot(dogPos.x - it.x, dogPos.z - it.z);
    const dy = Math.abs((it.baseY - 0.2) - play.jumpY);
    if(d < bd && dy < 1.1){ bd = d; best = it; }
  }
  if(best){
    best.held = true;
    setCarried(best);
    comicBurst('CHOMP!', dogPos.x, (R? R.hipHeight:1) + 1.4 + play.jumpY, dogPos.z, '#ff8f2d');
    toast(best.kind==='bone' ? '🦴 Golden bone! Carry it to the finish!' : `Got the ${best.nm}!`);
    updateHud();
  } else {
    comicBurst('CHOMP', dogPos.x, (R? R.hipHeight:1) + 1.3 + play.jumpY, dogPos.z, '#c8b06a');
  }
}
function updatePickups(dt, t){
  for(const it of PICKUPS){
    if(it.banked){ it.g.visible = false; continue; }
    if(it.held && carried === it){
      // ride in the mouth
      const fx = Math.cos(dogYaw), fz = -Math.sin(dogYaw);
      const mz = R ? R.hipHeight + 0.28*P.size : 1;
      it.g.position.set(
        dogPos.x + fx*(0.62*P.size + 0.18),
        play.jumpY + mz - 0.3*play.crouchAmt*(R? R.bodyBaseY:1),
        dogPos.z + fz*(0.62*P.size + 0.18));
      it.g.rotation.y = dogYaw;
      it.x = it.g.position.x; it.z = it.g.position.z;
    } else if(it.kind === 'bone'){
      it.g.position.y = it.baseY + Math.sin(t*2.6)*0.07;
      it.g.rotation.y = t*1.4;
    }
  }
}

export { carried, setCarried, makeBoneMesh, makeBallMesh, spawnPickups, chomp, updatePickups };
