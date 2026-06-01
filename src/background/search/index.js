// Merges, deduplicates, scores, and returns cross-site search results.
import {
  searchAsura,
  searchWebtoon,
  searchManta,
  searchHiveToons,
  searchToonily,
  searchManhwaTop,
  searchManhuaUS,
  searchKingOfShojo,
  searchArenascan,
  searchToonGod,
  searchTapas,
} from "./adapters.js";
import { normalizeTitle, scoreResult } from "./helpers.js";

/** Merge results from multiple adapters, deduping by normalised title */
export async function searchAcrossSites(query) {
  const adapters = [
    searchAsura,
    searchWebtoon,
    searchManta,
    searchHiveToons,
    searchToonily,
    searchManhwaTop,
    searchManhuaUS,
    searchKingOfShojo,
    searchArenascan,
    searchToonGod,
    searchTapas,
  ];

  const settled = await Promise.allSettled(adapters.map(fn => fn(query)));
  /** @type {Map<string, {title:string, cover:string, chapters:string, sites:{site:string, url:string}[]}>} */
  const map = new Map();

  const normQuery = normalizeTitle(query);

  for (const r of settled) {
    if (r.status !== "fulfilled") continue;
    for (const item of r.value) {
      const nTitle = normalizeTitle(item.title);

      // 1. Strict title filtering: query in title OR title in query
      const isMatch = nTitle.includes(normQuery) || normQuery.includes(nTitle);
      if (!isMatch) continue;

      const key = normalizeTitle(item.title);
      if (map.has(key)) {
        const existing = map.get(key);
        for (const newSite of item.sites) {
          if (!existing.sites.some(s => s.site === newSite.site)) {
            existing.sites.push(newSite);
          }
        }
        if (item.cover) {
          if (!existing.covers) {
            existing.covers = [existing.cover].filter(Boolean);
          }
          if (!existing.covers.includes(item.cover)) {
            existing.covers.push(item.cover);
          }
          if (!existing.cover) {
            existing.cover = item.cover;
          }
        }
      } else {
        const newItem = { ...item };
        newItem.covers = newItem.cover ? [newItem.cover] : [];
        map.set(key, newItem);
      }
    }
  }

  // 4. Remove duplicate site badges for each item
  for (const item of map.values()) {
    const seen = new Set();
    item.sites = item.sites.filter(s => {
      const duplicate = seen.has(s.site);
      seen.add(s.site);
      return !duplicate;
    });
  }

  // 8. Score and sort matched results
  const matchedResults = [...map.values()].sort((a, b) => {
    return scoreResult(b.title, query) - scoreResult(a.title, query);
  });

  // Append fallback search links for sites we cannot scrape directly
  const fallbacks = [
    {
      title: `Search for "${query}"`,
      cover: "",
      chapters: "",
      sites: [
        { site: "MangaFire", url: `https://mangafire.to/filter?keyword=${encodeURIComponent(query)}` },
        { site: "ToonGod", url: `https://www.toongod.org/?s=${encodeURIComponent(query)}&post_type=wp-manga` },
        { site: "KunManga", url: `https://kunmanga.com/?s=${encodeURIComponent(query)}` },
        { site: "ManhwaClan", url: `https://manhwaclan.com/?s=${encodeURIComponent(query)}` }
      ],
      isFallback: true
    }
  ];

  return [...matchedResults.slice(0, 29), ...fallbacks];
}
