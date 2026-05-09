export function normalizeWhitespace(input: string): string {
  return input.replace(/\r/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

export function stripHtml(html: string): string {
  return normalizeWhitespace(
    decodeHtmlEntities(
      html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
        .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
        .replace(/<h([1-4])[^>]*>/gi, (_match, level: string) => `\n${"#".repeat(Number(level))} `)
        .replace(/<\/h[1-4]>/gi, "\n")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|section|article|header|main|aside)>/gi, "\n")
        .replace(/<\/li>/gi, ".\n")
        .replace(/<\/tr>/gi, ".\n")
        .replace(/<\/t[dh]>/gi, " | ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
    )
  );
}

export function titleFromHtml(html: string, fallback = "Untitled source"): string {
  const candidates = [
    metaContent(html, "og:title"),
    metaContent(html, "twitter:title"),
    firstHtmlHeading(html),
    titleTag(html),
    titleFromText(stripHtml(html), fallback)
  ];
  return candidates.map(cleanTitleCandidate).find((title) => title.length > 0) ?? fallback;
}

export function titleFromText(text: string, fallback = "Untitled source"): string {
  const heading = text
    .split("\n")
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .find((line) => line.length > 0 && line.length < 120);
  return heading ?? fallback;
}

export function splitSentences(text: string): string[] {
  return normalizeWhitespace(text)
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

export function excerpt(text: string, maxLength = 260): string {
  const cleaned = normalizeWhitespace(text);
  if (cleaned.length <= maxLength) {
    return cleaned;
  }
  return `${cleaned.slice(0, maxLength - 1).trim()}...`;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 2);
}

const QUESTION_STOPWORDS = new Set([
  "a",
  "about",
  "after",
  "all",
  "also",
  "an",
  "and",
  "are",
  "around",
  "as",
  "at",
  "be",
  "been",
  "being",
  "by",
  "can",
  "could",
  "did",
  "do",
  "does",
  "for",
  "from",
  "had",
  "has",
  "have",
  "happen",
  "happens",
  "here",
  "how",
  "i",
  "his",
  "in",
  "into",
  "is",
  "it",
  "its",
  "knowledge",
  "me",
  "of",
  "on",
  "or",
  "our",
  "represented",
  "responsible",
  "say",
  "show",
  "should",
  "source",
  "that",
  "the",
  "their",
  "there",
  "these",
  "this",
  "those",
  "to",
  "use",
  "used",
  "using",
  "was",
  "we",
  "were",
  "what",
  "whats",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
  "would",
  "you",
  "your",
  "documented",
  "brain"
]);

const CORPUS_INVENTORY_TOKENS = new Set(["base", "corpus", "database", "kb", "knowledge"]);

export function contentTokens(text: string): string[] {
  return tokenize(text)
    .filter((token) => !QUESTION_STOPWORDS.has(token))
    .map(normalizeTokenForMatch)
    .filter((token) => token.length > 2);
}

export function isCorpusInventoryQuestion(question: string): boolean {
  const lower = question.toLowerCase();
  const rawTokens = new Set(tokenize(lower));
  const hasCorpusNoun = [...CORPUS_INVENTORY_TOKENS].some((token) => rawTokens.has(token));
  const asksForOverview = /\b(what|what's|whats|list|show|summari[sz]e|overview|contents?)\b/.test(lower);
  const nonGenericTokens = unique(contentTokens(question)).filter(
    (token) => !CORPUS_INVENTORY_TOKENS.has(token)
  );

  return hasCorpusNoun && asksForOverview && nonGenericTokens.length === 0;
}

function normalizeTokenForMatch(token: string): string {
  if (token.endsWith("ies") && token.length > 4) {
    return `${token.slice(0, -3)}y`;
  }
  if (token.endsWith("ing") && token.length > 5) {
    return token.slice(0, -3);
  }
  if (token.endsWith("ed") && token.length > 4) {
    return token.slice(0, -2);
  }
  if (token.endsWith("s") && !token.endsWith("ss") && !token.endsWith("se") && token.length > 3) {
    return token.slice(0, -1);
  }
  return token;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function metaContent(html: string, property: string): string | undefined {
  const escapedProperty = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const propertyPattern = new RegExp(
    `<meta\\b(?=[^>]*(?:property|name)=["']${escapedProperty}["'])(?=[^>]*content=["']([^"']+)["'])[^>]*>`,
    "i"
  );
  const contentPattern = new RegExp(
    `<meta\\b(?=[^>]*content=["']([^"']+)["'])(?=[^>]*(?:property|name)=["']${escapedProperty}["'])[^>]*>`,
    "i"
  );
  return html.match(propertyPattern)?.[1] ?? html.match(contentPattern)?.[1];
}

function firstHtmlHeading(html: string): string | undefined {
  return html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
}

function titleTag(html: string): string | undefined {
  return html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1];
}

function cleanTitleCandidate(title: string | undefined): string {
  if (!title) {
    return "";
  }
  return normalizeWhitespace(stripHtml(title))
    .replace(/\s*\|\s*.+$/g, "")
    .trim();
}

export function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-f]+);/gi, (_, value: string) => String.fromCodePoint(Number.parseInt(value, 16)))
    .replace(/&#([0-9]+);/g, (_, value: string) => String.fromCodePoint(Number.parseInt(value, 10)))
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}
