// ============================================================
// Manhwa Tracker - Popup Script
// Handles popup rendering, theme persistence, imports/exports,
// and source interactions for tracked entries.
// ============================================================

let allManhwa = [];
let searchQuery = "";
let sortType = "recent";
let isDark = true;

const app = document.getElementById("app");
const listWrap = document.getElementById("listWrap");
const emptyState = document.getElementById("emptyState");

const panels = {
  reading: document.getElementById("readingPanel"),
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
        sortType = settings.sortType;
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

  const isStatusFilter = ["reading", "onhold", "dropped", "completed"].includes(sortType);
  if (isStatusFilter) {
    list = list.filter((entry) => (entry.status || "reading") === sortType);
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
    const resumeLabel =
      scrollPct > 0.02
        ? `Continue Ch. ${entry.lastChapter} · ${Math.round(scrollPct * 100)}%`
        : (isRecent
            ? `Continue Ch. ${entry.lastChapter}`
            : `Resume Ch. ${entry.lastChapter}`);

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
      render();
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
  sortType = event.target.value;
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
