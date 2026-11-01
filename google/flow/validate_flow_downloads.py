#!/usr/bin/env python3
"""
Validate downloaded Google Flow image exports and sidecars.

Checks:
1. Groups all files starting with 'GoogleFlow_' by media ID.
2. Checks that each media ID has both 1K and 2K image files.
3. Checks that every image file has a matching .json sidecar.
4. If 2K is missing for a media ID, checks the model in the 1K sidecar:
   - If the model is 'imagen_4' (or variant), it is classified as OK (model lacks 2K upscale support).
   - Otherwise, it is classified as an ERROR (missing 2K).
5. Detects identical image hashes across distinct IDs (duplicate download bug).
6. Outputs comprehensive statistics:
   - Images downloaded per model
   - Total number of images
   - Total number of sidecars and files
   - Validation summary & error details
"""

import argparse
import hashlib
import json
import os
import re
import sys
from collections import defaultdict
from pathlib import Path


IMAGE_PATTERN = re.compile(
    r"^GoogleFlow_(?P<res>1K|2K)_(?P<id>[0-9a-fA-F-]+)\.(?P<ext>jpg|jpeg|png)$",
    re.IGNORECASE,
)

SIDECAR_PATTERN = re.compile(
    r"^GoogleFlow_(?P<res>1K|2K)_(?P<id>[0-9a-fA-F-]+)\.(?P<ext>jpg|jpeg|png)\.json$",
    re.IGNORECASE,
)

ALT_SIDECAR_PATTERN = re.compile(
    r"^GoogleFlow_(?P<res>1K|2K)_(?P<id>[0-9a-fA-F-]+)\.json$",
    re.IGNORECASE,
)


def extract_model_from_sidecar(sidecar_path: Path) -> str:
    """Extract model name from sidecar JSON tags or fields."""
    if not sidecar_path or not sidecar_path.exists():
        return "unknown"
    try:
        with open(sidecar_path, "r", encoding="utf-8") as f:
            data = json.load(f)

        # 1. Look in tags for 'ai:model:<name>'
        tags = data.get("tags", [])
        if isinstance(tags, list):
            for tag in tags:
                if isinstance(tag, str) and tag.startswith("ai:model:"):
                    return tag.split("ai:model:", 1)[1]

        # 2. Look in top-level 'model' field
        if "model" in data and isinstance(data["model"], str) and data["model"]:
            return data["model"]

        # 3. Look in metadata dict
        meta = data.get("metadata", {})
        if isinstance(meta, dict) and "model" in meta:
            return meta["model"]

        # 4. Check notes / prompts for model references
        notes = data.get("notes", [])
        if isinstance(notes, list):
            for note in notes:
                if isinstance(note, str) and "model:" in note.lower():
                    m = re.search(r"model:\s*([a-zA-Z0-9_-]+)", note, re.IGNORECASE)
                    if m:
                        return m.group(1)
    except Exception:
        pass
    return "unknown"


def is_imagen_4(model_name: str) -> bool:
    """Check if model name corresponds to imagen_4 family."""
    if not model_name:
        return False
    norm = model_name.strip().lower().replace("-", "_")
    return norm.startswith("imagen_4") or norm == "imagen4"


def compute_file_hash(path: Path) -> str:
    """Compute MD5 hash of a file."""
    hasher = hashlib.md5()
    with open(path, "rb") as f:
        while chunk := f.read(65536):
            hasher.update(chunk)
    return hasher.hexdigest()


def find_matching_sidecar(img_path: Path) -> Path | None:
    """Find sidecar file matching an image path."""
    # Pattern 1: <filename>.json (e.g. GoogleFlow_1K_xyz.jpg.json)
    sc1 = img_path.with_name(img_path.name + ".json")
    if sc1.exists():
        return sc1

    # Pattern 2: <stem>.json (e.g. GoogleFlow_1K_xyz.json)
    sc2 = img_path.with_suffix(".json")
    if sc2.exists():
        return sc2

    return None


