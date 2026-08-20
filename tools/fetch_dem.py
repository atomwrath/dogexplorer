#!/usr/bin/env python3
"""
fetch_dem.py -- Build a combined world bundle from QGIS GeoJSON exports + AWS terrain tiles.

Reads every .geojson in an input directory, computes the union bounding box,
downloads Terrarium-encoded elevation tiles covering that box, resamples them
onto the game's local metric cell grid, and writes ONE .json file containing
both the vector layers and the heightfield.

The bundle also records the exact projection constants used, so the game can
project the GeoJSON coordinates with the same numbers instead of hardcoding
its own -- keeping vectors and terrain aligned by construction.

Usage:
    python3 tools/fetch_dem.py data/geojson -o data/world.json --cell 8
    python3 tools/fetch_dem.py data/geojson -o data/world.json --cell 8 --origin -104.8697 38.8783

Deps: numpy, Pillow
"""

import argparse
import base64
import io
import json
import math
import ssl
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from PIL import Image

# Some Python installs (notably conda on macOS) don't wire up the system CA
# bundle, so urllib fails with CERTIFICATE_VERIFY_FAILED even though the
# system's own certs are fine. Prefer certifi's bundle explicitly when it's
# installed; fall back to the interpreter default otherwise.
def _build_ssl_context():
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


SSL_CONTEXT = _build_ssl_context()

# --------------------------------------------------------------------------
# Terrain tile source
# --------------------------------------------------------------------------

DEFAULT_TILE_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
TILE_PX = 256
MAX_ZOOM = 15  # elevation-tiles-prod tops out here

ATTRIBUTION = [
    "Elevation: AWS Terrain Tiles (Mapzen), derived from USGS 3DEP, SRTM and other public sources.",
    "Vector data: (c) OpenStreetMap contributors, ODbL.",
]

# Terrarium encoding: elevation_m = (R * 256 + G + B / 256) - 32768
TERRARIUM_OFFSET = 32768.0

# Heightfield encoding written into the bundle:
#   elevation_m = base_m + (int16_value / 10)
HEIGHT_SCALE = 10.0  # decimetre precision


# --------------------------------------------------------------------------
# Geodesy -- local east/north metres about an origin
# --------------------------------------------------------------------------

def metres_per_degree(lat_deg, model="wgs84"):
    """Return (metres_per_deg_lon, metres_per_deg_lat) at a given latitude.

    'wgs84' uses the standard ellipsoidal series (accurate to <1 cm/deg).
    'sphere' uses a plain R=6378137 sphere, which is what a lot of quick
    hand-rolled projections use. Pick whichever matches your existing code;
    over 5 km the two differ by roughly 25 m, which is very visible in-game.
    """
    phi = math.radians(lat_deg)
    if model == "sphere":
        m_per_deg = math.pi * 6378137.0 / 180.0
        return m_per_deg * math.cos(phi), m_per_deg
    m_lat = (111132.92
             - 559.82 * math.cos(2 * phi)
             + 1.175 * math.cos(4 * phi)
             - 0.0023 * math.cos(6 * phi))
    m_lon = (111412.84 * math.cos(phi)
             - 93.5 * math.cos(3 * phi)
             + 0.118 * math.cos(5 * phi))
    return m_lon, m_lat


