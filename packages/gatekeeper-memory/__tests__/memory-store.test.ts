// Store logic tests: MemoryStoreCore over real SQLite (node:sqlite) with a mock Artifacts repo.
// Covers the DO's logic without workerd: sync/reindex, dedup, secret refusal, outbox, TOON error
// shapes, empty/error states, and the user-scoping namespaces (private vs shared) — per the
// brief's non-workerd suite requirement.

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  GIT_REFRESH_MIN_INTERVAL_MS,
  SCHEMA_VERSION,
  MemoryStoreCore,
  MemoryStoreError,
  type MemoryRepo,
  type MemoryWriteOp,
  type SqlCursor,
  type SqlDb,
  type SqlValue,
} from "../src/memory-store.js";
import { parseMemoryFile, serializeMemoryFile } from "../src/memory-format.js";

// ---------------------------------------------------------------------------
// node:sqlite → SqlDb adapter (mirrors the workerd ctx.storage.sql surface)
// ---------------------------------------------------------------------------

class NodeSqlDb implements SqlDb {
  #db: DatabaseSync;

  constructor() {
    this.#db = new DatabaseSync(":memory:");
  }

  exec<T extends Record<string, SqlValue>>(sql: string, ...bindings: SqlValue[]): SqlCursor<T> {
    if (bindings.length === 0 && !/^\s*(select|pragma)/i.test(sql)) {
      // DDL, BEGIN/COMMIT/ROLLBACK, ALTER: node:sqlite exec handles full statements
      this.#db.exec(sql);
      return { toArray: () => [] };
    }
    let stmt = this.#db.prepare(sql);
    let rows = stmt.all(...(bindings as never[]));
    return { toArray: () => rows as T[] };
  }
}

/** Wraps a SqlDb and records every SQL statement, to prove filters live in SQL, not JS. */
class RecordingSqlDb implements SqlDb {
  statements: string[] = [];
  #inner: SqlDb;

  constructor(inner: SqlDb) {
    this.#inner = inner;
  }

  exec<T extends Record<string, SqlValue>>(sql: string, ...bindings: SqlValue[]): SqlCursor<T> {
    this.statements.push(sql);
    return this.#inner.exec<T>(sql, ...bindings);
  }
}

// ---------------------------------------------------------------------------
// Mock Artifacts repo
// ---------------------------------------------------------------------------

class MockRepo implements MemoryRepo {
  documents = new Map<string, string>();
  tip = "c0";
  failMode: "none" | "unavailable" | "conflict" = "none";
  pushes = 0;

  async ensureRepo(): Promise<string> {
    if (this.failMode === "unavailable") throw new Error("artifacts unavailable (simulated)");
    return "https://account.artifacts.cloudflare.net/git/cfos-memory/agent-memories.git";
  }

  async serverTip(): Promise<string | null> {
    return this.tip;
  }

  async fetchDocuments(currentCommit?: string): Promise<{
    commit: string;
    changed: boolean;
    documents: Map<string, string>;
  }> {
    if (this.failMode === "unavailable") throw new Error("artifacts unavailable (simulated)");
    let changed = this.tip !== (currentCommit ?? "");
    return { commit: this.tip, changed, documents: new Map(this.documents) };
  }

  async pushOps(ops: MemoryWriteOp[], _message: string, _author: string): Promise<string> {
    if (this.failMode === "conflict") {
      let err = new Error("push rejected (non-fast-forward)");
      err.name = "SyncConflictError";
      throw err;
    }
    if (this.failMode === "unavailable") throw new Error("artifacts unavailable (simulated)");
    for (let op of ops) {
      if (op.op === "write") this.documents.set(op.path, op.content ?? "");
      else this.documents.delete(op.path);
    }
    this.pushes++;
    this.tip = `c${this.pushes}`;
    return this.tip;
  }
}

// ---------------------------------------------------------------------------
// Fake clock + store factory
// ---------------------------------------------------------------------------

