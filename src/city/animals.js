/* Animal AI: leashed wandering, obstacle-steering, flee behavior,
   and the stuck watchdog that re-plans when a critter stops making progress. */
import { scene, disposeGroup } from '../core/render.js';
import { lerp } from '../core/math.js';
import { SPECIES } from '../data/species.js';
import { makeAnimalModel, makeAlert, attachWantedStar } from './animal-models.js';
import { LEVEL, ENV, pointBlocked, inWater } from './world.js';
import { dogPos, STATS } from '../dog/runtime.js';
import { play } from './player-state.js';
import { mode } from './modes.js';
import { comicBurst } from '../core/fx.js';
import { thudSound, cheerBlip } from '../core/audio.js';
import { toast, updateHud } from './ui.js';

/* =========================================================
   ANIMAL AI — steered, leash-free of walls, never stuck
   ========================================================= */
const animals = [];
let scaredCount = 0;
function resetScared(){ scaredCount = 0; }
function clearAnimals(){
  while(animals.length){
    const a = animals.pop();
    scene.remove(a.g);
    disposeGroup(a.g);
  }
}
function placeAnimal(key, x, z, rnd){
  const S = SPECIES[key];
  if(!S) return;
  const model = makeAnimalModel(key, rnd);
  model.g.scale.setScalar(S.scale);
  model.g.position.set(x, 0, z);
  const alert = makeAlert();
  alert.position.y = S.scale*1.5 + 0.5;
  model.g.add(alert);
  scene.add(model.g);
  animals.push({
    key, S, g:model.g, refs:model.refs, hopper:!!model.hopper, alert,
    pos:{x, z}, home:{x, z}, yaw:rnd()*6.28, hop:rnd()*6, walkPh:rnd()*6,
    state:'wander', target:{x, z},
    timer:rnd()*2, alertT:0, deadOnce:false, counted:false,
    stuckT:0, lastX:x, lastZ:z,
    rad: 0.5*S.scale,
  });
}
function validSpot(x, z, rad){
  const hzW = ENV.W/2;
  if(x < 2 || x > LEVEL.length - 2 || Math.abs(z) > hzW - 1.2) return false;
  if(pointBlocked(x, z, rad + 0.15)) return false;
  if(inWater(x, z)) return false;
  return true;
}
function leashTarget(a){
  for(let i=0;i<9;i++){
    const ang = Math.random()*Math.PI*2;
    const r = 1 + Math.random()*3.4;
    const x = a.home.x + Math.cos(ang)*r;
    const z = a.home.z + Math.sin(ang)*r;
    if(validSpot(x, z, a.rad)) return {x, z};
  }
  return {x:a.home.x, z:a.home.z};
}
function fleeTarget(a){
  // run away from the dog, out along the nearest open direction
  const away = Math.atan2(a.pos.z - dogPos.z, a.pos.x - dogPos.x);
  for(const off of [0, 0.5, -0.5, 1.0, -1.0]){
    const x = a.pos.x + Math.cos(away+off)*30;
    const z = a.pos.z + Math.sin(away+off)*30;
    return {x, z};   // steering handles the rest
  }
}
/* steer around obstacles instead of grinding into them */
function steeredStep(a, tx, tz, sp, dt){
  const dx = tx - a.pos.x, dz = tz - a.pos.z;
  const dist = Math.hypot(dx, dz) || 0.0001;
  const base = Math.atan2(dz, dx);
  const probe = Math.max(0.7, sp*0.32);
  for(const off of [0, 0.55, -0.55, 1.1, -1.1, 1.7, -1.7, 2.4, -2.4]){
    const ang = base + off;
    const nx = a.pos.x + Math.cos(ang)*probe;
    const nz = a.pos.z + Math.sin(ang)*probe;
    if(!pointBlocked(nx, nz, a.rad) && !inWater(nx, nz)){
      a.pos.x += Math.cos(ang)*sp*dt;
      a.pos.z += Math.sin(ang)*sp*dt;
      a.yaw = Math.atan2(-Math.sin(ang), Math.cos(ang));
      return dist;
    }
  }
  return dist; // fully boxed in: stand still this frame, stuck timer will fire
}
function countScare(a){
  if(a.counted) return;
  a.counted = true;
  scaredCount++;
  if(a.wanted && !LEVEL.wantedGot){
    LEVEL.wantedGot = true;
    comicBurst('GOTCHA!', a.pos.x, a.S.scale*1.6 + 1.2, a.pos.z, '#ffd94a');
    toast(`⭐ WANTED ${a.S.nm} scared off — bonus!`);
    cheerBlip();
  }
  updateHud();
}
function scareAnimal(a){
  if(a.state === 'flee' || a.state === 'dead') return;
  if(a.S.playsDead && !a.deadOnce){
    a.state = 'dead';
    a.deadOnce = true;
    a.timer = 3.5 + Math.random()*2;
    thudSound();
  } else {
    a.state = 'flee';
    a.target = fleeTarget(a);
  }
  countScare(a);
  a.alertT = 0.9;
  a.alert.visible = true;
}
function updateAnimals(dt, t){
  const pulse = play.barkPulse > 0;
  const paceFactor = pulse ? 1 : (play.crouchAmt > 0.5 ? 0.32 : play.speedNow < 0.4 ? 0.5 : play.speedNow < STATS.walk + 0.4 ? 0.72 : 1);
  const hzW = ENV.W/2;
  for(let i=animals.length-1; i>=0; i--){
    const a = animals[i];
    a.alertT = Math.max(0, a.alertT - dt);
    a.alert.visible = a.alertT > 0;
    if(a.star){
      a.star.position.y = a.S.scale*1.6 + 0.9 + Math.sin(t*3.2)*0.12;
      a.star.material.rotation = Math.sin(t*2.2)*0.25;
    }

    const dx0 = a.pos.x - dogPos.x, dz0 = a.pos.z - dogPos.z;
    const distD = Math.hypot(dx0, dz0);
    const radius = STATS.scareRadius * a.S.skit * (pulse ? 1.55 : 1) * paceFactor;
    const power  = STATS.scarePower + (pulse ? 2.2 : 0);

    if(mode==='play' && a.state !== 'flee' && a.state !== 'dead' && distD < radius){
      if(power >= a.S.brav) scareAnimal(a);
      else { a.state = 'stand'; a.yaw = Math.atan2(dz0, -dx0); }
    } else if(a.state === 'stand' && distD > radius*1.25){
      a.state = 'wander';
      a.target = leashTarget(a);
    }

    if(a.state === 'dead'){
      a.g.rotation.z = lerp(a.g.rotation.z, -1.45, 1-Math.pow(0.001, dt));
      a.g.position.set(a.pos.x, 0.1*a.S.scale, a.pos.z);
      a.timer -= dt;
      if(a.timer <= 0 && distD > radius){
        a.g.rotation.z = 0;
        a.state = 'flee';
        a.target = fleeTarget(a);
      }
      continue;
    }
    if(a.state === 'stand'){
      a.g.position.set(a.pos.x, 0, a.pos.z);
      a.g.rotation.y = a.yaw;
      continue;
    }
    if(a.state === 'graze'){ a.state = 'pause'; }   // no grazers downtown
    if(a.refs.headG) a.refs.headG.rotation.z = lerp(a.refs.headG.rotation.z, 0, 1-Math.pow(0.01, dt));

    if(a.state === 'pause'){
      a.timer -= dt;
      if(a.timer <= 0){ a.state = 'wander'; a.target = leashTarget(a); }
    } else {
      const sp = a.S.speed * (a.state==='flee' ? 3.1 : 0.8);
      const dist = steeredStep(a, a.target.x, a.target.z, sp, dt);
      // stuck watchdog: no real progress → new plan
      const moved = Math.hypot(a.pos.x - a.lastX, a.pos.z - a.lastZ);
      a.stuckT = moved < sp*dt*0.25 ? a.stuckT + dt : 0;
      a.lastX = a.pos.x; a.lastZ = a.pos.z;
      if(a.stuckT > 0.8){
        a.stuckT = 0;
        if(a.state === 'flee') a.target = fleeTarget(a);
        else { a.home = {x:a.pos.x, z:a.pos.z}; a.target = leashTarget(a); }
      }
      if(dist < 0.4){
        if(a.state === 'flee'){ scene.remove(a.g); disposeGroup(a.g); animals.splice(i,1); continue; }
        if(Math.random() < 0.6){ a.state = 'pause'; a.timer = 0.9 + Math.random()*2.2; }
        else a.target = leashTarget(a);
      }
      if(a.state==='flee' && (Math.abs(a.pos.z) > hzW + 4 || a.pos.x < -8 || a.pos.x > LEVEL.length + 8)){
        scene.remove(a.g); disposeGroup(a.g); animals.splice(i,1); continue;
      }
    }

    const still = a.state === 'pause';
    if(a.hopper){
      a.hop += dt * (still ? 2 : a.S.speed * (a.state==='flee' ? 9 : 5));
      const h = still ? 0 : Math.abs(Math.sin(a.hop)) * 0.2 * a.S.scale;
      a.g.position.set(a.pos.x, h, a.pos.z);
    } else {
      const rate = a.state==='flee' ? 14 : 6;
      if(!still) a.walkPh += dt * rate;
      const amp = still ? 0 : (a.state==='flee' ? 0.65 : 0.35);
      a.refs.legs && a.refs.legs.forEach((leg, li)=>{
        const off = (li===0||li===3) ? 0 : Math.PI;
        leg.rotation.z = Math.sin(a.walkPh + off) * amp;
      });
      a.g.position.set(a.pos.x, 0, a.pos.z);
    }
    a.g.rotation.y = a.yaw;
    a.g.rotation.z = 0;
    if(a.refs.tailG) a.refs.tailG.rotation.x = Math.sin(t*5 + i)*0.18;
  }
}

export { animals, scaredCount, resetScared, clearAnimals, placeAnimal,
         validSpot, scareAnimal, updateAnimals, attachWantedStar };
