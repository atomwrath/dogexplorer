/* Keyboard + touch -> {steer, throttle, brake, boost}. Deliberately NOT core/input.js:
   that module is Pup City's (it imports the city player, modes and pickups), and a board
   has a different vocabulary anyway -- no jump, no bark, no sneak.

   Touch drives with auto-throttle: two thumbs have enough to do steering and boosting,
   and "hold a button the entire race" is not a control, it is a tax. Brake overrides it. */
const neonKeys = new Set();
const neonTouch = {brake:false, boost:false};
let neonIsTouch = false;
let steerSmooth = 0;
/* Analog touch steering. The steering pad is one control, not two buttons: where the
   thumb lands sets the lock, and SLIDING IT changes the lock without lifting. Tapping the
   far edge is still full lock, so it behaves like a pair of buttons for anyone who
   treats it as one, but a thumb that rolls fifteen degrees into a corner gets fifteen
   degrees of steering instead of everything. */
let touchSteer = 0, steerPointer = null;
const neonHandlers = {};

function initNeonInput(handlers){
  Object.assign(neonHandlers, handlers || {});
  window.addEventListener('keydown', e => {
    if(e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight',' '].includes(k)) e.preventDefault();
    if(!neonKeys.has(k)){
      if(k === 'g' && neonHandlers.gravity) neonHandlers.gravity();
      if(k === 'v' && neonHandlers.reverse) neonHandlers.reverse();
      if(k === 'c' && neonHandlers.camera) neonHandlers.camera();
      if(k === 'p' && neonHandlers.pause) neonHandlers.pause();
      if(k === 'r' && neonHandlers.restart) neonHandlers.restart();
      if(k === 'Escape' && neonHandlers.quit) neonHandlers.quit();
      if(k === 'Enter' && neonHandlers.confirm) neonHandlers.confirm();
    }
    neonKeys.add(k);
  });
  window.addEventListener('keyup', e => {
    neonKeys.delete(e.key.length === 1 ? e.key.toLowerCase() : e.key);
  });
  window.addEventListener('blur', () => {
    neonKeys.clear(); touchSteer = 0; steerPointer = null;
    for(const k in neonTouch) neonTouch[k] = false;
  });
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
  hold('tBrake', 'brake'); hold('tBoost', 'boost');
  bindSteerPad(document.getElementById('tSteer'));
  blockZoomGestures();
  if(window.matchMedia && window.matchMedia('(pointer: coarse)').matches) markTouch();
}

function bindSteerPad(pad){
  if(!pad) return;
  const read = e => {
    const r = pad.getBoundingClientRect();
    const half = r.width/2;
    if(!half) return 0;
    // + is left, matching the steering convention everywhere else
    const x = (e.clientX - (r.left + half))/half;
    return Math.max(-1, Math.min(1, -x));
  };
  pad.addEventListener('pointerdown', e => {
    e.preventDefault(); markTouch();
    steerPointer = e.pointerId;
    /* Capture, or the first fast slide leaves the element and the steering sticks at
       whatever it was when the thumb crossed the edge. */
    if(pad.setPointerCapture) try{ pad.setPointerCapture(e.pointerId); }catch(err){}
    touchSteer = read(e);
  });
  pad.addEventListener('pointermove', e => {
    if(steerPointer !== e.pointerId) return;
    e.preventDefault();
    touchSteer = read(e);
  });
  const up = e => {
    if(steerPointer !== e.pointerId) return;
    e.preventDefault();
    steerPointer = null; touchSteer = 0;
  };
  pad.addEventListener('pointerup', up);
  pad.addEventListener('pointercancel', up);
  pad.addEventListener('lostpointercapture', up);
  pad.addEventListener('contextmenu', e => e.preventDefault());
}

/* THE ZOOM GESTURES touch-action CANNOT REACH. Same fix as Pup Trails, same reason: iOS
   has ignored user-scalable=no since iOS 10, so the double-tap and pinch recognisers stay
   armed however the stylesheet is written, and per-element touch-action only governs
   touches that BEGIN on that element. A tap on the boost button followed by a tap on the
   canvas is two elements' business, resolved at the page level -- and zooms. Scoped to
   the play surface so the menu's buttons keep their synthesised clicks. */
const DOUBLE_TAP_MS = 350;
let lastTouchEndT = -1e9;
function inPlaySurface(node){
  for(let n = node; n; n = n.parentNode){
    if(n.id === 'c' || n.id === 'hud' || n.id === 'touchCtl') return true;
  }
  return false;
}
function blockZoomGestures(){
  window.addEventListener('touchend', e => {
    if(document.body.getAttribute('data-screen') === 'menu') return;
    if(!inPlaySurface(e.target)) return;
    const now = Date.now();
    if(now - lastTouchEndT <= DOUBLE_TAP_MS) e.preventDefault();
    lastTouchEndT = now;
  }, {passive: false});
  // WebKit's own pinch events, which carry the page zoom themselves
  for(const type of ['gesturestart','gesturechange','gestureend']){
    window.addEventListener(type, e => {
      if(document.body.getAttribute('data-screen') !== 'menu') e.preventDefault();
    }, {passive: false});
  }
}

function markTouch(){
  if(neonIsTouch) return;
  neonIsTouch = true;
  document.body.classList.add('touch');
}
function readNeonInput(dt){
  const K = k => neonKeys.has(k);
  const left  = K('a') || K('ArrowLeft');
  const right = K('d') || K('ArrowRight');
  const want = (left ? 1 : 0) - (right ? 1 : 0);
  if(steerPointer !== null){
    /* The pad is already analog, so it only needs enough smoothing to take the stair-step
       out of a dragging thumb. The key easing below must NOT also run here: it pulls
       towards zero every frame, and the two together settle about three quarters of the
       way to full lock -- a pad that can never quite reach the stops. */
    steerSmooth += (touchSteer - steerSmooth)*Math.min(1, dt*18);
  }else{
    // a key is all-or-nothing; ease it so a tap is a nudge and a hold is full lock
    const rate = want === 0 ? 7 : 4.5;
    steerSmooth += Math.max(-rate*dt, Math.min(rate*dt, want - steerSmooth));
  }
  const steer = steerSmooth;
  const brake = (K('s') || K('ArrowDown') || neonTouch.brake) ? 1 : 0;
  const gas = (K('w') || K('ArrowUp') || (neonIsTouch && !brake)) ? 1 : 0;
  return {steer, throttle: gas, brake, boost: K('Shift') || K(' ') || neonTouch.boost};
}
function resetNeonInput(){ steerSmooth = 0; touchSteer = 0; steerPointer = null; }

export { initNeonInput, readNeonInput, resetNeonInput, neonKeys, neonTouch };