function makeClock(startIso = "2026-10-12T00:00:00Z") {
  let now = new Date(startIso);
  return {
    now: () => now,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

function makeStoreOn<T extends MemoryRepo | null = null>(db: SqlDb, repo: T = null as T) {
  let clock = makeClock();
  let store = new MemoryStoreCore(db, repo, { now: clock.now });
  return { store, repo, clock, db };
}

function makeStore<T extends MemoryRepo | null = null>(repo: T = null as T) {
  return makeStoreOn(new NodeSqlDb(), repo);
}

/** Runs fn, expecting it to reject with a MemoryStoreError; fails the test otherwise. */
async function expectError<T>(fn: () => Promise<T>): Promise<MemoryStoreError> {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(MemoryStoreError);
    return e as MemoryStoreError;
  }
  throw new Error("expected the call to reject with a MemoryStoreError");
}

/** The v1 (pre-owner) memories DDL, for building a hand-migrated database. */
const V1_MEMORIES_DDL = `CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK (type IN ('constraint','decision','failure','howto','preference')),
        title TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '',
        confidence REAL NOT NULL DEFAULT 0.5,
        version INTEGER NOT NULL DEFAULT 1,
        body TEXT NOT NULL,
        body_bytes INTEGER NOT NULL,
        path TEXT NOT NULL,
        commit_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        author TEXT NOT NULL DEFAULT '',
        scope TEXT NOT NULL DEFAULT '',
        embedding BLOB,
        embedded_at TEXT
      )`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("schema and zero-state", () => {
  it("stats() on a fresh store is a definitive empty state", async () => {
    let { store } = makeStore(null);
    let stats = await store.stats("acct-a");
    expect(stats).toEqual({
      total: 0,
      byType: { constraint: 0, decision: 0, failure: 0, howto: 0, preference: 0 },
      lastSync: "",
      dirty: 0,
      repoOk: true,
      semantic: false,
    });
  });

  it("help() explains methods, the write policy, the secret policy, and namespaces", async () => {
    let { store } = makeStore(null);
    let help = await store.help();
    expect(help).toContain("search(query");
    expect(help).toContain("Secrets NEVER");
    expect(help).toContain("d-YYYY-MM-DD-<slug>");
    expect(help).toContain("shared:true");
  });

  it("exports SCHEMA_VERSION 2", () => {
    expect(SCHEMA_VERSION).toBe("2");
  });
});

describe("add and search (no repo: local index only)", () => {
  it("add() writes the index and search() finds it with a TOON-shaped result", async () => {
    let { store } = makeStore(null);
    let res = await store.add({
      title: "Deploy Workers with Wrangler",
      type: "howto",
      body: "Run `wrangler deploy` after `pnpm build`.",
    }, "acct-a");
    expect(res.deduped).toBe(false);
    expect(res.id).toBe("d-2026-10-12-deploy-workers-with-wrangler");
    expect(res.commit).toBe("");

    let search = await store.search("wrangler", undefined, "acct-a");
    expect(search.total).toBe(1);
    expect(search.truncated).toBe(false);
    expect(search.results[0]).toEqual({
      id: res.id,
      type: "howto",
      title: "Deploy Workers with Wrangler",
      tags: "",
      confidence: 0.5,
      score: 11, // title hit ×10 + body hit ×1
      snippet: expect.stringContaining("wrangler") as unknown,
    });
  });

  it("normalizes tags and clamps confidence at write time", async () => {
    let { store } = makeStore(null);
    let res = await store.add({
      title: "Tagged memory",
      type: "preference",
      body: "b",
      tags: ["Z", "alpha", "z"],
      confidence: 5,
    }, "acct-a");
    let got = await store.get(res.id, undefined, "acct-a");
    expect(got.tags).toBe("z,alpha");
    expect(got.confidence).toBe(1);
  });

  it("records author and scope in frontmatter", async () => {
    let { store } = makeStore(null);
    let res = await store.add({
      title: "Authored memory",
      type: "decision",
      body: "b",
      author: "acct-7",
      scope: "fleet",
    }, "acct-a");
    let got = await store.get(res.id, undefined, "acct-a");
    expect(got.author).toBe("acct-7");
    let stats = await store.stats("acct-a");
    expect(stats.byType.decision).toBe(1);
    expect(stats.total).toBe(1);
  });

  it("search() with no matches returns a definitive empty state with a hint", async () => {
    let { store } = makeStore(null);
    let search = await store.search("kubernetes ingress", undefined, "acct-a");
    expect(search).toEqual({
      results: [],
      total: 0,
      truncated: false,
      hint: "0 memories found matching 'kubernetes ingress' — try broader terms, or add() to record what you learned",
    });
  });
});

describe("validation and secrets (structured errors, no outbox growth)", () => {
  it("rejects invalid inputs with VALIDATION", async () => {
    let { store } = makeStore(null);
    await expect(store.add({ title: "", type: "howto", body: "b" }, "acct-a"))
      .rejects.toMatchObject({
        code: "VALIDATION",
        message: expect.stringContaining("error:title must not be empty") as unknown,
      });
    await expect(store.add({ title: "x".repeat(201), type: "howto", body: "b" }, "acct-a"))
      .rejects.toMatchObject({ code: "VALIDATION" });
    await expect(store.add({ title: "t", type: "howto", body: "" }, "acct-a"))
      .rejects.toMatchObject({ code: "VALIDATION" });
    await expect(store.add({ title: "t", type: "note", body: "b" }, "acct-a"))
      .rejects.toMatchObject({ code: "VALIDATION" });
    // Nothing was enqueued
    let stats = await store.stats("acct-a");
    expect(stats.dirty).toBe(0);
    expect(stats.total).toBe(0);
  });

  it("refuses secret-shaped bodies with the exact §7 TOON error", async () => {
    let { store } = makeStore(null);
    let err = await expectError(() =>
      store.add({
        title: "Leaked credential",
        type: "failure",
        body: `the deploy used ghp_${"a".repeat(40)} by mistake`,
      }, "acct-a")
    );
    expect(err).toBeInstanceOf(MemoryStoreError);
    expect(err.code).toBe("SECRET_REFUSED");
    expect(err.message).toBe(
      "error:body contains a secret-shaped value (github token)\n" +
      "code:SECRET_REFUSED\n" +
      "help:strip the secret and re-add; store only where the secret lives (env var, vault), never its value",
    );
    let stats = await store.stats("acct-a");
    expect(stats.dirty).toBe(0);
    expect(stats.total).toBe(0);
  });

  it("refuses secret-shaped values in tags, author, and scope", async () => {
    let { store } = makeStore(null);
    let secret = "ghp_" + "a".repeat(40);
    await expect(store.add({ title: "t", type: "howto", body: "b", tags: `x,${secret}` }, "acct-a"))
      .rejects.toMatchObject({ code: "SECRET_REFUSED" });
    await expect(store.add({ title: "t", type: "howto", body: "b", author: secret }, "acct-a"))
      .rejects.toMatchObject({ code: "SECRET_REFUSED" });
    await expect(store.add({ title: "t", type: "howto", body: "b", scope: secret }, "acct-a"))
      .rejects.toMatchObject({ code: "SECRET_REFUSED" });
    let stats = await store.stats("acct-a");
    expect(stats.dirty).toBe(0);
    expect(stats.total).toBe(0);
  });

  it("refuses secret-shaped values in an update patch's tags without mutating the row", async () => {
    let { store } = makeStore(null);
    let res = await store.add({ title: "Update target", type: "decision", body: "b" }, "acct-a");
    await expect(store.update(res.id, { tags: "x,ghp_" + "a".repeat(40) }, "acct-a"))
      .rejects.toMatchObject({ code: "SECRET_REFUSED" });
    let got = await store.get(res.id, undefined, "acct-a");
    expect(got.tags).toBe("");
    expect(got.version).toBe(1);
    expect((await store.stats("acct-a")).dirty).toBe(0);
  });

  it("rejects unknown search type filters", async () => {
    let { store } = makeStore(null);
    await expect(store.search("*", { type: "note" }, "acct-a")).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

describe("dedup", () => {
  it("re-adding a near-identical title is a no-op success merging into the original", async () => {
    let { store } = makeStore(null);
    let first = await store.add({ title: "Kubernetes Ingress Setup", type: "howto", body: "A" }, "acct-a");
    let second = await store.add({ title: "kubernetes ingress setup", type: "howto", body: "B" }, "acct-a");
    expect(second.deduped).toBe(true);
    expect(second.mergedInto).toBe(first.id);
    expect(second.id).toBe(first.id);
    let stats = await store.stats("acct-a");
    expect(stats.total).toBe(1);
  });

  it("different topics do not dedup", async () => {
    let { store } = makeStore(null);
    await store.add({ title: "Kubernetes Ingress Setup", type: "howto", body: "A" }, "acct-a");
    let res = await store.add({ title: "Postgres Tuning Guide", type: "howto", body: "B" }, "acct-a");
    expect(res.deduped).toBe(false);
  });

  it("dedupCheck() reports without writing", async () => {
    let { store } = makeStore(null);
    let first = await store.add({ title: "Ingress Setup Guide", type: "howto", body: "A" }, "acct-a");
    let hit = await store.dedupCheck("ingress setup guide", "acct-a");
    expect(hit.deduped).toBe(true);
    expect(hit.mergedInto).toBe(first.id);
    let miss = await store.dedupCheck("totally different subject", "acct-a");
    expect(miss.deduped).toBe(false);
  });
});

describe("get: preview vs full body", () => {
  it("truncates the body to 1500 chars with a hint unless {full:true}", async () => {
    let { store } = makeStore(null);
    let long = "x".repeat(2000);
    let res = await store.add({ title: "Long memory", type: "howto", body: long }, "acct-a");

    let preview = await store.get(res.id, undefined, "acct-a");
    expect(preview.body.length).toBe(1500);
    expect(preview.bodyBytes).toBe(2000);
    expect(preview.hint).toBe("body truncated to 1500 chars; pass {full:true} for the complete body");

    let full = await store.get(res.id, { full: true }, "acct-a");
    expect(full.body).toBe(long);
    expect(full.hint).toBeUndefined();
  });

  it("get() on a missing id throws the exact §7 NOT_FOUND TOON error", async () => {
    let { store } = makeStore(null);
    let err = await expectError(() => store.get("d-2026-10-12-nope", undefined, "acct-a"));
    expect(err).toBeInstanceOf(MemoryStoreError);
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toBe(
      "error:no memory with id d-2026-10-12-nope\n" +
      "code:NOT_FOUND\n" +
      "help:list ids with search('*') or stats(); ids are d-YYYY-MM-DD-<slug>",
    );
  });
});

describe("update and delete", () => {
  it("update() bumps the version and writes through", async () => {
    let { store } = makeStore(null);
    let res = await store.add({ title: "Original", type: "decision", body: "v1 body" }, "acct-a");
    let updated = await store.update(res.id, { body: "v2 body", confidence: 0.9 }, "acct-a");
    expect(updated.version).toBe(2);
    let got = await store.get(res.id, undefined, "acct-a");
    expect(got.body).toBe("v2 body");
    expect(got.version).toBe(2);
    expect(got.confidence).toBe(0.9);
  });

  it("update() on a missing id throws NOT_FOUND; patch title length is validated", async () => {
    let { store } = makeStore(null);
    await expect(store.update("d-2026-10-12-missing", { body: "x" }, "acct-a"))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    let res = await store.add({ title: "T", type: "decision", body: "b" }, "acct-a");
    await expect(store.update(res.id, { title: "x".repeat(201) }, "acct-a"))
      .rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("delete() is idempotent", async () => {
    let { store } = makeStore(null);
    // Missing → no-op success
    let noop = await store.delete("d-2026-10-12-nope", "acct-a");
    expect(noop).toEqual({ id: "d-2026-10-12-nope", deleted: true, commit: "" });

    let res = await store.add({ title: "Doomed", type: "howto", body: "b" }, "acct-a");
    let deleted = await store.delete(res.id, "acct-a");
    expect(deleted.deleted).toBe(true);
    let again = await store.delete(res.id, "acct-a");
    expect(again.deleted).toBe(true);
    let stats = await store.stats("acct-a");
    expect(stats.total).toBe(0);
  });
});

describe("search modes and filters", () => {
  it("match-all '*' returns everything ordered by recency", async () => {
    let { store, clock } = makeStore(null);
    let a = await store.add({ title: "First memory", type: "decision", body: "a" }, "acct-a");
    clock.advance(1_000);
    let b = await store.add({ title: "Second memory", type: "howto", body: "b" }, "acct-a");
    let all = await store.search("*", undefined, "acct-a");
    expect(all.total).toBe(2);
    expect(all.results[0].id).toBe(b.id);
    expect(all.results[1].id).toBe(a.id);
    expect(all.results[0].score).toBe(0);
  });

  it("filters by type and by tag (including middle tags)", async () => {
    let { store } = makeStore(null);
    let a = await store.add({ title: "Ingress via Cloudflare", type: "howto", body: "x", tags: "alpha,beta,gamma" }, "acct-a");
    await store.add({ title: "Ingress via Nginx", type: "decision", body: "y" }, "acct-a");

    let howtos = await store.search("ingress", { type: "howto" }, "acct-a");
    expect(howtos.total).toBe(1);
    expect(howtos.results[0].id).toBe(a.id);

    let tagged = await store.search("*", { tag: "beta" }, "acct-a");
    expect(tagged.total).toBe(1);
    expect(tagged.results[0].id).toBe(a.id);

    let none = await store.search("*", { tag: "absent" }, "acct-a");
    expect(none.total).toBe(0);
  });

  it("regex mode scores per match; invalid regex is VALIDATION", async () => {
    let { store } = makeStore(null);
    await store.add({ title: "ingress-1 setup", type: "howto", body: "configure ingress-2 and ingress-3" }, "acct-a");
    let hits = await store.search("ingress-\\d", { regex: true }, "acct-a");
    expect(hits.total).toBe(1);
    expect(hits.results[0].score).toBe(12);
    let miss = await store.search("zzz-\\d", { regex: true }, "acct-a");
    expect(miss.total).toBe(0);
    await expect(store.search("(", { regex: true }, "acct-a")).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("limits results and reports truncation with a hint", async () => {
    let { store } = makeStore(null);
    await store.add({ title: "Result one alpha", type: "decision", body: "alpha" }, "acct-a");
    await store.add({ title: "Result two alpha", type: "decision", body: "alpha" }, "acct-a");
    await store.add({ title: "Result three alpha", type: "decision", body: "alpha" }, "acct-a");
    let limited = await store.search("alpha", { limit: 2 }, "acct-a");
    expect(limited.total).toBe(3);
    expect(limited.results.length).toBe(2);
    expect(limited.truncated).toBe(true);
    expect(limited.hint).toBe(`showing 2 of 3; pass limit to see more (max 50)`);
  });

  it("escapes LIKE wildcards in literal queries", async () => {
    let { store } = makeStore(null);
    let res = await store.add({ title: "100% sure thing", type: "decision", body: "b" }, "acct-a");
    let hits = await store.search("100%", undefined, "acct-a");
    expect(hits.total).toBe(1);
    expect(hits.results[0].id).toBe(res.id);
  });
});

describe("repo round-trip and reindex", () => {
  it("add() pushes frontmatter markdown to the repo and indexes it", async () => {
    let { store, repo } = makeStore(new MockRepo());
    let res = await store.add({
      title: "Round trip memory",
      type: "decision",
      body: "Body text.",
      tags: ["Z", "a"],
      confidence: 0.75,
      author: "acct-9",
      scope: "fleet",
    }, "acct-a");
    let path = `objects/decision/${res.id}.md`;
    expect(res.commit).toBe("c1");
    let content = repo.documents.get(path);
    expect(content).toBeDefined();
    let parsed = parseMemoryFile(content!);
    expect(parsed!.fm.id).toBe(res.id);
    expect(parsed!.fm.type).toBe("decision");
    expect(parsed!.fm.tags).toBe("z,a");
    expect(parsed!.fm.confidence).toBe(0.75);
    expect(parsed!.fm.author).toBe("acct-9");
    expect(parsed!.fm.scope).toBe("fleet");
    expect(parsed!.fm.owner).toBe("acct-a");
    expect(parsed!.body).toBe("Body text.");

    let got = await store.get(res.id, undefined, "acct-a");
    expect(got.body).toBe("Body text.");
  });

  it("picks up edits made directly in the repo (human git clone path)", async () => {
    let { store, repo, clock } = makeStore(new MockRepo());
    // Initial contact establishes the mirror at tip c0 (empty repo).
    await store.search("*", undefined, "acct-a");

    // A human edits via git clone: new file + new tip. The human writes shared memories
    // (owner '') — the clone path predates per-account namespaces.
    repo.documents.set("objects/decision/d-2026-10-11-human-edit.md", serializeMemoryFile({
      id: "d-2026-10-11-human-edit",
      type: "decision",
      title: "Human edited decision",
      tags: "human",
      confidence: 0.9,
      version: 1,
      created: "2026-10-11T00:00:00Z",
      updated: "2026-10-11T00:00:00Z",
      author: "human",
      scope: "",
      owner: "",
    }, "Human authored body."));
    repo.tip = "human-1";
    clock.advance(GIT_REFRESH_MIN_INTERVAL_MS + 1_000);

    let found = await store.search("human edited", undefined, "acct-b");
    expect(found.total).toBe(1);
    expect(found.results[0].id).toBe("d-2026-10-11-human-edit");

    // The human deletes the file: the index row disappears on the next refresh.
    repo.documents.delete("objects/decision/d-2026-10-11-human-edit.md");
    repo.tip = "human-2";
    clock.advance(GIT_REFRESH_MIN_INTERVAL_MS + 1_000);
    let gone = await store.search("human edited", undefined, "acct-b");
    expect(gone.total).toBe(0);
    expect((await store.stats("acct-b")).total).toBe(0);
  });

  it("serves the local mirror when the repo goes unavailable", async () => {
    let { store, repo, clock } = makeStore(new MockRepo());
    let res = await store.add({ title: "Cached memory", type: "howto", body: "cached body" }, "acct-a");

    repo.failMode = "unavailable";
    clock.advance(GIT_REFRESH_MIN_INTERVAL_MS + 1_000);

    let search = await store.search("cached", undefined, "acct-a");
    expect(search.total).toBe(1);
    let got = await store.get(res.id, undefined, "acct-a");
    expect(got.body).toBe("cached body");
    let stats = await store.stats("acct-a");
    expect(stats.repoOk).toBe(false);
  });
});

describe("outbox: repo-unavailable and sync-conflict paths", () => {
  it("a failed write queues in the outbox and reports REPO_UNAVAILABLE", async () => {
    let { store, repo } = makeStore(new MockRepo());
    repo.failMode = "unavailable";
    let err = await expectError(() =>
      store.add({ title: "Queued write", type: "decision", body: "b" }, "acct-a")
    );
    expect(err).toBeInstanceOf(MemoryStoreError);
    expect(err.code).toBe("REPO_UNAVAILABLE");
    expect(err.message).toBe(
      "error:memory repo unavailable; write queued in outbox\n" +
      "code:REPO_UNAVAILABLE\n" +
      "help:the write retries automatically; call stats() to check dirty/repoOk",
    );

    let stats = await store.stats("acct-a");
    expect(stats.dirty).toBe(1);
    expect(stats.repoOk).toBe(false);

    // Reads still work from the (empty) mirror
    let search = await store.search("queued", undefined, "acct-a");
    expect(search.total).toBe(0);
  });

  it("flushOutbox() lands the queued write once the repo recovers", async () => {
    let { store, repo } = makeStore(new MockRepo());
    repo.failMode = "unavailable";
    await store.add({ title: "Queued write", type: "decision", body: "b" }, "acct-a").catch(() => {});
    expect((await store.stats("acct-a")).dirty).toBe(1);

    repo.failMode = "none";
    await store.flushOutbox();

    let stats = await store.stats("acct-a");
    expect(stats.dirty).toBe(0);
    let search = await store.search("queued", undefined, "acct-a");
    expect(search.total).toBe(1);
  });

  it("a rejected push reports SYNC_CONFLICT and keeps the write in the outbox", async () => {
    let { store, repo } = makeStore(new MockRepo());
    repo.failMode = "conflict";
    let err = await expectError(() =>
      store.add({ title: "Conflicted write", type: "decision", body: "b" }, "acct-a")
    );
    expect(err.code).toBe("SYNC_CONFLICT");
    expect(err.message).toBe(
      "error:could not push after retries; memory kept locally in outbox\n" +
      "code:SYNC_CONFLICT\n" +
      "help:the write retries automatically from the outbox; call stats() to check dirty",
    );
    expect((await store.stats("acct-a")).dirty).toBe(1);
  });

  it("outbox replays that now fail validation drop the op instead of looping", async () => {
    let { store, repo } = makeStore(new MockRepo());
    repo.failMode = "unavailable";
    await store.add({ title: "Will become invalid", type: "decision", body: "b" }, "acct-a").catch(() => {});
    expect((await store.stats("acct-a")).dirty).toBe(1);

    repo.failMode = "none";
    await store.flushOutbox();
    expect((await store.stats("acct-a")).dirty).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// User scoping: private + shared namespaces
// ---------------------------------------------------------------------------

describe("user scoping: private namespaces", () => {
  it("a private memory is invisible to another account through every read path", async () => {
    let { store } = makeStore(null);
    let res = await store.add({ title: "A's private deploy note", type: "howto", body: "use pnpm build" }, "acct-a");

    // search: both match-all and term queries see nothing
    let all = await store.search("*", undefined, "acct-b");
    expect(all).toEqual({
      results: [],
      total: 0,
      truncated: false,
      hint: "0 memories found matching '*' — try broader terms, or add() to record what you learned",
    });
    let term = await store.search("deploy note", undefined, "acct-b");
    expect(term.total).toBe(0);

    // get: byte-exact NOT_FOUND TOON error
    let err = await expectError(() => store.get(res.id, undefined, "acct-b"));
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toBe(
      `error:no memory with id ${res.id}\n` +
      `code:NOT_FOUND\n` +
      `help:list ids with search('*') or stats(); ids are d-YYYY-MM-DD-<slug>`,
    );

    // stats: zero for B
    let statsB = await store.stats("acct-b");
    expect(statsB.total).toBe(0);
    expect(statsB.byType.howto).toBe(0);

    // dedupCheck: B cannot merge into a memory it cannot see
    let dupB = await store.dedupCheck("a's private deploy note", "acct-b");
    expect(dupB.deduped).toBe(false);

    // update/delete as B: NOT_FOUND / no-op, and A's row survives both
    let updErr = await expectError(() => store.update(res.id, { body: "hijacked" }, "acct-b"));
    expect(updErr.code).toBe("NOT_FOUND");
    let delB = await store.delete(res.id, "acct-b");
    expect(delB.deleted).toBe(true); // idempotent no-op
    let stillThere = await store.get(res.id, undefined, "acct-a");
    expect(stillThere.title).toBe("A's private deploy note");
    expect((await store.stats("acct-a")).total).toBe(1);
  });

  it("B cannot take over A's id: a private memory B can't see does not dedup or collide", async () => {
    let { store } = makeStore(null);
    await store.add({ title: "Shared Release Process", type: "howto", body: "b" }, "acct-a");
    // B writes a near-identical title: it must create its own row, not merge into A's private one
    let res = await store.add({ title: "shared release process", type: "decision", body: "c" }, "acct-b");
    expect(res.deduped).toBe(false);
    let statsA = await store.stats("acct-a");
    let statsB = await store.stats("acct-b");
    expect(statsA.total).toBe(1);
    expect(statsB.total).toBe(1);
    // A's invisible row still owns the base id, so B's gets the collision suffix
    expect(res.id).toBe("d-2026-10-12-shared-release-process-2");
  });

  it("shared memories ({shared:true}) are visible to every account", async () => {
    let { store } = makeStore(null);
    let res = await store.add({
      title: "Fleet-wide deploy convention",
      type: "decision",
      body: "deploy via scripts/deploy.ts",
      shared: true,
    }, "acct-a");

    // B sees it in search, get, stats, and dedupCheck
    let search = await store.search("deploy convention", undefined, "acct-b");
    expect(search.total).toBe(1);
    expect(search.results[0].id).toBe(res.id);
    let got = await store.get(res.id, undefined, "acct-b");
    expect(got.title).toBe("Fleet-wide deploy convention");
    expect((await store.stats("acct-b")).total).toBe(1);
    let dup = await store.dedupCheck("fleet-wide deploy convention", "acct-b");
    expect(dup.deduped).toBe(true);
    expect(dup.mergedInto).toBe(res.id);

    // A sees it too, plus can update and delete shared rows (and B then sees the change)
    await store.update(res.id, { body: "updated body" }, "acct-a");
    let updated = await store.get(res.id, undefined, "acct-b");
    expect(updated.body).toBe("updated body");
    expect(updated.version).toBe(2);

    // An empty viewer (no account context) sees the shared namespace only
    let anonSearch = await store.search("*");
    expect(anonSearch.total).toBe(1);
    expect(anonSearch.results[0].id).toBe(res.id);
  });

  it("add() without a viewer and without shared:true is refused (fail-closed)", async () => {
    let { store } = makeStore(null);
    let err = await expectError(() =>
      store.add({ title: "Orphan write", type: "howto", body: "b" })
    );
    expect(err.code).toBe("VALIDATION");
    expect(err.message).toBe(
      "error:add() requires a viewer (the caller's account id); pass shared:true to write to the shared namespace\n" +
      "code:VALIDATION\n" +
      "help:fix the input and retry; see help() for the write policy",
    );
    // A viewerless add with shared:true lands in the shared namespace
    let res = await store.add({ title: "Viewerless shared write", type: "howto", body: "b", shared: true });
    expect(res.deduped).toBe(false);
    expect((await store.stats("acct-b")).total).toBe(1);
  });

  it("empty-viewer reads see the shared namespace only, never private rows", async () => {
    let { store } = makeStore(null);
    await store.add({ title: "Private alpha", type: "decision", body: "b" }, "acct-a");
    await store.add({ title: "Shared beta", type: "decision", body: "b", shared: true }, "acct-a");

    let anon = await store.search("*");
    expect(anon.total).toBe(1);
    expect(anon.results[0].title).toBe("Shared beta");
    expect((await store.stats()).total).toBe(1);
  });
});

describe("user scoping: storage-layer enforcement", () => {
  it("every read path issues SQL carrying the owner-visibility predicate", async () => {
    let db = new RecordingSqlDb(new NodeSqlDb());
    let { store } = makeStoreOn(db, null);
    await store.add({ title: "Private memory", type: "howto", body: "b" }, "acct-a");

    let visibility = "(owner = '' OR owner = ?)";
    db.statements.length = 0;
    await store.search("private", undefined, "acct-b");
    expect(db.statements.some((s) => s.includes(visibility) && s.includes("FROM memories"))).toBe(true);

    db.statements.length = 0;
    await store.stats("acct-b");
    expect(db.statements.some((s) => s.includes(visibility))).toBe(true);

    db.statements.length = 0;
    await store.dedupCheck("private memory", "acct-b");
    expect(db.statements.some((s) => s.includes(visibility))).toBe(true);

    db.statements.length = 0;
    await expectError(() => store.get("d-2026-10-12-private-memory", undefined, "acct-b"));
    expect(db.statements.some((s) => s.includes(visibility))).toBe(true);
  });

  it("a row inserted by a scope-ignoring adapter is still invisible to other accounts", async () => {
    let { store, db } = makeStoreOn(new NodeSqlDb(), null);
    // Ensure the schema exists before the raw insert below
    await store.stats("acct-a");
    // Bypass the store API entirely — as an adapter that ignores scoping would
    db.exec(
      `INSERT INTO memories
       (id, type, title, tags, confidence, version, body, body_bytes, path, commit_hash,
         created_at, updated_at, author, scope, owner, embedding, embedded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
      "d-2026-10-12-raw-row", "decision", "Raw bypass row", "", 0.5, 1,
      "raw body", 9, "objects/decision/d-2026-10-12-raw-row.md", "c9",
      "2026-10-12T00:00:00Z", "2026-10-12T00:00:00Z", "acct-a", "fleet", "acct-a",
    );

    // No public read path as B can reach it
    expect((await store.search("*", undefined, "acct-b")).total).toBe(0);
    await expectError(() => store.get("d-2026-10-12-raw-row", undefined, "acct-b"));
    expect((await store.stats("acct-b")).total).toBe(0);
    expect((await store.dedupCheck("raw bypass row", "acct-b")).deduped).toBe(false);

    // A still sees it — ownership, not the insert path, decides visibility
    expect((await store.search("raw bypass", undefined, "acct-a")).total).toBe(1);
    expect((await store.stats("acct-a")).total).toBe(1);
  });
});

describe("v1 → v2 migration", () => {
  it("migrates an existing v1 database in place: adds owner, v1 rows become shared", async () => {
    let db = new NodeSqlDb();
    // Hand-build a v1 database: memories table without owner, sync tables, v1 schemaVersion
    db.exec(V1_MEMORIES_DDL);
    db.exec("CREATE TABLE IF NOT EXISTS sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.exec("CREATE TABLE IF NOT EXISTS embedding_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.exec(`CREATE TABLE IF NOT EXISTS write_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        op TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0
      )`);
    db.exec("INSERT OR REPLACE INTO sync_state (key, value) VALUES ('schemaVersion', '1')");
    db.exec(
      `INSERT INTO memories
       (id, type, title, tags, confidence, version, body, body_bytes, path, commit_hash,
         created_at, updated_at, author, scope, embedding, embedded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
      "d-2026-10-10-v1-memory", "decision", "V1 era memory", "fleet", 0.7, 1,
      "v1 body", 8, "objects/decision/d-2026-10-10-v1-memory.md", "c1",
      "2026-10-10T00:00:00Z", "2026-10-10T00:00:00Z", "acct-1", "fleet",
    );

    // Open the store over the same database: the migration must run on first use
    let { store } = makeStoreOn(db, null);
    let stats = await store.stats("acct-a");
    expect(stats.total).toBe(1);
    expect(stats.byType.decision).toBe(1);

    // The owner column exists now, and the v1 row is in the shared namespace
    let cols = db.exec<{ name: string }>("PRAGMA table_info(memories)").toArray();
    expect(cols.some((c) => c.name === "owner")).toBe(true);

    // Visible to every account — v1 was account-wide, so nothing is lost
    let forA = await store.get("d-2026-10-10-v1-memory", undefined, "acct-a");
    expect(forA.title).toBe("V1 era memory");
    expect(forA.body).toBe("v1 body");
    let forB = await store.search("v1 era", undefined, "acct-b");
    expect(forB.total).toBe(1);
    expect(forB.results[0].id).toBe("d-2026-10-10-v1-memory");

    // Data preserved, schema stamped
    let got = await store.get("d-2026-10-10-v1-memory", { full: true }, "acct-a");
    expect(got.body).toBe("v1 body");
    let schema = db.exec<{ value: string }>(
      "SELECT value FROM sync_state WHERE key = 'schemaVersion'",
    ).toArray();
    expect(schema[0].value).toBe("2");
  });

  it("reindexes v1 markdown files (no owner frontmatter) as shared", async () => {
    let repo = new MockRepo();
    // A v1-era file: identical frontmatter minus the owner line
    let v1File = serializeMemoryFile({
      id: "d-2026-10-09-legacy-file",
      type: "howto",
      title: "Legacy v1 file",
      tags: "legacy",
      confidence: 0.6,
      version: 2,
      created: "2026-10-09T00:00:00Z",
      updated: "2026-10-09T00:00:00Z",
      author: "acct-2",
      scope: "fleet",
      owner: "",
    }, "Legacy body.").replace(/^owner: .*\n/m, "");
    expect(v1File).not.toContain("owner:");
    repo.documents.set("objects/howto/d-2026-10-09-legacy-file.md", v1File);
    repo.tip = "legacy-1";

    let { store } = makeStore(repo);
    // First contact reindexes the repo contents
    let forB = await store.search("legacy", undefined, "acct-b");
    expect(forB.total).toBe(1);
    expect(forB.results[0].id).toBe("d-2026-10-09-legacy-file");
    let got = await store.get("d-2026-10-09-legacy-file", undefined, "acct-a");
    expect(got.title).toBe("Legacy v1 file");
    expect(got.body).toBe("Legacy body.");
  });

  it("replays a legacy v1 outbox payload (no viewer) into the shared namespace", async () => {
    let db = new NodeSqlDb();
    db.exec(V1_MEMORIES_DDL);
    db.exec("CREATE TABLE IF NOT EXISTS sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.exec("CREATE TABLE IF NOT EXISTS embedding_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.exec(`CREATE TABLE IF NOT EXISTS write_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        op TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0
      )`);
    // The v1 outbox payload shape: {args} with no viewer wrapper
    db.exec(
      "INSERT INTO write_outbox (op, payload, created_at) VALUES (?, ?, ?)",
      "add", JSON.stringify({ args: { title: "Legacy queued write", type: "decision", body: "b" } }),
      "2026-10-10T00:00:00Z",
    );

    let { store } = makeStoreOn(db, null);
    await store.flushOutbox();
    expect((await store.stats("acct-b")).total).toBe(1);
    let got = await store.get("d-2026-10-12-legacy-queued-write", undefined, "acct-b");
    expect(got.title).toBe("Legacy queued write");
    expect((await store.stats("acct-b")).dirty).toBe(0);
  });
});
