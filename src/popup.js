// ============================================================
// Manhwa Tracker — Popup Script
// Handles popup rendering, theme persistence, imports/exports,
// and source/history interactions for tracked entries.
// ============================================================

// View state for the popup session. The list itself is always rehydrated
// from extension storage rather than treated as an in-memory source of truth.
let allManhwa = [];
let searchQuery = "";
let sortType = "recent";
let isDark = false;

// Cached DOM references used across renders.
const app = document.getElementById('app');
const listWrap = document.getElementById('listWrap');
const emptyState = document.getElementById('emptyState');

const panels = {
  reading: document.getElementById('readingPanel'),
  settings: document.getElementById('settingsPanel')
};

// ------------------------------------------------------------
// Theme and Panel State
// ------------------------------------------------------------

function setTheme(dark) {
  isDark = dark;
  app.classList.toggle('dark', dark);
  app.classList.toggle('light', !dark);
  document.getElementById('lightOpt').classList.toggle('selected', !dark);
  document.getElementById('darkOpt').classList.toggle('selected', dark);
  
  // Persist theme alongside sort preference so the popup restores cleanly.
  chrome.runtime.sendMessage({ 
    type: "SAVE_SETTINGS", 
    settings: { isDark: dark, sortType }
  });
}

function showPanel(id) {
  Object.values(panels).forEach(p => p.classList.remove('active'));
  panels[id].classList.add('active');
  
  if (id === 'settings') {
    document.getElementById('settingsToggle').style.display = 'none';
    document.getElementById('headerBackBtn').style.display = 'flex';
  } else {
    document.getElementById('settingsToggle').style.display = 'flex';
    document.getElementById('headerBackBtn').style.display = 'none';
  }
}

// ------------------------------------------------------------
// Display Helpers
// ------------------------------------------------------------

