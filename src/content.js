// ============================================================
// Manhwa Tracker — Content Script
// Detects title/chapter data on supported reader pages and
// reports stable progress updates back to the background worker.
// ============================================================

// Debounces navigation and DOM-triggered detection so SPA pages do not
// flood the background worker with duplicate progress events.
let debounceTimer;

// These values suppress duplicate reports caused by rerenders and fast SPA
// transitions on the same chapter page.
let lastFingerprint = null;
let lastSentAt = 0;

function hasExtensionContext() {
  return typeof chrome !== "undefined" && !!chrome.runtime?.id;
}

// ------------------------------------------------------------
// Title Normalization
// ------------------------------------------------------------

// Produces a user-facing title string that is clean enough for storage
// while staying close to the original site wording.
function cleanTitle(title) {
  if (!title) return "";
  return title
    .replace(/read\s+/i, "")
    .replace(/::/g, "")
    .replace(/\b(chapter|ch|episode|ep)\.?\s*\d+(\.\d+)?\b/gi, "")
    // Preserve colons and apostrophes inside words (e.g. Re:Zero, I'm) but strip other symbols
    .replace(/[^a-zA-Z0-9\s:'-]/g, "")
    // Strip leading/trailing punctuation artifacts left after the above
    .replace(/^[\s:'-]+|[\s:'-]+$/g, "")
    .trim()
    .toLowerCase()
    .replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Normalizes a title string to Title Case.
 * Applied once at detect() output; handlers produce raw cleaned strings.
 */
function toTitleCase(str) {
  if (!str) return str;
  return str.replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

function formatSlug(slug) {
  if (!slug) return "";
  return slug.replace(/[-_]/g, " ").replace(/\b\w/g, c => c.toUpperCase()).trim();
}

function extractNumber(str) {
  if (!str) return null;
  const match = str.match(/(\d+(\.\d+)?)/);
  return match ? parseFloat(match[1]) : null;
}

// ------------------------------------------------------------
// Site-Specific Detectors
// ------------------------------------------------------------

function handleWebtoon() {
  const title = document.title;
  const parts = title.split("|");

  if (parts.length > 1) {
    const name = parts[1].trim();
    const match = title.match(/Episode\s*(\d+)/i);

    if (match) {
      return {
        title: name,
        chapter: parseFloat(match[1])
      };
    }
  }
  return null;
}

function handleTappytoon() {
  const og = document.querySelector('meta[property="og:title"]');
  if (!og) return null;

  const text = og.content;
  const match = text.match(/Episode\s*(\d+)\s*-\s*(.+)/i);

  if (match) {
    return {
      title: match[2],
      chapter: parseFloat(match[1])
    };
  }
  return null;
}

function handleTapas() {
  const seriesEl = document.querySelector("h1") || document.querySelector('[class*="title"]');
  if (!seriesEl) return null;

  // Target only likely episode-label elements instead of walking all DOM nodes.
  const candidates = document.querySelectorAll('[class*="episode"], [class*="ep-num"], [class*="ep_num"], h2, h3');
  let epEl = null;
  for (const el of candidates) {
    if (/episode\s*\d+/i.test(el.innerText || "")) {
      epEl = el;
      break;
    }
  }

  if (!epEl) return null;

  const title = seriesEl.innerText;
  const match = epEl.innerText.match(/episode\s*(\d+)/i);
  if (!match) return null;

  return {
    title,
    chapter: parseFloat(match[1])
  };
}

// Manta data is exposed through a page-owned data layer, so the content
// script asks the background worker to read it from the page context.
async function getMantaData() {
  if (!hasExtensionContext()) return null;
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: "GET_MANTA_DATA" }, resolve);
    } catch {
      resolve(null);
    }
  });
}

async function handleManta() {
  const data = await getMantaData();
  if (!data || !Array.isArray(data)) return null;

  const entries = data.filter(d => d.event === "view_episode");
  if (entries.length > 0) {
    const entry = entries[entries.length - 1];
    return {
      title: entry.series_title,
      chapter: entry.episode_number
    };
  }

  const fallback = data.find(d => d.seriesIdOrTitle);
  if (fallback) {
    return {
      title: formatSlug(fallback.seriesIdOrTitle),
      chapter: extractNumber(fallback.episodeTitle)
    };
  }
  return null;
}

