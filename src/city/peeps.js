/* Neighbors walking their dogs. Never scareable — startling them costs points. */
import { M, toon } from '../core/materials.js';
import { scene } from '../core/render.js';
import { lerp, pickR } from '../core/math.js';
import { PEEPS, LEVEL, STREETS, HALF_ST } from './world.js';
import { quadruped } from './animal-models.js';
import { dogPos, STATS } from '../dog/runtime.js';
import { play } from './player-state.js';
import { mode } from './modes.js';
import { comicBurst } from '../core/fx.js';
import { grumbleSound, yipHigh } from '../core/audio.js';
import { toast, updateHud } from './ui.js';

let grumbles = 0;
/* ---------- dog-walkers ---------- */
function makePeep(rnd){
  const g = new THREE.Group();
  const skin = pickR(['#e8b98a','#c98d5f','#8a5a3c','#f0d0ac','#6e4527'], rnd);
  const shirt = pickR(['#e2453f','#4d8fd1','#2e6f4e','#f0b429','#7a4fd1','#ff6fa5','#5b6570'], rnd);
  const pants = pickR(['#33414d','#5b6570','#6e4527','#3d2a20'], rnd);
  const refs = {legs:[], arm:null};
  for(const s of [-1,1]){
    const leg = new THREE.Group();
    leg.position.set(0, 0.78, s*0.13);
    const lc = M(new THREE.CylinderGeometry(0.09,0.1,0.78,8), toon(pants));
    lc.position.y = -0.39; leg.add(lc);
    g.add(leg); refs.legs.push(leg);
  }
  const torso = M(new THREE.CylinderGeometry(0.24,0.3,0.72,10), toon(shirt));
  torso.position.y = 1.15; g.add(torso);
  const head = M(new THREE.SphereGeometry(0.22,12,10), toon(skin));
  head.position.y = 1.75; g.add(head);
  const cap = M(new THREE.SphereGeometry(0.23,12,8,0,Math.PI*2,0,Math.PI/2), toon(pickR(['#e2453f','#33414d','#f0b429','#2e6f4e'], rnd)));
  cap.position.y = 1.78; g.add(cap);
  const arm = new THREE.Group();
  arm.position.set(0, 1.42, 0.3);
  const ac = M(new THREE.CylinderGeometry(0.06,0.07,0.55,7), toon(shirt));
  ac.position.y = -0.27; arm.add(ac);
  arm.rotation.x = -0.5;
  g.add(arm); refs.arm = arm;
  return {g, refs};
}
function makePetDog(rnd){
  const c = pickR(['#c98d4f','#4a3a30','#f4efe6','#8a5a35','#d9d9d9'], rnd);
  const built = quadruped({body:c, belly:'#f2e2c3', len:0.5, r:0.26, legL:0.3, legR:0.055,
    headR:0.22, snoutL:0.55, snoutW:0.8, neckLen:0.08, neckUp:0.7,
    ears:'point', tail:'cat', nose:'#2b211c'});
  const collar = M(new THREE.TorusGeometry(0.14, 0.035, 8, 14), toon(pickR(['#e2453f','#4d8fd1','#f0b429'], rnd)));
  collar.rotation.y = Math.PI/2;
  collar.position.set(0.42, 0.52, 0);
  built.g.add(collar);
  return built;
}
function spawnPeeps(rnd, canalX){
  const len = LEVEL.length;
  const n = 2 + Math.floor(len/26);
  for(let i=0;i<n;i++){
    const street = STREETS[Math.floor(rnd()*3)];
    const side = rnd()<0.5 ? -1 : 1;
    const walkZ = street + side*(HALF_ST + 1.2);
    const person = makePeep(rnd);
    const pet = makePetDog(rnd);
    pet.g.scale.setScalar(0.85);
    const x = 6 + rnd()*(len-12);
    person.g.position.set(x, 0, walkZ);
    pet.g.position.set(x-0.9, 0, walkZ+0.5);
    scene.add(person.g); scene.add(pet.g);
    const leashGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    const leash = new THREE.Line(leashGeo, new THREE.LineBasicMaterial({color:0x3d2a20}));
    scene.add(leash);
    PEEPS.push({
      g:person.g, refs:person.refs, petG:pet.g, petRefs:pet.refs, leash,
      x, z:walkZ, walkZ, dir:rnd()<0.5?1:-1, speed:1.15+rnd()*0.5,
      ph:rnd()*6, pauseT:0, grumbled:false, startleT:0, petPh:rnd()*6, grumbCd:0,
    });
  }
}
function resetGrumbles(){ grumbles = 0; }
function startlePeep(p, why){
  p.startleT = 1.0;
  if(!p.grumbled){
    p.grumbled = true;
    grumbles++;
    updateHud();
  }
  comicBurst(pickR(['HEY!','WOAH!','RUDE!'], Math.random), p.x, 2.5, p.z, '#b48bff');
  comicBurst('YIP!', p.petG.position.x, 1.3, p.petG.position.z, '#67c6f2');
  grumbleSound();
  yipHigh();
  toast(`You startled a neighbor${why? ' — '+why : ''}! 😠`);
}
function updatePeeps(dt, t){
  const len = LEVEL.length;
  for(const p of PEEPS){
    p.startleT = Math.max(0, p.startleT - dt);
    p.grumbCd = Math.max(0, p.grumbCd - dt);
    const startled = p.startleT > 0;
    if(!startled){
      if(p.pauseT > 0) p.pauseT -= dt;
      else {
        p.x += p.dir * p.speed * dt;
        p.ph += dt * 7 * p.speed;
        if(p.x > len - 3 || p.x < 3) p.dir *= -1;
        if(Math.random() < dt*0.06){ p.pauseT = 1 + Math.random()*2; }
      }
    }
    // person pose
    p.g.position.set(p.x, startled ? Math.sin(p.startleT*Math.PI)*0.26 : 0, p.z);
    p.g.rotation.y = p.dir>0 ? 0 : Math.PI;
    const amp = (p.pauseT>0 || startled) ? 0 : 0.45;
    p.refs.legs.forEach((leg, li)=>{
      leg.rotation.z = Math.sin(p.ph + (li? Math.PI:0)) * amp;
    });
    p.refs.arm.rotation.x = startled ? -2.6 : -0.5 + Math.sin(p.ph)*0.1;
    // pet follows on the leash
    const heel = {x:p.x - p.dir*0.95, z:p.z + 0.55};
    const pg = p.petG;
    pg.position.x = lerp(pg.position.x, heel.x, 1-Math.pow(0.006, dt));
    pg.position.z = lerp(pg.position.z, heel.z, 1-Math.pow(0.006, dt));
    const pdx = heel.x - pg.position.x;
    const petMoving = Math.abs(pdx) > 0.05;
    if(petMoving || startled) p.petPh += dt*9;
    p.petRefs.legs && p.petRefs.legs.forEach((leg, li)=>{
      leg.rotation.z = Math.sin(p.petPh + ((li===0||li===3)?0:Math.PI)) * (petMoving?0.5:0.08);
    });
    pg.position.y = startled ? Math.abs(Math.sin(p.startleT*14))*0.12 : 0;
    pg.rotation.y = startled
      ? Math.atan2(pg.position.z - dogPos.z, dogPos.x - pg.position.x)
      : (p.dir>0 ? 0 : Math.PI);
    if(p.petRefs.tailG) p.petRefs.tailG.rotation.x = Math.sin(t*10)*0.3;
    // leash line: hand to collar
    const pts = p.leash.geometry.attributes.position.array;
    pts[0] = p.x; pts[1] = 1.0; pts[2] = p.z + 0.3;
    pts[3] = pg.position.x + Math.cos(pg.rotation.y)*0.35;
    pts[4] = 0.5;
    pts[5] = pg.position.z - Math.sin(pg.rotation.y)*0.35;
    p.leash.geometry.attributes.position.needsUpdate = true;

    // soft-body collision: you can't run through a neighbor
    const d = Math.hypot(dogPos.x - p.x, dogPos.z - p.z);
    if(d < 0.85){
      const nx = (dogPos.x - p.x)/(d||1), nz = (dogPos.z - p.z)/(d||1);
      dogPos.x = p.x + nx*0.85; dogPos.z = p.z + nz*0.85;
      if(mode==='play' && p.grumbCd<=0 && play.speedNow > STATS.walk*0.9){
        p.grumbCd = 3; startlePeep(p, 'nearly bowled them over');
      }
    }
    // barking close by is rude
    if(mode==='play' && play.barkPulse > 0.45 && p.grumbCd<=0){
      const dd = Math.hypot(dogPos.x - p.x, dogPos.z - p.z);
      const pd = Math.hypot(dogPos.x - pg.position.x, dogPos.z - pg.position.z);
      if(Math.min(dd, pd) < 4.6){ p.grumbCd = 3; startlePeep(p, 'that bark was LOUD'); }
    }
  }
}

export { grumbles, resetGrumbles, makePeep, makePetDog, spawnPeeps, startlePeep, updatePeeps };
