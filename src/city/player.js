/* Everything about controlling the pup: jump, bark, water, hazards,
   movement/collision, the gait animation, and the follow camera. */
import { camera, sun, sunTarget } from '../core/render.js';
import { clamp, lerp } from '../core/math.js';
import { dogPos, dog, R, P, STATS, dogYaw, addDogYaw } from '../dog/runtime.js';
import { play, keys } from './player-state.js';
import { mode, addLevelTime, finishRun } from './modes.js';
import { LEVEL, ENV, WATER, HAZARDS, COLLIDERS, supportAt, inWater } from './world.js';
import { spawnParticle, comicBurst } from '../core/fx.js';
import { AC, woofBurst, yip, splashSound, initAudio } from '../core/audio.js';
import { setShake, shakeT } from '../core/shake.js';
import { stick, dragging } from '../core/input.js';
import { toast } from './ui.js';

function tryJump(){
  if(mode!=='play' || !play.grounded || play.stunT > 0) return;
  play.vy = STATS.jumpV;
  play.grounded = false;
  yip(1.4);
}
function bark(){
  if(mode!=='play') return;
  initAudio();
  play.barkT = 0.55;
  play.barkPulse = 0.6;
  if(AC){
    const tN = AC.currentTime;
    const pm = 1/Math.sqrt(P.size);
    woofBurst(tN, pm);
    woofBurst(tN+0.18, pm*0.94);
  }
}

/* ---------- hazards ---------- */
/* ---------- water ---------- */
function splashOut(w){
  play.splashCd = 1.4;
  play.stunT = 0.5;
  play.speedNow = 0;
  if(mode==='play'){
    addLevelTime(2);
    const tp = document.getElementById('hudTime');
    tp.classList.add('pen');
    setTimeout(()=> tp.classList.remove('pen'), 700);
  }
  const dir = Math.sign(dogPos.x - w.x) || -1;
  play.kb.x += dir * 13;
  play.tumble = 0;
  play.vy = Math.max(play.vy, 3.0);
  play.grounded = false;
  setShake(0.4);
  splashSound(); yip(1.2);
  comicBurst('SPLASH!', dogPos.x, (R? R.hipHeight:1) + 1.5, dogPos.z, '#67c6f2');
  for(let i=0;i<16;i++){
    spawnParticle(dogPos.x, 0.2, dogPos.z,
      (Math.random()-0.5)*4, 2+Math.random()*3, (Math.random()-0.5)*4,
      0.05, '#bfe3f2', 0.65);
  }
  toast('Too deep for a little pup! +2 seconds');
}
function updateWater(dt){
  play.waterSlow = 0;
  play.splashCd = Math.max(0, play.splashCd - dt);
  if(!WATER.length) return;
  const onDeck = supportAt(dogPos.x, dogPos.z, play.jumpY) > 0.2;
  if(onDeck || play.jumpY > 0.3) return;
  for(const w of WATER){
    if(Math.abs(dogPos.x - w.x) > w.w/2 + 0.2) continue;
    if(dogPos.z < w.z0 || dogPos.z > w.z1) continue;
    const wader = P.size >= (w.deep ? 1.15 : 0.85);
    if(!wader){
      if(play.splashCd <= 0) splashOut(w);
      return;
    }
    play.waterSlow = w.deep ? 0.42 : 0.6;
    if(play.speedNow > 0.5 && Math.random() < dt*14){
      spawnParticle(dogPos.x, 0.12, dogPos.z,
        (Math.random()-0.5)*1.6, 1+Math.random()*1.6, (Math.random()-0.5)*1.6,
        0.05, '#cfeeff', 0.45);
    }
    return;
  }
}
function updateHazards(dt){
  play.mudSlow = false;
  play.hurtCd = Math.max(0, play.hurtCd - dt);
  for(const hz of HAZARDS){
    const d = Math.hypot(dogPos.x - hz.x, dogPos.z - hz.z);
    if(play.grounded && play.groundY < 0.2 && d < hz.r){
      play.mudSlow = true;
      if(play.speedNow > 1 && Math.random() < dt*9){
        spawnParticle(dogPos.x, 0.1, dogPos.z,
          (Math.random()-0.5)*1.6, 1+Math.random()*1.6, (Math.random()-0.5)*1.6,
          0.05, '#5b6a72', 0.45);
      }
    }
  }
}