function timeAgo(ts) {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  if (h < 24) return `${h}h ago`;
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function normalizeSite(site) {
  if (!site) return "web";
  return site
    .replace("www.", "")
    .replace(/\.(com|org|net|me|to)$/, "")
    .replace(/-/g, "")
    .slice(0, 15);
}

// Builds the source list shown in each card. The current site/URL is always
// treated as primary even if older mirrored sources are also stored.
function getSourceList(entry) {
  const primary = entry.site && entry.lastURL
    ? [{ site: entry.site, url: entry.lastURL, lastSeenAt: entry.updatedAt, isPrimary: true }]
    : [];
  const seen = new Set(primary.map(source => source.site));
  const extras = (entry.sources || []).filter(source => {
    if (!source || !source.site || !source.url || seen.has(source.site)) return false;
    seen.add(source.site);
    return true;
  }).map(source => ({ ...source, isPrimary: false }));

  return [...primary, ...extras].slice(0, 5);
}

// ------------------------------------------------------------
// Data Loading and Rendering
// ------------------------------------------------------------

function calculateStreak(daily) {
  if (!daily) return 0;
  let streak = 0;

  // Allow a 2-hour grace window so reading just before midnight still counts
  // after midnight when the popup is opened.
  const now = new Date(Date.now() + 2 * 60 * 60 * 1000);
  let date = now;
  while (true) {
    const key = date.toISOString().slice(0, 10);
    if (!daily[key]) break;
    streak++;
    date = new Date(date);
    date.setDate(date.getDate() - 1);
  }
  return streak;
}

// Loads settings, analytics, and list data together so the popup can render
// a consistent snapshot without partial UI updates.
function loadData() {
  Promise.all([
    new Promise(resolve => chrome.runtime.sendMessage({ type: "GET_SETTINGS" }, resolve)),
    new Promise(resolve => chrome.runtime.sendMessage({ type: "GET_ANALYTICS" }, resolve)),
    new Promise(resolve => chrome.runtime.sendMessage({ type: "GET_LIST" }, resolve))
  ]).then(([settingsRes, analyticsRes, listRes]) => {
    const settings = settingsRes?.settings;
    if (settings) {
      if (settings.isDark !== undefined) setTheme(settings.isDark);
      if (settings.sortType) {
        sortType = settings.sortType;
        const sel = document.getElementById('sortSelect');
        if (sel) sel.value = sortType;
      }
    }

    const analytics = analyticsRes?.analytics;
    if (analytics) {
      const totCh = document.getElementById('totalChaptersRead');
      const streak = document.getElementById('readingStreak');
      if (totCh) totCh.textContent = analytics.totalChapters || 0;
      if (streak) streak.textContent = calculateStreak(analytics.daily);
    }

    allManhwa = listRes?.list || [];
    render();
  });
}

// Full rerender is inexpensive at this scale and keeps the popup logic
// straightforward compared with incremental DOM patching.
function render() {
  let list = [...allManhwa];
  
  if (searchQuery) {
    list = list.filter(m => m.title.toLowerCase().includes(searchQuery.toLowerCase()));
  }
  
  if (sortType === 'chapter') {
    list.sort((a, b) => (b.lastChapter || 0) - (a.lastChapter || 0));
  } else {
    list.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  const totCnt = document.getElementById('totalCount');
  const todCnt = document.getElementById('todayCount');
  if (totCnt) totCnt.textContent = allManhwa.length;
  const todayThreshold = Date.now() - 86400000;
  if (todCnt) todCnt.textContent = allManhwa.filter(m => m.updatedAt > todayThreshold).length;

  listWrap.querySelectorAll('.card').forEach(c => c.remove());
  
  if (list.length === 0) {
    emptyState.style.display = 'flex';
    if (searchQuery) {
      emptyState.querySelector('.empty-ornament').textContent = "🔍";
      emptyState.querySelector('.empty-sub').textContent = `No results for "${searchQuery}"`;
    } else {
      emptyState.querySelector('.empty-ornament').textContent = "✦ ✦ ✦";
      emptyState.querySelector('.empty-sub').innerHTML = "Nothing tracked yet.<br>Visit any chapter to start.";
    }
    return;
  }
  
  emptyState.style.display = 'none';
  
  list.forEach((m) => {
    const card = document.createElement('div');
    card.className = 'card';
    const sources = getSourceList(m);
    const extraSources = Math.max(sources.length - 1, 0);
    
    const isRecent = Date.now() - m.updatedAt < 1000 * 60 * 60;
    const btnLabel = isRecent ? `CONTINUE CH. ${m.lastChapter}` : `RESUME CH. ${m.lastChapter}`;

    card.innerHTML = `
      ${m.cover ? `<img class="card-cover" src="${m.cover}" alt="" loading="lazy">` : ''}
      <div class="card-body">
        <div class="card-header">
          <div class="card-title-text" title="${m.title}">${m.title}</div>
          <button class="card-del" data-id="${m.id}">✕</button>
        </div>
        <div class="card-meta">
          <span class="pill pill-ch">Ch. ${m.lastChapter}</span>
          <span class="pill pill-site">${normalizeSite(sources[0]?.site || m.site)}</span>
          ${extraSources > 0 ? `
          <button class="source-toggle" type="button">
            <span>+${extraSources} source${extraSources > 1 ? 's' : ''}</span>
            <span class="source-arrow">▾</span>
          </button>` : ''}
          <span class="pill pill-time">${timeAgo(m.updatedAt)}</span>
        </div>
        <div class="card-actions">
          <button class="continue-btn" title="Continue reading from last page">
            <span>${btnLabel}</span>
          </button>
          <button class="next-btn" ${m.nextURL ? '' : 'disabled'} title="${m.nextURL ? 'Go to next chapter' : 'Next chapter not detected'}">
            <span>Next</span><span>→</span>
          </button>
        </div>
        ${extraSources > 0 ? `
        <div class="card-sources">
          ${sources.map((source, index) => `
            <div class="source-row">
              <span class="source-name">${normalizeSite(source.site)}${source.isPrimary ? ' (current)' : ''}</span>
              <button class="source-link" data-url="${source.url}" type="button">${index === 0 ? 'Continue' : 'Open'}</button>
            </div>
          `).join('')}
        </div>` : ''}
        ${(m.history && m.history.length > 0) ? `
        <button class="history-toggle">
          <span>History (${m.history.length})</span><span class="hist-arrow">▾</span>
        </button>
        <div class="card-history">
          ${m.history.map(h => `
            <div class="history-row">
              <span>Ch. ${h.chapter} – ${timeAgo(h.ts)}</span>
              <a href="${h.url}" title="Open chapter" target="_blank">↗</a>
            </div>
          `).join('')}
        </div>` : ''}
      </div>
    `;

    // Attach error handler via JS — inline onerror attributes are CSP-blocked.
    const coverImg = card.querySelector('.card-cover');
    if (coverImg) {
      coverImg.addEventListener('error', () => { coverImg.style.display = 'none'; });
    }

    card.querySelector('.card-del').addEventListener('click', (e) => {
      e.stopPropagation();
      chrome.runtime.sendMessage({ type: "DELETE_ENTRY", id: m.id }, loadData);
    });

    card.querySelector('.continue-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      chrome.tabs.create({ url: m.lastURL });
    });

    card.querySelector('.next-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      if (m.nextURL) {
        chrome.tabs.create({ url: m.nextURL });
      }
    });

    // Alternate sources stay tucked behind a small toggle so the main list
    // remains compact while still exposing mirrors when needed.
    const sourceToggle = card.querySelector('.source-toggle');
    if (sourceToggle) {
      sourceToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        const panel = card.querySelector('.card-sources');
        const arrow = sourceToggle.querySelector('.source-arrow');
        const isOpen = panel.classList.toggle('open');
        if (arrow) arrow.textContent = isOpen ? '▴' : '▾';
      });
    }

    card.querySelectorAll('.source-link').forEach(button => {
      button.addEventListener('click', (e) => {
        e.stopPropagation();
        const url = button.dataset.url;
        if (url) chrome.tabs.create({ url });
      });
    });

    // History remains local UI state only; it is not persisted separately.
    const histToggle = card.querySelector('.history-toggle');
    if (histToggle) {
      histToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        const panel = card.querySelector('.card-history');
        const arrow = histToggle.querySelector('.hist-arrow');
        const isOpen = panel.classList.toggle('open');
        if (arrow) arrow.textContent = isOpen ? '▴' : '▾';
      });

      card.querySelectorAll('.history-row a').forEach(a => {
        a.addEventListener('click', (e) => e.stopPropagation());
      });
    }

    // Card click is the broad "resume reading" affordance; nested controls opt out.
    card.addEventListener('click', (e) => {
      if (
        e.target.closest('.card-del') ||
        e.target.closest('.continue-btn') ||
        e.target.closest('.source-toggle') ||
        e.target.closest('.card-sources') ||
        e.target.closest('.history-toggle') ||
        e.target.closest('.card-history')
      ) return;
      chrome.tabs.create({ url: m.lastURL });
    });

    listWrap.appendChild(card);
  });
}

