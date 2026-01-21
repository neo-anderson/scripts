import os
import re
import shutil
from datetime import datetime
from pathlib import Path
from collections import defaultdict


def organize_screenshots(directory="."):
    """
    Organize screenshot files by creation date.
    Handles files starting with 'Screenshot' or matching 'SCR-YYYYMMDD-*.png' pattern.
    Moves them to folders named '{creation_date} - {count} screenshots'.
    """
    directory_path = Path(directory)

    # Pattern to match SCR-YYYYMMDD-*.png
    scr_pattern = re.compile(r"^SCR-\d{8}-.*\.png$")

    # Find all screenshot files
    screenshot_files = [
        f
        for f in directory_path.iterdir()
        if f.is_file()
        and (f.name.startswith("Screenshot") or scr_pattern.match(f.name))
    ]

    if not screenshot_files:
        print("No screenshot files found.")
        return

    print(f"Found {len(screenshot_files)} screenshot files.")

    # Group files by creation date and count them
    date_groups = defaultdict(list)
    for file_path in screenshot_files:
        try:
            creation_time = os.path.getctime(file_path)
            creation_date = datetime.fromtimestamp(creation_time).strftime("%Y-%m-%d")
            date_groups[creation_date].append(file_path)
        except Exception as e:
            print(f"Error processing {file_path.name}: {e}")

    # Move files to folders with count in the name
    for creation_date, files in date_groups.items():
        count = len(files)
        folder_name = f"{creation_date} - {count} screenshots"
        folder_path = directory_path / folder_name

        # Create folder if it doesn't exist
        folder_path.mkdir(exist_ok=True)

        for file_path in files:
            try:
                destination = folder_path / file_path.name
                shutil.move(str(file_path), str(destination))
                print(f"Moved {file_path.name} to {folder_name}/")
            except Exception as e:
                print(f"Error moving {file_path.name}: {e}")


if __name__ == "__main__":
    # Change this path to the directory containing your screenshots
    target_directory = "/Users/aswin/Downloads"
    organize_screenshots(target_directory)
    print("Screenshot organization complete!")
