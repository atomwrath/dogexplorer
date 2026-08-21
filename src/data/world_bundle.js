// src/data/world_bundle.js
//
// Loads a `pup-world/1` bundle produced by tools/fetch_dem.py: QGIS vector
// layers plus a terrarium-derived heightfield, in one file.
//
// The bundle carries its own projection constants. Project GeoJSON with
// `world.project()` rather than a hardcoded formula, so vectors and terrain
// are guaranteed to share a coordinate system.

const FORMAT = 'pup-world/1';

/**
 * fetch_dem.py writes `layers` as an OBJECT keyed by source filename
 * ({"pup-trails-map": {...FeatureCollection}}), because that is the natural
 * shape coming out of `load_layers()`. Consumers iterate layers as an ARRAY.
 * Spreading an object into an array literal throws "is not iterable", which
 * meant every real bundle blew up inside rebuildWorld() the moment it loaded --
 * no map, and therefore no trailheads, no start point and no avatar.
 *
 * Normalising here rather than at the call site means there is exactly one
 * place that knows about the two shapes, and `World.layers` is an array for
 * everyone: the game, the map editor and anything written later. Both shapes
 * stay valid on disk, so old bundles keep working.
 */
function normaliseLayers(layers) {
  if (!layers) return [];
  if (Array.isArray(layers)) return layers.filter(Boolean);
  return Object.entries(layers)
    .map(([name, doc]) => (doc && !doc.name ? { ...doc, name } : doc))
    .filter(Boolean);
}

function decodeInt16LE(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  // Terrarium PNGs are little-endian by construction here; DataView keeps
  // this correct on big-endian hosts too.
  const view = new DataView(bytes.buffer);
  const out = new Int16Array(bytes.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true);
  return out;
}

