// Memory gatekeeper: the agent-facing facet Durable Object, the auto-provisioned account, and
// the vendor entrypoint. The facet holds per-user pending write ops (action queue); all memory
// data lives in the MemoryStorage DO keyed by sharingDomain. Each account acts in its own
// private namespace plus the shared namespace, enforced by the storage layer — this facet
// carries the per-user viewer identity (accountId) that scopes every store call.

import {
  DurableObject,
  WorkerEntrypoint,
  RpcStub as NativeRpcStub,
} from "cloudflare:workers";
import { validateRpc, skipRpcValidation } from "capnweb-validate";
import type {
  VendorDescription,
  AccountDescription,
  GatekeeperUser,
  Gatekeeper,
  GatekeeperConnectCallback,
  GatekeeperConnectOptions,
  SupportedResource,
  AgentCatalog,
  ActionKind,
  ResourceDescription,
  ApprovalQueue,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  MemorySession,
  MEMORY_WRITE_ACTION_KIND,
  type MemoryStorageStub,
  type PendingWriteOp,
} from "./memory-session.js";
import { MEMORY_STORE_TYPES } from "./memory-store.js";
import { DEFAULT_SHARING_DOMAIN } from "./memory-domain.js";
import { logger } from "./observability.js";

// The Memory icon: the Phosphor "Brain" glyph as a self-contained SVG data URI.
const MEMORY_ICON = {
  url: "data:image/svg+xml," + encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256' fill='currentColor'>" +
    "<path d='M232,128a56,56,0,0,1-32,50.6A56,56,0,0,1,96,196v-4a52,52,0,0,1-45.3-26.4A48,48,0,0,1,32," +
    "72a48.6,48.6,0,0,1,8-.7A56,56,0,0,1,144,40h16a56,56,0,0,1,56,56v4A56,56,0,0,1,232,128Z'/>" +
    "</svg>"),
};

const MEMORY_CATALOG_ENTRY = {
  id: "memory",
  title: "Memory",
  description:
    "Search, record, and update durable cross-session memories (decisions, failures, how-tos, " +
    "constraints, preferences). Use search() before re-deriving known facts; add() to persist " +
    "durable learnings.",
};

// Persisted account props. No user identity; shared data keys by sharingDomain.
type MemoryAccountProps = {
  sharingDomain: string;
  accountId: string;
};

// ---------------------------------------------------------------------------
// MemoryAccount (auto-provisioned per user)
// ---------------------------------------------------------------------------

@validateRpc()
export class MemoryAccount
    extends WorkerEntrypoint<Cloudflare.Env, MemoryAccountProps>
    implements GatekeeperUser {
  async describe(): Promise<AccountDescription> {
    return {
      displayName: "Memory",
      avatar: MEMORY_ICON,
      singleton: { tsType: "MemoryStore" },
    };
  }

  /** Return the gadget-side session class, scoped by this account's props. */
  async getSingletonGatekeeperClass(): Promise<DurableObjectClass<Gatekeeper<any>>> {
    return this.ctx.exports.MemoryGatekeeper({
      props: { sharingDomain: this.ctx.props.sharingDomain, accountId: this.ctx.props.accountId },
    });
  }

  /** --- GatekeeperUser resource surface (no URL-addressed resources) --- */
  async getSupportedResources(): Promise<SupportedResource[]> {
    return [];
  }
  getGatekeeperClassFor(_url: string): never {
    throw new Error("Memory has no URL-addressed resources.");
  }
  startResourceConfigurator(_resourceUrlPattern: string): never {
    throw new Error("Memory has no URL-addressed resources.");
  }
  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }
  async revoke(): Promise<void> {
    // Shared memories survive account revocation; the revoked account's private namespace
    // stays in storage but is unreachable (no account id can name it again).
  }
  reconnect(): never {
    throw new Error("Memory is a singleton gatekeeper; it has no connect flow.");
  }
  commitReconnect(_stageId: string): never {
    throw new Error("Memory is a singleton gatekeeper; it has no connect flow.");
  }
  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }
  async getVerifier(): Promise<Fetcher<never>> {
    // No observer verification: the store is account-wide and reached only via ambient bindings.
    throw new Error("Memory has no observer verifier.");
  }
}

// ---------------------------------------------------------------------------
// MemoryGatekeeper (the facet DO; per-user session object)
// ---------------------------------------------------------------------------

