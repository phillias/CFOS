// Pure-logic tests for memory-format: slugs, ids, tags, secret scanning, dedup, frontmatter
// round-trips, scoring, snippets, validation, and TOON output shapes (report §7 examples).

import { describe, expect, it } from "vitest";
import {
  DEDUP_JACCARD_THRESHOLD,
  MAX_BODY_PREVIEW_CHARS,
  MAX_SEARCH_LIMIT,
  MAX_SNIPPET_CHARS,
  MEMORY_TYPES,
  buildSnippet,
  clampConfidence,
  formatAddToon,
  formatErrorToon,
  formatGetToon,
  formatSearchLine,
  formatSearchToon,
  formatStatsToon,
  isDuplicateTitle,
  jaccardSimilarity,
  literalScore,
  memoryIdFromDate,
  newMemoryId,
  normalizeTags,
  parseMemoryFile,
  parseMemoryId,
  parseTags,
  queryTokens,
  regexScore,
  scanForSecrets,
  serializeMemoryFile,
  titleSlug,
  validateBody,
  validateSearchLimit,
  validateTitle,
  validateType,
  type MemoryFrontmatter,
} from "../src/memory-format.js";

describe("titleSlug", () => {
  it("normalizes to lowercase kebab-case", () => {
    expect(titleSlug("How to deploy Workers!")).toBe("how-to-deploy-workers");
    expect(titleSlug("D1 cannot load sqlite-vec (WASM-only)")).toBe("d1-cannot-load-sqlite-vec-wasm-only");
  });

  it("folds unicode via NFKD", () => {
    expect(titleSlug("café über naïve")).toBe("cafe-uber-naive");
  });

  it("falls back to untitled when empty", () => {
    expect(titleSlug("")).toBe("untitled");
    expect(titleSlug("!!!")).toBe("untitled");
  });

  it("caps at 80 chars without a trailing dash", () => {
    let slug = titleSlug("a".repeat(200));
    expect(slug.length).toBeLessThanOrEqual(80);
    expect(slug).not.toMatch(/-$/);
  });
});

describe("memory ids", () => {
  it("composes id from date prefix and slug", () => {
    expect(memoryIdFromDate("2026-10-12", "Deploy Workers")).toBe("d-2026-10-12-deploy-workers");
  });

  it("uses the provided date object", () => {
    expect(newMemoryId("A B", new Date("2026-01-02T03:04:05Z"))).toBe("d-2026-01-02-a-b");
  });

  it("parses valid ids", () => {
    expect(parseMemoryId("d-2026-10-12-my-slug")).toEqual({ date: "2026-10-12", slug: "my-slug" });
  });

  it("rejects malformed ids", () => {
    expect(parseMemoryId("bogus")).toBeNull();
    expect(parseMemoryId("d-nope")).toBeNull();
    expect(parseMemoryId("")).toBeNull();
  });
});

describe("tag normalization", () => {
  it("normalizes case, trims, dedups, and joins with commas", () => {
    expect(normalizeTags(" Cloudflare, workers ,cloudflare ")).toBe("cloudflare,workers");
    expect(normalizeTags(["K8S", "k8s", "Ingress"])).toBe("k8s,ingress");
    expect(normalizeTags(undefined)).toBe("");
  });

  it("parses stored tags back into a list", () => {
    expect(parseTags("a,b")).toEqual(["a", "b"]);
    expect(parseTags("")).toEqual([]);
  });
});

