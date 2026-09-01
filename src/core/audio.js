/* All sound effects. Web Audio only — no asset files to load. */
import { P } from '../dog/runtime.js';

/* ========================================================= AUDIO */
let AC = null;
/* Anything scheduled while the context is still SUSPENDED is silently dropped.

   resume() returns a promise, and a context created inside a click handler is very often
   still suspended for a few milliseconds afterwards. Every sound in this file schedules
   against AC.currentTime and returns immediately, so a sound fired during that window
   builds a perfectly correct audio graph, starts it, and produces nothing at all -- no
   error, no warning, nothing to see in a debugger. That is exactly the failure mode where
   the code reads fine and the speaker stays quiet.

   So sounds fired before the context is running are queued and replayed the moment it
   is. The queue is short-lived and bounded: a backlog of barks arriving half a second
   late would be worse than the silence it replaced. */
const PENDING = [];
const PENDING_MAX = 4;
function whenRunning(fn){
  initAudio();
  if(!AC) return;
  if(AC.state === 'running'){ fn(); return; }
  if(PENDING.length < PENDING_MAX) PENDING.push(fn);
}
function flushPending(){
  if(!AC || AC.state !== 'running') return;
  while(PENDING.length){ const fn = PENDING.shift(); try{ fn(); }catch(err){} }
}
function initAudio(){
  if(!AC){ try{ AC = new (window.AudioContext || window.webkitAudioContext)(); }catch(e){} }
  if(!AC) return;
  if(AC.state === 'suspended'){
    const r = AC.resume();
    if(r && typeof r.then === 'function') r.then(flushPending, ()=>{ PENDING.length = 0; });
    else flushPending();
  }else{
    flushPending();
  }
}
/* Never schedule AT currentTime. A context that has only just started running can drop
   an event timestamped exactly now, because "now" has already passed by the time the
   audio thread sees it. 20 ms is inaudible as latency and reliable as a lead. */
const LEAD = 0.02;
function startAt(){ return (AC ? AC.currentTime : 0) + LEAD; }

/* One master gain everything routes through, instead of every voice connecting straight
   to destination. Two reasons: a single place to set overall level, and headroom -- three
   barks and a growl all hitting destination at 0.5 each was clipping on the way out. */
let MASTER = null;
function out(){
  if(!AC) return null;
  if(!MASTER){ MASTER = AC.createGain(); MASTER.gain.value = 0.85; MASTER.connect(out()); }
  return MASTER;
}

/* THE FLOOR A SMALL SPEAKER CAN ACTUALLY REPRODUCE.

   This is the bug behind "we can hear animals when they are startled but nothing else",
   and it was never in the wiring -- the audio graph was always built correctly. It was in
   the VOICING. The startle yip is woofBurst at pitch 2.4: a fundamental sweeping 768 ->
   215 Hz under a filter opening at 2160 Hz. The bark was the same function at pitch 1.0:
   89 -> 320 Hz under a filter closing to 240 Hz. Laptop and phone speakers roll off hard
   below roughly 300-500 Hz and have essentially no output under 200, so the yip was
   entirely inside the band they reproduce and the bark was entirely underneath it. On
   headphones both are audible, which is exactly why this survived being "tested".

   So every voice that is meant to be heard on a laptop keeps its fundamental above this,
   and carries a mid-band layer for the transient. Low end is treated as garnish that some
   listeners get, never as the thing carrying the sound. tools/smoke.js asserts the floor. */
const SPEAKER_FLOOR_HZ = 190;

/* Unlock on the FIRST user gesture of any kind, not on whichever button a given page
   happens to treat as "start".

   Every browser requires a gesture before audio will run, and every page here has had
   exactly one place that provided it. That is fragile in a way that is invisible when it
   works: move the start button, add a second way in, and the context is created on a tick
   that has no user activation behind it -- at which point resume() never settles, the
   queue never flushes, and the game is silent with a perfectly correct audio graph. Pup
   Trails just removed its start button, so this is no longer hypothetical. Listeners are
   passive, fire once, and cover pointer, key and touch. */
