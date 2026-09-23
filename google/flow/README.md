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
- **Selective Batch Downloading**: Select specific image tiles via checkboxes and click "Upscale / Download Selected".
- **Humanized Throttling**: Randomized pauses (`offset + rand(1..3)s`) between operations and resolutions to prevent rate limiting.
- **Fail-Safe Auto-Stop**: Halts immediately on failure to preserve quotas and logs the last successful download.

---

## Operating Guidelines & Browser Reliability Matrix

Because the script drives native UI elements (Angular Material context menus) and monitors DOM hydration from virtual scrolling, browser tab/window states directly influence reliability:

| Scenario / Browser State | Status | Behavior & Technical Cause | Operational Recommendation |
| :--- | :---: | :--- | :--- |
| **Resizing / Changing Browser Width** | ✅ **100% Reliable** | Elements are queried by DOM attributes (`data-media-id`, etc.) rather than fixed coordinate grids. `findAndScrollToTile` automatically calls `scrollIntoView({ block: 'center' })` before right-clicking, and viewport scroll steps are calculated dynamically (`0.75 * clientHeight`). | Safe to resize, tile, widen, or narrow at any time. |
| **Separate Window Behind Other Windows** | ✅ **100% Reliable** | As long as the window is not minimized, Chromium renders paint cycles and executes JavaScript timers (`setTimeout`) at standard speed. | Safe to place code editors, other apps, or browser windows in front. |
| **Moving Window to Another macOS Space / Desktop** | ✅ **100% Reliable** | Virtual desktop spaces remain active rendering contexts in macOS window managers; background throttling is avoided. | **Recommended workflow** for running long collection downloads in the background. |
| **Switching to Another Tab in Same Window** | ❌ **Will Pause / Fail** | Chromium completely freezes `requestAnimationFrame` on hidden tabs. Angular Material context menu animations (`@transformMenu`) pause, causing `waitForOverlayElement` to hit its 5-second timeout and fail. | **Do not switch tabs.** Instead, tear the Google Flow tab out into its own standalone browser window. |
| **Minimizing Window to macOS Dock (`Cmd+M`)** | ⚠️ **Unreliable / Stalls** | macOS/Chromium suspends window rendering and heavily clamps JavaScript timer execution to 1 Hz or lower. Smooth scrolling and virtual node hydration stall. | Do not minimize to the Dock. |

---

## How to Run Reliable Unattended Downloads

1. **Tear Off the Tab**: Pull the Google Flow tab out into its own dedicated Chrome window.
2. **Keep Tab Active in Its Window**: Leave Google Flow as the foreground tab in that window.
3. **Move to Background Space / Behind Other Windows**: Move that window to another macOS Space (Virtual Desktop) or leave it behind your active work windows. Do not minimize it to the Dock (`Cmd+M`).
4. **Start Auto-Downloader**: Click **Auto Scroll & Download Collection**. The script will run continuously until the entire collection has been processed.

---

## Installation

1. Install the [Violentmonkey](https://violentmonkey.github.io/) browser extension.
2. Install `flow-upscaler.user.js` into Violentmonkey.
3. Navigate to [Google Flow](https://flow.google.com/) and open any project or collection.
4. The floating control panel will appear in the top-right corner.
