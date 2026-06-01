// Provides canonical title normalization and fuzzy matching helpers.
export function canonicalTitle(title) {
  if (!title) return "";
  return title
    .toLowerCase()
    .replace(/\b(chapter|ch|episode|ep)\.?\s*\d+(\.\d+)?\b/g, "")
    .replace(/\b\d+(\.\d+)?\b$/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Standard dynamic-programming Levenshtein distance.
 * Operates on already-canonicalized strings for efficiency.
 */
export function levenshteinDistance(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => {
    const row = new Array(n + 1).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }
  return dp[m][n];
}

/**
 * Fast-path: exact canonical match.
 * Slow-path: Levenshtein <= 3 on canonical strings.
 * Threshold 3 is intentional - keeps similar-but-different titles separate.
 * Returns the matched list item, or null.
 */
export function fuzzyTitleMatch(newTitle, list) {
  const target = canonicalTitle(newTitle);

  const exact = list.find(item => canonicalTitle(item.title) === target);
  if (exact) return exact;

  const THRESHOLD = 3;
  let bestMatch = null;
  let bestDist = Infinity;

  for (const item of list) {
    const dist = levenshteinDistance(target, canonicalTitle(item.title));
    if (dist <= THRESHOLD && dist < bestDist) {
      bestDist = dist;
      bestMatch = item;
    }
  }

  return bestMatch;
}
