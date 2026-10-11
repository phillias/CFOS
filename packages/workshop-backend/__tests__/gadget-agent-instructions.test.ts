// Per-gadget agent instructions ("persona"): the GadgetClient RPC surface (metadata editable
// without touching gadget code), the record field it persists to, and its injection into the
// system prompt's gadget sections. The prompt test drives the real runAgent against a real
// OverseerImpl, with pi's faux provider standing in for the model (see describe-binding.test.ts).

import { describe, expect, it } from "vitest";
import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import {
  createFauxCore, fauxAssistantMessage, fauxText, getCurrentSystemPrompt,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { AiChatAuthorInfo, Overseer } from "@gadgets/workshop-shared/api";
import { MAX_INSTANCE_INSTRUCTIONS_LENGTH } from "@gadgets/workshop-shared/api";
import { runAgent } from "../src/agent";
import type { OverseerDurableObject } from "../src/overseer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const OWNER_USER_ID = "owner-user-do";
const OWNER: AiChatAuthorInfo = { type: "user", id: "owner@example.com", name: "Owner" };
const CHAT_ID = 1;
const PERSONA = "Always answer in rhyme when editing this gadget.";

let doCounter = 0;

// Two permanent gadgets -- 100 "App" and 101 "Other" -- and a chat, so a turn can run. App
// carries a persona only when `persona` is given.
function seedWorkspace(impl: any, persona?: string): void {
  impl.storage.gadgets.put({
    type: "gadget", id: 100, title: "App", created: new Date(0), bindingName: "APP",
    bindings: {}, ...(persona !== undefined ? { agentInstructions: persona } : {}),
  });
  impl.storage.gadgets.put({
    type: "gadget", id: 101, title: "Other", created: new Date(0), bindingName: "OTHER",
    bindings: {},
  });
  impl.storage.chatMeta.put(
      { id: CHAT_ID, title: "Chat", started: new Date(0), lastActive: new Date(0) });
  impl.storage.chats.put({
    chatId: CHAT_ID, sequence: impl.nextChatSequence(CHAT_ID), timestamp: new Date(0),
    author: OWNER, type: "message", message: "Hi",
  });
}

// Runs one agent turn whose model immediately finishes, returning the system prompt it saw.
async function runTurn(impl: any): Promise<string> {
  let faux = createFauxCore({ models: [{ id: "faux-model" }] });
  let prompts: string[] = [];
  faux.setResponses([(context: TranscriptContext) => {
    prompts.push(getCurrentSystemPrompt(context.messages));
    return fauxAssistantMessage(fauxText("Done."));
  }]);
  await runAgent(impl, { model: faux.getModel(), stream: faux.stream }, CHAT_ID,
      { type: "agent", id: "faux-model", name: "Faux" }, new AbortController().signal, OWNER,
      { provider: "cloudflare", model: "faux-model", apiToken: "" } as any);
  return prompts[0];
}

interface Workspace { impl: any; client: Overseer; }

// Opens the real OverseerClientInterface (as the owner, build role) over a fresh Overseer, with
// the owner id planted directly and open()'s user-DO side effects stubbed (see
// blueprints.test.ts's withWorkspace).
async function withWorkspace(fn: (workspace: Workspace) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`gadget-persona-rpc-${++doCounter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: any }).impl;
    impl.ownerId = OWNER_USER_ID;
    impl.ensureAmbientCapsules = async () => {};
    impl.markOutputsDirty = () => {};
    impl.users = {
      idFromString: (id: string) => id,
      get: () => ({
        whoami: async () => OWNER,
        recordSharedGadgetOpen: async () => {},
      }),
    };
    using notifyClosed = new NativeRpcStub<() => void>(() => {});
    using client = await instance.open(OWNER_USER_ID, OWNER.id, notifyClosed);
    await fn({ impl, client });
  });
}

describe("gadget agent instructions", () => {
  it("injects the persona into the gadget's prompt section, and only that gadget's",
      () => withWorkspace(async ({ impl }) => {
    // Seed via the record directly, so the test covers the prompt path regardless of the RPC.
    seedWorkspace(impl, PERSONA);
    let prompt = await runTurn(impl);

    let app = prompt.indexOf(`## Gadget APP: "App"`);
    let other = prompt.indexOf(`## Gadget OTHER: "Other"`);
    let block = prompt.indexOf("<gadget_instructions>");
    expect(app).toBeGreaterThan(-1);
    expect(other).toBeGreaterThan(app);
    // The instructions land inside App's section, before Other's header.
    expect(block).toBeGreaterThan(app);
    expect(block).toBeLessThan(other);
    expect(prompt).toContain(
        `The owner of this workspace has provided the following additional instructions ` +
        `for working on this gadget. Follow them unless they conflict with the user's safety ` +
        `or the instructions above.`);
    expect(prompt).toContain(`<gadget_instructions>\n${PERSONA}\n</gadget_instructions>`);
    // Exactly one block: Other, which has no persona, gets none.
    expect(prompt.match(/<gadget_instructions>/g)?.length).toBe(1);
  }));

  it("persists, trims, clears, and length-caps the persona as gadget metadata",
      () => withWorkspace(async ({ impl, client }) => {
    seedWorkspace(impl);
    using gadget = await client.getGadget(100);
    await expect(gadget.getAgentInstructions()).resolves.toBe("");

    // Trimmed on write; visible through both the record and the agent's gadget info.
    await gadget.setAgentInstructions(`  ${PERSONA}  `);
    await expect(gadget.getAgentInstructions()).resolves.toBe(PERSONA);
    expect(impl.storage.gadgets.get(100).agentInstructions).toBe(PERSONA);
    expect(impl.listGadgetInfo(CHAT_ID).find(g => g.id === 100)?.agentInstructions)
        .toBe(PERSONA);

    // Blank text clears the field rather than storing an empty blob.
    await gadget.setAgentInstructions("   ");
    expect(impl.storage.gadgets.get(100).agentInstructions).toBeUndefined();
    await expect(gadget.getAgentInstructions()).resolves.toBe("");

    // Over the admin-instructions cap: rejected, and the record is left untouched.
    await expect(gadget.setAgentInstructions("x".repeat(MAX_INSTANCE_INSTRUCTIONS_LENGTH + 1)))
        .rejects.toThrow(/Instructions too long/);
    expect(impl.storage.gadgets.get(100).agentInstructions).toBeUndefined();
  }));
});
