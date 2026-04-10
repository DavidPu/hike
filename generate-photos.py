#!/usr/bin/env python3
"""
Scans pics/ for JPEG files, extracts EXIF GPS coordinates,
generates thumbnails in pics/thumbs/, web-optimized versions in pics/web/,
and writes pics-manifest.json.
"""

import json
import os
import sys
from pathlib import Path
from PIL import Image, ExifTags

ROOT = Path(__file__).resolve().parent
PICS_DIR = ROOT / "pics"
THUMB_DIR = ROOT / "pics" / "thumbs"
WEB_DIR = ROOT / "pics" / "web"
GENERATED_DIRS = {THUMB_DIR, WEB_DIR}
MANIFEST = ROOT / "pics-manifest.json"
THUMB_SIZE = (240, 240)
WEB_LONG_EDGE = 1600
WEB_QUALITY = 82

ORIENTATION_TAG = 274
GPS_TAG = 34853
DATETIME_ORIGINAL_TAG = 36867
EXIF_ORIENTATION_OPS = {
    2: [Image.FLIP_LEFT_RIGHT],
    3: [Image.ROTATE_180],
    4: [Image.FLIP_TOP_BOTTOM],
    5: [Image.TRANSPOSE],
    6: [Image.ROTATE_270],
    7: [Image.TRANSVERSE],
    8: [Image.ROTATE_90],
}


def dms_to_decimal(dms, ref):
    """Convert (degrees, minutes, seconds) + N/S/E/W ref to decimal."""
    d, m, s = [float(x) for x in dms]
    decimal = d + m / 60 + s / 3600
    if ref in ("S", "W"):
        decimal = -decimal
    return decimal


def extract_gps(exif):
    gps = exif.get(GPS_TAG)
    if not gps:
        return None
    try:
        lat_ref = gps.get(1)
        lat_dms = gps.get(2)
        lon_ref = gps.get(3)
        lon_dms = gps.get(4)
        if not all([lat_ref, lat_dms, lon_ref, lon_dms]):
            return None
        lat = dms_to_decimal(lat_dms, lat_ref)
        lon = dms_to_decimal(lon_dms, lon_ref)
        return round(lat, 6), round(lon, 6)
    except Exception:
        return None


def fix_orientation(img, exif):
    orient = exif.get(ORIENTATION_TAG, 1)
    ops = EXIF_ORIENTATION_OPS.get(orient)
    if ops:
        for op in ops:
            img = img.transpose(op)
    return img


def make_thumbnail(src_path, thumb_path, exif):
    img = Image.open(src_path)
    img = fix_orientation(img, exif)
    img.thumbnail(THUMB_SIZE, Image.LANCZOS)
    thumb_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(thumb_path, "JPEG", quality=80)


def make_web(src_path, web_path, exif):
    img = Image.open(src_path)
    img = fix_orientation(img, exif)
    w, h = img.size

    # Center-crop to 50% of original dimensions
    cw, ch = w // 2, h // 2
    left = (w - cw) // 2
    top = (h - ch) // 2
    img = img.crop((left, top, left + cw, top + ch))

    # Then scale down if still larger than WEB_LONG_EDGE
    w2, h2 = img.size
    long_edge = max(w2, h2)
    if long_edge > WEB_LONG_EDGE:
        scale = WEB_LONG_EDGE / long_edge
        img = img.resize((round(w2 * scale), round(h2 * scale)), Image.LANCZOS)

    web_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(web_path, "JPEG", quality=WEB_QUALITY, optimize=True)


def is_generated_dir(dp):
    return any(dp == gd or gd in dp.parents for gd in GENERATED_DIRS)


def process_all():
    THUMB_DIR.mkdir(parents=True, exist_ok=True)
    WEB_DIR.mkdir(parents=True, exist_ok=True)
    entries = []
    extensions = {".jpg", ".jpeg"}

    for dirpath, _, filenames in os.walk(PICS_DIR):
        dp = Path(dirpath)
        if is_generated_dir(dp):
            continue
        for fname in sorted(filenames):
            fp = dp / fname
            if fp.suffix.lower() not in extensions:
                continue

            try:
                img = Image.open(fp)
                exif = img._getexif()
                if not exif:
                    print(f"  SKIP (no EXIF): {fp.relative_to(ROOT)}")
                    continue

                coords = extract_gps(exif)
                if not coords:
                    print(f"  SKIP (no GPS):  {fp.relative_to(ROOT)}")
                    continue

                lat, lon = coords
                dt = exif.get(DATETIME_ORIGINAL_TAG, "")

                rel = fp.relative_to(PICS_DIR)
                flat_name = str(rel).replace(os.sep, "_")

                thumb_path = THUMB_DIR / flat_name
                if not thumb_path.exists():
                    make_thumbnail(fp, thumb_path, exif)

                web_path = WEB_DIR / flat_name
                if not web_path.exists():
                    make_web(fp, web_path, exif)

                entries.append({
                    "lat": lat,
                    "lon": lon,
                    "src": str(web_path.relative_to(ROOT)),
                    "thumb": str(thumb_path.relative_to(ROOT)),
                    "name": fp.stem,
                    "date": dt,
                })
                print(f"  OK: {fp.relative_to(ROOT)}  →  ({lat}, {lon})")

            except Exception as e:
                print(f"  ERR: {fp.relative_to(ROOT)}: {e}", file=sys.stderr)

    entries.sort(key=lambda e: e.get("date", ""))

    with open(MANIFEST, "w") as f:
        json.dump(entries, f, indent=2)

    print(f"\nWrote {len(entries)} photo(s) to {MANIFEST.relative_to(ROOT)}")


if __name__ == "__main__":
    process_all()
