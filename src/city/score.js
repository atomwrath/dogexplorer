/* High-score table, keyed by block length + seed. */
import { LEVEL } from './world.js';
import { clamp } from '../core/math.js';
import { buildLevel } from './level.js';
import { toast } from './ui.js';

/* ---------- high scores ---------- */
let highScores = {};
function scoreKey(){ return `city:${LEVEL.length}:${LEVEL.seed}`; }
function renderScoreList(){
  const list = document.getElementById('scoreList');
  if(!list) return;
  list.innerHTML = '';
  const entries = Object.entries(highScores);
  if(!entries.length){
    list.innerHTML = '<div class="pup-empty">Run a trail to set your first record!</div>';
    return;
  }
  entries
    .sort((a,b)=> b[1].score - a[1].score)
    .slice(0, 10)
    .forEach(([key, rec])=>{
      const [env, length, seed] = key.split(':');
      const chip = document.createElement('div');
      chip.className = 'pup-chip';
      chip.innerHTML = `<div class="dot">${rec.medal}</div><div class="nm"></div><div class="sz"></div>`;
      chip.querySelector('.nm').textContent = `🏙 ${length}m #${seed} · ${rec.pup}`;
      chip.querySelector('.sz').textContent = rec.score;
      chip.addEventListener('click', ()=>{
        LEVEL.length = +length; LEVEL.seed = +seed;
        document.getElementById('lenSlider').value = LEVEL.length;
        document.getElementById('lenVal').textContent = LEVEL.length + ' m';
        document.getElementById('seedInput').value = LEVEL.seed;
        buildLevel();
        toast('Record trail loaded — beat it!');
      });
      list.appendChild(chip);
    });
}

export { highScores, scoreKey, renderScoreList };
