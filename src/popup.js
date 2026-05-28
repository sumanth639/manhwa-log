// ============================================================
// Manhwa Tracker - Popup Script
// Handles popup rendering, theme persistence, imports/exports,
// and source interactions for tracked entries.
// ============================================================

let allManhwa = [];
let searchQuery = "";
let sortType = "recent";
let filterStatus = "all";
let isDark = true;

function handleCoverError(img) {
  try {
    const fallbacks = JSON.parse(img.dataset.fallbacks || "[]");
    if (fallbacks.length > 0) {
      const nextSrc = fallbacks.shift();
      img.dataset.fallbacks = JSON.stringify(fallbacks);
      img.src = nextSrc;
    } else {
      img.style.display = "none";
    }
  } catch (e) {
    img.style.display = "none";
  }
}

const app = document.getElementById("app");
const listWrap = document.getElementById("listWrap");
const emptyState = document.getElementById("emptyState");

const panels = {
  reading: document.getElementById("readingPanel"),
  find: document.getElementById("findPanel"),
  settings: document.getElementById("settingsPanel"),
};

function setTheme(dark, persist = true) {
  isDark = dark;
  app.classList.toggle("dark", dark);
  app.classList.toggle("light", !dark);
  document.getElementById("lightOpt").classList.toggle("selected", !dark);
  document.getElementById("darkOpt").classList.toggle("selected", dark);

  if (persist) {
    chrome.runtime.sendMessage({
      type: "SAVE_SETTINGS",
      settings: { isDark: dark, sortType },
    });
  }
}

function showPanel(id) {
  Object.values(panels).forEach((panel) => panel.classList.remove("active"));
  panels[id].classList.add("active");

  const settingsToggle = document.getElementById("settingsToggle");
  const backBtn = document.getElementById("headerBackBtn");

  // Sync main-tab active state
  document.querySelectorAll(".main-tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === id);
  });

  if (id === "settings") {
    settingsToggle.hidden = true;
    backBtn.hidden = false;
    settingsToggle.classList.add("is-hidden");
    backBtn.classList.remove("is-hidden");
  } else {
    settingsToggle.hidden = false;
    backBtn.hidden = true;
    settingsToggle.classList.remove("is-hidden");
    backBtn.classList.add("is-hidden");
  }
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function normalizeSite(site) {
  if (!site) return "web";
  return site
    .replace("www.", "")
    .replace(/\.(com|org|net|me|to)$/, "")
    .replace(/-/g, "")
    .slice(0, 15);
}

function getSourceList(entry) {
  const primary =
    entry.site && entry.lastURL
      ? [
          {
            site: entry.site,
            url: entry.lastURL,
            lastSeenAt: entry.updatedAt,
            isPrimary: true,
          },
        ]
      : [];
  const seen = new Set(primary.map((source) => source.site));
  const extras = (entry.sources || [])
    .filter((source) => {
      if (!source || !source.site || !source.url || seen.has(source.site))
        return false;
      seen.add(source.site);
      return true;
    })
    .map((source) => ({ ...source, isPrimary: false }));

  return [...primary, ...extras].slice(0, 5);
}

