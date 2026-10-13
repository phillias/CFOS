// MemorySession: the agent-facing RpcTarget returned by startSession(). Reads authorize
// observations; writes validate + secret-scan synchronously, then submit actions through the
// ApprovalQueue (auto-approvable via memory.write tag). The actual git push lands in
// MemoryGatekeeper.applyAction post-approval, which replays the pending op stored in the facet.

import { RpcTarget as NativeRpcTarget } from "cloudflare:workers";
import type { RpcStub as NativeRpcStub } from "cloudflare:workers";
import type { ApprovalQueue, ActionKind } from "@gadgets/workshop-shared/gatekeeper";
import { validateRpc } from "capnweb-validate";
import {
  MemoryStoreError,
  type MemoryAddResult,
  type MemoryDeleteResult,
  type MemoryGetResult,
  type MemorySearchResult,
  type MemoryStats,
  type MemoryUpdateResult,
} from "./memory-store.js";
import {
  clampConfidence,
  newMemoryId,
  normalizeTags,
  scanForSecrets,
  validateBody,
  validateTitle,
  validateType,
} from "./memory-format.js";
import { logger } from "./observability.js";

// ---------------------------------------------------------------------------
// The memory write ActionKind: what the workshop's auto-approval UI offers as "always allow".
// ---------------------------------------------------------------------------

export const MEMORY_WRITE_ACTION_KIND: ActionKind = {
  tag: "memory.write",
  label: "Record a memory",
};

// ---------------------------------------------------------------------------
// Storage stub (narrow interface over the MemoryStorage DO, reached via the facet)
// ---------------------------------------------------------------------------

export interface MemoryStorageStub {
  search(query: string, opts?: { type?: string; tag?: string; limit?: number; regex?: boolean }): Promise<MemorySearchResult>;
  get(id: string, opts?: { full?: boolean }): Promise<MemoryGetResult>;
  add(args: {
    title: string; type: string; body: string;
    tags?: string | string[]; confidence?: number; author?: string; scope?: string;
  }): Promise<MemoryAddResult>;
  update(id: string, patch: {
    title?: string; body?: string; tags?: string | string[]; confidence?: number;
  }): Promise<MemoryUpdateResult>;
  delete(id: string): Promise<MemoryDeleteResult>;
  stats(): Promise<MemoryStats>;
  help(): Promise<string>;
  dedupCheck(title: string): Promise<{ deduped: boolean; mergedInto?: string; commit: string }>;
}

// ---------------------------------------------------------------------------
// Pending write op payload (stored in the facet's own storage by the session)
// ---------------------------------------------------------------------------

export interface PendingWriteOp {
  kind: "add" | "update" | "delete";
  addArgs?: { title: string; type: string; body: string; tags?: string | string[]; confidence?: number; author?: string; scope?: string };
  updateArgs?: { id: string; patch: { title?: string; body?: string; tags?: string | string[]; confidence?: number } };
  deleteArgs?: { id: string };
}

