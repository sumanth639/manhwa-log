// ===============================
// Universal Pattern-Based Tracker
// ===============================

let debounceTimer;


function cleanTitle(title) {
  if (!title) return "";
  return title
    .replace(/read\s+/i, "")
    .replace(/::/g, "")
    // Preserve colons and apostrophes inside words (e.g. Re:Zero, I'm) but strip other symbols
    .replace(/[^a-zA-Z0-9\s:'-]/g, "")
    // Strip leading/trailing punctuation artifacts left after the above
    .replace(/^[\s:'-]+|[\s:'-]+$/g, "")
    .trim()
    .toLowerCase()
    .replace(/\b\w/g, c => c.toUpperCase());
}

// ─────────────────────────────────────────────────────────────
// Specific Handlers
// ─────────────────────────────────────────────────────────────

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

  // Target only likely episode-label elements instead of walking all DOM nodes
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

async function getMantaData() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "GET_MANTA_DATA" }, resolve);
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

async function handleMantaWithRetry() {
  for (let i = 0; i < 5; i++) {
    const data = await handleManta();
    if (data) return data;
    await new Promise(r => setTimeout(r, 500));
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// Generic Fallback Detection
// ─────────────────────────────────────────────────────────────

async function genericDetect() {
  const url = location.href;
  const path = location.pathname;

  // 1. Extract chapter (robust)
  let chapter = null;

  // Matches: chapter-430, ch-430, /430/
  const chapterMatch =
    path.match(/chapter[-_ ]?(\d+(\.\d+)?)/i) ||
    path.match(/ch[-_ ]?(\d+(\.\d+)?)/i) ||
    path.match(/\/(\d+)(\/)?$/);

  if (chapterMatch) {
    chapter = parseFloat(chapterMatch[1]);
  }

  // 2. Extract title from slug
  const segments = path.split("/").filter(Boolean);
  const IGNORE_WORDS = ["manga", "manhwa", "manhua", "webtoon", "comic", "read", "series", "mangas", "comics", "manhwas", "webtoons"];
  const KEYWORDS = ["manga", "series", "webtoon", "comic", "manhwa"];

  let titleSlug = "";

  // Priority 1: Check segment after a keyword (e.g., /manga/title/)
  for (let key of KEYWORDS) {
    const idx = segments.findIndex(s => s.toLowerCase() === key);
    if (idx !== -1 && segments[idx + 1]) {
      const next = segments[idx + 1].toLowerCase();
      // Ensure the next segment isn't just a chapter number
      if (!next.match(/^(chapter|ch|ep|episode)[-_ ]?\d+/i) && !next.match(/^\d+$/)) {
        titleSlug = segments[idx + 1];
        break;
      }
    }
  }

  // Priority 2: Fallback to first valid segment that is NOT generic and NOT a chapter
  if (!titleSlug) {
    titleSlug = segments.find(seg => {
      const lower = seg.toLowerCase();
      return (
        !IGNORE_WORDS.includes(lower) &&
        !lower.match(/chapter|ch|ep|episode|\d/i)
      );
    }) || "";
  }

  // Final Fallback: First segment if nothing else worked
  if (!titleSlug && segments.length > 0) {
    titleSlug = segments[0];
  }

  // Clean and Format Title
  const title = cleanTitle(titleSlug.replace(/[-_]/g, " "));

  if (!title || !chapter) {
    // Last ditch effort: document title
    const titleFromDOM = document.title.match(/(.+?)\s+(chapter|episode)\s+(\d+(\.\d+)?)/i);
    if (titleFromDOM) {
      return { title: titleFromDOM[1], chapter: parseFloat(titleFromDOM[3]) };
    }
    return null;
  }

  // Confidence guard: reject known bad parses before saving junk
  const FALSE_POSITIVE_BLOCKLIST = new Set(["cdn", "api", "www", "static", "assets", "v2", "v1", "img", "images", "web", "app"]);
  if (title.length < 3 || FALSE_POSITIVE_BLOCKLIST.has(title.toLowerCase())) {
    return null;
  }

  return { title, chapter };
}

// ─────────────────────────────────────────────────────────────
// Site-Specific Handlers: Mangafire, FlameComics, Toonily
// ─────────────────────────────────────────────────────────────

/**
 * Normalizes a title string to Title Case.
 * Applied once at detect() output — handlers produce raw cleaned strings.
 */
function toTitleCase(str) {
  if (!str) return str;
  return str.replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}
/**
 * Mangafire: /read/title-slug.RANDOMID/en/chapter-NUMBER
 * Uses path split on "/read/" then takes only the first path segment
 * to avoid misidentifying dots within future title slugs.
 */
function _handleMangafireRaw() {
  // Primary: og:title is clean and sidesteps slug doubling obfuscation
  const og = document.querySelector('meta[property="og:title"]')?.content;
  if (og) {
    const match = og.match(/^(.+?)\s*[-–|]\s*(?:chapter|ch\.?)\s*([\d.]+)/i);
    if (match) {
      return { title: match[1].trim(), chapter: parseFloat(match[2]) };
    }
  }

  // Fallback: URL slug with doubled-last-char fix (e.g. blue-lockk -> blue-lock)
  const afterRead = location.pathname.split("/read/")[1];
  if (!afterRead) return null;

  const rawSegment = afterRead.split("/")[0];
  let titleSlug = rawSegment.replace(/\.[^/.]+$/, ""); // strip .kw9j9
  titleSlug = titleSlug.replace(/(.)\1$/, "$1");        // strip doubled last char

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

  // Extract chapter number — flexible: "Chapter N", "Ch. N", "Ch N"
  const chapterMatch = text.match(/ch(?:apter|\.?)\s*([\d.]+)/i);
  const chapter = chapterMatch ? parseFloat(chapterMatch[1]) : null;

  // Extract title: take first token when split by " - " or " | ", strip site suffix
  const titleRaw = text
    .split(/\s*[-\u2013|]\s*/)[0]  // take first segment
    .replace(/ch(?:apter|\.?)\s*[\d.]+/gi, "") // remove any inline chapter ref
    .replace(/flame\s*comics/gi, "") // strip site name if it bled in
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
    // Ensure we actually got a title, not just the generic "Flame Comics" or site name
    if (data && data.title.toLowerCase() !== "flame comics") return data;
    await new Promise(r => setTimeout(r, 500));
  }
  return null;
}

/**
 * Toonily: /serie/title-OPTIONAL_HASH/chapter-NUMBER/
 * Hash widened to 6–10 hex chars to handle sites that don’t pad to exactly 8.
 */
function handleToonily() {
  const path = location.pathname;

  const chapterMatch = path.match(/\/chapter[-_]?([\d.]+)/i);
  const chapter = chapterMatch ? parseFloat(chapterMatch[1]) : null;

  const serieMatch = path.match(/\/serie\/([^/]+)/i);
  if (!serieMatch) return null;

  // Strip optional trailing hex hash: 6–10 chars to handle variable-length suffixes
  const rawSlug = serieMatch[1].replace(/-[a-f0-9]{6,10}$/i, "");
  const title = rawSlug.replace(/[-_]/g, " ").replace(/\s+/g, " ").trim();

  if (!title || !chapter) return null;
  return { title, chapter };
}

// ─────────────────────────────────────────────────────────────
// Main Flow
// ─────────────────────────────────────────────────────────────

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

  if (!data && !host.includes("manta.net")) {
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
    timestamp: Date.now()
  };
}