function calculateStreak(daily) {
  if (!daily) return 0;

  let streak = 0;
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

function loadData() {
  Promise.all([
    new Promise((resolve) =>
      chrome.runtime.sendMessage({ type: "GET_SETTINGS" }, resolve),
    ),
    new Promise((resolve) =>
      chrome.runtime.sendMessage({ type: "GET_ANALYTICS" }, resolve),
    ),
    new Promise((resolve) =>
      chrome.runtime.sendMessage({ type: "GET_LIST" }, resolve),
    ),
  ]).then(([settingsRes, analyticsRes, listRes]) => {
    const settings = settingsRes?.settings;
    if (settings) {
      if (settings.sortType) {
        sortType = ["recent", "chapter"].includes(settings.sortType)
          ? settings.sortType
          : "recent";
        const select = document.getElementById("sortSelect");
        if (select) select.value = sortType;
      }
      setTheme(settings.isDark !== undefined ? settings.isDark : true, false);
    } else {
      setTheme(true, false);
    }

    const analytics = analyticsRes?.analytics;
    if (analytics) {
      const totalChapters = document.getElementById("totalChaptersRead");
      const readingStreak = document.getElementById("readingStreak");
      if (totalChapters)
        totalChapters.textContent = analytics.totalChapters || 0;
      if (readingStreak) {
        const streak = calculateStreak(analytics.daily);
        readingStreak.textContent = streak;
        readingStreak.closest(".stat").title =
          streak === 0
            ? "Read today to start your streak!"
            : `${streak} day streak — keep going!`;
      }
    }

    allManhwa = listRes?.list || [];
    render();
  });
}

async function render() {
  let list = [...allManhwa];

  if (searchQuery) {
    list = list.filter((entry) =>
      entry.title.toLowerCase().includes(searchQuery.toLowerCase()),
    );
  }

  if (filterStatus !== "all") {
    list = list.filter((entry) => (entry.status || "reading") === filterStatus);
  }

  list.sort((a, b) => {
    if (sortType === "chapter") return (b.lastChapter || 0) - (a.lastChapter || 0);
    return b.updatedAt - a.updatedAt;
  });

  const totalCount = document.getElementById("totalCount");
  const todayCount = document.getElementById("todayCount");
  if (totalCount) totalCount.textContent = allManhwa.length;

  const todayThreshold = Date.now() - 86400000;
  if (todayCount) {
    todayCount.textContent = allManhwa.filter(
      (entry) => entry.updatedAt > todayThreshold,
    ).length;
  }

  listWrap.querySelectorAll(".card").forEach((card) => card.remove());

  if (list.length === 0) {
    emptyState.classList.remove("is-hidden");
    if (searchQuery) {
      emptyState.querySelector(".empty-ornament").textContent = "Search";
      emptyState.querySelector(".empty-sub").textContent =
        `No results for "${searchQuery}"`;
    } else {
      emptyState.querySelector(".empty-ornament").textContent = "* * *";
      emptyState.querySelector(".empty-sub").innerHTML =
        "Nothing tracked yet.<br>Visit any chapter to start.";
    }
    return;
  }

  emptyState.classList.add("is-hidden");

  for (const entry of list) {
    const card = document.createElement("div");
    card.className = "card";

    const sources = getSourceList(entry);
    const extraSources = Math.max(sources.length - 1, 0);
    const isRecent = Date.now() - entry.updatedAt < 1000 * 60 * 60;
    const hash = entry.title.split('').reduce((a, b) => a + b.charCodeAt(0), 0);
    const pseudoMax = Math.max(entry.lastChapter + (hash % 40) + 5, 80);
    const progressPct = Math.min((entry.lastChapter / pseudoMax) * 100, 100);
    const scrollPct = await new Promise((resolve) => {
      chrome.storage.local.get(`scroll::${entry.lastURL}`, (res) => {
        resolve(res[`scroll::${entry.lastURL}`] || 0);
      });
    });
    const resumeLabel = scrollPct > 0.02
      ? `Continue Ch. ${entry.lastChapter} · ${Math.round(scrollPct * 100)}%`
      : `Continue Ch. ${entry.lastChapter}`;

    const status = entry.status || "reading";
    const statusLabels = { reading: "Reading", onhold: "On Hold", dropped: "Dropped", completed: "Completed" };

    card.innerHTML = `
      ${entry.cover ? `
        <div class="cover-wrap">
          <img class="card-cover" src="${entry.cover}" alt="" loading="lazy">
          <div class="cover-progress">
            <progress class="cover-progress-bar" max="100" value="${Math.round(progressPct)}"></progress>
          </div>
        </div>
      ` : ""}
      <div class="card-body">
        <div class="card-header">
          <div class="card-title-text" title="${entry.title}">${entry.title}</div>
          <button class="card-del" data-id="${entry.id}" aria-label="Delete entry">&times;</button>
        </div>
        <div class="card-meta">
          <span class="pill pill-ch">Ch. ${entry.lastChapter}</span>
          <span class="status-pill" data-status="${status}" title="Click to change status">${statusLabels[status]}</span>
          <span class="site-text">${normalizeSite(sources[0]?.site || entry.site)}</span>
          ${
            extraSources > 0
              ? `
            <button class="source-toggle" type="button">
              <span>+${extraSources} source${extraSources > 1 ? "s" : ""}</span>
              <span class="source-arrow">&#9662;</span>
            </button>
          `
              : ""
          }
          <span class="pill pill-time">${timeAgo(entry.updatedAt)}</span>
        </div>
        <div class="card-actions">
          <button class="continue-btn" title="Continue reading from last page">
            <span>${resumeLabel}</span>
          </button>
          <button class="next-btn" ${entry.nextURL ? "" : "disabled"} title="${entry.nextURL ? "Go to next chapter" : "No next chapter detected yet"}">
            ${entry.nextURL ? "<span>Next</span><span>&rarr;</span>" : "<span>No Next Ch.</span>"}
          </button>
        </div>
        ${
          extraSources > 0
            ? `
          <div class="card-sources">
            ${sources
              .map(
                (source, index) => `
              <div class="source-row">
                <span class="source-name">${normalizeSite(source.site)}${source.isPrimary ? " (current)" : ""}</span>
                <button class="source-link" data-url="${source.url}" type="button">${index === 0 ? "Continue" : "Open"}</button>
              </div>
            `,
              )
              .join("")}
          </div>
        `
            : ""
        }

      </div>
    `;

    const coverWrap = card.querySelector(".cover-wrap");
    if (coverWrap) {
      const img = coverWrap.querySelector(".card-cover");
      if (img) {
        img.addEventListener("error", () => {
          coverWrap.classList.add("is-hidden");
        });
      }
    }

    card.querySelector(".card-del").addEventListener("click", (event) => {
      event.stopPropagation();
      chrome.runtime.sendMessage(
        { type: "DELETE_ENTRY", id: entry.id },
        loadData,
      );
    });

    card.querySelector(".status-pill").addEventListener("click", (event) => {
      event.stopPropagation();
      const cycle = { reading: "onhold", onhold: "dropped", dropped: "completed", completed: "reading" };
      const newStatus = cycle[entry.status || "reading"];
      entry.status = newStatus;
      const idx = allManhwa.findIndex(e => e.id === entry.id);
      if (idx >= 0) allManhwa[idx].status = newStatus;
      chrome.runtime.sendMessage({ type: "UPDATE_ENTRY_FIELD", id: entry.id, field: "status", value: newStatus });
      const pill = event.currentTarget;
      const statusLabels = { reading: "Reading", onhold: "On Hold", dropped: "Dropped", completed: "Completed" };
      pill.dataset.status = newStatus;
      pill.textContent = statusLabels[newStatus];
      if (filterStatus !== "all" && filterStatus !== newStatus) {
        card.classList.add("is-exiting");
        setTimeout(() => render(), 220);
      }
    });

    card.querySelector(".continue-btn").addEventListener("click", (event) => {
      event.stopPropagation();
      chrome.tabs.create({ url: entry.lastURL });
    });

    card.querySelector(".next-btn").addEventListener("click", (event) => {
      event.stopPropagation();
      if (entry.nextURL) chrome.tabs.create({ url: entry.nextURL });
    });

    const sourceToggle = card.querySelector(".source-toggle");
    if (sourceToggle) {
      sourceToggle.addEventListener("click", (event) => {
        event.stopPropagation();
        const panel = card.querySelector(".card-sources");
        const arrow = sourceToggle.querySelector(".source-arrow");
        const isOpen = panel.classList.toggle("open");
        if (arrow) arrow.innerHTML = isOpen ? "&#9652;" : "&#9662;";
      });
    }

    card.querySelectorAll(".source-link").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        const url = button.dataset.url;
        if (url) chrome.tabs.create({ url });
      });
    });

    card.addEventListener("click", (event) => {
      if (
        event.target.closest(".card-del") ||
        event.target.closest(".continue-btn") ||
        event.target.closest(".source-toggle") ||
        event.target.closest(".card-sources")
      ) {
        return;
      }

      chrome.tabs.create({ url: entry.lastURL });
    });

    listWrap.appendChild(card);
  }
}

