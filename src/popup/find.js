// Handles the cross-site find panel UI and result rendering.
import { handleCoverError } from "./utils.js";

let findInput;
let findBtn;
let findClear;
let findResults;
let findState;
let findLoading;
let findInitialHtml = "";

export function setFindLoading(on) {
  if (on) {
    findState.classList.add("is-hidden");
    findResults.classList.add("is-hidden");
    findLoading.classList.remove("is-hidden");
  } else {
    findLoading.classList.add("is-hidden");
  }
}

export function createFindCard(item) {
  const card = document.createElement("div");
  card.className = "find-card";

  // Deduplicate sites inside popup just to be absolutely sure
  const seen = new Set();
  const uniqueSites = item.sites.filter(s => {
    const duplicate = seen.has(s.site);
    seen.add(s.site);
    return !duplicate;
  });

  const actions =
    uniqueSites.length === 1
      ? `<button class="find-open-btn" data-url="${uniqueSites[0].url}">${uniqueSites[0].site} &nearr;</button>`
      : uniqueSites
          .map((s) => `<button class="find-source-btn" data-url="${s.url}">${s.site}</button>`)
          .join("");

  // Gather and deduplicate covers
  const covers = [item.cover, ...(item.covers || [])].filter(Boolean);
  const uniqueCovers = [...new Set(covers)];

  let imgTag = "";
  if (uniqueCovers.length > 0) {
    const primary = uniqueCovers[0];
    const fallbacks = uniqueCovers.slice(1);
    const fallbacksJson = JSON.stringify(fallbacks).replace(/'/g, "&apos;");
    imgTag = `<img class="find-cover" src="${primary}" alt="" loading="lazy" data-fallbacks='${fallbacksJson}'>`;
  }

  const subtitle = item.isFallback
    ? "Search on fallback sites"
    : `Available on ${uniqueSites.length} source${uniqueSites.length > 1 ? "s" : ""}`;

  card.innerHTML = `
      <div class="find-cover-container">
        <div class="find-cover-placeholder">
          ${item.isFallback ? `
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle cx="11" cy="11" r="6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
              <path d="M16 16L21 21" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            </svg>
          ` : ""}
        </div>
        ${imgTag}
      </div>
      <div class="find-card-body">
        <div class="find-card-title">${item.title}</div>
        <div class="find-card-meta">${subtitle}</div>
        <div class="find-card-actions">${actions}</div>
      </div>`;

  const img = card.querySelector(".find-cover");
  if (img) {
    img.addEventListener("error", () => handleCoverError(img));
  }

  card.querySelectorAll("[data-url]").forEach((btn) => {
    btn.addEventListener("click", () => chrome.tabs.create({ url: btn.dataset.url }));
  });

  return card;
}

export function createSectionHeader(title) {
  const header = document.createElement("div");
  header.className = "find-section-header";
  header.textContent = title;
  return header;
}

export function renderFindResults(results) {
  setFindLoading(false);

  if (!results || results.length === 0) {
    findResults.classList.add("is-hidden");
    findState.classList.remove("is-hidden");
    findState.innerHTML = `
      <div class="find-empty">
        <div class="find-empty-icon">
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            <path d="M16.5 16.5L21 21" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
        </div>
        <div class="find-empty-title">No results found</div>
        <div class="find-empty-sub">Try a different title or check your spelling</div>
      </div>`;
    return;
  }

  findState.classList.add("is-hidden");
  findResults.classList.remove("is-hidden");
  findResults.innerHTML = "";

  function normTitle(t) {
    if (!t) return "";
    return t.toLowerCase().replace(/[^a-z0-9]/g, "").trim();
  }

  const exactMatches = [];
  const relatedResults = [];
  const fallbackCards = [];

  const query = findInput.value.trim();
  const nQuery = normTitle(query);

  const matchedSites = new Set();
  for (const item of results) {
    if (!item.isFallback) {
      for (const s of item.sites) {
        matchedSites.add(s.site);
      }
    }
  }

  const activeSearchUrls = {
    "Asura Scans": `https://asuracomic.net/search?q=${encodeURIComponent(query)}`,
    "Webtoon": `https://www.webtoons.com/en/search?keyword=${encodeURIComponent(query)}`,
    "Manta": `https://manta.net/en/search?q=${encodeURIComponent(query)}`,
    "Hive Toons": `https://hivetoons.org/?s=${encodeURIComponent(query)}`,
    "Toonily": `https://toonily.com/?s=${encodeURIComponent(query)}`,
    "ManhwaTop": `https://manhwatop.com/?s=${encodeURIComponent(query)}`,
    "ManhuaUS": `https://manhuaus.com/?s=${encodeURIComponent(query)}`,
    "ManhwaClub": `https://manhwaclub.net/?s=${encodeURIComponent(query)}`,
    "KingOfShojo": `https://kingofshojo.com/?s=${encodeURIComponent(query)}`,
    "ArenaScan": `https://arenascan.com/?s=${encodeURIComponent(query)}`,
    "ToonGod": `https://www.toongod.org/?s=${encodeURIComponent(query)}&post_type=wp-manga`,
    "Tapas": `https://tapas.io/search?q=${encodeURIComponent(query)}&t=COMIC`
  };

  for (const item of results) {
    if (item.isFallback) {
      const missingSites = Object.entries(activeSearchUrls)
        .filter(([siteName]) => !matchedSites.has(siteName))
        .map(([siteName, url]) => ({ site: siteName, url }));
      item.sites = [...item.sites, ...missingSites];
      fallbackCards.push(item);
    } else if (normTitle(item.title) === nQuery) {
      exactMatches.push(item);
    } else {
      relatedResults.push(item);
    }
  }

  if (exactMatches.length > 0) {
    findResults.appendChild(createSectionHeader("Exact Matches"));
    exactMatches.forEach(item => findResults.appendChild(createFindCard(item)));
  }

  if (relatedResults.length > 0) {
    findResults.appendChild(createSectionHeader("Related Results"));
    relatedResults.forEach(item => findResults.appendChild(createFindCard(item)));
  }

  if (fallbackCards.length > 0) {
    findResults.appendChild(createSectionHeader("Search on Site"));
    fallbackCards.forEach(item => findResults.appendChild(createFindCard(item)));
  }
}

export function triggerFindSearch() {
  const query = findInput.value.trim();
  if (query.length < 2) return;

  setFindLoading(true);
  chrome.runtime.sendMessage({ type: "SEARCH_SITES", query }, (res) => {
    renderFindResults(res?.results ?? []);
  });
}

export function initFindPanel() {
  findInput = document.getElementById("findInput");
  findBtn = document.getElementById("findBtn");
  findClear = document.getElementById("findClear");
  findResults = document.getElementById("findResults");
  findState = document.getElementById("findState");
  findLoading = document.getElementById("findLoading");

  findInitialHtml = findState.innerHTML;

  findBtn.addEventListener("click", triggerFindSearch);

  findInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") triggerFindSearch();
  });

  findInput.addEventListener("input", () => {
    findClear.classList.toggle("is-hidden", findInput.value.length === 0);
  });

  findClear.addEventListener("click", () => {
    findInput.value = "";
    findClear.classList.add("is-hidden");
    findResults.classList.add("is-hidden");
    findLoading.classList.add("is-hidden");
    findState.classList.remove("is-hidden");
    findState.innerHTML = findInitialHtml;
  });
}