describe("scanForSecrets", () => {
  it("detects each secret shape", () => {
    expect(scanForSecrets("t", "ghp_" + "a".repeat(40))).toBe("body contains a secret-shaped value (github token)");
    expect(scanForSecrets("t", "sk-" + "a".repeat(25))).toBe("body contains a secret-shaped value (OpenAI-style key)");
    expect(scanForSecrets("t", "Bearer abcdefghijklmnopqrstuvwx")).toBe("body contains a secret-shaped value (bearer token)");
    expect(scanForSecrets("t", "AKIAABCDEFGHIJKLMNOP")).toBe("body contains a secret-shaped value (AWS access key)");
    expect(scanForSecrets("t", "xoxb-" + "a".repeat(15))).toBe("body contains a secret-shaped value (Slack token)");
    expect(scanForSecrets("t", "api_key = a1b2c3d4e5")).toBe("body contains a secret-shaped value (key-value assignment)");
  });

  it("detects long key-value assignments without digits", () => {
    expect(scanForSecrets("t", "password: abcdefghijklmnop")).toBe("body contains a secret-shaped value (key-value assignment)");
  });

  it("scans every persisted field, not just title and body", () => {
    let secret = "ghp_" + "a".repeat(40);
    expect(scanForSecrets("t", "b", "x," + secret)).toContain("github token");
    expect(scanForSecrets("t", "b", "tag", "author", secret)).toContain("github token");
    expect(scanForSecrets("t", "b", "tag", secret, "scope")).toContain("github token");
  });

  it("scans the title too", () => {
    expect(scanForSecrets("leaked ghp_" + "a".repeat(40), "clean body")).toContain("github token");
  });

  it("allows prose that merely mentions secret words", () => {
    expect(scanForSecrets("The API key rotation policy", "rotates quarterly; the token never appears verbatim here.")).toBeNull();
    expect(scanForSecrets("Note", "token: this is a sentence about tokens")).toBeNull();
    expect(scanForSecrets("Note", "secret: shortvalue")).toBeNull();
    expect(scanForSecrets("Note", "we use Bearer auth headers in this flow")).toBeNull();
  });
});

describe("jaccard dedup", () => {
  it("is 1 for identical word sets", () => {
    expect(jaccardSimilarity("Deploy Workers with Wrangler", "wrangler workers deploy with")).toBe(1);
  });

  it("drops stop words and short words", () => {
    expect(jaccardSimilarity("the a of to", "")).toBe(0);
  });

  it("is 0 for disjoint sets", () => {
    expect(jaccardSimilarity("apple pie recipe", "kubernetes ingress setup")).toBe(0);
  });

  it("flags duplicates at the threshold", () => {
    expect(isDuplicateTitle("Kubernetes Ingress Setup", "kubernetes ingress setup")).toBe(true);
    expect(isDuplicateTitle("Kubernetes Ingress Setup", "Postgres tuning guide")).toBe(false);
    expect(isDuplicateTitle("A B", "A B", 0.5)).toBe(true);
    expect(DEDUP_JACCARD_THRESHOLD).toBe(0.85);
  });
});

describe("frontmatter round-trip", () => {
  let fm: MemoryFrontmatter = {
    id: "d-2026-10-12-test-memory",
    type: "decision",
    title: "Use SQLite DOs for the memory store",
    tags: "cloudflare,storage",
    confidence: 0.75,
    version: 3,
    created: "2026-10-12T00:00:00Z",
    updated: "2026-10-12T01:00:00Z",
    author: "acct-1",
    scope: "fleet",
    owner: "acct-1",
  };

  it("serializes and parses back identically", () => {
    let content = serializeMemoryFile(fm, "Body line one.\nBody line two.");
    let parsed = parseMemoryFile(content);
    expect(parsed).not.toBeNull();
    expect(parsed!.fm).toEqual(fm);
    expect(parsed!.body).toBe("Body line one.\nBody line two.");
  });

  it("defaults optional fields when parsing", () => {
    let content = `---\nid: d-2026-10-12-x\ntype: howto\ntitle: T\n---\n\nBody\n`;
    let parsed = parseMemoryFile(content);
    expect(parsed!.fm.tags).toBe("");
    expect(parsed!.fm.confidence).toBe(0.5);
    expect(parsed!.fm.version).toBe(1);
    expect(parsed!.fm.author).toBe("");
    expect(parsed!.fm.scope).toBe("");
    expect(parsed!.fm.owner).toBe("");
  });

  it("parses a v1 file (no owner) as shared without losing anything", () => {
    // A v1-era file: identical frontmatter shape minus the owner line.
    let content = serializeMemoryFile({ ...fm, owner: "" }, "Body line one.\nBody line two.")
      .replace(/^owner: .*\n/m, "");
    let parsed = parseMemoryFile(content);
    expect(parsed).not.toBeNull();
    expect(parsed!.fm.owner).toBe("");
    expect(parsed!.fm.author).toBe("acct-1");
    expect(parsed!.fm.scope).toBe("fleet");
    expect(parsed!.body).toBe("Body line one.\nBody line two.");
  });

  it("rejects malformed files", () => {
    expect(parseMemoryFile("no frontmatter at all")).toBeNull();
    expect(parseMemoryFile("---\nnot: yaml: valid: [\n---\n\nbody")).toBeNull();
    expect(parseMemoryFile(`---\nid: d-1\ntype: howto\n---\n\nbody`)).toBeNull(); // missing title
    expect(parseMemoryFile(`---\nid: d-1\ntitle: T\ntype: note\n---\n\nbody`)).toBeNull(); // bad type
  });
});

