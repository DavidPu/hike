#!/usr/bin/env python3
"""
Enriches GPX files with elevation data from the Open-Meteo Elevation API.

For each trackpoint missing an <ele> element, fetches elevation from the
Copernicus DEM (90m resolution) via Open-Meteo's free API and writes the
result to a new GPX file.

Usage:
    python3 enrich-elevation.py gpx/input.gpx                # writes gpx/input_enriched.gpx
    python3 enrich-elevation.py gpx/input.gpx -o gpx/out.gpx # custom output path
    python3 enrich-elevation.py gpx/*.gpx                    # batch process multiple files
"""

import argparse
import sys
import time
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen

GPX_NS = "http://www.topografix.com/GPX/1/1"
BATCH_SIZE = 100
API_URL = "https://api.open-meteo.com/v1/elevation"
MAX_RETRIES = 5
RETRY_DELAY = 10


def fetch_elevations(coords):
    """Fetch elevations for a list of (lat, lon) tuples. Returns list of floats."""
    import json

    lats = ",".join(f"{c[0]:.6f}" for c in coords)
    lons = ",".join(f"{c[1]:.6f}" for c in coords)
    url = f"{API_URL}?latitude={lats}&longitude={lons}"

    for attempt in range(MAX_RETRIES):
        try:
            with urlopen(url, timeout=30) as resp:
                data = json.loads(resp.read())
                return data["elevation"]
        except (URLError, TimeoutError, KeyError) as e:
            if attempt < MAX_RETRIES - 1:
                wait = RETRY_DELAY * (attempt + 1)
                print(f"    Retry {attempt + 1} in {wait}s: {e}")
                time.sleep(wait)
            else:
                raise RuntimeError(f"Failed after {MAX_RETRIES} attempts: {e}") from e


def process_gpx(input_path, output_path):
    ET.register_namespace("", GPX_NS)
    ET.register_namespace("xsi", "http://www.w3.org/2001/XMLSchema-instance")

    tree = ET.parse(input_path)
    root = tree.getroot()
    ns = f"{{{GPX_NS}}}"

    all_trkpts = root.findall(f".//{ns}trkpt")
    total = len(all_trkpts)

    missing = [(i, pt) for i, pt in enumerate(all_trkpts) if pt.find(f"{ns}ele") is None]

    if not missing:
        print(f"  All {total} points already have elevation — skipping.")
        return False

    print(f"  {len(missing)}/{total} points missing elevation — fetching...")

    for batch_start in range(0, len(missing), BATCH_SIZE):
        batch = missing[batch_start : batch_start + BATCH_SIZE]
        coords = [(float(pt.get("lat")), float(pt.get("lon"))) for _, pt in batch]

        elevations = fetch_elevations(coords)

        for (_, pt), ele in zip(batch, elevations):
            ele_elem = ET.SubElement(pt, f"{ns}ele")
            ele_elem.text = f"{ele:.1f}"

            time_elem = pt.find(f"{ns}time")
            if time_elem is not None:
                pt.remove(time_elem)
                pt.append(time_elem)

        done = min(batch_start + BATCH_SIZE, len(missing))
        print(f"    Fetched {done}/{len(missing)} elevations")

        if batch_start + BATCH_SIZE < len(missing):
            time.sleep(3)

    tree.write(output_path, xml_declaration=True, encoding="UTF-8")
    print(f"  Written: {output_path}")
    return True


def main():
    parser = argparse.ArgumentParser(description="Enrich GPX files with elevation data")
    parser.add_argument("files", nargs="+", help="GPX file(s) to process")
    parser.add_argument("-o", "--output", help="Output path (only valid with single input file)")
    parser.add_argument("--overwrite", action="store_true", help="Overwrite input file in place")
    args = parser.parse_args()

    if args.output and len(args.files) > 1:
        print("Error: -o/--output can only be used with a single input file", file=sys.stderr)
        sys.exit(1)

    for input_file in args.files:
        input_path = Path(input_file)
        if not input_path.exists():
            print(f"Skipping {input_file}: not found", file=sys.stderr)
            continue

        if args.output:
            output_path = Path(args.output)
        elif args.overwrite:
            output_path = input_path
        else:
            output_path = input_path.with_stem(input_path.stem + "_enriched")

        print(f"Processing: {input_path}")
        try:
            process_gpx(str(input_path), str(output_path))
        except Exception as e:
            print(f"  Error: {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
