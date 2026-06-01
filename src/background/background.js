// Registers background listeners and routes extension messages.
import { SETTINGS_KEY, getList, saveList, getSettings } from "./storage.js";
import { getAnalytics } from "./analytics.js";
import { fuzzyTitleMatch } from "./matcher.js";
import { updateProgress } from "./progress.js";
import { searchAcrossSites } from "./search/index.js";
import { setupNetworkRules } from "./network.js";

// The content script cannot always observe SPA URL changes by itself, so the
// background worker relays browser-level updates back into the active tab.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) {
    chrome.tabs.sendMessage(tabId, { type: "URL_CHANGED", url: changeInfo.url }).catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "GET_MANTA_DATA") {
    if (!sender.tab || !sender.tab.id) {
      sendResponse(null);
      return true;
    }
    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      func: () => window.MantaDataLayer,
      world: "MAIN"
    }).then(res => {
      sendResponse(res[0]?.result || null);
    }).catch(() => {
      sendResponse(null);
    });
    return true;
  }

  // Detection reports from the content script funnel through one update path
  // so deduplication, analytics, and badges stay in sync.
  if (message.type === "CHAPTER_DETECTED") {
    updateProgress(message.data).then(entry => {
      sendResponse({ success: true, entry });
    }).catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }

  if (message.type === "GET_LIST") {
    getList().then(list => sendResponse({ list }));
    return true;
  }

  if (message.type === "DELETE_ENTRY") {
    getList().then(async list => {
      const filtered = list.filter(item => item.id !== message.id);
      await saveList(filtered);
      sendResponse({ success: true });
    });
    return true;
  }

  if (message.type === "GET_SETTINGS") {
    getSettings().then(settings => sendResponse({ settings }));
    return true;
  }

  if (message.type === "SAVE_SETTINGS") {
    chrome.storage.local.set({ [SETTINGS_KEY]: message.settings }).then(() => {
      sendResponse({ success: true });
    });
    return true;
  }

  // Manual add reuses the same pipeline as automatic detection for consistency.
  if (message.type === "MANUAL_ADD") {
    updateProgress(message.data).then(entry => {
      sendResponse({ success: true, entry });
    });
    return true;
  }

  if (message.type === "EXPORT_LIST") {
    getList().then(list => {
      sendResponse({ list });
    });
    return true;
  }

  // Import merges by fuzzy title so mirror-site titles can collapse into the
  // same entry instead of duplicating the reading list.
  if (message.type === "IMPORT_LIST") {
    getList().then(async existingList => {
      const newList = message.list;
      const merged = [...existingList];

      newList.forEach(newItem => {
        const existingMatch = fuzzyTitleMatch(newItem.title, merged);
        const idx = existingMatch ? merged.indexOf(existingMatch) : -1;

        if (idx >= 0) {
          if (newItem.lastChapter > merged[idx].lastChapter) {
            merged[idx] = { ...newItem };
          }
        } else {
          merged.unshift(newItem);
        }
      });

      merged.sort((a, b) => b.updatedAt - a.updatedAt);
      await saveList(merged);
      sendResponse({ success: true });
    });
    return true;
  }

  if (message.type === "GET_ANALYTICS") {
    getAnalytics().then(analytics => sendResponse({ analytics }));
    return true;
  }

  if (message.type === "UPDATE_ENTRY_FIELD") {
    getList().then(async list => {
      const idx = list.findIndex(item => item.id === message.id);
      if (idx >= 0) {
        list[idx] = { ...list[idx], [message.field]: message.value };
        await saveList(list);
      }
      sendResponse({ success: true });
    });
    return true;
  }

  if (message.type === "SEARCH_SITES") {
    const q = (message.query || "").trim();
    if (!q) { sendResponse({ results: [] }); return true; }
    searchAcrossSites(q).then(results => sendResponse({ results }));
    return true;
  }
});

setupNetworkRules();