describe("literal and regex scoring", () => {
  it("tokenizes queries dropping short words and the star", () => {
    expect(queryTokens("Deploy the Workers!*")).toEqual(["deploy", "workers"]);
    expect(queryTokens("*")).toEqual([]);
  });

  it("weighs title hits 10x body hits", () => {
    let memory = { title: "Deploy Workers", body: "run wrangler deploy" };
    expect(literalScore("deploy", memory)).toBe(11);
    expect(literalScore("workers", memory)).toBe(10);
    expect(literalScore("nothing-matches", memory)).toBe(0);
    expect(literalScore("*", memory)).toBe(0);
  });

  it("scores regex matches per occurrence", () => {
    let memory = { title: "ingress-1", body: "ingress-2 and ingress-3" };
    expect(regexScore("ingress-\\d", memory)).toBe(12); // 1 title ×10 + 2 body ×1
    expect(regexScore("nomatch-zz", memory)).toBe(0);
  });
});

describe("buildSnippet", () => {
  it("centers on the first query hit and bounds the length", () => {
    let body = `prefix ${"x".repeat(500)} needle here ${"y".repeat(500)} suffix`;
    let snippet = buildSnippet("needle", body);
    expect(snippet).toContain("needle");
    expect(snippet.length).toBeLessThanOrEqual(MAX_SNIPPET_CHARS + 2); // +2 ellipsis chars
  });

  it("falls back to first token hit, then to a head slice", () => {
    expect(buildSnippet("needle missing", `token-hit ${"z".repeat(100)}`)).toContain("token-hit");
    let noHit = buildSnippet("absent", "a".repeat(500));
    expect(noHit.length).toBe(MAX_SNIPPET_CHARS);
  });
});

describe("validation", () => {
  it("validates titles", () => {
    expect(validateTitle("ok")).toBeNull();
    expect(validateTitle("")).toContain("empty");
    expect(validateTitle(" ".repeat(10))).toContain("empty");
    expect(validateTitle("x".repeat(201))).toContain("exceeds");
  });

  it("validates bodies by byte length", () => {
    expect(validateBody("ok")).toBeNull();
    expect(validateBody("")).toContain("empty");
    expect(validateBody("é".repeat(33_000))).toContain("exceeds"); // 66_000 bytes
    expect(validateBody("x".repeat(64 * 1024))).toBeNull();
  });

  it("validates types against the closed set", () => {
    expect(MEMORY_TYPES).toEqual(["constraint", "decision", "failure", "howto", "preference"]);
    expect(validateType("decision")).toBeNull();
    expect(validateType("note")).toContain("type must be one of");
  });

  it("clamps confidence and search limits", () => {
    expect(clampConfidence(undefined)).toBe(0.5);
    expect(clampConfidence(Number.NaN)).toBe(0.5);
    expect(clampConfidence(-1)).toBe(0);
    expect(clampConfidence(2)).toBe(1);
    expect(clampConfidence(0.75)).toBe(0.75);

    expect(validateSearchLimit(undefined)).toBe(10);
    expect(validateSearchLimit(0)).toBe(10);
    expect(validateSearchLimit(5)).toBe(5);
    expect(validateSearchLimit(500)).toBe(MAX_SEARCH_LIMIT);
  });
});

