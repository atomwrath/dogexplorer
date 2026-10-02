#!/usr/bin/env node
/* Draws the side-profile icon for every dog preset and wild species, from the game's own
   models, and writes them to src/data/profile-icons.js as data URIs.

   Pup Trails ships these so the picker has real pictures from the first frame. Anything with
   no shipped icon -- a pup made in Backyard Pups, one imported from a file, a preset retuned
   since this was last run -- is drawn at run time by the same renderer (src/core/profile-icon.js).
   The game compares each icon's hash with what it would draw now, so a stale icon is replaced
   rather than shown; but re-run this after changing a preset, a species, or the lighting in
   profile-icon.js, so players are not waiting on their own device for what could have shipped.

   NEEDS (development only -- none of it ships, and the repo has no package.json for it):
       npm install gl pngjs          # headless WebGL, and a PNG writer
       a display: on a server, run it under  xvfb-run -a node tools/make-profile-icons.mjs
   USAGE:
       node tools/make-profile-icons.mjs                 write src/data/profile-icons.js
       node tools/make-profile-icons.mjs --preview DIR   also write one PNG per icon and a
                                                         contact sheet into DIR, to look at
       node tools/make-profile-icons.mjs --check         write nothing; exit 1 if the shipped
                                                         icons are stale against the models */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const previewDir = args.includes('--preview') ? args[args.indexOf('--preview') + 1] : null;
const checkOnly = args.includes('--check');

/* ---- a just-enough browser for the model files to load in ----
   buildDog and makeAnimalModel draw speech-bubble and alert textures on a 2D canvas when
   they load. Those textures belong to sprites that are never in a profile, so the canvas
   only has to accept the calls. */
const noopCtx = new Proxy({}, { get: (_, k) => k === 'measureText' ? (() => ({ width: 0 })) : (() => {}), set: () => true });
globalThis.document = {
  createElement: () => ({ width: 0, height: 0, style: {}, getContext: () => noopCtx, addEventListener() {} }),
  getElementById: () => null,
};
globalThis.window = globalThis;
globalThis.THREE = require(path.join(ROOT, 'vendor/three.min.js'));

const createGL = require('gl');
const { PNG } = require('pngjs');

const load = p => import(pathToFileURL(path.join(ROOT, p)).href);
const { renderProfile, ICON_W, ICON_H } = await load('src/core/profile-icon.js');
const { dogIconSpec, wildIconSpec } = await load('src/trails/pup-icon-specs.js');
const { PRESETS } = await load('src/creator/presets.js');
const { SPECIES } = await load('src/data/species.js');

const gl = createGL(ICON_W * 3, ICON_H * 3, { preserveDrawingBuffer: true, alpha: true, antialias: false });
if (!gl) { console.error('no WebGL context -- is there a display? try: xvfb-run -a node tools/make-profile-icons.mjs'); process.exit(2); }
const fake = { width: ICON_W * 3, height: ICON_H * 3, style: {}, addEventListener() {}, removeEventListener() {}, getContext: () => gl };
gl.canvas = fake;      // three reads gl.canvas.width; a headless context has no canvas
const renderer = new THREE.WebGLRenderer({ canvas: fake, context: gl, antialias: false });
renderer.outputEncoding = THREE.sRGBEncoding;

/* what each icon is drawn FROM and what it is hashed over: the same specs the game uses
   (src/trails/pup-icon-specs.js), so the two cannot disagree */
const jobs = [];
for (const p of PRESETS) jobs.push({ key: 'dog:' + p.label, ...dogIconSpec(p.o) });
for (const key of Object.keys(SPECIES)) jobs.push({ key: 'wild:' + key, ...wildIconSpec(key) });

/* the data module as it stands, to tell what is stale */
const outPath = path.join(ROOT, 'src/data/profile-icons.js');
let shipped = {};
try { shipped = (await import(pathToFileURL(outPath).href + '?t=' + Date.now())).PROFILE_ICONS || {}; } catch (e) { /* first run */ }

if (checkOnly) {
  const stale = jobs.filter(j => !shipped[j.key] || shipped[j.key].h !== j.hash).map(j => j.key);
  const extra = Object.keys(shipped).filter(k => !jobs.some(j => j.key === k));
  if (stale.length || extra.length) {
    console.log('stale or missing: ' + (stale.join(', ') || '(none)') + (extra.length ? '\nno longer in the game: ' + extra.join(', ') : ''));
    process.exit(1);
  }
  console.log('all ' + jobs.length + ' shipped icons are current');
  process.exit(0);
}

const encode = img => {
  const png = new PNG({ width: img.w, height: img.h });
  png.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length);
  return PNG.sync.write(png, { deflateLevel: 9, filterType: 4 });
};

const entries = [], images = [];
for (const j of jobs) {
  const rig = j.build();
  const img = renderProfile(renderer, rig);
  if (!img) { console.error('could not render ' + j.key); process.exit(2); }
  rig.traverse(o => { if (o.geometry) o.geometry.dispose(); });
  const png = encode(img);
  entries.push([j.key, j.hash, png]);
  images.push({ key: j.key, img });
  console.log((j.key + '                    ').slice(0, 24) + png.length + ' bytes');
  if (previewDir) { fs.mkdirSync(previewDir, { recursive: true }); fs.writeFileSync(path.join(previewDir, j.key.replace(':', '-') + '.png'), png); }
}

if (previewDir) {
  // a contact sheet on the picker's own cream, 5 across, at 2x so it can be looked at
  const cols = 5, rows = Math.ceil(images.length / cols), pad = 10, S = 2;
  const cw = (ICON_W + pad) * S, ch = (ICON_H + pad) * S;
  const sheet = new PNG({ width: cols * cw + pad * S, height: rows * ch + pad * S });
  for (let i = 0; i < sheet.data.length; i += 4) { sheet.data[i] = 255; sheet.data[i + 1] = 243; sheet.data[i + 2] = 222; sheet.data[i + 3] = 255; }
  images.forEach(({ img }, n) => {
    const ox = pad * S + (n % cols) * cw, oy = pad * S + Math.floor(n / cols) * ch;
    for (let y = 0; y < ICON_H * S; y++) for (let x = 0; x < ICON_W * S; x++) {
      const sp = (Math.floor(y / S) * img.w + Math.floor(x / S)) * 4, dp = ((oy + y) * sheet.width + ox + x) * 4;
      const a = img.data[sp + 3] / 255;
      for (let c = 0; c < 3; c++) sheet.data[dp + c] = img.data[sp + c] * a + sheet.data[dp + c] * (1 - a);
    }
  });
  fs.writeFileSync(path.join(previewDir, 'sheet.png'), PNG.sync.write(sheet));
}

const body = entries.map(([k, h, png]) => `  ${JSON.stringify(k)}: {h: ${JSON.stringify(h)}, src: 'data:image/png;base64,${png.toString('base64')}'},`).join('\n');
fs.writeFileSync(outPath, `/* GENERATED by tools/make-profile-icons.mjs -- do not edit by hand; re-run it.
   One side-profile icon per dog preset and wild species, drawn from the game's own models.
   \`h\` is the hash of what each was drawn from: src/trails/pup-icons.js draws a fresh one at
   run time when it no longer matches. */
const PROFILE_ICONS = {
${body}
};
export { PROFILE_ICONS };
`);
console.log('wrote ' + path.relative(ROOT, outPath) + ' (' + (fs.statSync(outPath).size / 1024).toFixed(0) + ' KB, ' + entries.length + ' icons)');
