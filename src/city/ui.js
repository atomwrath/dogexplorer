/* The side panel, HUD pills, toasts and badges. */
import { clamp } from '../core/math.js';
import { LEVEL, ENV } from './world.js';
import { P, STATS, setDog, onDogChange } from '../dog/runtime.js';
import { DEFAULTS, randomPupParams } from '../dog/params.js';
import { buildLevel } from './level.js';
import { animals, scaredCount } from './animals.js';
import { grumbles } from './peeps.js';
import { carried } from './pickups.js';
import { highScores, renderScoreList } from './score.js';

/* ========================================================= PANEL */
const panel = document.getElementById('panel');
function section(title, emoji){
  const s = document.createElement('div');
  s.className = 'section';
  s.innerHTML = `<h2><span class="em">${emoji}</span>${title}</h2><div class="sec-body"></div>`;
  panel.appendChild(s);
  return s.querySelector('.sec-body');
}

/* --- Block builder --- */
const trailSec = section('Block builder', '🛠');
trailSec.insertAdjacentHTML('beforeend', `
  <div class="ctl">
    <label>Block length <span id="lenVal">140 m</span></label>
    <input type="range" id="lenSlider" min="80" max="260" step="10" value="140">
  </div>
  <div class="ctl">
    <label>Seed</label>
    <div class="seed-row">
      <input type="number" id="seedInput" min="0" max="99999" value="1234">
      <button class="btn small" id="seedDice">🎲</button>
    </div>
  </div>
  <div class="goal-chip" id="goalChip"></div>
  <div class="hint-note">Every seed lays out its own downtown — buildings, traffic, neighbors, the WANTED pest and the golden bone. Same length + seed = the same city, every time.</div>`);

let rebuildT = null;
function queueRebuild(){
  clearTimeout(rebuildT);
  rebuildT = setTimeout(buildLevel, 220);
}
document.getElementById('lenSlider').addEventListener('input', e=>{
  LEVEL.length = +e.target.value;
  document.getElementById('lenVal').textContent = LEVEL.length + ' m';
  queueRebuild();
});
document.getElementById('seedInput').addEventListener('change', e=>{
  LEVEL.seed = Math.abs(parseInt(e.target.value)||0) % 100000;
  e.target.value = LEVEL.seed;
  queueRebuild();
});
document.getElementById('seedDice').addEventListener('click', ()=>{
  LEVEL.seed = Math.floor(Math.random()*100000);
  document.getElementById('seedInput').value = LEVEL.seed;
  buildLevel();
  toast(`Seed ${LEVEL.seed} — fresh trail!`);
});

/* --- Trail box (save / import / export) --- */
const boxSec = section('Trail box', '📦');
boxSec.innerHTML = `
  <div class="io-row">
    <button class="btn small" id="saveTrailBtn">💾 Save trail</button>
    <button class="btn small" id="exportTrailsBtn">⬇ Export</button>
    <button class="btn small" id="importTrailsBtn">⬆ Import</button>
    <input type="file" id="importTrailsFile" accept=".json,application/json" style="display:none">
  </div>
  <div id="trailList"></div>
  <div class="hint-note">Saved trails live in this session — export to a <b>pup-trails.json</b> file to keep them or trade with friends.</div>`;
