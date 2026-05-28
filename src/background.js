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

/** Normalise a title for query filtering and scoring */
function normalizeTitle(t) {
  if (!t) return "";
  return t.toLowerCase().replace(/[^a-z0-9]/g, "").trim();
}

/** Calculate relevance score of a result title against search query */
function scoreResult(title, query) {
  const nTitle = normalizeTitle(title);
  const nQuery = normalizeTitle(query);
  if (!nTitle || !nQuery) return 0;
  
  if (nTitle === nQuery) return 100;
  if (nTitle.startsWith(nQuery)) return 80;
  if (nTitle.includes(nQuery)) return 60;
  if (nQuery.includes(nTitle)) return 50;
  
  // Fuzzy match fallback
  const dist = levenshteinDistance(nTitle, nQuery);
  if (dist <= 3) {
    return 40 - dist;
  }
  return 0;
}

/** Helper to extract and resolve image cover URL from a DOM element or HTML block */
function getImageSrc(img, baseUrl) {
  if (!img) return "";
  let src = "";
  if (typeof img === "string") {
    // Parse HTML attributes from string block using regex
    const attributes = ["data-src", "data-lazy-src", "data-cfsrc", "src"];
    for (const attr of attributes) {
      const match = img.match(new RegExp(`${attr}\\s*=\\s*["']([^"']+)["']`, "i"));
      if (match && match[1]) {
        src = match[1].trim();
        break;
      }
    }
  } else if (typeof img === "object" && img.getAttribute) {
    src = img.getAttribute("data-src") ||
          img.getAttribute("data-lazy-src") ||
          img.getAttribute("data-cfsrc") ||
          img.getAttribute("src") ||
          img.src || "";
  } else if (typeof img === "object") {
    src = img.src || "";
  }
  
  if (!src || src.startsWith("data:")) return src;
  
  try {
    return new URL(src, baseUrl).href;
  } catch (e) {
    return src;
  }
}

/** Merge results from multiple adapters, deduping by normalised title */
async function searchAcrossSites(query) {
  const adapters = [
    searchAsura,
    searchWebtoon,
    searchManta,
    searchHiveToons,
    searchToonily,
    searchManhwaTop,
    searchManhuaUS,
    searchKingOfShojo,
    searchArenascan,
    searchToonGod,
    searchTapas,
  ];

  const settled = await Promise.allSettled(adapters.map(fn => fn(query)));
  /** @type {Map<string, {title:string, cover:string, chapters:string, sites:{site:string, url:string}[]}>} */
  const map = new Map();

  const normQuery = normalizeTitle(query);

  for (const r of settled) {
    if (r.status !== "fulfilled") continue;
    for (const item of r.value) {
      const nTitle = normalizeTitle(item.title);
      
      // 1. Strict title filtering: query in title OR title in query
      const isMatch = nTitle.includes(normQuery) || normQuery.includes(nTitle);
      if (!isMatch) continue;

      const key = normalizeTitle(item.title);
      if (map.has(key)) {
        const existing = map.get(key);
        for (const newSite of item.sites) {
          if (!existing.sites.some(s => s.site === newSite.site)) {
            existing.sites.push(newSite);
          }
        }
      } else {
        map.set(key, { ...item });
      }
    }
  }

  // 4. Remove duplicate site badges for each item
  for (const item of map.values()) {
    const seen = new Set();
    item.sites = item.sites.filter(s => {
      const duplicate = seen.has(s.site);
      seen.add(s.site);
      return !duplicate;
    });
  }

  // 8. Score and sort matched results
  const matchedResults = [...map.values()].sort((a, b) => {
    return scoreResult(b.title, query) - scoreResult(a.title, query);
  });

  // Append fallback search links for sites we cannot scrape directly
  const fallbacks = [
    {
      title: `Search for "${query}" on MangaFire`,
      cover: "",
      chapters: "",
      sites: [{ site: "MangaFire", url: `https://mangafire.to/filter?keyword=${encodeURIComponent(query)}` }],
      isFallback: true
    },
    {
      title: `Search for "${query}" on KunManga`,
      cover: "",
      chapters: "",
      sites: [{ site: "KunManga", url: `https://kunmanga.com/?s=${encodeURIComponent(query)}` }],
      isFallback: true
    },
    {
      title: `Search for "${query}" on ManhwaClan`,
      cover: "",
      chapters: "",
      sites: [{ site: "ManhwaClan", url: `https://manhwaclan.com/?s=${encodeURIComponent(query)}` }],
      isFallback: true
    }
  ];

  return [...matchedResults, ...fallbacks].slice(0, 30);
}

/** Shared fetch headers — helps avoid bot-detection on plain fetch requests */
const SEARCH_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

// --- JSON APIs -----------------------------------------------------

