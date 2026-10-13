declare namespace Cloudflare {
  interface Env {
    ARTIFACTS?: Artifacts;
    AI?: Ai;
    MEMORY_SEMANTIC?: string;
  }
  interface GlobalProps {
    mainModule: typeof import("./index.js");
    durableNamespaces: "MemoryGatekeeper" | "MemoryStorage";
  }
}
