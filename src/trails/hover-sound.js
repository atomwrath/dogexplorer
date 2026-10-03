/* THE HOVERBOARD'S VOICE: Neon Pups' hover running sound, under the rider, with a little wind.

   THE JET is the motor from src/neon/neon-sound.js, ported rather than imported (apps never
   import from each other): brown-ish noise on a loop through a bandpass that rides speed and a
   lowpass that opens as the board spools up, plus a sine under it for the thrust you feel rather
   than hear. Noise shaped by filters is what a turbine IS. The levels and filter sweeps are
   Neon's own; the one change is the speed they are measured against (HV.speedRef), because a
   board pushed along a trail tops out around a sprint, not at Neon's 24 m/s.

   IT IS ONLY EVER HEARD WHILE RIDING. Every voice runs through one ENVELOPE (hvEnv) that is 0 off
   the board, rises over rampUpS from the moment the pup is on, and falls over rampDownS when it
   gets off -- and the jet, the thrust sine and the wind all scale by it, so getting off takes ALL
   of it to exactly zero. (The envelope also opens the lowpass, as Neon's gas does: a turbine
   spooling up, not a volume knob.) The first version of this file rode a slow swell on the hum
   by patching an oscillator into the hum's gain PARAM; that signal adds to whatever the gain is
   scheduled at, so with the gain "off" at 0.0001 the swell still played, about 40 dB down -- the
   hover sound that would not go away after getting off. Nothing here patches into a param.

   THE WIND is noise through a bandpass, silent standing still and rising with speed. Its LEVEL
   follows speed only. Turning does not make it louder: it MODULATES it -- the band sweeps up,
   narrows, and the sound pans toward the turn.

   Everything goes through out(), so the shared mute switch and master level apply, and nothing is
   built until whenRunning() says the context has been unlocked by a gesture. Pure functions are
   exported on their own so a check can ask what the board SOUNDS like without a speaker. Every
   name here starts hv or hover: build.py flattens the modules into one scope. */
import { AC, out, whenRunning, SPEAKER_FLOOR_HZ } from '../core/audio.js';

const HV = {
  speedRef: 16,                      // m/s that counts as "full speed" for the jet (Neon: 24)
  rampUpS: 0.8, rampDownS: 0.4,      // s to spool up on getting on, and to wind down on getting off
  // the jet, as Neon's humLevel: idle + what speed adds
  jetIdle: 0.012, jetSpeed: 0.030, jetPurr: 0.006,
  subIdle: 0.008, subSpeed: 0.012,
  bandHz: 380, bandSpool: 760, bandQ: 0.75,
  lowHz: 700, lowSpool: 1900,
  subHz: 62, subSpool: 26,
  windQuiet: 1.5, windFull: 13,      // m/s where the wind starts, and where it has fully come up
  windLevel: 0.024,                  // the wind's level at full speed, however you steer
  windBaseHz: 600, windSpoolHz: 1100, windTurnHz: 900,   // its band: at rest, + what speed adds, + what a full carve adds
};

const hvClamp = (v, a, b) => Math.max(a, Math.min(b, v));
/* THE ENVELOPE. 0 off the board; up over rampUpS when somebody is riding, down over rampDownS when
   not. Returned raw (linear in time); hoverEnvGain eases it for the ear. */
function hoverEnvStep(env, dt, riding){
  const d = dt > 0 ? dt : 1/60;
  return riding ? Math.min(1, env + d/HV.rampUpS) : Math.max(0, env - d/HV.rampDownS);
}
function hoverEnvGain(env){ const e = hvClamp(env, 0, 1); return e*e*(3 - 2*e); }
function hoverSpool(v){ return hvClamp(v/HV.speedRef, 0, 1); }

/* The jet and the thrust sine at speed v under envelope gain e (0..1): Neon's humLevel. */
function hoverJetLevels(v, e){
  const s = hoverSpool(v);
  return {
    jet: e*(HV.jetIdle + s*HV.jetSpeed + (v < 0.3 ? HV.jetPurr : 0)),
    sub: e*(HV.subIdle + s*HV.subSpeed),
    bandHz: HV.bandHz + s*HV.bandSpool,
    lowHz: (HV.lowHz + s*HV.lowSpool)*(0.55 + 0.45*e),     // the top end arrives with the spool-up
    subHz: HV.subHz + s*HV.subSpool,
  };
}
/* the wind: how far it has come up with speed. Turning is accepted and IGNORED, on purpose: the
   carve is heard in the band and the pan (setHover), never in the level. */
function hoverWindSpool(v){ return hvClamp((v - HV.windQuiet)/(HV.windFull - HV.windQuiet), 0, 1); }
function hoverWindLevel(v, turn){ return hoverWindSpool(v)*HV.windLevel; }

let hvNodes = null, hvEnv = 0;
/* what the voices were last told, for the harness: built is whether the graph exists */
const HVS = { built: false, riding: false, env: 0, jet: 0, sub: 0, wind: 0, bandHz: 0, lowHz: 0, subHz: 0, windHz: 0, windQ: 0, pan: 0 };

/* Brown-ish rather than white: a running sum tilts the spectrum down about 6 dB an octave, much
   closer to a turbine and far less like a hissing tap. Scaled back towards zero each sample so
   the sum cannot wander off into a DC offset. (Neon's own.) */
