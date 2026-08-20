/* size -> handling stats */
import { clamp } from '../core/math.js';

function computeStats(size){
  const n = clamp((size - 0.55) / 1.05, 0, 1);
  return {
    n,
    walk: 3.6 - 1.0*n,
    run:  8.1 - 2.7*n,
    accel: 15 - 7*n,
    turn:  15 - 8*n,
    jumpV: 9.6 - 2.2*n,
    scareRadius: 3.2 + 5.4*n,
    scarePower:  1.2 + 8.8*n,
  };
}

export { computeStats };
