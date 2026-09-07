# Shell Scripts & Automation Utilities

A curated collection of automation scripts, command-line utilities, userscripts, and browser extensions for developer productivity, media management, and AI platform workflows.

---

## Table of Contents

- [Repository Overview](#repository-overview)
- [System & CLI Utilities](#system--cli-utilities)
  - [tarzstd (`tarzstd.sh` & `tarzstd.py`)](#tarzstd-tarzstdsh--tarzstdpy)
  - [Screenshot Organizer (`organize_screenshots.py`)](#screenshot-organizer-organize_screenshotspy)
  - [OCR Processor (`ocr.py`)](#ocr-processor-ocrpy)
  - [Batch Git Fetch (`fetch_all_repos.sh`)](#batch-git-fetch-fetch_all_repossh)
- [Google Flow Automation (`google/flow/`)](#google-flow-automation-googleflow)
  - [Google Flow Auto-Upscaler Userscript](#google-flow-auto-upscaler-userscript)
  - [Google Flow Sidecar Converter (`convert_sidecars.py`)](#google-flow-sidecar-converter-convert_sidecarspy)
- [Grok AI Automation (`grok related/`)](#grok-ai-automation-grok-related)
  - [Grok - All Posts Userscript](#grok---all-posts-userscript)
  - [Grok Chat Auto-Download Userscript](#grok-chat-auto-download-userscript)
  - [Grok Export Cleaner (`clean_grok_exports_folder.py`)](#grok-export-cleaner-clean_grok_exports_folderpy)
- [Reddit Safari Extension (`reddit_safari_extension/`)](#reddit-safari-extension-reddit_safari_extension)
- [Prerequisites & Dependencies](#prerequisites--dependencies)
- [Development & Conventions](#development--conventions)

---

## Repository Overview

```
.
├── tarzstd.sh / tarzstd.py         # Multi-threaded zstd tar archiver with GPG encryption
├── organize_screenshots.py        # Date-based clustering and organizer for macOS screenshots
├── ocr.py                         # Batch PDF/A OCR scanner with deskew & sidecar text generation
├── fetch_all_repos.sh             # Recursive git fetch across workspace directories
├── google/
│   └── flow/
│       ├── flow-upscaler.user.js          # Google Flow auto-upscaler + Hydrus JSON sidecar generator
│       ├── upscale-with-sidecars.user.js  # Legacy Google Flow userscript (txt + md sidecars)
│       ├── upscale.user.js                # Base Google Flow auto-upscaler userscript
│       └── convert_sidecars.py            # Converts legacy Google Flow sidecars to Hydrus format
├── grok related/
│   ├── grok-posts.user.js                 # Grok Imagine posts gallery, downloader & batch deleter
│   ├── grok-chat-gen-auto-download.user.js # Real-time chat image downloader for grok.com
│   ├── clean_grok_exports_folder.py       # Cleans :image suffix and deduplicates duplicate media
│   └── grok-posts-benefits.md             # Design rationale and feature notes
└── reddit_safari_extension/
    ├── RedditFilter/                      # Xcode project for macOS & iOS Safari extension
    └── RedditFilterExtension/             # Manifest V3 extension core (filtering, quick save/hide)
```

---

## System & CLI Utilities

### tarzstd (`tarzstd.sh` & `tarzstd.py`)

Fast, multi-threaded tar compression leveraging `zstd -T0` with optional GPG public-key/symmetric encryption and per-target archiving. Available in both Bash and Python implementations with matching CLI flags.

#### Features
- **Parallel Compression**: Uses all CPU cores (`-T0`).
- **Configurable Quality**: Compression levels from 1 to 19 (default: 14).
- **GPG Encryption**: Pipes directly from `tar | zstd | gpg` without intermediate temporary files.
- **Batch Processing**: Archive multiple targets into a single file or generate individual archives (`-s`).

#### Usage

```bash
# Compress files/folders into archive.tar.zst (quality 14)
./tarzstd.sh folder1 file2.txt

# Or using the Python version:
python3 tarzstd.py folder1 file2.txt

# Set custom compression level (1-19)
./tarzstd.sh -q 19 my_large_dataset/

# Encrypt archive with GPG (.tar.zst.gpg)
./tarzstd.sh -e private_documents/

# Create separate archives for each input with verbose tar output
./tarzstd.sh -v -s folder1 folder2 file1.txt

# Display help
./tarzstd.sh --help
python3 tarzstd.py --help
```

---

### Screenshot Organizer (`organize_screenshots.py`)

Scans a directory for screenshot images (matching macOS default `Screenshot*` naming or `SCR-YYYYMMDD-*.png` patterns), inspects their creation timestamps, and automatically moves them into date-stamped folders in the format:
```
{YYYY-MM-DD} - {N} screenshots/
```

#### Usage

```bash
python3 organize_screenshots.py
```

*Note: Update `target_directory` in the script's `__main__` entry point or invoke `organize_screenshots("/path/to/screenshots")` as a module.*

---

### OCR Processor (`ocr.py`)

Batch OCR utility that iterates through an input directory of image files (e.g., scanned JPEGs) and converts each to a searchable PDF/A document using `ocrmypdf`, simultaneously writing full-text OCR sidecars (`.txt`).

#### Features
- Optional automatic deskewing (`--deskew` / `-d`).
- High-efficiency JPEG image compression within the PDF/A container.
- Optimization level 3 enabled by default.

#### Usage

```bash
# Process all JPG files in /Volumes/Scans and output to ~/Downloads/Scans with deskewing
python3 ocr.py -i /Volumes/Scans -o ~/Downloads/Scans -f jpg -d
```

---

### Batch Git Fetch (`fetch_all_repos.sh`)

Convenience shell script for developers maintaining multiple repositories in a single workspace. Iterates through all immediate child directories and runs `git fetch --all` on any directory containing a `.git` folder.

#### Usage

```bash
chmod +x fetch_all_repos.sh
./fetch_all_repos.sh
```

---

## Google Flow Automation (`google/flow/`)

Tools and browser scripts for interacting with [Google Flow](https://flow.google.com) AI media generation.

### Google Flow Auto-Upscaler Userscript

- **File**: [`google/flow/flow-upscaler.user.js`](google/flow/flow-upscaler.user.js)
- **Target Sites**: `https://flow.google.com/*`, `https://labs.google/fx/tools/flow/project/*`
- **Recommended Runner**: Violentmonkey / Tampermonkey

#### Highlights
- Automatically captures Google BOQ / WIZ session tokens and project IDs from web requests.
- Injects an on-screen floating control panel to trigger and manage 2K image upscales.
- Automatically extracts prompt text (including multi-line prompts), model identifier, and generation date.
- Downloads both the upscaled media and a [Hydrus Network](https://hydrusnetwork.github.io/hydrus/)-compatible grouped JSON sidecar:
  ```json
  {
    "tags": [
      "ai:generated",
      "ai:service:google_flow",
      "ai:model:nano_banana_2",
      "ai:upscaled"
    ],
    "notes": [
      "1.Prompt: A photorealistic landscape...",
      "2.Created: Jul 18, 2026"
    ]
  }
  ```
- *Legacy versions*: `upscale-with-sidecars.user.js` (generates separate `.txt` and `.md` files) and `upscale.user.js` (basic upscaling).

### Google Flow Sidecar Converter (`convert_sidecars.py`)

CLI migration utility to normalize older Google Flow sidecars into the modern Hydrus grouped JSON format.

#### Usage

```bash
# Convert legacy .txt (tags) + .md (notes) pairs to .json
python3 google/flow/convert_sidecars.py /path/to/downloads --mode md

# Automatically delete old .txt/.md files after conversion
python3 google/flow/convert_sidecars.py /path/to/downloads --mode md --delete-old

# Upgrade older flat-array or nested-object JSON sidecars to grouped format
python3 google/flow/convert_sidecars.py /path/to/downloads --mode json
```

---

## Grok AI Automation (`grok related/`)

Automation scripts and userscripts for downloading and managing image/video generations from [Grok](https://grok.com) / x.ai.

### Grok - All Posts Userscript

- **File**: [`grok related/grok-posts.user.js`](grok%20related/grok-posts.user.js)
- **Target Sites**: `https://grok.com/*`, `https://x.ai/*`
- **Features**:
  - Full modal overlay displaying all generated Grok Imagine posts.
  - Multi-selection support (including Shift+click range selection).
  - Batch downloading of media with post-ID prefix formatting.
  - Automatic video upscaling before downloading.
  - Batch deletion of posts directly from your library.
  - Built-in jitter delays and pagination throttling to prevent API rate limits.

### Grok Chat Auto-Download Userscript

- **File**: [`grok related/grok-chat-gen-auto-download.user.js`](grok%20related/grok-chat-gen-auto-download.user.js)
- **Target Sites**: `https://grok.com/*`, `https://x.ai/*`
- **Features**: Uses `MutationObserver` to watch chat messages and immediately downloads generated images as they are rendered in the stream.

### Grok Export Cleaner (`clean_grok_exports_folder.py`)

Sanitizes filenames and eliminates duplicate downloads in Grok export folders.

#### Features
- Removes awkward `:image` URL artifact suffixes from downloaded filenames.
- Scans for numbered download duplicates (e.g. `image (1).jpg`) and performs byte-by-byte comparison (`filecmp.cmp`) against the original before safe deletion.
- Supports dry-run inspection and recursive folder traversal.

#### Usage

```bash
# Preview actions without modifying any files
python3 "grok related/clean_grok_exports_folder.py" /path/to/grok_exports --dry-run

# Run cleanup recursively
python3 "grok related/clean_grok_exports_folder.py" /path/to/grok_exports --recursive
```

---

## Reddit Safari Extension (`reddit_safari_extension/`)

A Safari Web Extension (Manifest V3 compatible, packaged for macOS and iOS using Xcode) designed to enhance the Reddit browsing experience.

### Features
- **Karma / Likes Filtering**: Automatically filters out Reddit posts below a customizable upvote threshold (`minLikes`).
- **1-Click Quick Hide**: Adds a hide button directly to post bars to dismiss posts instantly via the Reddit API.
- **Quick Save / Unsave**: Instant save toggling with persistent visual state.
- **Hide After Save**: Optional setting to automatically hide a post once saved to keep feeds fresh.
- **Icon / Text Mode**: Configurable compact icon UI vs full-text buttons.

### Structure
- `RedditFilter/`: Xcode workspace containing macOS and iOS app wrappers and extension targets.
- `RedditFilterExtension/`: Core extension web assets (`manifest.json`, `content.js`, `popup.html`, `popup.js`, `styles.css`).

---

## Prerequisites & Dependencies

### System Packages
Ensure the following CLI utilities are installed (available via Homebrew on macOS):

```bash
brew install zstd gnupg ocrmypdf
```

### Python
Python 3.8+ is recommended. Most scripts rely solely on the Python Standard Library (`pathlib`, `argparse`, `subprocess`, `filecmp`, `json`, `re`).

### Browser Extensions
To use the userscripts (`.user.js`), install a userscript manager in your browser:
- [Violentmonkey](https://violentmonkey.github.io/) (recommended)
- [Tampermonkey](https://www.tampermonkey.net/)

---

## Development & Conventions

- **Python Scripts**: Adhere to PEP 8 standards, prioritize `pathlib.Path` for filesystem interactions, and provide CLI options using `argparse`.
- **Shell Scripts**: Maintain Bash compatibility, support `-h` and `--help` flags, use `getopts` for parsing options, and include usage instructions at the head of the file.
- See `.github/copilot-instructions.md` for extended architectural details and contributor guidelines.
