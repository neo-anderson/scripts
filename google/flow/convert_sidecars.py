#!/usr/bin/env python3
"""
Convert Google Flow sidecars into grouped JSON objects for Hydrus.

Two modes:

  --mode md   (default)
      Build .json from legacy .txt (tags) + .md (notes) sidecars.

  --mode json
      Upgrade previous-format .json sidecars (flat array, or the older nested
      {"metadata": {...}}) into the new grouped format.

New output (GoogleFlow_2K_<id>.jpg.json):
    {
      "tags": [
        "ai:generated",
        "ai:model:nano_banana_2",
        "ai:service:google_flow"
      ],
      "notes": [
        "Prompt: Generate an image of a beautiful horse\\nwith a flowing mane\\n...",
        "Created: Jul 18, 2026"
      ]
    }
"""

import argparse
import json
import sys
from pathlib import Path

# Known keys that appeared in the old .md files.
KNOWN_MD_KEYS = {"prompt", "caption", "model", "aspect", "created"}

# Prefixes that identify "note" strings inside a flat array.
NOTE_PREFIXES = ("Created:", "Prompt:")


def parse_tags(txt_path: Path) -> list:
    """Read a .txt tag file (one tag per line), deduped and sorted."""
    if not txt_path.exists():
        return []
    tags = []
    for line in txt_path.read_text(encoding="utf-8").splitlines():
        tag = line.strip()
        if tag:
            tags.append(tag)
    return sorted(set(tags))


def parse_notes(md_path: Path) -> dict:
    """
    Parse a .md notes file of "key: value" lines.

    Lines that don't start with a known "key:" are treated as continuation of
    the previous value (so multi-line prompts survive).
    """
    notes = {}
    if not md_path.exists():
        return notes

    current_key = None
    for raw in md_path.read_text(encoding="utf-8").splitlines():
        key_candidate = None
        if ":" in raw:
            key_candidate = raw.split(":", 1)[0].strip().lower()

        if key_candidate in KNOWN_MD_KEYS:
            current_key = key_candidate
            value = raw.split(":", 1)[1].strip()
            notes[current_key] = value
        elif current_key is not None:
            # Continuation line of the previous key (e.g. multi-line prompt)
            notes[current_key] = notes[current_key] + "\n" + raw.rstrip("\n")
    return notes


def build_notes_list(created: str, prompt: str) -> list:
    """Build the notes array: Prompt first, then Created (non-empty only)."""
    notes = []
    prompt = (prompt or "").strip()
    if prompt:
        notes.append(f"1.Prompt: {prompt}")
    created = (created or "").strip()
    if created:
        notes.append(f"2.Created: {created}")
    return notes


def build_grouped(tags: list, notes: list) -> str:
    """Build the grouped JSON object."""
    return json.dumps({"tags": list(tags), "notes": list(notes)},
                      ensure_ascii=False, indent=2)


def split_flat_items(items: list):
    """Split a flat list into (tags, notes) by the note prefixes."""
    tags, notes = [], []
    for item in items:
        s = str(item)
        if s.startswith(NOTE_PREFIXES):
            notes.append(s)
        else:
            t = s.strip()
            if t:
                tags.append(t)
    return sorted(set(tags)), notes


# ---------------------------------------------------------------------------
# Mode: md  (.txt + .md  ->  grouped .json)
# ---------------------------------------------------------------------------
def collect_bases_from_sidecars(directory: Path) -> set:
    """Find image base names (e.g. 'GoogleFlow_2K_<id>.jpg') from .txt/.md files."""
    bases = set()
    for path in directory.iterdir():
        if path.suffix.lower() in (".txt", ".md"):
            bases.add(path.with_suffix("").name)  # strip the .txt/.md
    return bases


def run_md_mode(directory: Path, overwrite: bool, delete_old: bool):
    bases = collect_bases_from_sidecars(directory)
    if not bases:
        print("No .txt or .md sidecar files found.")
        return

    written = skipped = 0
    for base in sorted(bases):
        txt_path = directory / f"{base}.txt"
        md_path = directory / f"{base}.md"
        json_path = directory / f"{base}.json"

        if json_path.exists() and not overwrite:
            print(f"skip (exists): {json_path.name}")
            skipped += 1
            continue

        tags = parse_tags(txt_path)
        notes_dict = parse_notes(md_path)
        notes = build_notes_list(notes_dict.get("created", ""), notes_dict.get("prompt", ""))

        json_path.write_text(build_grouped(tags, notes) + "\n", encoding="utf-8")
        print(f"wrote: {json_path.name}")
        written += 1

        if delete_old:
            for p in (txt_path, md_path):
                if p.exists():
                    p.unlink()

    print(f"\nDone. {written} written, {skipped} skipped.")


# ---------------------------------------------------------------------------
# Mode: json  (flat array / nested object  ->  grouped .json)
# ---------------------------------------------------------------------------
def run_json_mode(directory: Path):
    json_files = sorted(p for p in directory.iterdir() if p.suffix.lower() == ".json")
    if not json_files:
        print("No .json files found.")
        return

    converted = skipped = errored = 0
    for path in json_files:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as e:
            print(f"error (unreadable): {path.name} -> {e}")
            errored += 1
            continue

        # Already grouped? leave it alone.
        if isinstance(data, dict) and "tags" in data and "notes" in data:
            print(f"skip (already grouped): {path.name}")
            skipped += 1
            continue

        if isinstance(data, list):
            # Previous flat-array format.
            tags, notes = split_flat_items(data)
        elif isinstance(data, dict) and "metadata" in data:
            # Older nested-object format.
            meta = data.get("metadata") or {}
            raw_tags = meta.get("tags") or []
            tags = sorted(set(str(t).strip() for t in raw_tags if str(t).strip())) \
                if isinstance(raw_tags, list) else []
            notes = build_notes_list(meta.get("created", ""), meta.get("prompt", ""))
        else:
            print(f"skip (unrecognized): {path.name}")
            skipped += 1
            continue

        path.write_text(build_grouped(tags, notes) + "\n", encoding="utf-8")
        print(f"converted: {path.name}")
        converted += 1

    print(f"\nDone. {converted} converted, {skipped} skipped, {errored} errored.")


def main():
    ap = argparse.ArgumentParser(description="Convert Google Flow sidecars to grouped JSON objects.")
    ap.add_argument("directory", nargs="?", default=".",
                    help="Folder containing the sidecar files (default: current dir).")
    ap.add_argument("--mode", choices=["md", "json"], default="md",
                    help="'md' = build from .txt/.md (default); 'json' = upgrade flat/nested .json.")
    ap.add_argument("--no-overwrite", action="store_true",
                    help="[md mode] Skip images that already have a .json sidecar (default: overwrite).")
    ap.add_argument("--delete-old", action="store_true",
                    help="[md mode] Delete the .txt and .md files after successful conversion.")
    args = ap.parse_args()

    directory = Path(args.directory)
    if not directory.is_dir():
        sys.exit(f"Not a directory: {directory}")

    if args.mode == "md":
        run_md_mode(directory, overwrite=not args.no_overwrite, delete_old=args.delete_old)
    else:
        run_json_mode(directory)


if __name__ == "__main__":
    main()
