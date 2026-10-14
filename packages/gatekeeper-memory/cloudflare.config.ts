import {
  CAPNWEB_VALIDATE_BUILD,
  OBSERVABILITY,
  defineGadgetsWorker,
  type DurableObjectMigration,
  type WranglerExtras,
} from "@gadgets/scripts/worker-config";

// The Memory gatekeeper worker: a store of durable agent memories with per-account private and
// shared namespaces, mirrored to a Cloudflare Artifacts git repository. The ARTIFACTS, AI, and
// MEMORY_SEMANTIC bindings are added at deploy time by the starter's deploy script, not here.

export default defineGadgetsWorker({
  name: "gatekeeper-memory",
  entrypoint: ".wrangler/validate/src/index.ts",
  compatibilityFlags: ["nodejs_compat", "allow_irrevocable_stub_storage"],
  observability: OBSERVABILITY,
});

/** Settings @cloudflare/config has no field for. */
export const wrangler: WranglerExtras = {
  build: CAPNWEB_VALIDATE_BUILD,
};

/** DO classes are reached via ctx.exports; no durable_objects binding needed. */
export const migrations: DurableObjectMigration[] = [
  {
    tag: "v0",
    new_sqlite_classes: ["MemoryGatekeeper", "MemoryStorage"],
  },
];
