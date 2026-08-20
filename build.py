#!/usr/bin/env python3
"""
Bundle the ES modules into standalone single-file HTML builds.

    python3 build.py            # -> dist/pup-city.html, dist/backyard-pups.html
    python3 build.py --serve    # build, then serve the repo at :8000

Why this exists: the source is ES modules (clean to edit, works on GitHub Pages),
but a single self-contained file is still the most portable thing you can hand
someone - it opens from a double-click, works offline, and needs no server.

The bundler resolves the import graph, strips import/export lines, and
concatenates modules in dependency order. Top-level names are unique across
modules by design, so flattening them into one scope is safe.
"""
import re, sys, os, pathlib, http.server, socketserver, functools

ROOT = pathlib.Path(__file__).parent
DIST = ROOT / 'dist'

# handles single-line AND brace-across-multiple-lines import statements
IMPORT_RE = re.compile(
    r'^[ \t]*import\s+(?:\{[^}]*\}|\*\s+as\s+[\w$]+|[\w$]+)?\s*(?:from\s*)?'
    r'[\'"]([^\'"]+)[\'"][ \t]*;?[ \t]*$', re.M)
EXPORT_LINE_RE = re.compile(r'^\s*export\s*\{[^}]*\}\s*;?\s*$', re.M | re.S)
EXPORT_DECL_RE = re.compile(r'^(\s*)export\s+(const|let|var|function|class)\s', re.M)


def resolve(spec, importer):
    return (importer.parent / spec).resolve()


def collect(entry, seen, order):
    """Depth-first walk of the import graph; a module lands in `order` after
    everything it depends on. Cycles are tolerated (ES modules allow them for
    function references), the module just keeps its first position."""
    entry = entry.resolve()
    if entry in seen:
        return
    seen.add(entry)
    src = entry.read_text(encoding='utf-8')
    for spec in IMPORT_RE.findall(src):
        if spec.startswith('.'):
            dep = resolve(spec, entry)
            if not dep.exists():
                raise SystemExit(f'! {entry.name} imports missing module: {spec}')
            collect(dep, seen, order)
    order.append(entry)


def strip_module_syntax(src):
    src = IMPORT_RE.sub('', src)
    src = EXPORT_LINE_RE.sub('', src)
    src = EXPORT_DECL_RE.sub(r'\1\2 ', src)
    return src.strip()


def bundle_js(entry):
    order = []
    collect(entry, set(), order)
    parts = []
    for path in order:
        rel = path.relative_to(ROOT)
        parts.append(f'/* ==== {rel} ==== */\n' + strip_module_syntax(path.read_text(encoding='utf-8')))
    return '\n\n'.join(parts), order


def inline(html_path, out_name):
    html = html_path.read_text(encoding='utf-8')
    here = html_path.parent

    # inline stylesheets
    def css_sub(m):
        href = m.group(1)
        p = (here / href).resolve()
        return '<style>\n' + p.read_text(encoding='utf-8') + '\n</style>'
    html = re.sub(r'<link rel="stylesheet" href="(.+?)">', css_sub, html)

    # inline the vendored three.js
    def vendor_sub(m):
        p = (here / m.group(1)).resolve()
        return '<script>\n' + p.read_text(encoding='utf-8') + '\n</script>'
    html = re.sub(r'<script src="(\.\./vendor/.+?)"></script>', vendor_sub, html)

    # bundle the module graph
    m = re.search(r'<script type="module" src="(.+?)"></script>', html)
    entry = (here / m.group(1)).resolve()
    js, order = bundle_js(entry)
    html = html[:m.start()] + '<script>\n' + js + '\n</script>' + html[m.end():]

    # drop things that only make sense when served
    html = re.sub(r'\s*<link rel="manifest".*?>', '', html)

    DIST.mkdir(exist_ok=True)
    out = DIST / out_name
    out.write_text(html, encoding='utf-8')
    print(f'  {out_name:24s} {len(html)//1024:5d} KB   ({len(order)} modules)')
    return out


def main():
    print('building single-file bundles...')
    inline(ROOT / 'city' / 'index.html', 'pup-city.html')
    inline(ROOT / 'creator' / 'index.html', 'backyard-pups.html')
    print('done -> dist/')
    if '--serve' in sys.argv:
        os.chdir(ROOT)
        handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT))
        with socketserver.TCPServer(('', 8000), handler) as httpd:
            print('serving http://localhost:8000/  (ctrl-c to stop)')
            httpd.serve_forever()


if __name__ == '__main__':
    main()