async function searchAsura(q) {
  try {
    const url = `https://api.asurascans.com/api/search?q=${encodeURIComponent(q)}`;
    const res = await fetch(url, { headers: SEARCH_HEADERS, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const json = await res.json();
    const items = [];
    const data = json.data || [];
    for (const x of data) {
      if (!x.title) continue;
      
      let asuraUrl = "";
      const publicUrl = x.public_url || "";
      if (publicUrl) {
        if (publicUrl.startsWith("http")) {
          asuraUrl = publicUrl;
        } else {
          try {
            asuraUrl = new URL(publicUrl, "https://asuracomic.net").href;
          } catch (err) {
            asuraUrl = `https://asuracomic.net${publicUrl.startsWith("/") ? "" : "/"}${publicUrl}`;
          }
        }
      } else {
        asuraUrl = `https://asuracomic.net/search?q=${encodeURIComponent(x.title)}`;
      }

      items.push({
        title: x.title,
        cover: x.cover || "",
        chapters: x.chapter_count ? `${x.chapter_count} chapters` : "",
        sites: [{ site: "Asura Scans", url: asuraUrl }]
      });
    }
    return items;
  } catch (e) {
    console.error("searchAsura error details:", e.name, e.message, e.stack);
    return [];
  }
}

async function searchWebtoon(q) {
  try {
    const url = `https://www.webtoons.com/en/search/immediate?keyword=${encodeURIComponent(q)}`;
    const res = await fetch(url, { headers: SEARCH_HEADERS, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const json = await res.json();
    const items = [];
    const list = json.result?.searchedList || [];
    for (const x of list) {
      if (!x.title) continue;
      items.push({
        title: x.title,
        cover: x.thumbnailMobile || "",
        chapters: "",
        sites: [{ site: "Webtoon", url: `https://www.webtoons.com/en/search?keyword=${encodeURIComponent(x.title)}` }]
      });
    }
    return items;
  } catch (e) {
    console.error("searchWebtoon error:", e);
    return [];
  }
}

async function searchManta(q) {
  try {
    const url = `https://manta.net/manta/v1/search/series?lang=en&q=${encodeURIComponent(q)}`;
    const res = await fetch(url, { headers: SEARCH_HEADERS, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const json = await res.json();
    const items = [];
    const data = json.data || [];
    for (const x of data) {
      const title = x.data?.title?.en || "";
      if (!title) continue;
      const id = x.id || "";
      const cover = x.image?.["1280x1840_480"]?.downloadUrl || "";
      items.push({
        title,
        cover,
        chapters: "",
        sites: [{ site: "Manta", url: `https://manta.net/en/series/${id}` }]
      });
    }
    return items;
  } catch (e) {
    console.error("searchManta error:", e);
    return [];
  }
}

async function searchHiveToons(q) {
  try {
    const url = `https://api.hivetoons.org/api/query?searchTerm=${encodeURIComponent(q)}&perPage=5`;
    const res = await fetch(url, { headers: SEARCH_HEADERS, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const json = await res.json();
    const items = [];
    const posts = json.posts || [];
    for (const x of posts) {
      if (!x.postTitle) continue;
      items.push({
        title: x.postTitle,
        cover: x.featuredImage || "",
        chapters: "",
        sites: [{ site: "Hive Toons", url: `https://hivetoons.org/series/${x.slug || ""}` }]
      });
    }
    return items;
  } catch (e) {
    console.error("searchHiveToons error:", e);
    return [];
  }
}

// --- WordPress admin-ajax (POSTs) ----------------------------------

async function searchWPMangaPost(origin, siteName, q) {
  try {
    const url = `${origin}/wp-admin/admin-ajax.php`;
    const body = new URLSearchParams();
    body.append("action", "wp-manga-search-manga");
    body.append("title", q);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        ...SEARCH_HEADERS,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: body.toString(),
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) return [];
    const json = await res.json();
    const items = [];
    const data = Array.isArray(json) ? json : (json.data || []);
    for (const x of data) {
      const title = x.title || x.label || "";
      const href = x.url || "";
      if (!title || !href) continue;
      items.push({
        title,
        cover: x.cover || x.thumbnail || "",
        chapters: "",
        sites: [{ site: siteName, url: href }]
      });
    }
    return items;
  } catch (e) {
    console.error(`searchWPMangaPost for ${siteName} error:`, e);
    return [];
  }
}

async function searchTsAcPost(origin, siteName, q) {
  try {
    const url = `${origin}/wp-admin/admin-ajax.php`;
    const body = new URLSearchParams();
    body.append("action", "ts_ac_do_search");
    body.append("ts_ac_query", q);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        ...SEARCH_HEADERS,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: body.toString(),
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) return [];
    const json = await res.json();
    const items = [];
    let all = [];
    if (json.series) {
      if (Array.isArray(json.series)) {
        json.series.forEach(s => {
          if (s && Array.isArray(s.all)) {
            all.push(...s.all);
          }
        });
      } else if (Array.isArray(json.series.all)) {
        all.push(...json.series.all);
      }
    }
    for (const x of all) {
      if (!x.post_title) continue;
      items.push({
        title: x.post_title,
        cover: x.post_image || "",
        chapters: "",
        sites: [{ site: siteName, url: x.post_link || "" }]
      });
    }
    return items;
  } catch (e) {
    console.error(`searchTsAcPost for ${siteName} error:`, e);
    return [];
  }
}

async function searchToonily(q) { return searchWPMangaPost("https://toonily.com", "Toonily", q); }
async function searchManhwaTop(q) { return searchWPMangaPost("https://manhwatop.com", "ManhwaTop", q); }
async function searchManhuaUS(q) { return searchWPMangaPost("https://manhuaus.com", "ManhuaUS", q); }
async function searchKingOfShojo(q) { return searchTsAcPost("https://kingofshojo.com", "KingOfShojo", q); }
async function searchArenascan(q) { return searchTsAcPost("https://arenascan.com", "ArenaScan", q); }

// --- HTML Scrape ---------------------------------------------------

async function searchToonGod(q) {
  try {
    const url = `https://www.toongod.org/?s=${encodeURIComponent(q)}&post_type=wp-manga`;
    const res = await fetch(url, { headers: SEARCH_HEADERS, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return [];
    const html = await res.text();
    const items = [];
    
    // Split by c-tabs-item__content container
    const blocks = html.split(/class="[^"]*c-tabs-item__content[^"]*"/i);
    if (blocks.length > 1) {
      for (let i = 1; i < blocks.length; i++) {
        const block = blocks[i];
        
        // Match title and href inside post-title
        const hrefMatch = block.match(/<div[^>]*class="[^"]*post-title[^"]*"[\s\S]*?<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
        if (!hrefMatch) continue;
        
        const href = hrefMatch[1].trim();
        const title = hrefMatch[2].replace(/<[^>]*>/g, "").trim();
        if (!title || !href) continue;
        
        // Match image source via helper
        const cover = getImageSrc(block, "https://www.toongod.org");
        
        items.push({
          title,
          cover,
          chapters: "",
          sites: [{ site: "ToonGod", url: href }]
        });
      }
    }
    
    // Fallback: search for simple post-title h3 a matches in the whole html if blocks didn't yield anything
    if (items.length === 0) {
      const globalRegex = /<div[^>]*class="[^"]*post-title[^"]*"[\s\S]*?<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
      let match;
      while ((match = globalRegex.exec(html)) !== null) {
        const href = match[1].trim();
        const title = match[2].replace(/<[^>]*>/g, "").trim();
        if (title && href) {
          items.push({
            title,
            cover: "",
            chapters: "",
            sites: [{ site: "ToonGod", url: href }]
          });
        }
      }
    }
    
    return items;
  } catch (e) {
    console.error("searchToonGod error:", e);
    return [];
  }
}

async function searchTapas(q) {
  try {
    const url = `https://tapas.io/search?q=${encodeURIComponent(q)}&t=COMIC`;
    const res = await fetch(url, { headers: SEARCH_HEADERS, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return [];
    const html = await res.text();
    const items = [];
    
    // Split by search-item-wrap
    const blocks = html.split(/class="[^"]*search-item-wrap[^"]*"/i);
    if (blocks.length > 1) {
      for (let i = 1; i < blocks.length; i++) {
        const block = blocks[i];
        
        // Match title and href inside title class
        const titleMatch = block.match(/<div[^>]*class="[^"]*title[^"]*"[\s\S]*?<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
        if (!titleMatch) continue;
        
        const href = titleMatch[1].trim();
        const title = titleMatch[2].replace(/<[^>]*>/g, "").trim();
        if (!title || !href) continue;
        
        // Match image src via helper
        const cover = getImageSrc(block, "https://tapas.io");
        
        items.push({
          title,
          cover,
          chapters: "",
          sites: [{ site: "Tapas", url: href.startsWith("http") ? href : `https://tapas.io${href}` }]
        });
      }
    }
    
    return items;
  } catch (e) {
    console.error("searchTapas error:", e);
    return [];
  }
}

// ------------------------------------------------------------
// Side Panel
// ------------------------------------------------------------

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(() => {});

// ------------------------------------------------------------
// Network Header Rules (DeclarativeNetRequest)
// ------------------------------------------------------------

async function setupNetworkRules() {
  if (typeof chrome === "undefined" || !chrome.declarativeNetRequest) return;
  try {
    const rules = [
      {
        id: 1,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            { header: "Origin", operation: "remove" }
          ]
        },
        condition: {
          urlFilter: "||api.asurascans.com",
          resourceTypes: ["xmlhttprequest"]
        }
      }
    ];

    const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
    const existingIds = existingRules.map(r => r.id);

    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: existingIds,
      addRules: rules
    });
    console.log("[ManhwaLog] Successfully registered DeclarativeNetRequest rules.");
  } catch (e) {
    console.error("[ManhwaLog] Failed to setup network rules:", e);
  }
}

setupNetworkRules();
