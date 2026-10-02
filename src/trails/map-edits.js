/* Edits made to a map's own data from inside the game.

   Only trail and road NAMES can be changed so far, but everything here speaks in
   "property patches" -- {name:'Palmer Trail'} -- rather than in names, so the next thing
   worth editing (a surface, a one-way flag) is another key in the same patch and not a
   second mechanism.

   WHERE AN EDIT LIVES. The map is a static file served from GitHub Pages and the game can
   never write to it. So an edit is made in three places, each for its own reason:
     1. the GeoJSON feature itself, in memory (patchFeature) -- that is what makes the
        next rebuildWorld, and the exported file, carry the change;
     2. localStorage, filed per map (saveEdits) -- so closing the tab does not lose it;
     3. the downloaded file (world.js's getMapBundleJSON) -- the only copy that can go
        back into the repo.
   Stored edits are reapplied whenever the map loads (applyEdits). An edit the freshly
   loaded file already agrees with is dropped from storage there, so once the repo has the
   downloaded file the browser stops carrying a copy of it.

   The keys are the OSM way id the feature came from where it has one: the feature's
   position in its layer would move the moment the data was regenerated from OSM, taking
   every stored edit onto the wrong way. */

import { ptSeg } from './geo.js';

const PREFIX = 'pupMapEdits:';
/* The same keys, in the same order, that geo.js's parseFeatures reads a name from. A
   rename has to land on the key that is actually being read, or it changes nothing. */
const NAME_KEYS = ['name', 'NAME', 'Name', 'title', 'trail', 'Trail', 'label'];

function featureName(f){
  const p = (f && f.properties) || {};
  for(const k of NAME_KEYS){ const v = p[k]; if(v != null && String(v).trim()) return String(v).trim(); }
  return '';
}

/* A key for a feature that survives a reload and does not depend on where in the file it
   sits. Falls back to the two end coordinates for hand-drawn data with no ids. */
function featureKey(f){
  const p = (f && f.properties) || {};
  if(p.full_id) return String(p.full_id);
  if(p.osm_id != null && p.osm_id !== '') return (p.osm_type ? String(p.osm_type)[0] : '') + p.osm_id;
  let c = f && f.geometry && f.geometry.coordinates;
  const ends = [];
  const walk = a => {
    if(!Array.isArray(a)) return;
    if(typeof a[0] === 'number'){ ends.push(a); return; }
    a.forEach(walk);
  };
  walk(c);
  if(!ends.length) return null;
  const q = v => (+v[0]).toFixed(6) + ',' + (+v[1]).toFixed(6);
  return 'c:' + q(ends[0]) + '>' + q(ends[ends.length - 1]);
}

/* Write one patch into a feature's properties. Returns true when anything changed. */
function patchFeature(f, patch){
  if(!f || !patch) return false;
  const p = f.properties || (f.properties = {});
  let changed = false;
  for(const k of Object.keys(patch)){
    if(k === 'name'){
      const want = String(patch.name == null ? '' : patch.name).trim();
      if(featureName(f) === want) continue;
      if(!want){
        // clearing: every key that currently supplies a name has to go, or the next one
        // down the list would start supplying it instead
        for(const nk of NAME_KEYS) if(p[nk] != null && String(p[nk]).trim()) p[nk] = '';
      }else{
        const hit = NAME_KEYS.find(nk => p[nk] != null && String(p[nk]).trim());
        p[hit || 'name'] = want;
      }
      changed = true;
    }else if(p[k] !== patch[k]){
      p[k] = patch[k]; changed = true;
    }
  }
  return changed;
}

function matches(f, patch){
  for(const k of Object.keys(patch)){
    if(k === 'name' ? featureName(f) !== String(patch.name || '').trim() : (f.properties || {})[k] !== patch[k]) return false;
  }
  return true;
}

function loadEdits(mapId){
  try{
    const raw = localStorage.getItem(PREFIX + mapId);
    const o = raw ? JSON.parse(raw) : null;
    return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
  }catch(err){ return {}; }
}
function saveEdits(mapId, edits){
  try{
    if(edits && Object.keys(edits).length) localStorage.setItem(PREFIX + mapId, JSON.stringify(edits));
    else localStorage.removeItem(PREFIX + mapId);
  }catch(err){ /* private mode or quota: the edit still holds for this session */ }
}

/* Reapply stored edits to freshly loaded layers. Returns {applied, edits}, where `edits`
   is what is still worth keeping: an edit the file already agrees with is dropped. Call it
   on data straight off the network and not on data that has been edited this session --
   there, every edit "already agrees" and would be dropped the moment it was made. */
