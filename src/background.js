// ============================================================
// Manhwa Tracker — Background Service Worker
// Handles storage, deduplication, analytics, and navigation relays.
// ============================================================

const STORAGE_KEY = "manhwa_tracker_list";
const SETTINGS_KEY = "manhwa_tracker_settings";
const ANALYTICS_KEY = "manhwa_log_analytics";

// ------------------------------------------------------------
// Storage Helpers
// ------------------------------------------------------------

async function getList() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return result[STORAGE_KEY] || [];
}

async function saveList(list) {
  await chrome.storage.local.set({ [STORAGE_KEY]: list });
}

async function getSettings() {
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  return result[SETTINGS_KEY] || {};
}

// Canonical titles are used only for matching and analytics keys. The
// original stored title remains user-facing and is left untouched elsewhere.
function canonicalTitle(title) {
  if (!title) return "";
  return title
    .toLowerCase()
    .replace(/\b(chapter|ch|episode|ep)\.?\s*\d+(\.\d+)?\b/g, "")
    .replace(/\b\d+(\.\d+)?\b$/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ------------------------------------------------------------
// Fuzzy Title Matching
// ------------------------------------------------------------

/**
 * Standard dynamic-programming Levenshtein distance.
 * Operates on already-canonicalized strings for efficiency.
 */
function levenshteinDistance(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => {
    const row = new Array(n + 1).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }
  return dp[m][n];
}

/**
 * Fast-path: exact canonical match.
 * Slow-path: Levenshtein <= 3 on canonical strings.
 * Threshold 3 is intentional — keeps similar-but-different titles separate.
 * Returns the matched list item, or null.
 */
function fuzzyTitleMatch(newTitle, list) {
  const target = canonicalTitle(newTitle);

  const exact = list.find(item => canonicalTitle(item.title) === target);
  if (exact) return exact;

  const THRESHOLD = 3;
  let bestMatch = null;
  let bestDist = Infinity;

  for (const item of list) {
    const dist = levenshteinDistance(target, canonicalTitle(item.title));
    if (dist <= THRESHOLD && dist < bestDist) {
      bestDist = dist;
      bestMatch = item;
    }
  }

  return bestMatch;
}

// ------------------------------------------------------------
// Analytics
// ------------------------------------------------------------

async function getAnalytics() {
  const res = await chrome.storage.local.get(ANALYTICS_KEY);
  return res[ANALYTICS_KEY] || { totalChapters: 0, daily: {}, titles: {} };
}

// Analytics intentionally count chapter advances, not every revisit, so the
// popup stats represent reading progress instead of refresh noise.
async function trackAnalytics(data) {
  const analytics = await getAnalytics();
  const today = new Date().toISOString().slice(0, 10);

  analytics.totalChapters += 1;
  analytics.daily[today] = (analytics.daily[today] || 0) + 1;

  const titleKey = canonicalTitle(data.title);
  analytics.titles[titleKey] = (analytics.titles[titleKey] || 0) + 1;

  // Prune daily keys older than 90 days to prevent unbounded growth.
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 90);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  for (const key of Object.keys(analytics.daily)) {
    if (key < cutoffStr) delete analytics.daily[key];
  }

  await chrome.storage.local.set({ [ANALYTICS_KEY]: analytics });
}

// ------------------------------------------------------------
// Progress Update Pipeline
// ------------------------------------------------------------

async function updateProgress(data) {
  let list = await getList();
  let cleanTitle = data.title;

  // Guard against incomplete detections before touching persisted state.
  if (!cleanTitle || cleanTitle.toLowerCase() === "read") return;
  if (!data.chapter || isNaN(data.chapter) || data.chapter <= 0) return;

  const matched = fuzzyTitleMatch(cleanTitle, list);
  const idx = matched ? list.indexOf(matched) : -1;

  const updatedEntry = {
    id: idx >= 0 ? list[idx].id : Date.now().toString(),
    title: idx >= 0 ? list[idx].title : cleanTitle,
    status: idx >= 0 ? (list[idx].status || "reading") : "reading",
    pinned: idx >= 0 ? (list[idx].pinned || false) : false,
    lastChapter: data.chapter,
    lastURL: data.url,
    nextURL: data.nextURL || null,
    site: data.site,
    // Prefer a freshly-detected cover; fall back to the previously stored one
    // so a thumbnail is never lost once captured. Null means no cover found.
    cover: data.cover || (idx >= 0 ? (list[idx].cover || null) : null),
    updatedAt: data.timestamp,
    addedAt: idx >= 0 ? list[idx].addedAt : data.timestamp,
    sources: idx >= 0 ? (list[idx].sources || []) : []
  };

  // Keep the current site first so the popup can show a stable primary source
  // while still preserving alternate mirrors for the same series.
  const priorSources = updatedEntry.sources.filter(source => source && source.site && source.url);
  updatedEntry.sources = [
    { site: data.site, url: data.url, lastSeenAt: data.timestamp },
    ...priorSources.filter(source => source.site !== data.site)
  ].slice(0, 5);

  let prevChapter = null;

  if (idx >= 0) {
    const existing = list[idx];
    prevChapter = existing.lastChapter;
    if (data.chapter === existing.lastChapter && data.url === existing.lastURL) {
      // Always proceed if we now have a cover that wasn't stored before, or if it changed.
      // (This fixes the case where an old, incorrect og:image logo was previously saved).
      const coverUpdated = data.cover && data.cover !== existing.cover;
      if (!coverUpdated) return;
    }


    list[idx] = updatedEntry;
  } else {
    list.unshift(updatedEntry);
  }

  // Retry once before surfacing a badge failure. Storage writes are small,
  // but a brief retry is cheap and helps absorb transient extension issues.
  try {
    await saveList(list);
  } catch {
    await new Promise(r => setTimeout(r, 500));
    try {
      await saveList(list);
    } catch {
      chrome.action.setBadgeText({ text: "\u2717" });
      chrome.action.setBadgeBackgroundColor({ color: "#c84b2f" });
      return;
    }
  }

  const isNewChapter = prevChapter === null || data.chapter !== prevChapter;
  if (isNewChapter) await trackAnalytics(data);

  chrome.action.setBadgeText({ text: "\u2713" });
  chrome.action.setBadgeBackgroundColor({ color: "#e06040" });
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), 2000);

  await checkStorageQuota();

  return updatedEntry;
}

