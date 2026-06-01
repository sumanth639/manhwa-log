// Handles progress updates, badge feedback, and storage quota pruning.
import { getList, saveList } from "./storage.js";
import { fuzzyTitleMatch } from "./matcher.js";
import { trackAnalytics } from "./analytics.js";

export async function updateProgress(data) {
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

export async function pruneScrollKeys() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith("scroll::"));
  if (keys.length > 300) {
    await chrome.storage.local.remove(keys.slice(0, keys.length - 300));
  }
}

export async function checkStorageQuota() {
  await pruneScrollKeys();
  const bytesInUse = await chrome.storage.local.getBytesInUse(null);
  if (bytesInUse > 8_000_000) {
    chrome.action.setBadgeText({ text: "!" });
    chrome.action.setBadgeBackgroundColor({ color: "#e0a040" });
  }
}
