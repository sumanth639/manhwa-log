// Provides shared search normalization, scoring, headers, and image helpers.
import { levenshteinDistance } from "../matcher.js";

/** Shared fetch headers - helps avoid bot-detection on plain fetch requests */
export const SEARCH_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

/** Normalise a title for query filtering and scoring */
export function normalizeTitle(t) {
  if (!t) return "";
  return t.toLowerCase().replace(/[^a-z0-9]/g, "").trim();
}

/** Calculate relevance score of a result title against search query */
export function scoreResult(title, query) {
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
export function getImageSrc(img, baseUrl) {
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
