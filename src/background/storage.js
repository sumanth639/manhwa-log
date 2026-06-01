// Handles persisted reading list and settings storage.
export const STORAGE_KEY = "manhwa_tracker_list";
export const SETTINGS_KEY = "manhwa_tracker_settings";

export async function getList() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return result[STORAGE_KEY] || [];
}

export async function saveList(list) {
  await chrome.storage.local.set({ [STORAGE_KEY]: list });
}

export async function getSettings() {
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  return result[SETTINGS_KEY] || {};
}
