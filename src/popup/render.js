// Handles reading-list filtering, sorting, card construction, and rendering.
import { state } from "./state.js";
import { handleCoverError } from "./utils.js";

let reloadData = () => {};

export function setReloadHandler(handler) {
  reloadData = handler;
}

export function timeAgo(ts) {
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

export function normalizeSite(site) {
  if (!site) return "web";
  return site
    .replace("www.", "")
    .replace(/\.(com|org|net|me|to)$/, "")
    .replace(/-/g, "")
    .slice(0, 15);
}

export function getSourceList(entry) {
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

export function buildCard(entry, scrollPct) {
  const card = document.createElement("div");
  card.className = "card";

  const sources = getSourceList(entry);
  const extraSources = Math.max(sources.length - 1, 0);
  const hash = entry.title.split('').reduce((a, b) => a + b.charCodeAt(0), 0);
  const pseudoMax = Math.max(entry.lastChapter + (hash % 40) + 5, 80);
  const progressPct = Math.min((entry.lastChapter / pseudoMax) * 100, 100);
  const resumeLabel = scrollPct > 0.02
    ? `Continue Ch. ${entry.lastChapter} &middot; ${Math.round(scrollPct * 100)}%`
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
        handleCoverError(img);
        if (img.style.display === "none") coverWrap.classList.add("is-hidden");
      });
    }
  }

  card.querySelector(".card-del").addEventListener("click", (event) => {
    event.stopPropagation();
    chrome.runtime.sendMessage(
      { type: "DELETE_ENTRY", id: entry.id },
      reloadData,
    );
  });

  card.querySelector(".status-pill").addEventListener("click", (event) => {
    event.stopPropagation();
    const cycle = { reading: "onhold", onhold: "dropped", dropped: "completed", completed: "reading" };
    const newStatus = cycle[entry.status || "reading"];
    entry.status = newStatus;
    const idx = state.allManhwa.findIndex(e => e.id === entry.id);
    if (idx >= 0) state.allManhwa[idx].status = newStatus;
    chrome.runtime.sendMessage({ type: "UPDATE_ENTRY_FIELD", id: entry.id, field: "status", value: newStatus });
    const pill = event.currentTarget;
    const statusLabels = { reading: "Reading", onhold: "On Hold", dropped: "Dropped", completed: "Completed" };
    pill.dataset.status = newStatus;
    pill.textContent = statusLabels[newStatus];
    if (state.filterStatus !== "all" && state.filterStatus !== newStatus) {
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

  return card;
}

export async function render() {
  let list = [...state.allManhwa];

  if (state.searchQuery) {
    list = list.filter((entry) =>
      entry.title.toLowerCase().includes(state.searchQuery.toLowerCase()),
    );
  }

  if (state.filterStatus !== "all") {
    list = list.filter((entry) => (entry.status || "reading") === state.filterStatus);
  }

  list.sort((a, b) => {
    if (state.sortType === "chapter") return (b.lastChapter || 0) - (a.lastChapter || 0);
    return b.updatedAt - a.updatedAt;
  });

  const totalCount = document.getElementById("totalCount");
  const todayCount = document.getElementById("todayCount");
  if (totalCount) totalCount.textContent = state.allManhwa.length;

  const todayThreshold = Date.now() - 86400000;
  if (todayCount) {
    todayCount.textContent = state.allManhwa.filter(
      (entry) => entry.updatedAt > todayThreshold,
    ).length;
  }

  const listWrap = document.getElementById("listWrap");
  const emptyState = document.getElementById("emptyState");
  listWrap.querySelectorAll(".card").forEach((card) => card.remove());

  if (list.length === 0) {
    emptyState.classList.remove("is-hidden");
    if (state.searchQuery) {
      emptyState.querySelector(".empty-ornament").textContent = "Search";
      emptyState.querySelector(".empty-sub").textContent =
        `No results for "${state.searchQuery}"`;
    } else {
      emptyState.querySelector(".empty-ornament").textContent = "* * *";
      emptyState.querySelector(".empty-sub").innerHTML =
        "Nothing tracked yet.<br>Visit any chapter to start.";
    }
    return;
  }

  emptyState.classList.add("is-hidden");

  const scrollKeys = list.map(e => `scroll::${e.lastURL}`);
  const scrollData = await chrome.storage.local.get(scrollKeys);

  for (const entry of list) {
    try {
      const scrollPct = scrollData[`scroll::${entry.lastURL}`] || 0;
      const card = buildCard(entry, scrollPct);
      listWrap.appendChild(card);
    } catch (err) {
      console.warn("[ManhwaLog] Failed to render card for:", entry.title, err);
    }
  }
}
