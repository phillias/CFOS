// Static request headers for an MCP connection: per-endpoint credentials the user supplies on the
// connect form, stored server-side next to the connection's other credentials, and applied by
// `McpClient` to every request it sends to the endpoint. A header-authenticated server needs no
// OAuth, so a probe that succeeds with the headers connects without the authorization flow.
//
// Values are secrets. They are never returned over RPC, echoed back into the form, or logged; the
// client's server-text redaction includes them wherever the endpoint's own words come back.

/** One statically applied request header for an MCP connection. */
export type StaticHeader = {
  name: string;
  value: string;
};

/** Most headers one connection may carry. */
export const MAX_STATIC_HEADERS = 8;

/** Longest accepted header name. */
export const MAX_HEADER_NAME_CHARS = 128;

/** Longest accepted header value. */
export const MAX_HEADER_VALUE_CHARS = 4096;

// Headers this client sets itself, or that the transport controls. A user value for one would
// either be overwritten by the client or corrupt the request framing, so none can be supplied.
const BLOCKED_HEADERS = new Set([
  "accept",
  "authorization",
  "connection",
  "content-length",
  "content-type",
  "expect",
  "host",
  "mcp-protocol-version",
  "mcp-session-id",
  "transfer-encoding",
]);

// RFC 7230 `token`: the characters a header name may legally use.
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

// Field values may not carry line breaks or other control characters; rejecting all of them also
// rules out header smuggling through a folded or split value.
// oxlint-disable-next-line no-control-regex -- intentionally rejecting control chars (header-injection guard)
const HEADER_VALUE_CONTROL = /[\u0000-\u001f\u007f]/;

export type ParsedStaticHeaders =
  | { ok: true; headers: StaticHeader[] }
  | { ok: false; reason: string };

/**
 * Validates user-supplied header rows. A row left entirely blank is skipped; otherwise both fields
 * are required. Names and values are trimmed, then checked against the caps and the blocked set
 * above. The reason strings are shown on the connect form.
 */
export function parseStaticHeaders(
  entries: readonly { name: unknown; value: unknown }[],
): ParsedStaticHeaders {
  const headers: StaticHeader[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    const value = typeof entry.value === "string" ? entry.value.trim() : "";
    if (name === "" && value === "") continue;
    if (name === "") return { ok: false, reason: "A header row has a value but no name." };
    if (!HEADER_NAME.test(name)) {
      return { ok: false, reason: `"${name}" is not a valid header name.` };
    }
    const lower = name.toLowerCase();
    if (BLOCKED_HEADERS.has(lower)) {
      return { ok: false, reason: `"${name}" is set by this client and cannot be overridden.` };
    }
    if (seen.has(lower)) {
      return { ok: false, reason: `Header "${name}" appears more than once.` };
    }
    if (name.length > MAX_HEADER_NAME_CHARS) {
      return {
        ok: false,
        reason: `Header names are limited to ${MAX_HEADER_NAME_CHARS} characters.`,
      };
    }
    if (value === "") return { ok: false, reason: `Header "${name}" has a name but no value.` };
    if (value.length > MAX_HEADER_VALUE_CHARS) {
      return {
        ok: false,
        reason: `Header values are limited to ${MAX_HEADER_VALUE_CHARS} characters.`,
      };
    }
    if (HEADER_VALUE_CONTROL.test(value)) {
      return { ok: false, reason: `Header "${name}" values cannot contain control characters.` };
    }
    seen.add(lower);
    headers.push({ name, value });
  }
  if (headers.length > MAX_STATIC_HEADERS) {
    return {
      ok: false,
      reason: `At most ${MAX_STATIC_HEADERS} headers can be set per connection.`,
    };
  }
  return { ok: true, headers };
}
