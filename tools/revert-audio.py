#!/usr/bin/env python3
"""Each new assertion gets its own targeted revert: undo exactly the line it claims to
protect, rebuild, and confirm THAT check fails. A check that still passes against its own
revert is decoration, not evidence."""
import subprocess, shutil, sys, os

ROOT = '/home/claude/repo'
FILES = ['src/core/audio.js', 'src/trails/gait.js']
BACKUP = {f: open(os.path.join(ROOT, f)).read() for f in FILES}

# (label, file, find, replace, the check that must fail)
REVERTS = [
  ("gallop offsets collapse back to the trot pattern",
   'src/trails/gait.js',
   "const off = trotPhase + (gallopPhase - trotPhase)*a;",
   "const off = trotPhase;",
   "a gallop lands as two tight pairs"),

  ("footsteps replay the buffer from zero every time",
   'src/core/audio.js',
   "src.start(tN, noiseOffset(dur));\n    src.stop(tN+dur+0.02);",
   "src.start(tN, 0);\n    src.stop(tN+dur+0.02);",
   "consecutive footsteps are not the same slice"),

  ("footsteps get banked like every other sound",
   'src/core/audio.js',
   "  nowOnly(()=>{\n    const tN = startAt();\n    // one jitter per step",
   "  whenRunning(()=>{\n    const tN = startAt();\n    // one jitter per step",
   "a footstep fired before audio is live is dropped"),

  ("the step band drops below the speaker floor",
   'src/core/audio.js',
   "bp.frequency.setValueAtTime(Math.max(SPEAKER_FLOOR_HZ*1.6, S.hz*bright*sizeMul*j), tN);",
   "bp.frequency.setValueAtTime(S.hz*bright*sizeMul*j*0.05, tN);",
   "a footstep is voiced above the speaker floor"),

  ("soft ground is given a drum head after all",
   'src/core/audio.js',
   "grass: {hz:2700, q:0.5, d:0.105, b:0,   be:0,   n:0.24, bg:0.00}",
   "grass: {hz:2700, q:0.5, d:0.105, b:210, be:120, n:0.24, bg:0.16}",
   "soft ground is a swish, not a drum"),

  ("every surface shares one voice",
   'src/core/audio.js',
   "function stepSurface(name){ return STEP_SURFACES[name] || STEP_SURFACES.trail; }",
   "function stepSurface(name){ return STEP_SURFACES.trail; }",
   "the ground underfoot actually changes the sound"),

  ("speed stops brightening the step",
   'src/core/audio.js',
   "const bright = 0.82 + spd*0.42;",
   "const bright = 1;",
   "running brightens the step against walking"),

  ("GO is pitched like just another pip",
   'src/core/audio.js',
   "[783.99, 1174.66].forEach((fr, k)=>{",
   "[523.25, 523.25].forEach((fr, k)=>{",
   "the GO tone answers the countdown"),
]

def restore():
    for f, txt in BACKUP.items():
        open(os.path.join(ROOT, f), 'w').write(txt)

def smoke():
    subprocess.run(['python3', 'build.py'], cwd=ROOT, capture_output=True)
    r = subprocess.run(['node', 'tools/smoke.js'], cwd=ROOT, capture_output=True, text=True)
    return r.stdout

# baseline
restore()
base = smoke()
base_fails = {l.strip() for l in base.splitlines() if l.startswith(' FAIL')}
print(f'baseline failures: {len(base_fails)}\n', flush=True)
open(os.path.join(ROOT,'revert-log.txt'),'w').write(f'baseline failures: {len(base_fails)}\n')

results = []
import sys as _s
_only = [int(a) for a in _s.argv[1:]]
for _i, (label, f, find, repl, target) in enumerate(REVERTS):
  if _only and _i not in _only: continue
  if True:
    restore()
    p = os.path.join(ROOT, f)
    s = open(p).read()
    if find not in s:
        results.append((label, 'ANCHOR NOT FOUND', 0)); print(f'!! anchor missing: {label}'); continue
    open(p, 'w').write(s.replace(find, repl, 1))
    out = smoke()
    fails = {l.strip() for l in out.splitlines() if l.startswith(' FAIL')}
    caught = any(target in l for l in fails)
    collateral = len(fails - base_fails) - (1 if caught else 0)
    results.append((label, 'CAUGHT' if caught else 'MISSED', collateral))
    line = f'{"CAUGHT " if caught else "MISSED "} {label}   (+{collateral} collateral)'
    print(line, flush=True)
    with open(os.path.join(ROOT, 'revert-log.txt'), 'a') as fh:
        fh.write(line + '\n')

restore()
subprocess.run(['python3', 'build.py'], cwd=ROOT, capture_output=True)
print('\nrestored.')
missed = [r for r in results if r[1] != 'CAUGHT']
print('ALL LOAD-BEARING' if not missed else f'{len(missed)} NOT LOAD-BEARING')
