// Pure formatting, validation, and scoring logic for the Memory gatekeeper. No Worker or DO
// imports — this module is the Node-testable core of the store.

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

// ---------------------------------------------------------------------------
// Types and constants
// ---------------------------------------------------------------------------

export const MEMORY_TYPES = ["constraint", "decision", "failure", "howto", "preference"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export const MAX_TITLE_CHARS = 200;
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_SNIPPET_CHARS = 300;
export const MAX_BODY_PREVIEW_CHARS = 1500;
export const DEFAULT_SEARCH_LIMIT = 10;
export const MAX_SEARCH_LIMIT = 50;
export const DEDUP_JACCARD_THRESHOLD = 0.85;
export const DEDUP_PRESEARCH_LIMIT = 20;

const ID_DATE_RE = /^d-(\d{4}-\d{2}-\d{2})-(.+)$/;
const SLUG_STRIP_RE = /[^a-z0-9]+/g;

// ---------------------------------------------------------------------------
// Slug and ID generation
// ---------------------------------------------------------------------------

/** Normalize a title into a lowercase kebab-case slug, bounded to 80 chars. */
export function titleSlug(title: string): string {
  let slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(SLUG_STRIP_RE, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
  return slug || "untitled";
}

/** Generate a memory id from a title and an ISO date prefix (YYYY-MM-DD). */
export function memoryIdFromDate(date: string, title: string): string {
  return `d-${date}-${titleSlug(title)}`;
}

/** Generate a memory id using the current date. */
export function newMemoryId(title: string, now: Date): string {
  let date = now.toISOString().slice(0, 10);
  return memoryIdFromDate(date, title);
}

/** Parse a memory id into its date and slug parts, or null if malformed. */
export function parseMemoryId(id: string): { date: string; slug: string } | null {
  let m = ID_DATE_RE.exec(id);
  if (!m) return null;
  return { date: m[1], slug: m[2] };
}

// ---------------------------------------------------------------------------
// Tag normalization
// ---------------------------------------------------------------------------

/** Normalize a tag string into lowercase, comma-separated, deduplicated, trimmed form. */
export function normalizeTags(tags: string | string[] | undefined): string {
  let list: string[];
  if (tags === undefined) list = [];
  else if (Array.isArray(tags)) list = tags;
  else list = tags.split(",");
  let seen = new Set<string>();
  let out: string[] = [];
  for (let raw of list) {
    let tag = raw.trim().toLowerCase();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out.join(",");
}

/** Parse a stored comma-separated tag string into a list. */
export function parseTags(tags: string): string[] {
  return tags ? tags.split(",").filter(Boolean) : [];
}

// ---------------------------------------------------------------------------
// Secret scanning — no exceptions, no overrides
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "github token", re: /gh[pousr]_[A-Za-z0-9]{36,}/ },
  { name: "OpenAI-style key", re: /sk-[A-Za-z0-9]{20,}/ },
  { name: "bearer token", re: /Bearer\s+[A-Za-z0-9\-._~+/]{20,}/ },
  { name: "AWS access key", re: /AKIA[0-9A-Z]{16}/ },
  { name: "Slack token", re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: "key-value assignment", re: /(?:api[_-]?key|apikey|token|secret|password|passwd|pwd)\s*[:=]\s*([A-Za-z0-9_\-+/=.$*]{8,})/i },
];

/**
 * Scan every user-supplied persisted field (title, body, tags, author, scope) for
 * secret-shaped values. Returns a human-readable finding, or null.
 * NO exceptions or overrides — any hit refuses the write.
 */
export function scanForSecrets(...fields: string[]): string | null {
  let combined = fields.join("\n");
  for (let { name, re } of SECRET_PATTERNS) {
    let m = re.exec(combined);
    if (!m) continue;
    // The key-value pattern requires a digit or a long value to reduce prose false positives.
    if (name === "key-value assignment") {
      let value = m[1] ?? "";
      let hasDigit = /\d/.test(value);
      if (!hasDigit && value.length < 16) continue;
    }
    return `body contains a secret-shaped value (${name})`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Jaccard dedup
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "if", "in",
  "into", "is", "it", "no", "not", "of", "on", "or", "such", "that", "the",
  "their", "then", "there", "these", "they", "this", "to", "was", "will", "with",
]);

/** Tokenize a title into a lowercase word set, dropping stop words. */
function titleWords(title: string): Set<string> {
  let words = new Set<string>();
  for (let w of title.toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length < 2 || STOP_WORDS.has(w)) continue;
    words.add(w);
  }
  return words;
}