function applyEdits(layers, edits){
  const keep = Object.assign({}, edits);
  let applied = 0;
  for(const layer of layers || []){
    for(const f of (layer && layer.features) || []){
      const key = featureKey(f);
      const patch = key && edits[key];
      if(!patch) continue;
      if(matches(f, patch)) delete keep[key];
      else if(patchFeature(f, patch)) applied++;
    }
  }
  return {applied, edits: keep};
}

/* What to CALL a way on screen: its name, or an honest word for it when it has none. Every
   place that prints a trail name goes through this, so "unknown" is spelled one way. */
function edgeLabel(e){
  if(e && e.name) return e.name;
  const k = e && e.kind;
  return (k==='road' || k==='dirtroad') ? 'Unknown road' : 'Unknown trail';
}

/* ---------- which map feature an edge came from ----------
   The graph builder (geo.js) is shared with Neon Pups and is deliberately left alone, so it
   neither remembers which GeoJSON feature a line came from nor lets an unnamed way stay
   unnamed. Both are recovered here, from outside it:

   lineKey/indexLineFeatures tie each raw line parseFeatures returns back to its feature
   (the same coordinates, parsed the same way); linkEdgesToFeatures then ties each finished
   graph edge to the projected line it was cut from, by where it lies. An edge's own
   vertices are the line's vertices, kept by the simplifier, so it lies along its source to
   within the simplify tolerance; the name and kind narrow the candidates first, so two
   different ways that happen to run together are not mistaken for one another. */
function lineKey(pts){
  const a = pts[0], b = pts[pts.length - 1];
  return pts.length + '|' + (+a[0]) + ',' + (+a[1]) + '|' + (+b[0]) + ',' + (+b[1]);
}
function indexLineFeatures(layer){
  const m = new Map();
  for(const f of (layer && layer.features) || []){
    const g = f && f.geometry;
    if(!g || (g.type !== 'LineString' && g.type !== 'MultiLineString')) continue;
    const parts = g.type === 'LineString' ? [g.coordinates] : g.coordinates;
    for(const part of parts){
      if(!part || part.length < 2) continue;
      const k = lineKey(part);
      if(!m.has(k)) m.set(k, f);
    }
  }
  return m;
}

function alongPoints(pts){
  // three sample points spread along a polyline, by vertex count then within a segment
  const out = [];
  const n = pts.length;
  for(const f of [0.25, 0.5, 0.75]){
    const t = f * (n - 1), i = Math.min(n - 2, Math.floor(t)), u = t - i;
    out.push([pts[i][0] + (pts[i+1][0] - pts[i][0]) * u, pts[i][1] + (pts[i+1][1] - pts[i][1]) * u]);
  }
  return out;
}
function nearLine(p, pts){
  let best = Infinity;
  for(let i = 0; i + 1 < pts.length; i++){
    const d = ptSeg(p, pts[i], pts[i+1]).d;
    if(d < best) best = d;
  }
  return best;
}

/* Sets `feat` on every edge it can place within `tol` of a source line, and leaves it null
   on the rest. Returns how many it could not place. */
function linkEdgesToFeatures(edges, lines, tol){
  const info = lines.map(L => {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for(const p of L.pts){ if(p[0]<x0)x0=p[0]; if(p[0]>x1)x1=p[0]; if(p[1]<z0)z0=p[1]; if(p[1]>z1)z1=p[1]; }
    return {L, x0, x1, z0, z1, name: L.name || '', kind: L.kind || 'trail'};
  });
  let missed = 0;
  for(const e of edges){
    e.feat = null;
    if(!e.pts || e.pts.length < 2) { missed++; continue; }
    const samples = alongPoints(e.pts);
    const kind = e.kind || 'trail';
    // the name the edge was built from: a real name, or none (nicknames are blanked after)
    const want = e.named ? e.name : '';
    for(const strict of [true, false]){
      let best = null;
      for(const c of info){
        if(strict && (c.kind !== kind || c.name !== want)) continue;
        if(samples.some(p => p[0] < c.x0 - tol || p[0] > c.x1 + tol || p[1] < c.z0 - tol || p[1] > c.z1 + tol)) continue;
        let worst = 0, sum = 0;
        for(const p of samples){ const d = nearLine(p, c.L.pts); sum += d; if(d > worst) worst = d; }
        if(worst <= tol && (!best || sum < best.sum)) best = {c, sum};
      }
      if(best){ e.feat = best.c.L.feat || null; break; }
    }
    if(!e.feat) missed++;
  }
  return missed;
}

export { featureKey, featureName, patchFeature, loadEdits, saveEdits, applyEdits,
         edgeLabel, lineKey, indexLineFeatures, linkEdgesToFeatures };
