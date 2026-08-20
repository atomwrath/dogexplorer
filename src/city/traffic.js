/* Cars: they cruise, brake and honk for a pup in the road, and bump on contact. */
import { M, toon } from '../core/materials.js';
import { scene } from '../core/render.js';
import { lerp, pickR } from '../core/math.js';
import { CARS, LEVEL, STREETS } from './world.js';
import { dogPos } from '../dog/runtime.js';
import { play } from './player-state.js';
import { mode, addLevelTime } from './modes.js';
import { comicBurst } from '../core/fx.js';
import { honkSound, thudSound, yip } from '../core/audio.js';
import { setShake } from '../core/shake.js';
import { toast } from './ui.js';

/* ---------- cars ---------- */
function makeCarMesh(rnd){
  const col = pickR(['#e2564a','#4d8fd1','#f0b429','#7cc860','#b48bff','#ff8f2d','#d9d9d9'], rnd);
  const g = new THREE.Group();
  const body = M(new THREE.BoxGeometry(2.7,0.64,1.3), toon(col)); body.position.y=0.56; g.add(body);
  const cab = M(new THREE.BoxGeometry(1.45,0.52,1.14), toon(col)); cab.position.set(-0.12,1.08,0); g.add(cab);
  const win = M(new THREE.BoxGeometry(1.28,0.36,1.18), toon('#bfe3f2'), false); win.position.set(-0.12,1.08,0); g.add(win);
  for(const [wx,wz] of [[0.9,0.64],[0.9,-0.64],[-0.9,0.64],[-0.9,-0.64]]){
    const w = M(new THREE.CylinderGeometry(0.27,0.27,0.2,10), toon('#2b2b2b'));
    w.rotation.x = Math.PI/2; w.position.set(wx,0.27,wz); g.add(w);
  }
  const h1 = M(new THREE.SphereGeometry(0.09,7,6), new THREE.MeshBasicMaterial({color:'#fff3c0'}), false);
  h1.position.set(1.36,0.56,0.4); g.add(h1);
  const h2 = h1.clone(); h2.position.z = -0.4; g.add(h2);
  return g;
}
function spawnCars(rnd){
  const len = LEVEL.length;
  const per = 1 + Math.floor(len/110);
  for(const sz of STREETS){
    for(const dir of [1, -1]){
      for(let i=0;i<per;i++){
        const g = makeCarMesh(rnd);
        const lane = sz + dir*1.45;              // drive on the right
        const car = {g, lane, dir, x:rnd()*len, base:5.5+rnd()*2.2, speed:0, honkCd:0};
        g.position.set(car.x, 0, lane);
        g.rotation.y = dir>0 ? 0 : Math.PI;
        scene.add(g);
        CARS.push(car);
      }
    }
  }
}
function updateCars(dt){
  const len = LEVEL.length;
  for(const c of CARS){
    c.honkCd = Math.max(0, c.honkCd - dt);
    // brake for a pup in the road ahead
    let want = c.base;
    const onRoad = Math.abs(dogPos.z - c.lane) < 2.3;
    const ahead = (dogPos.x - c.x) * c.dir;
    if(mode==='play' && onRoad && ahead > 0.6 && ahead < 6){
      want = 1.1;
      if(c.honkCd <= 0 && ahead < 5){
        c.honkCd = 2.4;
        honkSound();
        comicBurst('HONK!', c.x, 2.1, c.lane, '#f0b429');
      }
    }
    c.speed = lerp(c.speed || c.base, want, 1-Math.pow(0.05, dt));
    c.x += c.dir * c.speed * dt;
    if(c.x > len + 28) c.x = -28;
    if(c.x < -28) c.x = len + 28;
    c.g.position.set(c.x, Math.abs(Math.sin(c.x*2.7))*0.015, c.lane);
    // contact = BUMP
    if(mode==='play' && play.hurtCd <= 0 && play.jumpY < 1.15
       && Math.abs(dogPos.x - c.x) < 1.7 && Math.abs(dogPos.z - c.lane) < 1.05){
      carBump(c);
    }
  }
}
function carBump(c){
  play.hurtCd = 1.6;
  play.stunT = 0.85;
  play.speedNow = 0;
  if(mode==='play'){
    addLevelTime(3);
    const tp = document.getElementById('hudTime');
    tp.classList.add('pen');
    setTimeout(()=> tp.classList.remove('pen'), 700);
  }
  const away = new THREE.Vector3(dogPos.x - c.x, 0, dogPos.z - c.lane);
  if(away.lengthSq() < 0.001) away.set(0,0,1);
  away.normalize();
  away.z += 0.5 * Math.sign(dogPos.z - c.lane || 1);
  play.kb.addScaledVector(away.normalize(), 16);
  play.vy = Math.max(play.vy, 3.8);
  play.grounded = false;
  setShake(0.6);
  yip(0.8); thudSound(); honkSound();
  comicBurst('BUMP!', dogPos.x, 2.2, dogPos.z, '#e2453f');
  toast('Watch for traffic! +3 seconds');
}

export { makeCarMesh, spawnCars, updateCars, carBump };
