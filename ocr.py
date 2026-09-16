#!/usr/bin/env python3
"""
Batch OCR & Compression Utility (ocr.py)

Compression & Archival Benchmarks (Tested on 4 x 1 MB Scanned JPEGs):
-----------------------------------------------------------------------
- Original Scans:        ~1 MB per page (4 MB total).
- Default Mode:          2.2 MB PDF (full color, high fidelity).
- ImageOptim Pre-pass:   1.2 MB PDF, but degrades OCR accuracy due to
                         compression artifacts before text recognition.
- Grayscale (Quality 10): 950 KB PDF; close to the 1.2 MB file and not worth
                         the loss of color/shading fidelity.
- JBIG2 Archival (-j):   256 KB PDF (~90%+ savings!). Converts to 1-bit
                         pure black/white and compresses glyphs using a
                         shared symbol dictionary across pages.

Alfred Workflow Triggers:
--------------------------
- Enter (Default):       OCR images individually into separate PDFs.
- Cmd + Enter:           Combine images into a single searchable PDF.
- Cmd + Opt + Enter:     Combine images into a single PDF with JBIG2 archival compression (-j).
"""

import os
import sys
import tempfile
import subprocess
from pathlib import Path
from argparse import ArgumentParser
from PIL import Image, ImageFile, ImageOps

# Allow loading scans that have missing/truncated trailing bytes (common from scanners)
ImageFile.LOAD_TRUNCATED_IMAGES = True

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".tif", ".tiff", ".bmp", ".webp"}

def get_ocrmypdf_env() -> dict[str, str]:
    """Injects ImageFile.LOAD_TRUNCATED_IMAGES=True into ocrmypdf's Python subprocess.
    This fixes Ghostscript 10.06+ / Pillow OSError crashes during --optimize 2 and 3.
    """
    patch_dir = Path(tempfile.gettempdir()) / "ocrmypdf_pillow_patch"
    patch_dir.mkdir(exist_ok=True)
    sitecustomize = patch_dir / "sitecustomize.py"
    if not sitecustomize.exists():
        sitecustomize.write_text(
            "try:\n"
            "    from PIL import ImageFile\n"
            "    ImageFile.LOAD_TRUNCATED_IMAGES = True\n"
            "except ImportError:\n"
            "    pass\n"
        )
    env = os.environ.copy()
    existing = env.get("PYTHONPATH", "")
    env["PYTHONPATH"] = f"{patch_dir}:{existing}" if existing else str(patch_dir)
    return env

def sanitize_image(img_path: Path, mono: bool = False, gray: bool = False) -> Image.Image:
    """Loads an image into a clean memory buffer, repairing any truncated scanner bytes.
    - If mono=True: 1-bit monochrome for JBIG2 (~90%+ savings).
    - If gray=True: 8-bit continuous grayscale (~85-90% savings at quality 10).
    """
    with Image.open(img_path) as raw:
        if mono:
            gray_img = ImageOps.grayscale(raw)
            gray_img = ImageOps.autocontrast(gray_img, cutoff=2)
            return gray_img.point(lambda p: 255 if p > 185 else 0, mode="1")
        elif gray:
            gray_img = ImageOps.grayscale(raw)
            return ImageOps.autocontrast(gray_img, cutoff=0.5)
        clean = Image.new("RGB", raw.size)
        clean.paste(raw)
        return clean

def execute_ocrmypdf(base_cmd: list[str], optimize: str):
    """Executes ocrmypdf with image optimization, falling back to --optimize 0 if needed."""
    cmd = base_cmd + ["--optimize", optimize]
    env = get_ocrmypdf_env()
    try:
        subprocess.run(cmd, env=env, check=True)
    except subprocess.CalledProcessError as e:
        if optimize != "0":
            print(f"Warning: ocrmypdf with --optimize {optimize} failed. Retrying with --optimize 0...")
            subprocess.run(base_cmd + ["--optimize", "0"], env=env, check=True)
        else:
            raise e

def run_ocr(input_file: Path, output_pdf: Path, deskew: bool, optimize: str = "3", mono: bool = False, gray: bool = False, jpeg_quality: int | None = None):
    """Runs ocrmypdf on a single file, sanitizing if it's an image to prevent truncated errors."""
    output_pdf.parent.mkdir(parents=True, exist_ok=True)
    sidecar_txt = output_pdf.with_suffix(".txt")

    tmp_pdf = None
    target_to_ocr = input_file

    # If the input is a raw image file, convert it to a sanitized clean PDF first
    if input_file.suffix.lower() in IMAGE_EXTENSIONS:
        tmp = tempfile.NamedTemporaryFile(suffix=".pdf", delete=False)
        tmp_pdf = Path(tmp.name)
        clean_img = sanitize_image(input_file, mono=mono, gray=gray)
        if mono:
            clean_img.save(tmp_pdf, format="PDF")
        elif gray:
            clean_img.save(tmp_pdf, format="PDF", quality=65, optimize=True)
        else:
            clean_img.save(tmp_pdf, format="PDF", quality=85, optimize=True)
        target_to_ocr = tmp_pdf

    try:
        cmd = [
            "ocrmypdf",
            str(target_to_ocr),
            str(output_pdf),
            "--pdfa-image-compression", "jpeg",
            "--sidecar", str(sidecar_txt)
        ]
        if deskew:
            cmd.append("--deskew")
        if gray:
            cmd.extend(["--color-conversion-strategy", "Gray"])
            jq = jpeg_quality if jpeg_quality is not None else 10
            cmd.extend(["--jpeg-quality", str(jq)])
        elif jpeg_quality is not None:
            cmd.extend(["--jpeg-quality", str(jpeg_quality)])

        print(f"Running OCR on {input_file.name} -> {output_pdf.name}...")
        execute_ocrmypdf(cmd, optimize)
    finally:
        if tmp_pdf and tmp_pdf.exists():
            tmp_pdf.unlink()

