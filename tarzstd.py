# Python equivalient of the shell script
# Example usage:
# python tarzstd.py -q 14 file1.txt file2.txt folder1
# python tarzstd.py * - all files and folders in the current directory except hidden ones
# python tarzstd.py .* * - all files and folders in the current directory including hidden ones
# python tarzstd.py {.,}* - same as above using fish shell wildcard globbing

from argparse import ArgumentParser
import os
import subprocess

quality = 19
error_msg = "Usage: python tarzstd.py [-q compression_level] file_or_folder [more_files_and_folders...]"

parser = ArgumentParser(
    description="Compress files and folders using tar with optional compression."
)
parser.add_argument(
    "-q",
    "--quality",
    type=int,
    default=quality,
    help="Set the compression level (1-19) for tar. Default is 19.",
)
parser.add_argument("files", nargs="+", help="Files and folders to compress.")
args = parser.parse_args()

out_file = (
    "archive.tar.zst"
    if len(args.files) > 1
    else f"{os.path.basename(os.path.normpath(args.files[0]))}.tar.zst"
)

print(f"Creating '{out_file}'")
process = subprocess.run(
    f"tar -cv {' '.join(args.files)} | zstd -{args.quality} -T0 > {out_file}",
    shell=True,
    check=True,
)
