/* Camera shake, owned in one place so any system can kick it. */
let shakeT = 0;
function setShake(v){ shakeT = Math.max(shakeT, v); }
function decayShake(dt){ shakeT = Math.max(0, shakeT - dt); }

export { shakeT, setShake, decayShake };
