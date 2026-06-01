// Contains all cross-site search adapters.
import { SEARCH_HEADERS } from "./helpers.js";

// --- JSON APIs -----------------------------------------------------

export async function searchAsura(q) {
  try {
    const url = `https://api.asurascans.com/api/search?q=${encodeURIComponent(q)}`;
    const res = await fetch(url, { headers: SEARCH_HEADERS, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const json = await res.json();
    const items = [];
    const data = json.data || [];
    for (const x of data) {
      if (!x.title) continue;

      let asuraUrl = "";
      const publicUrl = x.public_url || "";
      if (publicUrl) {
        if (publicUrl.startsWith("http")) {
          asuraUrl = publicUrl;
        } else {
          try {
            asuraUrl = new URL(publicUrl, "https://asuracomic.net").href;
          } catch (err) {
            asuraUrl = `https://asuracomic.net${publicUrl.startsWith("/") ? "" : "/"}${publicUrl}`;
          }
        }
      } else {
        asuraUrl = `https://asuracomic.net/search?q=${encodeURIComponent(x.title)}`;
      }

      items.push({
        title: x.title,
        cover: x.cover || "",
        chapters: x.chapter_count ? `${x.chapter_count} chapters` : "",
        sites: [{ site: "Asura Scans", url: asuraUrl }]
      });
    }
    return items;
  } catch (e) {
    console.error("searchAsura error details:", e.name, e.message, e.stack);
    return [];
  }
}

export async function searchWebtoon(q) {
  try {
    const url = `https://www.webtoons.com/en/search/immediate?keyword=${encodeURIComponent(q)}`;
    const res = await fetch(url, { headers: SEARCH_HEADERS, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const json = await res.json();
    const items = [];
    const list = json.result?.searchedList || [];
    for (const x of list) {
      if (!x.title) continue;
      items.push({
        title: x.title,
        cover: x.thumbnailMobile ? `https://webtoon-phinf.pstatic.net${x.thumbnailMobile}` : "",
        chapters: "",
        sites: [{ site: "Webtoon", url: getWebtoonSeriesUrl(x) }]
      });
    }
    return items;
  } catch (e) {
    console.error("searchWebtoon error:", e);
    return [];
  }
}

function getWebtoonSeriesUrl(item) {
  const titleNo = item.titleNo || item.title_no;
  const titleSlug = item.titleSeo || item.titleSeoName || slugifyWebtoonPart(item.title);
  const rawGenre = item.genre || item.representGenre || item.serviceGenre || "";
  const type = String(item.titleType || item.serviceType || item.webtoonType || "").toLowerCase();

  if (titleNo && titleSlug) {
    if (type.includes("canvas") || type.includes("challenge")) {
      return `https://www.webtoons.com/en/canvas/${titleSlug}/list?title_no=${encodeURIComponent(titleNo)}`;
    }

    const genreSlug = slugifyWebtoonPart(rawGenre);
    if (genreSlug) {
      return `https://www.webtoons.com/en/${genreSlug}/${titleSlug}/list?title_no=${encodeURIComponent(titleNo)}`;
    }
  }

  return `https://www.webtoons.com/en/search?keyword=${encodeURIComponent(item.title)}`;
}

function slugifyWebtoonPart(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export async function searchManta(q) {
  try {
    const url = `https://manta.net/manta/v1/search/series?lang=en&q=${encodeURIComponent(q)}`;
    const res = await fetch(url, { headers: SEARCH_HEADERS, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const json = await res.json();
    const items = [];
    const data = json.data || [];
    for (const x of data) {
      const title = x.data?.title?.en || "";
      if (!title) continue;
      const id = x.id || "";
      const cover = x.image?.["1280x1840_480"]?.downloadUrl || "";
      items.push({
        title,
        cover,
        chapters: "",
        sites: [{ site: "Manta", url: `https://manta.net/en/series/${id}` }]
      });
    }
    return items;
  } catch (e) {
    console.error("searchManta error:", e);
    return [];
  }
}

export async function searchHiveToons(q) {
  try {
    const url = `https://api.hivetoons.org/api/query?searchTerm=${encodeURIComponent(q)}&perPage=5`;
    const res = await fetch(url, { headers: SEARCH_HEADERS, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const json = await res.json();
    const items = [];
    const posts = json.posts || [];
    for (const x of posts) {
      if (!x.postTitle) continue;
      items.push({
        title: x.postTitle,
        cover: x.featuredImage || "",
        chapters: "",
        sites: [{ site: "Hive Toons", url: `https://hivetoons.org/series/${x.slug || ""}` }]
      });
    }
    return items;
  } catch (e) {
    console.error("searchHiveToons error:", e);
    return [];
  }
}

// --- WordPress admin-ajax (POSTs) ----------------------------------

async function searchWPMangaPost(origin, siteName, q) {
  try {
    const url = `${origin}/wp-admin/admin-ajax.php`;
    const body = new URLSearchParams();
    body.append("action", "wp-manga-search-manga");
    body.append("title", q);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        ...SEARCH_HEADERS,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: body.toString(),
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) return [];
    const json = await res.json();
    const items = [];
    const data = Array.isArray(json) ? json : (json.data || []);
    for (const x of data) {
      const title = x.title || x.label || "";
      const href = x.url || "";
      if (!title || !href) continue;
      items.push({
        title,
        cover: x.cover || x.thumbnail || "",
        chapters: "",
        sites: [{ site: siteName, url: href }]
      });
    }
    return items;
  } catch (e) {
    console.error(`searchWPMangaPost for ${siteName} error:`, e);
    return [];
  }
}

async function searchTsAcPost(origin, siteName, q) {
  try {
    const url = `${origin}/wp-admin/admin-ajax.php`;
    const body = new URLSearchParams();
    body.append("action", "ts_ac_do_search");
    body.append("ts_ac_query", q);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        ...SEARCH_HEADERS,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: body.toString(),
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) return [];
    const json = await res.json();
    const items = [];
    let all = [];
    if (json.series) {
      if (Array.isArray(json.series)) {
        json.series.forEach(s => {
          if (s && Array.isArray(s.all)) {
            all.push(...s.all);
          }
        });
      } else if (Array.isArray(json.series.all)) {
        all.push(...json.series.all);
      }
    }
    for (const x of all) {
      if (!x.post_title) continue;
      items.push({
        title: x.post_title,
        cover: x.post_image || "",
        chapters: "",
        sites: [{ site: siteName, url: x.post_link || "" }]
      });
    }
    return items;
  } catch (e) {
    console.error(`searchTsAcPost for ${siteName} error:`, e);
    return [];
  }
}

export async function searchToonily(q) { return searchWPMangaPost("https://toonily.com", "Toonily", q); }
export async function searchManhwaTop(q) { return searchWPMangaPost("https://manhwatop.com", "ManhwaTop", q); }
export async function searchManhuaUS(q) { return searchWPMangaPost("https://manhuaus.com", "ManhuaUS", q); }
export async function searchKingOfShojo(q) { return searchTsAcPost("https://kingofshojo.com", "KingOfShojo", q); }
export async function searchArenascan(q) { return searchTsAcPost("https://arenascan.com", "ArenaScan", q); }
export async function searchToonGod(q) { return searchWPMangaPost("https://www.toongod.org", "ToonGod", q); }

// --- HTML Scrape ---------------------------------------------------

export async function searchTapas(q) {
  try {
    const url = `https://tapas.io/search?q=${encodeURIComponent(q)}&t=COMIC`;
    const res = await fetch(url, { headers: SEARCH_HEADERS, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return [];
    const html = await res.text();
    const items = [];

    const blocks = html.split(/class="search-item-wrap"/i);
    for (let i = 1; i < blocks.length; i++) {
      const block = blocks[i];

      const titleMatch = block.match(/<p[^>]*class="[^"]*\btitle\b[^"]*"[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
      if (!titleMatch) continue;

      const href = titleMatch[1].trim();
      const title = titleMatch[2].replace(/<[^>]*>/g, "").trim();
      if (!title || !href) continue;

      const coverMatch = block.match(/<img\s[^>]*src="([^"]+)"[^>]*>/i);
      const cover = coverMatch ? coverMatch[1].trim() : "";

      items.push({
        title,
        cover,
        chapters: "",
        sites: [{ site: "Tapas", url: href.startsWith("http") ? href : `https://tapas.io${href}` }]
      });
    }

    return items;
  } catch (e) {
    console.error("searchTapas error:", e);
    return [];
  }
}
