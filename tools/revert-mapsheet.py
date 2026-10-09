#!/usr/bin/env python3
"""Each map-sheet assertion (start label, Start here button, GPS Start here, the folding
Recordings card) gets a targeted revert: break exactly the line it claims to protect, rebuild,
run the smoke suite, and confirm THAT check goes red. Usage (from the repo root):

    python3 tools/revert-mapsheet.py            # every revert
    python3 tools/revert-mapsheet.py "fix kept" # only reverts whose label or check contains that

The sources are restored from memory after every revert (and at the end, via finally). If the
run is killed halfway, `git checkout -- src trails styles` is the way back, then rebuild."""
import subprocess, os, sys
sys.stdout.reconfigure(line_buffering=True)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MN, LC, HT = 'src/trails/main.js', 'src/trails/locate.js', 'trails/index.html'
FILES = [MN, LC, HT]
BACKUP = {f: open(os.path.join(ROOT, f), encoding='utf-8').read() for f in FILES}
REVERTS = [
  # ---- the 📍 card's Start here ----
  ("the card's Start here only loads the point, like the old Go to", LC, "  if(locStart) locStart();\n", "",
   "Start here on the card puts the pup on the nearest trail point at once"),
  ("main.js never hands the card its start function", MN, "initLocate(startFromHere);", "initLocate();",
   "Start here on the card puts the pup on the nearest trail point at once"),
  ("the typed latitude/longitude path does not start either", LC, "  if(locStart) locStart();\n", "",
   "typing a latitude and longitude lights Start here"),
  ("the card's button still says Go to", HT, 'id="locGo" type="button">🚩 Start here</button>', 'id="locGo" type="button">▶ Go to</button>',
   "the card's button says Start here, not Go to"),
  ("Start here clears the fix off the sheet", LC, "  locClose(false);      // the dot stays on the sheet, beside the flag\n",
   "  locClose(true);\n", "keeps the fix on the sheet"),
  # ---- Start here on the map ----
  ("Start here is on the sheet at all times", MN, "if(btn) btn.hidden = !(hereSubject && (hereSubject.kind === 'head' || hereSubject.kind === 'point'));",
   "if(btn) btn.hidden = false;", "Start here is only offered while a trailhead or a trail point is loaded"),
  ("Start here is never shown", MN, "if(btn) btn.hidden = !(hereSubject && (hereSubject.kind === 'head' || hereSubject.kind === 'point'));",
   "if(btn) btn.hidden = true;", "the loaded trailhead shows Start here on the map"),
  ("Start here does not place a trailhead", MN, "if(subj.kind === 'head') placeAtHead(subj.i);", "if(subj.kind === 'head') { }",
   "the loaded trailhead shows Start here on the map"),
  ("Start here leaves the sheet open", MN, "  if(!playing) enterPlay();\n  showPane(null);\n  return true;", "  if(!playing) enterPlay();\n  return true;",
   "the loaded trailhead shows Start here on the map"),
  ("a loaded course keeps the Start here button", MN, "  renderStartPicker();               // a course is not a place to start: the button goes\n", "",
   "a loaded course shows its details inside the Recordings card"),
  # ---- the label ----
  ("the label drops the elevation", MN, "return lead + name + (ft == null ? '' : ' \\u00b7 ' + Math.round(ft).toLocaleString() + ' ft');",
   "return lead + name;", "a loaded trailhead is named at the top left of the map"),
  ("the label ignores a loaded trailhead", MN, "if(hereSubject && hereSubject.kind === 'head' && heads[hereSubject.i]){",
   "if(false){", "a loaded trailhead is named at the top left of the map"),
  # ---- the Recordings card ----
  ("the Recordings card cannot fold", HT, 'id="recCard" data-fold="rec" data-fold-narrow-closed>', 'id="recCard" data-fold-narrow-closed>',
   "the Recordings caret folds the card"),
  ("a trace to name does not open a folded card", MN, "  if(recPending) openRecordings();   // the name field is in the card, which may be folded\n", "",
   "a trace waiting for a name opens a folded Recordings card"),
  ("a loaded course does not open a folded card", MN, "  openRecordings();                  // the details are in the card; a folded card would hide them\n", "",
   "a loaded course shows its details inside the Recordings card"),
  ("the card never starts folded on a phone", MN, "return !(sect.hasAttribute('data-fold-narrow-closed') && narrow);", "return true;",
   "on a phone-sized sheet the Recordings card starts folded"),
  ("a remembered choice no longer wins", MN, "if(kept !== null && kept !== undefined) return kept !== '0';", "",
   "on a phone-sized sheet the Recordings card starts folded"),
  ("courses and spots are two cards again", HT, '                  <div class="sub">📍 Saved spots</div>',
   '                </div></section><section class="bm-card" id="spotsCard"><div class="sub">📍 Saved spots</div><div>', "courses and saved spots are one Recordings card"),
]
def restore():
    for f, t in BACKUP.items(): open(os.path.join(ROOT, f), 'w', encoding='utf-8').write(t)
def smoke():
    subprocess.run(['python3', 'build.py'], cwd=ROOT, capture_output=True)
    return subprocess.run(['node', 'tools/smoke.js'], cwd=ROOT, capture_output=True, text=True).stdout
ONLY = sys.argv[1:]            # optional substrings of a check name or label: run just those reverts
for label, f, find, repl, check in REVERTS:
    if BACKUP[f].count(find) != 1: print('!! anchor missing/ambiguous:', label)
bad = 0
try:
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