let unlockWired = false;
function wireAudioUnlock(){
  if(unlockWired || typeof window === 'undefined' || !window.addEventListener) return;
  unlockWired = true;
  const go = ()=>{ initAudio(); };
  for(const ev of ['pointerdown','touchstart','keydown','click']){
    window.addEventListener(ev, go, {passive:true});
  }
}
if(typeof window !== 'undefined') wireAudioUnlock();

/* A one-line answer to "why can I not hear anything", printed once, the first time a
   sound is asked for. It reports the context state and the actual frequency band this
   BUILD produces -- which is the fastest way to tell a genuine audio fault apart from an
   old copy of this file still being on disk, since the two look identical from the
   outside and only one of them is fixable from here. */
let announced = false;
function announceOnce(){
  if(announced || typeof console === 'undefined') return;
  announced = true;
  const b = barkBand(1);
  console.log('[pup-trails audio] context=' + audioState() +
    '  bark=' + Math.round(b.lo) + '-' + Math.round(b.hi) + ' Hz' +
    '  floor=' + SPEAKER_FLOOR_HZ + ' Hz' +
    (b.lo < SPEAKER_FLOOR_HZ ? '  <-- BELOW SPEAKER FLOOR, this file is out of date' : ''));
}
/* The band a bark occupies at a given size, derived from the same constants wuf uses so
   it cannot drift from what is actually played. */
