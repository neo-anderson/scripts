#!/usr/bin/env python3
"""
Rename natively downloaded Google Flow images to canonical GoogleFlow format.

Google Flow native downloads are named:
  1K: <prompt_slug>_<short_id>.<ext>
  2K: <prompt_slug>_<short_id>_2K.<ext>

Where <short_id> is the first 8 characters of the full media UUID.

This script:
1. Scans sidecar JSON files (e.g. GoogleFlow_1K_<UUID>.jpg.json) in the base directory
   (or current directory) to map short IDs (8 hex chars) -> full UUIDs.
2. Scans the 'download/' subfolder (or specified images folder) for native Flow filenames.
3. Matches images by their 8-character ID suffix to the full UUID.
4. Renames:
     <slug>_<short_id>.<ext>    -> GoogleFlow_1K_<full_uuid>.<ext>
     <slug>_<short_id>_2K.<ext> -> GoogleFlow_2K_<full_uuid>.<ext>
5. Optionally copies or generates matching .json sidecars for both 1K and 2K files.
"""

import argparse
import json
import os
import re
import shutil
import sys
from collections import defaultdict
from pathlib import Path


# Regex to extract full UUID from existing sidecars or GoogleFlow files
SIDECAR_UUID_PATTERN = re.compile(
    r"^GoogleFlow_(?P<res>1K|2K)_(?P<uuid>[0-9a-fA-F-]{36})\.(?:jpg|jpeg|png)?\.?json$",
    re.IGNORECASE,
)
GENERIC_SIDECAR_PATTERN = re.compile(
    r"^(?:GoogleFlow_)?(?P<uuid>[0-9a-fA-F-]{36})\.(?:jpg|jpeg|png)?\.?json$",
    re.IGNORECASE,
)
GOOGLEFLOW_FILE_PATTERN = re.compile(
    r"^GoogleFlow_(?P<res>1K|2K)_(?P<uuid>[0-9a-fA-F-]{36})\.(?P<ext>jpg|jpeg|png)$",
    re.IGNORECASE,
)

# Regex to match native Flow filenames:
#   2K: e.g. "Man_and_woman_posing_together_18eddfc2_2K.jpg"
NATIVE_2K_PATTERN = re.compile(
    r"^(?P<slug>.+?)_(?P<short_id>[0-9a-fA-F]{8})_2[kK]\.(?P<ext>jpg|jpeg|png)$",
    re.IGNORECASE,
)
#   1K: e.g. "Man_and_woman_posing_together_18eddfc2.jpg"
NATIVE_1K_PATTERN = re.compile(
    r"^(?P<slug>.+?)_(?P<short_id>[0-9a-fA-F]{8})\.(?P<ext>jpg|jpeg|png)$",
    re.IGNORECASE,
)


