// Provides shared popup utility helpers.
export function handleCoverError(img) {
  try {
    const fallbacks = JSON.parse(img.dataset.fallbacks || "[]");
    if (fallbacks.length > 0) {
      const nextSrc = fallbacks.shift();
      img.dataset.fallbacks = JSON.stringify(fallbacks);
      img.src = nextSrc;
    } else {
      img.style.display = "none";
    }
  } catch (e) {
    img.style.display = "none";
  }
}

export function calculateStreak(daily) {
  if (!daily) return 0;

  let streak = 0;
  const now = new Date(Date.now() + 2 * 60 * 60 * 1000);
  let date = now;

  while (true) {
    const key = date.toISOString().slice(0, 10);
    if (!daily[key]) break;
    streak++;
    date = new Date(date);
    date.setDate(date.getDate() - 1);
  }

  return streak;
}
