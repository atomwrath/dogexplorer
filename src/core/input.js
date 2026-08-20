/* Keyboard, lobby drag-spin, and the mobile control layer
   (floating analog stick + multi-touch action buttons). */
import { canvas } from './render.js';
import { clamp } from './math.js';
import { initAudio } from './audio.js';
import { addDogYaw } from '../dog/runtime.js';
import { play, keys } from '../city/player-state.js';
import { mode, setMode } from '../city/modes.js';
import { tryJump, bark } from '../city/player.js';
import { chomp } from '../city/pickups.js';
import { toast } from '../city/ui.js';

let dragging = false, lastX = 0;
canvas.addEventListener('pointerdown', e=>{
  if(mode!=='lobby') return;
  e.preventDefault();
  dragging = true; lastX = e.clientX;
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', e=>{
  if(!dragging || mode!=='lobby') return;
  addDogYaw((e.clientX - lastX) * 0.012);
  lastX = e.clientX;
});
canvas.addEventListener('pointerup', ()=> dragging = false);
canvas.addEventListener('pointercancel', ()=> dragging = false);

window.addEventListener('keydown', e=>{
  const k = e.key.toLowerCase();
  if(mode==='play'){
    if(['arrowup','arrowdown','arrowleft','arrowright',' '].includes(k)) e.preventDefault();
    if(e.key===' ') tryJump();
    if(k==='b') bark();
    if(k==='e' || k==='f') chomp();
    if(e.key==='Escape') setMode('lobby');
  }
  keys[k] = true;
});
window.addEventListener('keyup', e=>{ keys[e.key.toLowerCase()] = false; });
/* ---------- analog thumbstick (multi-touch safe) ---------- */
const IS_TOUCH = matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
const stickZone = document.getElementById('stickZone');
const stickBase = document.getElementById('stickBase');
const stickKnob = document.getElementById('stickKnob');
const STICK_R = 52;
const stick = {id:null, active:false, dx:0, dz:0, mag:0, ox:0, oy:0};

function stickRender(px, py){
  let dx = px - stick.ox, dy = py - stick.oy;
  const len = Math.hypot(dx, dy) || 0.0001;
  const cl = Math.min(len, STICK_R);
  const nx = dx/len, ny = dy/len;
  stickKnob.style.transform = `translate(${nx*cl}px, ${ny*cl}px)`;
  stick.mag = cl / STICK_R;
  stick.dx = nx; stick.dz = ny;
  stickBase.classList.toggle('run', stick.mag > 0.78 && !play.sneakToggle);
}
function stickStart(e){
  if(stick.id !== null || mode !== 'play') return;
  e.preventDefault();
  initAudio();
  stick.id = e.pointerId;
  stick.active = true;
  const zr = stickZone.getBoundingClientRect();
  // the stick appears wherever the thumb lands
  const bx = clamp(e.clientX - zr.left, 74, Math.max(74, zr.width - 74));
  const by = clamp(e.clientY - zr.top, 74, Math.max(74, zr.height - 74));
  stickBase.style.left = bx + 'px';
  stickBase.style.top = by + 'px';
  stickBase.style.bottom = 'auto';
  stickBase.classList.add('on');
  stick.ox = zr.left + bx; stick.oy = zr.top + by;
  stickRender(e.clientX, e.clientY);
  try{ stickZone.setPointerCapture(e.pointerId); }catch(err){}
}
function stickMove(e){
  if(e.pointerId !== stick.id) return;
  e.preventDefault();
  stickRender(e.clientX, e.clientY);
}
function stickEnd(e){
  if(e.pointerId !== stick.id) return;
  stick.id = null; stick.active = false; stick.mag = 0; stick.dx = 0; stick.dz = 0;
  stickKnob.style.transform = 'translate(0,0)';
  stickBase.classList.remove('on','run');
  stickBase.style.left = ''; stickBase.style.top = ''; stickBase.style.bottom = '';
}
stickZone.addEventListener('pointerdown', stickStart);
stickZone.addEventListener('pointermove', stickMove);
stickZone.addEventListener('pointerup', stickEnd);
stickZone.addEventListener('pointercancel', stickEnd);

/* ---------- action buttons: independent, so they stack with the stick ---------- */
function tapButton(el, fn, hold){
  el.addEventListener('pointerdown', e=>{
    e.preventDefault();
    el.setPointerCapture && el.setPointerCapture(e.pointerId);
    el.classList.add('down');
    if(navigator.vibrate) navigator.vibrate(8);
    fn();
  });
  const up = e=>{
    el.classList.remove('down');
    if(hold) hold(false);
  };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
}
tapButton(document.getElementById('tJump'), tryJump);
tapButton(document.getElementById('tBark'), bark);
tapButton(document.getElementById('tChomp'), chomp);
document.getElementById('tSneak').addEventListener('pointerdown', function(e){
  e.preventDefault();
  play.sneakToggle = !play.sneakToggle;
  this.classList.toggle('on', play.sneakToggle);
  stickBase.classList.toggle('sneaking', play.sneakToggle);
  if(navigator.vibrate) navigator.vibrate(8);
  toast(play.sneakToggle ? '🐾 Sneaking — quiet paws' : 'Back to normal pace');
});

export { keys, IS_TOUCH, stick, stickBase, stickKnob, tapButton, dragging };
