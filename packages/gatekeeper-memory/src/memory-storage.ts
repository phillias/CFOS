// MemoryStorage: the account-wide shared Durable Object holding the SQLite memory index and
// the git mirror. Reached via ctx.exports.MemoryStorage.getByName(sharingDomain). All
// MemoryStore logic delegates to MemoryStoreCore over a ctx.storage.sql adapter.

import { DurableObject } from "cloudflare:workers";
import {
  MemoryStoreCore,
  type MemoryAddResult,
  type MemoryDeleteResult,
  type MemoryGetResult,
  type MemorySearchResult,
  type MemoryStats,
  type MemoryUpdateResult,
  type SqlCursor,
  type SqlDb,
  type SqlValue,
} from "./memory-store.js";
import { ArtifactsGitRepo } from "./memory-sync.js";
import { logger } from "./observability.js";

// ---------------------------------------------------------------------------
// ctx.storage.sql → SqlDb adapter
// ---------------------------------------------------------------------------

class WorkerdSqlDb implements SqlDb {
  #storage: DurableObjectStorage;

  constructor(storage: DurableObjectStorage) {
    this.#storage = storage;
  }

  exec<T extends Record<string, SqlValue>>(sql: string, ...bindings: SqlValue[]): SqlCursor<T> {
    return this.#storage.sql.exec<T>(sql, ...bindings);
  }
}

// ---------------------------------------------------------------------------
// Alarm backstop: refresh + outbox flush every 15 minutes
// ---------------------------------------------------------------------------

const ALARM_INTERVAL_MS = 15 * 60 * 1000;

type MemoryStorageProps = {
  sharingDomain: string;
};

/**
 * The shared storage DO. One instance per sharingDomain across the whole account; all users'
 * sessions funnel through it. Single-writer by DO semantics.
 */
export class MemoryStorage extends DurableObject<Cloudflare.Env, MemoryStorageProps> {
  #core: MemoryStoreCore | null = null;

  #store(): MemoryStoreCore {
    if (!this.#core) {
      let db = new WorkerdSqlDb(this.ctx.storage);
      let repo = this.env.ARTIFACTS
        ? new ArtifactsGitRepo(this.env.ARTIFACTS)
        : null;
      let semantic = this.env.MEMORY_SEMANTIC === "true" && this.env.AI !== undefined;
      this.#core = new MemoryStoreCore(db, repo, { semantic });
    }
    return this.#core;
  }

  async initialize(): Promise<void> {
    // Ensure schema is applied and the git mirror is fresh on first contact.
    await this.#store().ensureFresh();
    await this.ctx.storage.setAlarm(new Date(Date.now() + ALARM_INTERVAL_MS));
  }

  // --- Alarm: 15-min backstop for freshness + outbox retries ---

  async alarm(): Promise<void> {
    let store = this.#store();
    try {
      await store.ensureFresh();
      await store.flushOutbox();
    } catch (err) {
      logger.warn("memory alarm failed", {
        event: "memory.alarm.failed",
        operation: "alarm",
        repoName: "agent-memories",
        commit: "",
        bodyBytes: 0,
        dirty: 0,
        attempts: 0,
        vendorId: "memory",
        memoryId: "",
        query: "",
        total: 0,
        error: err as Error,
      });
    }
    await this.ctx.storage.setAlarm(new Date(Date.now() + ALARM_INTERVAL_MS));
  }

  // --- MemoryStore surface (validated by MemoryStoreCore internally) ---

  async search(
    query: string,
    opts?: { type?: string; tag?: string; limit?: number; regex?: boolean },
  ): Promise<MemorySearchResult> {
    return this.#store().search(query, opts);
  }

  async get(id: string, opts?: { full?: boolean }): Promise<MemoryGetResult> {
    return this.#store().get(id, opts);
  }

  async add(args: {
    title: string; type: string; body: string;
    tags?: string | string[]; confidence?: number; author?: string; scope?: string;
  }): Promise<MemoryAddResult> {
    return this.#store().add(args);
  }

  async update(id: string, patch: {
    title?: string; body?: string; tags?: string | string[]; confidence?: number;
  }): Promise<MemoryUpdateResult> {
    return this.#store().update(id, patch);
  }

  async delete(id: string): Promise<MemoryDeleteResult> {
    return this.#store().delete(id);
  }

  async stats(): Promise<MemoryStats> {
    return this.#store().stats();
  }

  async help(): Promise<string> {
    return this.#store().help();
  }

  async dedupCheck(title: string): Promise<{ deduped: boolean; mergedInto?: string; commit: string }> {
    return this.#store().dedupCheck(title);
  }

  /** Called by MemoryGatekeeper.applyAction to flush the outbox after a queued write. */
  async retryOutbox(): Promise<void> {
    await this.#store().flushOutbox();
  }
}
