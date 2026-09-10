#!/usr/bin/env python3
"""Break each behaviour on purpose; confirm the check that guards it goes red.

A passing test is not evidence until it has failed against a revert. Each entry below
undoes one property of the pane drawer, rebuilds, runs the suite, and asserts that the
NAMED check fails and that the rest of the suite still fails only its known baseline.
Throwaway tooling -- not part of the delivered change.
"""
import pathlib, subprocess, sys, re

ROOT = pathlib.Path(__file__).parent.parent
BASELINE = 5   # pre-existing failures, unrelated to this work

# (name, file, old, new) -- and optionally a second (old, new) pair for reverts that have
# to move code rather than delete it.
REVERTS = [
    ('the retired toggles are gone from the page', 'trails/index.html',
     '  <main>\n',
     '  <button class="btn icon" id="panelTab">\u2699\ufe0f</button>\n  <main>\n'),

    ('an edge tab opens its own pane', 'src/trails/panes.js',
     "document.getElementById('paneTabSet')?.addEventListener('click', ()=> togglePane('settings'));",
     ''),

    # a plausible regression: "ignore the tap if something is already open"
    ('opening one pane closes the other', 'src/trails/panes.js',
     'function togglePane(name){ showPane(openPane === name ? null : name); }',
     'function togglePane(name){ if(openPane && openPane !== name) return; showPane(openPane === name ? null : name); }'),

    # close-then-open: same end state, two transitions, a visible flinch
    ('switching panes from the drawer header does not close the drawer', 'src/trails/panes.js',
     'if(b && b.dataset.pane) showPane(b.dataset.pane);',
     'if(b && b.dataset.pane){ showPane(null); showPane(b.dataset.pane); }'),

    ('the header tab you are already on is not a close button', 'src/trails/panes.js',
     'if(b && b.dataset.pane) showPane(b.dataset.pane);',
     'if(b && b.dataset.pane) togglePane(b.dataset.pane);'),

    ('the \u2715 closes whichever pane is showing', 'src/trails/panes.js',
     "document.getElementById('paneClose')?.addEventListener('click', ()=> showPane(null));",
     ''),

    ('Tab and M open their panes, and repeat to close', 'src/trails/main.js',
     "if(e.code==='KeyM'){ togglePane('map'); return; }",
     "if(e.code==='KeyM'){ showPane('map'); return; }"),

    # M back behind the paused gate, where it used to live. It has to MOVE, not vanish:
    # deleting it breaks every other check that opens the map with a key, which tells you
    # nothing about whether the gate is in the right place.
    ('a key still reaches a pane while the walk is paused', 'src/trails/main.js',
     """  if(e.code==='KeyM'){ togglePane('map'); return; }
  /* Esc unwinds""",
     """  /* Esc unwinds""",
     """    return;
  }
  if(e.code==='Space'""",
     """    return;
  }
  if(e.code==='KeyM'){ togglePane('map'); return; }
  if(e.code==='Space'"""),

    ('the body attribute never disagrees with the pane state', 'src/trails/panes.js',
     "else body.removeAttribute('data-pane');", ''),

    ('reopening the map pane refits it to the sheet', 'src/trails/minimap.js',
     'if(next && !bigOpen){ bigZoom = 1; bigFocus = null; }', ''),
]


SNAP = pathlib.Path('/tmp/revert-snap')


def restore_leftovers():
    """A SIGKILL skips the finally that puts the file back, so a killed sweep can leave a
    revert applied -- which the next run would then read as the baseline. Snapshots live
    outside the tree and are replayed on startup."""
    SNAP.mkdir(exist_ok=True)
    n = 0
    for snap in SNAP.glob('*.orig'):
        target = ROOT / snap.read_text().split('\n', 1)[0]
        target.write_text(snap.read_text().split('\n', 1)[1])
        snap.unlink()
        n += 1
    if n:
        print(f'(restored {n} file(s) left behind by a killed run)')


def run_suite():
    subprocess.run([sys.executable, 'build.py'], cwd=ROOT, capture_output=True)
    out = subprocess.run(['node', 'tools/smoke.js'], cwd=ROOT, capture_output=True, text=True).stdout
    failed = [re.sub(r'\s{2,}.*$', '', l[6:]).strip() for l in out.splitlines() if l.startswith(' FAIL')]
    errs = 0
    m = re.search(r'(\d+) runtime error', out)
    if m:
        errs = int(m.group(1))
    return failed, errs


def main():
    only = None
    if len(sys.argv) > 1:
        only = [int(x) for x in sys.argv[1].split(',')]
    restore_leftovers()
    base_failed, base_errs = run_suite()
    print(f'baseline: {len(base_failed)} failing, {base_errs} runtime error(s)\n')
    ok = True
    for i, entry in enumerate(REVERTS):
        name, relpath, old, new = entry[:4]
        extra_pair = entry[4:6] if len(entry) >= 6 else None
        if only is not None and i not in only:
            continue
        f = ROOT / relpath
        orig = f.read_text()
        if orig.count(old) != 1:
            print(f'  ??  [{i}] {name}\n      revert anchor matched {orig.count(old)} times in {relpath}')
            ok = False
            continue
        snap = SNAP / (relpath.replace('/', '_') + '.orig')
        snap.write_text(relpath + '\n' + orig)
        mutated = orig.replace(old, new)
        if extra_pair:
            assert mutated.count(extra_pair[0]) == 1, f'second anchor missed in {relpath}'
            mutated = mutated.replace(extra_pair[0], extra_pair[1])
        f.write_text(mutated)
        try:
            failed, errs = run_suite()
        finally:
            f.write_text(orig)
            snap.unlink(missing_ok=True)
        caught = name in failed
        # anything newly failing that is not the check under test, named so a sloppy
        # revert can be told apart from a genuinely entangled behaviour
        collateral = [x for x in failed if x != name and x not in base_failed]
        clean = not collateral and errs == 0
        mark = 'ok  ' if caught and clean else 'BAD '
        if not (caught and clean):
            ok = False
        print(f'  {mark}[{i}] {name}')
        if not caught:
            print('      revert did NOT make this check fail -- it is not load-bearing')
        for c in collateral:
            print(f'      also broke: {c}')
        if errs:
            print(f'      {errs} runtime error(s)')
    subprocess.run([sys.executable, 'build.py'], cwd=ROOT, capture_output=True)
    print('\nall reverts caught, no collateral' if ok else '\nNOT CLEAN -- see above')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
