/* THE BOARD'S ENGINE, as a jet rather than a motor.

   One second of white noise on a loop, through a bandpass that rides speed and a lowpass
   that opens up under boost, plus a little sine under it for the thrust you feel rather
   than hear. That is the whole rig: noise shaped by filters is what a turbine IS, whereas
   the sawtooth this replaces was a moped.

   Everything goes through out(), so the shared mute switch and master level still apply,
   and nothing is built until whenRunning() says the context has been unlocked by a
   gesture -- an AudioContext created before that is born suspended and stays silent. */
import { AC, out, whenRunning } from '../core/audio.js';

let jet = null;
/* THE WIND. A second noise loop, brighter than the jet, that is almost silent going
   straight and swells as you lean into a turn -- the rush of air across a board carving
   at speed. Louder the harder you steer and the faster you go, pitched up with both, and
   panned to the side you are leaning towards, so a long sweeper sounds like one. */
let wind = null;
/* THE BRAKE: a bright scrub of noise, like a deck dragging on the track -- as loud as you
   are braking hard and moving fast, silent the moment you let go or stop. */
let brakeN = null;

function noiseBuffer(){
  const n = Math.floor(AC.sampleRate);
  const buf = AC.createBuffer(1, n, AC.sampleRate);
  const ch = buf.getChannelData(0);
  /* Brown-ish rather than white: a running sum tilts the spectrum down about 6 dB an
     octave, which is much closer to a turbine and far less like a hissing tap. Scaled
     back towards zero each sample so the sum cannot wander off into a DC offset. */
  let last = 0;
  for(let i = 0; i < n; i++){
    const w = Math.random()*2 - 1;
    last = (last + 0.035*w)/1.035;
    ch[i] = last*3.2;
  }
  return buf;
}

function startHum(){
  if(jet) return;
  whenRunning(() => {
    if(jet || !AC) return;
    const dest = out();
    if(!dest) return;
    const src = AC.createBufferSource();
    src.buffer = noiseBuffer();
    src.loop = true;
    const band = AC.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.setValueAtTime(420, AC.currentTime);
    band.Q.setValueAtTime(0.7, AC.currentTime);
    const low = AC.createBiquadFilter();
    low.type = 'lowpass';
    low.frequency.setValueAtTime(900, AC.currentTime);
    const gain = AC.createGain();
    gain.gain.setValueAtTime(0.0001, AC.currentTime);
    src.connect(band).connect(low).connect(gain).connect(dest);
    // the body of the thrust, an octave below anything the noise is doing
    const sub = AC.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(70, AC.currentTime);
    const subGain = AC.createGain();
    subGain.gain.setValueAtTime(0.0001, AC.currentTime);
    sub.connect(subGain).connect(dest);
    src.start(AC.currentTime + 0.02);
    sub.start(AC.currentTime + 0.02);
    jet = {src, band, low, gain, sub, subGain};
    buildWind(dest);
  });
}
function whiteBuffer(){
  const n = Math.floor(AC.sampleRate*1.5);
  const buf = AC.createBuffer(1, n, AC.sampleRate);
  const ch = buf.getChannelData(0);
  // pink-ish: white, lightly smoothed, so it is air and not static
  let last = 0;
  for(let i = 0; i < n; i++){ const w = Math.random()*2 - 1; last = last*0.55 + w*0.45; ch[i] = last; }
  return buf;
}
function buildWind(dest){
  if(wind) return;
  const src = AC.createBufferSource();
  src.buffer = whiteBuffer();
  src.loop = true;
  const band = AC.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.setValueAtTime(900, AC.currentTime);
  band.Q.setValueAtTime(0.9, AC.currentTime);
  const hi = AC.createBiquadFilter();
  hi.type = 'highpass';
  hi.frequency.setValueAtTime(260, AC.currentTime);
  const gain = AC.createGain();
  gain.gain.setValueAtTime(0.0001, AC.currentTime);
  // a panner where the browser has one; plain mono where it does not
  const pan = AC.createStereoPanner ? AC.createStereoPanner() : null;
  let chain = src.connect(hi).connect(band).connect(gain);
  if(pan) chain = chain.connect(pan);
  chain.connect(dest);
  src.start(AC.currentTime + 0.03);
  wind = {src, band, hi, gain, pan};
  buildBrake(dest, src.buffer);
}
function buildBrake(dest, buffer){
  if(brakeN) return;
  const src = AC.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  const hi = AC.createBiquadFilter();
  hi.type = 'highpass';
  hi.frequency.setValueAtTime(1400, AC.currentTime);
  const band = AC.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.setValueAtTime(2600, AC.currentTime);
  band.Q.setValueAtTime(1.1, AC.currentTime);
  const gain = AC.createGain();
  gain.gain.setValueAtTime(0.0001, AC.currentTime);
  src.connect(hi).connect(band).connect(gain).connect(dest);
  src.start(AC.currentTime + 0.03);
  brakeN = {src, hi, band, gain};
}
function brakeLevel(brake, v){
  const b = Math.max(0, Math.min(1, brake || 0));
  const spool = Math.max(0, Math.min(1, v/20));
  return v < 0.4 ? 0 : b*(0.015 + 0.06*spool);
}
function setBrakeSound(brake, v){
  if(!brakeN || !AC) return;
  const tN = AC.currentTime + 0.04;
  const g = brakeLevel(brake, v);
  brakeN.gain.gain.linearRampToValueAtTime(g < 0.0005 ? 0.0001 : g, tN);
  brakeN.band.frequency.linearRampToValueAtTime(1800 + Math.min(1, v/24)*2200, tN);
}
/* steer: -1..1 as the board uses it (+ is left). v: m/s. */
function windLevel(steer, v){
  const spool = Math.max(0, Math.min(1, v/24));
  const lean = Math.min(1, Math.abs(steer || 0));
  // a breath of air at speed, and the rush on top of it when you carve
  return spool*(0.004 + 0.075*Math.pow(lean, 1.3));
}
function setWind(steer, v){
  if(!wind || !AC) return;
  const tN = AC.currentTime + 0.07;
  const spool = Math.max(0, Math.min(1, v/24));
  const lean = Math.min(1, Math.abs(steer || 0));
  const g = windLevel(steer, v);
  wind.gain.gain.linearRampToValueAtTime(g < 0.0005 ? 0.0001 : g, tN);
  wind.band.frequency.linearRampToValueAtTime(600 + spool*1300 + lean*1100, tN);
  wind.band.Q.linearRampToValueAtTime(0.7 + lean*0.8, tN);
  if(wind.pan) wind.pan.pan.linearRampToValueAtTime(Math.max(-0.7, Math.min(0.7, -(steer || 0)*0.7)), tN);
}

