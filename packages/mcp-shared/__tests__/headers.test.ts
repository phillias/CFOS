import { afterEach, describe, expect, it, vi } from "vitest";

import { McpProtocolError } from "../src/client.js";
import { withClient, type ConnectionAccount, type McpConnection } from "../src/connection.js";
import { parseStaticHeaders } from "../src/headers.js";

afterEach(() => vi.unstubAllGlobals());

const SECRET = "sk-live-abcdef0123456789";

function accountWithHeaders(connection: Partial<McpConnection>): ConnectionAccount {
  return {
    async getConnection() {
      return { authorization: null, sessionId: null, generation: 1, ...connection };
    },
    async assertConnectionCurrent() {},
    async setMcpSessionId() { return true; },
    async noteCredentialsExpired() {},
  };
}

// Serves `initialize` and the follow-up notification, recording every request's headers.
function stubInitialize(recorded: Headers[]) {
  vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body));
    recorded.push(new Headers(init?.headers));
    if (request.method === "initialize") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }), {
        headers: { "Content-Type": "application/json", "Mcp-Session-Id": "new-session" },
      });
    }
    if (request.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { content: [] } }),
      { headers: { "Content-Type": "application/json" } });
  });
}

describe("parseStaticHeaders", () => {
  it("accepts valid rows and trims both fields", () => {
    expect(parseStaticHeaders([
      { name: " X-Api-Key ", value: " secret-123 " },
      { name: "", value: "" },
      { name: "   ", value: "   " },
    ])).toEqual({ ok: true, headers: [{ name: "X-Api-Key", value: "secret-123" }] });
  });

  it("requires both fields on a non-blank row", () => {
    expect(parseStaticHeaders([{ name: "", value: "secret" }]).ok).toBe(false);
    expect(parseStaticHeaders([{ name: "X-Api-Key", value: "" }]).ok).toBe(false);
    expect(parseStaticHeaders([{ name: "X-Api-Key" } as never]).ok).toBe(false);
  });

  it("rejects names the client sets or that are not tokens", () => {
    for (const name of ["Authorization", "authorization", "Host", "Content-Type",
      "Mcp-Session-Id", "MCP-Protocol-Version", "Transfer-Encoding"]) {
      expect(parseStaticHeaders([{ name, value: "x" }]).ok).toBe(false);
    }
    expect(parseStaticHeaders([{ name: "X Api Key", value: "x" }]).ok).toBe(false);
  });

  it("rejects duplicate names regardless of case", () => {
    const result = parseStaticHeaders([
      { name: "X-Api-Key", value: "one" },
      { name: "x-api-key", value: "two" },
    ]);
    expect(result.ok).toBe(false);
  });

  it("rejects control characters and oversized values", () => {
    expect(parseStaticHeaders([{ name: "X-Api-Key", value: "a\nb" }]).ok).toBe(false);
    expect(parseStaticHeaders([{ name: "X-Api-Key", value: "a\u0000b" }]).ok).toBe(false);
    expect(parseStaticHeaders([{ name: "X-Api-Key", value: "x".repeat(4097) }]).ok).toBe(false);
    expect(parseStaticHeaders([{ name: "X-Api-Key", value: "x".repeat(4096) }]).ok).toBe(true);
    expect(parseStaticHeaders([{ name: "x".repeat(129), value: "x" }]).ok).toBe(false);
    expect(parseStaticHeaders([{ name: "x".repeat(128), value: "x" }]).ok).toBe(true);
  });

  it("caps the number of headers", () => {
    const rows = Array.from({ length: 9 }, (_, i) => ({ name: `X-Header-${i}`, value: "x" }));
    expect(parseStaticHeaders(rows).ok).toBe(false);
    expect(parseStaticHeaders(rows.slice(0, 8)).ok).toBe(true);
  });
});

