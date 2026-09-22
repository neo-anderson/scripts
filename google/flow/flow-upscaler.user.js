// ==UserScript==
// @name        Google Flow Auto-Upscaler
// @namespace   Violentmonkey Scripts
// @match       https://flow.google.com/*
// @match       https://flow.google.com/project/*
// @match       https://labs.google/fx/tools/flow/project/*
// @grant       none
// @version     2.8.4
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
// **Separate toggles for downloading 2K upscaled & default 1K** (both enabled by default) and a **minimize/expand** toggle for the panel.
// default model and offset options on the panel.

(function() {
    'use strict';

    const SCRIPT_VERSION = 'v2.8.4';

    console.log(`[Auto-Upscaler ${SCRIPT_VERSION}] Script loaded on:`, window.location.href);

    // Store tokens intercepted from normal page traffic or Google BOQ WIZ data
    window.__upscale_tokens = {
        authToken: '',       // Legacy Authorization header if present
        at: '',              // Google BOQ XSRF / session token (WIZ_global_data.SNlM0e or batchexecute POST body)
        bl: '',              // BOQ build label (WIZ_global_data.cfb2h or batchexecute URL query)
        fSid: '',            // BOQ session ID (WIZ_global_data.FdrFJe or batchexecute URL query)
        sourcePath: '',      // source-path parameter from batchexecute URL
        projectId: '',       // Extracted dynamically from URL or fetch
        sessionId: '',
        recaptchaToken: '',
        recaptchaSiteKey: '',
        recaptchaAction: ''  // Action name for grecaptcha (e.g. IMAGE_GENERATION)
    };
    window.__media_to_workflow = window.__media_to_workflow || {};
    window.__media_to_cdn_url = window.__media_to_cdn_url || {};

    function hookRecaptcha() {
        try {
            if (!window.grecaptcha) return;

            // 1. Hook grecaptcha.execute
            if (typeof window.grecaptcha.execute === 'function' && !window.grecaptcha.execute.__hooked) {
                const orig = window.grecaptcha.execute;
                window.grecaptcha.execute = async function(siteKey, actionObj) {
                    console.log('[Auto-Upscaler] Hook intercepted grecaptcha.execute call! siteKey:', siteKey, 'action:', actionObj);
                    if (siteKey && siteKey !== 'explicit') {
                        window.__upscale_tokens.recaptchaSiteKey = siteKey;
                    }
                    if (actionObj && actionObj.action) {
                        window.__upscale_tokens.recaptchaAction = actionObj.action;
                    }
                    const res = await orig.apply(this, arguments);
                    if (res && typeof res === 'string') {
                        console.log('[Auto-Upscaler] Hook intercepted generated token of length:', res.length);
                        window.__upscale_tokens.recaptchaToken = res;
                        updateStatusUI();
                    }
                    return res;
                };
                window.grecaptcha.execute.__hooked = true;
                console.log('[Auto-Upscaler] Successfully installed hook on grecaptcha.execute');
            }

            // 2. Hook grecaptcha.enterprise.execute
            if (window.grecaptcha.enterprise && typeof window.grecaptcha.enterprise.execute === 'function' && !window.grecaptcha.enterprise.__hooked) {
                const orig = window.grecaptcha.enterprise.execute;
                window.grecaptcha.enterprise.execute = async function(siteKey, actionObj) {
                    console.log('[Auto-Upscaler] Hook intercepted grecaptcha.enterprise.execute call! siteKey:', siteKey, 'action:', actionObj);
                    if (siteKey && siteKey !== 'explicit') {
                        window.__upscale_tokens.recaptchaSiteKey = siteKey;
                    }
                    if (actionObj && actionObj.action) {
                        window.__upscale_tokens.recaptchaAction = actionObj.action;
                    }
                    const res = await orig.apply(this, arguments);
                    if (res && typeof res === 'string') {
                        console.log('[Auto-Upscaler] Hook intercepted generated token of length:', res.length);
                        window.__upscale_tokens.recaptchaToken = res;
                        updateStatusUI();
                    }
                    return res;
                };
                window.grecaptcha.enterprise.__hooked = true;
                console.log('[Auto-Upscaler] Successfully installed hook on grecaptcha.enterprise.execute');
            }
        } catch (e) {}
    }

    // Attempt hook immediately on load, and keep checking until installed
    hookRecaptcha();
    const recaptchaHookPoll = setInterval(() => {
        hookRecaptcha();
        if (window.grecaptcha && window.grecaptcha.enterprise && window.grecaptcha.enterprise.__hooked) {
            clearInterval(recaptchaHookPoll);
        }
    }, 250);

    function getRecaptchaSiteKey() {
        if (window.__upscale_tokens.recaptchaSiteKey && window.__upscale_tokens.recaptchaSiteKey !== 'explicit') {
            return window.__upscale_tokens.recaptchaSiteKey;
        }

        // 1. Check DOM elements with data-sitekey
        const elWithKey = document.querySelector('[data-sitekey]');
        if (elWithKey) {
            const k = elWithKey.getAttribute('data-sitekey');
            if (k && k !== 'explicit') {
                window.__upscale_tokens.recaptchaSiteKey = k;
                return k;
            }
        }

        // 2. Check script tags for render=<sitekey>, ignoring 'explicit'
        const scripts = document.querySelectorAll('script[src*="recaptcha"]');
        for (const s of scripts) {
            const m = s.src.match(/render=([^&]+)/);
            if (m && m[1] && m[1] !== 'explicit') {
                window.__upscale_tokens.recaptchaSiteKey = m[1];
                return m[1];
            }
        }

        // 3. Inspect window.___grecaptcha_cfg
        try {
            if (window.___grecaptcha_cfg && window.___grecaptcha_cfg.clients) {
                const clients = window.___grecaptcha_cfg.clients;
                const findKey = (obj, depth = 0) => {
                    if (!obj || depth > 6) return null;
                    if (typeof obj === 'string') {
                        if (obj.length === 40 && /^[0-9a-zA-Z_-]{40}$/.test(obj) && obj !== 'explicit') {
                            return obj;
                        }
                        return null;
                    }
                    if (typeof obj === 'object') {
                        for (const k of Object.keys(obj)) {
                            try {
                                if (obj[k] instanceof Node) continue;
                                const res = findKey(obj[k], depth + 1);
                                if (res) return res;
                            } catch (e) {}
                        }
                    }
                    return null;
                };
                const found = findKey(clients);
                if (found) {
                    console.log('[Auto-Upscaler] Found sitekey in ___grecaptcha_cfg:', found);
                    window.__upscale_tokens.recaptchaSiteKey = found;
                    return found;
                }
            }
        } catch (e) {}

        // 4. Search inline scripts for 40-character sitekey pattern (e.g. 6L...)
        try {
            for (const s of document.querySelectorAll('script:not([src])')) {
                const text = s.textContent || '';
                const m = text.match(/['"](6L[0-9a-zA-Z_-]{38})['"]/);
                if (m) {
                    console.log('[Auto-Upscaler] Found sitekey in inline script:', m[1]);
                    window.__upscale_tokens.recaptchaSiteKey = m[1];
                    return m[1];
                }
            }
        } catch (e) {}

        return '';
    }

    function extractTokensFromWiz() {
        hookRecaptcha();
        if (typeof window.WIZ_global_data === 'object' && window.WIZ_global_data !== null) {
            const w = window.WIZ_global_data;
            if (w.SNlM0e && !window.__upscale_tokens.at) {
                window.__upscale_tokens.at = w.SNlM0e;
            }
            if (w.cfb2h && !window.__upscale_tokens.bl) {
                window.__upscale_tokens.bl = w.cfb2h;
            }
            if (w.FdrFJe && !window.__upscale_tokens.fSid) {
                window.__upscale_tokens.fSid = w.FdrFJe;
            }
        }
        getRecaptchaSiteKey();
    }

    function findWorkflowMappings(obj, parentWfId = '') {
        if (!obj || typeof obj !== 'object') return;
        let currentWfId = parentWfId;
        if (typeof obj.name === 'string' && /([0-9a-f-]{36})/.test(obj.name)) {
            const m = obj.name.match(/([0-9a-f-]{36})/);
            if (m) currentWfId = m[1];
        } else if (typeof obj.workflowId === 'string') {
            currentWfId = obj.workflowId;
        }

        if (typeof obj.mediaId === 'string' && currentWfId) {
            window.__media_to_workflow[obj.mediaId] = currentWfId;
        }

        for (const k of Object.keys(obj)) {
            if (typeof obj[k] === 'object' && obj[k] !== null) {
                findWorkflowMappings(obj[k], currentWfId);
            }
        }
    }

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

    function getProjectId() {
        // Try to grab from the current URL first: /fx/tools/flow/project/<id> or /project/<id>
        const match = window.location.pathname.match(/\/project\/([0-9a-f-]+)/);
        return match ? match[1] : window.__upscale_tokens.projectId;
    }

    // 0. Global UI Container (pure DOM construction for full CSP & Trusted-Types compatibility)
    const controlPanel = document.createElement('div');
    controlPanel.id = 'flow-auto-upscaler-panel';
    Object.assign(controlPanel.style, {
        position: 'fixed',
        bottom: '20px',
        right: '20px',
        backgroundColor: 'rgba(0, 0, 0, 0.95)',
        color: '#fff',
        padding: '14px',
        borderRadius: '8px',
        zIndex: '2147483647',
        fontFamily: 'monospace',
        fontSize: '12px',
        width: '260px',
        boxShadow: '0 4px 16px rgba(0, 0, 0, 0.6)',
        border: '1px solid #444',
        boxSizing: 'border-box',
        display: 'block',
        visibility: 'visible',
    });

    const panelHeader = document.createElement('div');
    panelHeader.id = 'panel-header';
    Object.assign(panelHeader.style, {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: '10px',
    });

    const panelTitle = document.createElement('strong');
    panelTitle.textContent = `Auto-Upscaler ${SCRIPT_VERSION}`;
    panelHeader.appendChild(panelTitle);

    const btnMinimize = document.createElement('button');
    btnMinimize.id = 'btn-minimize';
    btnMinimize.title = 'Minimize';
    btnMinimize.textContent = '–';
    Object.assign(btnMinimize.style, {
        cursor: 'pointer',
        background: '#444',
        color: '#fff',
        border: 'none',
        borderRadius: '4px',
        width: '22px',
        height: '22px',
        lineHeight: '1',
        fontSize: '14px',
    });
    panelHeader.appendChild(btnMinimize);
    controlPanel.appendChild(panelHeader);

    const panelContent = document.createElement('div');
    panelContent.id = 'panel-content';
    panelContent.style.marginTop = '10px';

    const statusRow = document.createElement('div');
    statusRow.style.marginBottom = '10px';
    const statusTitle = document.createElement('strong');
    statusTitle.textContent = 'Status';
    statusRow.appendChild(statusTitle);
    statusRow.appendChild(document.createElement('br'));
    statusRow.appendChild(document.createTextNode('Auth: '));

    const statusAuth = document.createElement('span');
    statusAuth.id = 'status-auth';
    statusAuth.style.color = '#F44336';
    statusAuth.textContent = '❌';
    statusRow.appendChild(statusAuth);

    statusRow.appendChild(document.createTextNode(' | Recaptcha: '));

    const statusRecaptcha = document.createElement('span');
    statusRecaptcha.id = 'status-recaptcha';
    statusRecaptcha.style.color = '#F44336';
    statusRecaptcha.textContent = '❌';
    statusRow.appendChild(statusRecaptcha);
    panelContent.appendChild(statusRow);

    const selectedRow = document.createElement('div');
    selectedRow.style.marginBottom = '10px';
    selectedRow.appendChild(document.createTextNode('Selected: '));
    const statusSelected = document.createElement('span');
    statusSelected.id = 'status-selected';
    statusSelected.style.color = '#2196F3';
    statusSelected.textContent = '0';
    selectedRow.appendChild(statusSelected);
    panelContent.appendChild(selectedRow);

    // Download checkboxes
    const dlDiv = document.createElement('div');
    Object.assign(dlDiv.style, {
        marginBottom: '10px',
        paddingBottom: '10px',
        borderBottom: '1px solid #444',
    });

    const lbl2k = document.createElement('label');
    Object.assign(lbl2k.style, {
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: '5px',
        fontSize: '11px',
        marginBottom: '6px',
    });
    const cbDownload2k = document.createElement('input');
    cbDownload2k.type = 'checkbox';
    cbDownload2k.id = 'cb-download-2k';
    cbDownload2k.checked = true;
    cbDownload2k.style.cursor = 'pointer';
    cbDownload2k.style.margin = '0';
    lbl2k.appendChild(cbDownload2k);
    lbl2k.appendChild(document.createTextNode('Download 2K upscaled'));
    dlDiv.appendChild(lbl2k);

    const lbl1k = document.createElement('label');
    Object.assign(lbl1k.style, {
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: '5px',
        fontSize: '11px',
    });
    const cbDownload1k = document.createElement('input');
    cbDownload1k.type = 'checkbox';
    cbDownload1k.id = 'cb-download-1k';
    cbDownload1k.checked = true;
    cbDownload1k.style.cursor = 'pointer';
    cbDownload1k.style.margin = '0';
    lbl1k.appendChild(cbDownload1k);
    lbl1k.appendChild(document.createTextNode('Download default 1K'));
    dlDiv.appendChild(lbl1k);
    panelContent.appendChild(dlDiv);

    // Default model
    const modelDiv = document.createElement('div');
    Object.assign(modelDiv.style, {
        marginBottom: '10px',
        paddingBottom: '10px',
        borderBottom: '1px solid #444',
    });

    const lblModel = document.createElement('label');
    Object.assign(lblModel.style, {
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: '5px',
        fontSize: '11px',
        marginBottom: '6px',
    });
    const defaultModelCb = document.createElement('input');
    defaultModelCb.type = 'checkbox';
    defaultModelCb.id = 'cb-default-model';
    defaultModelCb.checked = true;
    defaultModelCb.style.cursor = 'pointer';
    defaultModelCb.style.margin = '0';
    lblModel.appendChild(defaultModelCb);
    lblModel.appendChild(document.createTextNode('Use default model when missing'));
    modelDiv.appendChild(lblModel);

    const modelInpRow = document.createElement('div');
    Object.assign(modelInpRow.style, {
        display: 'flex',
        alignItems: 'center',
        gap: '5px',
        fontSize: '11px',
    });
    const lblModelPrefix = document.createElement('span');
    lblModelPrefix.textContent = 'ai:model:';
    modelInpRow.appendChild(lblModelPrefix);

    const defaultModelInp = document.createElement('input');
    defaultModelInp.type = 'text';
    defaultModelInp.id = 'inp-default-model';
    defaultModelInp.value = DEFAULT_MODEL_NAME;
    Object.assign(defaultModelInp.style, {
        flex: '1',
        minWidth: '0',
        background: '#222',
        color: '#fff',
        border: '1px solid #555',
        borderRadius: '3px',
        padding: '2px 4px',
        fontFamily: 'monospace',
        fontSize: '11px',
    });
    modelInpRow.appendChild(defaultModelInp);
    modelDiv.appendChild(modelInpRow);
    panelContent.appendChild(modelDiv);

    // Offset settings
    const offsetDiv = document.createElement('div');
    Object.assign(offsetDiv.style, {
        marginBottom: '10px',
        paddingBottom: '10px',
        borderBottom: '1px solid #444',
    });

    function createOffsetRow(label, id, defaultVal, isLast) {
        const row = document.createElement('div');
        Object.assign(row.style, {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '5px',
            fontSize: '11px',
            marginBottom: isLast ? '0' : '6px',
        });
        const span = document.createElement('span');
        span.textContent = label;
        row.appendChild(span);

        const inp = document.createElement('input');
        inp.type = 'number';
        inp.id = id;
        inp.value = String(defaultVal);
        inp.min = '0';
        inp.step = '1';
        Object.assign(inp.style, {
            width: '55px',
            background: '#222',
            color: '#fff',
            border: '1px solid #555',
            borderRadius: '3px',
            padding: '2px 4px',
            fontFamily: 'monospace',
            fontSize: '11px',
        });
        row.appendChild(inp);
        return inp;
    }

    const inpSuccessOffset = createOffsetRow('Success offset (s)', 'inp-success-offset', SUCCESS_WAIT_OFFSET, false);
    offsetDiv.appendChild(inpSuccessOffset.parentElement);
    const inpFailureOffset = createOffsetRow('Failure offset (s)', 'inp-failure-offset', FAILURE_WAIT_OFFSET, false);
    offsetDiv.appendChild(inpFailureOffset.parentElement);
    panelContent.appendChild(offsetDiv);

    // Action button
    const btnUpscale = document.createElement('button');
    btnUpscale.id = 'btn-upscale-selected';
    btnUpscale.textContent = 'Upscale / Download Selected';
    Object.assign(btnUpscale.style, {
        width: '100%',
        padding: '8px',
        cursor: 'pointer',
        backgroundColor: '#2196F3',
        color: 'white',
        border: 'none',
        borderRadius: '4px',
    });
    panelContent.appendChild(btnUpscale);

    // Collection Download button
    const btnDownloadCollection = document.createElement('button');
    btnDownloadCollection.id = 'btn-download-collection';
    btnDownloadCollection.textContent = 'Scan & Download Collection';
    Object.assign(btnDownloadCollection.style, {
        width: '100%',
        padding: '8px',
        marginTop: '6px',
        cursor: 'pointer',
        backgroundColor: '#4CAF50',
        color: 'white',
        border: 'none',
        borderRadius: '4px',
    });
    panelContent.appendChild(btnDownloadCollection);

    // Status / Last Downloaded info card
    const statusCard = document.createElement('div');
    statusCard.id = 'upscaler-status-card';
    Object.assign(statusCard.style, {
        marginTop: '8px',
        padding: '6px 8px',
        backgroundColor: '#1a1a1a',
        border: '1px solid #333',
        borderRadius: '4px',
        fontSize: '11px',
        color: '#aaa',
        lineHeight: '1.4',
        wordBreak: 'break-word',
        whiteSpace: 'pre-wrap',
    });
    statusCard.textContent = 'Ready';
    panelContent.appendChild(statusCard);

    controlPanel.appendChild(panelContent);

    // ---- Minimize / restore panel ----
    let panelMinimized = false;
    btnMinimize.onclick = () => {
        panelMinimized = !panelMinimized;
        panelContent.style.display = panelMinimized ? 'none' : 'block';
        btnMinimize.textContent = panelMinimized ? '+' : '–';
        btnMinimize.title = panelMinimized ? 'Expand' : 'Minimize';
    };

    // ---- Enable/disable the default-model textbox with its checkbox ----
    defaultModelCb.addEventListener('change', () => {
        defaultModelInp.disabled = !defaultModelCb.checked;
        modelInpRow.style.opacity = defaultModelCb.checked ? '1' : '0.4';
    });

    // Mount floating panel safely across SPA navigation / React hydration
    function mountControlPanel() {
        if (window.top !== window.self) return;
        if (document.getElementById('flow-auto-upscaler-panel')) return;
        const root = document.body || document.documentElement;
        if (root) {
            root.appendChild(controlPanel);
            console.log('[Auto-Upscaler] Floating control panel mounted to', root.tagName);
            updateStatusUI();
            updateSelectedCount();
        }
    }

    mountControlPanel();
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', mountControlPanel);
    }
    window.addEventListener('load', mountControlPanel);

    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    // Returns milliseconds: (offset + random(min..max)) seconds
    const computeWaitMs = (offsetSec, minSec, maxSec) => {
        const rand = Math.random() * (maxSec - minSec) + minSec;
        return Math.round((offsetSec + rand) * 1000);
    };

    // Read the editable offsets from the panel (fall back to the constants)
    function getSuccessOffset() {
        const v = parseFloat(inpSuccessOffset.value);
        return isNaN(v) || v < 0 ? SUCCESS_WAIT_OFFSET : v;
    }
    function getFailureOffset() {
        const v = parseFloat(inpFailureOffset.value);
        return isNaN(v) || v < 0 ? FAILURE_WAIT_OFFSET : v;
    }

    // Update the "Selected: N" counter in the floating panel
    function updateSelectedCount() {
        const count = document.querySelectorAll('.upscaler-checkbox:checked').length;
        statusSelected.textContent = String(count);
    }

    async function getFreshRecaptchaToken() {
        try {
            hookRecaptcha();
            const siteKey = getRecaptchaSiteKey();
            const action = window.__upscale_tokens.recaptchaAction || null;
            console.log(`[Auto-Upscaler] Requesting reCAPTCHA token with siteKey: "${siteKey}", action:`, action);

            const execFn = (window.grecaptcha && window.grecaptcha.enterprise && typeof window.grecaptcha.enterprise.execute === 'function')
                ? window.grecaptcha.enterprise.execute
                : (window.grecaptcha && typeof window.grecaptcha.execute === 'function')
                    ? window.grecaptcha.execute
                    : null;

            if (execFn && siteKey && siteKey !== 'explicit') {
                // Do not force IMAGE_GENERATION action since Google Flow registers reCAPTCHA with action: null
                const freshToken = action ? await execFn(siteKey, {action: action}) : await execFn(siteKey);
                if (freshToken) {
                    console.log(`[Auto-Upscaler] Generated fresh reCAPTCHA token! (length: ${freshToken.length})`);
                    window.__upscale_tokens.recaptchaToken = freshToken;
                    updateStatusUI();
                    return freshToken;
                }
            } else {
                console.warn(`[Auto-Upscaler] Cannot call grecaptcha execute: grecaptcha=${!!window.grecaptcha}, enterprise=${!!window.grecaptcha?.enterprise}, siteKey="${siteKey}"`);
            }
        } catch (e) {
            console.warn("[Auto-Upscaler] Error calling grecaptcha execute:", e);
        }

        if (window.__upscale_tokens.recaptchaToken) {
            console.log("[Auto-Upscaler] Using cached/intercepted reCAPTCHA token (length: " + window.__upscale_tokens.recaptchaToken.length + ")");
            return window.__upscale_tokens.recaptchaToken;
        }

        console.error("[Auto-Upscaler] No valid reCAPTCHA token available!");
        return '';
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
        const img = document.querySelector(`img[data-media-id="${mediaId}"]`) ||
                    document.querySelector(`img[alt="Generated image"][src*="name=${mediaId}"]`) ||
                    document.querySelector(`img[src*="name=${mediaId}"]`) ||
                    document.querySelector(`img[src*="${mediaId}"]`);
        if (!img) return meta;

        // Climb to the batch / row / tile container of the virtualized grid
        const row = img.closest('.batch-container') ||
                    img.closest('.virtual-item-container') ||
                    img.closest('[data-item-index]') ||
                    img.closest('div[data-index]') ||
                    img.closest('flow-grid-tile-container');
        if (!row) return meta;

        // 1. Prompt extraction
        const promptEl = row.querySelector('flow-expandable-prompt .text-part') ||
                         row.querySelector('flow-expandable-prompt .prompt-text') ||
                         row.querySelector('[data-allow-text-selection="true"]');
        if (promptEl) {
            meta.prompt = extractText(promptEl);
        }

        // 2. Created & Model extraction (new DOM: .metadata .metadata-row)
        const metaRows = Array.from(row.querySelectorAll('.metadata .metadata-row, .metadata-row'));
        if (metaRows.length > 0) {
            for (const r of metaRows) {
                const text = r.textContent.trim();
                if (/^Created/i.test(text)) {
                    meta.created = text.replace(/^Created\s*/i, '').trim();
                } else {
                    const spans = Array.from(r.querySelectorAll('span'));
                    for (const s of spans) {
                        const spanText = s.textContent.trim();
                        if (spanText && !/^\d+:\d+$/.test(spanText) && !s.querySelector('mat-icon, i')) {
                            meta.model = spanText.replace(/^[^\p{L}\p{N}]+/u, '').trim();
                            break;
                        }
                    }
                }
            }
        }

        // Old DOM fallback (footer block)
        if (!meta.created || !meta.model) {
            const footer = Array.from(row.querySelectorAll('div')).find(d =>
                d.children.length >= 2 &&
                d.firstElementChild &&
                /^Created/.test(d.firstElementChild.textContent)
            );
            if (footer) {
                const childDivs = Array.from(footer.children);
                if (!meta.created && childDivs[0]) {
                    meta.created = childDivs[0].textContent.trim().replace(/^Created\s*/, '');
                }
                if (!meta.model) {
                    const modelDiv = childDivs.slice(1).find(d => !d.querySelector('i, mat-icon'));
                    if (modelDiv) {
                        meta.model = modelDiv.textContent.replace(/^[^\p{L}\p{N}]+/u, '').trim();
                    }
                }
            }
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

    let reqCounter = 6060000;
    async function sendBatchExecuteUpscale(mediaId, freshRecaptchaToken) {
        const t = window.__upscale_tokens;
        extractTokensFromWiz();

        const bl = t.bl || (window.WIZ_global_data && window.WIZ_global_data.cfb2h) || 'boq_labs-ai-sandbox-frontend_20260922.00_p0';
        const fSid = t.fSid || (window.WIZ_global_data && window.WIZ_global_data.FdrFJe) || '';
        const at = t.at || (window.WIZ_global_data && window.WIZ_global_data.SNlM0e) || '';
        const reqId = ++reqCounter;
        const sourcePath = encodeURIComponent(window.location.pathname) || t.sourcePath;
        const projectId = getProjectId() || t.projectId || '';

        const url = `https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute?rpcids=SPrCad&source-path=${sourcePath}&bl=${encodeURIComponent(bl)}&f.sid=${encodeURIComponent(fSid)}&hl=en&_reqid=${reqId}&rt=c`;

        console.log(`[Auto-Upscaler] Dispatching SPrCad 2K for ${mediaId}:`, {
            url,
            projectId,
            sourcePath,
            fSid,
            bl,
            hasAt: !!at,
            atPreview: at ? at.substring(0, 16) + '...' : 'MISSING',
            tokenLen: freshRecaptchaToken ? freshRecaptchaToken.length : 0
        });

        // Inner payload format for SPrCad:
        // [mediaId, 1, [null, 22, null, null, null, projectId, null, null, null, null, [freshRecaptchaToken, 1]]]
        const rpcInnerData = [
            mediaId,
            1,
            [null, 22, null, null, null, projectId, null, null, null, null, [freshRecaptchaToken, 1]]
        ];
        const rpcEnvelope = [
            [
                ["SPrCad", JSON.stringify(rpcInnerData), null, "generic"]
            ]
        ];

        const body = `f.req=${encodeURIComponent(JSON.stringify(rpcEnvelope))}&at=${encodeURIComponent(at)}&`;

        // Clear used single-use recaptcha token so stale tokens are never replayed
        window.__upscale_tokens.recaptchaToken = '';

        return await window.fetch(url, {
            headers: {
                "accept": "*/*",
                "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
                "x-same-domain": "1"
            },
            body: body,
            method: "POST",
            mode: "cors",
            credentials: "include"
        });
    }

    async function sendBatchExecute1KUrl(mediaId) {
        const t = window.__upscale_tokens;
        extractTokensFromWiz();

        const bl = t.bl || (window.WIZ_global_data && window.WIZ_global_data.cfb2h) || 'boq_labs-ai-sandbox-frontend_20260922.00_p0';
        const fSid = t.fSid || (window.WIZ_global_data && window.WIZ_global_data.FdrFJe) || '';
        const at = t.at || (window.WIZ_global_data && window.WIZ_global_data.SNlM0e) || '';
        const reqId = ++reqCounter;
        const sourcePath = encodeURIComponent(window.location.pathname) || t.sourcePath;

        const url = `https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute?rpcids=as29s&source-path=${sourcePath}&bl=${encodeURIComponent(bl)}&f.sid=${encodeURIComponent(fSid)}&hl=en&_reqid=${reqId}&rt=c`;

        // Payload format for as29s: [mediaId]
        const rpcInnerData = [mediaId];
        const rpcEnvelope = [
            [
                ["as29s", JSON.stringify(rpcInnerData), null, "generic"]
            ]
        ];

        const body = `f.req=${encodeURIComponent(JSON.stringify(rpcEnvelope))}&at=${encodeURIComponent(at)}&`;

        const res = await window.fetch(url, {
            headers: {
                "accept": "*/*",
                "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
                "x-same-domain": "1"
            },
            body: body,
            method: "POST",
            mode: "cors",
            credentials: "include"
        });

        if (!res.ok) {
            throw new Error(`as29s RPC returned HTTP ${res.status}`);
        }

        const text = await res.text();
        const match = text.match(/(https:[\\/]+flow-content\.google[\\/]+image[\\/][a-zA-Z0-9-]+[^"'\s]+)/);
        if (match && match[1]) {
            return match[1]
                .replace(/\\u003d/gi, '=')
                .replace(/\\u0026/gi, '&')
                .replace(/\\u002f/gi, '/')
                .replace(/\\/g, '');
        }

        return null;
    }

    function parseBatchExecuteResponse(responseText) {
        if (!responseText) return null;

        // Strategy 1: Direct regex extraction of JPEG base64 (handles escaped/unescaped quotes and slashes)
        const b64RegexMatch = responseText.match(/(\\?\/9j\\?\/[a-zA-Z0-9+/=_\\]{100,})/);
        if (b64RegexMatch && b64RegexMatch[1]) {
            return b64RegexMatch[1].replace(/\\/g, '');
        }

        // Strategy 2: Extract from SPrCad envelope using regex
        try {
            const sPrCadMatch = responseText.match(/\["wrb\.fr","SPrCad","(.*?)(?<!\\)",/s);
            if (sPrCadMatch) {
                const unescaped = JSON.parse(`"${sPrCadMatch[1]}"`);
                const inner = JSON.parse(unescaped);
                if (Array.isArray(inner)) {
                    for (const item of inner) {
                        if (typeof item === 'string' && item.startsWith('/9j/')) {
                            return item;
                        }
                    }
                }
            }
        } catch (e) {}

        // Strategy 3: Chunk-based parsing
        try {
            const cleaned = responseText.replace(/^\)\]\}'\s*/, '');
            const chunks = cleaned.split(/\n\d+\n/).filter(Boolean);
            for (const chunk of chunks) {
                try {
                    const parsed = JSON.parse(chunk);
                    if (Array.isArray(parsed)) {
                        for (const item of parsed) {
                            if (Array.isArray(item) && item[1] === 'SPrCad' && typeof item[2] === 'string') {
                                const inner = JSON.parse(item[2]);
                                if (Array.isArray(inner)) {
                                    for (const sub of inner) {
                                        if (typeof sub === 'string' && sub.startsWith('/9j/')) return sub;
                                    }
                                }
                            }
                        }
                    }
                } catch (e) {}
            }
        } catch (e) {}

        return null;
    }

    let lastSuccessfulDownload = null; // { mediaId, filename, time }

    function findScrollableContainer() {
        const v = document.querySelector('cdk-virtual-scroll-viewport');
        if (v && v.scrollHeight > v.clientHeight) return v;

        const vItem = document.querySelector('.virtual-item-container');
        if (vItem) {
            let p = vItem.parentElement;
            while (p && p !== document.body) {
                const style = window.getComputedStyle(p);
                const overflow = style.overflowY || style.overflow;
                if (['auto', 'scroll'].includes(overflow) && p.scrollHeight > p.clientHeight) {
                    return p;
                }
                p = p.parentElement;
            }
        }

        const main = document.querySelector('main') || document.querySelector('flow-collection-view');
        if (main && main.scrollHeight > main.clientHeight) return main;

        return document.scrollingElement || document.documentElement || document.body || window;
    }

    async function scanCollectionImages(progressCallback) {
        const scroller = findScrollableContainer();
        const isWindow = (scroller === window || scroller === document.body || scroller === document.documentElement || scroller === document.scrollingElement);

        const getScrollTop = () => isWindow ? (window.pageYOffset || document.documentElement.scrollTop) : scroller.scrollTop;
        const setScrollTop = (val) => {
            if (isWindow) {
                window.scrollTo({ top: val, behavior: 'smooth' });
            } else {
                scroller.scrollTo({ top: val, behavior: 'smooth' });
            }
        };
        const getScrollHeight = () => isWindow ? document.documentElement.scrollHeight : scroller.scrollHeight;
        const getClientHeight = () => isWindow ? window.innerHeight : scroller.clientHeight;

        const collected = new Map(); // mediaId -> { mediaId, prompt, model, created }

        function harvestVisibleTiles() {
            const imgs = document.querySelectorAll('img[data-media-id]');
            imgs.forEach(img => {
                const mid = img.dataset.mediaId;
                if (mid && !collected.has(mid)) {
                    const meta = getImageMetadata(mid);
                    collected.set(mid, { mediaId: mid, ...meta });
                }
            });
        }

        harvestVisibleTiles();

        let lastScrollTop = -1;
        let staleCount = 0;

        while (staleCount < 4) {
            const currentTop = getScrollTop();
            const maxScroll = getScrollHeight() - getClientHeight();

            harvestVisibleTiles();
            if (progressCallback) progressCallback(collected.size);

            if (currentTop >= maxScroll - 5 || Math.abs(currentTop - lastScrollTop) < 2) {
                staleCount++;
            } else {
                staleCount = 0;
            }
            lastScrollTop = currentTop;

            const nextTop = Math.min(currentTop + Math.max(getClientHeight() * 0.75, 400), getScrollHeight());
            setScrollTop(nextTop);
            await sleep(350);
        }

        harvestVisibleTiles();
        setScrollTop(0);
        await sleep(250);

        return Array.from(collected.values());
    }

    async function processMediaList(itemsList, activeBtn) {
        if (!itemsList || itemsList.length === 0) {
            alert("No images to process.");
            return;
        }

        const do2k = cbDownload2k.checked;
        const do1k = cbDownload1k.checked;

        if (!do2k && !do1k) {
            alert("Please enable at least one download option (2K Upscaled or Default 1K).");
            return;
        }

        const t = window.__upscale_tokens;
        extractTokensFromWiz();
        const isAuthReady = !!(t.at || t.authToken);
        if (do2k && !isAuthReady) {
            alert("Cannot upscale yet! Wait for Auth token to turn green (✅).");
            return;
        }

        const originalBtnText = (activeBtn === btnDownloadCollection) ? 'Scan & Download Collection' : 'Upscale / Download Selected';
        const originalBtnColor = (activeBtn === btnDownloadCollection) ? '#4CAF50' : '#2196F3';

        activeBtn.innerText = `Processing 0 / ${itemsList.length}...`;
        activeBtn.style.backgroundColor = '#FFC107';
        activeBtn.disabled = true;

        statusCard.style.backgroundColor = '#1a1a1a';
        statusCard.style.borderColor = '#333';
        statusCard.style.color = '#ccc';
        statusCard.textContent = `Starting batch (${itemsList.length} items)...`;

        const makePayload = (mediaId, freshToken, resolution) => {
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
            try {
                const byteCharacters = atob(base64Data);
                const byteNumbers = new Uint8Array(byteCharacters.length);
                for (let i = 0; i < byteCharacters.length; i++) {
                    byteNumbers[i] = byteCharacters.charCodeAt(i);
                }
                const blob = new Blob([byteNumbers], { type: 'image/jpeg' });
                const blobUrl = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = blobUrl;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                setTimeout(() => window.URL.revokeObjectURL(blobUrl), 15000);
            } catch (e) {
                const a = document.createElement('a');
                a.href = 'data:image/jpeg;base64,' + base64Data;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
            }
        };

        const downloadUrl = async (url, filename) => {
            const opts = url.includes('flow-content.google') ? { credentials: 'omit' } : {};
            const r = await window.fetch(url, opts);
            if (!r.ok) {
                throw new Error(`HTTP ${r.status} fetching ${url}`);
            }
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

        // Writes image-filename.ext.json sidecar using either cached metadata or DOM extraction
        const writeSidecar = async (mediaId, imageFilename, upscaled, cachedMeta) => {
            const meta = (cachedMeta && cachedMeta.prompt) ? cachedMeta : getImageMetadata(mediaId);
            await sleep(400); // avoid the browser's multi-download block
            downloadText(buildJson(meta, upscaled), `${imageFilename}.json`);
        };

        for (let i = 0; i < itemsList.length; i++) {
            const item = itemsList[i];
            const mediaId = item.mediaId;
            const cb = item.checkboxEl || document.querySelector(`.upscaler-checkbox[value="${mediaId}"]`);
            const countLabel = `${i + 1} out of ${itemsList.length}`;
            activeBtn.innerText = `Processing ${countLabel}...`;
            console.log(`[Auto-Upscaler] Processing ${mediaId} (${countLabel})...`);

            let success2k = false;
            let success1k = false;
            let currentDownloadedFilename = '';

            // 1. Process 2K Upscale if requested
            if (do2k) {
                try {
                    const freshToken = await getFreshRecaptchaToken();
                    if (!freshToken) {
                        console.error(`[Auto-Upscaler] Cannot upscale ${mediaId}: no reCAPTCHA token available.`);
                    } else {
                        let base64Data = null;
                        if (window.location.hostname.includes('flow.google.com') || t.at) {
                            console.log(`[Auto-Upscaler] Sending 2K upscale via SPrCad batchexecute for ${mediaId}...`);
                            const res = await sendBatchExecuteUpscale(mediaId, freshToken);
                            if (res && res.ok) {
                                const text = await res.text();
                                base64Data = parseBatchExecuteResponse(text);
                                if (!base64Data) {
                                    console.error(`[Auto-Upscaler] Could not find base64 image in SPrCad response for ${mediaId}:`, text.substring(0, 300));
                                }
                            } else {
                                const errText = res ? await res.text() : 'No response';
                                console.error(`[Auto-Upscaler] 2K Upscale failed for ${mediaId}:`, errText);
                            }
                        } else {
                            const res = await sendRequest(makePayload(mediaId, freshToken, "UPSAMPLE_IMAGE_RESOLUTION_2K"));
                            if (res && res.ok) {
                                const data = await res.json();
                                base64Data = data.encodedImage || null;
                            } else {
                                const errText = res ? await res.text() : 'No response';
                                console.error(`[Auto-Upscaler] 2K Upscale failed for ${mediaId}:`, errText);
                            }
                        }

                        if (base64Data) {
                            console.log(`[Auto-Upscaler] 2K Success for ${mediaId}`);
                            const imageFilename = `GoogleFlow_2K_${mediaId}.jpg`;
                            downloadBase64(base64Data, imageFilename);
                            await writeSidecar(mediaId, imageFilename, true, item.meta);
                            success2k = true;
                            currentDownloadedFilename = imageFilename;
                            lastSuccessfulDownload = {
                                mediaId: mediaId,
                                filename: imageFilename,
                                time: new Date().toLocaleTimeString()
                            };
                        }
                    }
                } catch (err2k) {
                    console.error(`[Auto-Upscaler] 2K Upscale error on ${mediaId}:`, err2k);
                }
            }

            // 2. Process Default 1K if requested
            if (do1k) {
                // If 2K was requested and failed, do not proceed to 1K
                if (do2k && !success2k) {
                    // 2K failed, skip 1K
                } else {
                    try {
                        if (do2k && success2k) {
                            await sleep(400); // brief pause between 2K and 1K downloads for same image
                        }
                        console.log(`[Auto-Upscaler] Downloading 1K default for ${mediaId}...`);
                        const imageFilename = `GoogleFlow_1K_${mediaId}.jpg`;
                        let oneKUrl = (window.__media_to_cdn_url && window.__media_to_cdn_url[mediaId]) || null;

                        // Try getting official signed CDN URL via as29s RPC on flow.google.com
                        if (!oneKUrl && (window.location.hostname.includes('flow.google.com') || t.at)) {
                            try {
                                oneKUrl = await sendBatchExecute1KUrl(mediaId);
                                if (oneKUrl) {
                                    window.__media_to_cdn_url = window.__media_to_cdn_url || {};
                                    window.__media_to_cdn_url[mediaId] = oneKUrl;
                                    console.log(`[Auto-Upscaler] Obtained signed 1K CDN URL via as29s for ${mediaId}`);
                                }
                            } catch (errAs29s) {
                                console.warn(`[Auto-Upscaler] as29s RPC failed for ${mediaId}, trying fallback:`, errAs29s);
                            }
                        }

                        // Fallback: Check DOM img src or legacy URL
                        if (!oneKUrl) {
                            const img = document.querySelector(`img[data-media-id="${mediaId}"]`) ||
                                        document.querySelector(`img[alt="Generated image"][src*="name=${mediaId}"]`) ||
                                        document.querySelector(`img[src*="name=${mediaId}"]`) ||
                                        document.querySelector(`img[src*="${mediaId}"]`);
                            if (img && img.src) {
                                // On flow.google.com, asb URLs have =s<size> (e.g. =s512-rw); replacing with =s0 gives original full-res
                                oneKUrl = img.src.includes('=s') ? img.src.replace(/=s\d+[^/]*$/, '=s0') : img.src;
                            } else {
                                const anyImg = document.querySelector('img[src*="media.getMediaUrlRedirect"]');
                                if (anyImg && anyImg.src) {
                                    try {
                                        const u = new URL(anyImg.src);
                                        oneKUrl = `${u.origin}${u.pathname}?name=${mediaId}`;
                                    } catch (e) {}
                                } else {
                                    oneKUrl = `${window.location.origin}/fx/api/trpc/media.getMediaUrlRedirect?name=${mediaId}`;
                                }
                            }
                        }

                        if (!oneKUrl) {
                            throw new Error(`Could not determine 1K URL for ${mediaId}`);
                        }

                        await downloadUrl(oneKUrl, imageFilename);
                        await writeSidecar(mediaId, imageFilename, false, item.meta);
                        console.log(`[Auto-Upscaler] 1K Success for ${mediaId}`);
                        success1k = true;
                        currentDownloadedFilename = imageFilename;
                        lastSuccessfulDownload = {
                            mediaId: mediaId,
                            filename: imageFilename,
                            time: new Date().toLocaleTimeString()
                        };
                    } catch (err1k) {
                        console.error(`[Auto-Upscaler] 1K Download error on ${mediaId}:`, err1k);
                    }
                }
            }

            // Determine if this item failed
            const failed2k = do2k && !success2k;
            const failed1k = do1k && !success1k;
            const isFailure = failed2k || failed1k;

            const targetOverlay = (cb && cb.parentElement) || document.querySelector(`.upscaler-checkbox[value="${mediaId}"]`)?.parentElement;

            if (isFailure) {
                // Highlight failed tile in red
                if (targetOverlay) {
                    targetOverlay.style.backgroundColor = 'rgba(244, 67, 54, 0.8)';
                }

                // Stop immediately, do NOT wait failure offset, and display last successful info
                const lastInfoText = lastSuccessfulDownload
                    ? `${lastSuccessfulDownload.filename} at ${lastSuccessfulDownload.time}`
                    : 'None';

                statusCard.style.backgroundColor = '#3b1818';
                statusCard.style.borderColor = '#F44336';
                statusCard.style.color = '#ff9999';
                statusCard.textContent = `❌ STOPPED ON FAILURE!\nItem: ${countLabel}\nFailed image: ${mediaId.slice(0, 8)} (${failed2k ? '2K failed' : '1K failed'})\nLast success: ${lastInfoText}`;

                console.error(`[Auto-Upscaler] Auto-stopped on failure for ${mediaId} (${countLabel}). Last successfully downloaded:`, lastSuccessfulDownload);

                activeBtn.innerText = `Stopped: ${countLabel}`;
                activeBtn.style.backgroundColor = '#F44336';
                activeBtn.disabled = false;
                return;
            }

            // On success:
            if (targetOverlay) {
                targetOverlay.style.backgroundColor = 'rgba(76, 175, 80, 0.8)';
            }
            if (cb) {
                cb.checked = false;
                updateSelectedCount();
            }

            const lastSuccessStr = lastSuccessfulDownload ? `${lastSuccessfulDownload.filename} (${lastSuccessfulDownload.time})` : currentDownloadedFilename;
            statusCard.style.backgroundColor = '#1a1a1a';
            statusCard.style.borderColor = '#333';
            statusCard.style.color = '#ccc';
            statusCard.textContent = `Processed: ${countLabel}\nLast downloaded: ${lastSuccessStr}`;

            // Throttle between requests (unless it's the last one)
            if (i < itemsList.length - 1) {
                const sleepTime = computeWaitMs(getSuccessOffset(), SUCCESS_WAIT_RAND_MIN, SUCCESS_WAIT_RAND_MAX);
                console.log(`[Auto-Upscaler] Success throttle — sleeping for ${sleepTime}ms...`);
                await sleep(sleepTime);
            }
        }

        activeBtn.innerText = `Completed (${itemsList.length} out of ${itemsList.length})`;
        activeBtn.style.backgroundColor = '#4CAF50';
        activeBtn.disabled = false;

        const finalInfoText = lastSuccessfulDownload ? `${lastSuccessfulDownload.filename} (${lastSuccessfulDownload.time})` : 'All items processed';
        statusCard.style.backgroundColor = '#1b381b';
        statusCard.style.borderColor = '#4CAF50';
        statusCard.style.color = '#81C784';
        statusCard.textContent = `✅ Completed ${itemsList.length} out of ${itemsList.length} items!\nLast downloaded: ${finalInfoText}`;

        setTimeout(() => {
            activeBtn.innerText = originalBtnText;
            activeBtn.style.backgroundColor = originalBtnColor;
        }, 3500);
    }

    btnUpscale.onclick = async () => {
        const checkedBoxes = Array.from(document.querySelectorAll('.upscaler-checkbox:checked'));
        if (checkedBoxes.length === 0) {
            alert("No images selected.");
            return;
        }

        const itemsList = checkedBoxes.map(cb => ({
            mediaId: cb.value,
            checkboxEl: cb,
            meta: getImageMetadata(cb.value)
        }));

        await processMediaList(itemsList, btnUpscale);
    };

    btnDownloadCollection.onclick = async () => {
        const do2k = cbDownload2k.checked;
        const do1k = cbDownload1k.checked;
        if (!do2k && !do1k) {
            alert("Please enable at least one download option (2K Upscaled or Default 1K).");
            return;
        }

        const t = window.__upscale_tokens;
        extractTokensFromWiz();
        const isAuthReady = !!(t.at || t.authToken);
        if (do2k && !isAuthReady) {
            alert("Cannot upscale yet! Wait for Auth token to turn green (✅).");
            return;
        }

        btnDownloadCollection.disabled = true;
        btnDownloadCollection.style.backgroundColor = '#FFC107';
        btnDownloadCollection.innerText = 'Scanning collection...';

        statusCard.style.backgroundColor = '#1a1a1a';
        statusCard.style.borderColor = '#333';
        statusCard.style.color = '#ccc';
        statusCard.textContent = 'Scanning collection viewport...';

        const collectionItems = await scanCollectionImages((count) => {
            btnDownloadCollection.innerText = `Scanning... (${count} found)`;
            statusCard.textContent = `Scanning collection... ${count} images found`;
        });

        if (collectionItems.length === 0) {
            alert("No images found in current view/collection.");
            btnDownloadCollection.innerText = 'Scan & Download Collection';
            btnDownloadCollection.style.backgroundColor = '#4CAF50';
            btnDownloadCollection.disabled = false;
            statusCard.textContent = 'Ready';
            return;
        }

        console.log(`[Auto-Upscaler] Discovered ${collectionItems.length} images in collection.`);
        statusCard.textContent = `Found ${collectionItems.length} images. Starting download...`;

        const itemsList = collectionItems.map(item => ({
            mediaId: item.mediaId,
            checkboxEl: document.querySelector(`.upscaler-checkbox[value="${item.mediaId}"]`),
            meta: item
        }));

        await processMediaList(itemsList, btnDownloadCollection);
    };

    function updateStatusUI() {
        extractTokensFromWiz();
        const hasAuth = !!(window.__upscale_tokens.at || window.__upscale_tokens.authToken);
        const hasRecaptcha = !!(
            window.__upscale_tokens.recaptchaToken ||
            (window.grecaptcha && window.grecaptcha.enterprise && getRecaptchaSiteKey())
        );

        if (hasAuth) {
            statusAuth.textContent = '✅';
            statusAuth.style.color = '#4CAF50';
        } else {
            statusAuth.textContent = '❌';
            statusAuth.style.color = '#f44336';
        }

        if (hasRecaptcha) {
            statusRecaptcha.textContent = '✅';
            statusRecaptcha.style.color = '#4CAF50';
        } else {
            statusRecaptcha.textContent = '❌';
            statusRecaptcha.style.color = '#f44336';
        }
    }

    let lastCheckedBox = null;

    // 1. Scan DOM for generated images and overlay UI directly on them
    setInterval(() => {
        mountControlPanel(); // keep panel mounted across SPA route changes & hydration
        updateStatusUI();   // keep auth and recaptcha indicators synchronized

        const selector = [
            'img[data-media-id]:not([data-upscaler-injected])',
            'flow-image-tile img:not([data-upscaler-injected])',
            'img[src*="media.getMediaUrlRedirect"]:not([data-upscaler-injected])',
            'img[alt="Tile displaying a user\'s image"]:not([data-upscaler-injected])'
        ].join(', ');

        const images = document.querySelectorAll(selector);
        images.forEach(img => {
            // Only generated images, skip ingredient thumbnails
            const alt = (img.getAttribute('alt') || '').toLowerCase();
            if (alt.includes('ingredient')) return;

            let mediaId = img.dataset.mediaId || img.getAttribute('data-media-id') || '';
            if (!mediaId) {
                const match = img.src.match(/name=([0-9a-f-]+)/i);
                if (match) mediaId = match[1];
            }
            if (!mediaId) {
                const match = img.src.match(/\/([0-9a-f-]{36})/i);
                if (match) mediaId = match[1];
            }
            if (!mediaId) return;

            img.setAttribute('data-upscaler-injected', 'true');

            // Workflow ID = captured from network mapping, or the UUID in the tile's edit link href
            let workflowId = window.__media_to_workflow[mediaId] || '';
            if (!workflowId) {
                const editLink = img.closest('a[href*="/edit/"]');
                if (editLink) {
                    const wm = editLink.getAttribute('href').match(/\/edit\/([0-9a-f-]+)/i);
                    if (wm) workflowId = wm[1];
                }
            }
            if (!workflowId) {
                const elWithWf = img.closest('[data-workflow-id]');
                if (elWithWf) workflowId = elWithWf.getAttribute('data-workflow-id');
            }

            // Target tile container (works for flow-grid-tile-container, flow-tile-container, and legacy <a>)
            let container = img.closest('flow-tile-container') ||
                            img.closest('.container') ||
                            img.closest('flow-image-tile') ||
                            img.closest('a') ||
                            img.parentElement;
            if (window.getComputedStyle(container).position === 'static') {
                container.style.position = 'relative';
            }

            // Create an overlay box
            const overlay = document.createElement('div');
            overlay.className = 'upscaler-tile-overlay';
            Object.assign(overlay.style, {
                position: 'absolute',
                bottom: '6px',
                left: '6px',
                backgroundColor: 'rgba(0, 0, 0, 0.85)',
                color: '#fff',
                padding: '3px 6px',
                fontSize: '11px',
                borderRadius: '4px',
                zIndex: '1000',
                fontFamily: 'monospace',
                display: 'flex',
                alignItems: 'center',
                gap: '5px',
                pointerEvents: 'auto',
                boxShadow: '0 2px 6px rgba(0, 0, 0, 0.5)',
                border: '1px solid rgba(255, 255, 255, 0.2)',
            });

            const idText = document.createElement('span');
            idText.innerText = mediaId.substring(0, 8);

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'upscaler-checkbox';
            checkbox.value = mediaId;
            if (workflowId) checkbox.dataset.workflowId = workflowId;
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

    // 2. Intercept XMLHttpRequest to capture live tokens from Google Flow's native requests
    const originalXhrOpen = XMLHttpRequest.prototype.open;
    const originalXhrSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        this.__flowReqUrl = url;
        this.__flowReqMethod = method;
        return originalXhrOpen.apply(this, [method, url, ...rest]);
    };
    XMLHttpRequest.prototype.send = function(body) {
        try {
            const reqUrl = this.__flowReqUrl ? String(this.__flowReqUrl) : '';
            if (reqUrl.includes('batchexecute')) {
                const u = new URL(reqUrl, window.location.origin);
                const bl = u.searchParams.get('bl');
                if (bl) window.__upscale_tokens.bl = bl;
                const fSid = u.searchParams.get('f.sid');
                if (fSid) window.__upscale_tokens.fSid = fSid;
                const sp = u.searchParams.get('source-path');
                if (sp) window.__upscale_tokens.sourcePath = encodeURIComponent(sp);

                if (typeof body === 'string') {
                    const atMatch = body.match(/at=([^&]+)/);
                    if (atMatch) {
                        window.__upscale_tokens.at = decodeURIComponent(atMatch[1]);
                        updateStatusUI();
                    }
                    const rcMatch = body.match(/0cAF[a-zA-Z0-9_-]+/);
                    if (rcMatch) {
                        console.log('[Auto-Upscaler] Intercepted reCAPTCHA token from XHR body (length: ' + rcMatch[0].length + ')');
                        window.__upscale_tokens.recaptchaToken = rcMatch[0];
                        updateStatusUI();
                    }
                }
            }
        } catch (e) {}
        return originalXhrSend.apply(this, arguments);
    };

    // 3. Intercept fetch to steal tokens and payload
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
            // Intercept BOQ batchexecute tokens on flow.google.com
            if (reqUrl.includes('batchexecute')) {
                try {
                    const u = new URL(reqUrl, window.location.origin);
                    const bl = u.searchParams.get('bl');
                    if (bl) window.__upscale_tokens.bl = bl;
                    const fSid = u.searchParams.get('f.sid');
                    if (fSid) window.__upscale_tokens.fSid = fSid;
                    const sp = u.searchParams.get('source-path');
                    if (sp) window.__upscale_tokens.sourcePath = encodeURIComponent(sp);
                } catch (e) {}

                if (options && typeof options.body === 'string') {
                    // Extract XSRF 'at' token from form-urlencoded body
                    const atMatch = options.body.match(/at=([^&]+)/);
                    if (atMatch) {
                        window.__upscale_tokens.at = decodeURIComponent(atMatch[1]);
                        updateStatusUI();
                    }
                    // Extract enterprise recaptcha token if present in body
                    const rcMatch = options.body.match(/0cAF[a-zA-Z0-9_-]+/);
                    if (rcMatch) {
                        console.log('[Auto-Upscaler] Intercepted reCAPTCHA token from fetch body (length: ' + rcMatch[0].length + ')');
                        window.__upscale_tokens.recaptchaToken = rcMatch[0];
                        updateStatusUI();
                    }
                }
            }

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

        // Intercept response data to map workflowId <-> mediaId for deletion
        try {
            if (response && response.ok && (reqUrl.includes('aisandbox-pa.googleapis.com') || reqUrl.includes('flowWorkflows'))) {
                const clone = response.clone();
                clone.json().then(data => {
                    findWorkflowMappings(data);
                }).catch(() => {});
            }
        } catch (e) {}

        // Sniff as29s responses for flow-content.google 1K image CDN URLs
        try {
            if (response && response.ok && (reqUrl.includes('as29s') || (options && typeof options.body === 'string' && options.body.includes('as29s')))) {
                const clone = response.clone();
                clone.text().then(text => {
                    const match = text.match(/(https:[\\/]+flow-content\.google[\\/]+image[\\/][a-zA-Z0-9-]+[^"'\s]+)/);
                    if (match && match[1]) {
                        const cdnUrl = match[1]
                            .replace(/\\u003d/gi, '=')
                            .replace(/\\u0026/gi, '&')
                            .replace(/\\u002f/gi, '/')
                            .replace(/\\/g, '');
                        const idMatch = cdnUrl.match(/image\/([0-9a-fA-F-]+)/);
                        if (idMatch) {
                            window.__media_to_cdn_url = window.__media_to_cdn_url || {};
                            window.__media_to_cdn_url[idMatch[1]] = cdnUrl;
                            console.log(`[Auto-Upscaler] Intercepted 1K CDN URL for ${idMatch[1]}`);
                        }
                    }
                }).catch(() => {});
            }
        } catch (e) {}

        return response;
    };

})();
