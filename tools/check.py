#!/usr/bin/env python3
"""Verify every module parses, and that the built bundles parse too.

    python3 tools/check.py

Requires node on PATH (used only as a syntax checker, nothing is executed).
"""
import pathlib, re, subprocess, sys, tempfile

ROOT = pathlib.Path(__file__).parent.parent
fails = []

def check_js(name, source, module=False):
    # .mjs = module semantics, .cjs = classic-script semantics. The .cjs case
    # matters: node --check on a plain .js auto-detects ESM and would happily
    # accept leftover import/export syntax in a bundle that browsers reject.
    with tempfile.NamedTemporaryFile('w', suffix='.mjs' if module else '.cjs',
                                     delete=False, encoding='utf-8') as f:
        f.write(source)
        tmp = f.name
    r = subprocess.run(['node', '--check', tmp], capture_output=True, text=True)
    if r.returncode:
        fails.append(f'{name}\n{r.stderr.strip()}')
        print(f'  FAIL  {name}')
    else:
        print(f'  ok    {name}')

print('checking modules...')
for p in sorted(ROOT.glob('src/**/*.js')):
    check_js(str(p.relative_to(ROOT)), p.read_text(encoding='utf-8'), module=True)

print('checking bundles...')
for p in sorted(ROOT.glob('dist/*.html')):
    for i, block in enumerate(re.findall(r'<script>(.*?)</script>', p.read_text(encoding='utf-8'), re.S)):
        if 'THREE' in block[:400] and 'Copyright 2010-2021' in block[:400]:
            continue  # skip vendored three.js
        check_js(f'{p.name} block {i}', block)

# --- duplicate top-level declarations, per bundle ---
# Modules are flattened into one scope, so two modules in the SAME bundle must
# not declare the same top-level name. Across bundles it's fine (they never meet).
print('checking for name collisions within each bundle...')
sys.path.insert(0, str(ROOT))
import build as builder

DECL = re.compile(r'^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)', re.M)
for entry_rel in ['src/city/main.js', 'src/creator/main.js']:
    order = []
    builder.collect(ROOT / entry_rel, set(), order)
    seen = {}
    clashes = []
    for path in order:
        for name in set(DECL.findall(path.read_text(encoding='utf-8'))):
            if name in seen:
                clashes.append(f'{name}: {seen[name]} vs {path.relative_to(ROOT)}')
            else:
                seen[name] = path.relative_to(ROOT)
    if clashes:
        fails.append(f'{entry_rel} bundle name collisions:\n  ' + '\n  '.join(clashes))
        print(f'  FAIL  {entry_rel} ({len(clashes)} collisions)')
    else:
        print(f'  ok    {entry_rel} ({len(order)} modules, no collisions)')

if fails:
    print('\n' + '\n\n'.join(fails))
    sys.exit(1)
print('\nall good')
