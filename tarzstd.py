#!/usr/bin/env python3

# Python equivalent of the shell script
# Example usage:
# python tarzstd.py -q 14 file1.txt file2.txt folder1
# python tarzstd.py -e folder1  # encrypt with GPG
# python tarzstd.py -v -s file1 file2  # verbose, separate archives
# python tarzstd.py * - all files and folders in the current directory except hidden ones
# python tarzstd.py .* * - all files and folders in the current directory including hidden ones
# python tarzstd.py {.,}* - same as above using fish shell wildcard globbing

import os
import subprocess
import sys
from argparse import ArgumentParser
from pathlib import Path


def create_archive(
    output_name: str, inputs: list[str], quality: int, encrypt: bool, verbose: bool
) -> None:
    """
    Create a compressed archive with optional encryption.

    Args:
        output_name: Base name for the output archive (without extension)
        inputs: List of files/folders to archive
        quality: zstd compression level (1-19)
        encrypt: Whether to encrypt with GPG
        verbose: Whether to show verbose tar output
    """
    tar_opts = "cv" if verbose else "c"

    if encrypt:
        # Compress and encrypt in a single pipeline
        final_archive = f"{output_name}.tar.zst.gpg"
        print(f"Creating encrypted archive: {final_archive}")

        # Build the pipeline: tar | zstd | gpg
        tar_cmd = ["tar", f"-{tar_opts}"] + inputs
        zstd_cmd = ["zstd", f"-{quality}", "-T0"]
        gpg_cmd = [
            "gpg",
            "-o",
            final_archive,
            "--compress-algo",
            "none",
            "--no-armor",
            "-e",
        ]

        # Execute the pipeline
        try:
            tar_proc = subprocess.Popen(
                tar_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE
            )
            zstd_proc = subprocess.Popen(
                zstd_cmd,
                stdin=tar_proc.stdout,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            tar_proc.stdout.close()  # Allow tar to receive SIGPIPE if zstd exits
            gpg_proc = subprocess.Popen(
                gpg_cmd, stdin=zstd_proc.stdout, stderr=subprocess.PIPE
            )
            zstd_proc.stdout.close()  # Allow zstd to receive SIGPIPE if gpg exits

            # Wait for the pipeline to complete
            gpg_proc.wait()

            if gpg_proc.returncode != 0:
                stderr = gpg_proc.stderr.read().decode()
                print(f"Error during encryption: {stderr}", file=sys.stderr)
                sys.exit(1)
        except FileNotFoundError as e:
            print(f"Error: Required command not found: {e.filename}", file=sys.stderr)
            print("Make sure tar, zstd, and gpg are installed.", file=sys.stderr)
            sys.exit(1)
    else:
        # Standard compression without encryption
        archive_name = f"{output_name}.tar.zst"
        print(f"Creating archive: {archive_name}")

        # Build the pipeline: tar | zstd > output
        tar_cmd = ["tar", f"-{tar_opts}"] + inputs
        zstd_cmd = ["zstd", f"-{quality}", "-T0"]

        try:
            with open(archive_name, "wb") as out_file:
                tar_proc = subprocess.Popen(
                    tar_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE
                )
                zstd_proc = subprocess.Popen(
                    zstd_cmd,
                    stdin=tar_proc.stdout,
                    stdout=out_file,
                    stderr=subprocess.PIPE,
                )
                tar_proc.stdout.close()  # Allow tar to receive SIGPIPE if zstd exits

                # Wait for the pipeline to complete
                zstd_proc.wait()

                if zstd_proc.returncode != 0:
                    stderr = zstd_proc.stderr.read().decode()
                    print(f"Error during compression: {stderr}", file=sys.stderr)
                    sys.exit(1)
        except FileNotFoundError as e:
            print(f"Error: Required command not found: {e.filename}", file=sys.stderr)
            print("Make sure tar and zstd are installed.", file=sys.stderr)
            sys.exit(1)


def main():
    """Main entry point for the script."""
    parser = ArgumentParser(
        description="Tar and compress files/folders using zstd with optional encryption."
    )
    parser.add_argument(
        "-q",
        "--quality",
        type=int,
        default=14,
        help="Set the zstd compression level (1-19). Default: 14.",
    )
    parser.add_argument(
        "-e",
        "--encrypt",
        action="store_true",
        help="Encrypt the archive using GPG.",
    )
    parser.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="Enable verbose output from tar.",
    )
    parser.add_argument(
        "-s",
        "--separate",
        action="store_true",
        help="Create a separate archive for each input.",
    )
    parser.add_argument(
        "files",
        nargs="+",
        help="Files and folders to compress.",
    )

    args = parser.parse_args()

    if args.separate:
        # Create a separate archive for each input
        for item in args.files:
            output_name = os.path.basename(os.path.normpath(item))
            create_archive(
                output_name, [item], args.quality, args.encrypt, args.verbose
            )
    else:
        # Create a single archive for all inputs
        if len(args.files) == 1:
            output_name = os.path.basename(os.path.normpath(args.files[0]))
        else:
            output_name = "archive"

        create_archive(
            output_name, args.files, args.quality, args.encrypt, args.verbose
        )


if __name__ == "__main__":
    main()