class LocalProjection:
    """Equirectangular projection about a fixed origin.

    +x is east. +z is south by default (three.js convention: viewed from +y
    with the default camera up, north points away from the viewer). Pass
    flip_z=True if your world uses +z north.
    """

    def __init__(self, lon0, lat0, model="wgs84", flip_z=False):
        self.lon0 = lon0
        self.lat0 = lat0
        self.model = model
        self.flip_z = flip_z
        self.m_per_deg_lon, self.m_per_deg_lat = metres_per_degree(lat0, model)
        self.z_sign = -1.0 if flip_z else 1.0

    def forward(self, lon, lat):
        x = (lon - self.lon0) * self.m_per_deg_lon
        z = (self.lat0 - lat) * self.m_per_deg_lat * self.z_sign
        return x, z

    def inverse(self, x, z):
        lon = self.lon0 + x / self.m_per_deg_lon
        lat = self.lat0 - (z * self.z_sign) / self.m_per_deg_lat
        return lon, lat

    def to_dict(self):
        return {
            "kind": "equirectangular-local",
            "originLon": self.lon0,
            "originLat": self.lat0,
            "metresPerDegreeLon": self.m_per_deg_lon,
            "metresPerDegreeLat": self.m_per_deg_lat,
            "zAxis": "north" if self.flip_z else "south",
            "geodesy": self.model,
            "forward": "x = (lon - originLon) * metresPerDegreeLon; "
                       "z = (originLat - lat) * metresPerDegreeLat"
                       + (" * -1" if self.flip_z else ""),
        }


# --------------------------------------------------------------------------
# Web Mercator tile maths
# --------------------------------------------------------------------------

def lonlat_to_tile_xy(lon, lat, z):
    """Fractional tile coordinates (x, y) in Web Mercator at zoom z."""
    lat = max(min(lat, 85.05112878), -85.05112878)
    n = 2.0 ** z
    x = (lon + 180.0) / 360.0 * n
    s = math.sin(math.radians(lat))
    y = (0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * n
    return x, y


def ground_resolution(lat, z):
    """Metres per tile-pixel at a latitude and zoom (256 px tiles)."""
    return 156543.03392 * math.cos(math.radians(lat)) / (2 ** z)


def choose_zoom(lat, cell_m, oversample=2.0):
    """Pick the smallest zoom whose pixels are >= `oversample` finer than a cell."""
    target = cell_m / oversample
    z = math.ceil(math.log2(156543.03392 * math.cos(math.radians(lat)) / target))
    return int(max(0, min(MAX_ZOOM, z)))


# --------------------------------------------------------------------------
# GeoJSON reading
# --------------------------------------------------------------------------

def iter_positions(geom):
    """Yield every (lon, lat) position in any GeoJSON geometry."""
    if geom is None:
        return
    gtype = geom.get("type")
    if gtype == "GeometryCollection":
        for g in geom.get("geometries", []):
            yield from iter_positions(g)
        return
    coords = geom.get("coordinates")
    if coords is None:
        return

    def walk(node):
        if not isinstance(node, (list, tuple)) or not node:
            return
        if isinstance(node[0], (int, float)):
            yield float(node[0]), float(node[1])
        else:
            for child in node:
                yield from walk(child)

    yield from walk(coords)


def check_crs(doc, path):
    """QGIS sometimes writes a legacy `crs` member. Anything that is not
    WGS84 lon/lat would silently produce a garbage bounding box, so bail."""
    crs = doc.get("crs")
    if not crs:
        return
    name = json.dumps(crs.get("properties", {}))
    ok = ("CRS84" in name or "4326" in name)
    if not ok:
        raise SystemExit(
            f"{path.name}: file declares a non-WGS84 CRS ({name}).\n"
            f"Re-export from QGIS with EPSG:4326 (RFC 7946 requires lon/lat)."
        )


def load_layers(input_dir):
    """Load every .geojson in a directory, keyed by filename stem."""
    paths = sorted(Path(input_dir).glob("*.geojson"))
    paths += sorted(Path(input_dir).glob("*.json"))
    if not paths:
        raise SystemExit(f"No .geojson files found in {input_dir}")

    layers = {}
    for path in paths:
        with open(path, "r", encoding="utf-8") as fh:
            doc = json.load(fh)
        if doc.get("type") != "FeatureCollection":
            print(f"  skip {path.name} (not a FeatureCollection)", file=sys.stderr)
            continue
        check_crs(doc, path)
        layers[path.stem] = doc
        n = len(doc.get("features", []))
        print(f"  {path.name}: {n} feature(s)")
    if not layers:
        raise SystemExit("No usable FeatureCollections found.")
    return layers


def union_bounds(layers):
    """Union lon/lat bbox across every feature in every layer."""
    min_lon = min_lat = math.inf
    max_lon = max_lat = -math.inf
    count = 0
    for doc in layers.values():
        for feat in doc.get("features", []):
            for lon, lat in iter_positions(feat.get("geometry")):
                min_lon = min(min_lon, lon)
                max_lon = max(max_lon, lon)
                min_lat = min(min_lat, lat)
                max_lat = max(max_lat, lat)
                count += 1
    if count == 0:
        raise SystemExit("No coordinates found in any layer.")
    return min_lon, min_lat, max_lon, max_lat


# --------------------------------------------------------------------------
# Tile fetching
# --------------------------------------------------------------------------

def fetch_tile(z, x, y, cache_dir, tile_url, retries=3):
    """Return a (256, 256, 3) uint8 array for one tile, using an on-disk cache."""
    cache_path = None
    if cache_dir:
        cache_path = Path(cache_dir) / str(z) / str(x) / f"{y}.png"
        if cache_path.exists():
            with Image.open(cache_path) as im:
                return np.asarray(im.convert("RGB"))

    url = tile_url.format(z=z, x=x, y=y)
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "pup-trails-dem/1.0"})
            with urllib.request.urlopen(req, timeout=30, context=SSL_CONTEXT) as resp:
                blob = resp.read()
            break
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                raise SystemExit(f"Tile {z}/{x}/{y} not found (404). Try a lower --zoom.")
            last = exc
        except Exception as exc:  # noqa: BLE001 - network is best-effort
            # urllib wraps SSL failures inside URLError rather than raising
            # ssl.SSLCertVerificationError directly, so match on the reason.
            reason = getattr(exc, "reason", exc)
            if isinstance(reason, ssl.SSLCertVerificationError) or (
                "CERTIFICATE_VERIFY_FAILED" in str(exc)
            ):
                raise SystemExit(
                    f"TLS certificate verification failed fetching {url}.\n"
                    f"This is usually a conda/macOS Python missing its CA bundle, not a "
                    f"real security issue. Fix with:\n"
                    f"    pip install --upgrade certifi\n"
                    f"then re-run this script (it now uses certifi's bundle automatically).\n"
                    f"Underlying error: {exc}"
                )
            last = exc
        time.sleep(1.5 * (attempt + 1))
    else:
        raise SystemExit(f"Failed to fetch {url}: {last}")

    if cache_path:
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_bytes(blob)

    with Image.open(io.BytesIO(blob)) as im:
        return np.asarray(im.convert("RGB"))