describe("static headers on the connection", () => {
  it("sends the account's headers with every request", async () => {
    const recorded: Headers[] = [];
    stubInitialize(recorded);
    const account = accountWithHeaders({
      authorization: null,
      sessionId: null,
      generation: 1,
      headers: [{ name: "X-Api-Key", value: SECRET }],
    });

    await withClient({}, account, "https://mcp.example.com", client => client.callTool("send", {}));

    expect(recorded.length).toBeGreaterThanOrEqual(2);
    for (const headers of recorded) {
      expect(headers.get("X-Api-Key")).toBe(SECRET);
    }
    // The client's own framing headers survive alongside the static ones.
    expect(recorded[0].get("Content-Type")).toBe("application/json");
  });

  it("drops static headers on a cross-origin redirect hop", async () => {
    const secondHopHeaders: Headers[] = [];
    let lastId: string | null = null;
    vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      let request: { id?: string; method?: string } = {};
      try { request = JSON.parse(String(init?.body)); } catch { /* bodyless redirect hop */ }
      if (request.method === "initialize") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }), {
          headers: { "Content-Type": "application/json", "Mcp-Session-Id": "new-session" },
        });
      }
      if (request.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      if (request.method === "tools/call") {
        lastId = request.id ?? null;
        return new Response(null, {
          status: 302,
          headers: { Location: "https://other.example.com/mcp" },
        });
      }
      secondHopHeaders.push(headers);
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: lastId, result: { content: [] } }),
        { headers: { "Content-Type": "application/json" } });
    });
    const account = accountWithHeaders({
      sessionId: "session",
      headers: [{ name: "X-Api-Key", value: SECRET }],
    });

    await withClient({}, account, "https://mcp.example.com",
      client => client.callTool("send", {})).catch(() => undefined);

    expect(secondHopHeaders.length).toBe(1);
    expect(secondHopHeaders[0].get("X-Api-Key")).toBeNull();
    expect(secondHopHeaders[0].get("Mcp-Session-Id")).toBeNull();
  });

  it("keeps static headers on a same-origin redirect hop", async () => {
    const secondHopHeaders: Headers[] = [];
    let lastId: string | null = null;
    vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      let request: { id?: string; method?: string } = {};
      try { request = JSON.parse(String(init?.body)); } catch { /* bodyless redirect hop */ }
      if (request.method === "initialize") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }), {
          headers: { "Content-Type": "application/json", "Mcp-Session-Id": "new-session" },
        });
      }
      if (request.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      if (request.method === "tools/call") {
        lastId = request.id ?? null;
        return new Response(null, { status: 302, headers: { Location: "/mcp-continued" } });
      }
      secondHopHeaders.push(headers);
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: lastId, result: { content: [] } }),
        { headers: { "Content-Type": "application/json" } });
    });
    const account = accountWithHeaders({
      sessionId: "session",
      headers: [{ name: "X-Api-Key", value: SECRET }],
    });

    await withClient({}, account, "https://mcp.example.com", client => client.callTool("send", {}));

    expect(secondHopHeaders.length).toBe(1);
    expect(secondHopHeaders[0].get("X-Api-Key")).toBe(SECRET);
  });

  it("redacts a header value a server echoes back in an error", async () => {
    vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      if (request.method === "initialize") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }), {
          headers: { "Content-Type": "application/json", "Mcp-Session-Id": "new-session" },
        });
      }
      if (request.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32000, message: `invalid credential ${SECRET} for this server` },
      }), { headers: { "Content-Type": "application/json" } });
    });
    const account = accountWithHeaders({
      authorization: null,
      sessionId: "session",
      generation: 1,
      headers: [{ name: "X-Api-Key", value: SECRET }],
    });

    const error = await withClient({}, account, "https://mcp.example.com",
      client => client.callTool("send", {})).catch(err => err);

    expect(error).toBeInstanceOf(McpProtocolError);
    expect(String(error.message)).not.toContain(SECRET);
    expect(String(error.message)).toContain("[redacted]");
  });
});
