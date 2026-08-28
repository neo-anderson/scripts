// ── Settings ──────────────────────────────────────────────────────────────────
let currentMinLikes = 0;
let currentHideAfterSave = false;
let currentIconMode = true;

function loadSettings() {
  browser.storage.sync.get({ minLikes: 0, hideAfterSave: false, iconMode: true }, (items) => {
    currentMinLikes = items.minLikes;
    currentHideAfterSave = items.hideAfterSave;
    currentIconMode = items.iconMode;
    processPosts();
  });
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync') {
    if (changes.minLikes) currentMinLikes = changes.minLikes.newValue;
    if (changes.hideAfterSave) currentHideAfterSave = changes.hideAfterSave.newValue;
    if (changes.iconMode) currentIconMode = changes.iconMode.newValue;
    processPosts();
  }
});

// ── Icons ─────────────────────────────────────────────────────────────────────
const ICON_HIDE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
  <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/>
  <line x1="1" y1="1" x2="23" y2="23"/>
</svg>`;

const ICON_SAVE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
  <path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z"/>
</svg>`;

const ICON_SAVE_FILLED = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
  <path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z"/>
</svg>`;

// ── CSRF Token ────────────────────────────────────────────────────────────────
function getCsrfToken() {
  const match = document.cookie
    .split('; ')
    .find(c => c.startsWith('csrf_token='));
  return match ? match.split('=')[1] : null;
}

// ── Post ID Extraction ───────────────────────────────────────────────────────
function getPostId(post) {
  const directId = post.getAttribute('id') ||
                   post.getAttribute('fullname') ||
                   post.getAttribute('post-id') ||
                   post.getAttribute('data-fullname');
  if (directId && directId.startsWith('t3_')) return directId;

  const link = post.querySelector('a[data-ks-id]');
  if (link) {
    const ksId = link.getAttribute('data-ks-id');
    if (ksId && ksId.startsWith('t3_')) return ksId;
  }

  const permalink = post.getAttribute('permalink') || post.getAttribute('content-href');
  if (permalink) {
    const match = permalink.match(/comments\/([a-z0-9]+)/);
    if (match) return `t3_${match[1]}`;
  }

  return null;
}

// ── GraphQL API Calls ────────────────────────────────────────────────────────
async function hidePost(postId) {
  const csrf = getCsrfToken();
  if (!csrf) throw new Error('CSRF token not found in cookies');

  const res = await fetch('https://www.reddit.com/svc/shreddit/graphql', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      operation: 'UpdatePostHideState',
      variables: { input: { postId, hideState: 'HIDDEN' } },
      csrf_token: csrf,
    }),
  });

  if (!res.ok) throw new Error(`Hide failed: ${res.status}`);
  const data = await res.json();
  if (data.errors && data.errors.length > 0) throw new Error(data.errors[0].message);
  return data;
}

async function savePost(postId) {
  const csrf = getCsrfToken();
  if (!csrf) throw new Error('CSRF token not found in cookies');

  const res = await fetch('https://www.reddit.com/svc/shreddit/graphql', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      operation: 'UpdatePostSaveState',
      variables: { input: { postId, saveState: 'SAVED' } },
      csrf_token: csrf,
    }),
  });

  if (!res.ok) throw new Error(`Save failed: ${res.status}`);
  const data = await res.json();
  if (data.errors && data.errors.length > 0) throw new Error(data.errors[0].message);
  return data;
}

// ── Fade out helper ───────────────────────────────────────────────────────────
function fadeOutPost(post) {
  post.style.transition = 'opacity 0.3s ease, max-height 0.3s ease';
  post.style.opacity = '0';
  post.style.maxHeight = '0';
  post.style.overflow = 'hidden';
  setTimeout(() => { post.style.display = 'none'; }, 300);
}

// ── Button Injection ─────────────────────────────────────────────────────────
function injectOverlayButtons(post, isSavedPage) {
  const iconMode = currentIconMode;
  const container = document.createElement('div');
  container.className = 'rf-bottom-container';

  // ── Hide button ──
  const hideBtn = document.createElement('button');
  hideBtn.className = `rf-btn rf-hide-btn${iconMode ? ' rf-icon-btn' : ''}`;

  if (iconMode) {
    hideBtn.innerHTML = ICON_HIDE;
    hideBtn.title = 'Hide post';
    hideBtn.setAttribute('aria-label', 'Hide post');
  } else {
    hideBtn.textContent = 'Hide';
  }

  hideBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();

    const postId = getPostId(post);
    if (!postId) { console.error('RedditFilter: Could not extract post ID'); return; }

    hideBtn.innerHTML = '⟳';
    hideBtn.disabled = true;

    try {
      await hidePost(postId);
      fadeOutPost(post);
    } catch (err) {
      console.error('RedditFilter: Hide failed', err);
      if (iconMode) hideBtn.innerHTML = ICON_HIDE;
      else hideBtn.textContent = 'Hide';
      hideBtn.disabled = false;
    }
  });
  container.appendChild(hideBtn);

  // ── Save button (not on the saved page) ──
  if (!isSavedPage) {
    const saveBtn = document.createElement('button');
    saveBtn.className = `rf-btn rf-save-btn${iconMode ? ' rf-icon-btn' : ''}`;

    if (iconMode) {
      saveBtn.innerHTML = ICON_SAVE;
      saveBtn.title = 'Save post';
      saveBtn.setAttribute('aria-label', 'Save post');
    } else {
      saveBtn.textContent = 'Save';
    }

    saveBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();

      const postId = getPostId(post);
      if (!postId) { console.error('RedditFilter: Could not extract post ID'); return; }

      saveBtn.innerHTML = '⟳';
      saveBtn.disabled = true;

      try {
        await savePost(postId);
        if (iconMode) {
          saveBtn.innerHTML = ICON_SAVE_FILLED;
        } else {
          saveBtn.textContent = '✓ Saved';
        }
        saveBtn.classList.add('rf-btn-success');

        if (currentHideAfterSave) {
          await hidePost(postId);
          fadeOutPost(post);
        }
      } catch (err) {
        console.error('RedditFilter: Save failed', err);
        if (iconMode) saveBtn.innerHTML = ICON_SAVE;
        else saveBtn.textContent = 'Save';
        saveBtn.disabled = false;
      }
    });
    container.appendChild(saveBtn);
  }

  post.appendChild(container);
}

// ── Process Posts ─────────────────────────────────────────────────────────────
function processPosts() {
  const isSavedPage = window.location.pathname.includes('/saved');
  const posts = document.querySelectorAll('shreddit-post');

  posts.forEach(post => {
    // Hide promoted posts (ads)
    if (post.hasAttribute('promoted')) {
      post.style.display = 'none';
      return;
    }

    // Min-likes filtering (skip on saved page)
    if (!isSavedPage) {
      const scoreAttr = post.getAttribute('score');
      if (scoreAttr !== null) {
        const score = parseInt(scoreAttr, 10);
        if (!isNaN(score) && score < currentMinLikes) {
          post.style.display = 'none';
          return;
        } else {
          post.style.display = '';
        }
      }
    }

    // Inject buttons once per post
    if (!post.dataset.rfProcessed) {
      post.dataset.rfProcessed = 'true';
      injectOverlayButtons(post, isSavedPage);
    }
  });
}

// ── DOM Observer for Infinite Scroll ─────────────────────────────────────────
const observer = new MutationObserver((mutations) => {
  for (const mut of mutations) {
    if (mut.addedNodes.length > 0) {
      processPosts();
      break;
    }
  }
});

observer.observe(document.body, { childList: true, subtree: true });

// ── Init ─────────────────────────────────────────────────────────────────────
loadSettings();
