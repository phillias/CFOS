// Memory gatekeeper worker: a durable, account-wide store of agent memories (decisions,
// failures, how-tos, constraints, preferences), mirrored to a Cloudflare Artifacts git repository
// so humans can clone and edit the same data. The vendor auto-provisions one account per user;
// each account exposes an agent singleton (MemoryGatekeeper) over the shared store.

export { MemoryStorage } from "./memory-storage.js";
export { GatekeeperVendor, MemoryAccount, MemoryGatekeeper } from "./memory-gatekeeper.js";
export { MemorySession } from "./memory-session.js";
export {
  MemoryStoreError,
  MEMORY_ERROR_CODES,
  type MemoryErrorCode,
  type MemoryStore,
  type MemorySearchResult,
  type MemoryGetResult,
  type MemoryAddResult,
  type MemoryUpdateResult,
  type MemoryDeleteResult,
  type MemoryStats,
} from "./memory-store.js";

/** Keep ES Module worker format; this worker is used over RPC/DOs, not HTTP. */
export default {
  async fetch(): Promise<Response> {
    return new Response("Memory gatekeeper worker is running.", {
      headers: { "content-type": "text/plain" },
    });
  },
};
