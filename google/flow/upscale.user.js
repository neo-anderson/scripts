// ==UserScript==
// @name        Google Flow Auto-Upscaler
// @namespace   Violentmonkey Scripts
// @match       https://labs.google/fx/tools/flow/project/*
// @grant       none
// @version     1.0
// ==/UserScript==

(function() {
    'use strict';

    // Store tokens intercepted from normal page traffic
    window.__upscale_tokens = {
        authToken: '',
        projectId: '', // Extracted dynamically from URL or fetch
        sessionId: '',
        recaptchaToken: ''
    };

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

            try {
                // 1. Try 2K Upscale
                let res = await sendRequest(makePayload("UPSAMPLE_IMAGE_RESOLUTION_2K"));
                let resolutionUsed = "2K";

                // 2. Fallback to default 1K via redirect if 2K fails AND fallback is checked
                const fallbackChecked = document.getElementById('cb-download-fallback').checked;
                if (!res.ok) {
                    if (fallbackChecked) {
                        console.warn(`[Auto-Upscaler] 2K failed for ${mediaId}, downloading default 1K via redirect...`);
                        await downloadUrl(`https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name=${mediaId}`, `GoogleFlow_1K_${mediaId}.jpg`);
                        console.log(`[Auto-Upscaler] Success (1K Fallback) for ${mediaId}`);
                        cb.parentElement.style.backgroundColor = 'rgba(76, 175, 80, 0.8)'; 
                        cb.checked = false;
                        res = null; // nullify so we skip the JSON block
                    } else {
                        throw new Error(`2K upscale failed and fallback disabled. Server response: ${await res.text()}`);
                    }
                }

                if (res && res.ok) {
                    const data = await res.json();
                    console.log(`[Auto-Upscaler] Success (${resolutionUsed}) for ${mediaId}`);
                    if (data.encodedImage) {
                        downloadBase64(data.encodedImage, `GoogleFlow_${resolutionUsed}_${mediaId}.jpg`);
                    }
                    cb.parentElement.style.backgroundColor = 'rgba(76, 175, 80, 0.8)'; 
                    cb.checked = false; // Uncheck on success
                } else if (res && !res.ok) {
                    const errText = await res.text();
                    console.error(`[Auto-Upscaler] Final failure for ${mediaId}:`, errText);
                    cb.parentElement.style.backgroundColor = 'rgba(244, 67, 54, 0.8)';
                }
            } catch (e) {
                console.error(`[Auto-Upscaler] Error on ${mediaId}:`, e);
                cb.parentElement.style.backgroundColor = 'rgba(244, 67, 54, 0.8)';
            }

            // Sleep between requests (unless it's the last one)
            if (i < checkedBoxes.length - 1) {
                const sleepTime = Math.floor(Math.random() * (5000 - 3000 + 1)) + 3000; // 3 to 5 seconds
                console.log(`[Auto-Upscaler] Sleeping for ${sleepTime}ms...`);
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
            };

            overlay.appendChild(checkbox);
            overlay.appendChild(idText);
            container.appendChild(overlay);
        });
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
            // (Removed mediaId extraction here since the DOM scanner handles it perfectly)

            // Intercept headers (Auth) from ANY request that has it
            if (options && options.headers) {
                // headers might be an object or Headers instance
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

        // Intercept response body to find new media IDs
        if (reqUrl && reqUrl.includes('aisandbox-pa.googleapis.com')) {
            try {
                const clone = response.clone();
                const text = await clone.text();
                
                // (Removed response UUID scanning since DOM scanner handles it)
            } catch (e) {}
        }

        return response;
    };

    // 3. (Mock trigger function, replaced by the alert above)
    // async function triggerUpscale(...) { ... }

})();