def validate_directory(target_dir: Path, check_duplicates: bool = True) -> int:
    target_path = Path(target_dir).expanduser().resolve()
    if not target_path.exists() or not target_path.is_dir():
        print(f"Error: Target directory not found: {target_path}", file=sys.stderr)
        return 2

    print("=" * 70)
    print(" Google Flow Downloads & Sidecars Validator")
    print("=" * 70)
    print(f"Directory: {target_path}\n")

    # Data structures to aggregate
    # media_id -> {'1K': img_path, '2K': img_path, '1K_sidecar': path, '2K_sidecar': path}
    items_by_id = defaultdict(dict)
    all_matched_files = set()
    total_flow_files = 0

    all_entries = sorted(target_path.iterdir())
    for entry in all_entries:
        if not entry.is_file():
            continue
        name = entry.name
        if not name.startswith("GoogleFlow"):
            continue

        total_flow_files += 1

        # Match sidecars first
        m_sc = SIDECAR_PATTERN.match(name)
        if m_sc:
            res = m_sc.group("res").upper()
            mid = m_sc.group("id")
            items_by_id[mid][f"{res}_sidecar"] = entry
            all_matched_files.add(entry)
            continue

        m_alt_sc = ALT_SIDECAR_PATTERN.match(name)
        if m_alt_sc:
            res = m_alt_sc.group("res").upper()
            mid = m_alt_sc.group("id")
            if f"{res}_sidecar" not in items_by_id[mid]:
                items_by_id[mid][f"{res}_sidecar"] = entry
            all_matched_files.add(entry)
            continue

        # Match images
        m_img = IMAGE_PATTERN.match(name)
        if m_img:
            res = m_img.group("res").upper()
            mid = m_img.group("id")
            items_by_id[mid][res] = entry
            all_matched_files.add(entry)
            continue

    # Second pass: ensure any image with sidecar not yet caught by regex is linked
    for mid, d in items_by_id.items():
        if "1K" in d and "1K_sidecar" not in d:
            sc = find_matching_sidecar(d["1K"])
            if sc:
                d["1K_sidecar"] = sc
                all_matched_files.add(sc)
        if "2K" in d and "2K_sidecar" not in d:
            sc = find_matching_sidecar(d["2K"])
            if sc:
                d["2K_sidecar"] = sc
                all_matched_files.add(sc)

    # Classification buckets
    valid_complete = []         # both 1K and 2K, with sidecars
    valid_imagen4_1k_only = []  # 1K only, imagen_4 model, sidecar present
    error_missing_2k = []       # 1K exists, model is NOT imagen_4, missing 2K
    error_missing_1k = []       # 2K exists, but 1K missing
    error_missing_sidecar = []  # image exists, sidecar missing

    # Model counts
    images_per_model = defaultdict(int)
    unique_ids_per_model = defaultdict(int)

    # Duplicate hash detection
    hash_to_images = defaultdict(list)

    total_images_count = 0

    for mid, d in sorted(items_by_id.items()):
        has_1k = "1K" in d
        has_2k = "2K" in d
        has_1k_sc = "1K_sidecar" in d
        has_2k_sc = "2K_sidecar" in d

        if has_1k:
            total_images_count += 1
            if check_duplicates:
                h = compute_file_hash(d["1K"])
                hash_to_images[h].append(d["1K"])

        if has_2k:
            total_images_count += 1
            if check_duplicates:
                h = compute_file_hash(d["2K"])
                hash_to_images[h].append(d["2K"])

        # Determine model
        model = "unknown"
        if has_1k_sc:
            model = extract_model_from_sidecar(d["1K_sidecar"])
        elif has_2k_sc:
            model = extract_model_from_sidecar(d["2K_sidecar"])

        unique_ids_per_model[model] += 1
        if has_1k:
            images_per_model[model] += 1
        if has_2k:
            images_per_model[model] += 1

        # Check sidecar completeness
        sidecar_error = False
        if has_1k and not has_1k_sc:
            error_missing_sidecar.append((d["1K"], mid, "1K sidecar missing"))
            sidecar_error = True
        if has_2k and not has_2k_sc:
            error_missing_sidecar.append((d["2K"], mid, "2K sidecar missing"))
            sidecar_error = True

        # Check resolution pairs
        if has_1k and has_2k:
            if not sidecar_error:
                valid_complete.append((mid, model))
        elif has_1k and not has_2k:
            if is_imagen_4(model):
                if not sidecar_error:
                    valid_imagen4_1k_only.append((mid, model))
            else:
                error_missing_2k.append((mid, model, d["1K"]))
        elif has_2k and not has_1k:
            error_missing_1k.append((mid, model, d["2K"]))

    # Summary Statistics
    total_ids = len(items_by_id)
    total_sidecars_count = sum(
        1 for d in items_by_id.values() for k in ("1K_sidecar", "2K_sidecar") if k in d
    )

    print("----------------------------------------------------------------------")
    print(" Model Statistics")
    print("----------------------------------------------------------------------")
    print(f"{'Model Name':<30} | {'Unique IDs':<12} | {'Image Files':<12}")
    print("-" * 60)
    for model, count in sorted(unique_ids_per_model.items(), key=lambda x: -x[1]):
        img_count = images_per_model[model]
        print(f"{model:<30} | {count:<12} | {img_count:<12}")

    print("\n----------------------------------------------------------------------")
    print(" Overall File Counts")
    print("----------------------------------------------------------------------")
    print(f"Total Unique Media IDs:          {total_ids}")
    print(f"Total Image Files (.jpg/.png):   {total_images_count}")
    print(f"Total Sidecar Files (.json):     {total_sidecars_count}")
    print(f"Total GoogleFlow Files Found:    {total_flow_files}")

    print("\n----------------------------------------------------------------------")
    print(" Validation Results")
    print("----------------------------------------------------------------------")
    print(f"✓ Complete pairs (1K + 2K + sidecars): {len(valid_complete)}")
    print(f"✓ Valid 1K-only (imagen_4 no 2K):      {len(valid_imagen4_1k_only)}")
    print(f"✗ Errors: Missing 2K (non-imagen_4):    {len(error_missing_2k)}")
    print(f"✗ Errors: Missing 1K (2K-only):         {len(error_missing_1k)}")
    print(f"✗ Errors: Missing sidecars:             {len(error_missing_sidecar)}")

    # Detailed Error Listings
    has_errors = False

    if error_missing_2k:
        has_errors = True
        print("\n[ERROR] Missing 2K for models expecting 2K upscale:")
        for mid, model, path in error_missing_2k:
            print(f"  • ID: {mid} | Model: {model} | File: {path.name}")

    if error_missing_1k:
        has_errors = True
        print("\n[ERROR] Missing 1K baseline image:")
        for mid, model, path in error_missing_1k:
            print(f"  • ID: {mid} | Model: {model} | File: {path.name}")

    if error_missing_sidecar:
        has_errors = True
        print("\n[ERROR] Missing .json sidecars:")
        for path, mid, reason in error_missing_sidecar:
            print(f"  • {reason}: {path.name} (ID: {mid})")

    # Duplicate Hash Warnings
    duplicate_groups = {h: flist for h, flist in hash_to_images.items() if len(flist) > 1}
    if duplicate_groups:
        print("\n----------------------------------------------------------------------")
        print(" [WARNING] Duplicate Image Content Detected (Same bytes, different files)")
        print("----------------------------------------------------------------------")
        for h, flist in duplicate_groups.items():
            print(f"Hash: {h} (shared across {len(flist)} files):")
            for f in flist:
                print(f"   ↳ {f.name}")
        print("  NOTE: If 2K files for different IDs share the exact same hash,")
        print("        Google Flow's native download was intercepted and renamed")
        print("        to multiple IDs while downloading the same upscaled image.")

    print("\n" + "=" * 70)
    if has_errors:
        print(" RESULT: FAILED (Discrepancies found)")
        print("=" * 70)
        return 1
    else:
        print(" RESULT: PASSED (All downloads valid according to model capabilities)")
        print("=" * 70)
        return 0


def main():
    parser = argparse.ArgumentParser(
        description="Validate Google Flow downloaded images and sidecars."
    )
    parser.add_argument(
        "directory",
        nargs="?",
        default=".",
        help="Path to directory containing GoogleFlow files (default: current directory)",
    )
    parser.add_argument(
        "--no-hash-check",
        action="store_true",
        help="Skip image MD5 hash computation for duplicate detection",
    )
    args = parser.parse_args()

    target_dir = Path(args.directory)
    code = validate_directory(target_dir, check_duplicates=not args.no_hash_check)
    sys.exit(code)


if __name__ == "__main__":
    main()