document
  .getElementById("themeToggle")
  .addEventListener("click", () => setTheme(!isDark));
document
  .getElementById("lightOpt")
  .addEventListener("click", () => setTheme(false));
document
  .getElementById("darkOpt")
  .addEventListener("click", () => setTheme(true));

document
  .getElementById("settingsToggle")
  .addEventListener("click", () => showPanel("settings"));
document
  .getElementById("headerBackBtn")
  .addEventListener("click", () => showPanel("reading"));
document
  .getElementById("logoHome")
  .addEventListener("click", () => showPanel("reading"));

document.getElementById("searchInput").addEventListener("input", (event) => {
  searchQuery = event.target.value;
  render();
});

document.getElementById("sortSelect").addEventListener("change", (event) => {
  const val = event.target.value;
  const statusValues = ["reading", "onhold", "dropped", "completed"];
  if (statusValues.includes(val)) {
    filterStatus = val;
    sortType = "recent";
  } else {
    filterStatus = "all";
    sortType = val;
  }
  chrome.runtime.sendMessage({
    type: "SAVE_SETTINGS",
    settings: { isDark, sortType },
  });
  render();
});

document.getElementById("exportBtn").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "EXPORT_LIST" }, ({ list }) => {
    const blob = new Blob([JSON.stringify(list, null, 2)], {
      type: "application/json",
    });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "manhwa-log.json";
    link.click();
  });
});

