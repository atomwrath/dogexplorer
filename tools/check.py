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
# `let a = 1, b = [], c = null;` declares THREE names, and DECL alone sees only the first --
# which once hid a real clash (two modules' top-level `STATE`, the second declared after
# a comma) until the bundle threw on load. So every top-level let/const/var statement is
# also read declarator by declarator: split at depth-0 commas up to its depth-0 `;`.
VARSTMT = re.compile(r'^(?:const|let|var)\s+', re.M)
IDENT = re.compile(r'\s*([A-Za-z_$][\w$]*)')
def top_level_names(src):
    names = set(DECL.findall(src))
    for m in VARSTMT.finditer(src):
        i, depth, part_start, q = m.end(), 0, m.end(), None
        parts = []
        while i < len(src):
            ch = src[i]
            if q:
                if ch == '\\': i += 2; continue
                if ch == q: q = None
            elif ch in '\'"`': q = ch
            elif ch in '([{': depth += 1
            elif ch in ')]}': depth -= 1
            elif depth == 0 and ch in ',;':
                parts.append(src[part_start:i])
                part_start = i + 1
                if ch == ';': break
            elif depth == 0 and ch == '\n' and not src[part_start:i].strip().endswith((',', '=')) and '=' in src[part_start:i] and not src[i+1:].lstrip().startswith((',', '.', '?', ':', '+', '-', '*', '/', '&', '|')):
                # an ASI-terminated declaration with no semicolon
                parts.append(src[part_start:i]); break
            i += 1
        for part in parts:
            mm = IDENT.match(part)
            if mm: names.add(mm.group(1))
    return names

for entry_rel in ['src/city/main.js', 'src/creator/main.js', 'src/trails/main.js', 'src/neon/main.js']:
    order = []
    builder.collect(ROOT / entry_rel, set(), order)
    seen = {}
    clashes = []
    for path in order:
        for name in top_level_names(path.read_text(encoding='utf-8')):
            if name in seen:
                clashes.append(f'{name}: {seen[name]} vs {path.relative_to(ROOT)}')
            else:
                seen[name] = path.relative_to(ROOT)
    if clashes:
        fails.append(f'{entry_rel} bundle name collisions:\n  ' + '\n  '.join(clashes))
        print(f'  FAIL  {entry_rel} ({len(clashes)} collisions)')
    else:
        print(f'  ok    {entry_rel} ({len(order)} modules, no collisions)')

print('checking for aliased imports/exports...')
# build.py flattens every module into one scope and DELETES the import/export lines,
# so `import { pups as kennelPups }` leaves no `kennelPups` binding anywhere: the name
# is simply undefined in the bundle. It works perfectly in dev (real ES modules) and
# throws only in the built single-file version, which is the worst possible place to
# find out. `import * as ns` is fine -- the regex below deliberately ignores it.
ALIAS_RE = re.compile(r'(?:^|\n)[ \t]*(?:import|export)[ \t]*\{([^}]*)\}', re.S)
alias_fails = []
for p in sorted(ROOT.glob('src/**/*.js')):
    src = p.read_text(encoding='utf-8')
    for m in ALIAS_RE.finditer(src):
        for part in m.group(1).split(','):
            bits = part.split()
            if len(bits) == 3 and bits[1] == 'as':
                line = src[:m.start()].count('\n') + 1
                alias_fails.append(f'{p.relative_to(ROOT)}:{line}  {bits[0]} as {bits[2]}')
if alias_fails:
    fails.append('aliased import/export (build.py strips these, leaving the alias '
                 'undefined in the bundle):\n  ' + '\n  '.join(alias_fails))
    print(f'  FAIL  {len(alias_fails)} alias(es)')
else:
    print('  ok    no aliases')

if fails:
    print('\n' + '\n\n'.join(fails))
    sys.exit(1)
print('\nall good')
