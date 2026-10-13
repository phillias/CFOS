// MemoryStoreCore: the logic of the account-wide memory store over an injected SQL database and
// git repo mirror. All §7 methods live here; the MemoryStorage Durable Object wraps this class
// with ctx.storage.sql and the Artifacts git client. Node tests instantiate it with node:sqlite
// and a mock repo.

import {
  MEMORY_TYPES,
  MAX_BODY_PREVIEW_CHARS,
  MAX_SEARCH_LIMIT,
  DEDUP_PRESEARCH_LIMIT,
  buildSnippet,
  clampConfidence,
  isDuplicateTitle,
  literalScore,
  newMemoryId,
  normalizeTags,
  parseMemoryFile,
  scanForSecrets,
  serializeMemoryFile,
  validateBody,
  validateSearchLimit,
  validateTitle,
  validateType,
  type MemoryFrontmatter,
  type MemoryType,
} from "./memory-format.js";
import { logger } from "./observability.js";

// ---------------------------------------------------------------------------
// SQL abstraction (bridges workerd ctx.storage.sql and node:sqlite)
// ---------------------------------------------------------------------------

export type SqlValue = string | number | null | ArrayBuffer;

export interface SqlCursor<T extends Record<string, SqlValue>> {
  toArray(): T[];
}

export interface SqlDb {
  exec<T extends Record<string, SqlValue>>(sql: string, ...bindings: SqlValue[]): SqlCursor<T>;
}

// ---------------------------------------------------------------------------
// Repo abstraction (Artifacts git mirror)
// ---------------------------------------------------------------------------

export interface MemoryWriteOp {
  op: "write" | "remove";
  path: string;
  content?: string;
}

