/* Keyboard + touch -> {steer, throttle, brake, boost}. Deliberately NOT core/input.js:
   that module is Pup City's (it imports the city player, modes and pickups), and a board
   has a different vocabulary anyway -- no jump, no bark, no sneak.

   Touch has two independent choices, both live in settings (see main.js applySteerMode):
   steering by a drag pad (analog, see bindSteerPad below) or by a pair of left/right
   buttons (digital, eased exactly like the arrow keys, see bindSteerButtons below); and,
   either way, an explicit gas button -- touch used to throttle automatically the instant
   a finger was down, but that makes a real accel button pointless to add, so it is now
   held like brake and boost are. */
const neonKeys = new Set();
const neonTouch = {brake:false, boost:false, accel:false, steerL:false, steerR:false};
let neonIsTouch = false;
let steerSmooth = 0;
/* Analog touch steering. The steering pad is one control, not two buttons: where the
   thumb lands sets the lock, and SLIDING IT changes the lock without lifting. Tapping the
   far edge is still full lock, so it behaves like a pair of buttons for anyone who
   treats it as one, but a thumb that rolls fifteen degrees into a corner gets fifteen
   degrees of steering instead of everything. */
let touchSteer = 0, steerPointer = null;
/* The button pair is ONE drag surface too, not two independent buttons: both children
   have pointer-events:none (see the CSS) so every event lands on the shared container
   regardless of which button the finger is over, and bindSteerButtons below picks a side
   from where the pointer actually is. That's what lets a finger slide from one button to
   the other and have the game notice -- two separately-listening buttons would each only
   hear their own pointerdown, and a slide between them (implicit touch capture keeps a
   touch bound to whichever element it started on) would never reach the second one. */
let btnSteerPointer = null, steerBtnL = null, steerBtnR = null;
const neonHandlers = {};
const holdEls = [];                   // gas, brake, nitro: cleared of their pressed look on blur

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
    for(const el of holdEls) el.classList.remove('pressed');
    const pad = document.getElementById('tSteer');
    if(pad) pad.classList.remove('pressed');
    clearSteerButtons();
  });
  const hold = (id, key) => {
    const el = document.getElementById(id);
    if(!el) return;
    /* The pressed LOOK is a class set here, not :active. iOS Safari only applies :active
       to an element with a touchstart listener, and applies it late even then; a class
       toggled on the same pointer event that sets the input is on screen the same frame
       the board responds, and off the same frame it lets go. */
    const on = e => { e.preventDefault(); neonTouch[key] = true; el.classList.add('pressed'); markTouch(); };
    const off = e => { e.preventDefault(); neonTouch[key] = false; el.classList.remove('pressed'); };
    holdEls.push(el);
    el.addEventListener('pointerdown', on);
    el.addEventListener('pointerup', off);
    el.addEventListener('pointercancel', off);
    el.addEventListener('pointerleave', off);
    el.addEventListener('contextmenu', e => e.preventDefault());
  };
  hold('tBrake', 'brake'); hold('tBoost', 'boost'); hold('tAccel', 'accel');
  bindSteerButtons(document.getElementById('tSteerBtns'), document.getElementById('tLeft'), document.getElementById('tRight'));
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
  /* Belt and suspenders against the browser's own "swipe to go back": touch-action:none
     (in the stylesheet) and preventDefault() on the pointer handlers below stop it on
     most browsers, but iOS Safari's edge-swipe gesture is recognised by the OS layer and
     can preempt a page's pointer events entirely when the touch starts close enough to
     the screen edge -- CTL_INSET_MIN (main.js) is what actually keeps that from
     happening. These raw touch listeners are the other half: some browsers respect an
     explicit, non-passive preventDefault() on the underlying touch event even where they
     do not fully honour touch-action, so both are wired to the same effect for whichever
     one a given browser actually listens to. */
  pad.addEventListener('touchstart', e => { if(e.cancelable) e.preventDefault(); }, {passive:false});
  pad.addEventListener('touchmove', e => { if(e.cancelable) e.preventDefault(); }, {passive:false});
  pad.addEventListener('pointerdown', e => {
    e.preventDefault(); markTouch();
    steerPointer = e.pointerId;
    pad.classList.add('pressed');
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
    pad.classList.remove('pressed');
  };
  pad.addEventListener('pointerup', up);
  pad.addEventListener('pointercancel', up);
  pad.addEventListener('lostpointercapture', up);
  pad.addEventListener('contextmenu', e => e.preventDefault());
}