/* v: speed in m/s. burn: 0 (coasting) .. 1 (mid-burn). throttle: 0..1, the GAS -- the
   motor is only audible while it is being driven, so letting off goes quiet and pressing
   gas spools it back up. A burn roars regardless. (Omitted, throttle counts as held.) */
function humLevel(v, burn, throttle){
  const b = Math.max(0, Math.min(1, burn || 0));
  const spool = Math.min(1, v/24);
  const th = throttle == null ? 1 : Math.max(0, Math.min(1, throttle));
  // at a standstill with the gas down you still hear it idle up, just quietly
  const drive = th*(0.012 + spool*0.030) + (v < 0.3 && th > 0 ? 0.006 : 0);
  return {jet: drive + b*0.055, sub: th*(0.008 + spool*0.012) + b*0.03, b, spool};
}
function setHum(v, burn, throttle){
  if(!jet || !AC) return;
  const tN = AC.currentTime + 0.06;
  const L = humLevel(v, burn, throttle);
  const b = L.b, spool = L.spool;
  jet.band.frequency.linearRampToValueAtTime(380 + spool*760 + b*900, tN);
  jet.band.Q.linearRampToValueAtTime(0.75 + b*0.9, tN);
  // the lowpass is what "opening the throttle" sounds like: the top end arrives with it
  jet.low.frequency.linearRampToValueAtTime(700 + spool*1900 + b*5200, tN);
  jet.gain.gain.linearRampToValueAtTime(Math.max(0.0001, L.jet), tN);
  jet.sub.frequency.linearRampToValueAtTime(62 + spool*26 + b*22, tN);
  jet.subGain.gain.linearRampToValueAtTime(Math.max(0.0001, L.sub), tN);
}

/* The moment a burn lights: a short upward whoosh laid over the running jet, so the
   single press has an attack of its own rather than just a louder steady state. */
function burnSound(){
  if(!AC) return;
  whenRunning(() => {
    const dest = out();
    if(!dest || !jet) return;
    const t0 = AC.currentTime;
    const src = AC.createBufferSource();
    src.buffer = jet.src.buffer;
    src.loop = true;
    const bp = AC.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.setValueAtTime(1.4, t0);
    bp.frequency.setValueAtTime(500, t0);
    bp.frequency.exponentialRampToValueAtTime(5200, t0 + 0.42);
    const g = AC.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(0.10, t0 + 0.06);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.75);
    src.connect(bp).connect(g).connect(dest);
    src.start(t0);
    src.stop(t0 + 0.8);
  });
}
/* Taking a boost cell: a short bright blip, nothing like the jet. */
function cellSound(){
  if(!AC) return;
  whenRunning(() => {
    const dest = out();
    if(!dest) return;
    const t0 = AC.currentTime;
    const o = AC.createOscillator(), g = AC.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(680, t0);
    o.frequency.exponentialRampToValueAtTime(1320, t0 + 0.09);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(0.05, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.26);
    o.connect(g).connect(dest);
    o.start(t0); o.stop(t0 + 0.28);
  });
}
function stopHum(){
  if(!jet || !AC) return;
  jet.gain.gain.linearRampToValueAtTime(0.0001, AC.currentTime + 0.1);
  jet.subGain.gain.linearRampToValueAtTime(0.0001, AC.currentTime + 0.1);
  if(wind) wind.gain.gain.linearRampToValueAtTime(0.0001, AC.currentTime + 0.1);
  if(brakeN) brakeN.gain.gain.linearRampToValueAtTime(0.0001, AC.currentTime + 0.1);
}
function brakeState(){ return brakeN; }
function humState(){ return jet; }
function windState(){ return wind; }

export { startHum, setHum, humLevel, stopHum, burnSound, cellSound, setWind, windLevel, windState,
         setBrakeSound, brakeLevel, brakeState, humState };