// Some SPA pages populate metadata late, so a short retry window is safer
// than treating the first empty read as a final failure.
async function handleMantaWithRetry() {
  for (let i = 0; i < 5; i++) {
    const data = await handleManta();
    if (data) return data;
    await new Promise(r => setTimeout(r, 500));
  }
  return null;
}

/**
 * Mangafire: /read/title-slug.RANDOMID/en/chapter-NUMBER
 * Uses path split on "/read/" then takes only the first path segment
 * to avoid misidentifying dots within future title slugs.
 */
function _handleMangafireRaw() {
  // Primary: og:title is clean and sidesteps slug doubling obfuscation.
  const og = document.querySelector('meta[property="og:title"]')?.content;
  if (og) {
    const match = og.match(/^(.+?)\s*[-â€“|]\s*(?:chapter|ch\.?)\s*([\d.]+)/i);
    if (match) {
      return { title: match[1].trim(), chapter: parseFloat(match[2]) };
    }
  }

  // Fallback: URL slug with doubled-last-char fix (e.g. blue-lockk -> blue-lock).
  const afterRead = location.pathname.split("/read/")[1];
  if (!afterRead) return null;

  const rawSegment = afterRead.split("/")[0];
  let titleSlug = rawSegment.replace(/\.[^/.]+$/, "");
  titleSlug = titleSlug.replace(/(.)\1$/, "$1");

  const segments = location.pathname.split("/").filter(Boolean);
  const chapterSeg = segments.find(s => /^chapter[-_]?[\d.]+/i.test(s));
  const chapterMatch = (chapterSeg && chapterSeg.match(/([\d.]+)$/)) || location.pathname.match(/\/chapter-(\d+)/i);
  const chapter = chapterMatch ? parseFloat(chapterMatch[1]) : null;

  if (!titleSlug || !chapter) return null;
  return {
    title: titleSlug.replace(/[-_]/g, " "),
    chapter: chapter
  };
}

/**
 * Async retry wrapper for Mangafire to give og:title time to populate.
 */
async function handleMangafireWithRetry() {
  for (let i = 0; i < 5; i++) {
    const data = _handleMangafireRaw();
    if (data) return data;
    await new Promise(r => setTimeout(r, 500));
  }
  return null;
}

/**
 * FlameComics: /series/NUMBER/HASH — no title in URL.
 * Handles multiple real-world og:title formats:
 *   "Title - Chapter 478"
 *   "Title - Ch. 478 - Flame Comics"
 *   "Chapter 478 - Title"
 *   "Title Chapter 478"
 */
function _handleFlameComicsRaw() {
  const text = document.querySelector('meta[property="og:title"]')?.content
    || document.title
    || "";

  if (!text) return null;

  // Extract chapter number: flexible enough for "Chapter N", "Ch. N", or "Ch N".
  const chapterMatch = text.match(/ch(?:apter|\.?)\s*([\d.]+)/i);
  const chapter = chapterMatch ? parseFloat(chapterMatch[1]) : null;

  // Take the leading title segment, then scrub out chapter/site noise if present.
  const titleRaw = text
    .split(/\s*[-\u2013|]\s*/)[0]
    .replace(/ch(?:apter|\.?)\s*[\d.]+/gi, "")
    .replace(/flame\s*comics/gi, "")
    .trim();

  const title = titleRaw.replace(/\s+/g, " ").trim();

  if (!title || !chapter) return null;
  return { title, chapter };
}

/**
 * Async retry wrapper for Flame Comics to handle SPA-injected meta tags.
 */
async function handleFlameComicsWithRetry() {
  for (let i = 0; i < 5; i++) {
    const data = _handleFlameComicsRaw();
    // Ensure we actually got a title, not just the generic site name.
    if (data && data.title.toLowerCase() !== "flame comics") return data;
    await new Promise(r => setTimeout(r, 500));
  }
  return null;
}

/**
 * Toonily: /serie/title-OPTIONAL_HASH/chapter-NUMBER/
 * Hash widened to 6-10 hex chars to handle sites that do not pad to exactly 8.
 */