function barkBand(sizeMul){
  const size = Math.max(0.25, Math.min(4, Number(sizeMul) || 1));
  const base = Math.max(SPEAKER_FLOOR_HZ*1.15, 620/Math.pow(size, 0.42));
  return {lo: base*0.72, hi: base*1.22, base};
}
function woofBurst(when, pitchMul, dur=0.14, peak=0.5){
  if(!AC) return;
  const o = AC.createOscillator(), f = AC.createBiquadFilter(), gn = AC.createGain();
  o.type = 'sawtooth';
  // yipHigh (pitch 2.4) was the ONE sound anybody could hear -- it is the reference this
  // floor was derived from. Clamping keeps a low-pitched call from repeating the bug.
  const base = Math.max(SPEAKER_FLOOR_HZ*1.1, 320 * pitchMul);
  o.frequency.setValueAtTime(base, when);
  o.frequency.exponentialRampToValueAtTime(base*0.28, when+dur);
  f.type = 'lowpass';
  f.frequency.setValueAtTime(900*pitchMul, when);
  f.frequency.exponentialRampToValueAtTime(240, when+dur);
  f.Q.value = 4;
  gn.gain.setValueAtTime(0.0001, when);
  gn.gain.exponentialRampToValueAtTime(peak, when+0.015);
  gn.gain.exponentialRampToValueAtTime(0.0001, when+dur);
  o.connect(f).connect(gn).connect(out());
  o.start(when); o.stop(when+dur+0.02);
}
function yip(pitch){
  whenRunning(()=>{
    if(!P) return;
    woofBurst(startAt(), pitch/Math.sqrt(P.size), 0.09);
  });
}
let noiseBuf = null;
function getNoise(){
  if(!AC) return null;
  if(!noiseBuf){
    noiseBuf = AC.createBuffer(1, AC.sampleRate*0.3, AC.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for(let i=0;i<d.length;i++) d[i] = Math.random()*2-1;
  }
  return noiseBuf;
}
function huffSound(){
  whenRunning(()=>{
    const src = AC.createBufferSource(); src.buffer = getNoise();
    const f = AC.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 320; f.Q.value = 1.2;
    const gn = AC.createGain();
    const tN = startAt();
    gn.gain.setValueAtTime(0.5, tN);
    gn.gain.exponentialRampToValueAtTime(0.0001, tN+0.35);
    src.connect(f).connect(gn).connect(out());
    src.start(tN); src.stop(tN+0.36);
  });
}
function thudSound(){
  whenRunning(()=>{
    const o = AC.createOscillator(), gn = AC.createGain();
    const tN = startAt();
    o.type = 'sine';
    o.frequency.setValueAtTime(150, tN);
    o.frequency.exponentialRampToValueAtTime(55, tN+0.16);
    gn.gain.setValueAtTime(0.35, tN);
    gn.gain.exponentialRampToValueAtTime(0.0001, tN+0.18);
    o.connect(gn).connect(out());
    o.start(tN); o.stop(tN+0.2);
  });
}
function splashSound(){
  whenRunning(()=>{
    const src = AC.createBufferSource(); src.buffer = getNoise();
    const f = AC.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1400; f.Q.value = 0.8;
    const gn = AC.createGain();
    const tN = startAt();
    f.frequency.exponentialRampToValueAtTime(500, tN+0.3);
    gn.gain.setValueAtTime(0.45, tN);
    gn.gain.exponentialRampToValueAtTime(0.0001, tN+0.35);
    src.connect(f).connect(gn).connect(out());
    src.start(tN); src.stop(tN+0.36);
  });
}
function honkSound(){
  whenRunning(()=>{
    const tN = startAt();
    [392, 494].forEach(fr=>{
      const o = AC.createOscillator(), gn = AC.createGain();
      o.type = 'square'; o.frequency.value = fr;
      gn.gain.setValueAtTime(0.12, tN);
      gn.gain.setValueAtTime(0.12, tN+0.14);
      gn.gain.exponentialRampToValueAtTime(0.0001, tN+0.2);
      o.connect(gn).connect(out());
      o.start(tN); o.stop(tN+0.22);
    });
  });
}
function chompSound(){
  whenRunning(()=>{
    const tN = startAt();
    const o = AC.createOscillator(), gn = AC.createGain();
    o.type = 'square';
    o.frequency.setValueAtTime(210, tN);
    o.frequency.exponentialRampToValueAtTime(70, tN+0.07);
    gn.gain.setValueAtTime(0.3, tN);
    gn.gain.exponentialRampToValueAtTime(0.0001, tN+0.09);
    o.connect(gn).connect(out());
    o.start(tN); o.stop(tN+0.1);
  });
}
function grumbleSound(){
  whenRunning(()=>{
    const tN = startAt();
    const o = AC.createOscillator(), gn = AC.createGain();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(180, tN);
    o.frequency.linearRampToValueAtTime(120, tN+0.24);
    gn.gain.setValueAtTime(0.14, tN);
    gn.gain.exponentialRampToValueAtTime(0.0001, tN+0.26);
    o.connect(gn).connect(out());
    o.start(tN); o.stop(tN+0.28);
  });
}
function yipHigh(){
  whenRunning(()=>{
    woofBurst(startAt(), 2.4, 0.07);
  });
}
function cheerBlip(){
  whenRunning(()=>{
    const tN = startAt();
    [659, 880].forEach((fr,i)=>{
      const o = AC.createOscillator(), gn = AC.createGain();
      o.type = 'triangle'; o.frequency.value = fr;
      gn.gain.setValueAtTime(0.0001, tN+i*0.08);
      gn.gain.exponentialRampToValueAtTime(0.2, tN+i*0.08+0.02);
      gn.gain.exponentialRampToValueAtTime(0.0001, tN+i*0.08+0.22);
      o.connect(gn).connect(out());
      o.start(tN+i*0.08); o.stop(tN+i*0.08+0.24);
    });
  });
}
function cheerSound(){
  whenRunning(()=>{
    const tN = startAt();
    [523, 659, 784, 1047].forEach((fr, i)=>{
      const o = AC.createOscillator(), gn = AC.createGain();
      o.type = 'triangle';
      o.frequency.value = fr;
      gn.gain.setValueAtTime(0.0001, tN+i*0.09);
      gn.gain.exponentialRampToValueAtTime(0.22, tN+i*0.09+0.02);
      gn.gain.exponentialRampToValueAtTime(0.0001, tN+i*0.09+0.3);
      o.connect(gn).connect(out());
      o.start(tN+i*0.09); o.stop(tN+i*0.09+0.32);
    });
  });
}

/* A bark, for whoever is doing the barking.

   yip() above is the city dog's, and it reads P -- dog/runtime.js's live rig params --
   to pitch itself. Pup Trails cannot use that: you might be playing as a bighorn sheep,
   and P is either stale or belongs to a dog nobody is currently controlling. So the
   caller passes the size instead, which is the only thing the sound needs to know.

   Two woofs, not one, and the second is quieter and a touch lower: a single burst reads
   as a yelp, and the point of pressing B on a trail is to announce yourself to the
   valley. A big animal gets a third, spaced wider -- the interval is what makes a moose
   sound like a moose rather than a slowed-down terrier. */
/* One "wuf": a voiced body plus a noise transient.

   Deliberately not woofBurst with a different argument. The body is pitched well clear of
   SPEAKER_FLOOR_HZ and its filter OPENS across the burst rather than closing, so the
   sound brightens as it lands instead of sinking out of the band on the way. The noise
   layer is the consonant -- the hard front edge that makes it read as a bark rather than
   as a note -- and it lives around 1.5 kHz where every speaker is at its best. Size
   pitches both down, but only within a range that stays reproducible: a moose sounds
   bigger than a terrier by being lower AND rougher, not by being inaudible. */
function wuf(t0, sizeMul, gainMul){
  if(!AC) return;
  const size = Math.max(0.25, Math.min(4, Number(sizeMul) || 1));
  const dur = 0.12 + 0.05*Math.sqrt(size);
  const base = Math.max(SPEAKER_FLOOR_HZ*1.15, 620/Math.pow(size, 0.42));
  const g = gainMul == null ? 1 : gainMul;

  const o = AC.createOscillator(), f = AC.createBiquadFilter(), gn = AC.createGain();
  o.type = 'sawtooth';
  o.frequency.setValueAtTime(base*1.22, t0);
  o.frequency.exponentialRampToValueAtTime(base*0.72, t0 + dur);
  f.type = 'bandpass';
  f.frequency.setValueAtTime(base*1.6, t0);
  f.frequency.exponentialRampToValueAtTime(base*2.9, t0 + dur*0.45);
  f.frequency.exponentialRampToValueAtTime(base*1.3, t0 + dur);
  f.Q.value = 1.1;
  gn.gain.setValueAtTime(0.0001, t0);
  gn.gain.exponentialRampToValueAtTime(0.62*g, t0 + 0.012);
  gn.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(f).connect(gn).connect(out());
  o.start(t0); o.stop(t0 + dur + 0.02);

  const src = AC.createBufferSource(); src.buffer = getNoise();
  const nf = AC.createBiquadFilter(); nf.type = 'bandpass';
  nf.frequency.value = 1500/Math.pow(size, 0.3); nf.Q.value = 0.9;
  const ng = AC.createGain();
  ng.gain.setValueAtTime(0.34*g, t0);
  ng.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.07);
  src.connect(nf).connect(ng).connect(out());
  src.start(t0); src.stop(t0 + 0.08);
}