document.getElementById("importBtn").addEventListener("click", () => {
  document.getElementById("importFile").click();
});

document.querySelectorAll(".site-tag[data-site-url]").forEach((button) => {
  button.addEventListener("click", () => {
    const url = button.dataset.siteUrl;
    if (url) chrome.tabs.create({ url });
  });
});

document.getElementById("importFile").addEventListener("change", (event) => {
  const file = event.target.files[0];
  if (!file) return;

  const statusEl = document.getElementById("importStatus");
  const reader = new FileReader();

  reader.onload = (loadEvent) => {
    try {
      const list = JSON.parse(loadEvent.target.result);
      if (!Array.isArray(list)) throw new Error("Invalid format");

      chrome.runtime.sendMessage({ type: "IMPORT_LIST", list }, (res) => {
        if (res.success) {
          loadData();
          if (statusEl) {
            statusEl.innerHTML = "&#10003; Import successful - list merged.";
            statusEl.classList.remove("is-error");
            statusEl.classList.add("is-success");
            setTimeout(() => {
              statusEl.textContent = "";
              statusEl.classList.remove("is-success");
            }, 3000);
          }
        }
      });
    } catch (err) {
      if (statusEl) {
        statusEl.innerHTML = `&#10007; Import failed: ${err.message}`;
        statusEl.classList.remove("is-success");
        statusEl.classList.add("is-error");
        setTimeout(() => {
          statusEl.textContent = "";
          statusEl.classList.remove("is-error");
        }, 4000);
      }
    }
  };

  reader.readAsText(file);
  event.target.value = "";
});

function updateStorageMeter() {
  if (typeof chrome === "undefined" || !chrome.storage) return;

  chrome.storage.local.getBytesInUse(null, (bytes) => {
    const usedMb = bytes / 1_000_000;
    const remainingMb = 10 - usedMb;
    const percent = Math.min((bytes / 10_000_000) * 100, 100);

    const usedEl = document.getElementById("storageUsed");
    const totalEl = document.getElementById("storageTotal");
    const bar = document.getElementById("storageBar");
    const pctEl = document.getElementById("storagePct");

    if (usedEl) usedEl.innerHTML = `${usedMb.toFixed(2)}<span>MB used</span>`;
    if (totalEl) totalEl.textContent = `${remainingMb.toFixed(2)} MB remaining`;
    if (pctEl) pctEl.textContent = `${percent.toFixed(1)}% of 10 MB`;

    if (bar) {
      bar.value = percent;
      bar.classList.remove("warn", "critical");
      if (percent > 90) {
        bar.classList.add("critical");
      } else if (percent > 70) {
        bar.classList.add("warn");
      }
    }
  });
}

document
  .getElementById("settingsToggle")
  ?.addEventListener("click", updateStorageMeter);

showPanel("reading");
loadData();
updateStorageMeter();

// Main tab switching (My List / Find)
document.querySelectorAll(".main-tab").forEach((btn) => {
  btn.addEventListener("click", () => showPanel(btn.dataset.tab));
});

// ================================================================
// Find Panel — Cross-site search
// ================================================================

const findInput   = document.getElementById("findInput");
const findBtn     = document.getElementById("findBtn");
const findClear   = document.getElementById("findClear");
const findResults = document.getElementById("findResults");
const findState   = document.getElementById("findState");
const findLoading = document.getElementById("findLoading");

const FIND_INITIAL_HTML = findState.innerHTML;

function setFindLoading(on) {
  if (on) {
    findState.classList.add("is-hidden");
    findResults.classList.add("is-hidden");
    findLoading.classList.remove("is-hidden");
  } else {
    findLoading.classList.add("is-hidden");
  }
}

function renderFindResults(results) {
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

  function createFindCard(item) {
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

  function createSectionHeader(title) {
    const header = document.createElement("div");
    header.className = "find-section-header";
    header.textContent = title;
    return header;
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
    "KingOfShojo": `https://kingofshojo.com/?s=${encodeURIComponent(query)}`,
    "ArenaScan": `https://arenascan.com/?s=${encodeURIComponent(query)}`
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

function triggerFindSearch() {
  const query = findInput.value.trim();
  if (query.length < 2) return;

  setFindLoading(true);
  chrome.runtime.sendMessage({ type: "SEARCH_SITES", query }, (res) => {
    renderFindResults(res?.results ?? []);
  });
}

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
  findState.innerHTML = FIND_INITIAL_HTML;
});
