// ==UserScript==
// @name        Google Flow Auto-Upscaler
// @namespace   Violentmonkey Scripts
// @match       https://labs.google/fx/tools/flow/project/*
// @grant       none
// @version     1.8
// ==/UserScript==

// JSON sidecar instead of ⁠.txt + ⁠.md — a single ⁠image-filename.ext.json is written per image via the new ⁠buildJson(), producing exactly your target shape:
// Multi-line prompts — ⁠JSON.stringify automatically escapes newlines as ⁠\n. To make sure the newlines survive, the new ⁠extractText() helper converts ⁠<br> elements to ⁠\n and reads via ⁠textContent (so CSS line-clamp doesn't truncate long prompts), then trims and normalizes non-breaking spaces.
// getImageMetadata() now only returns ⁠prompt, ⁠model (used solely to derive the ⁠ai:model:* tag), and ⁠created
// ⁠writeSidecar() replaces ⁠writeSidecars() — one download, ⁠application/json MIME type. That means two files per image now (image + ⁠.json), so Chrome's multi-download prompt is lighter than before.
// Grouped sidecar — ⁠buildJson() now emits ⁠{ "tags": [...], "notes": [...] } instead of the flat array.
// ⁠buildNotes() — new helper that conditionally builds the numbered notes: ⁠1.Prompt: <prompt> first, then ⁠2.Created: <created>. Empty values are skipped, and the numbering stays sequential (so a prompt-only image gets just ⁠1.Prompt: ...).
// ⁠buildTags() — same conditional logic as before (static tags + one ⁠ai:model:* derived tag or the ⁠imagen_4 default + ⁠ai:upscaled only on a true 2K success), but I dropped the ⁠.sort() so the output preserves insertion order to match your example. Duplicates are still removed via ⁠Set.
// Sidecar example (for a 2K upscaled image with both prompt and created):
// {
//   "tags": [
//     "ai:generated",
//     "ai:service:google_flow",
//     "ai:model:nano_banana_2",
//     "ai:upscaled"
//   ],
//   "notes": [
//     "1.Prompt: Generate a 9x16 photo of a horse with a flowing mane,\ngalloping through a misty forest at dawn, cinematic lighting, ultra-realistic, 8k",
//     "2.Created: Jun 22, 2026"
//   ]
// }
// **"Download default 1K only"** checkbox and a **minimize/expand** toggle for the panel.
// default model and offset options on the panel.
// bulk delete

