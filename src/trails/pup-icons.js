/* Side-profile icons for the pup picker.

   THREE SOURCES, IN ORDER.
     1. Shipped. src/data/profile-icons.js holds an icon for every dog preset and wild species,
        drawn ahead of time by tools/make-profile-icons.mjs. Found by hash, so they appear on the
        first frame, cost nothing to show, and work on a device with no WebGL to spare.
     2. Drawn on this device. A pup with no shipped icon -- one made in Backyard Pups, one
        imported from a file, a preset retuned since the icons were last generated -- is drawn
        by the very same renderer (core/profile-icon.js), one per timer tick so the picker never
        stalls, and kept for the rest of the session.
     3. Nothing. If the browser cannot draw it, the card keeps its emoji. An icon is a nicety;
        it must never be the reason the picker does not work.

   Found by HASH, not by name, so two pups with the same look share one icon, and a preset that
   is renamed keeps its picture while one that is retuned loses it (and is redrawn). */
import { PROFILE_ICONS } from '../data/profile-icons.js';
import { renderProfile, pixelsToDataURL, canRender } from '../core/profile-icon.js';
import { renderer, disposeGroup } from '../core/render.js';

const shippedIcons = new Map();          // hash -> data URL
for(const k of Object.keys(PROFILE_ICONS)) shippedIcons.set(PROFILE_ICONS[k].h, PROFILE_ICONS[k].src);
const madeIcons = new Map();             // hash -> data URL, drawn on this device this session
const failedIcons = new Set();           // hashes the browser could not draw: not retried
const waitingIcons = new Map();          // hash -> {spec, cbs}
const iconOrder = [];
let iconTimer = 0;

function iconSrc(spec){ return shippedIcons.get(spec.hash) || madeIcons.get(spec.hash) || null; }
function iconIsShipped(spec){ return shippedIcons.has(spec.hash); }

function drawIcon(spec){
  if(!canRender(renderer)) return null;
  let rig = null;
  try{
    rig = spec.build();
    const img = renderProfile(renderer, rig);
    return img ? pixelsToDataURL(img) : null;
  }catch(err){
    console.warn('profile icon: could not draw one', err);
    return null;
  }finally{
    if(rig) disposeGroup(rig);
  }
}
/* Swappable so a test can supply the pixels. The default is the real thing. */
let iconBackend = drawIcon;
function setIconBackend(fn){ iconBackend = fn || drawIcon; }

/* One icon per tick, on a timer and NOT requestAnimationFrame: this must never contend with
   the game's own frame loop for the slot, and a pup that takes a few extra tenths of a second
   to get its picture is not worth a dropped frame. */
function pumpIcons(){
  iconTimer = 0;
  const hash = iconOrder.shift();
  const job = hash == null ? null : waitingIcons.get(hash);
  if(job){
    waitingIcons.delete(hash);
    const src = iconBackend(job.spec);
    if(src){
      madeIcons.set(hash, src);
      for(const cb of job.cbs){ try{ cb(src); }catch(err){ console.warn('profile icon callback', err); } }
    }else{
      failedIcons.add(hash);
    }
  }
  if(iconOrder.length) iconTimer = setTimeout(pumpIcons, 20);
}

/* Ask for a spec's icon. When it is shipped or already drawn, `cb` is called at once and the
   src is returned; otherwise it is queued, `cb` is called when it is ready (never, if it
   cannot be drawn), and null is returned. */
function requestIcon(spec, cb){
  const have = iconSrc(spec);
  if(have){ if(cb) cb(have); return have; }
  if(failedIcons.has(spec.hash)) return null;
  const queued = waitingIcons.get(spec.hash);
  if(queued){
    if(cb) queued.cbs.push(cb);
  }else{
    waitingIcons.set(spec.hash, {spec, cbs: cb ? [cb] : []});
    iconOrder.push(spec.hash);
    if(!iconTimer) iconTimer = setTimeout(pumpIcons, 0);
  }
  return null;
}

function iconQueueLength(){ return iconOrder.length; }

export { requestIcon, iconSrc, iconIsShipped, setIconBackend, iconQueueLength };
