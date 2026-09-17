/* Keyboard + touch -> {steer, throttle, brake, boost}. Deliberately NOT core/input.js:
   that module is Pup City's (it imports the city player, modes and pickups), and a board
   has a different vocabulary anyway -- no jump, no bark, no sneak.

   Touch drives with auto-throttle: two thumbs have enough to do steering and boosting,
   and "hold a button the entire race" is not a control, it is a tax. Brake overrides it. */
const neonKeys = new Set();
const neonTouch = {left:false, right:false, brake:false, boost:false};
let neonIsTouch = false;
let steerSmooth = 0;
const neonHandlers = {};

function initNeonInput(handlers){
  Object.assign(neonHandlers, handlers || {});
  window.addEventListener('keydown', e => {
    if(e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight',' '].includes(k)) e.preventDefault();
    if(!neonKeys.has(k)){
      if(k === 'g' && neonHandlers.gravity) neonHandlers.gravity();
      if(k === 'r' && neonHandlers.restart) neonHandlers.restart();
      if(k === 'Escape' && neonHandlers.quit) neonHandlers.quit();
      if(k === 'Enter' && neonHandlers.confirm) neonHandlers.confirm();
    }
    neonKeys.add(k);
  });
  window.addEventListener('keyup', e => {
    neonKeys.delete(e.key.length === 1 ? e.key.toLowerCase() : e.key);
  });
  window.addEventListener('blur', () => { neonKeys.clear(); for(const k in neonTouch) neonTouch[k] = false; });
  const hold = (id, key) => {
    const el = document.getElementById(id);
    if(!el) return;
    const on = e => { e.preventDefault(); neonTouch[key] = true; markTouch(); };
    const off = e => { e.preventDefault(); neonTouch[key] = false; };
    el.addEventListener('pointerdown', on);
    el.addEventListener('pointerup', off);
    el.addEventListener('pointercancel', off);
    el.addEventListener('pointerleave', off);
    el.addEventListener('contextmenu', e => e.preventDefault());
  };
  hold('tLeft', 'left'); hold('tRight', 'right'); hold('tBrake', 'brake'); hold('tBoost', 'boost');
  if(window.matchMedia && window.matchMedia('(pointer: coarse)').matches) markTouch();
}
function markTouch(){
  if(neonIsTouch) return;
  neonIsTouch = true;
  document.body.classList.add('touch');
}
function readNeonInput(dt){
  const K = k => neonKeys.has(k);
  const left  = K('a') || K('ArrowLeft')  || neonTouch.left;
  const right = K('d') || K('ArrowRight') || neonTouch.right;
  const want = (left ? 1 : 0) - (right ? 1 : 0);
  // a key is all-or-nothing; ease it so a tap is a nudge and a hold is full lock
  const rate = want === 0 ? 7 : 4.5;
  steerSmooth += Math.max(-rate*dt, Math.min(rate*dt, want - steerSmooth));
  const brake = (K('s') || K('ArrowDown') || neonTouch.brake) ? 1 : 0;
  const gas = (K('w') || K('ArrowUp') || (neonIsTouch && !brake)) ? 1 : 0;
  return {steer: steerSmooth, throttle: gas, brake, boost: K('Shift') || K(' ') || neonTouch.boost};
}
function resetNeonInput(){ steerSmooth = 0; }

export { initNeonInput, readNeonInput, resetNeonInput, neonKeys, neonTouch };
