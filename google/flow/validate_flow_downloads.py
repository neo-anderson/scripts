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
   - Duplicates are treated as a FAILURE.
   - Offers to remove all false duplicate sets (1K/2K images and sidecars),
     keep the potential original set based on lowest visual difference to 1K,
     and move that original set to a 'duplicate_triage/' subfolder.
   - If cleanup succeeds, prints PASSED with a warning pointing to the triage subfolder.
   - If rejected or if cleanup fails, prints FAILED.
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
import shutil
import sys
from collections import defaultdict
from pathlib import Path


IMAGE_PATTERN = re.compile(
    r"^GoogleFlow_(?P<res>1K|2K)_(?P<id>[0-9a-zA-Z_-]+)\.(?P<ext>jpg|jpeg|png)$",
    re.IGNORECASE,
)

SIDECAR_PATTERN = re.compile(
    r"^GoogleFlow_(?P<res>1K|2K)_(?P<id>[0-9a-zA-Z_-]+)\.(?P<ext>jpg|jpeg|png)\.json$",
    re.IGNORECASE,
)

ALT_SIDECAR_PATTERN = re.compile(
    r"^GoogleFlow_(?P<res>1K|2K)_(?P<id>[0-9a-zA-Z_-]+)\.json$",
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
    sc1 = img_path.with_name(img_path.name + ".json")
    if sc1.exists():
        return sc1

    sc2 = img_path.with_suffix(".json")
    if sc2.exists():
        return sc2

    return None


def calculate_visual_diff(img1_path: Path, img2_path: Path) -> float:
    """
    Compute average pixel difference (MAE) between two images scaled to 64x64.
    Lower score means more visually similar.
    """
    try:
        from PIL import Image
        with Image.open(img1_path) as im1, Image.open(img2_path) as im2:
            im1_rgb = im1.convert("RGB").resize((64, 64))
            im2_rgb = im2.convert("RGB").resize((64, 64))
            b1 = im1_rgb.tobytes()
            b2 = im2_rgb.tobytes()
            return sum(abs(x - y) for x, y in zip(b1, b2)) / (64 * 64)
    except Exception:
        return float("inf")


def triage_and_resolve_duplicates(
    duplicate_groups: dict[str, list[Path]],
    items_by_id: dict[str, dict],
    target_dir: Path,
    auto_fix: bool = False,
) -> bool:
    """
    Offers to remove all false duplicate sets, keep the potential original set
    based on lowest visual difference to 1K, and move that original set to
    target_dir / 'duplicate_triage'.

    Returns True if resolved successfully, False otherwise.
    """
    triage_dir = target_dir / "duplicate_triage"

    # Plan actions
    plans = []

    for h, file_list in duplicate_groups.items():
        # Identify all IDs involved in this duplicate hash group
        group_ids = set()
        for f in file_list:
            m = IMAGE_PATTERN.match(f.name)
            if m:
                group_ids.add(m.group("id"))

        if len(group_ids) <= 1:
            continue

        print(f"\nAnalyzing duplicate group (Hash: {h[:12]}..., {len(group_ids)} distinct IDs):")

        # Determine reference duplicate image file (e.g. 2K image)
        ref_img_path = file_list[0]

        # Calculate visual difference against each ID's 1K image (if available)
        id_scores = {}
        for mid in group_ids:
            d = items_by_id.get(mid, {})
            img_1k = d.get("1K")
            if img_1k and img_1k.exists():
                score = calculate_visual_diff(ref_img_path, img_1k)
                mtime = img_1k.stat().st_mtime
            else:
                score = float("inf")
                ref_candidate = d.get("2K") or list(d.values())[0]
                mtime = ref_candidate.stat().st_mtime if ref_candidate else 0.0

            id_scores[mid] = (score, mtime)
            score_str = f"{score:.2f}" if score != float("inf") else "N/A (no 1K)"
            print(f"  • ID {mid}: Visual diff to duplicate 2K = {score_str}")

        # Choose best candidate: minimum visual diff; tiebreaker: earliest mtime
        best_id = min(id_scores.keys(), key=lambda mid: (id_scores[mid][0], id_scores[mid][1]))
        best_score = id_scores[best_id][0]
        score_desc = f"{best_score:.2f}" if best_score != float("inf") else "earliest timestamp"
        print(f"  👉 Potential original identified: {best_id} (score: {score_desc})")

        # Collect files for best_id (to KEEP & MOVE to triage_dir)
        keep_files = []
        best_files_dict = items_by_id.get(best_id, {})
        for k in ("1K", "1K_sidecar", "2K", "2K_sidecar"):
            f = best_files_dict.get(k)
            if f and f.exists() and f not in keep_files:
                keep_files.append(f)

        # Collect files for false duplicate IDs (to REMOVE)
        delete_files = []
        for mid in group_ids:
            if mid == best_id:
                continue
            false_files_dict = items_by_id.get(mid, {})
            for k in ("1K", "1K_sidecar", "2K", "2K_sidecar"):
                f = false_files_dict.get(k)
                if f and f.exists() and f not in delete_files:
                    delete_files.append(f)

        plans.append({
            "hash": h,
            "best_id": best_id,
            "keep_files": keep_files,
            "delete_files": delete_files,
            "false_ids": [m for m in group_ids if m != best_id],
        })

    if not plans:
        return True

    print("\n----------------------------------------------------------------------")
    print(" Proposed Triage Action")
    print("----------------------------------------------------------------------")
    for idx, plan in enumerate(plans, 1):
        print(f"Group #{idx} (Hash {plan['hash'][:12]}...):")
        print(f"  [MOVE TO duplicate_triage/] Original ID {plan['best_id']} ({len(plan['keep_files'])} files):")
        for f in plan["keep_files"]:
            print(f"     ↳ {f.name}")
        print(f"  [DELETE] False duplicate sets ({len(plan['delete_files'])} files across IDs: {', '.join(m[:8] for m in plan['false_ids'])}):")
        for f in plan["delete_files"]:
            print(f"     ✕ {f.name}")

    # Prompt user or check auto_fix
    do_cleanup = False
    if auto_fix:
        print("\n--fix-duplicates flag provided. Proceeding with cleanup automatically.")
        do_cleanup = True
    else:
        if sys.stdin.isatty():
            try:
                resp = input("\nDo you want to proceed with this cleanup? (delete false sets & move original to duplicate_triage/) [y/N]: ").strip().lower()
                do_cleanup = (resp in ("y", "yes"))
            except (KeyboardInterrupt, EOFError):
                print("\nAborted by user.")
                return False
        else:
            print("\nNon-interactive session and --fix-duplicates not specified. Skipping cleanup.")
            return False

    if not do_cleanup:
        print("Cleanup declined. Duplicate sets were not modified.")
        return False

    # Execute cleanup
    try:
        triage_dir.mkdir(parents=True, exist_ok=True)
        for plan in plans:
            # 1. Move original set files to triage_dir
            for f in plan["keep_files"]:
                dest = triage_dir / f.name
                shutil.move(str(f), str(dest))
                print(f"  ✓ Moved to triage: {f.name}")

            # 2. Delete false duplicate sets
            for f in plan["delete_files"]:
                f.unlink(missing_ok=True)
                print(f"  ✕ Deleted false set file: {f.name}")

        print(f"\nAll duplicate actions completed. Potential originals moved to:\n  {triage_dir}")
        return True
    except Exception as e:
        print(f"\nError during duplicate cleanup execution: {e}", file=sys.stderr)
        return False


def validate_directory(
    target_dir: Path,
    check_duplicates: bool = True,
    auto_fix_duplicates: bool = False,
) -> int:
    target_path = Path(target_dir).expanduser().resolve()
    if not target_path.exists() or not target_path.is_dir():
        print(f"Error: Target directory not found: {target_path}", file=sys.stderr)
        return 2

    print("=" * 70)
    print(" Google Flow Downloads & Sidecars Validator")
    print("=" * 70)
    print(f"Directory: {target_path}\n")

    # Data structures to aggregate
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

    has_standard_errors = bool(error_missing_2k or error_missing_1k or error_missing_sidecar)

    if error_missing_2k:
        print("\n[ERROR] Missing 2K for models expecting 2K upscale:")
        for mid, model, path in error_missing_2k:
            print(f"  • ID: {mid} | Model: {model} | File: {path.name}")

    if error_missing_1k:
        print("\n[ERROR] Missing 1K baseline image:")
        for mid, model, path in error_missing_1k:
            print(f"  • ID: {mid} | Model: {model} | File: {path.name}")

    if error_missing_sidecar:
        print("\n[ERROR] Missing .json sidecars:")
        for path, mid, reason in error_missing_sidecar:
            print(f"  • {reason}: {path.name} (ID: {mid})")

    # Duplicate Hash Detection - Classified as Failure
    duplicate_groups = {h: flist for h, flist in hash_to_images.items() if len(flist) > 1}
    duplicates_present = bool(duplicate_groups)
    duplicates_triaged_cleanly = False

    if duplicates_present:
        print("\n----------------------------------------------------------------------")
        print(" [ERROR: FAILURE] Duplicate Image Content Detected Under Multiple IDs")
        print("----------------------------------------------------------------------")
        for h, flist in duplicate_groups.items():
            print(f"Hash: {h} (shared across {len(flist)} files):")
            for f in flist:
                print(f"   ↳ {f.name}")

        # Offer duplicate triage and cleanup
        duplicates_triaged_cleanly = triage_and_resolve_duplicates(
            duplicate_groups=duplicate_groups,
            items_by_id=items_by_id,
            target_dir=target_path,
            auto_fix=auto_fix_duplicates,
        )

    print("\n" + "=" * 70)
    if has_standard_errors:
        print(" RESULT: FAILED (Discrepancies found in file pairs or sidecars)")
        print("=" * 70)
        return 1
    elif duplicates_present and not duplicates_triaged_cleanly:
        print(" RESULT: FAILED (Duplicate image content detected under multiple IDs)")
        print("=" * 70)
        return 1
    elif duplicates_present and duplicates_triaged_cleanly:
        print(" RESULT: PASSED (with WARNING: Duplicates were detected and resolved)")
        print(" WARNING: False duplicate sets were deleted.")
        print(f"          Potential original set was preserved and moved to:")
        print(f"          {target_path / 'duplicate_triage'}")
        print("          Please inspect the 'duplicate_triage' folder to verify.")
        print("=" * 70)
        return 0
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
    parser.add_argument(
        "--fix-duplicates",
        "-y",
        action="store_true",
        help="Automatically remove false duplicate sets and move potential original to duplicate_triage/ without prompting",
    )
    args = parser.parse_args()

    target_dir = Path(args.directory)
    code = validate_directory(
        target_dir,
        check_duplicates=not args.no_hash_check,
        auto_fix_duplicates=args.fix_duplicates,
    )
    sys.exit(code)


if __name__ == "__main__":
    main()
