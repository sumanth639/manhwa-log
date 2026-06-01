// Handles theme persistence and storage meter display.
import { state } from "./state.js";

export function setTheme(dark, persist = true) {
  state.isDark = dark;
  const app = document.getElementById("app");
  app.classList.toggle("dark", dark);
  app.classList.toggle("light", !dark);
  document.getElementById("lightOpt").classList.toggle("selected", !dark);
  document.getElementById("darkOpt").classList.toggle("selected", dark);

  if (persist) {
    chrome.runtime.sendMessage({
      type: "SAVE_SETTINGS",
      settings: { isDark: dark, sortType: state.sortType },
    });
  }
}

export function updateStorageMeter() {
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