let savedTrails = [];
function trailName(t){
  return `🏙 Downtown · ${t.length}m · #${t.seed}`;
}
function renderTrailList(){
  const list = document.getElementById('trailList');
  list.innerHTML = '';
  if(!savedTrails.length){
    list.innerHTML = '<div class="pup-empty">No trails saved yet.</div>';
    return;
  }
  savedTrails.forEach((tr, i)=>{
    const chip = document.createElement('div');
    chip.className = 'pup-chip';
    chip.innerHTML = `<div class="dot">🏙</div><div class="nm"></div><button class="del">✕</button>`;
    chip.querySelector('.nm').textContent = tr.name || trailName(tr);
    chip.addEventListener('click', e=>{
      if(e.target.classList.contains('del')) return;
      LEVEL.length = tr.length; LEVEL.seed = tr.seed;
      document.getElementById('lenSlider').value = tr.length;
      document.getElementById('lenVal').textContent = tr.length + ' m';
      document.getElementById('seedInput').value = tr.seed;
      buildLevel();
      toast('Trail loaded!');
    });
    chip.querySelector('.del').addEventListener('click', ()=>{
      savedTrails.splice(i,1);
      renderTrailList();
    });
    list.appendChild(chip);
  });
}
document.getElementById('saveTrailBtn').addEventListener('click', ()=>{
  const tr = {env:'city', length:LEVEL.length, seed:LEVEL.seed};
  tr.name = trailName(tr);
  if(savedTrails.some(s=> s.env===tr.env && s.length===tr.length && s.seed===tr.seed)){
    toast('That trail is already in the box.');
    return;
  }
  savedTrails.push(tr);
  renderTrailList();
  toast('Trail saved to the box!');
});
document.getElementById('exportTrailsBtn').addEventListener('click', ()=>{
  const list = savedTrails.length ? savedTrails
    : [{env:'city', length:LEVEL.length, seed:LEVEL.seed, name:trailName(LEVEL)}];
  const blob = new Blob([JSON.stringify({pupTrails:1, trails:list, scores:highScores}, null, 2)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'pup-trails.json';
  a.click();
  URL.revokeObjectURL(a.href);
  toast(savedTrails.length ? 'Trail box exported!' : 'Current trail exported!');
});
document.getElementById('importTrailsBtn').addEventListener('click', ()=> document.getElementById('importTrailsFile').click());
document.getElementById('importTrailsFile').addEventListener('change', e=>{
  const file = e.target.files[0];
  if(!file) return;
  const rd = new FileReader();
  rd.onload = ()=>{
    try{
      const data = JSON.parse(rd.result);
      const list = data.trails || (Array.isArray(data)? data : [data]);
      let n = 0;
      list.forEach(tr=>{
        if(tr && tr.env === 'city' && tr.length >= 40 && tr.length <= 400 && Number.isFinite(+tr.seed)){
          const clean = {env:'city', length:clamp(Math.round(tr.length/10)*10, 80, 260), seed:Math.abs(+tr.seed|0)%100000, name:tr.name};
          if(!savedTrails.some(s=> s.env===clean.env && s.length===clean.length && s.seed===clean.seed)){
            savedTrails.push(clean); n++;
          }
        }
      });
      let ns = 0;
      if(data.scores && typeof data.scores === 'object'){
        for(const [key, rec] of Object.entries(data.scores)){
          const parts = key.split(':');
          if(parts.length===3 && parts[0]==='city' && rec && Number.isFinite(+rec.score)){
            if(!highScores[key] || +rec.score > highScores[key].score){
              highScores[key] = {score:+rec.score, time:+rec.time||0, pup:String(rec.pup||'?').slice(0,24), medal:String(rec.medal||'🎗').slice(0,4)};
              ns++;
            }
          }
        }
        if(ns) renderScoreList();
      }
      renderTrailList();
      toast((n||ns) ? `Imported ${n} trail${n===1?'':'s'} + ${ns} record${ns===1?'':'s'}!` : 'No new trails in that file.');
    }catch(err){ toast('That file could not be read.'); }
  };
  rd.readAsText(file);
  e.target.value = '';
});

/* --- High scores --- */
const scoreSec = section('High scores', '🏆');
scoreSec.innerHTML = `
  <div id="scoreList"></div>
  <div class="hint-note">Best score for every trail you finish, this session. They ride along in <b>pup-trails.json</b> when you export, so your records travel with your trails.</div>`;

/* --- Your explorer --- */
const pupSec = section('Your explorer', '🐶');
pupSec.innerHTML = `
  <div class="io-row">
    <button class="btn small" id="importBtn">⬆ Import pups</button>
    <button class="btn small" id="randBtn">🎲 Random pup</button>
    <input type="file" id="importFile" accept=".json,application/json" style="display:none">
  </div>
  <div id="pupList"></div>
  <div class="hint-note">Import <b>backyard-pups.json</b> from the Dog Character Creator, then pick who runs today.</div>`;
let importedPups = [];
let selectedIdx = -1;
function renderPupList(){
  const list = document.getElementById('pupList');
  list.innerHTML = '';
  if(!importedPups.length){
    list.innerHTML = '<div class="pup-empty">No pups imported — running with a random pup.</div>';
    return;
  }
  importedPups.forEach((s, i)=>{
    const chip = document.createElement('div');
    chip.className = 'pup-chip' + (i===selectedIdx ? ' sel' : '');
    chip.innerHTML = `<div class="dot"></div><div class="nm"></div><div class="sz"></div>`;
    chip.querySelector('.dot').style.background =
      `linear-gradient(135deg, ${s.furColor} 55%, ${s.bellyColor} 56%)`;
    chip.querySelector('.nm').textContent = s.name;
    const n = clamp((s.size-0.55)/1.05, 0, 1);
    chip.querySelector('.sz').textContent = n < 0.33 ? 'small' : n < 0.66 ? 'medium' : 'BIG';
    chip.addEventListener('click', ()=>{
      selectedIdx = i;
      setDog(s);
      renderPupList();
      toast(`${s.name} laced up and ready!`);
    });
    list.appendChild(chip);
  });
}
document.getElementById('importBtn').addEventListener('click', ()=> document.getElementById('importFile').click());
document.getElementById('importFile').addEventListener('change', e=>{
  const file = e.target.files[0];
  if(!file) return;
  const rd = new FileReader();
  rd.onload = ()=>{
    try{
      const data = JSON.parse(rd.result);
      const pups = data.pups || (Array.isArray(data)? data : [data]);
      let n = 0;
      pups.forEach(pp=>{
        const params = pp.params || pp;
        if(params && params.furColor){
          importedPups.push(Object.assign({}, DEFAULTS, params));
          n++;
        }
      });
      if(n){
        selectedIdx = importedPups.length - 1;
        setDog(importedPups[selectedIdx]);
      }
      renderPupList();
      toast(n ? `Imported ${n} pup${n>1?'s':''}!` : 'No pups found in that file.');
    }catch(err){ toast('That file could not be read.'); }
  };
  rd.readAsText(file);
  e.target.value = '';
});
document.getElementById('randBtn').addEventListener('click', ()=>{
  selectedIdx = -1;
  setDog(randomPupParams());
  renderPupList();
  toast(`Meet ${P.name}, a brand new pup!`);
});

/* --- Trail stats --- */
const statSec = section('Trail stats', '📊');
statSec.innerHTML = `
  <div class="stat speed"><label>Speed<span id="svSpeed"></span></label><div class="track"><div class="fill" id="sbSpeed"></div></div></div>
  <div class="stat agi"><label>Agility<span id="svAgi"></span></label><div class="track"><div class="fill" id="sbAgi"></div></div></div>
  <div class="stat scare"><label>Intimidation<span id="svScare"></span></label><div class="track"><div class="fill" id="sbScare"></div></div></div>
  <div class="hint-note"><b>Small pups</b> fly down the trail but barely rattle the wildlife — perfect for quiet hikes. <b>Big pups</b> are slow, but pests scatter a mile away. Pick the right dog for the job! The glowing ring is your <b>scare bubble</b> — animals inside it get spooked. It grows when you run or bark, shrinks when you <b>sneak (C)</b>. Scare strays for points, but startling <b>people or their pups costs you</b>. <b>E chomps</b> — grab the 🦴 golden bone and carry it to the finish. Big dogs can <b>wade the canal</b>; everyone else crosses at an avenue.</div>`;
function updateStatsUI(){
  if(!document.getElementById('sbSpeed')) return;
  const S = STATS;
  const spPct = Math.round(((S.run - 5.4) / 2.7) * 100);
  const agPct = Math.round(((S.turn - 7) / 8) * 100);
  const scPct = Math.round((S.scarePower / 10) * 100);
  document.getElementById('sbSpeed').style.width = clamp(spPct,6,100) + '%';
  document.getElementById('sbAgi').style.width = clamp(agPct,6,100) + '%';
  document.getElementById('sbScare').style.width = clamp(scPct,6,100) + '%';
  document.getElementById('svSpeed').textContent = S.run.toFixed(1) + ' m/s';
  document.getElementById('svAgi').textContent = ['clumsy','steady','nimble','zoomy'][Math.min(3, Math.floor(clamp(agPct,0,99)/26))];
  document.getElementById('svScare').textContent = S.scarePower.toFixed(1) + ' / 10';
}

/* ---------- toast + badges + HUD ---------- */
let toastT = null;
function toast(msg){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(()=> t.classList.remove('show'), 1900);
}
function updateBadges(){
  if(!P) return;
  const info = `🏙 ${LEVEL.length}m · #${LEVEL.seed}`;
  document.getElementById('lobbyBadge').textContent = `🐶 ${P.name} · ${info}`;
  document.getElementById('playName').textContent = `🐶 ${P.name} · ${info}`;
  document.getElementById('goalChip').textContent = `${ENV.goal}  ·  ⭐ wanted: ${LEVEL.wantedNm||'?'}`;
}
function fmtTime(s){
  const m = Math.floor(s/60);
  return `${m}:${(s - m*60).toFixed(1).padStart(4,'0')}`;
}
function updateHud(){
  document.getElementById('hudScare').textContent = `😱 ${scaredCount}/${LEVEL.total}`;
  document.getElementById('hudOops').textContent = `😠 ${grumbles}`;
  const star = LEVEL.wantedGot ? '⭐✓' : '⭐';
  const bone = (carried && carried.kind==='bone') ? '🦴…' : (LEVEL.boneBanked ? '🦴✓' : '🦴');
  document.getElementById('hudBonus').textContent = `${star} ${bone}`;
}

export { panel, section, toast, updateBadges, fmtTime, updateHud, updateStatsUI,
         renderTrailList, renderPupList, queueRebuild, savedTrails };