// ------------------------------------------------------------
// Storage Quota Guard
// ------------------------------------------------------------

async function pruneScrollKeys() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith("scroll::"));
  if (keys.length > 300) {
    await chrome.storage.local.remove(keys.slice(0, keys.length - 300));
  }
}

async function checkStorageQuota() {
  await pruneScrollKeys();
  const bytesInUse = await chrome.storage.local.getBytesInUse(null);
  if (bytesInUse > 8_000_000) {
    chrome.action.setBadgeText({ text: "!" });
    chrome.action.setBadgeBackgroundColor({ color: "#e0a040" });
  }
}

// ------------------------------------------------------------
// Tab Navigation Relay
// ------------------------------------------------------------

// The content script cannot always observe SPA URL changes by itself, so the
// background worker relays browser-level updates back into the active tab.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) {
    chrome.tabs.sendMessage(tabId, { type: "URL_CHANGED", url: changeInfo.url }).catch(() => {});
  }
});

// ------------------------------------------------------------
// Runtime Message Handling
// ------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "GET_MANTA_DATA") {
    if (!sender.tab || !sender.tab.id) {
      sendResponse(null);
      return true;
    }
    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      func: () => window.MantaDataLayer,
      world: "MAIN"
    }).then(res => {
      sendResponse(res[0]?.result || null);
    }).catch(() => {
      sendResponse(null);
    });
    return true;
  }

  // Detection reports from the content script funnel through one update path
  // so deduplication, analytics, and badges stay in sync.
  if (message.type === "CHAPTER_DETECTED") {
    updateProgress(message.data).then(entry => {
      sendResponse({ success: true, entry });
    }).catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }

  if (message.type === "GET_LIST") {
    getList().then(list => sendResponse({ list }));
    return true;
  }

  if (message.type === "DELETE_ENTRY") {
    getList().then(async list => {
      const filtered = list.filter(item => item.id !== message.id);
      await saveList(filtered);
      sendResponse({ success: true });
    });
    return true;
  }

  if (message.type === "GET_SETTINGS") {
    getSettings().then(settings => sendResponse({ settings }));
    return true;
  }

  if (message.type === "SAVE_SETTINGS") {
    chrome.storage.local.set({ [SETTINGS_KEY]: message.settings }).then(() => {
      sendResponse({ success: true });
    });
    return true;
  }

  // Manual add reuses the same pipeline as automatic detection for consistency.
  if (message.type === "MANUAL_ADD") {
    updateProgress(message.data).then(entry => {
      sendResponse({ success: true, entry });
    });
    return true;
  }

  if (message.type === "EXPORT_LIST") {
    getList().then(list => {
      sendResponse({ list });
    });
    return true;
  }

  // Import merges by fuzzy title so mirror-site titles can collapse into the
  // same entry instead of duplicating the reading list.
  if (message.type === "IMPORT_LIST") {
    getList().then(async existingList => {
      const newList = message.list;
      const merged = [...existingList];

      newList.forEach(newItem => {
        const existingMatch = fuzzyTitleMatch(newItem.title, merged);
        const idx = existingMatch ? merged.indexOf(existingMatch) : -1;

        if (idx >= 0) {
          if (newItem.lastChapter > merged[idx].lastChapter) {
            merged[idx] = { ...newItem };
          }
        } else {
          merged.unshift(newItem);
        }
      });

      merged.sort((a, b) => b.updatedAt - a.updatedAt);
      await saveList(merged);
      sendResponse({ success: true });
    });
    return true;
  }

  if (message.type === "GET_ANALYTICS") {
    getAnalytics().then(analytics => sendResponse({ analytics }));
    return true;
  }

  if (message.type === "UPDATE_ENTRY_FIELD") {
    getList().then(async list => {
      const idx = list.findIndex(item => item.id === message.id);
      if (idx >= 0) {
        list[idx] = { ...list[idx], [message.field]: message.value };
        await saveList(list);
      }
      sendResponse({ success: true });
    });
    return true;
  }

  if (message.type === "SEARCH_SITES") {
    const q = (message.query || "").trim();
    if (!q) { sendResponse({ results: [] }); return true; }
    searchAcrossSites(q).then(results => sendResponse({ results }));
    return true;
  }
});