def combine_and_ocr(image_files: list[Path], output_pdf: Path, deskew: bool, optimize: str = "3", mono: bool = False, gray: bool = False, jpeg_quality: int | None = None):
    """Merges multiple images into a multi-page PDF, then runs ocrmypdf on it."""
    image_files = sorted(image_files)
    output_pdf.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
        tmp_pdf = Path(tmp.name)

    try:
        print(f"Merging {len(image_files)} images into temporary PDF...")
        # Sanitize all images to strip corrupted/missing scanner trailing bytes
        images = [sanitize_image(f, mono=mono, gray=gray) for f in image_files]

        if mono:
            images[0].save(tmp_pdf, save_all=True, append_images=images[1:], format="PDF")
        elif gray:
            images[0].save(tmp_pdf, save_all=True, append_images=images[1:], format="PDF", quality=65, optimize=True)
        else:
            images[0].save(tmp_pdf, save_all=True, append_images=images[1:], format="PDF", quality=85, optimize=True)

        print(f"Running OCR on combined PDF -> {output_pdf.name}...")
        cmd = [
            "ocrmypdf",
            str(tmp_pdf),
            str(output_pdf),
            "--pdfa-image-compression", "jpeg",
            "--sidecar", str(output_pdf.with_suffix(".txt"))
        ]
        if deskew:
            cmd.append("--deskew")
        if gray:
            cmd.extend(["--color-conversion-strategy", "Gray"])
            jq = jpeg_quality if jpeg_quality is not None else 10
            cmd.extend(["--jpeg-quality", str(jq)])
        elif jpeg_quality is not None:
            cmd.extend(["--jpeg-quality", str(jpeg_quality)])

        execute_ocrmypdf(cmd, optimize)
        print(f"Created combined PDF: {output_pdf}")
    finally:
        if tmp_pdf.exists():
            tmp_pdf.unlink()

def main():
    parser = ArgumentParser(description="Batch OCR utility for images (individual or combined into single PDF).")
    parser.add_argument("files", nargs="*", help="File paths passed directly (e.g. from Alfred)")
    parser.add_argument("-i", "--input", dest="INPUT", help="input folder or file")
    parser.add_argument("-o", "--output", dest="OUTPUT", help="output folder or file")
    parser.add_argument("-f", "--file-extension", dest="FILEEXTENSION", default="jpg", help="extension of input files to filter (default: jpg)")
    parser.add_argument("-d", "--deskew", dest="DESKEW", help="deskew images", action="store_true")
    parser.add_argument("-c", "--combine", dest="COMBINE", help="combine multiple images into a single PDF", action="store_true")
    parser.add_argument("-j", "--jbig2", "--mono", dest="JBIG2", help="convert to 1-bit monochrome and compress using JBIG2 (~95%%+ size reduction)", action="store_true")
    parser.add_argument("-g", "--gray", dest="GRAY", help="convert to 8-bit continuous grayscale with quality 10 compression (~85-90%% size reduction)", action="store_true")
    parser.add_argument("-q", "--jpeg-quality", dest="JPEG_QUALITY", type=int, default=None, help="custom JPEG quality (1-100, default: 10 when -g is set)")
    parser.add_argument("-O", "--optimize", dest="OPTIMIZE", default="3", choices=["0", "1", "2", "3"], help="PDF optimization level (default: 3)")

    args = parser.parse_args()

    # Collect files
    target_files: list[Path] = []
    if args.files:
        target_files = [Path(f) for f in args.files]
    elif args.INPUT:
        p = Path(args.INPUT)
        if p.is_dir():
            target_files = [f for f in p.glob('*') if f.suffix.lower() == f".{args.FILEEXTENSION.lower()}"]
        else:
            target_files = [p]

    if not target_files:
        print("No files found to process.", file=sys.stderr)
        sys.exit(1)

    # Determine output location
    if args.OUTPUT:
        out_path = Path(args.OUTPUT)
    else:
        # Default output directory next to the input files
        out_path = target_files[0].parent / "ocr_output"

    if args.COMBINE:
        if out_path.suffix.lower() == ".pdf":
            out_pdf = out_path
        else:
            out_pdf = out_path / f"{target_files[0].stem}_combined.pdf"
        combine_and_ocr(target_files, out_pdf, args.DESKEW, optimize=args.OPTIMIZE, mono=args.JBIG2, gray=args.GRAY, jpeg_quality=args.JPEG_QUALITY)
    else:
        out_dir = out_path if out_path.suffix.lower() != ".pdf" else out_path.parent
        for file in target_files:
            run_ocr(file, out_dir / f"{file.stem}.pdf", args.DESKEW, optimize=args.OPTIMIZE, mono=args.JBIG2, gray=args.GRAY, jpeg_quality=args.JPEG_QUALITY)

if __name__ == "__main__":
    main()