function handleToonily() {
  const path = location.pathname;

  const chapterMatch = path.match(/\/chapter[-_]?([\d.]+)/i);
  const chapter = chapterMatch ? parseFloat(chapterMatch[1]) : null;

  const serieMatch = path.match(/\/serie\/([^/]+)/i);
  if (!serieMatch) return null;

  const rawSlug = serieMatch[1].replace(/-[a-f0-9]{6,10}$/i, "");
  const title = rawSlug.replace(/[-_]/g, " ").replace(/\s+/g, " ").trim();

  if (!title || !chapter) return null;
  return { title, chapter };
}

function handleArenascan() {
  const path = location.pathname;
  const match = path.match(/^\/([^/]+)-([\d.]+)\/?$/);
  if (!match) return null;

  const slug = match[1];
  const chapter = parseFloat(match[2]);

  // Try to find the title from breadcrumb or other DOM elements first.
  const allcLink = document.querySelector(".allc a");
  let title = allcLink ? allcLink.textContent.trim() : "";

  if (!title) {
    const breadcrumbs = document.querySelectorAll('[itemprop="itemListElement"] a span');
    if (breadcrumbs.length >= 2) {
      title = breadcrumbs[1].textContent.trim();
    }
  }

  if (!title) {
    title = slug.replace(/[-_]/g, " ");
  }

  return { title, chapter };
}


// ------------------------------------------------------------
// Generic Fallback Detection
// ------------------------------------------------------------

async function genericDetect() {
  const path = location.pathname;

  // Ignore catalog/search pagination paths like /page/18/ or /manga/title/page/2/
  const pathSegments = path.split("/").filter(Boolean).map(s => s.toLowerCase());
  if (pathSegments.includes("page") || pathSegments.includes("pages")) {
    return null;
  }

  // Step 1: extract a likely chapter number from the URL path.
  let chapter = null;

  // Matches patterns like:
  // - chapter-430
  // - ch-430
  // - /430/
  const chapterMatch =
    path.match(/chapter[-_ ]?(\d+(\.\d+)?)/i) ||
    path.match(/ch[-_ ]?(\d+(\.\d+)?)/i) ||
    path.match(/\/(\d+)(\/)?$/);

  if (chapterMatch) {
    chapter = parseFloat(chapterMatch[1]);
  }

  // Step 2: choose the best candidate slug for the series title.
  const segments = path.split("/").filter(Boolean);
  const IGNORE_WORDS = ["manga", "manhwa", "manhua", "webtoon", "comic", "read", "series", "mangas", "comics", "manhwas", "webtoons"];
  const KEYWORDS = ["manga", "series", "webtoon", "comic", "manhwa", "comics"];

  let titleSlug = "";

  // Priority 1: check the segment after a keyword like /manga/title/.
  for (let key of KEYWORDS) {
    const idx = segments.findIndex(s => s.toLowerCase() === key);
    if (idx !== -1 && segments[idx + 1]) {
      const next = segments[idx + 1].toLowerCase();
      if (!next.match(/^(chapter|ch|ep|episode)[-_ ]?\d+/i) && !next.match(/^\d+$/)) {
        titleSlug = segments[idx + 1];
        break;
      }
    }
  }

  // Priority 2: fall back to the first non-generic, non-chapter segment.
  if (!titleSlug) {
    titleSlug = segments.find(seg => {
      const lower = seg.toLowerCase();
      return (
        !IGNORE_WORDS.includes(lower) &&
        !lower.match(/chapter|ch|ep|episode|\d/i)
      );
    }) || "";
  }

  // Final fallback: use the first segment if nothing better was found.
  if (!titleSlug && segments.length > 0) {
    titleSlug = segments[0];
  }

  // Strip trailing hash suffixes like -7b57f74d used by Asura and similar sites
  titleSlug = titleSlug.replace(/-[a-f0-9]{6,12}$/i, "");

  // Step 3: normalize the slug into a readable title.
  const title = cleanTitle(titleSlug.replace(/[-_]/g, " "));

  if (!title || !chapter) {
    // Last-chance fallback for sites whose URL shape is too noisy.
    const titleFromDOM = document.title.match(/(.+?)\s+(chapter|episode)\s+(\d+(\.\d+)?)/i);
    if (titleFromDOM) {
      return { title: titleFromDOM[1], chapter: parseFloat(titleFromDOM[3]) };
    }
    return null;
  }

  // Confidence guard: reject common false-positive path fragments.
  const FALSE_POSITIVE_BLOCKLIST = new Set(["cdn", "api", "www", "static", "assets", "v2", "v1", "img", "images", "web", "app", "page", "pages"]);
  if (title.length < 3 || FALSE_POSITIVE_BLOCKLIST.has(title.toLowerCase())) {
    return null;
  }

  return { title, chapter };
}

