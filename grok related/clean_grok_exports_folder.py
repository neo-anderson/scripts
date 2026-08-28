# Usage: python clean_grok_exports_folder.py /path/to/folder --dry-run

import argparse
import os
import re
import filecmp
from pathlib import Path

def get_dir_size_recursive(directory):
    """Calculates the total size of files in a directory and subdirectories in bytes."""
    return sum(f.stat().st_size for f in directory.rglob('*') if f.is_file())

def format_size(size_bytes):
    """Formats bytes to MB."""
    return f"{size_bytes / (1024 * 1024):.2f} MB"

def rename_in_dir(directory, dry_run=False):
    """
    Renames files containing ':image' in a single directory.
    Returns (count_renamed).
    """
    renamed_count = 0
    # Use iterdir to only look at files in THIS directory (Pass 1)
    for item in directory.iterdir():
        if item.is_file() and ":image" in item.name:
            new_name = item.name.replace(":image", "")
            new_path = directory / new_name
            
            if new_path.exists():
                print(f"  Warning: Cannot rename {item.name} - {new_name} already exists.")
                continue

            if dry_run:
                print(f"  [DRY RUN] Rename: {item.name} -> {new_name}")
            else:
                print(f"  Renaming: {item.name} -> {new_name}")
                try:
                    item.rename(new_path)
                except Exception as e:
                    print(f"  Error renaming {item.name}: {e}")
                    continue
            renamed_count += 1
    return renamed_count

def dedupe_in_dir(directory, dry_run=False):
    """
    Deduplicates numbered files in a single directory.
    Returns (count_deleted, size_saved, count_not_identical, count_no_original).
    """
    # Pattern to match: filename (n).extension
    pattern = re.compile(r"^(.*) \((\d+)\)\.([^.]+)$")
    
    deleted_count = 0
    deleted_size = 0
    not_identical_count = 0
    no_original_count = 0

    for item in directory.iterdir():
        if not item.is_file():
            continue

        match = pattern.match(item.name)
        if match:
            base_name = match.group(1)
            extension = match.group(3)
            original_filename = f"{base_name}.{extension}"
            original_file = directory / original_filename

            if original_file.exists() and original_file.is_file():
                if filecmp.cmp(item, original_file, shallow=False):
                    size = item.stat().st_size
                    if dry_run:
                        print(f"  [DRY RUN] Delete identical: {item.name} ({format_size(size)})")
                        deleted_count += 1
                        deleted_size += size
                    else:
                        print(f"  Deleting identical: {item.name} ({format_size(size)})")
                        try:
                            item.unlink()
                            deleted_count += 1
                            deleted_size += size
                        except Exception as e:
                            print(f"  Error deleting {item.name}: {e}")
                else:
                    print(f"  Files not identical: {item.name} vs {original_filename}")
                    not_identical_count += 1
            else:
                no_original_count += 1
                
    return deleted_count, deleted_size, not_identical_count, no_original_count

def clean_folder_recursive(directory_path, dry_run=False):
    root_dir = Path(directory_path)
    if not root_dir.is_dir():
        print(f"Error: {directory_path} is not a valid directory.")
        return

    # Aggregate metrics
    metrics = {
        "renamed": 0,
        "deleted": 0,
        "size_saved": 0,
        "not_identical": 0,
        "no_original": 0
    }

    # Calculate initial total size across all subfolders
    initial_total_size = get_dir_size_recursive(root_dir)
    
    if dry_run:
        print("--- DRY RUN MODE: No files will be modified ---")

    # Find all directories including the root
    all_dirs = [root_dir] + sorted([d for d in root_dir.rglob('*') if d.is_dir()])

    print(f"Initial total size: {format_size(initial_total_size)}")
    print(f"Processing {len(all_dirs)} directories...")

    for current_dir in all_dirs:
        rel_path = current_dir.relative_to(root_dir)
        print(f"\nScrubbing directory: ./{rel_path}")
        
        # Pass 1: Rename
        metrics["renamed"] += rename_in_dir(current_dir, dry_run=dry_run)
        
        # Pass 2: Dedupe
        d_count, d_size, ni_count, no_count = dedupe_in_dir(current_dir, dry_run=dry_run)
        metrics["deleted"] += d_count
        metrics["size_saved"] += d_size
        metrics["not_identical"] += ni_count
        metrics["no_original"] += no_count

    print("\n" + "="*40)
    print("FINAL AGGREGATE SUMMARY")
    print("="*40)
    print(f"  Total Renamed:         {metrics['renamed']}")
    print(f"  Total Deleted:         {metrics['deleted']}")
    print(f"  Total Space Saved:     {format_size(metrics['size_saved'])}")
    print(f"  Initial Total Size:    {format_size(initial_total_size)}")
    print(f"  Final Total Size:      {format_size(initial_total_size - metrics['size_saved'] if not dry_run else initial_total_size)}")
    print(f"  Files Not Identical:   {metrics['not_identical']}")
    print(f"  Numbered (No Base):    {metrics['no_original']}")
    print("="*40)
    if dry_run:
        print("--- End of DRY RUN ---")

def main():
    parser = argparse.ArgumentParser(description="Clean exports folder recursively: Rename ':image' and deduplicate.")
    parser.add_argument("path", help="Path to the directory to scan")
    parser.add_argument("--dry-run", action="store_true", help="Show what would be done without making changes")
    
    args = parser.parse_args()
    clean_folder_recursive(args.path, dry_run=args.dry_run)

if __name__ == "__main__":
    main()