function barkSound(sizeMul){
  announceOnce();
  whenRunning(()=>{
    const size = Math.max(0.25, Math.min(4, Number(sizeMul) || 1));
    const t0 = startAt();
    const gap = 0.15 + 0.05*size;
    wuf(t0, size, 1);
    wuf(t0 + gap, size*1.06, 0.82);
    if(size > 1.4) wuf(t0 + gap*2.05, size*1.12, 0.66);
  });
}

/* A big animal's warning: a low, rising huff-growl with a hard edge on it. Deliberately
   NOT a scaled-down bark -- the player has to be able to tell "that one is about to have
   a go at me" from "that one is barking back", by ear, with the camera pointed elsewhere. */
function warnGrowl(sizeMul){
  whenRunning(()=>{
    const size = Math.max(0.5, Math.min(4, Number(sizeMul) || 1));
    const t0 = startAt(), dur = 0.5;
    /* A growl WANTS to be low, and low is exactly what a laptop cannot play. So the
       menace comes from roughness and a rising pitch rather than from depth: a resonant
       bandpass an octave above the fundamental gives it a snarl that survives a small
       speaker, and the fundamental still sits clear of the floor. */
    const o = AC.createOscillator(), f = AC.createBiquadFilter(), gn = AC.createGain();
    o.type = 'sawtooth';
    const base = Math.max(SPEAKER_FLOOR_HZ*1.1, 300/Math.pow(size, 0.35));
    o.frequency.setValueAtTime(base, t0);
    o.frequency.linearRampToValueAtTime(base*1.45, t0+dur);
    f.type = 'bandpass'; f.frequency.value = base*2.1; f.Q.value = 3.2;
    gn.gain.setValueAtTime(0.0001, t0);
    gn.gain.exponentialRampToValueAtTime(0.5, t0+0.12);
    gn.gain.exponentialRampToValueAtTime(0.0001, t0+dur);
    o.connect(f).connect(gn).connect(out());
    o.start(t0); o.stop(t0+dur+0.02);
    // a slow noise rasp under it: this is what makes it read as an animal, not a synth
    const src = AC.createBufferSource(); src.buffer = getNoise();
    const nf = AC.createBiquadFilter(); nf.type='bandpass'; nf.frequency.value=700; nf.Q.value=0.8;
    const ng = AC.createGain();
    ng.gain.setValueAtTime(0.0001, t0);
    ng.gain.exponentialRampToValueAtTime(0.26, t0+0.16);
    ng.gain.exponentialRampToValueAtTime(0.0001, t0+dur);
    src.connect(nf).connect(ng).connect(out());
    src.start(t0); src.stop(t0+dur);
  });
}

