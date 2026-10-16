#!/usr/bin/env python3
"""Each elevation-download assertion (src/trails/dem-fetch.js and the panel in main.js) gets a
targeted revert: break exactly the line it claims to protect, rebuild, run the elevation checks,
and confirm THAT check goes red. A check that stays green against the bug it names is not
evidence. Usage (from the repo root):

    python3 tools/revert-dem.py              # every revert
    python3 tools/revert-dem.py "rebuild"    # only reverts whose label or check contains that

It runs `SMOKE_ONLY=dem node tools/smoke.js`, which is the elevation checks alone (a dozen
seconds a revert, not the full suite's two minutes). Needs jsdom, as the smoke suite does.

The sources are restored from memory after every revert (and at the end, via finally). If the
run is killed halfway, `git checkout -- src trails` is the way back, then rebuild."""
import subprocess, os, sys, signal
sys.stdout.reconfigure(line_buffering=True)
# a kill must still restore the sources: SystemExit unwinds through the finally below
signal.signal(signal.SIGTERM, lambda *a: sys.exit(143))
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DF, MN, HT = 'src/trails/dem-fetch.js', 'src/trails/main.js', 'trails/index.html'
FILES = [DF, MN, HT]
BACKUP = {f: open(os.path.join(ROOT, f), encoding='utf-8').read() for f in FILES}
PLAN = "the elevation plan agrees with fetch_dem.py"
ALIGN = "the built heightfield lines up with the projection"
REVERTS = [
  # ---- the plan: the numbers fetch_dem.py would print ----
  ("origin at the north edge, not the middle of the files", DF,
   "const lon0 = (b.minLon + b.maxLon)/2, lat0 = (b.minLat + b.maxLat)/2;",
   "const lon0 = (b.minLon + b.maxLon)/2, lat0 = b.maxLat;", PLAN),
  ("no margin around the files", DF, "const DEM_MARGIN_M = 100;", "const DEM_MARGIN_M = 0;", PLAN),
  ("zoom chosen for pixels as coarse as the cells", DF,
   "const target = cell/(oversample || 2);", "const target = cell/(oversample || 1);", PLAN),
  # ---- the heightfield: where each number lands ----
  ("rows read from the wrong side of the origin (z north)", DF,
   "const lat = plan.lat0 - (plan.minZ + (j + 0.5)*cell)/plan.mLat;",
   "const lat = plan.lat0 + (plan.minZ + (j + 0.5)*cell)/plan.mLat;", ALIGN),
  ("tiles stitched column-major", DF,
   "const at = (X, Y) => tiles[(Y >> 8)*nTx + (X >> 8)][((Y & 255) << 8) + (X & 255)];",
   "const at = (X, Y) => tiles[(X >> 8)*plan.nTy + (Y >> 8)][((Y & 255) << 8) + (X & 255)];", ALIGN),
  ("the blue channel is ignored", DF,
   "out[i] = (rgba[p]*256 + rgba[p + 1] + rgba[p + 2]/256) - DEM_OFFSET;",
   "out[i] = (rgba[p]*256 + rgba[p + 1]) - DEM_OFFSET;", "decodes to R*256 + G + B/256"),
  ("duplicate file names overwrite each other", DF,
   "while(used.has(key)) key = stem + '-' + (n++);", "", "get different keys"),
  # ---- the limits and the warning ----
  ("nothing is ever called large", DF, "const DEM_WARN_BYTES = 5e6;", "const DEM_WARN_BYTES = 5e12;",
   "only called large from about 5 MB"),
  ("the tile estimate is a guess of 1 KB", DF, "const DEM_TILE_BYTES = 95000;", "const DEM_TILE_BYTES = 1000;",
   "only called large from about 5 MB"),
  ("no tile limit", DF, "const DEM_MAX_TILES = 400;", "const DEM_MAX_TILES = 40000;", "refused rather than attempted"),
  ("any coordinate system is accepted", DF, "if(!(/CRS84|4326/.test(name))) return 'A layer", "if(false) return 'A layer",
   "not WGS84"),
  # ---- the panel ----
  ("the controls are always on the panel", MN, "box.hidden = !(demBusy || offer || active);", "box.hidden = false;",
   "with no dropped files the elevation controls are not on the panel"),
  ("files inside the loaded DEM are offered elevation too", MN,
   "return !p || !inMapArea(p.x, p.z);", "return true;", "an overlay and are not offered elevation"),
  ("the slider range is not 6-20", HT, 'id="demCell" min="6" max="20"', 'id="demCell" min="1" max="50"',
   "the resolution slider (6-20 m)"),
  ("a large download starts on the first tap", MN,
   "if(plan.large && !demArmed){ demArmed = true; renderDemUI(); return; }", "", "first tap only arms the button"),
  ("moving the slider leaves the button armed", MN,
   "$('#demCell')?.addEventListener('input', ()=>{ demArmed = false; demMsg = ''; renderDemUI(); });",
   "$('#demCell')?.addEventListener('input', ()=>{ demMsg = ''; renderDemUI(); });", "moving the slider disarms it"),
  ("Cancel does nothing", MN, "if(demBusy){ demBusy.abort(); return; }", "if(demBusy){ return; }", "Cancel stops the download"),
  ("a failure is not reported", MN, "demMsg = (err && err.demCode) ? err.message :", "demMsg = '' ? err.message :",
   "a dead connection says so"),
  ("a stale result is loaded anyway", MN,
   "if(out && (loadedFiles.length !== snap.length || snap.some((f,i)=>loadedFiles[i] !== f))){", "if(false){",
   "throw the stale result away"),
  # ---- building on a map built here, and saving ----
  ("no rebuild is offered while a built map is showing", MN,
   "const offer = !demBusy && demNeeded();", "const offer = !demBusy && !active && demNeeded();",
   "offer a rebuild that keeps the files already in it"),
  ("a rebuild forgets the files already in the map", MN,
   "if(demActive()) for(const k of Object.keys(demBuilt.bundle.layers))",
   "if(false) for(const k of Object.keys(demBuilt.bundle.layers))", "offer a rebuild that keeps the files already in it"),
  ("Save combined still saves bare GeoJSON", MN,
   "  if(demActive()){ downloadText(demBuilt.name, demSaveText(), 'application/json'); return; }\n  if(!loadedFiles.length){ console.warn",
   "  if(!loadedFiles.length){ console.warn", "Save combined downloads the map and its elevation"),
  ("files dropped later are left out of the saved file", MN,
   "loadedFiles.forEach(f=>{ layers[demLayerKey(f.name, used)] = f.layer; });", "", "folded into its saved file"),
  ("changing terrain detail reloads the map from before", MN,
   "  if(reload && demActive()) return loadWorld(demBuilt.bundle, [], 3).then(()=>{\n    refreshMapUI(); placeAtHead(pickDefaultHead());\n  });\n",
   "", "changing terrain detail reloads the map built here"),
]
def restore():
    for f, t in BACKUP.items(): open(os.path.join(ROOT, f), 'w', encoding='utf-8').write(t)