export class World {
  constructor(bundle) {
    if (bundle.format !== FORMAT) {
      throw new Error(`Unsupported bundle format: ${bundle.format}`);
    }
    const hf = bundle.heightfield;
    const pr = bundle.projection;

    this.bundle = bundle;
    this.layers = normaliseLayers(bundle.layers);
    this.bounds = bundle.bounds;
    this.attribution = bundle.attribution;

    this.originLon = pr.originLon;
    this.originLat = pr.originLat;
    this.mPerDegLon = pr.metresPerDegreeLon;
    this.mPerDegLat = pr.metresPerDegreeLat;
    this.zSign = pr.zAxis === 'north' ? -1 : 1;

    this.cell = hf.cell;
    this.width = hf.width;
    this.height = hf.height;
    this.originX = hf.originX;
    this.originZ = hf.originZ;
    this.minM = hf.minM;
    this.maxM = hf.maxM;
    this.mapScale = 1;

    const raw = decodeInt16LE(hf.data);
    if (raw.length !== hf.width * hf.height) {
      throw new Error(`Heightfield size mismatch: ${raw.length} vs ${hf.width * hf.height}`);
    }

    // Expand once to Float32 metres. ~200 KB for a 2 km square at 8 m cells.
    this.heights = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) {
      this.heights[i] = hf.baseM + raw[i] / hf.scale;
    }
  }

  // --- horizontal scale -------------------------------------------------

  /**
   * Shrink or stretch the whole map horizontally.
   *
   * Scale MUST be applied here rather than in the game layer, because the
   * projection and the heightfield grid have to move together: `project()`
   * turns lon/lat into metres, and `cellI/cellJ` turn those same metres back
   * into DEM cells. Scaling one without the other silently decouples the
   * vectors from the terrain -- trails would drape over the wrong ground.
   * Deriving both from the untouched bundle constants keeps them consistent
   * for any scale, and makes repeat calls idempotent rather than cumulative.
   *
   * Elevations stay in true metres; vertical scale is the game's business
   * (see trails/world.js), so a scaled map is not automatically flattened.
   */
  setMapScale(scale) {
    // Lower bound loosened from 0.05 to 0.0005 to support "1:N" compaction up to
    // N=1000 (trails/main.js). Upper bound unchanged -- the UI only ever asks to shrink,
    // never enlarge past true scale, since "1:N" notation has no way to express that.
    const s = Math.max(0.0005, Math.min(8, Number(scale) || 1));
    const hf = this.bundle.heightfield;
    const pr = this.bundle.projection;
    this.mapScale = s;
    this.mPerDegLon = pr.metresPerDegreeLon * s;
    this.mPerDegLat = pr.metresPerDegreeLat * s;
    this.cell = hf.cell * s;
    this.originX = hf.originX * s;
    this.originZ = hf.originZ * s;
    return this;
  }

  // --- projection -------------------------------------------------------

  project(lon, lat, out = { x: 0, z: 0 }) {
    out.x = (lon - this.originLon) * this.mPerDegLon;
    out.z = (this.originLat - lat) * this.mPerDegLat * this.zSign;
    return out;
  }

  unproject(x, z, out = { lon: 0, lat: 0 }) {
    out.lon = this.originLon + x / this.mPerDegLon;
    out.lat = this.originLat - (z * this.zSign) / this.mPerDegLat;
    return out;
  }

  /** Project a GeoJSON coordinate array of any nesting depth, in place-safe fashion. */
  projectCoords(coords) {
    if (typeof coords[0] === 'number') {
      const p = this.project(coords[0], coords[1]);
      return [p.x, p.z];
    }
    return coords.map((c) => this.projectCoords(c));
  }

  // --- heightfield ------------------------------------------------------

  cellI(x) {
    const i = Math.floor((x - this.originX) / this.cell);
    return i < 0 ? 0 : i >= this.width ? this.width - 1 : i;
  }

  cellJ(z) {
    const j = Math.floor((z - this.originZ) / this.cell);
    return j < 0 ? 0 : j >= this.height ? this.height - 1 : j;
  }

  contains(x, z) {
    return x >= this.originX && x < this.originX + this.width * this.cell
        && z >= this.originZ && z < this.originZ + this.height * this.cell;
  }

  /**
   * Raw DEM elevation in metres for the cell containing (x, z).
   *
   * Deliberately nearest-cell, not bilinear: the terrain is piecewise
   * constant per cell, so a flat-bottomed object anywhere inside a cell
   * must read exactly one height. Interpolating here would reintroduce the
   * floating/buried-edge class of bugs the terracing exists to prevent.
   */
  heightAt(x, z) {
    return this.heights[this.cellJ(z) * this.width + this.cellI(x)];
  }

  /** Snapped ground height for a terrace step, in metres. */
  groundAt(x, z, step) {
    return Math.floor(this.heightAt(x, z) / step) * step;
  }

  /** Terrace band index (integer) for a cell. */
  bandAt(x, z, step) {
    return Math.floor(this.heightAt(x, z) / step);
  }

  /** World-space centre of cell (i, j). */
  cellCentre(i, j, out = { x: 0, z: 0 }) {
    out.x = this.originX + (i + 0.5) * this.cell;
    out.z = this.originZ + (j + 0.5) * this.cell;
    return out;
  }

  /**
   * Quantise the whole field to terrace band indices.
   * Returns an Int32Array in the same row-major order as `heights`.
   */
  terraceGrid(step) {
    const out = new Int32Array(this.heights.length);
    for (let i = 0; i < out.length; i++) {
      out[i] = Math.floor(this.heights[i] / step);
    }
    return out;
  }

  /** Distinct band count at a given step -- useful for sanity-checking a step size. */
  bandCount(step) {
    return Math.floor(this.maxM / step) - Math.floor(this.minM / step) + 1;
  }
}

export function loadWorldBundle(bundle) {
  return new World(bundle);
}

export async function fetchWorldBundle(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
  return new World(await res.json());
}