// ------------------------------------------------------------
// Cover Image
// ------------------------------------------------------------

// Sites where the cover exists only on the series/detail page, not on the
// chapter reader page. Each entry provides:
//   selector     — CSS selector for the cover <img> on the series page.
//   getSeriesUrl — derives the series URL from the current chapter URL.
const SERIES_COVER_SITES = {
  "toongod.org": {
    selector: ".summary_image img",
    getSeriesUrl: () => {
      // Split into segments and find the chapter- part by segment, not string split.
      // This is immune to extra slashes, query params, and SPA URL rewrites.
      const parts = location.pathname.split("/");
      const chapterIndex = parts.findIndex(p => p.startsWith("chapter-"));
      if (chapterIndex === -1) return null;
      return location.origin + parts.slice(0, chapterIndex).join("/") + "/";
    }
  },
  "toongod.xyz": {
    selector: ".summary_image img",
    getSeriesUrl: () => {
      const parts = location.pathname.split("/");
      const chapterIndex = parts.findIndex(p => p.startsWith("chapter-"));
      if (chapterIndex === -1) return null;
      return location.origin + parts.slice(0, chapterIndex).join("/") + "/";
    }
  },
  "mangafire.to": {
    selector: ".poster img",
    getSeriesUrl: () => {
      // /read/slug.id/en/chapter-N  →  /manga/slug.id
      const match = location.pathname.match(/\/read\/([^/]+)/);
      return match ? `${location.origin}/manga/${match[1]}` : null;
    }
  },
  "arenascan.com": {
    selector: ".thumb img, .summary_image img",
    getSeriesUrl: () => {
      const match = location.pathname.match(/^\/([^/]+)-[\d.]+\/?$/);
      if (!match) return null;
      return `${location.origin}/manga/${match[1]}/`;
    }
  }
};

// Fetches an image URL and converts it to a base64 Data URI.
// This runs in the content script (same origin as the site), meaning it naturally
// bypasses CDN hotlink protection, Cloudflare blocks, and Referer checks.
// The popup then renders the local base64 string safely.
async function urlToBase64(url) {
  if (!url || url.startsWith("data:")) return url;
  try {
    const res = await fetch(url);
    const blob = await res.blob();
    return await new Promise(resolve => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.readAsDataURL(blob);
    });
  } catch {
    return url; // Fallback to raw URL if fetch fails
  }
}

// Fetches the series page and extracts the cover URL from a CSS selector.
// Uses getAttribute() on the parsed document to avoid DOMParser base-URL
// resolution issues (img.src resolves relative to about:blank).
// Returns null on any fetch or parse failure so callers degrade gracefully.
async function fetchCoverFromSeriesPage(seriesUrl, selector) {
  try {
    console.log("[ManhwaLog] Fetching series page:", seriesUrl);
    const res = await fetch(seriesUrl, { credentials: "include" });
    if (!res.ok) {
      console.log("[ManhwaLog] Fetch failed:", res.status, res.statusText);
      return null;
    }
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    const img = doc.querySelector(selector);
    console.log("[ManhwaLog] Selector:", selector, "→ img found:", !!img, img?.getAttribute("data-src") || img?.getAttribute("src"));
    if (!img) return null;
    const raw =
      img.getAttribute("data-src") ||
      img.getAttribute("src");
    if (!raw || raw.startsWith("data:")) return null;
    // Normalise to an absolute URL using the series page as base.
    const absolute = raw.startsWith("http") ? raw : new URL(raw, seriesUrl).href;
    return await urlToBase64(absolute);
  } catch (err) {
    console.log("[ManhwaLog] fetchCoverFromSeriesPage error:", err.message);
    return null;
  }
}

