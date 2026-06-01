// Entry point for popup initialization and event wiring.
import { state } from "./state.js";
import { setTheme, updateStorageMeter } from "./theme.js";
import { render, setReloadHandler } from "./render.js";
import { initFindPanel } from "./find.js";
import { initImportExport } from "./importExport.js";
import { calculateStreak } from "./utils.js";

const panels = {
  reading: document.getElementById("readingPanel"),
  find: document.getElementById("findPanel"),
  settings: document.getElementById("settingsPanel"),
};

function showPanel(id) {
  Object.values(panels).forEach((panel) => panel.classList.remove("active"));
  panels[id].classList.add("active");

  const discoverToggle = document.getElementById("discoverToggle");
  const settingsToggle = document.getElementById("settingsToggle");
  const backBtn = document.getElementById("headerBackBtn");
  const isReading = id === "reading";

  discoverToggle.hidden = !isReading;
  backBtn.hidden = isReading;
  discoverToggle.classList.toggle("is-hidden", !isReading);
  settingsToggle.classList.remove("is-hidden");
  backBtn.classList.toggle("is-hidden", isReading);
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
        state.sortType = ["recent", "chapter"].includes(settings.sortType)
          ? settings.sortType
          : "recent";
        const select = document.getElementById("sortSelect");
        if (select) select.value = state.sortType;
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
            : `${streak} day streak - keep going!`;
      }
    }

    state.allManhwa = listRes?.list || [];
    render();
  });
}

setReloadHandler(loadData);

document
  .getElementById("themeToggle")
  .addEventListener("click", () => setTheme(!state.isDark));
document
  .getElementById("lightOpt")
  .addEventListener("click", () => setTheme(false));
document
  .getElementById("darkOpt")
  .addEventListener("click", () => setTheme(true));

document
  .getElementById("discoverToggle")
  .addEventListener("click", () => showPanel("find"));
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
  state.searchQuery = event.target.value;
  render();
});

document.getElementById("sortSelect").addEventListener("change", (event) => {
  const val = event.target.value;
  const statusValues = ["reading", "onhold", "dropped", "completed"];
  if (statusValues.includes(val)) {
    state.filterStatus = val;
    state.sortType = "recent";
  } else {
    state.filterStatus = "all";
    state.sortType = val;
  }
  chrome.runtime.sendMessage({
    type: "SAVE_SETTINGS",
    settings: { isDark: state.isDark, sortType: state.sortType },
  });
  render();
});

document.querySelectorAll(".site-tag[data-site-url]").forEach((button) => {
  button.addEventListener("click", () => {
    const url = button.dataset.siteUrl;
    if (url) chrome.tabs.create({ url });
  });
});

document
  .getElementById("settingsToggle")
  ?.addEventListener("click", updateStorageMeter);

initFindPanel();
initImportExport(loadData);
showPanel("reading");
loadData();
updateStorageMeter();