(function() {
    'use strict';

    // Store tokens intercepted from normal page traffic
    window.__upscale_tokens = {
        authToken: '',
        projectId: '', // Extracted dynamically from URL or fetch
        sessionId: '',
        recaptchaToken: ''
    };

    // ---- CONFIGURE YOUR STATIC TAGS HERE ----
    const STATIC_TAGS = ['ai:generated', 'ai:service:google_flow'];
    const DEFAULT_MODEL_NAME = 'imagen_4'; // default value pre-filled in the panel textbox

    // ---- WAIT / THROTTLE DEFAULTS (seconds) — editable in the panel ----
    const SUCCESS_WAIT_OFFSET = 3;      // constant base wait after a success
    const SUCCESS_WAIT_RAND_MIN = 1;    // random extra wait, lower bound
    const SUCCESS_WAIT_RAND_MAX = 3;    // random extra wait, upper bound
    const FAILURE_WAIT_OFFSET = 7;      // constant base wait after a failure
    const FAILURE_WAIT_RAND_MIN = 1;    // random extra wait, lower bound
    const FAILURE_WAIT_RAND_MAX = 3;    // random extra wait, upper bound
    const DELETE_WAIT_OFFSET = 2;       // constant base wait between deletes
    const DELETE_WAIT_RAND_MIN = 1;     // random extra wait, lower bound
    const DELETE_WAIT_RAND_MAX = 3;     // random extra wait, upper bound

    function getProjectId() {
        // Try to grab from the current URL first: /fx/tools/flow/project/0cd06166-0dde-4120-9f29-bf1052c30333
        const match = window.location.pathname.match(/\/project\/([0-9a-f-]+)/);
        return match ? match[1] : window.__upscale_tokens.projectId;
    }

    // 0. Global UI Container
    const controlPanel = document.createElement('div');
    controlPanel.style.position = 'fixed';
    controlPanel.style.bottom = '20px';
    controlPanel.style.right = '20px';
    controlPanel.style.backgroundColor = 'rgba(0, 0, 0, 0.9)';
    controlPanel.style.color = 'white';
    controlPanel.style.padding = '15px';
    controlPanel.style.borderRadius = '8px';
    controlPanel.style.zIndex = '999999';
    controlPanel.style.fontFamily = 'monospace';
    controlPanel.style.fontSize = '12px';
    controlPanel.style.width = '250px';
    controlPanel.innerHTML = `
        <div id="panel-header" style="display: flex; justify-content: space-between; align-items: center; gap: 10px;">
            <strong>Auto-Upscaler</strong>
            <button id="btn-minimize" title="Minimize" style="cursor: pointer; background: #444; color: #fff; border: none; border-radius: 4px; width: 22px; height: 22px; line-height: 1; font-size: 14px;">–</button>
        </div>
        <div id="panel-content" style="margin-top: 10px;">
            <div style="margin-bottom: 10px;">
                <strong>Status</strong><br>
                Auth: <span id="status-auth" style="color: #F44336;">❌</span> |
                Recaptcha: <span id="status-recaptcha" style="color: #F44336;">❌</span>
            </div>
            <div style="margin-bottom: 10px;">
                Selected: <span id="status-selected" style="color: #2196F3;">0</span>
            </div>
            <div style="margin-bottom: 10px; padding-bottom: 10px; border-bottom: 1px solid #444;">
                <label style="cursor: pointer; display: flex; align-items: center; gap: 5px; font-size: 11px; margin-bottom: 6px;">
                    <input type="checkbox" id="cb-only-1k" style="cursor: pointer; margin: 0;">
                    Only download default 1K (no upscale)
                </label>
                <label style="cursor: pointer; display: flex; align-items: center; gap: 5px; font-size: 11px;">
                    <input type="checkbox" id="cb-download-fallback" style="cursor: pointer; margin: 0;">
                    Download default 1K if 2K fails
                </label>
            </div>
            <div style="margin-bottom: 10px; padding-bottom: 10px; border-bottom: 1px solid #444;">
                <label style="cursor: pointer; display: flex; align-items: center; gap: 5px; font-size: 11px; margin-bottom: 6px;">
                    <input type="checkbox" id="cb-default-model" style="cursor: pointer; margin: 0;">
                    Use default model when missing
                </label>
                <div style="display: flex; align-items: center; gap: 5px; font-size: 11px;">
                    <span>ai:model:</span>
                    <input type="text" id="inp-default-model" value="${DEFAULT_MODEL_NAME}" disabled
                        style="flex: 1; min-width: 0; background: #222; color: #fff; border: 1px solid #555; border-radius: 3px; padding: 2px 4px; font-family: monospace; font-size: 11px;">
                </div>
            </div>
            <div style="margin-bottom: 10px; padding-bottom: 10px; border-bottom: 1px solid #444;">
                <div style="display: flex; align-items: center; justify-content: space-between; gap: 5px; font-size: 11px; margin-bottom: 6px;">
                    <span>Success offset (s)</span>
                    <input type="number" id="inp-success-offset" value="${SUCCESS_WAIT_OFFSET}" min="0" step="1"
                        style="width: 55px; background: #222; color: #fff; border: 1px solid #555; border-radius: 3px; padding: 2px 4px; font-family: monospace; font-size: 11px;">
                </div>
                <div style="display: flex; align-items: center; justify-content: space-between; gap: 5px; font-size: 11px; margin-bottom: 6px;">
                    <span>Failure offset (s)</span>
                    <input type="number" id="inp-failure-offset" value="${FAILURE_WAIT_OFFSET}" min="0" step="1"
                        style="width: 55px; background: #222; color: #fff; border: 1px solid #555; border-radius: 3px; padding: 2px 4px; font-family: monospace; font-size: 11px;">
                </div>
                <div style="display: flex; align-items: center; justify-content: space-between; gap: 5px; font-size: 11px;">
                    <span>Delete offset (s)</span>
                    <input type="number" id="inp-delete-offset" value="${DELETE_WAIT_OFFSET}" min="0" step="1"
                        style="width: 55px; background: #222; color: #fff; border: 1px solid #555; border-radius: 3px; padding: 2px 4px; font-family: monospace; font-size: 11px;">
                </div>
            </div>
            <button id="btn-upscale-selected" style="width: 100%; padding: 8px; cursor: pointer; background-color: #2196F3; color: white; border: none; border-radius: 4px;">
                Upscale Selected
            </button>
            <button id="btn-delete-selected" style="width: 100%; padding: 8px; margin-top: 8px; cursor: pointer; background-color: #F44336; color: white; border: none; border-radius: 4px;">
                Delete Selected
            </button>
        </div>
    `;
    document.body.appendChild(controlPanel);

    // ---- Minimize / restore panel ----
    let panelMinimized = false;
    document.getElementById('btn-minimize').onclick = () => {
        panelMinimized = !panelMinimized;
        const content = document.getElementById('panel-content');
        const btn = document.getElementById('btn-minimize');
        content.style.display = panelMinimized ? 'none' : 'block';
        btn.innerText = panelMinimized ? '+' : '–';
        btn.title = panelMinimized ? 'Expand' : 'Minimize';
    };

    // ---- "Only 1K" and "Fallback" are mutually exclusive; grey out fallback when only-1K is on ----
    const only1kCb = document.getElementById('cb-only-1k');
    const fallbackCb = document.getElementById('cb-download-fallback');
    only1kCb.addEventListener('change', () => {
        fallbackCb.disabled = only1kCb.checked;
        fallbackCb.parentElement.style.opacity = only1kCb.checked ? '0.4' : '1';
    });

    // ---- Enable/disable the default-model textbox with its checkbox ----
    const defaultModelCb = document.getElementById('cb-default-model');
    const defaultModelInp = document.getElementById('inp-default-model');
    defaultModelCb.addEventListener('change', () => {
        defaultModelInp.disabled = !defaultModelCb.checked;
        defaultModelInp.parentElement.style.opacity = defaultModelCb.checked ? '1' : '0.4';
    });
    defaultModelInp.parentElement.style.opacity = '0.4';

    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    // Returns milliseconds: (offset + random(min..max)) seconds
    const computeWaitMs = (offsetSec, minSec, maxSec) => {
        const rand = Math.random() * (maxSec - minSec) + minSec;
        return Math.round((offsetSec + rand) * 1000);
    };

    // Read the editable offsets from the panel (fall back to the constants)
    function getSuccessOffset() {
        const v = parseFloat(document.getElementById('inp-success-offset').value);
        return isNaN(v) || v < 0 ? SUCCESS_WAIT_OFFSET : v;
    }
    function getFailureOffset() {
        const v = parseFloat(document.getElementById('inp-failure-offset').value);
        return isNaN(v) || v < 0 ? FAILURE_WAIT_OFFSET : v;
    }
    function getDeleteOffset() {
        const v = parseFloat(document.getElementById('inp-delete-offset').value);
        return isNaN(v) || v < 0 ? DELETE_WAIT_OFFSET : v;
    }

    // Update the "Selected: N" counter in the floating panel
    function updateSelectedCount() {
        const el = document.getElementById('status-selected');
        if (!el) return;
        const count = document.querySelectorAll('.upscaler-checkbox:checked').length;
        el.innerText = String(count);
    }

    // Add a persistent "🗑 Deleted" badge overlay onto a tile (idempotent)
    function markTileDeleted(cb) {
        const container = cb.closest('a') || cb.parentElement.parentElement || cb.parentElement;
        if (!container) return;

        // Dim the whole tile
        container.style.opacity = '0.45';
        container.style.filter = 'grayscale(1)';
        container.style.transition = 'opacity 0.2s, filter 0.2s';

        // Avoid adding the badge twice
        if (container.querySelector('.upscaler-deleted-badge')) return;

        if (window.getComputedStyle(container).position === 'static') {
            container.style.position = 'relative';
        }

        const badge = document.createElement('div');
        badge.className = 'upscaler-deleted-badge';
        badge.innerText = '🗑 Deleted';
        badge.style.position = 'absolute';
        badge.style.top = '5px';
        badge.style.left = '5px';
        badge.style.right = '5px';
        badge.style.padding = '4px 6px';
        badge.style.backgroundColor = 'rgba(244, 67, 54, 0.92)';
        badge.style.color = '#fff';
        badge.style.fontSize = '12px';
        badge.style.fontWeight = 'bold';
        badge.style.fontFamily = 'monospace';
        badge.style.textAlign = 'center';
        badge.style.borderRadius = '4px';
        badge.style.zIndex = '101';
        badge.style.pointerEvents = 'none';
        container.appendChild(badge);
    }

    async function getFreshRecaptchaToken() {
        try {
            if (window.grecaptcha && window.grecaptcha.enterprise) {
                const script = document.querySelector('script[src*="recaptcha/enterprise.js"]');
                let siteKey = '';
                if (script) {
                    const match = script.src.match(/render=([^&]+)/);
                    if (match) siteKey = match[1];
                }
                if (siteKey) {
                    const freshToken = await window.grecaptcha.enterprise.execute(siteKey, {action: 'IMAGE_GENERATION'});
                    console.log("[Auto-Upscaler] Generated fresh reCAPTCHA token!");
                    return freshToken;
                }
            }
        } catch (e) {
            console.warn("[Auto-Upscaler] Failed to get fresh reCAPTCHA token:", e);
        }
        console.warn("[Auto-Upscaler] Falling back to intercepted stale token...");
        return window.__upscale_tokens.recaptchaToken;
    }

    // Extract text while preserving line breaks (<br> -> \n).
    // Uses textContent (not innerText) so CSS line-clamp doesn't truncate the prompt.
    function extractText(el) {
        if (!el) return '';
        const clone = el.cloneNode(true);
        clone.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
        return clone.textContent.replace(/\u00a0/g, ' ').trim();
    }

    // ---- METADATA EXTRACTION ----
    function getImageMetadata(mediaId) {
        const meta = { prompt: '', model: '', created: '' };
        const img = document.querySelector(`img[alt="Generated image"][src*="name=${mediaId}"]`);
        if (!img) return meta;

        // Climb to the tile container of the virtualized grid
        const tile = img.closest('[data-item-index]') || img.closest('div[data-index]');
        if (!tile) return meta;

        // Full prompt (CSS-clamped text is still fully present in the DOM)
        const sel = tile.querySelector('[data-allow-text-selection="true"]');
        if (sel && sel.firstElementChild) {
            meta.prompt = extractText(sel.firstElementChild.firstElementChild);
        }

        // Footer block: the div whose first child starts with "Created"
        const footer = Array.from(tile.querySelectorAll('div')).find(d =>
            d.children.length >= 2 &&
            d.firstElementChild &&
            /^Created/.test(d.firstElementChild.textContent)
        );
        if (footer) {
            const childDivs = Array.from(footer.children);

            // Created is always the first child
            meta.created = (childDivs[0] ? childDivs[0].textContent.trim() : '').replace(/^Created\s*/, '');

            // Model is the child (after "Created") that has NO icon (<i>) inside it.
            // The aspect-ratio child always contains an <i class="google-symbols">crop_...</i>,
            // so it is skipped; when the model is missing there simply is no such child.
            const modelDiv = childDivs.slice(1).find(d => !d.querySelector('i'));
            meta.model = modelDiv
                ? modelDiv.textContent.replace(/^[^\p{L}\p{N}]+/u, '').trim()
                : '';
        }
        return meta;
    }

    // Slugify a model name into "ai:model:<slug>", or return null if empty
    function slugModelTag(name) {
        if (!name) return null;
        const slug = name.toLowerCase().replace(/[^\w]+/g, '_').replace(/^_+|_+$/g, '');
        return slug ? `ai:model:${slug}` : null;
    }

    // Decide the model tag: extracted model wins; else the panel default (if enabled); else omit
    function modelToTag(model) {
        const extracted = slugModelTag(model);
        if (extracted) return extracted;

        if (defaultModelCb.checked) {
            return slugModelTag(defaultModelInp.value.trim());
        }
        return null; // omit model tag entirely when missing and default is off
    }

    // Build the tags array (deduped, insertion order preserved)
    function buildTags(meta, upscaled) {
        const tags = [...STATIC_TAGS];
        const modelTag = modelToTag(meta.model);
        if (modelTag) tags.push(modelTag);
        if (upscaled) tags.push('ai:upscaled');
        return [...new Set(tags)];
    }

    // Build the notes array (conditional, numbered: Prompt first, Created second)
    function buildNotes(meta) {
        const notes = [];
        let n = 1;
        if (meta.prompt)  notes.push(`${n++}.Prompt: ${meta.prompt}`);
        if (meta.created) notes.push(`${n++}.Created: ${meta.created}`);
        return notes;
    }

    // Build the grouped .json sidecar
    function buildJson(meta, upscaled) {
        return JSON.stringify({
            tags: buildTags(meta, upscaled),
            notes: buildNotes(meta)
        }, null, 2);
    }

    // ---- DELETE (archive) a workflow via PATCH ----
    async function archiveWorkflow(workflowId) {
        const t = window.__upscale_tokens;
        return window.fetch(`https://aisandbox-pa.googleapis.com/v1/flowWorkflows/${workflowId}`, {
            headers: {
                "accept": "*/*",
                "authorization": t.authToken,
                "content-type": "text/plain;charset=UTF-8",
            },
            body: JSON.stringify({
                workflow: {
                    name: workflowId,
                    projectId: getProjectId(),
                    metadata: { archived: true }
                },
                updateMask: "metadata.archived"
            }),
            method: "PATCH",
            mode: "cors",
            credentials: "include"
        });
    }

    document.getElementById('btn-upscale-selected').onclick = async () => {
        const checkedBoxes = Array.from(document.querySelectorAll('.upscaler-checkbox:checked'));
        if (checkedBoxes.length === 0) {
            alert("No images selected.");
            return;
        }

        const only1k = document.getElementById('cb-only-1k').checked;

        const t = window.__upscale_tokens;
        // Auth token is only required for the 2K upscale API; 1K-only uses the redirect endpoint.
        if (!only1k && !t.authToken) {
            alert("Cannot upscale yet! Wait for Auth token to turn green (✅).");
            return;
        }

        const btn = document.getElementById('btn-upscale-selected');
        btn.innerText = `${only1k ? 'Downloading' : 'Upscaling'} 0 / ${checkedBoxes.length}...`;
        btn.style.backgroundColor = '#FFC107';
        btn.disabled = true;

        for (let i = 0; i < checkedBoxes.length; i++) {
            const cb = checkedBoxes[i];
            const mediaId = cb.value;
            btn.innerText = `${only1k ? 'Downloading' : 'Upscaling'} ${i + 1} / ${checkedBoxes.length}...`;
            console.log(`[Auto-Upscaler] Processing ${mediaId}...`);

            // Track outcome of this iteration to pick the right wait afterwards
            let iterationSuccess = false;

            // Only fetch a reCAPTCHA token when we actually hit the upscale API.
            const freshToken = only1k ? '' : await getFreshRecaptchaToken();

            const makePayload = (resolution) => {
                const p = {
                    mediaId: mediaId,
                    clientContext: {
                        recaptchaContext: {
                            token: freshToken,
                            applicationType: "RECAPTCHA_APPLICATION_TYPE_WEB"
                        },
                        projectId: getProjectId(),
                        tool: "PINHOLE",
                        userPaygateTier: "PAYGATE_TIER_ONE",
                        sessionId: t.sessionId
                    }
                };
                if (resolution) {
                    p.targetResolution = resolution;
                }
                return p;
            };

            const sendRequest = async (payload) => {
                return await window.fetch("https://aisandbox-pa.googleapis.com/v1/flow/upsampleImage", {
                    headers: {
                        "accept": "*/*",
                        "authorization": t.authToken,
                        "content-type": "text/plain;charset=UTF-8",
                    },
                    body: JSON.stringify(payload),
                    method: "POST",
                    mode: "cors"
                });
            };

            const downloadBase64 = (base64Data, filename) => {
                const a = document.createElement('a');
                a.href = 'data:image/jpeg;base64,' + base64Data;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
            };

            const downloadUrl = async (url, filename) => {
                const r = await window.fetch(url);
                const blob = await r.blob();
                const blobUrl = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = blobUrl;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                setTimeout(() => window.URL.revokeObjectURL(blobUrl), 10000);
            };

            const downloadText = (content, filename) => {
                const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
                const blobUrl = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = blobUrl;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                setTimeout(() => window.URL.revokeObjectURL(blobUrl), 10000);
            };

            // Writes image-filename.ext.json sidecar
            const writeSidecar = async (imageFilename, upscaled) => {
                const meta = getImageMetadata(mediaId);
                await sleep(400); // avoid the browser's multi-download block
                downloadText(buildJson(meta, upscaled), `${imageFilename}.json`);
            };

            try {
                if (only1k) {
                    // ---- 1K-only mode: skip the upscale API entirely ----
                    console.log(`[Auto-Upscaler] 1K-only download for ${mediaId}...`);
                    const imageFilename = `GoogleFlow_1K_${mediaId}.jpg`;
                    await downloadUrl(`https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name=${mediaId}`, imageFilename);
                    await writeSidecar(imageFilename, false); // 1K -> no ai:upscaled tag
                    console.log(`[Auto-Upscaler] Success (1K only) for ${mediaId}`);
                    cb.parentElement.style.backgroundColor = 'rgba(76, 175, 80, 0.8)';
                    cb.checked = false;
                    updateSelectedCount();
                    iterationSuccess = true;
                } else {
                    // 1. Try 2K Upscale
                    let res = await sendRequest(makePayload("UPSAMPLE_IMAGE_RESOLUTION_2K"));
                    let resolutionUsed = "2K";

                    // 2. Fallback to default 1K via redirect if 2K fails AND fallback is checked
                    const fallbackChecked = document.getElementById('cb-download-fallback').checked;
                    if (!res.ok) {
                        if (fallbackChecked) {
                            console.warn(`[Auto-Upscaler] 2K failed for ${mediaId}, downloading default 1K via redirect...`);
                            const imageFilename = `GoogleFlow_1K_${mediaId}.jpg`;
                            await downloadUrl(`https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name=${mediaId}`, imageFilename);
                            await writeSidecar(imageFilename, false); // 1K -> no ai:upscaled tag
                            console.log(`[Auto-Upscaler] Success (1K Fallback) for ${mediaId}`);
                            cb.parentElement.style.backgroundColor = 'rgba(76, 175, 80, 0.8)';
                            cb.checked = false;
                            updateSelectedCount();
                            iterationSuccess = true; // 1K fallback download counts as success for throttling
                            res = null; // nullify so we skip the JSON block
                        } else {
                            throw new Error(`2K upscale failed and fallback disabled. Server response: ${await res.text()}`);
                        }
                    }

                    if (res && res.ok) {
                        const data = await res.json();
                        console.log(`[Auto-Upscaler] Success (${resolutionUsed}) for ${mediaId}`);
                        if (data.encodedImage) {
                            const imageFilename = `GoogleFlow_${resolutionUsed}_${mediaId}.jpg`;
                            downloadBase64(data.encodedImage, imageFilename);
                            await writeSidecar(imageFilename, true); // 2K success -> ai:upscaled tag
                        }
                        cb.parentElement.style.backgroundColor = 'rgba(76, 175, 80, 0.8)';
                        cb.checked = false; // Uncheck on success
                        updateSelectedCount();
                        iterationSuccess = true;
                    } else if (res && !res.ok) {
                        const errText = await res.text();
                        console.error(`[Auto-Upscaler] Final failure for ${mediaId}:`, errText);
                        cb.parentElement.style.backgroundColor = 'rgba(244, 67, 54, 0.8)';
                        iterationSuccess = false;
                    }
                }
            } catch (e) {
                console.error(`[Auto-Upscaler] Error on ${mediaId}:`, e);
                cb.parentElement.style.backgroundColor = 'rgba(244, 67, 54, 0.8)';
                iterationSuccess = false;
            }

            // Throttle between requests (unless it's the last one).
            // Success and failure use their own offset (from the panel) + random wait windows.
            if (i < checkedBoxes.length - 1) {
                const sleepTime = iterationSuccess
                    ? computeWaitMs(getSuccessOffset(), SUCCESS_WAIT_RAND_MIN, SUCCESS_WAIT_RAND_MAX)
                    : computeWaitMs(getFailureOffset(), FAILURE_WAIT_RAND_MIN, FAILURE_WAIT_RAND_MAX);
                console.log(`[Auto-Upscaler] ${iterationSuccess ? 'Success' : 'Failure'} throttle — sleeping for ${sleepTime}ms...`);
                await sleep(sleepTime);
            }
        }

        btn.innerText = 'Upscale Selected';
        btn.style.backgroundColor = '#2196F3';
        btn.disabled = false;
    };

    // ---- DELETE SELECTED (archive) ----
    document.getElementById('btn-delete-selected').onclick = async () => {
        const checkedBoxes = Array.from(document.querySelectorAll('.upscaler-checkbox:checked'));
        if (checkedBoxes.length === 0) {
            alert("No images selected.");
            return;
        }

        const t = window.__upscale_tokens;
        if (!t.authToken) {
            alert("Cannot delete yet! Wait for Auth token to turn green (✅).");
            return;
        }

        // Ensure every selected tile has a workflow ID; warn about any that don't.
        const missing = checkedBoxes.filter(cb => !cb.dataset.workflowId).length;
        if (!confirm(`Move ${checkedBoxes.length} image(s) to trash?` +
            (missing ? `\n\n⚠️ ${missing} have no workflow ID and will be skipped.` : '') +
            `\n\nThis is reversible from the app's trash.`)) {
            return;
        }

        const btn = document.getElementById('btn-delete-selected');
        btn.innerText = `Deleting 0 / ${checkedBoxes.length}...`;
        btn.disabled = true;

        for (let i = 0; i < checkedBoxes.length; i++) {
            const cb = checkedBoxes[i];
            const workflowId = cb.dataset.workflowId;
            btn.innerText = `Deleting ${i + 1} / ${checkedBoxes.length}...`;

            let iterationSuccess = false;
            try {
                if (!workflowId) throw new Error("No workflow ID captured for this tile");
                const res = await archiveWorkflow(workflowId);
                if (res.ok) {
                    console.log(`[Auto-Upscaler] Archived workflow ${workflowId}`);
                    markTileDeleted(cb); // visual indication on the tile
                    cb.checked = false;
                    cb.disabled = true;  // prevent re-selecting a deleted tile
                    updateSelectedCount();
                    iterationSuccess = true;
                } else {
                    console.error(`[Auto-Upscaler] Delete failed for ${workflowId}:`, await res.text());
                    cb.parentElement.style.backgroundColor = 'rgba(244, 67, 54, 0.4)';
                }
            } catch (e) {
                console.error(`[Auto-Upscaler] Delete error:`, e);
                cb.parentElement.style.backgroundColor = 'rgba(244, 67, 54, 0.4)';
            }

            // Throttle between deletes using the dedicated delete offset
            if (i < checkedBoxes.length - 1) {
                const sleepTime = computeWaitMs(getDeleteOffset(), DELETE_WAIT_RAND_MIN, DELETE_WAIT_RAND_MAX);
                console.log(`[Auto-Upscaler] Delete throttle — sleeping for ${sleepTime}ms...`);
                await sleep(sleepTime);
            }
        }

        btn.innerText = 'Delete Selected';
        btn.disabled = false;
        console.log("[Auto-Upscaler] Delete batch done. Reload the page to refresh the grid.");
    };

    function updateStatusUI() {
        if (window.__upscale_tokens.authToken) {
            document.getElementById('status-auth').innerText = '✅';
            document.getElementById('status-auth').style.color = '#4CAF50';
        }
        if (window.__upscale_tokens.recaptchaToken) {
            document.getElementById('status-recaptcha').innerText = '✅';
            document.getElementById('status-recaptcha').style.color = '#4CAF50';
        }
    }

    let lastCheckedBox = null;

    // 1. Scan DOM for generated images and overlay UI directly on them
    setInterval(() => {
        const images = document.querySelectorAll('img[src*="media.getMediaUrlRedirect"]:not([data-upscaler-injected])');
        images.forEach(img => {
            img.setAttribute('data-upscaler-injected', 'true');

            // Only the main generated image — skip ingredient/reference thumbnails
            if (img.getAttribute('alt') !== 'Generated image') return;

            const match = img.src.match(/name=([0-9a-f-]+)/i);
            if (!match) return;
            const mediaId = match[1];

            // Workflow ID = the UUID in the tile's edit link href (used for delete/archive).
            // The regex stops at the "?" so any ?_gl=... tracking params are ignored.
            // NOTE: do NOT use data-tile-id ("fe_id_...") — that's a front-end id, not the workflow id.
            let workflowId = '';
            const editLink = img.closest('a[href*="/edit/"]');
            if (editLink) {
                const wm = editLink.getAttribute('href').match(/\/edit\/([0-9a-f-]+)/i);
                if (wm) workflowId = wm[1];
            }

            // Get the anchor tag wrapper or its direct parent
            let container = img.closest('a') || img.parentElement;
            if (window.getComputedStyle(container).position === 'static') {
                container.style.position = 'relative';
            }

            // Create an overlay box
            const overlay = document.createElement('div');
            overlay.style.position = 'absolute';
            overlay.style.bottom = '5px';
            overlay.style.left = '5px';
            overlay.style.backgroundColor = 'rgba(0,0,0,0.8)';
            overlay.style.color = '#fff';
            overlay.style.padding = '4px 6px';
            overlay.style.fontSize = '11px';
            overlay.style.borderRadius = '4px';
            overlay.style.zIndex = '100';
            overlay.style.fontFamily = 'monospace';
            overlay.style.display = 'flex';
            overlay.style.alignItems = 'center';
            overlay.style.gap = '5px';

            const idText = document.createElement('span');
            idText.innerText = mediaId.substring(0, 8);

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'upscaler-checkbox';
            checkbox.value = mediaId;
            checkbox.dataset.workflowId = workflowId; // stash workflow ID for delete
            checkbox.style.cursor = 'pointer';
            checkbox.style.width = '14px';
            checkbox.style.height = '14px';
            checkbox.style.margin = '0';
            checkbox.onclick = function(e) {
                e.stopPropagation();

                if (e.shiftKey && lastCheckedBox) {
                    const allBoxes = Array.from(document.querySelectorAll('.upscaler-checkbox'));
                    const start = allBoxes.indexOf(lastCheckedBox);
                    const end = allBoxes.indexOf(this);

                    if (start > -1 && end > -1) {
                        const min = Math.min(start, end);
                        const max = Math.max(start, end);
                        for (let i = min; i <= max; i++) {
                            if (!allBoxes[i].disabled) allBoxes[i].checked = this.checked;
                        }
                    }
                }
                lastCheckedBox = this;
                updateSelectedCount();
            };

            overlay.appendChild(checkbox);
            overlay.appendChild(idText);
            container.appendChild(overlay);
        });

        // Keep the counter accurate even when tiles are added/removed by virtualization
        updateSelectedCount();
    }, 1000);

    // 2. Intercept fetch to steal tokens and payload
    const originalFetch = window.fetch;
    window.fetch = async function(...args) {
        const [url, options] = args;

        let reqUrl = '';
        if (typeof url === 'string') {
            reqUrl = url;
        } else if (url && url.url) {
            reqUrl = url.url;
        } else if (url && url.href) {
            reqUrl = url.href;
        }

        if (reqUrl) {
            // Intercept headers (Auth) from ANY request that has it
            if (options && options.headers) {
                const headersObj = options.headers instanceof Headers ? Object.fromEntries(options.headers.entries()) : options.headers;

                const auth = headersObj['authorization'] || headersObj['Authorization'];
                if (auth) {
                    window.__upscale_tokens.authToken = auth;
                    updateStatusUI();
                }
            }

            // Intercept body (Session ID, Recaptcha) from aisandbox-pa requests
            if (reqUrl.includes('aisandbox-pa.googleapis.com') && options && typeof options.body === 'string') {
                try {
                    const bodyObj = JSON.parse(options.body);
                    if (bodyObj.clientContext) {
                        if (bodyObj.clientContext.projectId) window.__upscale_tokens.projectId = bodyObj.clientContext.projectId;
                        if (bodyObj.clientContext.sessionId) window.__upscale_tokens.sessionId = bodyObj.clientContext.sessionId;
                        if (bodyObj.clientContext.recaptchaContext && bodyObj.clientContext.recaptchaContext.token) {
                            window.__upscale_tokens.recaptchaToken = bodyObj.clientContext.recaptchaContext.token;
                            updateStatusUI();
                        }
                    }
                } catch(e) {}
            }
        }

        const response = await originalFetch.apply(this, args);
        return response;
    };

})();