def inspect_json_resolution(json_path: Path) -> str:
    """
    Determines resolution ('1K', '2K', or 'unknown') of a JSON sidecar
    from its filename and its JSON contents (tags).
    """
    if not json_path or not json_path.exists():
        return "unknown"

    name_upper = json_path.name.upper()
    if "_2K_" in name_upper or name_upper.startswith("GOOGLEFLOW_2K_"):
        return "2K"
    if "_1K_" in name_upper or name_upper.startswith("GOOGLEFLOW_1K_"):
        return "1K"

    # Inspect JSON contents
    try:
        with open(json_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        tags = data.get("tags", [])
        if isinstance(tags, list):
            for t in tags:
                if t in ("media:resolution:2k", "media:upscaled:true"):
                    return "2K"
                if t in ("media:resolution:1k", "media:upscaled:false"):
                    return "1K"
    except Exception:
        pass

    return "unknown"


def build_uuid_map(
    sidecar_dirs: list[Path],
) -> tuple[dict[str, dict], dict[str, list[str]]]:
    """
    Scans directories for sidecars and GoogleFlow files to build a mapping:
    short_id (lowercase 8-char) -> {
        'full_uuid': str,
        'sidecar_1k': Path | None,
        'sidecar_2k': Path | None,
        'generic_sidecar': Path | None
    }
    Also returns:
    ambiguous_short_ids: dict mapping short_id -> list of distinct full_uuids (if collisions occur)
    """
    short_to_uuids = defaultdict(set)
    uuid_info = defaultdict(
        lambda: {"sidecar_1k": None, "sidecar_2k": None, "generic_sidecar": None}
    )

    for d in sidecar_dirs:
        if not d.exists() or not d.is_dir():
            continue

        for p in d.iterdir():
            if not p.is_file():
                continue

            full_uuid = None
            res = None

            # 1. Check explicit 1K / 2K sidecar pattern
            m_sc = SIDECAR_UUID_PATTERN.match(p.name)
            if m_sc:
                full_uuid = m_sc.group("uuid").lower()
                res = m_sc.group("res").upper()
            else:
                # 2. Check generic sidecar pattern
                m_gen = GENERIC_SIDECAR_PATTERN.match(p.name)
                if m_gen:
                    full_uuid = m_gen.group("uuid").lower()
                    res = inspect_json_resolution(p)
                else:
                    # 3. Check GoogleFlow image files
                    m_gf = GOOGLEFLOW_FILE_PATTERN.match(p.name)
                    if m_gf:
                        full_uuid = m_gf.group("uuid").lower()
                        res = m_gf.group("res").upper()

            if full_uuid:
                short_id = full_uuid[:8]
                short_to_uuids[short_id].add(full_uuid)

                if p.name.endswith(".json"):
                    detected_res = inspect_json_resolution(p)
                    if detected_res == "2K" and not uuid_info[full_uuid]["sidecar_2k"]:
                        uuid_info[full_uuid]["sidecar_2k"] = p
                    elif detected_res == "1K" and not uuid_info[full_uuid]["sidecar_1k"]:
                        uuid_info[full_uuid]["sidecar_1k"] = p
                    elif not uuid_info[full_uuid]["generic_sidecar"]:
                        uuid_info[full_uuid]["generic_sidecar"] = p

    # Separate unambiguous short IDs from ambiguous collisions
    uuid_map = {}
    ambiguous_short_ids = {}

    for short_id, uuids in short_to_uuids.items():
        if len(uuids) > 1:
            ambiguous_short_ids[short_id] = sorted(list(uuids))
        else:
            full_uuid = next(iter(uuids))
            uuid_map[short_id] = {
                "full_uuid": full_uuid,
                **uuid_info[full_uuid],
            }

    return uuid_map, ambiguous_short_ids


def plan_renames(
    images_dir: Path,
    uuid_map: dict[str, dict],
    ambiguous_short_ids: dict[str, list[str]],
    allow_overwrite: bool = False,
) -> tuple[list[dict], list[Path], list[dict]]:
    """
    Plans renames for files in images_dir and detects all conflicts.
    Returns:
      (plans, unmapped_files, conflicts)
    """
    raw_candidates = []
    unmapped = []
    conflicts = []

    for p in sorted(images_dir.iterdir()):
        if not p.is_file():
            continue

        name = p.name
        if name.startswith("."):
            continue

        # Skip files already in GoogleFlow format
        if name.startswith("GoogleFlow_"):
            continue

        # Check 2K pattern first
        m2k = NATIVE_2K_PATTERN.match(name)
        if m2k:
            short_id = m2k.group("short_id").lower()
            ext = m2k.group("ext").lower()
            if short_id in ambiguous_short_ids:
                conflicts.append({
                    "type": "ambiguous_id",
                    "source": p,
                    "target": None,
                    "short_id": short_id,
                    "details": f"Short ID matches multiple UUIDs in sidecars: {', '.join(ambiguous_short_ids[short_id])}",
                })
            elif short_id in uuid_map:
                full_uuid = uuid_map[short_id]["full_uuid"]
                target_name = f"GoogleFlow_2K_{full_uuid}.{ext}"
                target_path = images_dir / target_name
                raw_candidates.append({
                    "source": p,
                    "target": target_path,
                    "res": "2K",
                    "short_id": short_id,
                    "full_uuid": full_uuid,
                    "slug": m2k.group("slug"),
                })
            else:
                unmapped.append(p)
            continue

        # Check 1K pattern
        m1k = NATIVE_1K_PATTERN.match(name)
        if m1k:
            short_id = m1k.group("short_id").lower()
            ext = m1k.group("ext").lower()
            if short_id in ambiguous_short_ids:
                conflicts.append({
                    "type": "ambiguous_id",
                    "source": p,
                    "target": None,
                    "short_id": short_id,
                    "details": f"Short ID matches multiple UUIDs in sidecars: {', '.join(ambiguous_short_ids[short_id])}",
                })
            elif short_id in uuid_map:
                full_uuid = uuid_map[short_id]["full_uuid"]
                target_name = f"GoogleFlow_1K_{full_uuid}.{ext}"
                target_path = images_dir / target_name
                raw_candidates.append({
                    "source": p,
                    "target": target_path,
                    "res": "1K",
                    "short_id": short_id,
                    "full_uuid": full_uuid,
                    "slug": m1k.group("slug"),
                })
            else:
                unmapped.append(p)
            continue

    # Cross-check for collisions (multiple sources targeting the same filename)
    target_groups = defaultdict(list)
    for c in raw_candidates:
        target_groups[c["target"]].append(c)

    plans = []
    for target_path, group in target_groups.items():
        if len(group) > 1:
            # Multiple sources mapping to the exact same target filename
            source_names = [item["source"].name for item in group]
            for item in group:
                conflicts.append({
                    "type": "multiple_sources",
                    "source": item["source"],
                    "target": target_path,
                    "short_id": item["short_id"],
                    "details": f"Collision: multiple source files target the same name ({', '.join(source_names)})",
                })
        else:
            item = group[0]
            # Check if destination file already exists on disk
            if target_path.exists():
                try:
                    target_sz = target_path.stat().st_size
                    source_sz = item["source"].stat().st_size
                    same_sz = (target_sz == source_sz)
                    sz_info = (
                        f"identical size ({source_sz} bytes)"
                        if same_sz
                        else f"DIFFERENT sizes (target: {target_sz} bytes vs source: {source_sz} bytes)"
                    )
                except Exception:
                    sz_info = "size unknown"

                if allow_overwrite:
                    item["will_overwrite"] = True
                    plans.append(item)
                else:
                    conflicts.append({
                        "type": "destination_exists",
                        "source": item["source"],
                        "target": target_path,
                        "short_id": item["short_id"],
                        "details": f"Destination file already exists on disk [{sz_info}]. Pass --overwrite to replace.",
                    })
            else:
                plans.append(item)

    return plans, unmapped, conflicts


def resolve_sidecar_for_resolution(res: str, sidecar_info: dict) -> tuple[Path | None, str]:
    """
    Finds the best sidecar JSON file for the given resolution ("1K" or "2K").
    Returns (source_path, status_description).
    Status description explains if it is an exact resolution match or derived.
    """
    exact_key = f"sidecar_{res.lower()}"
    exact_sc = sidecar_info.get(exact_key)
    if exact_sc and exact_sc.exists():
        if inspect_json_resolution(exact_sc) == res:
            return exact_sc, f"exact {res} sidecar match ({exact_sc.name})"

    # If exact resolution sidecar not found, check the alternate resolution to derive from
    alt_res = "1K" if res == "2K" else "2K"
    alt_sc = sidecar_info.get(f"sidecar_{alt_res.lower()}")
    if alt_sc and alt_sc.exists():
        return alt_sc, f"derived from {alt_res} sidecar ({alt_sc.name}) with tags updated to {res}"

    # Fallback to generic sidecar if present
    gen_sc = sidecar_info.get("generic_sidecar")
    if gen_sc and gen_sc.exists():
        return gen_sc, f"derived from generic sidecar ({gen_sc.name}) with tags updated to {res}"

    return None, "no sidecar found"


def copy_or_create_sidecar(
    plan: dict, sidecar_info: dict, target_dir: Path, dry_run: bool = False
) -> tuple[Path | None, str]:
    """
    Copies or creates matching sidecar JSON for the renamed file, ensuring
    exact resolution matching and tag consistency.
    """
    res = plan["res"]
    target_img = plan["target"]
    target_sidecar = target_dir / f"{target_img.name}.json"

    sc_source, desc = resolve_sidecar_for_resolution(res, sidecar_info)
    if not sc_source or not sc_source.exists():
        return None, desc

    if not dry_run and not target_sidecar.exists():
        try:
            with open(sc_source, "r", encoding="utf-8") as f:
                data = json.load(f)

            # Update tags if necessary to reflect target resolution
            tags = data.get("tags", [])
            if isinstance(tags, list):
                new_tags = []
                has_res = False
                has_upscaled = False
                for t in tags:
                    if t.startswith("media:resolution:"):
                        new_tags.append(f"media:resolution:{res.lower()}")
                        has_res = True
                    elif t.startswith("media:upscaled:"):
                        new_tags.append(
                            "media:upscaled:true"
                            if res == "2K"
                            else "media:upscaled:false"
                        )
                        has_upscaled = True
                    else:
                        new_tags.append(t)
                if not has_res:
                    new_tags.append(f"media:resolution:{res.lower()}")
                if not has_upscaled:
                    new_tags.append(
                        "media:upscaled:true"
                        if res == "2K"
                        else "media:upscaled:false"
                    )
                data["tags"] = new_tags

            with open(target_sidecar, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
        except Exception as e:
            print(f"  Warning: failed to write sidecar {target_sidecar.name}: {e}")
            return None, f"error writing sidecar: {e}"

    return target_sidecar, desc


def main():
    parser = argparse.ArgumentParser(
        description="Rename native Google Flow downloads to canonical GoogleFlow_1K/2K_<UUID> format."
    )
    parser.add_argument(
        "directory",
        nargs="?",
        default=".",
        help="Directory containing images to rename (defaults to current directory).",
    )
    parser.add_argument(
        "--metadata-dir",
        "-m",
        default=None,
        help="Subfolder containing sidecar JSON files (defaults to <directory>/metadata if present, else auto-detects meta/, sidecars/, or <directory>).",
    )
    parser.add_argument(
        "--images-dir",
        "--download-dir",
        default=None,
        help="Explicit directory containing images to rename (defaults to <directory>).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Simulate renames without modifying any files.",
    )
    parser.add_argument(
        "-y",
        "--yes",
        action="store_true",
        help="Execute renames without interactive prompt.",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Allow overwriting destination files that already exist on disk.",
    )
    parser.add_argument(
        "--copy-sidecars",
        action="store_true",
        default=True,
        help="Also copy/generate matching .json sidecars for renamed images (default: True).",
    )
    parser.add_argument(
        "--no-sidecars",
        dest="copy_sidecars",
        action="store_false",
        help="Do not copy or generate sidecars.",
    )
    parser.add_argument(
        "--search-parent",
        action="store_true",
        help="Also search the parent directory for sidecars.",
    )

    args = parser.parse_args()
    base_dir = Path(args.directory).expanduser().resolve()

    if not base_dir.exists() or not base_dir.is_dir():
        print(f"Error: Directory not found: {base_dir}", file=sys.stderr)
        return 1

    # Determine metadata directory (subfolder priority: metadata/ -> meta/ -> sidecars/ -> base_dir)
    if args.metadata_dir:
        metadata_dir = Path(args.metadata_dir).expanduser().resolve()
    else:
        candidates = ["metadata", "meta", "sidecars"]
        found_meta_subfolder = None
        for c in candidates:
            cand_path = base_dir / c
            if cand_path.exists() and cand_path.is_dir():
                found_meta_subfolder = cand_path
                break
        metadata_dir = found_meta_subfolder if found_meta_subfolder else base_dir

    # Determine images directory (default is base_dir; fallback to download/ if base_dir has no native images)
    if args.images_dir:
        images_dir = Path(args.images_dir).expanduser().resolve()
    else:
        has_native_in_base = any(
            NATIVE_2K_PATTERN.match(p.name) or NATIVE_1K_PATTERN.match(p.name)
            for p in base_dir.iterdir()
            if p.is_file()
        )
        if not has_native_in_base and (base_dir / "download").exists() and (base_dir / "download").is_dir():
            images_dir = base_dir / "download"
        else:
            images_dir = base_dir

    print("=" * 70)
    print(" Google Flow Native Downloads Renamer")
    print("=" * 70)
    print(f"Images Directory:   {images_dir}")
    print(f"Metadata Directory: {metadata_dir}")

    # Build UUID map by looking in metadata_dir and base_dir
    search_dirs = [metadata_dir]
    if base_dir != metadata_dir:
        search_dirs.append(base_dir)
    if images_dir not in search_dirs:
        search_dirs.append(images_dir)
    if args.search_parent and base_dir.parent.exists():
        search_dirs.append(base_dir.parent)

    uuid_map, ambiguous_short_ids = build_uuid_map(search_dirs)
    print(f"Mapped UUIDs from sidecars: {len(uuid_map)} unique IDs found")
    if ambiguous_short_ids:
        print(f"⚠️ Ambiguous short IDs:      {len(ambiguous_short_ids)} ID collisions found")
    print()

    if not uuid_map:
        print("Error: No GoogleFlow sidecar JSON files or reference images found to map short IDs.", file=sys.stderr)
        return 1

    # Plan renames and detect conflicts
    plans, unmapped, conflicts = plan_renames(
        images_dir,
        uuid_map,
        ambiguous_short_ids,
        allow_overwrite=args.overwrite,
    )

    # 1. Report planned safe renames
    if plans:
        print(f"Planned Renames ({len(plans)} file{'s' if len(plans) != 1 else ''}):")
        print("-" * 70)
        for p in plans:
            info = uuid_map.get(p["short_id"], {})
            _, sc_status = resolve_sidecar_for_resolution(p["res"], info)
            overwrite_warn = " ⚠️ [OVERWRITE]" if p.get("will_overwrite") else ""
            print(f"  [{p['res']}] {p['source'].name}")
            print(f"    ↳ New Image:   {p['target'].name}{overwrite_warn}")
            print(f"    ↳ Sidecar:     {p['target'].name}.json ({sc_status})")
            print()

    # 2. Report conflicts & blocking issues
    if conflicts:
        print("=" * 70)
        print(f" ⚠️  CONFLICTS DETECTED ({len(conflicts)} file{'s' if len(conflicts) != 1 else ''} blocked/skipped)")
        print("=" * 70)
        for c in conflicts:
            ctype = c["type"]
            src_name = c["source"].name
            tgt_name = c["target"].name if c.get("target") else "N/A"
            if ctype == "destination_exists":
                print(f"  [DESTINATION ALREADY EXISTS] {src_name}")
                print(f"    ↳ Target:  {tgt_name}")
                print(f"    ↳ Reason:  {c['details']}")
            elif ctype == "multiple_sources":
                print(f"  [TARGET COLLISION] Multiple files map to same target: {src_name}")
                print(f"    ↳ Target:  {tgt_name}")
                print(f"    ↳ Reason:  {c['details']}")
            elif ctype == "ambiguous_id":
                print(f"  [AMBIGUOUS SHORT ID] {src_name}")
                print(f"    ↳ Reason:  {c['details']}")
            print()

    # 3. Report unmapped files
    if unmapped:
        print(f"Unmapped files ({len(unmapped)} files):")
        for p in unmapped:
            print(f"  ? {p.name} (short ID not in sidecars)")
        print()

    # 4. Summary table before execution prompt
    print("----------------------------------------------------------------------")
    print(" Pre-Execution Summary:")
    print(f"  • Safe planned renames: {len(plans)} file(s)")
    if conflicts:
        print(f"  • Conflicting / blocked: {len(conflicts)} file(s) (will NOT be renamed)")
    if unmapped:
        print(f"  • Unmapped / skipped:    {len(unmapped)} file(s)")
    print("----------------------------------------------------------------------")

    if not plans:
        if conflicts:
            print("\n❌ Cannot proceed: All candidate files have conflicts and cannot be safely renamed.")
            if any(c["type"] == "destination_exists" for c in conflicts):
                print("💡 Hint: If you intended to replace existing files, pass '--overwrite'.")
            return 1
        print("No native Flow images found that need renaming.")
        return 0

    if args.dry_run:
        print("[DRY RUN] No files were renamed.")
        return 0

    if not args.yes:
        action_note = f"renaming {len(plans)} file(s)"
        if any(p.get("will_overwrite") for p in plans):
            action_note += " (including OVERWRITING existing files)"
        resp = input(f"\nProceed with {action_note}? [y/N]: ").strip().lower()
        if resp not in ("y", "yes"):
            print("Cancelled.")
            return 0

    # Execute renames
    renamed_count = 0
    sidecars_created = 0

    for p in plans:
        src = p["source"]
        dst = p["target"]
        try:
            if p.get("will_overwrite") and dst.exists():
                dst.unlink()
            src.rename(dst)
            renamed_count += 1

            if args.copy_sidecars:
                info = uuid_map.get(p["short_id"], {})
                sc, _ = copy_or_create_sidecar(p, info, images_dir, dry_run=False)
                if sc:
                    sidecars_created += 1
        except Exception as e:
            print(f"Error renaming {src.name} -> {dst.name}: {e}", file=sys.stderr)

    print("\n" + "=" * 70)
    print(f"✓ Successfully renamed {renamed_count} files!")
    if args.copy_sidecars and sidecars_created > 0:
        print(f"✓ Created/copied {sidecars_created} matching .json sidecars in {images_dir.name}/")
    print("=" * 70)

    return 0


if __name__ == "__main__":
    sys.exit(main())