/* ---------- per-frame player + camera ---------- */
let blinkT = 2.5;
const camTarget = new THREE.Vector3();
const camPosGoal = new THREE.Vector3();
function updatePlayer(dt, t){
  if(!(dog && R)) return;
    play.stunT = Math.max(0, play.stunT - dt);
    let moveX = 0, moveZ = 0;
    if(mode==='play' && play.stunT <= 0){
      if(keys['w']||keys['arrowup'])    moveZ -= 1;
      if(keys['s']||keys['arrowdown'])  moveZ += 1;
      if(keys['a']||keys['arrowleft'])  moveX -= 1;
      if(keys['d']||keys['arrowright']) moveX += 1;
    }
    const dogRad = 0.7*P.size;
    play.groundY = supportAt(dogPos.x, dogPos.z, play.jumpY);
    updateHazards(dt);
    updateWater(dt);
    const crouching = mode==='play' && play.stunT <= 0 && (keys['c'] || keys['control'] || play.sneakToggle);
    play.crouchAmt = lerp(play.crouchAmt, crouching ? 1 : 0, 1-Math.pow(0.0005, dt));
    // thumbstick overrides the keys: push a little to pad softly, push far to sprint
    const analog = mode==='play' && play.stunT <= 0 && stick.active && stick.mag > 0.14;
    if(analog){ moveX = stick.dx; moveZ = stick.dz; }
    const moving = analog || (moveX||moveZ);
    const running = moving && !crouching && (analog
      ? stick.mag > 0.78
      : (keys['shift'] || play.runToggle));
    let targetSpeed;
    if(!moving) targetSpeed = 0;
    else if(crouching) targetSpeed = STATS.walk * 0.8 * (analog ? clamp(stick.mag,0.35,1) : 1);
    else if(analog) targetSpeed = stick.mag <= 0.6
      ? STATS.walk * (0.35 + 0.65*(stick.mag/0.6))
      : lerp(STATS.walk, STATS.run, (stick.mag - 0.6)/0.4);
    else targetSpeed = running ? STATS.run : STATS.walk;
    if(play.mudSlow) targetSpeed *= 0.45;
    if(play.waterSlow) targetSpeed *= play.waterSlow;
    if(play.stunT > 0) targetSpeed = 0;
    play.speedNow += clamp(targetSpeed - play.speedNow, -STATS.accel*dt, STATS.accel*dt);

    if(moving){
      const len = Math.hypot(moveX, moveZ);
      const dx = moveX/len, dz = moveZ/len;
      dogPos.x += dx*play.speedNow*dt;
      dogPos.z += dz*play.speedNow*dt;
      const targetYaw = Math.atan2(-dz, dx);
      let dy = targetYaw - dogYaw;
      while(dy > Math.PI) dy -= Math.PI*2;
      while(dy < -Math.PI) dy += Math.PI*2;
      addDogYaw(clamp(dy, -STATS.turn*dt, STATS.turn*dt));
    }
    dogPos.addScaledVector(play.kb, dt);
    play.kb.multiplyScalar(Math.pow(0.015, dt));

    if(ENV){
      dogPos.x = clamp(dogPos.x, -3, LEVEL.length + 4);
      dogPos.z = clamp(dogPos.z, -ENV.W/2, ENV.W/2);
    }
    for(const c of COLLIDERS){
      if(play.jumpY > c.h - 0.05) continue;   // sailing over — or standing on top
      if(c.rect){
        const ex = c.w/2 + dogRad, ez = c.d/2 + dogRad;
        const ox = dogPos.x - c.x, oz = dogPos.z - c.z;
        if(Math.abs(ox) < ex && Math.abs(oz) < ez){
          if(ex - Math.abs(ox) < ez - Math.abs(oz)) dogPos.x = c.x + Math.sign(ox||1)*ex;
          else dogPos.z = c.z + Math.sign(oz||1)*ez;
        }
        continue;
      }
      const ox = dogPos.x - c.x, oz = dogPos.z - c.z;
      const od = Math.hypot(ox, oz), min = c.r + dogRad;
      if(od < min && od > 0.001){
        dogPos.x = c.x + ox/od*min;
        dogPos.z = c.z + oz/od*min;
      }
    }
    // re-read the surface after being pushed around
    play.groundY = supportAt(dogPos.x, dogPos.z, play.jumpY);

    if(mode==='play' && dogPos.x >= LEVEL.length) finishRun();

    if(!play.grounded){
      play.vy -= 22 * dt;
      play.jumpY += play.vy * dt;
      if(play.vy <= 0 && play.jumpY <= play.groundY){
        const drop = play.groundY;
        play.jumpY = drop; play.grounded = true;
        play.squash = 0.28;
        if(play.stunT > 0) comicBurst('THUD!', dogPos.x, drop + (R? R.hipHeight:1) + 1.2, dogPos.z, '#b48bff');
        for(let i=0;i<5;i++){
          spawnParticle(dogPos.x + (Math.random()-0.5)*0.6, drop + 0.08, dogPos.z + (Math.random()-0.5)*0.6,
            (Math.random()-0.5)*1.6, 0.5+Math.random(), (Math.random()-0.5)*1.6,
            0.04, '#cbb89b', 0.4);
        }
      }
    } else if(play.jumpY < play.groundY - 0.02){
      play.jumpY = play.groundY;          // step up onto a ledge
    } else if(play.jumpY > play.groundY + 0.06){
      play.grounded = false;              // ran off an edge
      play.vy = 0;
    }
    play.squash = Math.max(0, play.squash - dt*1.6);

    const cA = play.crouchAmt;
    const sneakStep = cA > 0.35 && moving && play.grounded && play.speedNow > 0.25;
    const gaitRate = (running ? 15 : 9.5) * (1 - 0.32*cA);
    if(play.speedNow > 0.2){
      const inc = gaitRate * (0.5 + play.speedNow/6);
      play.phase += dt * (sneakStep ? Math.max(inc, 7.5) : inc);
    }
    let amp = play.grounded ? clamp(play.speedNow/6.5, 0, 1) * (running ? 0.85 : 0.55) * (1 - 0.4*cA) : 0;
    if(sneakStep) amp = Math.max(amp, 0.5);
    R.legs.forEach((leg,i)=>{
      const off = (i===0||i===3)? 0 : Math.PI;
      const target = play.grounded
        ? Math.sin(play.phase + off) * amp
        : (i<2? -0.7 : 0.75);
      leg.rotation.z = lerp(leg.rotation.z, target, 1-Math.pow(0.0001, dt));
    });

    const bob = play.grounded ? Math.abs(Math.sin(play.phase)) * amp * 0.14 : 0;
    const breathe = Math.sin(t*2.2) * 0.012;
    R.bodyG.position.y = R.bodyBaseY * (1 - 0.3*cA) + bob * (1 - 0.5*cA);
    const sq = play.squash;
    const airStretch = !play.grounded ? clamp(Math.abs(play.vy)*0.02, 0, 0.12) : 0;
    R.bodyG.scale.set(
      (1 + sq*0.5 - airStretch*0.5) * (1 + 0.07*cA),
      (1 - sq*0.6 + breathe + airStretch) * (1 - 0.28*cA),
      (1 + sq*0.5 - airStretch*0.5) * (1 + 0.07*cA));

    const wagRate = (moving || play.barkT>0)? 14 : 3.2;
    const wagAmp  = (moving || play.barkT>0)? 0.55 : 0.22;
    R.tail.rotation.x = Math.sin(t*wagRate) * wagAmp;

    const floppy = (R.earStyle==='floppy' || R.earStyle==='long');
    R.ears.forEach((e,i)=>{
      const ud = e.userData;
      const sway = Math.sin(t*wagRate*0.7 + i*2.1) * (moving? 0.12 : 0.04);
      if(floppy){
        const lift = (moving? 0.18*clamp(play.speedNow/6,0,1) : 0) + (!play.grounded? 0.3 : 0);
        e.rotation.x = lerp(e.rotation.x, ud.baseX - ud.sd*(lift + Math.abs(sway)*0.5), 1-Math.pow(0.002, dt));
        e.rotation.y = sway;
      } else {
        e.rotation.x = ud.baseX + sway*0.4;
        e.rotation.y = sway*0.5;
      }
    });

    let headRZ = -0.14*cA;
    if(!play.grounded) headRZ = 0.18;
    if(play.barkT>0)   headRZ = -0.22;
    R.head.rotation.z = lerp(R.head.rotation.z, headRZ, 1-Math.pow(0.001, dt));

    if(play.barkT > 0){
      play.barkT -= dt;
      const open = Math.max(0, Math.sin((0.55-play.barkT)/0.55 * Math.PI));
      R.jaw.rotation.z = open * 0.5;
      R.tongue.visible = true;
      R.tongue.rotation.z = R.tongueBaseRot - open*0.3 + Math.sin(t*40)*0.06*open;
      R.bubble.visible = true;
      const pop = clamp((0.55-play.barkT)*8, 0, 1);
      const bs = pop / Math.max(P.size, 0.6);
      R.bubble.scale.set(2.2*bs, 1.4*bs, 1);
    } else {
      R.jaw.rotation.z = lerp(R.jaw.rotation.z, 0, 1-Math.pow(0.001, dt));
      R.tongue.visible = R.tongueDefault;
      R.tongue.rotation.z = lerp(R.tongue.rotation.z, R.tongueBaseRot, 1-Math.pow(0.001, dt));
      R.bubble.visible = false;
    }
    if(play.chompT > 0){
      play.chompT -= dt;
      R.jaw.rotation.z = Math.max(R.jaw.rotation.z, 0.75 * Math.sin(clamp(play.chompT/0.32, 0, 1) * Math.PI));
    }

    blinkT -= dt;
    if(blinkT < 0) blinkT = 2 + Math.random()*3.5;
    const blinking = blinkT < 0.12;
    R.pupils.forEach(pp=> pp.scale.y = blinking? 0.12 : 1);

    if(mode==='lobby' && !dragging) addDogYaw(dt*0.12);

    if(play.stunT > 0){
      play.tumble += dt * 9;
      dog.rotation.z = Math.sin(play.tumble) * 0.5;
      dog.rotation.x = Math.sin(play.tumble*0.7) * 0.22;
    } else if(dog.rotation.z || dog.rotation.x){
      dog.rotation.z = lerp(dog.rotation.z, 0, 1-Math.pow(0.001, dt));
      dog.rotation.x = lerp(dog.rotation.x, 0, 1-Math.pow(0.001, dt));
    }
    dog.position.set(dogPos.x, play.jumpY + (sneakStep ? Math.abs(Math.sin(play.phase))*0.045 : 0), dogPos.z);
    dog.rotation.y = dogYaw;

    // keep the shadow camera near the action
    sun.position.set(dogPos.x + 12, 22, dogPos.z + 8);
    sunTarget.position.set(dogPos.x, 0, dogPos.z);

    const focusY = R.hipHeight + 0.4;
    if(mode==='lobby'){
      camPosGoal.set(dogPos.x + 4.6*Math.max(1,P.size*0.9), 2.6 + 1.6*P.size, dogPos.z + 7.4*Math.max(1,P.size*0.9));
      camTarget.set(dogPos.x, focusY*0.85, dogPos.z);
    } else {
      camPosGoal.set(dogPos.x + 1.2, 7.6 + play.jumpY*0.6, dogPos.z + 11.5);
      camTarget.set(dogPos.x + 1.2, play.jumpY*0.7 + 1.0, dogPos.z);
    }
    camera.position.lerp(camPosGoal, 1-Math.pow(0.002, dt));
    if(shakeT > 0){
      camera.position.x += (Math.random()-0.5)*shakeT*0.5;
      camera.position.y += (Math.random()-0.5)*shakeT*0.5;
    }
    camera.lookAt(camTarget);
}

export { tryJump, bark, splashOut, updateWater, updateHazards, updatePlayer };
