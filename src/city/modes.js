/* Lobby / play / results state machine, run start + scoring handoff. */
import { clamp, pick } from '../core/math.js';
import { resize } from '../core/render.js';
import { initAudio } from '../core/audio.js';
import { spawnParticle } from '../core/fx.js';
import { stick, stickBase, stickKnob } from '../core/input.js';
import { LEVEL, ENV } from './world.js';
import { dogPos, dog, dogYaw, setDogYaw, P } from '../dog/runtime.js';
import { play } from './player-state.js';
import { buildLevel } from './level.js';
import { animals, scaredCount } from './animals.js';
import { grumbles } from './peeps.js';
import { carried, setCarried } from './pickups.js';
import { toast, updateBadges, updateHud, fmtTime } from './ui.js';
import { highScores, scoreKey, renderScoreList } from './score.js';
import { cheerSound } from '../core/audio.js';

/* ========================================================= MODES */
let mode = 'lobby';
let levelTime = 0;
function addLevelTime(v){ levelTime += v; }
function setMode(m){
  mode = m;
  document.body.classList.toggle('play', m==='play');
  document.body.classList.toggle('done', m==='done');
  if(m==='play'){
    initAudio();
    levelTime = 0;
    updateBadges();
    updateHud();
  }
  if(m==='lobby'){
    dogPos.set(0, 0, LEVEL.pathZ(0));
    setDogYaw(0);
    play.vy = 0; play.jumpY = 0; play.grounded = true;
    play.kb.set(0,0,0);
    if(dog){ dog.position.copy(dogPos); dog.rotation.y = dogYaw; }
  }
  setTimeout(resize, 380);
}
function startRun(){
  LEVEL.wantedGot = false;
  LEVEL.boneBanked = false;
  buildLevel();          // fresh, deterministic rebuild — every retry is identical
  play.vy = 0; play.jumpY = 0; play.grounded = true;
  play.kb.set(0,0,0);
  play.speedNow = 0;
  play.stunT = 0; play.hurtCd = 0; play.splashCd = 0; play.groundY = 0;
  play.chompT = 0;
  stick.id = null; stick.active = false; stick.mag = 0;
  stickKnob.style.transform = 'translate(0,0)';
  stickBase.classList.remove('on','run');
  if(dog){ dog.rotation.z = 0; dog.rotation.x = 0; }
  setMode('play');
  toast('GO! Scare the strays — mind the neighbors & traffic!');
}
function finishRun(){
  cheerSound();
  const zc = LEVEL.gateZ || 0;
  for(let i=0;i<42;i++){
    spawnParticle(LEVEL.length + (Math.random()-0.5)*2, 2.5+Math.random()*2, zc+(Math.random()-0.5)*6,
      (Math.random()-0.5)*4, 2+Math.random()*4, (Math.random()-0.5)*4,
      0.05+Math.random()*0.05, pick(['#ff6fa5','#67c6f2','#7cc860','#f0b429','#ff8f2d']), 1.4+Math.random());
  }
  // ----- scoring -----
  if(carried && carried.kind === 'bone'){
    carried.banked = true;
    LEVEL.boneBanked = true;
    setCarried(null);
  }
  const par = 17 + LEVEL.length / 4.0;
  const timeScore = clamp(Math.round(500 * par / Math.max(levelTime, 8)), 0, 650);
  const frac = LEVEL.total ? scaredCount / LEVEL.total : 0;
  const scareScore = Math.round(500 * frac);
  const grumbPen = grumbles * 40;
  const bonus = (LEVEL.wantedGot ? 100 : 0) + (LEVEL.boneBanked ? 150 : 0);
  const total = Math.max(0, timeScore + scareScore - grumbPen + bonus);
  const medal = total >= 1050 ? '🥇' : total >= 820 ? '🥈' : total >= 600 ? '🥉' : '🎗';
  document.getElementById('resMedal').textContent = medal;
  document.getElementById('resTime').textContent = `${fmtTime(levelTime)}  (par ${fmtTime(par)})`;
  document.getElementById('resScareLbl').textContent = '🎯 Scared off';
  document.getElementById('resScared').textContent = `${scaredCount} / ${LEVEL.total}`;
  document.getElementById('resGrumb').textContent = grumbles ? `−${grumbPen} (${grumbles})` : 'none 🙌';
  document.getElementById('resBonus').textContent = bonus
    ? `+${bonus} ${LEVEL.wantedGot?'⭐':''}${LEVEL.boneBanked?'🦴':''}` : '—';
  document.getElementById('resTrail').textContent = `🏙 ${LEVEL.length}m · #${LEVEL.seed}`;
  document.getElementById('resScore').textContent = total;
  const key = scoreKey();
  const prev = highScores[key];
  const isNew = !prev || total > prev.score;
  if(isNew){
    highScores[key] = {score:total, time:Math.round(levelTime*10)/10, pup:P.name, medal};
    renderScoreList();
  }
  document.getElementById('resBest').textContent =
    isNew ? '🎉 NEW RECORD!' : `${prev.score} (${prev.pup})`;
  setMode('done');
}
document.getElementById('playBtn').addEventListener('click', startRun);
document.getElementById('backBtn').addEventListener('click', ()=> setMode('lobby'));
document.getElementById('retryBtn').addEventListener('click', startRun);
document.getElementById('newSeedBtn').addEventListener('click', ()=>{
  LEVEL.seed = Math.floor(Math.random()*100000);
  document.getElementById('seedInput').value = LEVEL.seed;
  startRun();
});
document.getElementById('doneBackBtn').addEventListener('click', ()=>{ buildLevel(); setMode('lobby'); });
document.getElementById('panelBtn').addEventListener('click', ()=>{
  document.body.classList.toggle('nopanel');
  document.body.dataset.panelInit = '1';
  setTimeout(resize, 380);
});

export { mode, levelTime, addLevelTime, setMode, startRun, finishRun };
