const SEE_MORE_TEXT = "\uB354 \uBCF4\uAE30";
const PUBLIC_AUDIENCE_TEXT = "\uACF5\uC720 \uB300\uC0C1:";
const AUTHOR_TEXT = "\uBBF8\uCE5C\uBC14\uB78C";
const AUTHOR_POST_TEXT = "\uBBF8\uCE5C\uBC14\uB78C\uB2D8\uC758 \uAC8C\uC2DC\uBB3C";
const INSIGHTS_TEXT = "\uC778\uC0AC\uC774\uD2B8 \uBC0F \uAD11\uACE0 \uBCF4\uAE30";
const REACTIONS_TEXT = "\uBAA8\uB4E0 \uACF5\uAC10:";
const LIKE_TEXT = "\uC88B\uC544\uC694";
const COMMENT_TEXT = "\uB313\uAE00";
const MONTH_TEXT = "\uC6D4";
const DAY_TEXT = "\uC77C";
const IMAGE_COUNT_TEXT = "\uC7A5";

export function normalizeFacebookLines(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function hasCollapsedFacebookText(value) {
  const text = String(value || "");

  return text.includes(SEE_MORE_TEXT) || new RegExp(`\\u2026\\s*${SEE_MORE_TEXT}`).test(text);
}

export function stripFacebookUiFromBody(value) {
  return String(value || "")
    .replace(new RegExp(`\\s*\\u2026\\s*${SEE_MORE_TEXT}`, "g"), "")
    .replace(new RegExp(`\\s*${SEE_MORE_TEXT}`, "g"), "")
    .replace(/\d+:\d+\s*\/\s*\d+:\d+/g, "")
    .replace(new RegExp(`${REACTIONS_TEXT}\\s*\\d+[\\s\\S]*$`, "g"), "")
    .replace(new RegExp(`${COMMENT_TEXT}\\s*\\d+\\s*\\uAC1C[\\s\\S]*$`, "g"), "")
    .trim();
}

export function extractFacebookPostBodyFromPageText(pageText, authorName = AUTHOR_TEXT) {
  const rawText = String(pageText || "");
  const postIndex = rawText.indexOf(AUTHOR_POST_TEXT);
  const lines = normalizeFacebookLines(postIndex >= 0 ? rawText.slice(postIndex) : rawText);
  let start = lines.findIndex((line) => line.includes(PUBLIC_AUDIENCE_TEXT));

  if (start >= 0) {
    start += 1;
  } else {
    const authorIndexes = lines.map((line, index) => (line === authorName ? index : -1)).filter((index) => index >= 0);
    start = authorIndexes.length ? authorIndexes[authorIndexes.length - 1] + 1 : 0;
  }

  let end = lines.findIndex(
    (line, index) =>
      index > start &&
      (new RegExp(`^\\+\\d+${IMAGE_COUNT_TEXT}$`).test(line) ||
        line === INSIGHTS_TEXT ||
        line === REACTIONS_TEXT ||
        new RegExp(`^${COMMENT_TEXT}\\s+\\d+\\s*\\uAC1C$`).test(line) ||
        line === LIKE_TEXT)
  );

  if (end < 0) {
    end = lines.length;
  }

  const noise = new Set(["·", PUBLIC_AUDIENCE_TEXT, AUTHOR_POST_TEXT, "\uD53C\uB4DC \uAC8C\uC2DC\uBB3C"]);
  const datePattern = new RegExp(`^\\d+${MONTH_TEXT}\\s+\\d+${DAY_TEXT}$`);

  return lines
    .slice(start, end)
    .filter((line) => !noise.has(line) && !datePattern.test(line))
    .join("\n")
    .trim();
}

export function isUsableFacebookBody(value) {
  const text = stripFacebookUiFromBody(value);

  return text.length > 0 && !hasCollapsedFacebookText(text);
}