def build_mosaic(z, tx0, ty0, tx1, ty1, cache_dir, tile_url):
    """Stitch a tile range into one float32 elevation array (metres)."""
    nx, ny = tx1 - tx0 + 1, ty1 - ty0 + 1
    total = nx * ny
    print(f"  zoom {z}: {nx} x {ny} = {total} tile(s)")

    mosaic = np.zeros((ny * TILE_PX, nx * TILE_PX, 3), dtype=np.uint8)
    done = 0
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            rgb = fetch_tile(z, tx, ty, cache_dir, tile_url)
            r0 = (ty - ty0) * TILE_PX
            c0 = (tx - tx0) * TILE_PX
            mosaic[r0:r0 + TILE_PX, c0:c0 + TILE_PX] = rgb
            done += 1
            print(f"\r  tiles {done}/{total}", end="", file=sys.stderr)
    print("", file=sys.stderr)

    r = mosaic[:, :, 0].astype(np.float32)
    g = mosaic[:, :, 1].astype(np.float32)
    b = mosaic[:, :, 2].astype(np.float32)
    return (r * 256.0 + g + b / 256.0) - TERRARIUM_OFFSET


def bilinear(grid, px, py):
    """Bilinear sample a 2D array at fractional pixel coords (clamped)."""
    h, w = grid.shape
    px = np.clip(px, 0, w - 1.001)
    py = np.clip(py, 0, h - 1.001)
    x0 = np.floor(px).astype(np.int32)
    y0 = np.floor(py).astype(np.int32)
    x1 = np.minimum(x0 + 1, w - 1)
    y1 = np.minimum(y0 + 1, h - 1)
    fx = (px - x0)[None, :] if px.ndim == 1 else (px - x0)
    fy = (py - y0)[:, None] if py.ndim == 1 else (py - y0)
    v00 = grid[np.ix_(y0, x0)]
    v01 = grid[np.ix_(y0, x1)]
    v10 = grid[np.ix_(y1, x0)]
    v11 = grid[np.ix_(y1, x1)]
    top = v00 * (1 - fx) + v01 * fx
    bot = v10 * (1 - fx) + v11 * fx
    return top * (1 - fy) + bot * fy


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input_dir", help="Directory of QGIS-exported .geojson files")
    ap.add_argument("-o", "--output", default="world.json", help="Bundle path to write")
    ap.add_argument("--cell", type=float, default=8.0,
                    help="Heightfield cell size in metres (match your terrace cell). Default 8")
    ap.add_argument("--margin", type=float, default=100.0,
                    help="Metres of terrain to include beyond the vector bbox. Default 100")
    ap.add_argument("--origin", nargs=2, type=float, metavar=("LON", "LAT"),
                    help="Projection origin. Default: centre of the vector bbox")
    ap.add_argument("--zoom", type=int, default=None,
                    help=f"Tile zoom (0-{MAX_ZOOM}). Default: chosen from --cell")
    ap.add_argument("--geodesy", choices=["wgs84", "sphere"], default="wgs84",
                    help="Degree-to-metre model. Must match your existing projection")
    ap.add_argument("--flip-z", action="store_true", help="Use +z = north instead of +z = south")
    ap.add_argument("--cache-dir", default=".cache/dem-tiles",
                    help="On-disk tile cache so re-runs are free. '' to disable")
    ap.add_argument("--tile-url", default=DEFAULT_TILE_URL, help="Terrarium tile URL template")
    ap.add_argument("--max-tiles", type=int, default=400, help="Refuse to fetch more than this")
    ap.add_argument("--indent", type=int, default=None, help="Pretty-print the JSON")
    args = ap.parse_args()

    print(f"Reading GeoJSON from {args.input_dir}")
    layers = load_layers(args.input_dir)

    min_lon, min_lat, max_lon, max_lat = union_bounds(layers)
    print(f"  vector bbox: {min_lon:.6f},{min_lat:.6f} .. {max_lon:.6f},{max_lat:.6f}")

    if args.origin:
        lon0, lat0 = args.origin
    else:
        lon0 = (min_lon + max_lon) / 2.0
        lat0 = (min_lat + max_lat) / 2.0
    proj = LocalProjection(lon0, lat0, args.geodesy, args.flip_z)
    print(f"  origin: {lon0:.6f}, {lat0:.6f} ({args.geodesy}, +z={proj.to_dict()['zAxis']})")

    # World-metre bbox: project all four corners, then pad.
    xs, zs = [], []
    for lon in (min_lon, max_lon):
        for lat in (min_lat, max_lat):
            x, z = proj.forward(lon, lat)
            xs.append(x)
            zs.append(z)
    min_x, max_x = min(xs) - args.margin, max(xs) + args.margin
    min_z, max_z = min(zs) - args.margin, max(zs) + args.margin

    # Snap the grid origin to a multiple of the cell size so the heightfield
    # lines up with a world-space cell lattice anchored at (0, 0).
    cell = args.cell
    min_x = math.floor(min_x / cell) * cell
    min_z = math.floor(min_z / cell) * cell
    nx = int(math.ceil((max_x - min_x) / cell))
    nz = int(math.ceil((max_z - min_z) / cell))
    print(f"  grid: {nx} x {nz} cells @ {cell} m "
          f"({nx * cell:.0f} x {nz * cell:.0f} m, {nx * nz} samples)")

    zoom = args.zoom if args.zoom is not None else choose_zoom(lat0, cell)
    res = ground_resolution(lat0, zoom)
    print(f"  DEM zoom {zoom} ~ {res:.2f} m/px")
    if res > cell:
        print(f"  NOTE: tile pixels ({res:.1f} m) are coarser than cells ({cell} m); "
              f"terrain will look smoothed.", file=sys.stderr)

    # Cell-centre world coords -> lon/lat -> mercator pixel coords.
    cx = min_x + (np.arange(nx) + 0.5) * cell
    cz = min_z + (np.arange(nz) + 0.5) * cell
    lons = lon0 + cx / proj.m_per_deg_lon
    lats = lat0 - (cz * proj.z_sign) / proj.m_per_deg_lat

    tx_f = np.array([lonlat_to_tile_xy(l, lat0, zoom)[0] for l in lons])
    ty_f = np.array([lonlat_to_tile_xy(lon0, l, zoom)[1] for l in lats])

    tx0, tx1 = int(math.floor(tx_f.min())), int(math.floor(tx_f.max()))
    ty0, ty1 = int(math.floor(ty_f.min())), int(math.floor(ty_f.max()))
    n_tiles = (tx1 - tx0 + 1) * (ty1 - ty0 + 1)
    if n_tiles > args.max_tiles:
        raise SystemExit(
            f"Would need {n_tiles} tiles (limit {args.max_tiles}). "
            f"Lower --zoom, shrink the area, or raise --max-tiles.")

    print("Fetching elevation tiles")
    elev_px = build_mosaic(zoom, tx0, ty0, tx1, ty1, args.cache_dir or None, args.tile_url)

    px = (tx_f - tx0) * TILE_PX
    py = (ty_f - ty0) * TILE_PX
    heights = bilinear(elev_px, px, py).astype(np.float32)  # shape (nz, nx)

    base = float(math.floor(heights.min()))
    quant = np.rint((heights - base) * HEIGHT_SCALE)
    if quant.max() > 32767:
        raise SystemExit("Relief exceeds the int16 range; reduce the area.")
    packed = quant.astype("<i2")

    print(f"  elevation: {heights.min():.1f} .. {heights.max():.1f} m "
          f"(relief {heights.max() - heights.min():.1f} m)")

    bundle = {
        "format": "pup-world/1",
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "attribution": ATTRIBUTION,
        "projection": proj.to_dict(),
        "bounds": {
            "minLon": min_lon, "minLat": min_lat,
            "maxLon": max_lon, "maxLat": max_lat,
            "minX": min_x, "minZ": min_z,
            "maxX": min_x + nx * cell, "maxZ": min_z + nz * cell,
        },
        "heightfield": {
            "cell": cell,
            "width": nx,
            "height": nz,
            "originX": min_x,
            "originZ": min_z,
            "sampleAt": "cell centre: x = originX + (i + 0.5) * cell, "
                        "z = originZ + (j + 0.5) * cell",
            "order": "row-major, index = j * width + i",
            "encoding": "int16le-base64",
            "baseM": base,
            "scale": HEIGHT_SCALE,
            "decode": "elevationM = baseM + int16Value / scale",
            "minM": float(heights.min()),
            "maxM": float(heights.max()),
            "source": {"zoom": zoom, "metresPerPixel": res,
                       "tiles": args.tile_url, "encoding": "terrarium"},
            "data": base64.b64encode(packed.tobytes()).decode("ascii"),
        },
        "layers": layers,
    }

    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(bundle, fh, indent=args.indent)
    size = out.stat().st_size
    print(f"Wrote {out} ({size / 1024:.0f} KiB, "
          f"heightfield {len(bundle['heightfield']['data']) / 1024:.0f} KiB base64)")


if __name__ == "__main__":
    main()
