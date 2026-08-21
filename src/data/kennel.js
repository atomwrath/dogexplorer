/* The kennel: kennelPups the player has made, shared across every app in the suite.
   Until now a pup could only travel between apps as a downloaded backyard-kennelPups.json
   the player re-imported by hand; the creator's own saves were in-memory and died with
   the tab. This is the one place that persists them.

   Sits in data/ because it is the bottom of the dependency chain -- it imports nothing,
   not even DEFAULTS. It stores whatever param objects it is handed and leaves merging
   with DEFAULTS to the caller (dog/params.js is *above* data/, and reaching up would
   invert the arrow). That also keeps the stored shape a plain, versioned data record
   rather than a snapshot of whatever DEFAULTS happened to be that week.

   `kennelPups` is exported as a live array and is ALWAYS cleared in place, never reassigned:
   other modules hold this same reference, and reassigning would silently orphan them. */

const KEY = 'dogexplorer.kennel';
const VERSION = 1;

const kennelPups = [];              // [{ name, params }] -- live binding, mutate in place
const listeners = [];

function onKennelChange(fn){ listeners.push(fn); }
function notify(){ for(const fn of listeners) fn(kennelPups); }

/* localStorage throws rather than returning null in Safari private mode and in some
   embedded webviews, and the whole feature is a nicety -- never let it break the game. */
function readStore(){
  try{ return JSON.parse(localStorage.getItem(KEY) || 'null'); }
  catch(err){ console.warn('kennel: could not read saved kennelPups', err); return null; }
}
function writeStore(payload){
  try{ localStorage.setItem(KEY, JSON.stringify(payload)); return true; }
  catch(err){ console.warn('kennel: could not save kennelPups', err); return false; }
}

/* Migration chain, one step per version bump. Unknown-but-newer records are dropped
   rather than guessed at, so a downgrade can't corrupt a save. */
function migrate(rec){
  if(!rec || typeof rec !== 'object') return null;
  if(!rec.version || rec.version > VERSION) return null;
  return rec;
}

function loadKennel(){
  const rec = migrate(readStore());
  kennelPups.length = 0;
  if(rec && Array.isArray(rec.pups)) kennelPups.push(...rec.pups.filter(isPup));
  notify();
  return kennelPups;
}

function saveKennel(){
  const ok = writeStore({version:VERSION, pups:kennelPups});
  notify();
  return ok;
}

function isPup(p){
  return !!(p && p.params && typeof p.params === 'object' && p.params.furColor);
}

/* Name is the identity, matching how the creator's own save list already behaves:
   saving a pup twice under one name updates it instead of piling up duplicates. */
function addPups(list){
  let n = 0;
  for(const raw of (list || [])){
    const params = raw && (raw.params || raw);
    if(!params || !params.furColor) continue;
    const entry = {name: String(params.name || 'Pup').slice(0,24), params};
    const at = kennelPups.findIndex(p => p.name === entry.name);
    if(at >= 0) kennelPups[at] = entry; else kennelPups.push(entry);
    n++;
  }
  if(n) saveKennel();
  return n;
}

function removePup(i){
  if(i < 0 || i >= kennelPups.length) return false;
  kennelPups.splice(i, 1);
  saveKennel();
  return true;
}

function setKennelPups(list){
  kennelPups.length = 0;
  addPups(list);
  saveKennel();
  return kennelPups.length;
}

/* Accepts every shape the suite has ever written or read: the creator's
   {backyardPups:1, pups:[{params}]} export, a bare array, or a single pup object.
   Returns plain param objects; callers merge DEFAULTS themselves. */
function parsePupFile(data){
  let obj = data;
  if(typeof obj === 'string'){
    try{ obj = JSON.parse(obj); }catch(err){ return []; }
  }
  if(!obj) return [];
  const list = obj.pups || (Array.isArray(obj) ? obj : [obj]);
  return list.map(p => (p && p.params) || p).filter(p => p && p.furColor);
}

export { kennelPups, loadKennel, saveKennel, addPups, setKennelPups, removePup, parsePupFile, onKennelChange };