def smoke():
    subprocess.run(['python3', 'build.py'], cwd=ROOT, capture_output=True)
    env = dict(os.environ, SMOKE_ONLY='dem')
    try:
        return subprocess.run(['node', 'tools/smoke.js'], cwd=ROOT, capture_output=True, text=True, env=env, timeout=240).stdout
    except subprocess.TimeoutExpired:
        return 'FAIL  (the elevation checks hung for 240 s)\n'
ONLY = sys.argv[1:]            # optional substrings of a check name or label: run just those reverts
for label, f, find, repl, check in REVERTS:
    if BACKUP[f].count(find) != 1: print('!! anchor missing/ambiguous:', label)
bad = 0
try:
    base = smoke()
    clean = [l for l in base.splitlines() if l.lstrip().startswith('FAIL')]
    if clean: print('!! the elevation checks are red BEFORE any revert:\n' + '\n'.join(clean)); sys.exit(1)
    for label, f, find, repl, check in REVERTS:
        if ONLY and not any(o in check or o in label for o in ONLY): continue
        src = BACKUP[f]
        if src.count(find) != 1: print('!! anchor missing/ambiguous:', label); bad += 1; continue
        open(os.path.join(ROOT, f), 'w', encoding='utf-8').write(src.replace(find, repl))
        out = smoke()
        red = any(l.lstrip().startswith('FAIL') and check in l for l in out.splitlines())
        print(('ok   ' if red else 'LIVE ') + label + '  ->  "' + check + '"')
        bad += (not red); restore()
finally:
    restore(); subprocess.run(['python3', 'build.py'], cwd=ROOT, capture_output=True)
print('\n%d revert(s) did NOT turn their check red' % bad)
