# Google Flow Auto-Upscaler - Version Log & Changelog

## Overview
This document records the architectural decisions, reverse-engineering findings, and evolution of the `flow-upscaler.user.js` Violentmonkey userscript for [Google Flow](https://flow.google.com/).

---

## Version History

### v2.8.8 (2026-09-22) — Scope Fix for Continuous Downloader Sidecars
- **Problem**:
  - Running "Auto Scroll & Download Collection" successfully upscaled and saved the 2K image with renaming (`GoogleFlow_2K_<mediaId>.jpg`), but immediately halted with `STOPPED ON FAILURE! Failed on: <mediaId> (2K failed)` without writing the `.json` sidecar or proceeding to the 1K download.
  - Root Cause: `downloadText`, `downloadUrl`, and `downloadBase64` were defined locally inside `processMediaList(...)`. When `runContinuousCollectionDownloader` called `writeSidecar` (which invokes `downloadText`), it threw `ReferenceError: downloadText is not defined`. This uncaught error inside `try { ... } catch (err2k)` prevented `success2k = true` from being set, skipping 1K and triggering the auto-stop safety latch.
- **Solution**:
  - Lifted `downloadBase64`, `downloadUrl`, `downloadText`, and `writeSidecar` to module-level scope so both batch execution flows (`processMediaList` and `runContinuousCollectionDownloader`) share the identical download machinery.
  - Eliminated redundant duplicate function declarations.

---

### v2.8.7 (2026-09-22) — Continuous Auto-Scroll & Download
- **Problem**:
  - The previous two-pass collection downloader scrolled all the way to the bottom to harvest IDs, then attempted to rewind to the top (`scrollTo(0)`).
  - Angular's virtual scroller recycled DOM nodes during the downward scan, causing `scrollTo(0)` to freeze or miss tiles because virtual nodes were mid-hydration.
- **Solution**:
  - Replaced two-pass scan-and-rewind with **continuous auto-scroll and download**:
    1. Downloads all un-processed visible image tiles on screen immediately.
    2. Once visible tiles are downloaded, smoothly scrolls down by ~75% viewport height.
    3. Waits 800ms for Angular's virtual scroll to hydrate the next batch of image tiles into the DOM.
    4. Repeats until reaching the bottom of the collection.
  - Displays real-time progress: `Downloaded: X images so far | Currently processing: <mediaId>...`.
  - Auto-stops cleanly on any failure, keeping all downloads safe and reporting the last successful file.

---

### v2.8.6 (2026-09-22) — Inter-Resolution Throttling
- **Changes**:
  - Replaced the hardcoded 400ms pause between 2K and 1K downloads on the same image with the full randomized success throttle (`offset + rand(1..3)s`).
  - Ensures uniform, safe, human-like spacing between all operations (2K $\rightarrow$ 1K and Image $n$ $\rightarrow$ Image $n+1$).

---

### v2.8.5 (2026-09-22) — Native UI Automation & Standardized Naming
- **Problem**:
  - Direct backend RPC calls to `SPrCad` (`batchexecute`) consistently failed with `PUBLIC_ERROR_UNUSUAL_ACTIVITY` (gRPC status 7: `PERMISSION_DENIED`).
  - Byte-by-byte comparison proved the JSON request envelope and headers were 100% identical to manual requests.
  - Root cause: Google Flow subjects 2K GPU upscaling (`SPrCad`) to reCAPTCHA Enterprise risk scoring. Programmatic calls to `grecaptcha.enterprise.execute()` lack trusted user gestures (`isTrusted: true`), resulting in a bot score (<0.3) that Google Cloud rejects.
- **Solution**:
  - **Native UI Driving**: Rather than synthetic API calls, the script now automates Google Flow's native Angular Material context menu:
    1. Scrolls the target tile into view (`findAndScrollToTile`).
    2. Dispatches a native `contextmenu` event to open the menu.
    3. Locates and clicks the "Download" menu item.
    4. Locates and clicks the "2K" submenu item.
    5. Google Flow's internal components process reCAPTCHA and execute `SPrCad` natively with high trust scores ($\ge 0.7$).
  - **Anchor Download Interception**: Hooked `HTMLAnchorElement.prototype.click` to catch the file download triggered by Google Flow, renaming it to the standardized format: `GoogleFlow_2K_<mediaId>.jpg`.
  - **Sidecar Synchronization**: Automatically saves the matching metadata sidecar: `GoogleFlow_2K_<mediaId>.jpg.json`.
  - **Virtual Scrolling Support**: `findAndScrollToTile` scrolls incrementally to locate tiles that may be recycled or virtualized in large collections.

---

### v2.8.4 (2026-09-22) — reCAPTCHA Client Configuration & Action Matching
- **Investigation**:
  - Dumped `window.___grecaptcha_cfg.clients` to inspect Google Flow's internal reCAPTCHA Enterprise client.
  - Discovered Google Flow registers its invisible widget (`id: 100000`) with `"action": null`.
  - The script had previously been hardcoding `{action: 'IMAGE_GENERATION'}`, causing an action assessment mismatch.
- **Changes**:
  - Removed forced `IMAGE_GENERATION` action parameter, passing `null` unless explicitly intercepted.
  - Hooked both `window.grecaptcha.execute` and `window.grecaptcha.enterprise.execute` to ensure interception regardless of which API Google Flow loads.

---

### v2.8.3 (2026-09-22) — Fix Credentials Mode for batchexecute
- **Problem**:
  - `batchexecute` requests were returning HTTP `401 Unauthorized`.
- **Root Cause**:
  - `v2.8.2` had mistakenly set `credentials: "omit"` in `window.fetch`.
- **Solution**:
  - Restored `credentials: "include"`, ensuring Google session cookies (`SAPISID`, `SSID`, `HSID`, etc.) are attached to all requests.

---

### v2.8.2 (2026-09-22) — Live XHR & BOQ Token Interception
- **Changes**:
  - Hooked `XMLHttpRequest.prototype.open` and `XMLHttpRequest.prototype.send` in addition to `window.fetch`.
  - Intercepts live `at` (anti-XSRF token), `f.sid` (session ID), `bl` (BOQ build label), and `source-path` from background Google traffic.
  - Ensures tokens stay fresh across long-running sessions without page reloads.

---

### v2.8.1 (2026-09-22) — Project ID Slot & Version Display
- **Changes**:
  - Added `projectId` to slot 5 of the `SPrCad` context payload:
    `[null, 22, null, null, null, projectId, null, null, null, null, [token, 1]]`
  - Added visible script version (`v2.8.1`) to the floating panel title header for instant verification.

---

### v2.8.0 (2026-09-22) — Collection Scanner, Auto-Stop & Counter Format
- **Features**:
  - Added **Scan & Download Collection** button to automatically scan the entire viewport/collection and process all images.
  - Counter format standardized to `n out of n_max` (e.g., `Processing 3 out of 25...`).
  - **Auto-Stop on Failure**: If any upscale or download fails, the script halts execution immediately (no retries / no wasting quota) and displays the last successful download in red.
  - Displays last successfully downloaded filename and timestamp.

---

### v2.7.0 (2026-07-22) — 1K Original Resolution via as29s RPC
- **Features**:
  - Integrated Google Flow's `as29s` RPC (`batchexecute?rpcids=as29s`) to fetch official full-resolution 1K CDN URLs (`flow-content.google`).
  - Added separate toggle checkboxes: "Download 2K upscaled" and "Download Default (1K)".
  - Formatted 1K filenames as `GoogleFlow_1K_<mediaId>.jpg` with matching `.json` sidecars.

---

### Earlier Releases
- **Single JSON Sidecar**: Consolidated prompt, model tag (`ai:model:*`), and creation date into a single structured `<filename>.json` sidecar.
- **Trusted Types & CSP Compliance**: Eliminated all `innerHTML` usage to strictly conform to Google's strict Trusted Types Content Security Policy.
- **Floating Panel UI**: Draggable, collapsible UI overlay mounted on the page with live Auth and reCAPTCHA status indicators.

