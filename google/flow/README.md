# Google Flow Auto-Upscaler

Violentmonkey userscript for [Google Flow](https://flow.google.com/) that automates 2K image upscaling, original 1K downloading, metadata extraction, and JSON sidecar generation.

---

## Features

- **Native UI Driving for 2K Upscaling**: Automates Google Flow's native Angular Material context menu (`contextmenu` $\rightarrow$ "Download" $\rightarrow$ "2K"). Passes reCAPTCHA Enterprise verification with human trust scores (`isTrusted: true`), preventing `PUBLIC_ERROR_UNUSUAL_ACTIVITY` (`PERMISSION_DENIED`).
- **Standardized File Naming**: Intercepts browser anchor downloads and standardizes image filenames:
  - 2K Upscaled: `GoogleFlow_2K_<mediaId>.jpg`
  - 1K Original: `GoogleFlow_1K_<mediaId>.jpg`
- **Synchronized JSON Sidecars**: Automatically saves structured `<filename>.json` metadata sidecars containing multi-line prompts, creation dates, and tags:
  ```json
  {
    "tags": [
      "ai:generated",
      "ai:service:google_flow",
      "ai:model:nano_banana_2",
      "ai:upscaled"
    ],
    "notes": [
      "1.Prompt: Generate a 9x16 photo of a horse with a flowing mane...",
      "2.Created: Sep 22, 2026"
    ]
  }
  ```
- **Continuous Auto-Scroll & Download**: Downloads all visible images on screen, smoothly scrolls down to hydrate the next batch via Angular's virtual scroller, and repeats continuously with a live progress counter.
- **Graceful Non-2K Model Fallback**: Detects whether an image tile has a direct "Download" button versus a "2K" submenu. If 2K is unsupported for that image, skips 2K without errors and seamlessly downloads the 1K original version.
- **Selective Batch Downloading**: Select specific image tiles via checkboxes and click "Upscale / Download Selected".
- **Humanized Throttling**: Randomized pauses (`offset + rand(1..3)s`) between operations and resolutions to prevent rate limiting.
- **Fail-Safe Auto-Stop**: Halts immediately on failure to preserve quotas and logs the last successful download.
- **"Moved to Trash" Toast Blocker**: Includes a toggle in the control panel to block and auto-dismiss the persistent `1 item moved to trash` snackbar toast notification that obscures tiles during deletion workflows.

---

## Operating Guidelines & Browser Reliability Matrix

Because the script drives native UI elements (Angular Material context menus) and monitors DOM hydration from virtual scrolling, browser tab/window states directly influence reliability:

| Scenario / Browser State | Status | Behavior & Technical Cause | Operational Recommendation |
| :--- | :---: | :--- | :--- |
| **Resizing / Changing Browser Width** | ✅ **100% Reliable** | Elements are queried by DOM attributes (`data-media-id`, etc.) rather than fixed coordinate grids. `findAndScrollToTile` automatically calls `scrollIntoView({ block: 'center' })` before right-clicking, and viewport scroll steps are calculated dynamically (`0.75 * clientHeight`). | Safe to resize, tile, widen, or narrow at any time. |
| **Moving Window to Another macOS Space / Desktop** | ✅ **100% Reliable** | macOS Spaces remain active rendering surfaces for unminimized windows without occlusion throttling. | **Recommended workflow**: place Google Flow on a secondary Space / virtual desktop. |
| **Separate Window Fully Covered on Same Space** | ⚠️ **Throttled / Occluded** | When 100% covered by an opaque window (like a code editor), macOS **App Nap** and Chromium **Window Occlusion Tracking** throttle JS timers and pause CSS transitions. | **Do not completely cover.** Either leave an edge visible, or swipe the window to a separate macOS Space. |
| **Switching to Another Tab in Same Window** | ❌ **Will Pause / Fail** | Chromium completely freezes `requestAnimationFrame` on hidden tabs. Angular Material context menu animations pause, causing timeouts. | **Do not switch tabs.** Tear the Google Flow tab out into its own standalone browser window. |
| **Minimizing Window to macOS Dock (`Cmd+M`)** | ❌ **Suspended** | macOS and Chromium suspend window rendering and clamp timers down to $\le 1$ Hz. | Do not minimize to the Dock. |

---

## How to Run Reliable Unattended Downloads

1. **Tear Off the Tab**: Pull the Google Flow tab out into its own dedicated browser window.
2. **Move to Another macOS Space (Virtual Desktop)**: Swipe the window to another Space (e.g. Desktop 2) so macOS keeps its rendering pipeline active without App Nap or window occlusion throttling.
3. **Start Auto-Downloader**: Click **Auto Scroll & Download Collection**. The script will automatically rewind to the top, download every row sequentially, and cleanly complete after a 10-second idle period once the bottom is reached.

---

## Helper Python Tools

### 1. Download & Sidecar Validation Script (`validate_flow_downloads.py`)
Validates exported files starting with `GoogleFlow_*` in a folder:
- Verifies that both 1K and 2K files exist for each image ID.
- Checks that `.json` sidecars exist for each `.jpg`/`.png`.
- Handles models without 2K support: if a 2K file is missing, inspects the `.json` sidecar model tag. If `imagen_4`, marks it as valid/expected; otherwise flags an error.
- Detects duplicate image content across different IDs (via MD5 hashes) and offers automated triage.
- **Proper Pairs Isolation**: Prompts (or via `--move-proper` / `-m`) to move all complete, valid pairs and sidecars into a subfolder (`proper_pairs/`), cleanly leaving behind *only* the invalid or incomplete files in the main directory for easy inspection or re-download.
- Prints a breakdown of images downloaded per model, total image counts, and total file counts.

```bash
# Interactive check & prompt to isolate proper pairs:
python3 google/flow/validate_flow_downloads.py "/Users/aswin/Downloads/Brave Downloads"

# Automatically move proper pairs to 'proper_pairs/' subfolder:
python3 google/flow/validate_flow_downloads.py "/Users/aswin/Downloads/Brave Downloads" --move-proper
```

### 2. Low-Resolution 2K Cleaner Script (`clean_lowres_2k.py`)
Scans a folder for fake/low-resolution 2K downloads (< 1MB) and deletes both the 2K image and its corresponding `.json` sidecar without affecting 1K images:

```bash
python3 google/flow/clean_lowres_2k.py "/Users/aswin/Downloads/Brave Downloads" --threshold 1.0
```

---

## Installation

1. Install the [Violentmonkey](https://violentmonkey.github.io/) browser extension.
2. Install `flow-upscaler.user.js` into Violentmonkey.
3. Navigate to [Google Flow](https://flow.google.com/) and open any project or collection.
4. The floating control panel will appear in the top-right corner.