/** Callbacks the facet provides so the session can record pending ops and mint action ids. */
export interface SessionContext {
  nextActionId(): Promise<number>;
  putPendingOp(actionId: number, op: PendingWriteOp): Promise<void>;
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

function validationError(message: string): MemoryStoreError {
  return new MemoryStoreError(
    "VALIDATION",
    "fix the input and retry; see help() for the write policy",
    message,
  );
}

function secretError(finding: string): MemoryStoreError {
  return new MemoryStoreError(
    "SECRET_REFUSED",
    "strip the secret and re-add; store only where the secret lives (env var, vault), never its value",
    finding,
  );
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

@validateRpc()
export class MemorySession extends NativeRpcTarget {
  #storage: MemoryStorageStub;
  #approvalQueue: NativeRpcStub<ApprovalQueue>;
  #accountId: string;
  #sessionContext: SessionContext;

  constructor(
    storage: MemoryStorageStub,
    approvalQueue: NativeRpcStub<ApprovalQueue>,
    accountId: string,
    sessionContext: SessionContext,
  ) {
    super();
    this.#storage = storage;
    this.#approvalQueue = approvalQueue;
    this.#accountId = accountId;
    this.#sessionContext = sessionContext;
  }

  [Symbol.dispose]() {
    this.#approvalQueue[Symbol.dispose]?.();
  }

  // --- Reads (observations) ---

  async search(
    query: string,
    opts?: { type?: string; tag?: string; limit?: number; regex?: boolean },
  ): Promise<MemorySearchResult> {
    let result = await this.#storage.search(query, opts);
    if (result.total > 0 || result.results.length > 0) {
      await this.#authorizeObservation(`searched '${query}' (${result.total} match${result.total === 1 ? "" : "es"})`);
    }
    return result;
  }

  async get(id: string, opts?: { full?: boolean }): Promise<MemoryGetResult> {
    let result = await this.#storage.get(id, opts);
    await this.#authorizeObservation(`read memory ${id} (${result.title})`);
    return result;
  }

  async stats(): Promise<MemoryStats> {
    let result = await this.#storage.stats();
    await this.#authorizeObservation(`read memory stats (${result.total} total, ${result.dirty} dirty)`);
    return result;
  }

  async help(): Promise<string> {
    return this.#storage.help();
  }

  // --- Writes (actions, auto-approvable via memory.write) ---

  async add(args: {
    title: string;
    type: string;
    body: string;
    tags?: string | string[];
    confidence?: number;
    author?: string;
    scope?: string;
  }): Promise<MemoryAddResult> {
    // Validate synchronously (fail fast before submitting)
    let titleErr = validateTitle(args.title);
    if (titleErr) throw validationError(titleErr);
    let bodyErr = validateBody(args.body);
    if (bodyErr) throw validationError(bodyErr);
    let typeErr = validateType(args.type);
    if (typeErr) throw validationError(typeErr);
    let finding = scanForSecrets(args.title, args.body);
    if (finding) throw secretError(finding);

    // Dedup pre-check: no write needed if we hit an existing memory
    let dedup = await this.#storage.dedupCheck(args.title);
    if (dedup.deduped && dedup.mergedInto) {
      return { id: dedup.mergedInto, deduped: true, mergedInto: dedup.mergedInto, commit: dedup.commit };
    }

    // Pre-compute the expected id for the response (actual id may differ if the date rolls or a
    // collision occurs; the agent can search() by title to find the landed memory).
    let expectedId = newMemoryId(args.title, new Date());

    // Record the pending op, then submit the action
    let actionId = await this.#sessionContext.nextActionId();
    await this.#sessionContext.putPendingOp(actionId, {
      kind: "add",
      addArgs: {
        title: args.title,
        type: args.type,
        body: args.body,
        tags: normalizeTags(args.tags),
        confidence: clampConfidence(args.confidence),
        author: args.author ?? this.#accountId,
        scope: args.scope ?? "",
      },
    });
    await this.#approvalQueue.submitAction(actionId, {
      title: `Memory: add "${args.title}"`,
      description: `Record a ${args.type} memory: ${args.title}`,
      actionKind: MEMORY_WRITE_ACTION_KIND,
      autoApprovable: true,
      awaitDecision: true,
      descriptionIsComplete: true,
      implementsRevert: false,
    });

    return { id: expectedId, deduped: false, commit: "pending" };
  }

  async update(id: string, patch: {
    title?: string; body?: string; tags?: string | string[]; confidence?: number;
  }): Promise<MemoryUpdateResult> {
    // Existence pre-check: surface NOT_FOUND synchronously
    await this.#storage.get(id);

    // Validate synchronously
    if (patch.title !== undefined) {
      let err = validateTitle(patch.title);
      if (err) throw validationError(err);
    }
    if (patch.body !== undefined) {
      let err = validateBody(patch.body);
      if (err) throw validationError(err);
    }
    if (patch.title !== undefined || patch.body !== undefined) {
      let finding = scanForSecrets(patch.title ?? "", patch.body ?? "");
      if (finding) throw secretError(finding);
    }

    let actionId = await this.#sessionContext.nextActionId();
    await this.#sessionContext.putPendingOp(actionId, {
      kind: "update",
      updateArgs: { id, patch: { title: patch.title, body: patch.body, tags: patch.tags, confidence: patch.confidence } },
    });
    await this.#approvalQueue.submitAction(actionId, {
      title: `Memory: update ${id}`,
      description: `Update memory ${id}`,
      actionKind: MEMORY_WRITE_ACTION_KIND,
      autoApprovable: true,
      awaitDecision: true,
      descriptionIsComplete: true,
      implementsRevert: false,
    });

    return { id, version: 0, commit: "pending" };
  }

  async delete(id: string): Promise<MemoryDeleteResult> {
    // Idempotent: deleting a missing memory is a no-op success (no action needed)
    try {
      await this.#storage.get(id);
    } catch {
      let stats = await this.#storage.stats();
      return { id, deleted: true, commit: stats.lastSync };
    }

    let actionId = await this.#sessionContext.nextActionId();
    await this.#sessionContext.putPendingOp(actionId, {
      kind: "delete",
      deleteArgs: { id },
    });
    await this.#approvalQueue.submitAction(actionId, {
      title: `Memory: delete ${id}`,
      description: `Delete memory ${id}`,
      actionKind: MEMORY_WRITE_ACTION_KIND,
      autoApprovable: true,
      awaitDecision: true,
      descriptionIsComplete: true,
      implementsRevert: false,
    });

    return { id, deleted: true, commit: "pending" };
  }

  // --- Internal ---

  async #authorizeObservation(description: string): Promise<void> {
    try {
      await this.#approvalQueue.authorizeObservation({
        title: "Memory observation",
        description,
      });
    } catch (err) {
      logger.warn("memory observation authorization failed", {
        event: "memory.observation.authorize.failed",
        operation: "authorizeObservation",
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
      throw err;
    }
  }
}
