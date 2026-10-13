import { createObservabilityContext } from "@gadgets/observability/observability-context";
import { createLogger } from "@gadgets/observability/logger";

export const VENDOR_ID = "memory";

/** Observability fields emitted by the Memory gatekeeper. */
export type MemoryObservabilityFields = {
  operation: string;
  repoName: string;
  commit: string;
  bodyBytes: number;
  dirty: number;
  attempts: number;
  vendorId: string;
  memoryId: string;
  query: string;
  total: number;
};

/** Ambient observability fields for one Memory gatekeeper operation. */
export const obsContext = createObservabilityContext<MemoryObservabilityFields>();

/** Module-scoped logger. */
export const logger = createLogger<MemoryObservabilityFields>({
  component: "gatekeeper.memory",
  vendorId: VENDOR_ID,
});
