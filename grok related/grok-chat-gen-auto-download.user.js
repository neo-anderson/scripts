// ==UserScript==
// @name         Grok Chat Auto Download
// @namespace    http://tampermonkey.net/
// @version      0.1
// @description  Automatically download generated images from Grok chat
// @author       You
// @match        https://grok.com/*
// @match        https://x.ai/*
// @grant        GM_download
// ==/UserScript==

(function() {
    'use strict';

    const downloaded = new Set();

    function processImages() {
        const images = document.querySelectorAll('img');
        
        images.forEach(img => {
            const src = img.src;
            if (!src) return;
            
            // Debug log for first few images to verify we are seeing them
            if (downloaded.size === 0 && Math.random() < 0.05) {
                console.log('[Grok Auto DL] Seeing image:', src);
            }

            if (downloaded.has(src)) return;

            // Match URL pattern: https://assets.grok.com/users/.../generated/{postId}/image.jpg
            // We need to capture {postId}
            const match = src.match(/https:\/\/assets\.grok\.com\/users\/[^/]+\/generated\/([^/]+)\/image\.jpg/);
            
            if (match) {
                const postId = match[1];

                // Skip if postId ends with -part-0
                if (postId.endsWith('-part-0')) {
                    console.log(`[Grok Auto DL] Skipping part-0: ${postId}`);
                    downloaded.add(src); // Mark as seen so we don't log again
                    return;
                }

                const filename = `${postId}.jpg`;
                
                // Mark as processed to avoid duplicates
                downloaded.add(src);

                console.log(`[Grok Auto DL] Found match! Downloading ${filename}`);
                
                GM_download({
                    url: src,
                    name: filename,
                    saveAs: false,
                    onload: () => console.log(`[Grok Auto DL] Success: ${filename}`),
                    onerror: (err) => console.error('[Grok Auto DL] Error:', err)
                });
            }
        });
    }

    // Observe DOM changes to catch new images as they generate
    const observer = new MutationObserver((mutations) => {
        processImages();
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true
    });

    // Initial check
    console.log('[Grok Auto DL] Script started. Waiting for images...');
    processImages();
})();
