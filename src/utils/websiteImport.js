function normalizeText(rawText) {
  if (!rawText) return '';

  return rawText
    .replace(/<[^>]+>/g, '\n')
    .replace(/\r/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function looksLikeLyricLine(line) {
  const normalized = line.trim();
  if (!normalized || normalized.length < 3) return false;
  if (normalized.length > 140) return false;
  if (/^(https?:\/\/|www\.|mailto:)/i.test(normalized)) return false;
  if (/^(lyrics?|song lyrics?|google|search results?|about|images?|videos?|news|shopping|maps|settings|sign in|help|privacy|terms|feedback|people also ask|show more|home|contact|menu|skip to content|results)$/i.test(normalized)) return false;
  if (/^©|copyright|all rights reserved/i.test(normalized)) return false;
  if (/^[\W_]+$/.test(normalized)) return false;
  if (/^[A-Z][A-Z0-9\s&|()\-]+$/i.test(normalized) && normalized.includes('|')) return false;
  if (/^\[[^\]]+\]$/.test(normalized)) return false;
  if (/^\([^)]*\)$/.test(normalized)) return false;
  if (/[a-zA-Z]/.test(normalized)) return true;
  return false;
}

export function extractLyricsFromText(rawText) {
  const lines = normalizeText(rawText);
  const lyricLines = lines.filter(looksLikeLyricLine);

  if (lyricLines.length >= 3) {
    return lyricLines.join('\n');
  }

  const fallbackLines = lines.filter((line) => {
    const normalized = line.replace(/\s+/g, ' ').trim();
    return normalized.length >= 3 && !/^(copyright|©|all rights reserved|home|about|contact|follow|listen|download|share|subscribe|privacy|terms|cookie|ads?|advertisement|featured on)/i.test(normalized);
  });

  return fallbackLines.slice(0, 20).join('\n');
}

export function buildGoogleLyricsSearchUrl(title, artist, overrideQuery = '') {
  const query = (overrideQuery || `${artist} ${title} lyrics`).trim();
  const encoded = encodeURIComponent(query.replace(/\s+/g, ' '));
  return `https://www.google.com/search?q=${encoded}`;
}

export function formatLabel(value) {
  return value
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}