// ------------------------------------------------------------
// Cross-site search
// ------------------------------------------------------------

/** Normalise a title for fuzzy comparison */
function normTitle(t) {
  return t.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Merge results from multiple adapters, deduping by normalised title */
async function searchAcrossSites(query) {
  const adapters = [
    searchWebtoon,
    searchToonily,
    searchManhwaTop,
    searchManhuaUS,
    searchKingOfShojo,
    searchArenascan,
  ];

  const settled = await Promise.allSettled(adapters.map(fn => fn(query)));
  /** @type {Map<string, {title:string, cover:string, chapters:string, sites:{site:string, url:string}[]}>} */
  const map = new Map();

  for (const r of settled) {
    if (r.status !== "fulfilled") continue;
    for (const item of r.value) {
      const key = normTitle(item.title);
      if (map.has(key)) {
        map.get(key).sites.push(...item.sites);
      } else {
        map.set(key, { ...item });
      }
    }
  }

  return [...map.values()].slice(0, 30);
}

/** Shared fetch headers — helps avoid bot-detection on plain fetch requests */
const SEARCH_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

// --- Webtoon -------------------------------------------------------
// Actual search result structure:
//   ul.webtoon_list > li > a > div.image_wrap > img
//                               > div.info_text  > strong.title
async function searchWebtoon(q) {
  const url = `https://www.webtoons.com/en/search?keyword=${encodeURIComponent(q)}`;
  const res = await fetch(url, { headers: SEARCH_HEADERS, signal: AbortSignal.timeout(8000) });
  const html = await res.text();
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  const items = [];
  doc.querySelectorAll(".webtoon_list li").forEach(el => {
    const a = el.querySelector("a");
    const img = el.querySelector("img");
    const title = el.querySelector("strong.title")?.textContent?.trim() || "";
    const href = a?.getAttribute("href") || "";
    if (!title || !href) return;
    items.push({
      title,
      cover: img?.getAttribute("src") || "",
      chapters: "",
      // href is already absolute on Webtoon
      sites: [{ site: "Webtoon", url: href.startsWith("http") ? href : `https://www.webtoons.com${href}` }],
    });
  });
  return items;
}

// --- WordPress search helper (MangaReader / WP-Manga theme) ---------
// Card structure: div.bsx > a[href][title] > img.data-lazy-src
//                                          > div.adds > h2.tt
// IMPORTANT: use getAttribute("href") — DOMParser has no base URL,
// so a.href resolves against extension origin instead of the site.
async function wpSearch(origin, siteName, q) {
  const url = `${origin}/?s=${encodeURIComponent(q)}`;
  const res = await fetch(url, { headers: SEARCH_HEADERS, signal: AbortSignal.timeout(10000) });
  if (!res.ok) return [];
  const html = await res.text();
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  const items = [];
  doc.querySelectorAll(".bsx").forEach(el => {
    const a = el.querySelector("a");
    const img = el.querySelector("img");
    const href = a?.getAttribute("href") || "";
    // title attribute on the anchor is the most reliable source in this theme
    const title = a?.getAttribute("title") || el.querySelector(".tt")?.textContent?.trim() || "";
    if (!title || !href) return;
    // Lazy-loaded images may be in data-lazy-src or data-src before real src
    const cover =
      img?.getAttribute("data-lazy-src") ||
      img?.getAttribute("data-src") ||
      img?.getAttribute("src") || "";
    items.push({
      title,
      cover,
      chapters: "",
      sites: [{ site: siteName, url: href.startsWith("http") ? href : `${origin}${href}` }],
    });
  });
  return items;
}

async function searchToonily(q) { return wpSearch("https://toonily.me", "Toonily", q); }
async function searchManhwaTop(q) { return wpSearch("https://manhwatop.com", "ManhwaTop", q); }
async function searchManhuaUS(q) { return wpSearch("https://manhuaus.com", "ManhuaUS", q); }
async function searchKingOfShojo(q) { return wpSearch("https://kingofshojo.com", "KingOfShojo", q); }
async function searchArenascan(q) { return wpSearch("https://arenascan.com", "ArenaScan", q); }

// ------------------------------------------------------------
// Side Panel
// ------------------------------------------------------------

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(() => {});