export interface MemoryRepo {
  /** Bootstrap the repo if missing; returns the remote URL. */
  ensureRepo(): Promise<string>;
  /** Cheap server-side tip check; returns the branch tip oid or null if no branch. */
  serverTip(): Promise<string | null>;
  /**
   * Fetch and read all markdown files under objects/. Returns the new tip commit and a map of
   * path to file content. Returns changed:false when the tip equals currentCommit.
   */
  fetchDocuments(currentCommit?: string): Promise<{
    commit: string;
    changed: boolean;
    documents: Map<string, string>;
  }>;
  /** Push write ops as one commit; returns the new tip commit. */
  pushOps(ops: MemoryWriteOp[], message: string, author: string): Promise<string>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const MEMORY_ERROR_CODES = [
  "NOT_FOUND",
  "DUPLICATE",
  "VALIDATION",
  "SECRET_REFUSED",
  "SYNC_CONFLICT",
  "REPO_UNAVAILABLE",
  "NOT_ENABLED",
] as const;
export type MemoryErrorCode = (typeof MEMORY_ERROR_CODES)[number];

export class MemoryStoreError extends Error {
  constructor(
    public code: MemoryErrorCode,
    public helpText: string,
    message: string,
  ) {
    super(`error:${message}\ncode:${code}\nhelp:${helpText}`);
    this.name = "MemoryStoreError";
  }
}

function notFound(id: string): MemoryStoreError {
  return new MemoryStoreError(
    "NOT_FOUND",
    "list ids with search('*') or stats(); ids are d-YYYY-MM-DD-<slug>",
    `no memory with id ${id}`,
  );
}

function validation(message: string): MemoryStoreError {
  return new MemoryStoreError(
    "VALIDATION",
    "fix the input and retry; see help() for the write policy",
    message,
  );
}

function secretRefused(finding: string): MemoryStoreError {
  return new MemoryStoreError(
    "SECRET_REFUSED",
    "strip the secret and re-add; store only where the secret lives (env var, vault), never its value",
    finding,
  );
}

function repoUnavailable(): MemoryStoreError {
  return new MemoryStoreError(
    "REPO_UNAVAILABLE",
    "the write retries automatically; call stats() to check dirty/repoOk",
    "memory repo unavailable; write queued in outbox",
  );
}

function syncConflict(): MemoryStoreError {
  return new MemoryStoreError(
    "SYNC_CONFLICT",
    "the write retries automatically from the outbox; call stats() to check dirty",
    "could not push after retries; memory kept locally in outbox",
  );
}

// ---------------------------------------------------------------------------
// Public result types (the MemoryStore RPC surface)
// ---------------------------------------------------------------------------

export interface MemorySearchResult {
  results: Array<{
    id: string;
    type: string;
    title: string;
    tags: string;
    confidence: number;
    score: number;
    snippet: string;
  }>;
  total: number;
  truncated: boolean;
  hint?: string;
}

export interface MemoryGetResult {
  id: string;
  type: string;
  title: string;
  tags: string;
  confidence: number;
  version: number;
  updated: string;
  author: string;
  body: string;
  bodyBytes: number;
  hint?: string;
}

export interface MemoryAddResult {
  id: string;
  deduped: boolean;
  mergedInto?: string;
  commit: string;
}

export interface MemoryUpdateResult {
  id: string;
  version: number;
  commit: string;
}

export interface MemoryDeleteResult {
  id: string;
  deleted: true;
  commit: string;
}

export interface MemoryStats {
  total: number;
  byType: Record<string, number>;
  lastSync: string;
  dirty: number;
  repoOk: boolean;
  semantic: boolean;
}

export interface MemoryStore {
  search(query: string, opts?: { type?: string; tag?: string; limit?: number; regex?: boolean }): Promise<MemorySearchResult>;
  get(id: string, opts?: { full?: boolean }): Promise<MemoryGetResult>;
  add(args: {
    title: string;
    type: string;
    body: string;
    tags?: string | string[];
    confidence?: number;
    author?: string;
    scope?: string;
  }): Promise<MemoryAddResult>;
  update(id: string, patch: {
    title?: string; body?: string; tags?: string | string[]; confidence?: number;
  }): Promise<MemoryUpdateResult>;
  delete(id: string): Promise<MemoryDeleteResult>;
  stats(): Promise<MemoryStats>;
  help(): Promise<string>;
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface MemoryRow {
  [key: string]: SqlValue;
  id: string;
  type: string;
  title: string;
  tags: string;
  confidence: number;
  version: number;
  body: string;
  body_bytes: number;
  path: string;
  commit_hash: string;
  created_at: string;
  updated_at: string;
  author: string;
  scope: string;
  embedding: ArrayBuffer | null;
  embedded_at: string | null;
}

interface OutboxRow {
  [key: string]: SqlValue;
  id: number;
  op: string;
  payload: string;
  created_at: string;
  attempts: number;
}

// ---------------------------------------------------------------------------
// Store core
// ---------------------------------------------------------------------------

export const SCHEMA_VERSION = "1";
export const GIT_REFRESH_MIN_INTERVAL_MS = 60_000;
export const MEMORY_REPO_NAME = "agent-memories";
export const MEMORY_BRANCH = "main";

export interface MemoryStoreCoreOpts {
  semantic?: boolean;
  now?: () => Date;
}

export class MemoryStoreCore implements MemoryStore {
  #db: SqlDb;
  #repo: MemoryRepo | null;
  #semantic: boolean;
  #now: () => Date;
  #schemaReady = false;

  constructor(db: SqlDb, repo: MemoryRepo | null, opts: MemoryStoreCoreOpts = {}) {
    this.#db = db;
    this.#repo = repo;
    this.#semantic = opts.semantic ?? false;
    this.#now = opts.now ?? (() => new Date());
  }

  // --- Schema ---

  #ensureSchema(): void {
    if (this.#schemaReady) return;
    let probe = this.#db.exec<{ n: number }>(
      "SELECT COUNT(*) as n FROM sqlite_master WHERE type = 'table' AND name = 'sync_state'",
    ).toArray();
    if (probe.length === 0 || probe[0].n === 0) {
      let ddl = [
      `CREATE TABLE IF NOT EXISTS memories (
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
      )`,
      `CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type)`,
      `CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories(updated_at DESC)`,
      `CREATE TABLE IF NOT EXISTS sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS embedding_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS write_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        op TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0
      )`,
      ];
      for (let sql of ddl) {
        this.#db.exec(sql);
      }
    }
    this.#db.exec(
      "INSERT OR REPLACE INTO sync_state (key, value) VALUES ('schemaVersion', ?)",
      SCHEMA_VERSION,
    );
    this.#schemaReady = true;
  }