function findNextChapter() {
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
    if (el && el.href && el.href !== location.href) return el.href;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// Production-Grade SPA & Navigation Detection
// ─────────────────────────────────────────────────────────────

let lastFingerprint = null;
let lastSentAt = 0;

function getFingerprint(data) {
  const normalize = s => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  return `${normalize(data.title)}::${data.chapter}`;
}

function report(data) {
  if (!data) return;

  const fp = getFingerprint(data);
  const now = Date.now();

  // 1. Same exact data → ignore
  if (fp === lastFingerprint) return;

  // 2. Spam protection (prevents multiple triggers during fast transitions)
  if (now - lastSentAt < 1000) return;

  lastFingerprint = fp;
  lastSentAt = now;

  chrome.runtime.sendMessage({ type: "CHAPTER_DETECTED", data });
}

async function triggerDetection() {
  // Wait for DOM to settle
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(async () => {
    report(await detect());
  }, 1000);
}

// 1. Listen for browser-level navigation (handled by background.js)
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "URL_CHANGED") {
    triggerDetection();
  }
});

// 2. Listen for back/forward navigation
window.addEventListener("popstate", triggerDetection);

// 3. Observe DOM changes (for sites like Manta that update without URL changes)
function setupDOMObserver() {
  const observer = new MutationObserver((mutations) => {
    // Only trigger if added nodes contain meaningful text content (>20 chars)
    // This prevents firing on every image/script/style insertion on reader pages
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

// ── Init ──────────────────────────────────────────────────────

setupDOMObserver();
triggerDetection();