@validateRpc()
export class MemoryGatekeeper
    extends DurableObject<Cloudflare.Env, MemoryAccountProps>
    implements Gatekeeper<MemorySession> {
  #storage(): MemoryStorageStub {
    return this.ctx.exports.MemoryStorage.getByName(this.ctx.props.sharingDomain) as MemoryStorageStub;
  }

  async describe(): Promise<ResourceDescription> {
    return {
      url: "memory://store",
      title: "Memory",
      snippet: "Search, record, and update durable cross-session memories.",
      suggestedBindingName: "MEMORY",
      tsType: "MemoryStore",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return MEMORY_STORE_TYPES;
  }

  /**
   * Not an observation: the catalog reaches every chat's prompt automatically, so nothing in it
   * may need observer verification.
   */
  async getAgentCatalog(): Promise<AgentCatalog> {
    return { entries: [MEMORY_CATALOG_ENTRY] };
  }

  /** Memory writes are auto-approvable once the user enables the memory.write rule. */
  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [MEMORY_WRITE_ACTION_KIND];
  }

  async startSession(approvalQueue: NativeRpcStub<ApprovalQueue>): Promise<MemorySession> {
    let ownedQueue = approvalQueue.dup();
    try {
      return new MemorySession(
        this.#storage(),
        ownedQueue,
        this.ctx.props.accountId,
        {
          nextActionId: () => this.#nextActionId(),
          putPendingOp: (actionId, op) => this.#putPendingOp(actionId, op),
        },
      );
    } catch (err) {
      ownedQueue[Symbol.dispose]?.();
      throw err;
    }
  }

  async #nextActionId(): Promise<number> {
    let counter = (await this.ctx.storage.get<number>("actionCounter")) ?? 0;
    counter++;
    await this.ctx.storage.put("actionCounter", counter);
    return counter;
  }

  async #putPendingOp(actionId: number, op: PendingWriteOp): Promise<void> {
    await this.ctx.storage.put(`pendingAction:${actionId}`, op);
  }

  async #getPendingOp(actionId: number): Promise<PendingWriteOp | null> {
    return (await this.ctx.storage.get<PendingWriteOp>(`pendingAction:${actionId}`)) ?? null;
  }

  async #deletePendingOp(actionId: number): Promise<void> {
    await this.ctx.storage.delete(`pendingAction:${actionId}`);
  }

  /** Apply a write op post-approval: replay it against the shared store. */
  async applyAction(action: number): Promise<void> {
    let op = await this.#getPendingOp(action);
    if (!op) {
      logger.warn("memory action applied with no pending op", {
        event: "memory.action.missing",
        operation: "applyAction",
        repoName: "agent-memories",
        commit: "",
        bodyBytes: 0,
        dirty: 0,
        attempts: 0,
        vendorId: "memory",
        memoryId: String(action),
        query: "",
        total: 0,
      });
      return;
    }
    let storage = this.#storage();
    // REPO_UNAVAILABLE / SYNC_CONFLICT already queued the write in the outbox inside the store;
    // rethrow so the workshop records the failure on the action.
    // The replay runs as the op's originating account (viewer), so it stays inside that
    // account's namespaces. Pending ops carry their viewer; an op recorded before the viewer
    // field existed (still pending across the v1→v2 deploy) has no viewer and fails validation
    // rather than replaying as shared. Only the store-core outbox replays legacy payloads.
    if (op.kind === "add" && op.addArgs) {
      await storage.add(op.addArgs, op.viewer);
    } else if (op.kind === "update" && op.updateArgs) {
      await storage.update(op.updateArgs.id, op.updateArgs.patch, op.viewer);
    } else if (op.kind === "delete" && op.deleteArgs) {
      await storage.delete(op.deleteArgs.id, op.viewer);
    }
    await this.#deletePendingOp(action);
  }

  async rejectAction(action: number): Promise<void | { restart?: boolean }> {
    await this.#deletePendingOp(action);
  }

  revertAction(_action: number):
      Promise<void | { message?: string; canRetry?: boolean; restart?: boolean }> {
    throw new Error("Memory writes cannot be reverted after commit; use update() or delete() instead.");
  }

  /** No observer verification: the store is account-wide and reached only via ambient bindings. */
  async addObserver(_id: string, _user: Fetcher<never>): Promise<void> {}
  async removeObserver(_id: string): Promise<void> {}
}

// ---------------------------------------------------------------------------
// GatekeeperVendor (the entrypoint bound as GATEKEEPER_MEMORY)
// ---------------------------------------------------------------------------

type GatekeeperVendorProps = {
  sharingDomain?: string;
};

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Cloudflare.Env, GatekeeperVendorProps> {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Memory",
      url: "https://workers.cloudflare.com/",
      logo: MEMORY_ICON,
      tagline: "Durable cross-session agent memory",
      description:
        "Search, record, and update durable cross-session memories (decisions, failures, " +
        "how-tos, constraints, preferences), mirrored to a git repository you can clone. " +
        "Enable this feature to let agents remember what they learn across sessions.",
      autoProvisionsAccount: true,
      providesAuth: false,
    };
  }

  @skipRpcValidation()
  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    let sharingDomain = this.ctx.props.sharingDomain ?? DEFAULT_SHARING_DOMAIN;
    return this.ctx.exports.MemoryAccount({
      props: { sharingDomain, accountId: crypto.randomUUID() },
    }) as unknown as Fetcher<GatekeeperUser>;
  }

  connectAccount(_callback: Fetcher<GatekeeperConnectCallback>,
                 _options?: GatekeeperConnectOptions): Promise<{ url: string }> {
    throw new Error("Memory is auto-provisioned; it has no connect flow.");
  }
  async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> {
    return [];
  }
  async getTypeScriptTypes(): Promise<string> {
    return MEMORY_STORE_TYPES;
  }
}
