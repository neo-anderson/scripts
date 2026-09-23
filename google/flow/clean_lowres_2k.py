#!/usr/bin/env python3
"""
Clean up fake/low-resolution 2K downloads in Google Flow export directories.

When a model/workflow does not support 2K upscaling, clicking native download
may download a 1K image named with 2K. This script scans for files containing '2K'
(excluding '1K'), checks if the file size is less than 1MB (1,048,576 bytes),
and deletes both the 2K image and its corresponding .json sidecar.
"""

import argparse
import os
import sys
from pathlib import Path


def clean_lowres_2k(target_dir: Path, threshold_mb: float = 1.0, dry_run: bool = False):
    target_path = Path(target_dir).expanduser().resolve()
    if not target_path.exists() or not target_path.is_dir():
        print(f"Error: Directory not found: {target_path}", file=sys.stderr)
        sys.exit(1)

    threshold_bytes = int(threshold_mb * 1024 * 1024)
    print(f"Scanning directory: {target_path}")
    print(f"Threshold: < {threshold_mb} MB ({threshold_bytes:,} bytes)")
    print(f"Dry Run: {dry_run}\n")

    # Collect candidate files
    entries = sorted(target_path.iterdir())
    candidates = []

    for item in entries:
        if not item.is_file():
            continue
        filename = item.name

        # Condition: Contains '2K', does NOT contain '1K', and is NOT a .json sidecar
        if "2K" in filename and "1K" not in filename and not filename.endswith(".json"):
            candidates.append(item)

    deleted_images = 0
    deleted_sidecars = 0
    kept_images = 0
    reclaimed_bytes = 0

    for img_path in candidates:
        size = img_path.stat().st_size
        size_mb = size / (1024 * 1024)

        if size < threshold_bytes:
            # Find matching sidecar: either <filename>.json or <stem>.json
            sidecar = None
            candidate_sidecar_1 = img_path.with_name(img_path.name + ".json")
            candidate_sidecar_2 = img_path.with_suffix(".json")

            if candidate_sidecar_1.exists():
                sidecar = candidate_sidecar_1
            elif candidate_sidecar_2.exists():
                sidecar = candidate_sidecar_2

            sidecar_size = sidecar.stat().st_size if (sidecar and sidecar.exists()) else 0

            action_prefix = "[DRY-RUN] Would delete" if dry_run else "[DELETED]"
            print(f"{action_prefix} 2K image: {img_path.name} ({size:,} bytes, {size_mb:.2f} MB)")
            if sidecar and sidecar.exists():
                print(f"  {action_prefix} sidecar: {sidecar.name} ({sidecar_size:,} bytes)")

            if not dry_run:
                img_path.unlink()
                deleted_images += 1
                reclaimed_bytes += size

                if sidecar and sidecar.exists():
                    sidecar.unlink()
                    deleted_sidecars += 1
                    reclaimed_bytes += sidecar_size
            else:
                deleted_images += 1
                reclaimed_bytes += size
                if sidecar and sidecar.exists():
                    deleted_sidecars += 1
                    reclaimed_bytes += sidecar_size
        else:
            kept_images += 1
            print(f"[KEPT] 2K image: {img_path.name} ({size:,} bytes, {size_mb:.2f} MB)")

    print("\n--- Summary ---")
    print(f"Total 2K images evaluated: {len(candidates)}")
    print(f"2K images deleted (< {threshold_mb} MB): {deleted_images}")
    print(f"Sidecars deleted: {deleted_sidecars}")
    print(f"2K images kept (>= {threshold_mb} MB): {kept_images}")
    print(f"Total space reclaimed: {reclaimed_bytes:,} bytes ({reclaimed_bytes / (1024 * 1024):.2f} MB)")


def main():
    parser = argparse.ArgumentParser(description="Delete low-res (<1MB) 2K downloads and their .json sidecars.")
    parser.add_argument("directory", nargs="?", default=".", help="Directory to process")
    parser.add_argument("--threshold-mb", type=float, default=1.0, help="File size threshold in MB (default: 1.0)")
    parser.add_argument("--dry-run", action="store_true", help="Preview deletions without deleting")
    args = parser.parse_args()

    clean_lowres_2k(Path(args.directory), threshold_mb=args.threshold_mb, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