describe("TOON formatters (report §7 shapes)", () => {
  it("formats a structured error as error/code/help lines", () => {
    expect(formatErrorToon(
      "no memory with id d-2026-10-12-nope",
      "NOT_FOUND",
      "list ids with search('*') or stats(); ids are d-YYYY-MM-DD-<slug>",
    )).toBe(
      "error:no memory with id d-2026-10-12-nope\n" +
      "code:NOT_FOUND\n" +
      "help:list ids with search('*') or stats(); ids are d-YYYY-MM-DD-<slug>",
    );
  });

  it("formats a secret refusal exactly as specified", () => {
    expect(formatErrorToon(
      "body contains a secret-shaped value (github token)",
      "SECRET_REFUSED",
      "strip the secret and re-add; store only where the secret lives (env var, vault), never its value",
    )).toBe(
      "error:body contains a secret-shaped value (github token)\n" +
      "code:SECRET_REFUSED\n" +
      "help:strip the secret and re-add; store only where the secret lives (env var, vault), never its value",
    );
  });

  it("formats stats", () => {
    expect(formatStatsToon({
      total: 147,
      byType: { constraint: 31, decision: 52, failure: 18, howto: 38, preference: 8 },
      lastSync: "2026-10-12T06:40:12Z",
      dirty: 0,
      repoOk: true,
      semantic: false,
    })).toBe(
      "total:147 byType{constraint:31,decision:52,failure:18,howto:38,preference:8} " +
      "lastSync:2026-10-12T06:40:12Z dirty:0 repoOk:true semantic:false",
    );
  });

  it("formats add results", () => {
    expect(formatAddToon("d-2026-10-12-d1-cannot-load-sqlite-vec", false, undefined, "a1b2c3d"))
      .toBe("id:d-2026-10-12-d1-cannot-load-sqlite-vec deduped:false commit:a1b2c3d");
    expect(formatAddToon("d-x", true, "d-y", "a1b2c3d"))
      .toBe("id:d-x deduped:true mergedInto:d-y commit:a1b2c3d");
  });

  it("formats search results and hints", () => {
    let line = formatSearchLine("d-1", "decision", "Use Artifacts for memory", "cloudflare", 0.5, 20, "one\ntwo");
    expect(line).toBe(`id:d-1 type:decision "Use Artifacts for memory" tags:cloudflare confidence:0.5 score:20 snippet:"one two"`);

    expect(formatSearchToon({
      results: [
        { id: "d-1", type: "decision", title: "A", tags: "x", confidence: 0.5, score: 20, snippet: "s1" },
        { id: "d-2", type: "howto", title: "B", tags: "", confidence: 0.9, score: 10, snippet: "s2" },
      ],
      total: 2,
      truncated: false,
    })).toBe(
      'id:d-1 type:decision "A" tags:x confidence:0.5 score:20 snippet:"s1"\n' +
      'id:d-2 type:howto "B" tags: confidence:0.9 score:10 snippet:"s2"\n' +
      "total:2 truncated:false",
    );

    expect(formatSearchToon({
      results: [],
      total: 0,
      truncated: false,
      hint: "0 memories found matching 'kubernetes ingress' — try broader terms, or add() to record what you learned",
    })).toBe(
      "total:0 truncated:false\n" +
      "hint:0 memories found matching 'kubernetes ingress' — try broader terms, or add() to record what you learned",
    );
  });

  it("formats get output", () => {
    let out = formatGetToon({
      id: "d-1", type: "howto", title: "T", tags: "a,b", confidence: 0.5, version: 2,
      updated: "2026-10-12T00:00:00Z", author: "acct", body: "the body", bodyBytes: 8,
      hint: `body truncated to ${MAX_BODY_PREVIEW_CHARS} chars; pass {full:true} for the complete body`,
    });
    expect(out).toBe(
      'id:d-1 type:howto "T" tags:a,b confidence:0.5 version:2 updated:2026-10-12T00:00:00Z author:acct bodyBytes:8\n' +
      `hint:body truncated to ${MAX_BODY_PREVIEW_CHARS} chars; pass {full:true} for the complete body\n` +
      "the body",
    );
  });
});
