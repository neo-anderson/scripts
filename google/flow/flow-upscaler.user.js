// ==UserScript==
// @name        Google Flow Auto-Upscaler
// @namespace   Violentmonkey Scripts
// @match       https://labs.google/fx/tools/flow/project/*
// @grant       none
// @version     1.4
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
    const DEFAULT_MODEL_TAG = 'ai:model:imagen_4';

    // ---- WAIT / THROTTLE CONFIG (seconds) ----
    // Success: base offset + random(min..max)
    const SUCCESS_WAIT_OFFSET = 7;      // constant base wait after a success
    const SUCCESS_WAIT_RAND_MIN = 1;    // random extra wait, lower bound
    const SUCCESS_WAIT_RAND_MAX = 3;    // random extra wait, upper bound
    // Failure: base offset + random(min..max)
    const FAILURE_WAIT_OFFSET = 7;      // constant base wait after a failure
    const FAILURE_WAIT_RAND_MIN = 1;    // random extra wait, lower bound
    const FAILURE_WAIT_RAND_MAX = 3;    // random extra wait, upper bound

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
    controlPanel.innerHTML = `
        <div style="margin-bottom: 10px;">
            <strong>Status</strong><br>
            Auth: <span id="status-auth" style="color: #F44336;">❌</span> | 
            Recaptcha: <span id="status-recaptcha" style="color: #F44336;">❌</span>
        </div>
        <div style="margin-bottom: 10px;">
            Selected: <span id="status-selected" style="color: #2196F3;">0</span>
        </div>
        <div style="margin-bottom: 10px; padding-bottom: 10px; border-bottom: 1px solid #444;">
            <label style="cursor: pointer; display: flex; align-items: center; gap: 5px; font-size: 11px;">
                <input type="checkbox" id="cb-download-fallback" style="cursor: pointer; margin: 0;">
                Download default 1K if 2K fails
            </label>
        </div>
        <button id="btn-upscale-selected" style="width: 100%; padding: 8px; cursor: pointer; background-color: #2196F3; color: white; border: none; border-radius: 4px;">
            Upscale Selected
        </button>
    `;
    document.body.appendChild(controlPanel);

    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    // Returns milliseconds: (offset + random(min..max)) seconds
    const computeWaitMs = (offsetSec, minSec, maxSec) => {
        const rand = Math.random() * (maxSec - minSec) + minSec;
        return Math.round((offsetSec + rand) * 1000);
    };

    // Update the "Selected: N" counter in the floating panel
    function updateSelectedCount() {
        const el = document.getElementById('status-selected');
        if (!el) return;
        const count = document.querySelectorAll('.upscaler-checkbox:checked').length;
        el.innerText = String(count);
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
            const parts = Array.from(footer.children).map(c => c.textContent.trim());
            meta.created = (parts[0] || '').replace(/^Created\s*/, '');
            // strip leading emoji/symbols from model name
            meta.model = (parts[1] || '').replace(/^[^\p{L}\p{N}]+/u, '').trim();
        }
        return meta;
    }

    function modelToTag(model) {
        if (!model) return DEFAULT_MODEL_TAG;
        const slug = model.toLowerCase().replace(/[^\w]+/g, '_').replace(/^_+|_+$/g, '');
        return slug ? `ai:model:${slug}` : DEFAULT_MODEL_TAG;
    }

    // Build the tags array (deduped, insertion order preserved)
    function buildTags(meta, upscaled) {
        const tags = [...STATIC_TAGS];
        tags.push(modelToTag(meta.model));
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

    document.getElementById('btn-upscale-selected').onclick = async () => {
        const checkedBoxes = Array.from(document.querySelectorAll('.upscaler-checkbox:checked'));
        if (checkedBoxes.length === 0) {
            alert("No images selected.");
            return;
        }

        const t = window.__upscale_tokens;
        if (!t.authToken) {
            alert("Cannot upscale yet! Wait for Auth token to turn green (✅).");
            return;
        }

        const btn = document.getElementById('btn-upscale-selected');
        btn.innerText = `Upscaling 0 / ${checkedBoxes.length}...`;
        btn.style.backgroundColor = '#FFC107';
        btn.disabled = true;

        for (let i = 0; i < checkedBoxes.length; i++) {
            const cb = checkedBoxes[i];
            const mediaId = cb.value;
            btn.innerText = `Upscaling ${i + 1} / ${checkedBoxes.length}...`;
            console.log(`[Auto-Upscaler] Attempting to upscale ${mediaId}...`);

            // Track outcome of this iteration to pick the right wait afterwards
            let iterationSuccess = false;

            const freshToken = await getFreshRecaptchaToken();

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
            } catch (e) {
                console.error(`[Auto-Upscaler] Error on ${mediaId}:`, e);
                cb.parentElement.style.backgroundColor = 'rgba(244, 67, 54, 0.8)';
                iterationSuccess = false;
            }

            // Throttle between requests (unless it's the last one).
            // Success and failure use their own offset + random wait windows.
            if (i < checkedBoxes.length - 1) {
                const sleepTime = iterationSuccess
                    ? computeWaitMs(SUCCESS_WAIT_OFFSET, SUCCESS_WAIT_RAND_MIN, SUCCESS_WAIT_RAND_MAX)
                    : computeWaitMs(FAILURE_WAIT_OFFSET, FAILURE_WAIT_RAND_MIN, FAILURE_WAIT_RAND_MAX);
                console.log(`[Auto-Upscaler] ${iterationSuccess ? 'Success' : 'Failure'} throttle — sleeping for ${sleepTime}ms...`);
                await sleep(sleepTime);
            }
        }

        btn.innerText = 'Upscale Selected';
        btn.style.backgroundColor = '#2196F3';
        btn.disabled = false;
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
                            allBoxes[i].checked = this.checked;
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