function hvBrown(){
  const n = Math.floor(AC.sampleRate), buf = AC.createBuffer(1, n, AC.sampleRate), ch = buf.getChannelData(0);
  let last = 0;
  for(let i = 0; i < n; i++){ const w = Math.random()*2 - 1; last = (last + 0.035*w)/1.035; ch[i] = last*3.2; }
  return buf;
}
// pink-ish: white, lightly smoothed, so it is air and not static (the wind)
function hvAir(){
  const n = Math.floor(AC.sampleRate*1.5), buf = AC.createBuffer(1, n, AC.sampleRate), ch = buf.getChannelData(0);
  let last = 0;
  for(let i = 0; i < n; i++){ const w = Math.random()*2 - 1; last = last*0.55 + w*0.45; ch[i] = last; }
  return buf;
}
function hvBuild(){
  if(hvNodes || !AC) return;
  const dest = out(); if(!dest) return;
  const t0 = AC.currentTime;
  // ---- the jet ----
  const src = AC.createBufferSource(); src.buffer = hvBrown(); src.loop = true;
  const band = AC.createBiquadFilter(); band.type = 'bandpass';
  band.frequency.setValueAtTime(HV.bandHz, t0); band.Q.setValueAtTime(HV.bandQ, t0);
  const low = AC.createBiquadFilter(); low.type = 'lowpass'; low.frequency.setValueAtTime(HV.lowHz, t0);
  const jetGain = AC.createGain(); jetGain.gain.setValueAtTime(0, t0);
  src.connect(band).connect(low).connect(jetGain).connect(dest);
  // the body of the thrust, an octave below anything the noise is doing
  const sub = AC.createOscillator(); sub.type = 'sine'; sub.frequency.setValueAtTime(HV.subHz, t0);
  const subGain = AC.createGain(); subGain.gain.setValueAtTime(0, t0);
  sub.connect(subGain).connect(dest);
  src.start(t0 + 0.02); sub.start(t0 + 0.02);
  // ---- the wind ----
  const wsrc = AC.createBufferSource(); wsrc.buffer = hvAir(); wsrc.loop = true;
  const hi = AC.createBiquadFilter(); hi.type = 'highpass'; hi.frequency.setValueAtTime(Math.max(SPEAKER_FLOOR_HZ*1.3, 260), t0);
  const wband = AC.createBiquadFilter(); wband.type = 'bandpass';
  wband.frequency.setValueAtTime(HV.windBaseHz, t0); wband.Q.setValueAtTime(0.8, t0);
  const windGain = AC.createGain(); windGain.gain.setValueAtTime(0, t0);
  const pan = AC.createStereoPanner ? AC.createStereoPanner() : null;
  let chain = wsrc.connect(hi).connect(wband).connect(windGain);
  if(pan) chain = chain.connect(pan);
  chain.connect(dest);
  wsrc.start(t0 + 0.03);
  hvNodes = { band, low, jetGain, sub, subGain, windGain, wband, pan };
  HVS.built = true;
}

/* Every frame. riding: is somebody on the board; v: its speed in m/s; turn: -1..1, how hard it is
   being carved (+ is left); dt: the frame time in seconds, which paces the envelope. Builds the
   voices the first time a rider needs them. Off the board the envelope runs out and every gain is
   scheduled at exactly 0. */
function setHover(riding, v, turn, dt){
  HVS.riding = !!riding;
  hvEnv = hoverEnvStep(hvEnv, dt, riding);
  const e = hoverEnvGain(hvEnv), L = hoverJetLevels(v, e);
  const lean = hvClamp(Math.abs(turn || 0), 0, 1);
  HVS.env = hvEnv; HVS.jet = L.jet; HVS.sub = L.sub; HVS.bandHz = L.bandHz; HVS.lowHz = L.lowHz; HVS.subHz = L.subHz;
  HVS.wind = e*hoverWindLevel(v, turn);
  HVS.windHz = HV.windBaseHz + hoverWindSpool(v)*HV.windSpoolHz + lean*HV.windTurnHz;
  HVS.windQ = 0.7 + lean*0.9;
  HVS.pan = riding ? hvClamp(-(turn || 0)*0.7, -0.7, 0.7) : 0;
  if(riding && !hvNodes) whenRunning(hvBuild);
  if(!hvNodes || !AC) return;
  const tN = AC.currentTime + 0.06;
  hvNodes.band.frequency.linearRampToValueAtTime(L.bandHz, tN);
  hvNodes.low.frequency.linearRampToValueAtTime(L.lowHz, tN);
  hvNodes.jetGain.gain.linearRampToValueAtTime(L.jet, tN);
  hvNodes.sub.frequency.linearRampToValueAtTime(L.subHz, tN);
  hvNodes.subGain.gain.linearRampToValueAtTime(L.sub, tN);
  hvNodes.windGain.gain.linearRampToValueAtTime(HVS.wind, tN);
  hvNodes.wband.frequency.linearRampToValueAtTime(HVS.windHz, tN);
  hvNodes.wband.Q.linearRampToValueAtTime(HVS.windQ, tN);
  if(hvNodes.pan) hvNodes.pan.pan.linearRampToValueAtTime(HVS.pan, tN);
}
// test seams
function hoverSoundState(){ return HVS; }

export { HV, hoverEnvStep, hoverEnvGain, hoverSpool, hoverJetLevels, hoverWindLevel, hoverWindSpool, setHover, hoverSoundState };
