// Handles analytics persistence and derived reading statistics.
import { canonicalTitle } from "./matcher.js";

export const ANALYTICS_KEY = "manhwa_log_analytics";

export async function getAnalytics() {
  const res = await chrome.storage.local.get(ANALYTICS_KEY);
  return res[ANALYTICS_KEY] || { totalChapters: 0, daily: {}, titles: {} };
}

// Analytics intentionally count chapter advances, not every revisit, so the
// popup stats represent reading progress instead of refresh noise.
export async function trackAnalytics(data) {
  const analytics = await getAnalytics();
  const today = new Date().toISOString().slice(0, 10);

  analytics.totalChapters += 1;
  analytics.daily[today] = (analytics.daily[today] || 0) + 1;

  const titleKey = canonicalTitle(data.title);
  analytics.titles[titleKey] = (analytics.titles[titleKey] || 0) + 1;

  // Prune daily keys older than 90 days to prevent unbounded growth.
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 90);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  for (const key of Object.keys(analytics.daily)) {
    if (key < cutoffStr) delete analytics.daily[key];
  }

  await chrome.storage.local.set({ [ANALYTICS_KEY]: analytics });
}
