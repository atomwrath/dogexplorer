# Pup Games

Two cartoon 3D dog games that run in any browser — no install, no build step required to play.?

- **Backyard Pups** — design a pup from the paws up, save favorites, export them as JSON.
- **Pup City** — downtown dash. Sneak the block, scare the strays, dodge traffic, chomp the golden bone, and don't startle the neighbors.

Both games share the same dog builder, so a pup you design in the creator is the pup you run with in the city.

## Playing

Visit the GitHub Pages URL. On a phone or tablet, use **Share → Add to Home Screen** for fullscreen play with no browser chrome; the game is cached, so it works offline afterwards.

Controls: WASD/arrows to move, Shift to run, C to sneak, Space to jump, B to bark, E to chomp, Esc to quit.
On touch devices a floating analog stick appears wherever your left thumb lands — push a little to pad along, push far to sprint.

## Repo layout

```
index.html              landing page
city/  creator/         thin HTML shells (markup + <script type="module">)
src/
  core/       math, materials, render, audio, fx, input, shake, quality
  dog/        params, build (SHARED by both games), stats, runtime
  city/       world, props, buildings, level, animals, traffic, peeps,
              pickups, player, ring, visibility, modes, ui, score, main
  creator/    scene, presets, main
  data/       species.js, tuning.js   <- gameplay balance, no logic
vendor/three.min.js     pinned r128
build.py                bundles modules -> dist/*.html single files
tools/check.py          syntax + name-collision verification
```

**Dependency flow is one-way:** `data → core → dog → world → systems → main`. Nothing reaches back up.

**Shared mutable state** lives in the module that owns it and is read elsewhere as a live binding. Only the owner assigns; everyone else goes through a setter (`setEnvG`, `setCarried`, `setDogYaw`, `addLevelTime`, `resetScared`, `resetGrumbles`, `setShake`).

> One gotcha worth knowing: the arrays in `city/world.js` (`COLLIDERS`, `PLATFORMS`, …) must never be reassigned — other modules hold the same reference. `resetWorld()` empties them in place.

## Developing

ES modules need to be served (browsers block them over `file://`):

```bash
python3 build.py --serve     # builds, then serves at http://localhost:8000
```

Edit anything under `src/` and reload. No bundler, no node_modules, no watch process.

### Load-bearing rules

- **Shared mutable arrays are cleared in place**, never reassigned — other modules hold
  the same reference, and reassigning silently orphans them (`resetWorld()`,
  `kennel.pups`).
- **A driver never reads the player.** `dog/runtime.js` owns `dogPos`; `wild-driver.js`
  owns its own `pos`. Whoever owns the player state has to push x/z across to the live
  driver every frame (`trails/main.js`'s `syncAvatar`). Miss it and the rig renders at
  the world origin while the camera follows the player — on a kilometres-wide map, the
  avatar is simply never on screen, with no error anywhere.
- **Never alias an import or export** (`import { a as b }`). `build.py` flattens every
  module into one scope and deletes the import/export lines, so the alias is undefined
  in the built bundle — works in dev, throws in `dist/`. `tools/check.py` enforces this.
- **`fetch_dem.py` writes `layers` as an object** keyed by filename; `World` normalises
  it to an array. Consumers can rely on `World.layers` being an array.
- **Horizontal map scale belongs to `World`,** not the game layer. `World.setMapScale()`
  re-derives the projection *and* the DEM cell grid from the bundle constants together;
  scaling one without the other decouples vectors from terrain.

## Building single-file versions

```bash
python3 build.py             # -> dist/pup-city.html, dist/backyard-pups.html
```

Each is fully self-contained (three.js, CSS and all modules inlined) and opens from a double-click. Handy for sharing, archiving, or playing with no server at all.

## Verifying

```bash
python3 tools/check.py       # needs node on PATH
```

Checks that every module parses as ESM, that each built bundle parses as a **classic script**, and that no two modules in the same bundle declare the same top-level name (they're flattened into one scope).

> The classic-script check matters: `node --check` on a plain `.js` auto-detects ESM and will happily accept leftover `import`/`export` that a browser would reject, so bundles are checked as `.cjs`.

### Smoke test (optional)

`tools/check.py` proves the code parses. `tools/smoke.js` proves it runs: it boots the
built bundle under jsdom with a stubbed THREE, then clicks through the pickers and
asserts the avatar ends up where the player is.

```bash
npm install jsdom            # dev only, nothing ships
python3 build.py && node tools/smoke.js
```

## Tuning the game

Most balance changes need no logic edits:

- `src/data/tuning.js` — scoring weights, medal thresholds, penalties, pace multipliers
- `src/data/species.js` — animal speed, bravery, skittishness
- `src/core/quality.js` — device tiers (pixel ratio, shadows, fog, cull distance)

## Performance

Quality tier is auto-detected from device memory, core count and screen size, then a frame-budget watchdog drops one tier if the game runs slow for ~1.5s (it only ever steps down, so it can't oscillate). Distant city blocks are culled by bucketing world-space bounding boxes along the street; full-length geometry like the ground plane and roads is exempt so the world never blinks out.

## Deploying

Push to `main`. The Pages workflow builds, verifies and deploys.

In repo **Settings → Pages**, set the source to **GitHub Actions**.

All paths are relative, so the site works from `username.github.io/repo-name/` without changes. When you ship a change that must invalidate caches, bump `CACHE` in `sw.js`.
