/**
 * Namespace all data for one Workshop binding. This prevents accidental mixing between trusted
 * deployments sharing a gatekeeper instance; it is not a boundary against malicious peer configs.
 * (Same contract as gatekeeper-context's domain.ts.)
 */
export const DEFAULT_SHARING_DOMAIN = "default";