// Returns the best available cover image URL for the current page.
// Priority for sites in SERIES_COVER_SITES:
//   1. Series-page fetch (their og:image returns a site logo, not the cover)
//   2. og:image / og:image:secure_url / twitter:image as fallback
// For all other sites:
//   1. og:image / og:image:secure_url / twitter:image (no extra fetch)
// Returns null if nothing is found.
async function getCoverImage() {
  const host = location.hostname.replace(/^www\./, "");

  // 1. Known sites: fetch the series page first — their og:image is unreliable
  //    (returns a site-wide logo/banner instead of the series cover).
  const siteCfg = SERIES_COVER_SITES[host];
  if (siteCfg) {
    const seriesUrl = siteCfg.getSeriesUrl();
    if (seriesUrl) {
      const cover = await fetchCoverFromSeriesPage(seriesUrl, siteCfg.selector);
      if (cover) return cover;
    }
  }

  // 2. Universal fallback: OpenGraph / Twitter card.
  //    Fast path for all other sites; also catches SERIES_COVER_SITES failures.
  const fallbackUrl =
    document.querySelector('meta[property="og:image"]')?.content ||
    document.querySelector('meta[property="og:image:secure_url"]')?.content ||
    document.querySelector('meta[name="twitter:image"]')?.content ||
    null;

  return await urlToBase64(fallbackUrl);
}

// ------------------------------------------------------------
// Detection Flow
// ------------------------------------------------------------

async function detect() {
  const host = location.hostname;
  let data = null;

  if (host.includes("webtoons.com")) data = handleWebtoon();
  else if (host.includes("tappytoon.com")) data = handleTappytoon();
  else if (host.includes("tapas.io")) data = handleTapas();
  else if (host.includes("manta.net")) data = await handleMantaWithRetry();
  else if (host.includes("mangafire.to")) data = await handleMangafireWithRetry();
  else if (host.includes("flamecomics.xyz")) data = await handleFlameComicsWithRetry();
  else if (host.includes("toonily.com") || host.includes("toonily.me")) data = handleToonily();
  else if (host.includes("arenascan.com")) data = handleArenascan();

  if (!data && !host.includes("manta.net")) {
    // Manta already has a dedicated extraction path; other sites can use
    // the generic URL/title fallback when no specific detector matched.
    data = await genericDetect();
  }

  if (!data || !data.title || data.title.toLowerCase() === "read" || data.chapter === null || data.chapter === undefined) return null;

  const nextURL = findNextChapter();

  return {
    title: toTitleCase(cleanTitle(data.title)),
    chapter: data.chapter,
    url: location.href,
    nextURL: nextURL,
    site: host,
    cover: await getCoverImage(),
    timestamp: Date.now()
  };
}

// Finds the best "next chapter" control currently present on the page so
// the popup can offer a one-click forward action.
function findNextChapter() {
  // First try to find from inline script tags (useful for JS-injected links like Mangareader theme)
  const scripts = document.querySelectorAll("script");
  for (let script of scripts) {
    const text = script.textContent;
    if (text && text.includes("nextUrl")) {
      const match = text.match(/"nextUrl"\s*:\s*"([^"]+)"/);
      if (match) {
        const url = match[1].replace(/\\/g, "");
        if (url && !url.includes("#") && url !== location.href) {
          return url;
        }
      }
    }
  }

  // Fallback to DOM elements, ensuring we filter out dummy hash links
  const selectors = [
    'a[rel="next"]',
    'a.next',
    'button.next',
    '[class*="next-btn"]',
    '[class*="btn-next"]',
    '.next_page',
    '.next-chapter',
    '.next-episode',
    '.chapter-next',
    'a[data-link*="chapter"]',
    '[aria-label*="next" i]',
    'a[title*="next" i]',
    '.nav-next a',
    '.chapter-nav a:last-child'
  ];
  for (let sel of selectors) {
    const el = document.querySelector(sel);
    if (el && el.href && el.href !== location.href && !el.href.includes("#")) return el.href;
  }
  return null;
}

