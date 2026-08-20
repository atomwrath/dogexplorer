/* Device quality tiers.
   Picked once at boot from the hardware, then nudged down automatically if the
   frame budget slips. Every renderer/scene decision reads from QUALITY, so
   tuning performance means editing this file and nothing else. */

const TIERS = {
  low:    { dpr: 1.0, shadows: false, shadowSize: 1024, fog: [40, 100], cullDist: 52, maxParticles: 40, windowRows: 2 },
  medium: { dpr: 1.5, shadows: true,  shadowSize: 1024, fog: [52, 130], cullDist: 68, maxParticles: 90, windowRows: 3 },
  high:   { dpr: 2.0, shadows: true,  shadowSize: 2048, fog: [58, 150], cullDist: 95, maxParticles: 160, windowRows: 4 },
};

function detectTier(){
  const saved = localStorage.getItem('pupQuality');
  if(saved && TIERS[saved]) return saved;
  const mem = navigator.deviceMemory || 4;
  const cores = navigator.hardwareConcurrency || 4;
  const coarse = matchMedia('(pointer: coarse)').matches;
  const smallish = Math.min(screen.width, screen.height) <= 480;
  if(mem <= 2 || cores <= 2 || (coarse && smallish)) return 'low';
  if(coarse || mem <= 4 || cores <= 4) return 'medium';
  return 'high';
}

let tierName = detectTier();
const QUALITY = Object.assign({ tier: tierName }, TIERS[tierName]);

const qListeners = [];
function onQualityChange(fn){ qListeners.push(fn); }

function setTier(name, remember = true){
  if(!TIERS[name] || name === QUALITY.tier) return;
  Object.assign(QUALITY, TIERS[name], { tier: name });
  if(remember){ try{ localStorage.setItem('pupQuality', name); }catch(e){} }
  for(const fn of qListeners) fn(QUALITY);
}

/* Watchdog: if we spend ~1.5s below ~40fps, drop a tier. Only ever steps down,
   so it can't oscillate. */
let slowT = 0, autoDropped = false;
function watchFrame(dt){
  if(autoDropped) return;
  slowT = dt > 0.025 ? slowT + dt : Math.max(0, slowT - dt * 0.5);
  if(slowT > 1.5){
    const next = QUALITY.tier === 'high' ? 'medium' : QUALITY.tier === 'medium' ? 'low' : null;
    if(next){ setTier(next, false); autoDropped = true; }
    slowT = 0;
  }
}

export { QUALITY, TIERS, setTier, onQualityChange, watchFrame };