  // --- Sync state helpers ---

  #getSyncState(key: string): string | null {
    let rows = this.#db.exec<{ value: string }>(
      "SELECT value FROM sync_state WHERE key = ?", key,
    ).toArray();
    return rows.length > 0 ? rows[0].value : null;
  }

  #setSyncState(key: string, value: string): void {
    this.#db.exec(
      "INSERT OR REPLACE INTO sync_state (key, value) VALUES (?, ?)", key, value,
    );
  }

  get #lastCommit(): string {
    return this.#getSyncState("commit") ?? "";
  }

  get #repoOk(): boolean {
    return this.#getSyncState("repoOk") !== "false";
  }

  #isoNow(): string {
    return this.#now().toISOString();
  }

  // --- Freshness ---

  /**
   * Refresh the git mirror if it's stale (≥ GIT_REFRESH_MIN_INTERVAL_MS since last fetch).
   * Serves the local SQLite mirror when the repo is unavailable.
   */
  async ensureFresh(): Promise<void> {
    this.#ensureSchema();
    if (!this.#repo) return;
    let lastFetchAt = this.#getSyncState("lastFetchAt");
    let elapsed = lastFetchAt ? this.#now().getTime() - Date.parse(lastFetchAt) : Infinity;
    if (elapsed < GIT_REFRESH_MIN_INTERVAL_MS) return;
    await this.#refreshFromRepo();
  }

  /** Fetch from the repo and re-index all markdown files under objects/ into SQLite. */
  async #refreshFromRepo(): Promise<void> {
    if (!this.#repo) return;
    try {
      await this.#repo.ensureRepo();
      let result = await this.#repo.fetchDocuments(this.#lastCommit);
      this.#setSyncState("lastFetchAt", this.#isoNow());
      this.#setSyncState("repoOk", "true");
      if (result.changed) {
        this.#reindex(result.commit, result.documents);
      }
    } catch (err) {
      logger.warn("memory repo fetch failed; serving local mirror", {
        event: "memory.repo.fetch.failed",
        error: err as Error,
      });
      this.#setSyncState("repoOk", "false");
      this.#setSyncState("lastFetchAt", this.#isoNow());
    }
  }

  /** Re-parse all fetched markdown files into SQLite. Idempotent; markdown is authoritative. */
  #reindex(commit: string, documents: Map<string, string>): void {
    this.#db.exec("BEGIN");
    try {
      // Delete rows whose paths are no longer present
      let existingPaths = this.#db.exec<{ path: string }>(
        "SELECT path FROM memories",
      ).toArray().map((r) => r.path);
      let docPaths = new Set(documents.keys());
      for (let path of existingPaths) {
        if (!docPaths.has(path)) {
          this.#db.exec("DELETE FROM memories WHERE path = ?", path);
        }
      }
      // Upsert each parsed file
      for (let [path, content] of documents) {
        let parsed = parseMemoryFile(content);
        if (!parsed) {
          logger.warn("skipping unparseable memory file", {
            event: "memory.file.unparseable.skipped",
            operation: "reindex",
            repoName: MEMORY_REPO_NAME,
            commit,
            bodyBytes: content.length,
            dirty: 0,
            attempts: 0,
            vendorId: "memory",
            memoryId: path,
            query: "",
            total: 0,
          });
          continue;
        }
        let fm = parsed.fm;
        let bodyBytes = new TextEncoder().encode(parsed.body).length;
        this.#db.exec(
          `INSERT OR REPLACE INTO memories
           (id, type, title, tags, confidence, version, body, body_bytes, path, commit_hash,
            created_at, updated_at, author, scope)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          fm.id, fm.type, fm.title, fm.tags, fm.confidence, fm.version,
          parsed.body, bodyBytes, path, commit,
          fm.created, fm.updated, fm.author, fm.scope,
        );
      }
      this.#setSyncState("commit", commit);
      this.#db.exec("COMMIT");
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
  }

  // --- Outbox ---

  #enqueueOutbox(op: string, payload: object): void {
    this.#db.exec(
      "INSERT INTO write_outbox (op, payload, created_at) VALUES (?, ?, ?)",
      op, JSON.stringify(payload), this.#isoNow(),
    );
  }

  get #dirtyCount(): number {
    return this.#db.exec<{ n: number }>(
      "SELECT COUNT(*) as n FROM write_outbox",
    ).toArray()[0].n;
  }

  /** Retry pending outbox ops (called from the alarm handler). */
  async flushOutbox(): Promise<void> {
    this.#ensureSchema();
    await this.ensureFresh();
    let rows = this.#db.exec<OutboxRow>(
      "SELECT * FROM write_outbox ORDER BY id ASC",
    ).toArray();
    for (let row of rows) {
      try {
        let payload = JSON.parse(row.payload);
        if (row.op === "add") {
          await this.#doAdd(payload.args ?? payload);
        } else if (row.op === "update") {
          await this.#doUpdate(payload.id, payload.patch);
        } else if (row.op === "delete") {
          await this.#doDelete(payload.id);
        }
        this.#db.exec("DELETE FROM write_outbox WHERE id = ?", row.id);
      } catch (err) {
        // Validation/secret/not-found failures mean the replay is no longer valid — drop the op.
        // Repo failures stay for the next alarm with attempts++.
        if (err instanceof MemoryStoreError) {
          this.#db.exec("DELETE FROM write_outbox WHERE id = ?", row.id);
          logger.warn("outbox op dropped after replay validation failure", {
            event: "memory.outbox.op.dropped",
            operation: "flushOutbox",
            repoName: MEMORY_REPO_NAME,
            commit: this.#lastCommit,
            bodyBytes: 0,
            dirty: this.#dirtyCount,
            attempts: row.attempts,
            vendorId: "memory",
            memoryId: "",
            query: "",
            total: 0,
            error: err,
          });
          continue;
        }
        this.#db.exec(
          "UPDATE write_outbox SET attempts = attempts + 1 WHERE id = ?", row.id,
        );
        logger.warn("outbox retry failed", {
          event: "memory.outbox.retry.failed",
          error: err as Error,
          operation: "flushOutbox",
          repoName: MEMORY_REPO_NAME,
          commit: this.#lastCommit,
          bodyBytes: 0,
          dirty: this.#dirtyCount,
          attempts: row.attempts + 1,
          vendorId: "memory",
          memoryId: "",
          query: "",
          total: 0,
        });
      }
    }
  }

  // --- Public API (MemoryStore) ---

  async search(
    query: string,
    opts?: { type?: string; tag?: string; limit?: number; regex?: boolean },
  ): Promise<{
    results: Array<{
      id: string; type: string; title: string; tags: string;
      confidence: number; score: number; snippet: string;
    }>;
    total: number;
    truncated: boolean;
    hint?: string;
  }> {
    this.#ensureSchema();
    await this.ensureFresh();

    let limit = validateSearchLimit(opts?.limit);
    let type = opts?.type ?? null;
    let tag = opts?.tag ? opts.tag.trim().toLowerCase() : null;
    let isMatchAll = query.trim() === "*" || query.trim() === "";

    // SQL LIKE prefilter (escape LIKE wildcards in the query)
    let conditions: string[] = [];
    let bindings: SqlValue[] = [];
    if (!isMatchAll && !opts?.regex) {
      let escaped = query.replace(/[\\%_]/g, (c) => `\\${c}`);
      conditions.push("(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')");
      bindings.push(`%${escaped}%`, `%${escaped}%`);
    }
    if (type) {
      if (!MEMORY_TYPES.includes(type as MemoryType)) {
        throw validation(`unknown type '${type}'`);
      }
      conditions.push("type = ?");
      bindings.push(type);
    }
    if (tag) {
      conditions.push("(tags = ? OR tags LIKE ? OR tags LIKE ? OR tags LIKE ?)");
      bindings.push(tag, `${tag},%`, `%,${tag}`, `%,${tag},%`);
    }
    let where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    let rows = this.#db.exec<MemoryRow>(
      `SELECT * FROM memories ${where} ORDER BY updated_at DESC LIMIT 500`,
      ...bindings,
    ).toArray();

    // JS token scoring re-rank
    let scored: Array<{ row: MemoryRow; score: number }> = [];
    if (opts?.regex) {
      let pattern: RegExp;
      try {
        pattern = new RegExp(query, "gi");
      } catch {
        throw validation(`invalid regex: ${query}`);
      }
      for (let row of rows) {
        let titleMatches = row.title.match(pattern)?.length ?? 0;
        let bodyMatches = row.body.match(pattern)?.length ?? 0;
        if (titleMatches === 0 && bodyMatches === 0) continue;
        scored.push({ row, score: titleMatches * 10 + bodyMatches * 1 });
      }
    } else if (isMatchAll) {
      scored = rows.map((row) => ({ row, score: 0 }));
    } else {
      for (let row of rows) {
        let score = literalScore(query, { title: row.title, body: row.body });
        if (score <= 0) continue;
        scored.push({ row, score });
      }
    }

    // Sort by score desc, then updated_at desc
    scored.sort((a, b) => b.score - a.score || b.row.updated_at.localeCompare(a.row.updated_at));

    let total = scored.length;
    let truncated = total > limit;
    let top = scored.slice(0, limit);
    let results = top.map(({ row, score }) => ({
      id: row.id,
      type: row.type,
      title: row.title,
      tags: row.tags,
      confidence: row.confidence,
      score,
      snippet: buildSnippet(query, row.body),
    }));

    let hint: string | undefined;
    if (total === 0) {
      hint = `0 memories found matching '${query}' — try broader terms, or add() to record what you learned`;
    } else if (truncated) {
      hint = `showing ${limit} of ${total}; pass limit to see more (max ${MAX_SEARCH_LIMIT})`;
    }

    return { results, total, truncated, hint };
  }

  async get(id: string, opts?: { full?: boolean }): Promise<{
    id: string; type: string; title: string; tags: string;
    confidence: number; version: number; updated: string; author: string;
    body: string; bodyBytes: number; hint?: string;
  }> {
    this.#ensureSchema();
    await this.ensureFresh();
    let rows = this.#db.exec<MemoryRow>(
      "SELECT * FROM memories WHERE id = ?", id,
    ).toArray();
    if (rows.length === 0) throw notFound(id);
    let row = rows[0];
    let full = opts?.full ?? false;
    let body = row.body;
    let hint: string | undefined;
    if (!full && body.length > MAX_BODY_PREVIEW_CHARS) {
      body = body.slice(0, MAX_BODY_PREVIEW_CHARS);
      hint = `body truncated to ${MAX_BODY_PREVIEW_CHARS} chars; pass {full:true} for the complete body`;
    }
    return {
      id: row.id,
      type: row.type,
      title: row.title,
      tags: row.tags,
      confidence: row.confidence,
      version: row.version,
      updated: row.updated_at,
      author: row.author,
      body,
      bodyBytes: row.body_bytes,
      hint,
    };
  }

  /**
   * Dedup pre-check without writing: normalized-title Jaccard ≥ threshold against recent
   * candidates. Used by the session pre-approval and by add() itself.
   */
  async dedupCheck(title: string): Promise<{ deduped: boolean; mergedInto?: string; commit: string }> {
    this.#ensureSchema();
    await this.ensureFresh();
    let hit = this.#findDuplicate(title);
    if (hit) {
      return { deduped: true, mergedInto: hit.id, commit: this.#lastCommit };
    }
    return { deduped: false, commit: this.#lastCommit };
  }

  #findDuplicate(title: string): MemoryRow | null {
    let candidates = this.#db.exec<MemoryRow>(
      "SELECT * FROM memories ORDER BY updated_at DESC LIMIT ?",
      DEDUP_PRESEARCH_LIMIT * 10,
    ).toArray();
    let lowerTitle = title.toLowerCase();
    let prefiltered = candidates.filter(
      (r) => r.title.toLowerCase().includes(lowerTitle.slice(0, 30)) || lowerTitle.includes(r.title.toLowerCase().slice(0, 30)),
    );
    for (let candidate of prefiltered.length > 0 ? prefiltered : candidates.slice(0, DEDUP_PRESEARCH_LIMIT)) {
      if (isDuplicateTitle(title, candidate.title)) {
        return candidate;
      }
    }
    return null;
  }

  async add(args: {
    title: string;
    type: string;
    body: string;
    tags?: string | string[];
    confidence?: number;
    author?: string;
    scope?: string;
  }): Promise<{ id: string; deduped: boolean; mergedInto?: string; commit: string }> {
    this.#ensureSchema();
    await this.ensureFresh();
    try {
      return await this.#doAdd(args);
    } catch (err) {
      // Caller errors (validation, secrets, not-found) are not repo failures — don't queue.
      if (err instanceof MemoryStoreError) throw err;
      this.#enqueueOutbox("add", { args });
      if (err instanceof Error && err.name === "SyncConflictError") {
        throw syncConflict();
      }
      throw repoUnavailable();
    }
  }

  /** Core add: validate → secret scan → dedup → push → index. Never touches the outbox. */
  async #doAdd(args: {
    title: string;
    type: string;
    body: string;
    tags?: string | string[];
    confidence?: number;
    author?: string;
    scope?: string;
  }): Promise<{ id: string; deduped: boolean; mergedInto?: string; commit: string }> {
    // Validate
    let titleError = validateTitle(args.title);
    if (titleError) throw validation(titleError);
    let bodyError = validateBody(args.body);
    if (bodyError) throw validation(bodyError);
    let typeError = validateType(args.type);
    if (typeError) throw validation(typeError);

    // Secret scan — no exceptions
    let finding = scanForSecrets(args.title, args.body);
    if (finding) throw secretRefused(finding);

    let tags = normalizeTags(args.tags);
    let confidence = clampConfidence(args.confidence);
    let author = args.author ?? "";
    let scope = args.scope ?? "";

    // Dedup check: literal pre-search on title, then Jaccard ≥0.85
    let duplicate = this.#findDuplicate(args.title);
    if (duplicate) {
      return {
        id: duplicate.id,
        deduped: true,
        mergedInto: duplicate.id,
        commit: this.#lastCommit,
      };
    }

    // New id
    let id = newMemoryId(args.title, this.#now());
    // Avoid id collision with different content
    let baseId = id;
    let suffix = 2;
    while (this.#db.exec<MemoryRow>("SELECT id FROM memories WHERE id = ?", id).toArray().length > 0) {
      id = `${baseId}-${suffix++}`;
    }

    let now = this.#isoNow();
    let path = `objects/${args.type}/${id}.md`;
    let fm: MemoryFrontmatter = {
      id, type: args.type as MemoryType, title: args.title, tags,
      confidence, version: 1, created: now, updated: now, author, scope,
    };
    let content = serializeMemoryFile(fm, args.body);

    if (!this.#repo) {
      // No repo configured: write directly to the index only
      this.#upsertRow(fm, args.body, path, this.#lastCommit);
      return { id, deduped: false, commit: this.#lastCommit };
    }
    let op = { op: "write" as const, path, content };
    let commit = await this.#repo.pushOps([op], `memory: add ${args.title}`, author);
    this.#upsertRow(fm, args.body, path, commit);
    this.#setSyncState("commit", commit);
    return { id, deduped: false, commit };
  }

  #upsertRow(fm: MemoryFrontmatter, body: string, path: string, commit: string): void {
    let bodyBytes = new TextEncoder().encode(body).length;
    this.#db.exec(
      `INSERT OR REPLACE INTO memories
       (id, type, title, tags, confidence, version, body, body_bytes, path, commit_hash,
        created_at, updated_at, author, scope)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      fm.id, fm.type, fm.title, fm.tags, fm.confidence, fm.version,
      body, bodyBytes, path, commit,
      fm.created, fm.updated, fm.author, fm.scope,
    );
  }

  async update(id: string, patch: {
    title?: string; body?: string; tags?: string | string[];
    confidence?: number;
  }): Promise<{ id: string; version: number; commit: string }> {
    this.#ensureSchema();
    await this.ensureFresh();
    try {
      return await this.#doUpdate(id, patch);
    } catch (err) {
      if (err instanceof MemoryStoreError) throw err;
      this.#enqueueOutbox("update", { id, patch });
      if (err instanceof Error && err.name === "SyncConflictError") {
        throw syncConflict();
      }
      throw repoUnavailable();
    }
  }

  /** Core update: fetch row → validate patch → push → index. Never touches the outbox. */
  async #doUpdate(id: string, patch: {
    title?: string; body?: string; tags?: string | string[];
    confidence?: number;
  }): Promise<{ id: string; version: number; commit: string }> {
    let rows = this.#db.exec<MemoryRow>(
      "SELECT * FROM memories WHERE id = ?", id,
    ).toArray();
    if (rows.length === 0) throw notFound(id);
    let row = rows[0];

    let newTitle = patch.title ?? row.title;
    let newBody = patch.body ?? row.body;
    let newTags = patch.tags !== undefined ? normalizeTags(patch.tags) : row.tags;
    let newConfidence = patch.confidence !== undefined ? clampConfidence(patch.confidence) : row.confidence;
    let newVersion = row.version + 1;

    let titleError = validateTitle(newTitle);
    if (titleError) throw validation(titleError);
    let bodyError = validateBody(newBody);
    if (bodyError) throw validation(bodyError);
    let finding = scanForSecrets(newTitle, newBody);
    if (finding) throw secretRefused(finding);

    let now = this.#isoNow();
    let fm: MemoryFrontmatter = {
      id: row.id,
      type: row.type as MemoryType,
      title: newTitle,
      tags: newTags,
      confidence: newConfidence,
      version: newVersion,
      created: row.created_at,
      updated: now,
      author: row.author,
      scope: row.scope,
    };
    let content = serializeMemoryFile(fm, newBody);

    if (!this.#repo) {
      this.#upsertRow(fm, newBody, row.path, this.#lastCommit);
      return { id, version: newVersion, commit: this.#lastCommit };
    }
    let op = { op: "write" as const, path: row.path, content };
    let commit = await this.#repo.pushOps([op], `memory: update ${newTitle}`, row.author);
    this.#upsertRow(fm, newBody, row.path, commit);
    this.#setSyncState("commit", commit);
    return { id, version: newVersion, commit };
  }

  async delete(id: string): Promise<{ id: string; deleted: true; commit: string }> {
    this.#ensureSchema();
    await this.ensureFresh();
    try {
      return await this.#doDelete(id);
    } catch (err) {
      if (err instanceof MemoryStoreError) throw err;
      this.#enqueueOutbox("delete", { id });
      if (err instanceof Error && err.name === "SyncConflictError") {
        throw syncConflict();
      }
      throw repoUnavailable();
    }
  }

  /** Core delete: push removal → drop index row. Idempotent; never touches the outbox. */
  async #doDelete(id: string): Promise<{ id: string; deleted: true; commit: string }> {
    let rows = this.#db.exec<MemoryRow>(
      "SELECT * FROM memories WHERE id = ?", id,
    ).toArray();
    // Idempotent: deleting a missing memory is a no-op success
    if (rows.length === 0) {
      return { id, deleted: true, commit: this.#lastCommit };
    }
    let row = rows[0];
    if (!this.#repo) {
      this.#db.exec("DELETE FROM memories WHERE id = ?", id);
      return { id, deleted: true, commit: this.#lastCommit };
    }
    let op = { op: "remove" as const, path: row.path };
    let commit = await this.#repo.pushOps([op], `memory: delete ${row.title}`, row.author);
    this.#db.exec("DELETE FROM memories WHERE id = ?", id);
    this.#setSyncState("commit", commit);
    return { id, deleted: true, commit };
  }

  async stats(): Promise<{
    total: number;
    byType: Record<string, number>;
    lastSync: string;
    dirty: number;
    repoOk: boolean;
    semantic: boolean;
  }> {
    this.#ensureSchema();
    await this.ensureFresh();
    let total = this.#db.exec<{ n: number }>(
      "SELECT COUNT(*) as n FROM memories",
    ).toArray()[0].n;
    let byType: Record<string, number> = {};
    for (let type of MEMORY_TYPES) byType[type] = 0;
    let typeRows = this.#db.exec<{ type: string; n: number }>(
      "SELECT type, COUNT(*) as n FROM memories GROUP BY type",
    ).toArray();
    for (let r of typeRows) byType[r.type] = r.n;
    let lastSync = this.#getSyncState("lastFetchAt") ?? "";
    return {
      total,
      byType,
      lastSync,
      dirty: this.#dirtyCount,
      repoOk: this.#repoOk,
      semantic: this.#semantic,
    };
  }

  async help(): Promise<string> {
    return [
      "Memory Store — durable cross-session memories (decisions, failures, how-tos, constraints, preferences).",
      "",
      "Methods:",
      "  search(query, opts?) — literal substring search over title+body; opts: {type, tag, limit (default 10, max 50), regex}",
      "    regex:true treats query as /pattern/ vs title+body",
      "  get(id, opts?) — fetch one memory; body truncated to 1500 chars unless {full:true}",
      "  add({title, type, body, tags?, confidence?, scope?}) — record a memory; idempotent (dedups on near-identical titles)",
      "  update(id, {title?, body?, tags?, confidence?}) — bump version and push",
      "  delete(id) — idempotent removal",
      "  stats() — totals, sync health, outbox depth",
      "",
      "Write policy:",
      "  Belongs: durable facts, decisions with rationale, constraints, how-tos, failures with root cause, preferences, env gotchas.",
      "  Not: transient state, scratch, conversation recap, large code bodies, repo-tracked things, PII beyond identity strings.",
      "  Secrets NEVER: token/key/password/API-key/Bearer patterns are scanned and refused.",
      "",
      "Call search() FIRST to avoid re-deriving known facts; add() to persist what you learned.",
      "Ids look like d-YYYY-MM-DD-<slug>; find them with search('*') or stats().",
    ].join("\n");
  }
}

