// ==UserScript==
// @name         Grok - All Posts
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  List all Grok imagine posts
// @author       You
// @match        https://grok.com/*
// @match        https://x.ai/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_download
// @connect      *
// ==/UserScript==

(function () {
    'use strict';

    // --- Styles ---
    GM_addStyle(`
        #grok-list::-webkit-scrollbar {
            width: 8px;
        }
        #grok-list::-webkit-scrollbar-track {
            background: rgba(255, 255, 255, 0.05);
            border-radius: 4px;
        }
        #grok-list::-webkit-scrollbar-thumb {
            background: rgba(255, 255, 255, 0.2);
            border-radius: 4px;
        }
        #grok-list::-webkit-scrollbar-thumb:hover {
            background: rgba(255, 255, 255, 0.3);
        }
    `);

    // --- Config ---
    const DELAYS = {
        PAGINATION: { MIN: 200, MAX: 500 }, // Between pages when fetching lists
        UPSCALE: { MIN: 1500, MAX: 2500 },   // Between video upscale requests
        DOWNLOAD: { MIN: 1000, MAX: 2500 },  // Between downloading posts
        DELETE: { MIN: 300, MAX: 800 }       // Between delete requests
    };

    // --- State ---
    let capturedHeaders = GM_getValue('grokHeaders', {});
    let posts = [];
    let modal = null;
    let selectedPosts = new Set();
    let lastCheckedId = null;
    let isDeleting = false;
    let stopDeleting = false;
    let renderedCount = 0;
    const BATCH_SIZE = 50;

    // --- Header Capture ---
    const originalFetch = window.fetch;
    window.fetch = async function (input, init) {
        const url = typeof input === 'string' ? input : (input instanceof Request ? input.url : '');

        if (url && (url.includes('grok.com') || url.includes('x.ai'))) {
            if (init && init.headers) {
                let newHeaders = {};
                if (init.headers instanceof Headers) {
                    init.headers.forEach((value, key) => {
                        newHeaders[key.toLowerCase()] = value;
                    });
                } else if (typeof init.headers === 'object') {
                    Object.keys(init.headers).forEach(key => {
                        newHeaders[key.toLowerCase()] = init.headers[key];
                    });
                }

                // Merge and save
                capturedHeaders = { ...capturedHeaders, ...newHeaders };
                GM_setValue('grokHeaders', capturedHeaders);
            }
        }
        return originalFetch.apply(this, arguments);
    };

    const originalXHR = window.XMLHttpRequest;
    window.XMLHttpRequest = function () {
        const xhr = new originalXHR();
        const originalOpen = xhr.open;
        const originalSetRequestHeader = xhr.setRequestHeader;

        let url = '';
        let headers = {};

        xhr.open = function (method, u) {
            url = u;
            return originalOpen.apply(this, arguments);
        };

        xhr.setRequestHeader = function (header, value) {
            if (url && (url.includes('grok.com') || url.includes('x.ai'))) {
                headers[header.toLowerCase()] = value;
                capturedHeaders = { ...capturedHeaders, ...headers };
                GM_setValue('grokHeaders', capturedHeaders);
            }
            return originalSetRequestHeader.apply(this, arguments);
        };

        return xhr;
    };

    // --- UI Creation ---
    function createButton(text, bgColor) {
        const btn = document.createElement('button');
        btn.textContent = text;
        btn.style.cssText = `
          background: ${bgColor}cc;
          backdrop-filter: blur(10px);
          color: white;
          border: 1px solid rgba(255, 255, 255, 0.1);
          padding: 10px 20px;
          border-radius: 9999px;
          cursor: pointer;
          font-weight: 700;
          font-size: 14px;
          transition: all 0.2s;
        `;
        btn.onmouseover = () => {
            btn.style.opacity = '1';
            btn.style.transform = 'translateY(-1px)';
            btn.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.3)';
        };
        btn.onmouseout = () => {
            btn.style.opacity = '0.9';
            btn.style.transform = 'translateY(0)';
            btn.style.boxShadow = 'none';
        };
        btn.onmousedown = () => btn.style.transform = 'translateY(0) scale(0.98)';
        btn.onmouseup = () => btn.style.transform = 'translateY(-1px)';
        return btn;
    }

    function createModal() {
        modal = document.createElement('div');
        modal.style.cssText = `
          display: none;
          position: fixed;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          background-color: rgba(0, 0, 0, 0.8);
          z-index: 100000;
          justify-content: center;
          align-items: center;
          backdrop-filter: blur(5px);
          -webkit-backdrop-filter: blur(5px);
        `;

        const modalContent = document.createElement('div');
        modalContent.style.cssText = `
          background: rgba(20, 20, 20, 0.9);
          backdrop-filter: blur(20px);
          -webkit-backdrop-filter: blur(20px);
          color: #fff;
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 16px;
          padding: 24px;
          width: 90%;
          height: 90%;
          display: flex;
          flex-direction: column;
          box-shadow: 0 20px 60px rgba(0, 0, 0, 0.8);
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        `;

        // Header
        const header = document.createElement('div');
        header.style.cssText = `
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 20px;
          padding-bottom: 16px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        `;

        const title = document.createElement('h2');
        title.textContent = 'Grok - All Posts';
        title.style.margin = '0';
        title.style.fontSize = '24px';
        title.style.fontWeight = '800';

        const closeBtn = document.createElement('button');
        closeBtn.innerHTML = '&times;';
        closeBtn.style.cssText = `
          background: none;
          border: none;
          color: #888;
          font-size: 32px;
          cursor: pointer;
          padding: 0;
          line-height: 1;
          width: 40px;
          height: 40px;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 50%;
          transition: background-color 0.2s;
        `;
        closeBtn.onmouseover = () => closeBtn.style.backgroundColor = 'rgba(255,255,255,0.1)';
        closeBtn.onmouseout = () => closeBtn.style.backgroundColor = 'transparent';
        closeBtn.addEventListener('click', () => { modal.style.display = 'none'; });

        header.appendChild(title);
        header.appendChild(closeBtn);

        // Controls
        const controls = document.createElement('div');
        controls.style.cssText = `
          display: flex;
          gap: 12px;
          margin-bottom: 20px;
          align-items: center;
          flex-wrap: wrap;
        `;

        const fetchBtn = createButton('Refresh Posts', '#1DA1F2');
        fetchBtn.onclick = fetchPosts;

        const deleteAllBtn = createButton('Delete All', '#e0245e');
        deleteAllBtn.onclick = deleteAllPosts;

        const deleteSelectedBtn = createButton('Delete Selected (0)', '#e0245e');
        deleteSelectedBtn.id = 'grok-delete-selected';
        deleteSelectedBtn.style.display = 'none';
        deleteSelectedBtn.onclick = deleteSelectedPosts;

        const downloadSelectedBtn = createButton('Download Selected (0)', '#17bf63');
        downloadSelectedBtn.id = 'grok-download-selected';
        downloadSelectedBtn.style.display = 'none';
        downloadSelectedBtn.onclick = downloadSelectedPosts;

        const clearSelectionBtn = createButton('Clear Selection', '#8899a6');
        clearSelectionBtn.id = 'grok-clear-selection';
        clearSelectionBtn.style.display = 'none';
        clearSelectionBtn.onclick = clearSelection;

        const viewRawBtn = createButton('View Full Payload', '#8899a6');
        viewRawBtn.id = 'grok-view-raw';
        viewRawBtn.style.display = 'none';
        viewRawBtn.onclick = viewRawData;

        const upscaleBtn = createButton('Upscale Favorites', '#794bc4');
        upscaleBtn.onclick = upscaleFavorites;

        const stopBtn = createButton('Stop', '#8899a6');
        stopBtn.id = 'grok-stop-delete';
        stopBtn.style.display = 'none';
        stopBtn.onclick = () => { stopDeleting = true; };

        // Quick Links
        const linksContainer = document.createElement('div');
        linksContainer.style.cssText = `
            display: flex;
            gap: 8px;
            margin-left: auto;
        `;

        const filesLink = createButton('Files', '#17bf63');
        filesLink.onclick = () => window.open('https://grok.com/files', '_blank');

        const shareLink = createButton('Shared', '#794bc4');
        shareLink.onclick = () => window.open('https://grok.com/share-links', '_blank');

        linksContainer.appendChild(filesLink);
        linksContainer.appendChild(shareLink);

        controls.appendChild(fetchBtn);
        controls.appendChild(deleteAllBtn);
        controls.appendChild(deleteSelectedBtn);
        controls.appendChild(downloadSelectedBtn);
        controls.appendChild(clearSelectionBtn);
        controls.appendChild(viewRawBtn);
        controls.appendChild(upscaleBtn);
        controls.appendChild(stopBtn);
        controls.appendChild(linksContainer);

        // Status
        const statusDiv = document.createElement('div');
        statusDiv.id = 'grok-status';
        statusDiv.style.cssText = `
          margin-bottom: 16px;
          font-size: 14px;
          color: #8899a6;
          min-height: 20px;
          font-weight: 500;
        `;

        // List Container
        const listContainer = document.createElement('div');
        listContainer.id = 'grok-list';
        listContainer.style.cssText = `
          flex: 1;
          overflow-y: auto;
          padding: 20px;
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
          gap: 24px;
          padding-bottom: 60px;
        `;

        listContainer.addEventListener('scroll', () => {
            if (listContainer.scrollTop + listContainer.clientHeight >= listContainer.scrollHeight - 1000) {
                renderNextBatch();
            }
        });

        modalContent.appendChild(header);
        modalContent.appendChild(controls);
        modalContent.appendChild(statusDiv);
        modalContent.appendChild(listContainer);
        modal.appendChild(modalContent);
        document.body.appendChild(modal);
    }

    function createFloatingButton() {
        const btn = document.createElement('button');
        btn.textContent = 'Load All Grok Imagine Posts';
        btn.style.cssText = `
            position: fixed;
            bottom: 20px;
            right: 20px;
            z-index: 99999;
            padding: 12px 24px;
            background: #1DA1F2;
            color: white;
            border: none;
            border-radius: 24px;
            font-weight: bold;
            cursor: pointer;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        `;
        btn.onclick = () => {
            if (!modal) createModal();
            modal.style.display = 'flex';
            fetchPosts();
        };
        document.body.appendChild(btn);
    }

    // --- Logic ---
    function randomDelay(min, max) {
        return new Promise(resolve => setTimeout(resolve, min + Math.random() * (max - min)));
    }

    function updateStatus(msg, color = '#8899a6') {
        const el = document.getElementById('grok-status');
        if (el) {
            el.textContent = msg;
            el.style.color = color;
        }
    }

    function formatCreatedAt(dateInput) {
        if (!dateInput) return '';
        try {
            let date;

            // Handle string timestamp (e.g. "1766316738542")
            if (typeof dateInput === 'string' && /^\d+$/.test(dateInput)) {
                dateInput = parseInt(dateInput, 10);
            }

            // Handle numeric timestamp (seconds or ms)
            if (typeof dateInput === 'number') {
                // If less than year 1973 in ms, assume seconds
                date = new Date(dateInput < 100000000000 ? dateInput * 1000 : dateInput);
            } else {
                date = new Date(dateInput);
            }

            // Check for invalid date
            if (isNaN(date.getTime())) {
                console.warn('GrokPosts: Invalid date input:', dateInput, typeof dateInput);
                return 'Date Error';
            }

            return date.toLocaleDateString(undefined, {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
            });
        } catch (e) {
            console.error('Date formatting error:', e);
            return 'Date Error';
        }
    }

    function getHeaders() {
        const headers = { ...capturedHeaders } || {};

        // Remove headers that might cause issues if reused
        delete headers['content-length'];

        // Generate new request ID
        if (typeof crypto !== 'undefined' && crypto.randomUUID) {
            headers['x-xai-request-id'] = crypto.randomUUID();
        } else {
            headers['x-xai-request-id'] = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
                var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
                return v.toString(16);
            });
        }

        return headers;
    }

    async function fetchPosts() {
        updateStatus('Getting authentication...', '#8899a6');

        // Use captured headers or empty object (relying on cookies)
        const headers = getHeaders();

        updateStatus('Fetching posts...', '#1DA1F2');
        const listContainer = document.getElementById('grok-list');
        if (listContainer) listContainer.innerHTML = '';

        try {
            const response = await fetch("https://grok.com/rest/media/post/list-shared-posts", {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    ...headers
                },
                body: JSON.stringify({ limit: 40000 }),
                credentials: "include"
            });

            if (!response.ok) throw new Error(`Failed to fetch: ${response.status}`);

            const data = await response.json();
            posts = Array.isArray(data) ? data : (data.items || data.posts || []);

            updateStatus(`Found ${posts.length} posts.`);
            renderList();
        } catch (e) {
            console.error(e);
            updateStatus('Error fetching posts. Please browse Grok to capture session first.', '#e0245e');
        }
    }

    function renderList() {
        const listContainer = document.getElementById('grok-list');
        if (!listContainer) return;
        listContainer.innerHTML = '';

        // Reset selection on re-render
        selectedPosts.clear();
        updateDeleteSelectedButton();

        renderedCount = 0;
        renderNextBatch();
    }

    function renderNextBatch() {
        const listContainer = document.getElementById('grok-list');
        if (!listContainer) return;

        const batch = posts.slice(renderedCount, renderedCount + BATCH_SIZE);
        if (batch.length === 0) return;

        const fragment = document.createDocumentFragment();

        batch.forEach(post => {
            const postId = post.postId || post.id;
            if (!postId) return;

            const card = document.createElement('div');
            // Use padding-top hack for robust square aspect ratio
            card.style.cssText = `
                position: relative;
                width: 100%;
                padding-top: 100%;
                border-radius: 12px;
                overflow: hidden;
                transition: transform 0.2s, box-shadow 0.2s, border-color 0.2s;
                border: 1px solid rgba(255, 255, 255, 0.1);
                background-color: rgba(17, 17, 17, 0.8);
                backdrop-filter: blur(10px);
                box-sizing: border-box;
            `;
            card.dataset.id = postId;

            card.onmouseenter = () => {
                card.style.transform = 'translateY(-4px) scale(1.02)';
                card.style.zIndex = '10';
                card.style.borderColor = 'rgba(29, 161, 242, 0.6)';
                card.style.boxShadow = '0 8px 24px rgba(0, 0, 0, 0.4)';
            };
            card.onmouseleave = () => {
                card.style.transform = 'translateY(0) scale(1)';
                card.style.zIndex = '1';
                card.style.borderColor = 'rgba(255, 255, 255, 0.1)';
                card.style.boxShadow = 'none';
            };

            const link = document.createElement('a');
            link.href = `https://grok.com/imagine/post/${postId}`;
            link.target = '_blank';
            link.style.cssText = `
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                text-decoration: none;
                display: flex;
                flex-direction: column;
            `;

            // Checkbox
            const checkbox = document.createElement('div');
            checkbox.className = 'grok-checkbox';
            checkbox.style.cssText = `
                position: absolute;
                top: 10px;
                left: 10px;
                width: 24px;
                height: 24px;
                border: 2px solid rgba(255, 255, 255, 0.5);
                border-radius: 6px;
                background: rgba(0, 0, 0, 0.5);
                z-index: 10;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                transition: all 0.2s;
            `;

            checkbox.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                toggleSelection(postId, checkbox, e.shiftKey);
            };

            card.appendChild(checkbox);

            // Image
            if (post.thumbnailImageUrl) {
                const img = document.createElement('img');
                img.src = post.thumbnailImageUrl;
                img.style.cssText = `
                  width: 100%;
                  height: 100%;
                  object-fit: cover;
                  display: block;
                `;
                link.appendChild(img);
            } else {
                const noImg = document.createElement('div');
                noImg.textContent = 'No Image';
                noImg.style.cssText = `
                  width: 100%;
                  height: 100%;
                  display: flex;
                  align-items: center;
                  justify-content: center;
                  color: #555;
                  font-size: 12px;
                `;
                link.appendChild(noImg);
            }

            // Overlay
            const overlay = document.createElement('div');
            overlay.style.cssText = `
                position: absolute;
                bottom: 0;
                left: 0;
                right: 0;
                background: linear-gradient(to top, rgba(0,0,0,0.95), rgba(0,0,0,0));
                backdrop-filter: blur(10px);
                padding: 20px 12px 12px;
                pointer-events: none;
            `;

            // Video Indicator (based on URL pattern)
            if (post.thumbnailImageUrl && (post.thumbnailImageUrl.includes('share-videos') || post.thumbnailImageUrl.endsWith('preview_image.jpg'))) {
                const videoIcon = document.createElement('div');
                videoIcon.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="white" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>';
                videoIcon.style.cssText = `
                    position: absolute;
                    top: 50%;
                    left: 50%;
                    transform: translate(-50%, -50%);
                    width: 40px;
                    height: 40px;
                    background: rgba(0, 0, 0, 0.5);
                    border-radius: 50%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    border: 2px solid rgba(255,255,255,0.8);
                    z-index: 5;
                    pointer-events: none;
                `;
                link.appendChild(videoIcon);
            }

            const dateText = document.createElement('div');
            // Try common date fields
            const dateVal = post.createdAt || post.created_at || post.timestamp || post.date || post.created;
            dateText.textContent = formatCreatedAt(dateVal);
            dateText.style.cssText = `
                color: rgba(255, 255, 255, 0.7);
                font-size: 11px;
                margin-bottom: 6px;
                text-shadow: 0 1px 2px rgba(0,0,0,0.8);
                font-weight: 500;
            `;
            overlay.appendChild(dateText);

            const promptText = document.createElement('div');
            promptText.textContent = post.prompt || 'No Prompt';
            promptText.style.cssText = `
                color: white;
                font-size: 13px;
                line-height: 1.4;
                display: -webkit-box;
                -webkit-line-clamp: 3;
                -webkit-box-orient: vertical;
                overflow: hidden;
                text-shadow: 0 1px 2px rgba(0,0,0,0.8);
            `;
            overlay.appendChild(promptText);
            link.appendChild(overlay);

            card.appendChild(link);
            fragment.appendChild(card);
        });

        listContainer.appendChild(fragment);
        renderedCount += batch.length;
    }

    function toggleSelection(id, checkbox, isShift) {
        if (isShift && lastCheckedId) {
            let start = false;
            let end = false;
            let range = [];

            for (let post of posts) {
                const pid = post.postId || post.id;
                if (pid === id || pid === lastCheckedId) {
                    if (!start) start = true;
                    else end = true;
                }
                if (start) range.push(pid);
                if (end) break;
            }

            const shouldSelect = !selectedPosts.has(id);
            range.forEach(pid => {
                if (shouldSelect) selectedPosts.add(pid);
                else selectedPosts.delete(pid);

                // Update UI for range
                const card = document.querySelector(`div[data-id="${pid}"]`);
                if (card) {
                    const cb = card.querySelector('.grok-checkbox');
                    if (cb) updateCheckboxStyle(cb, shouldSelect);
                }
            });
        } else {
            if (selectedPosts.has(id)) {
                selectedPosts.delete(id);
                updateCheckboxStyle(checkbox, false);
            } else {
                selectedPosts.add(id);
                updateCheckboxStyle(checkbox, true);
            }
        }

        lastCheckedId = id;
        updateDeleteSelectedButton();
    }

    function updateCheckboxStyle(checkbox, isSelected) {
        checkbox.style.background = isSelected ? '#1DA1F2' : 'rgba(0, 0, 0, 0.5)';
        checkbox.style.borderColor = isSelected ? '#1DA1F2' : 'rgba(255, 255, 255, 0.5)';
        checkbox.innerHTML = isSelected ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>' : '';
    }

    function updateDeleteSelectedButton() {
        const delBtn = document.getElementById('grok-delete-selected');
        const downBtn = document.getElementById('grok-download-selected');
        const rawBtn = document.getElementById('grok-view-raw');
        const clearBtn = document.getElementById('grok-clear-selection');

        const count = selectedPosts.size;

        if (delBtn) {
            if (count > 0) {
                delBtn.style.display = 'block';
                delBtn.textContent = `Delete Selected (${count})`;
            } else {
                delBtn.style.display = 'none';
            }
        }

        if (downBtn) {
            if (count > 0) {
                downBtn.style.display = 'block';
                downBtn.textContent = `Download Selected (${count})`;
            } else {
                downBtn.style.display = 'none';
            }
        }

        if (clearBtn) {
            clearBtn.style.display = count > 0 ? 'block' : 'none';
        }

        if (rawBtn) {
            if (count === 1) {
                rawBtn.style.display = 'block';
            } else {
                rawBtn.style.display = 'none';
            }
        }
    }

    function clearSelection() {
        selectedPosts.forEach(id => {
            const card = document.querySelector(`div[data-id="${id}"]`);
            if (card) {
                const cb = card.querySelector('.grok-checkbox');
                if (cb) updateCheckboxStyle(cb, false);
            }
        });
        selectedPosts.clear();
        updateDeleteSelectedButton();
    }

    async function viewRawData() {
        if (selectedPosts.size !== 1) return;
        const id = Array.from(selectedPosts)[0];

        const btn = document.getElementById('grok-view-raw');
        const originalText = btn ? btn.textContent : 'View Full Payload';
        if (btn) btn.textContent = 'Fetching...';

        try {
            const headers = getHeaders();
            const response = await fetch("https://grok.com/rest/media/post/get", {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    ...headers
                },
                body: JSON.stringify({ id: id }),
                credentials: "include"
            });

            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();

            const win = window.open('', '_blank', 'width=600,height=800');
            if (win) {
                win.document.write(`
                    <html>
                    <head>
                        <title>Raw Post Data ${id}</title>
                        <style>
                            body { background: #111; color: #eee; font-family: monospace; padding: 20px; }
                            pre { white-space: pre-wrap; word-wrap: break-word; }
                        </style>
                    </head>
                    <body>
                        <h3>Post ID: ${id}</h3>
                        <pre>${JSON.stringify(data, null, 2)}</pre>
                    </body>
                    </html>
                `);
            }
        } catch (e) {
            console.error(e);
            alert('Error fetching post data: ' + e.message);
        } finally {
            if (btn) btn.textContent = originalText;
        }
    }

    async function upscaleVideo(videoId) {
        const headers = getHeaders();
        try {
            const response = await fetch("https://grok.com/rest/media/video/upscale", {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    ...headers
                },
                body: JSON.stringify({ videoId: videoId }),
                credentials: "include"
            });

            if (response.ok) {
                const data = await response.json();
                return data.hdMediaUrl || null;
            }
            return null;
        } catch (e) {
            console.error(e);
            return null;
        }
    }

    async function fetchLikedPostsForUpscale() {
        updateStatus('Fetching favorite posts...', '#8899a6');
        const headers = getHeaders();
        let allPosts = [];
        let cursor = undefined;
        let hasMore = true;

        try {
            while (hasMore) {
                if (stopDeleting) break;

                const body = {
                    limit: 40,
                    filter: { source: "MEDIA_POST_SOURCE_LIKED" }
                };
                if (cursor) body.cursor = cursor;

                const response = await fetch("https://grok.com/rest/media/post/list", {
                    method: "POST",
                    headers: {
                        "content-type": "application/json",
                        ...headers
                    },
                    body: JSON.stringify(body),
                    credentials: "include"
                });

                if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);

                const data = await response.json();
                const posts = data.posts || [];
                allPosts = [...allPosts, ...posts];

                updateStatus(`Fetched ${allPosts.length} favorites...`);

                if (data.nextCursor) {
                    cursor = data.nextCursor;
                    await randomDelay(DELAYS.PAGINATION.MIN, DELAYS.PAGINATION.MAX);
                } else {
                    hasMore = false;
                }
            }
        } catch (e) {
            console.error(e);
            updateStatus('Error fetching favorites.', '#e0245e');
            return [];
        }
        return allPosts;
    }

    async function upscaleFavorites() {
        if (!confirm('This will fetch all your liked posts and upscale the videos if needed. Continue?')) return;

        stopDeleting = false;
        const stopBtn = document.getElementById('grok-stop-delete');
        if (stopBtn) stopBtn.style.display = 'block';

        const posts = await fetchLikedPostsForUpscale();
        if (stopDeleting) {
            updateStatus('Stopped.');
            if (stopBtn) stopBtn.style.display = 'none';
            return;
        }

        const videoPosts = posts.filter(p => p.mediaType === 'MEDIA_POST_TYPE_VIDEO' || (p.videos && p.videos.length > 0));
        updateStatus(`Found ${videoPosts.length} videos to check.`);

        let upscaledCount = 0;
        let skippedCount = 0;
        let errorCount = 0;

        for (let i = 0; i < videoPosts.length; i++) {
            if (stopDeleting) break;

            const post = videoPosts[i];
            const videoObj = (post.videos && post.videos.length > 0) ? post.videos[0] : null;
            const videoId = videoObj ? videoObj.id : (post.postId || post.id);

            // Check if already upscaled (check root and inside videos array)
            const isUpscaled = post.hdMediaUrl || (videoObj && videoObj.hdMediaUrl);

            updateStatus(`[${i + 1}/${videoPosts.length}] Upscaled: ${upscaledCount}, Skipped: ${skippedCount} - Checking ${videoId}...`);

            if (isUpscaled) {
                skippedCount++;
            } else {
                updateStatus(`[${i + 1}/${videoPosts.length}] Upscaled: ${upscaledCount}, Skipped: ${skippedCount} - Upscaling ${videoId}...`);
                const hdUrl = await upscaleVideo(videoId);
                if (hdUrl) {
                    upscaledCount++;
                } else {
                    errorCount++;
                }
                await randomDelay(DELAYS.UPSCALE.MIN, DELAYS.UPSCALE.MAX);
            }
        }

        if (stopBtn) stopBtn.style.display = 'none';
        updateStatus(`Finished. Upscaled: ${upscaledCount}, Skipped: ${skippedCount}, Errors: ${errorCount}`);
    }

    // Helper to fetch full post data
    async function getPostData(id) {
        const headers = getHeaders();
        try {
            const response = await fetch("https://grok.com/rest/media/post/get", {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    ...headers
                },
                body: JSON.stringify({ id: id }),
                credentials: "include"
            });
            if (!response.ok) return null;
            return await response.json();
        } catch (e) {
            console.error(e);
            return null;
        }
    }

    function downloadFile(url, filename) {
        return new Promise((resolve) => {
            // Skip GM_download for blob/data URLs as they are local and don't need CORS handling
            // This fixes "Check Internet Connection" errors with blobs
            if (url.startsWith('blob:') || url.startsWith('data:')) {
                downloadViaLink(url, filename);
                resolve();
                return;
            }

            if (typeof GM_download === 'function') {
                GM_download({
                    url: url,
                    name: filename,
                    saveAs: false,
                    onload: () => {
                        console.log(`GM_download success: ${filename}`);
                        resolve();
                    },
                    onerror: (err) => {
                        console.error('GM_download failed:', err);
                        downloadViaLink(url, filename);
                        resolve();
                    }
                });
            } else {
                downloadViaLink(url, filename);
                resolve();
            }
        });
    }

    async function downloadSelectedPosts() {
        console.log('Download initiated');
        if (!confirm(`Download ${selectedPosts.size} items (including JSON, Images, and Videos)?`)) return;

        const ids = Array.from(selectedPosts);
        let processed = 0;
        const total = ids.length;

        for (const id of ids) {
            updateStatus(`Processing ${processed + 1}/${total}: Fetching details for ${id}...`);

            // 1. Fetch full post details
            const fullResponse = await getPostData(id);
            if (!fullResponse) {
                console.error(`Failed to fetch details for ${id}`);
                updateStatus(`Failed to fetch details for ${id}`, '#e0245e');
                continue;
            }

            // Normalize data source (handle wrapped 'post' object)
            const postData = fullResponse.post || fullResponse;
            const originalId = postData.originalPostId;

            // 2. Download JSON
            try {
                const jsonBlob = new Blob([JSON.stringify(fullResponse, null, 2)], { type: "application/json" });
                const jsonUrl = URL.createObjectURL(jsonBlob);
                const jsonFilename = originalId ? `${originalId}_${id}.json` : `${id}.json`;
                await downloadFile(jsonUrl, jsonFilename);
                // Revoke after delay to ensure link click processed
                setTimeout(() => URL.revokeObjectURL(jsonUrl), 10000);
            } catch (e) {
                console.error('Error downloading JSON', e);
            }

            // 3. Process Images
            if (postData.images && Array.isArray(postData.images) && postData.images.length > 0) {
                for (let i = 0; i < postData.images.length; i++) {
                    const img = postData.images[i];
                    const imgId = img.id || 'unknown';
                    if (img.mediaUrl) {
                        updateStatus(`Processing ${processed + 1}/${total}: Downloading image ${imgId}...`);
                        // Guess extension
                        let ext = 'png';
                        const match = img.mediaUrl.match(/\.(\w{3,4})(?:\?|$)/);
                        if (match) ext = match[1];

                        const filename = originalId ? `${originalId}_${imgId}.${ext}` : `${id}_${imgId}.${ext}`;
                        await downloadFile(img.mediaUrl, filename);
                    }
                }
            } else if (postData.mediaUrl) {
                // Fallback if images array is missing
                updateStatus(`Processing ${processed + 1}/${total}: Downloading image for ${id}...`);
                let ext = 'png';
                const match = postData.mediaUrl.match(/\.(\w{3,4})(?:\?|$)/);
                if (match) ext = match[1];

                const filename = originalId ? `${originalId}_${id}.${ext}` : `${id}.${ext}`;
                await downloadFile(postData.mediaUrl, filename);
            }

            // 4. Process Videos
            if (postData.videos && Array.isArray(postData.videos)) {
                for (let i = 0; i < postData.videos.length; i++) {
                    const video = postData.videos[i];
                    const videoId = video.id || 'unknown';
                    let videoUrl = video.hdMediaUrl;

                    if (!videoUrl) {
                        updateStatus(`Processing ${processed + 1}/${total}: Upscaling video ${videoId}...`);
                        videoUrl = await upscaleVideo(videoId);
                    }

                    if (videoUrl) {
                        updateStatus(`Processing ${processed + 1}/${total}: Downloading video ${videoId}...`);
                        const filename = originalId ? `${originalId}_${videoId}.mp4` : `${id}_${videoId}.mp4`;
                        await downloadFile(videoUrl, filename);
                    } else {
                        console.warn(`Could not get HD URL for video ${videoId}`);
                    }
                }
            }

            processed++;
            await randomDelay(DELAYS.DOWNLOAD.MIN, DELAYS.DOWNLOAD.MAX);
        }
        updateStatus(`Finished downloading ${processed} items.`);
    }


    function downloadViaLink(url, filename) {
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.target = '_blank';
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
            document.body.removeChild(a);
        }, 100);
    }

    async function deletePost(id) {
        const headers = getHeaders();
        try {
            const response = await fetch("https://grok.com/rest/media/post/delete", {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    ...headers
                },
                body: JSON.stringify({ id: id }),
                credentials: "include"
            });
            return response.ok;
        } catch (e) {
            console.error(e);
            return false;
        }
    }

    async function deleteSelectedPosts() {
        if (!confirm(`Are you sure you want to delete ${selectedPosts.size} posts?`)) return;

        const ids = Array.from(selectedPosts);
        updateStatus(`Deleting ${ids.length} posts...`);

        let deleted = 0;
        for (const id of ids) {
            const success = await deletePost(id);
            if (success) {
                deleted++;
                // Remove from UI
                const card = document.querySelector(`div[data-id="${id}"]`);
                if (card) card.remove();
                selectedPosts.delete(id);
                updateDeleteSelectedButton();
            }
        }

        updateStatus(`Deleted ${deleted} posts.`);
        // Remove deleted from posts array
        posts = posts.filter(p => !ids.includes(p.postId || p.id));
    }

    async function deleteAllPosts() {
        if (!confirm('Are you sure you want to delete ALL displayed posts? This cannot be undone.')) return;

        isDeleting = true;
        stopDeleting = false;

        const stopBtn = document.getElementById('grok-stop-delete');
        if (stopBtn) stopBtn.style.display = 'block';

        const postsToDelete = [...posts];
        let deletedCount = 0;

        for (let i = 0; i < postsToDelete.length; i++) {
            if (stopDeleting) break;

            const post = postsToDelete[i];
            const id = post.postId || post.id;

            updateStatus(`Deleting ${i + 1}/${postsToDelete.length}...`);

            const success = await deletePost(id);
            if (success) {
                deletedCount++;
                const card = document.querySelector(`div[data-id="${id}"]`);
                if (card) card.remove();
            }

            // Small delay to be nice to the server
            await randomDelay(DELAYS.DELETE.MIN, DELAYS.DELETE.MAX);
        }

        isDeleting = false;
        if (stopBtn) stopBtn.style.display = 'none';
        updateStatus(stopDeleting ? `Stopped. Deleted ${deletedCount} posts.` : `Finished. Deleted ${deletedCount} posts.`);

        // Refresh list to be sure
        if (!stopDeleting) fetchPosts();
    }

    // Initialize
    createFloatingButton();

})();