/** Jaccard similarity between two titles' word sets. */
export function jaccardSimilarity(leftTitle: string, rightTitle: string): number {
  let left = titleWords(leftTitle);
  let right = titleWords(rightTitle);
  if (left.size === 0 && right.size === 0) {
    // No significant words on either side: identical case-folded titles still dedup.
    return leftTitle.trim().toLowerCase() === rightTitle.trim().toLowerCase() ? 1 : 0;
  }
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (let w of left) {
    if (right.has(w)) intersection++;
  }
  let union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** True if the normalized titles are ≥ threshold-similar (word-set Jaccard). */
export function isDuplicateTitle(newTitle: string, existingTitle: string, threshold = DEDUP_JACCARD_THRESHOLD): boolean {
  return jaccardSimilarity(newTitle, existingTitle) >= threshold;
}

// ---------------------------------------------------------------------------
// Frontmatter (YAML) serialization and parsing
// ---------------------------------------------------------------------------

export interface MemoryFrontmatter {
  id: string;
  type: MemoryType;
  title: string;
  tags: string;
  confidence: number;
  version: number;
  created: string;
  updated: string;
  author: string;
  scope: string;
}

/** Serialize a memory record to its on-disk markdown form (frontmatter + body). */
export function serializeMemoryFile(fm: MemoryFrontmatter, body: string): string {
  let yaml = stringifyYaml({
    id: fm.id,
    type: fm.type,
    title: fm.title,
    tags: fm.tags,
    confidence: fm.confidence,
    version: fm.version,
    created: fm.created,
    updated: fm.updated,
    author: fm.author,
    scope: fm.scope,
  });
  return `---\n${yaml.trimEnd()}\n---\n\n${body}\n`;
}

/** Parse an on-disk markdown file into its frontmatter and body, or null if malformed. */
export function parseMemoryFile(content: string): { fm: MemoryFrontmatter; body: string } | null {
  let m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(content);
  if (!m) return null;
  try {
    let raw = parseYaml(m[1]) as Partial<MemoryFrontmatter>;
    if (!raw.id || !raw.type || !raw.title) return null;
    if (!MEMORY_TYPES.includes(raw.type as MemoryType)) return null;
    return {
      fm: {
        id: raw.id,
        type: raw.type as MemoryType,
        title: raw.title,
        tags: raw.tags ?? "",
        confidence: typeof raw.confidence === "number" ? raw.confidence : 0.5,
        version: typeof raw.version === "number" ? raw.version : 1,
        created: raw.created ?? "",
        updated: raw.updated ?? "",
        author: raw.author ?? "",
        scope: raw.scope ?? "",
      },
      body: m[2].replace(/^\n/, "").replace(/\n$/, ""),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Search scoring and snippets
// ---------------------------------------------------------------------------

export interface ScoreInput {
  title: string;
  body: string;
}

/** Tokenize a query for literal scoring (stop words are scoring noise). */
export function queryTokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9*]+/)
    .filter((t) => t.length >= 2 && t !== "*" && !STOP_WORDS.has(t));
}

/**
 * Score a memory against a literal query: title token hits weigh 10x body hits.
 * An empty token list (match-all '*') scores 0 so ordering falls back to updated_at.
 */
export function literalScore(query: string, memory: ScoreInput): number {
  let tokens = queryTokens(query);
  if (tokens.length === 0) return 0;
  let lowerTitle = memory.title.toLowerCase();
  let lowerBody = memory.body.toLowerCase();
  let score = 0;
  for (let token of tokens) {
    if (lowerTitle.includes(token)) score += 10;
    if (lowerBody.includes(token)) score += 1;
  }
  return score;
}

/**
 * Score a memory against a regex: each title match ×10 plus each body match ×1.
 * Returns 0 if no matches. Throws SyntaxError if the regex is invalid (caller maps to VALIDATION).
 */
export function regexScore(pattern: string, memory: ScoreInput): number {
  let re = new RegExp(pattern, "gi");
  let titleMatches = memory.title.match(re)?.length ?? 0;
  let bodyMatches = memory.body.match(re)?.length ?? 0;
  if (titleMatches === 0 && bodyMatches === 0) return 0;
  return titleMatches * 10 + bodyMatches;
}

/** Build a snippet of at most MAX_SNIPPET_CHARS chars centered on the first query token hit. */
export function buildSnippet(query: string, body: string): string {
  let lowerBody = body.toLowerCase();
  let lowerQuery = query.toLowerCase();
  let idx = lowerBody.indexOf(lowerQuery);
  if (idx < 0) {
    // Fall back to first token hit
    for (let token of queryTokens(query)) {
      idx = lowerBody.indexOf(token);
      if (idx >= 0) break;
    }
  }
  if (idx < 0) {
    return body.slice(0, MAX_SNIPPET_CHARS);
  }
  let start = Math.max(0, idx - Math.floor(MAX_SNIPPET_CHARS / 3));
  let end = start + MAX_SNIPPET_CHARS;
  let snippet = body.slice(start, end);
  if (start > 0) snippet = `…${snippet}`;
  if (end < body.length) snippet = `${snippet}…`;
  return snippet;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateTitle(title: string): string | null {
  if (!title || !title.trim()) return "title must not be empty";
  if (title.length > MAX_TITLE_CHARS) return `title exceeds ${MAX_TITLE_CHARS} chars`;
  return null;
}

export function validateBody(body: string): string | null {
  if (!body || !body.trim()) return "body must not be empty";
  let byteLength = new TextEncoder().encode(body).length;
  if (byteLength > MAX_BODY_BYTES) {
    return `body exceeds ${MAX_BODY_BYTES} bytes`;
  }
  return null;
}

export function validateType(type: string): string | null {
  if (!MEMORY_TYPES.includes(type as MemoryType)) {
    return `type must be one of: ${MEMORY_TYPES.join(", ")}`;
  }
  return null;
}

export function clampConfidence(confidence: number | undefined): number {
  if (confidence === undefined || confidence === null || Number.isNaN(confidence)) return 0.5;
  return Math.max(0, Math.min(1, confidence));
}

export function validateSearchLimit(limit: number | undefined): number {
  if (limit === undefined || limit === null || limit <= 0) return DEFAULT_SEARCH_LIMIT;
  return Math.min(limit, MAX_SEARCH_LIMIT);
}

// ---------------------------------------------------------------------------
// TOON formatters
// ---------------------------------------------------------------------------

/** Format a memory id + type + title + tags + confidence + score + snippet as a TOON line. */
export function formatSearchLine(
  id: string, type: string, title: string, tags: string, confidence: number, score: number, snippet: string,
): string {
  return `id:${id} type:${type} "${title}" tags:${tags} confidence:${confidence} score:${score} snippet:"${snippet.replace(/\n/g, " ")}"`;
}

/** Format search results as TOON output (compact key:value lines). */
export function formatSearchToon(results: {
  results: Array<{
    id: string; type: string; title: string; tags: string;
    confidence: number; score: number; snippet: string;
  }>;
  total: number;
  truncated: boolean;
  hint?: string;
}): string {
  let lines: string[] = [];
  for (let r of results.results) {
    lines.push(formatSearchLine(r.id, r.type, r.title, r.tags, r.confidence, r.score, r.snippet));
  }
  lines.push(`total:${results.total} truncated:${results.truncated}`);
  if (results.hint) lines.push(`hint:${results.hint}`);
  return lines.join("\n");
}

/** Format stats as TOON output. */
export function formatStatsToon(stats: {
  total: number;
  byType: Record<string, number>;
  lastSync: string;
  dirty: number;
  repoOk: boolean;
  semantic: boolean;
}): string {
  let byType = Object.entries(stats.byType)
    .map(([k, v]) => `${k}:${v}`)
    .join(",");
  return `total:${stats.total} byType{${byType}} lastSync:${stats.lastSync} dirty:${stats.dirty} repoOk:${stats.repoOk} semantic:${stats.semantic}`;
}

/** Format a structured error as TOON output (error/code/help lines). */
export function formatErrorToon(message: string, code: string, help: string): string {
  return `error:${message}\ncode:${code}\nhelp:${help}`;
}

/** Format an add result as TOON output. */
export function formatAddToon(id: string, deduped: boolean, mergedInto: string | undefined, commit: string): string {
  let line = `id:${id} deduped:${deduped}`;
  if (mergedInto) line += ` mergedInto:${mergedInto}`;
  line += ` commit:${commit}`;
  return line;
}

/** Format a get result as TOON output. */
export function formatGetToon(get: {
  id: string; type: string; title: string; tags: string;
  confidence: number; version: number; updated: string; author: string;
  body: string; bodyBytes: number; hint?: string;
}): string {
  let lines = [
    `id:${get.id} type:${get.type} "${get.title}" tags:${get.tags} confidence:${get.confidence} version:${get.version} updated:${get.updated} author:${get.author} bodyBytes:${get.bodyBytes}`,
  ];
  if (get.hint) lines.push(`hint:${get.hint}`);
  lines.push(get.body);
  return lines.join("\n");
}
