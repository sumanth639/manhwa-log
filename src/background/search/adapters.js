// Contains all cross-site search adapters.
import { SEARCH_HEADERS, getImageSrc } from "./helpers.js";

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
        sites: [{ site: "Webtoon", url: `https://www.webtoons.com/en/search?keyword=${encodeURIComponent(x.title)}` }]
      });
    }
    return items;
  } catch (e) {
    console.error("searchWebtoon error:", e);
    return [];
  }
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

// --- HTML Scrape ---------------------------------------------------

export async function searchToonGod(q) {
  try {
    const url = `https://www.toongod.org/?s=${encodeURIComponent(q)}&post_type=wp-manga`;
    const res = await fetch(url, { headers: SEARCH_HEADERS, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return [];
    const html = await res.text();
    const items = [];

    // Split by c-tabs-item__content container
    const blocks = html.split(/class="[^"]*c-tabs-item__content[^"]*"/i);
    if (blocks.length > 1) {
      for (let i = 1; i < blocks.length; i++) {
        const block = blocks[i];

        // Match title and href inside post-title
        const hrefMatch = block.match(/<div[^>]*class="[^"]*post-title[^"]*"[\s\S]*?<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
        if (!hrefMatch) continue;

        const href = hrefMatch[1].trim();
        const title = hrefMatch[2].replace(/<[^>]*>/g, "").trim();
        if (!title || !href) continue;

        // Match image source via helper
        const cover = getImageSrc(block, "https://www.toongod.org");

        items.push({
          title,
          cover,
          chapters: "",
          sites: [{ site: "ToonGod", url: href }]
        });
      }
    }

    // Fallback: search for simple post-title h3 a matches in the whole html if blocks didn't yield anything
    if (items.length === 0) {
      const globalRegex = /<div[^>]*class="[^"]*post-title[^"]*"[\s\S]*?<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
      let match;
      while ((match = globalRegex.exec(html)) !== null) {
        const href = match[1].trim();
        const title = match[2].replace(/<[^>]*>/g, "").trim();
        if (title && href) {
          items.push({
            title,
            cover: "",
            chapters: "",
            sites: [{ site: "ToonGod", url: href }]
          });
        }
      }
    }

    return items;
  } catch (e) {
    console.error("searchToonGod error:", e);
    return [];
  }
}

export async function searchTapas(q) {
  try {
    const url = `https://tapas.io/search?q=${encodeURIComponent(q)}&t=COMIC`;
    const res = await fetch(url, { headers: SEARCH_HEADERS, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return [];
    const html = await res.text();
    const items = [];

    // Split by search-item-wrap
    const blocks = html.split(/class="[^"]*search-item-wrap[^"]*"/i);
    if (blocks.length > 1) {
      for (let i = 1; i < blocks.length; i++) {
        const block = blocks[i];

        // Match title and href inside title class
        const titleMatch = block.match(/<div[^>]*class="[^"]*title[^"]*"[\s\S]*?<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
        if (!titleMatch) continue;

        const href = titleMatch[1].trim();
        const title = titleMatch[2].replace(/<[^>]*>/g, "").trim();
        if (!title || !href) continue;

        // Match image src via helper
        const cover = getImageSrc(block, "https://tapas.io");

        items.push({
          title,
          cover,
          chapters: "",
          sites: [{ site: "Tapas", url: href.startsWith("http") ? href : `https://tapas.io${href}` }]
        });
      }
    }

    return items;
  } catch (e) {
    console.error("searchTapas error:", e);
    return [];
  }
}
