/* Boot + the frame loop. Everything else is a module this file wires together. */
import { renderer, scene, camera, resize } from '../core/render.js';
import { clamp } from '../core/math.js';
import { QUALITY, watchFrame, onQualityChange, setTier } from '../core/quality.js';
import { decayShake } from '../core/shake.js';
import { initAudio } from '../core/audio.js';
import { updateParticles, updateFX, makeStars } from '../core/fx.js';
import { IS_TOUCH } from '../core/input.js';
import { setDog, dogPos } from '../dog/runtime.js';
import { randomPupParams } from '../dog/params.js';
import { LEVEL } from './world.js';
import { buildLevel } from './level.js';
import { updateAnimals } from './animals.js';
import { updateCars } from './traffic.js';
import { updatePeeps } from './peeps.js';
import { updatePickups } from './pickups.js';
import { updatePlayer } from './player.js';
import { updateRing } from './ring.js';
import { updateBuildingFade, updateCulling } from './visibility.js';
import { mode, addLevelTime, levelTime } from './modes.js';
import { play } from './player-state.js';
import { toast, updateHud, fmtTime, renderTrailList, renderPupList } from './ui.js';
import { renderScoreList } from './score.js';
import { registerServiceWorker } from './pwa.js';

const clock = new THREE.Clock();

function animate(){
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;
  watchFrame(dt);

  play.barkPulse = Math.max(0, play.barkPulse - dt);
  decayShake(dt);
  if(mode === 'play'){
    addLevelTime(dt);
    document.getElementById('hudTime').textContent = fmtTime(levelTime);
    document.getElementById('progressFill').style.width = clamp(dogPos.x/LEVEL.length*100, 0, 100) + '%';
  }

  updateParticles(dt);
  updateFX(dt, t);
  updateAnimals(dt, t);
  updateCars(dt);
  updatePeeps(dt, t);
  updatePickups(dt, t);
  updateRing(dt);
  updateBuildingFade(dt);
  updateCulling();
  updatePlayer(dt, t);

  renderer.render(scene, camera);
}

/* ---------- boot ---------- */
buildLevel();
setDog(randomPupParams());
renderPupList();
renderTrailList();
renderScoreList();
makeStars();

/* ---------- device setup ---------- */
if(IS_TOUCH) document.body.classList.add('touch');
function syncMobile(){
  const mob = window.innerWidth <= 760;
  document.body.classList.toggle('mobile', mob);
  if(mob && !document.body.dataset.panelInit){
    document.body.classList.add('nopanel');   // start with the view uncluttered
    document.body.dataset.panelInit = '1';
  }
}
syncMobile();
document.getElementById('panelBackdrop').addEventListener('pointerdown', e=>{
  e.preventDefault();
  document.body.classList.add('nopanel');
  setTimeout(resize, 380);
});
window.addEventListener('orientationchange', ()=>{ setTimeout(()=>{ syncMobile(); resize(); }, 260); });
window.addEventListener('resize', syncMobile);
if(window.visualViewport) window.visualViewport.addEventListener('resize', ()=> setTimeout(resize, 60));
// iOS won't start audio until a real gesture
['pointerdown','touchstart','keydown'].forEach(ev=>
  window.addEventListener(ev, ()=> initAudio(), {once:true, passive:true}));
// block pinch-zoom & double-tap zoom on the play surface
document.addEventListener('gesturestart', e=> e.preventDefault());
let lastTapT = 0, lastTapX = 0, lastTapY = 0;
document.addEventListener('touchend', e=>{
  const now = Date.now();
  const t = e.changedTouches && e.changedTouches[0];
  const x = t ? t.clientX : 0, y = t ? t.clientY : 0;
  if(now - lastTapT < 320 && Math.hypot(x - lastTapX, y - lastTapY) < 34) e.preventDefault();
  lastTapT = now; lastTapX = x; lastTapY = y;
}, {passive:false});

onQualityChange(()=> resize());
registerServiceWorker();
resize();
animate();
toast('Tune your block, pick a pup, hit Run 🌆');