// ------------------------------------------------------------
// Reporting and SPA Navigation Handling
// ------------------------------------------------------------

// A compact fingerprint lets us suppress duplicate reports caused by
// rerenders or repeated observer triggers on the same chapter page.
function getFingerprint(data) {
  const normalize = s => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  return `${normalize(data.title)}::${data.chapter}`;
}

function report(data) {
  if (!data || !hasExtensionContext()) return;

  const fp = getFingerprint(data);
  const now = Date.now();

  // Ignore exact duplicates from repeated SPA lifecycle events.
  if (fp === lastFingerprint) return;

  // Keep a short cooldown so fast DOM churn does not emit multiple reports.
  if (now - lastSentAt < 1000) return;

  lastFingerprint = fp;
  lastSentAt = now;

  try {
    chrome.runtime.sendMessage({ type: "CHAPTER_DETECTED", data });
  } catch {
    // Ignore calls from stale content scripts after an extension reload.
  }
}

async function triggerDetection() {
  // Give the DOM a moment to settle so late-rendered titles and buttons are
  // more likely to exist before we inspect the page.
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(async () => {
    report(await detect());
  }, 1000);
}

// Browser-level URL changes are forwarded by the background worker.
if (hasExtensionContext()) {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "URL_CHANGED") {
      triggerDetection();
    }
  });
}

// Native back/forward navigation can change the chapter without a full reload.
window.addEventListener("popstate", triggerDetection);

// Some reader apps swap chapter content without updating the URL, so a DOM
// observer is the final fallback for SPA-style transitions.
function setupDOMObserver() {
  const observer = new MutationObserver((mutations) => {
    // Only trigger if added nodes contain meaningful text content (>20 chars).
    // This prevents firing on every image/script/style insertion on reader pages.
    const hasTextContent = mutations.some(m =>
      [...m.addedNodes].some(node => {
        if (node.nodeType === Node.TEXT_NODE) return (node.textContent || "").trim().length > 20;
        if (node.nodeType === Node.ELEMENT_NODE) return (node.innerText || "").trim().length > 20;
        return false;
      })
    );
    if (hasTextContent) triggerDetection();
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
}

// ------------------------------------------------------------
// Initialization
// ------------------------------------------------------------

setupDOMObserver();
triggerDetection();

// ------------------------------------------------------------
// Scroll Position Memory
// ------------------------------------------------------------

const SCROLL_KEY = `scroll::${location.href}`;

function saveScrollPosition() {
  if (!hasExtensionContext()) return;
  const total = document.documentElement.scrollHeight - window.innerHeight;
  if (total <= 0) return;
  const pct = window.scrollY / total;
  try {
    chrome.storage.local.set({ [SCROLL_KEY]: pct });
  } catch {
    // Ignore calls from stale content scripts after an extension reload.
  }
}

async function restoreScrollPosition() {
  if (!hasExtensionContext()) return;
  let result;
  try {
    result = await chrome.storage.local.get(SCROLL_KEY);
  } catch {
    return;
  }
  const pct = result[SCROLL_KEY];
  if (!pct || pct < 0.02) return;
  await autoScrollToPercent(pct);
}

async function autoScrollToPercent(pct) {
  const start = Date.now();
  let lastHeight = 0;

  while (Date.now() - start < 8000) {
    const total = document.documentElement.scrollHeight - window.innerHeight;
    if (total <= 0) return;

    const target = pct * total;
    window.scrollTo({ top: target, behavior: "smooth" });

    await new Promise(resolve => setTimeout(resolve, 500));

    const currentHeight = document.documentElement.scrollHeight;
    const isClose = Math.abs(window.scrollY - target) < 24;
    const heightSettled = currentHeight === lastHeight;
    if (isClose && heightSettled) return;

    lastHeight = currentHeight;
  }
}

// Save every 3 seconds while reading
setInterval(saveScrollPosition, 3000);

// Also save immediately when user leaves the page
window.addEventListener("pagehide", saveScrollPosition);

// Restore after page fully loads (wait for images to render)
window.addEventListener("load", () => setTimeout(restoreScrollPosition, 1500));