// ------------------------------------------------------------
// UI Event Wiring
// ------------------------------------------------------------

document.getElementById('themeToggle').addEventListener('click', () => setTheme(!isDark));
document.getElementById('lightOpt').addEventListener('click', () => setTheme(false));
document.getElementById('darkOpt').addEventListener('click', () => setTheme(true));

document.getElementById('settingsToggle').addEventListener('click', () => showPanel('settings'));
document.getElementById('headerBackBtn').addEventListener('click', () => showPanel('reading'));
document.getElementById('logoHome').addEventListener('click', () => showPanel('reading'));

document.getElementById('searchInput').addEventListener('input', (e) => {
  searchQuery = e.target.value;
  render();
});

document.getElementById('sortSelect').addEventListener('change', (e) => {
  sortType = e.target.value;
  chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", settings: { isDark, sortType } });
  render();
});

// Export writes the current list snapshot, which mirrors storage because
// `loadData()` is called after every mutating action.
document.getElementById('exportBtn').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: "EXPORT_LIST" }, ({ list }) => {
    const blob = new Blob([JSON.stringify(list, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'manhwa-log.json';
    a.click();
  });
});

document.getElementById('importBtn').addEventListener('click', () => {
  document.getElementById('importFile').click();
});

// Import delegates merge behavior to the background worker so title matching
// and deduplication rules stay defined in one place.
document.getElementById('importFile').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const statusEl = document.getElementById('importStatus');

  const reader = new FileReader();
  reader.onload = (event) => {
    try {
      const list = JSON.parse(event.target.result);
      if (!Array.isArray(list)) throw new Error("Invalid format");
      
      chrome.runtime.sendMessage({ type: "IMPORT_LIST", list }, (res) => {
        if (res.success) {
          loadData();
          if (statusEl) {
            statusEl.innerHTML = "&#10003; Import successful &ndash; list merged.";
            statusEl.style.color = "var(--accent, #e06040)";
            setTimeout(() => { statusEl.textContent = ""; }, 3000);
          }
        }
      });
    } catch (err) {
      if (statusEl) {
        statusEl.innerHTML = "&#10007; Import failed: " + err.message;
        statusEl.style.color = "#c0392b";
        setTimeout(() => { statusEl.textContent = ""; }, 4000);
      }
    }
  };
  reader.readAsText(file);
  e.target.value = '';
});

// ------------------------------------------------------------
// Storage Meter
// ------------------------------------------------------------

function updateStorageMeter() {
  if (typeof chrome === 'undefined' || !chrome.storage) return;
  chrome.storage.local.getBytesInUse(null, (bytes) => {
    const MB = bytes / 1_000_000;
    const remaining = 10 - MB;
    const pct = Math.min((bytes / 10_000_000) * 100, 100);

    const usedEl  = document.getElementById('storageUsed');
    const totalEl = document.getElementById('storageTotal');
    const bar     = document.getElementById('storageBar');
    const pctEl   = document.getElementById('storagePct');

    if (usedEl)  usedEl.innerHTML  = MB.toFixed(2) + '<span>MB used</span>';
    if (totalEl) totalEl.textContent = remaining.toFixed(2) + ' MB remaining';
    if (pctEl)   pctEl.textContent  = pct.toFixed(1) + '% of 10 MB';
    if (bar) {
      bar.style.width = pct + '%';
      bar.classList.remove('warn', 'critical');
      if (pct > 90) bar.classList.add('critical');
      else if (pct > 70) bar.classList.add('warn');
    }
  });
}

// ------------------------------------------------------------
// Initialization
// ------------------------------------------------------------

document.getElementById('settingsToggle')?.addEventListener('click', updateStorageMeter);
loadData();
updateStorageMeter();
