/* The board's motor: one sawtooth through a lowpass, pitched by speed. Everything else
   (count pips, the go tone, the bumper bonk, the finish cheer) is core/audio.js as is.
   Routed through out(), so the shared mute switch and master level apply. */
import { AC, out, whenRunning } from '../core/audio.js';

let humOsc = null, humGain = null, humFilt = null;

function startHum(){
  if(humOsc) return;
  whenRunning(() => {
    if(humOsc || !AC) return;
    const dest = out();
    if(!dest) return;
    humOsc = AC.createOscillator(); humFilt = AC.createBiquadFilter(); humGain = AC.createGain();
    humOsc.type = 'sawtooth';
    humOsc.frequency.setValueAtTime(180, AC.currentTime);
    humFilt.type = 'lowpass';
    humFilt.frequency.setValueAtTime(700, AC.currentTime);
    humGain.gain.setValueAtTime(0.0001, AC.currentTime);
    humOsc.connect(humFilt).connect(humGain).connect(dest);
    humOsc.start(AC.currentTime + 0.02);
  });
}
function setHum(v, boosting){
  if(!humOsc || !AC) return;
  const tN = AC.currentTime + 0.03;
  // 180 Hz up: a tablet speaker rolls off hard below that (see SPEAKER_FLOOR_HZ)
  humOsc.frequency.linearRampToValueAtTime(180 + v*9 + (boosting ? 60 : 0), tN);
  humFilt.frequency.linearRampToValueAtTime(600 + v*55, tN);
  humGain.gain.linearRampToValueAtTime(v < 0.3 ? 0.0001 : 0.018 + Math.min(0.03, v*0.0012), tN);
}
function stopHum(){
  if(!humOsc || !AC) return;
  humGain.gain.linearRampToValueAtTime(0.0001, AC.currentTime + 0.08);
}

export { startHum, setHum, stopHum };
