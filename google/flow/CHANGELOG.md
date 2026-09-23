# Google Flow Auto-Upscaler - Version Log & Changelog

## Overview
This document records the architectural decisions, reverse-engineering findings, and evolution of the `flow-upscaler.user.js` Violentmonkey userscript for [Google Flow](https://flow.google.com/).

---

## Version History

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