/* The moment of contact. A body-weight thud with a short noise slap on top -- the slap is
   what reads as "that hit me" rather than "something fell over nearby". */
function bonkSound(sizeMul){
  whenRunning(()=>{
    const size = Math.max(0.5, Math.min(4, Number(sizeMul) || 1));
    const t0 = startAt();
    /* The thump is the part a laptop will not play, so the SLAP carries the hit and the
       thump is a bonus for anyone on headphones. Pitched to stay in band on the way down
       rather than sliding under it. */
    const o = AC.createOscillator(), gn = AC.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(520/Math.pow(size, 0.3), t0);
    o.frequency.exponentialRampToValueAtTime(Math.max(SPEAKER_FLOOR_HZ, 240/Math.pow(size, 0.3)), t0+0.2);
    gn.gain.setValueAtTime(0.62, t0);
    gn.gain.exponentialRampToValueAtTime(0.0001, t0+0.26);
    o.connect(gn).connect(out());
    o.start(t0); o.stop(t0+0.28);
    const src = AC.createBufferSource(); src.buffer = getNoise();
    const nf = AC.createBiquadFilter(); nf.type = 'bandpass'; nf.frequency.value = 1300; nf.Q.value = 0.6;
    const ng = AC.createGain();
    ng.gain.setValueAtTime(0.55, t0);
    ng.gain.exponentialRampToValueAtTime(0.0001, t0+0.18);
    src.connect(nf).connect(ng).connect(out());
    src.start(t0); src.stop(t0+0.2);
  });
}

/* Test seam. tools/smoke.js asserts that nothing is ever scheduled against a suspended
   context, which is the bug this file's queue exists to prevent and the one thing about
   it that cannot be seen by listening to a headless browser. */
function audioState(){ return AC ? AC.state : 'none'; }
/* `const` bindings do not survive the smoke harness's eval boundary (same reason
   getSignCount and getBigView exist), so the floor is readable through a call. */
function speakerFloorHz(){ return SPEAKER_FLOOR_HZ; }
/* Callable from the console: plays a bark and reports what the build is doing. */
function soundCheck(){
  initAudio();
  const b = barkBand(1);
  barkSound(1);
  return {context: audioState(), queued: pendingSounds(),
          barkHz: Math.round(b.lo) + '-' + Math.round(b.hi),
          floorHz: SPEAKER_FLOOR_HZ, ok: b.lo >= SPEAKER_FLOOR_HZ};
}
if(typeof window !== 'undefined') window.pupSoundCheck = soundCheck;
function pendingSounds(){ return PENDING.length; }

export { AC, initAudio, woofBurst, wuf, out, SPEAKER_FLOOR_HZ, yip, huffSound, thudSound, splashSound,
         honkSound, chompSound, grumbleSound, yipHigh, cheerBlip, cheerSound, barkSound,
         warnGrowl, bonkSound, audioState, speakerFloorHz, soundCheck, barkBand, wireAudioUnlock, pendingSounds, whenRunning, flushPending };
