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
  });
}

/* v: speed in m/s. burn: 0 (coasting) .. 1 (mid-burn). */
function setHum(v, burn){
  if(!jet || !AC) return;
  const tN = AC.currentTime + 0.04;
  const b = Math.max(0, Math.min(1, burn || 0));
  const spool = Math.min(1, v/24);
  jet.band.frequency.linearRampToValueAtTime(380 + spool*760 + b*900, tN);
  jet.band.Q.linearRampToValueAtTime(0.75 + b*0.9, tN);
  // the lowpass is what "opening the throttle" sounds like: the top end arrives with it
  jet.low.frequency.linearRampToValueAtTime(700 + spool*1900 + b*5200, tN);
  jet.gain.gain.linearRampToValueAtTime(v < 0.3 && b <= 0 ? 0.0001
    : 0.012 + spool*0.030 + b*0.055, tN);
  jet.sub.frequency.linearRampToValueAtTime(62 + spool*26 + b*22, tN);
  jet.subGain.gain.linearRampToValueAtTime(v < 0.3 ? 0.0001 : 0.008 + spool*0.012 + b*0.03, tN);
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
}

export { startHum, setHum, stopHum, burnSound, cellSound };