// ---------------------------------------------------------------------------
// Frontend-facing type string (surfaced to agents via getTypeScriptTypes)
// ---------------------------------------------------------------------------

export const MEMORY_STORE_TYPES = `
/**
 * Durable cross-session memory store. Mirrored to a git repo humans can clone.
 * Call search() before re-deriving known facts; add() to persist durable learnings.
 */
interface MemoryStore {
  /** Literal substring search over title+body, relevance-ranked. Each call records an observation. */
  search(query: string, opts?: {
    type?: "constraint" | "decision" | "failure" | "howto" | "preference";
    tag?: string;
    limit?: number;   // default 10, max 50
    regex?: boolean;  // treat query as /pattern/ matching title+body
  }): Promise<{
    results: Array<{
      id: string; type: string; title: string; tags: string;
      confidence: number; score: number; snippet: string;
    }>;
    total: number; truncated: boolean; hint?: string;
  }>;

  /** Read one memory by id. Body truncated to 1500 chars unless {full:true}. */
  get(id: string, opts?: { full?: boolean }): Promise<{
    id: string; type: string; title: string; tags: string;
    confidence: number; version: number; updated: string; author: string;
    body: string; bodyBytes: number; hint?: string;
  }>;

  /** Record a memory. Idempotent: near-identical titles dedup (Jaccard >= 0.85) as a no-op. */
  add(args: {
    title: string;   // <= 200 chars
    type: "constraint" | "decision" | "failure" | "howto" | "preference";
    body: string;    // markdown, <= 64KB
    tags?: string | string[];
    confidence?: number;  // 0..1, default 0.5
    scope?: string;
  }): Promise<{ id: string; deduped: boolean; mergedInto?: string; commit: string }>;

  /** Update a memory; bumps version. */
  update(id: string, patch: {
    title?: string; body?: string; tags?: string | string[]; confidence?: number;
  }): Promise<{ id: string; version: number; commit: string }>;

  /** Delete a memory. Idempotent. */
  delete(id: string): Promise<{ id: string; deleted: true; commit: string }>;

  /** Store health: totals, sync status, outbox depth. */
  stats(): Promise<{
    total: number; byType: Record<string, number>; lastSync: string;
    dirty: number; repoOk: boolean; semantic: boolean;
  }>;

  /** Usage guide as text. */
  help(): Promise<string>;
}
`;