/* The two-button alternative to the pad above. Same shape of listener (raw touch events
   prevented for the same edge-swipe reason, a captured pointer tracked by id, released on
   up/cancel/loss) but the payload is a SIDE, not an offset: whichever half of the
   container the pointer is over gets steerL/steerR, and crossing the midpoint while still
   down switches which one -- that's the slide this exists for. A tap anywhere on a side
   is already full lock (there's no partial position within a side), so unlike the pad
   there's nothing analog to compute; the digital easing in readNeonInput does the rest,
   exactly as it does for a keyboard arrow. */
function bindSteerButtons(container, left, right){
  if(!container || !left || !right) return;
  steerBtnL = left; steerBtnR = right;
  const sideAt = e => {
    const r = container.getBoundingClientRect();
    const half = r.width/2;
    if(!half) return null;
    return (e.clientX - r.left) < half ? 'L' : 'R';
  };
  const setSide = side => {
    neonTouch.steerL = side === 'L';
    neonTouch.steerR = side === 'R';
    left.classList.toggle('pressed', side === 'L');
    right.classList.toggle('pressed', side === 'R');
  };
  container.addEventListener('touchstart', e => { if(e.cancelable) e.preventDefault(); }, {passive:false});
  container.addEventListener('touchmove', e => { if(e.cancelable) e.preventDefault(); }, {passive:false});
  container.addEventListener('pointerdown', e => {
    e.preventDefault(); markTouch();
    btnSteerPointer = e.pointerId;
    if(container.setPointerCapture) try{ container.setPointerCapture(e.pointerId); }catch(err){}
    const side = sideAt(e);
    if(side) setSide(side);
  });
  container.addEventListener('pointermove', e => {
    if(btnSteerPointer !== e.pointerId) return;
    e.preventDefault();
    const side = sideAt(e);
    if(side) setSide(side);
  });
  const up = e => {
    if(btnSteerPointer !== e.pointerId) return;
    e.preventDefault();
    btnSteerPointer = null; clearSteerButtons();
  };
  container.addEventListener('pointerup', up);
  container.addEventListener('pointercancel', up);
  container.addEventListener('lostpointercapture', up);
  container.addEventListener('contextmenu', e => e.preventDefault());
}
function clearSteerButtons(){
  neonTouch.steerL = false; neonTouch.steerR = false;
  if(steerBtnL) steerBtnL.classList.remove('pressed');
  if(steerBtnR) steerBtnR.classList.remove('pressed');
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
  // the left/right steer BUTTONS feed the same digital path a keyboard arrow does
  const left  = K('a') || K('ArrowLeft') || neonTouch.steerL;
  const right = K('d') || K('ArrowRight') || neonTouch.steerR;
  const want = (left ? 1 : 0) - (right ? 1 : 0);
  if(steerPointer !== null){
    /* The pad is already analog, so it only needs enough smoothing to take the stair-step
       out of a dragging thumb. The key easing below must NOT also run here: it pulls
       towards zero every frame, and the two together settle about three quarters of the
       way to full lock -- a pad that can never quite reach the stops. Only a drag on the
       pad itself sets steerPointer, so the buttons -- and a keyboard -- always fall to
       the digital branch below, pad mode or not. */
    steerSmooth += (touchSteer - steerSmooth)*Math.min(1, dt*18);
  }else{
    // a key (or a steer button) is all-or-nothing; ease it so a tap is a nudge and a
    // hold is full lock
    const rate = want === 0 ? 7 : 4.5;
    steerSmooth += Math.max(-rate*dt, Math.min(rate*dt, want - steerSmooth));
  }
  const steer = steerSmooth;
  const brake = (K('s') || K('ArrowDown') || neonTouch.brake) ? 1 : 0;
  const gas = (K('w') || K('ArrowUp') || neonTouch.accel) ? 1 : 0;
  return {steer, throttle: gas, brake, boost: K('Shift') || K(' ') || neonTouch.boost};
}
function resetNeonInput(){ steerSmooth = 0; touchSteer = 0; steerPointer = null; }
/* Called when the player switches steer mode (see main.js setSteerMode), so a drag or a
   button held down at the moment of the switch can't stick. Leaves steerSmooth itself
   alone -- the mode only changes which control feeds it, not the value already eased
   towards, and the switch happens from a menu or a paused race, never mid-corner. */
function resetSteerTouch(){
  touchSteer = 0; steerPointer = null; btnSteerPointer = null;
  clearSteerButtons();
  const pad = document.getElementById('tSteer');
  if(pad) pad.classList.remove('pressed');
}

export { initNeonInput, readNeonInput, resetNeonInput, resetSteerTouch, neonKeys, neonTouch };
