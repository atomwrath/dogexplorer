/* All sound effects. Web Audio only — no asset files to load. */
import { P } from '../dog/runtime.js';

/* ========================================================= AUDIO */
let AC = null;
function initAudio(){
  if(!AC){ try{ AC = new (window.AudioContext || window.webkitAudioContext)(); }catch(e){} }
  if(AC && AC.state === 'suspended') AC.resume();
}
function woofBurst(when, pitchMul, dur=0.14){
  if(!AC) return;
  const o = AC.createOscillator(), f = AC.createBiquadFilter(), gn = AC.createGain();
  o.type = 'sawtooth';
  const base = 320 * pitchMul;
  o.frequency.setValueAtTime(base, when);
  o.frequency.exponentialRampToValueAtTime(base*0.28, when+dur);
  f.type = 'lowpass';
  f.frequency.setValueAtTime(900*pitchMul, when);
  f.frequency.exponentialRampToValueAtTime(240, when+dur);
  f.Q.value = 4;
  gn.gain.setValueAtTime(0.0001, when);
  gn.gain.exponentialRampToValueAtTime(0.5, when+0.015);
  gn.gain.exponentialRampToValueAtTime(0.0001, when+dur);
  o.connect(f).connect(gn).connect(AC.destination);
  o.start(when); o.stop(when+dur+0.02);
}
function yip(pitch){
  initAudio();
  if(!AC || !P) return;
  woofBurst(AC.currentTime, pitch/Math.sqrt(P.size), 0.09);
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
  initAudio(); if(!AC) return;
  const src = AC.createBufferSource(); src.buffer = getNoise();
  const f = AC.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 320; f.Q.value = 1.2;
  const gn = AC.createGain();
  const tN = AC.currentTime;
  gn.gain.setValueAtTime(0.5, tN);
  gn.gain.exponentialRampToValueAtTime(0.0001, tN+0.35);
  src.connect(f).connect(gn).connect(AC.destination);
  src.start(tN); src.stop(tN+0.36);
}
function thudSound(){
  initAudio(); if(!AC) return;
  const o = AC.createOscillator(), gn = AC.createGain();
  const tN = AC.currentTime;
  o.type = 'sine';
  o.frequency.setValueAtTime(150, tN);
  o.frequency.exponentialRampToValueAtTime(55, tN+0.16);
  gn.gain.setValueAtTime(0.35, tN);
  gn.gain.exponentialRampToValueAtTime(0.0001, tN+0.18);
  o.connect(gn).connect(AC.destination);
  o.start(tN); o.stop(tN+0.2);
}
function splashSound(){
  initAudio(); if(!AC) return;
  const src = AC.createBufferSource(); src.buffer = getNoise();
  const f = AC.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1400; f.Q.value = 0.8;
  const gn = AC.createGain();
  const tN = AC.currentTime;
  f.frequency.exponentialRampToValueAtTime(500, tN+0.3);
  gn.gain.setValueAtTime(0.45, tN);
  gn.gain.exponentialRampToValueAtTime(0.0001, tN+0.35);
  src.connect(f).connect(gn).connect(AC.destination);
  src.start(tN); src.stop(tN+0.36);
}
function honkSound(){
  initAudio(); if(!AC) return;
  const tN = AC.currentTime;
  [392, 494].forEach(fr=>{
    const o = AC.createOscillator(), gn = AC.createGain();
    o.type = 'square'; o.frequency.value = fr;
    gn.gain.setValueAtTime(0.12, tN);
    gn.gain.setValueAtTime(0.12, tN+0.14);
    gn.gain.exponentialRampToValueAtTime(0.0001, tN+0.2);
    o.connect(gn).connect(AC.destination);
    o.start(tN); o.stop(tN+0.22);
  });
}
function chompSound(){
  initAudio(); if(!AC) return;
  const tN = AC.currentTime;
  const o = AC.createOscillator(), gn = AC.createGain();
  o.type = 'square';
  o.frequency.setValueAtTime(210, tN);
  o.frequency.exponentialRampToValueAtTime(70, tN+0.07);
  gn.gain.setValueAtTime(0.3, tN);
  gn.gain.exponentialRampToValueAtTime(0.0001, tN+0.09);
  o.connect(gn).connect(AC.destination);
  o.start(tN); o.stop(tN+0.1);
}
function grumbleSound(){
  initAudio(); if(!AC) return;
  const tN = AC.currentTime;
  const o = AC.createOscillator(), gn = AC.createGain();
  o.type = 'sawtooth';
  o.frequency.setValueAtTime(180, tN);
  o.frequency.linearRampToValueAtTime(120, tN+0.24);
  gn.gain.setValueAtTime(0.14, tN);
  gn.gain.exponentialRampToValueAtTime(0.0001, tN+0.26);
  o.connect(gn).connect(AC.destination);
  o.start(tN); o.stop(tN+0.28);
}
function yipHigh(){
  initAudio(); if(!AC) return;
  woofBurst(AC.currentTime, 2.4, 0.07);
}
function cheerBlip(){
  initAudio(); if(!AC) return;
  const tN = AC.currentTime;
  [659, 880].forEach((fr,i)=>{
    const o = AC.createOscillator(), gn = AC.createGain();
    o.type = 'triangle'; o.frequency.value = fr;
    gn.gain.setValueAtTime(0.0001, tN+i*0.08);
    gn.gain.exponentialRampToValueAtTime(0.2, tN+i*0.08+0.02);
    gn.gain.exponentialRampToValueAtTime(0.0001, tN+i*0.08+0.22);
    o.connect(gn).connect(AC.destination);
    o.start(tN+i*0.08); o.stop(tN+i*0.08+0.24);
  });
}
function cheerSound(){
  initAudio(); if(!AC) return;
  const tN = AC.currentTime;
  [523, 659, 784, 1047].forEach((fr, i)=>{
    const o = AC.createOscillator(), gn = AC.createGain();
    o.type = 'triangle';
    o.frequency.value = fr;
    gn.gain.setValueAtTime(0.0001, tN+i*0.09);
    gn.gain.exponentialRampToValueAtTime(0.22, tN+i*0.09+0.02);
    gn.gain.exponentialRampToValueAtTime(0.0001, tN+i*0.09+0.3);
    o.connect(gn).connect(AC.destination);
    o.start(tN+i*0.09); o.stop(tN+i*0.09+0.32);
  });
}

export { AC, initAudio, woofBurst, yip, huffSound, thudSound, splashSound,
         honkSound, chompSound, grumbleSound, yipHigh, cheerBlip, cheerSound };
