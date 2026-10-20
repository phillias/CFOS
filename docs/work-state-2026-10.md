# Work state — October 2026

A snapshot of where this repository's exploration stood when it was wound down after the October
2026 pivot. The project explored a **personal AI operating system**: an account-scoped platform of
gadgets, agents, and gatekeepers with durable agent memory, per-agent personas, external service
integrations, and careful context management. This document, the git history, and the pull requests
linked below are the record of what was built and what was left parked, kept so the work can resume
without being re-derived.

## What was built

All feature work below is merged to `main`.

### Agent memory (`gatekeeper-memory`)

The largest workstream: **account-wide durable agent memory**, exposed to every gadget as an
ambient `MEMORY` binding. [packages/gatekeeper-memory/README.md](../packages/gatekeeper-memory/README.md)
is the authoritative in-repo description; the design decisions behind it (approved 2026-10-12), in
brief:

- A new package implementing the standard gatekeeper contract. The account's singleton is
  auto-provided to every workspace, so memory is always available without per-gadget wiring.
- **Source of truth is a private Artifacts git repo** (`cfos-memory/agent-memories`, auto-created on
  first use). Each memory is a markdown file at `objects/<type>/<id>.md` with YAML frontmatter
  (`id,type,title,tags,confidence,version,created,updated,author,scope`); ids are
  `d-YYYY-MM-DD-<slug>` — human-cloneable and diff-friendly.
- A **Durable Object SQLite index is a read cache** (tables `memories`, `sync_state`,
  `embedding_meta`, `write_outbox`); the git repo is authoritative. Sync is an isomorphic-git
  shallow clone + commit-push from a single-writer DO, with short-TTL repo tokens minted per batch
  and revoked after; the index is updated only after a successful push. A non-fast-forward remote
  triggers replay (≤3 attempts) before surfacing `SYNC_CONFLICT`; a write outbox plus a 15-minute
  alarm backstops failed writes; corruption triggers a reclone.
- API: seven typed methods (`search/get/add/update/delete/stats/help`), compact TOON-shaped outputs,
  and structured errors carrying a code
  (`NOT_FOUND|DUPLICATE|VALIDATION|SECRET_REFUSED|SYNC_CONFLICT|REPO_UNAVAILABLE|NOT_ENABLED`).
- Write policy: durable facts, decisions-with-rationale, constraints, how-tos,
  failures-with-root-cause, and preferences; 64KB body cap; near-duplicate writes (Jaccard ≥ 0.85)
  merge instead of append; a hard secret scan refuses credential-shaped content with no exceptions.
- **Semantic search was designed but deliberately left dark** ("v2"): Workers AI embeddings
  (`@cf/baai/bge-small-en-v1.5`, 384-d) cached as BLOBs in the index DO and scanned brute-force in
  JS (SQLite extensions cannot be loaded). It activates behind `MEMORY_SEMANTIC` only when literal
  search demonstrably needs it; v1 shipped with literal search and instrumentation first.

Merged in two PRs:

- [#13](https://github.com/phillias/CFOS/pull/13) (merged 2026-10-13) — the gatekeeper itself:
  storage engine, sync model, secret scanning, and release-manifest integration (fixture bundle and
  deploy-input classifications for a gatekeeper with no third-party OAuth credentials).
- [#14](https://github.com/phillias/CFOS/pull/14) (merged 2026-10-17) — **per-user namespaces**: a
  private namespace per account plus a shared one, enforced at the storage layer (owner column,
  empty = shared). Writes are private by default with an explicit `shared: true`; reads fail closed;
  the v0 → shared migration is lossless (owner-less git files read as shared). Writes submit to an
  action queue returning `commit: "pending"`, and the approval UI's one-click always-allow
  (`getAutoApprovableActions()`) keeps routine memory writes frictionless.

Deployment wiring lives in the
[cloudflare-os-starter](https://github.com/cloudflare/cloudflare-os-starter) repository: deploy
order in `scripts/deploy.ts`, store configuration under `memory.*` in `deployment.jsonc`. The
Workshop and router take a `GATEKEEPER_MEMORY` binding; the memory worker takes `ARTIFACTS` and
`AI` bindings plus the `MEMORY_SEMANTIC` flag.

### Per-gadget agent instructions — [#11](https://github.com/phillias/CFOS/pull/11)

Persona support: a per-gadget **agent instructions** field persisted server-side and injected into
the gadget's prompt section for both agent types. Empty means no prompt section. The editing UI
mirrors the `/admin` pattern, and a persona-bot blueprint demonstrates the feature.

### Static headers for user-connected MCP endpoints — [#10](https://github.com/phillias/CFOS/pull/10)

The MCP gatekeeper gained **static HTTP headers** for user-connected endpoints: stored server-side,
redacted on read-backs, with OAuth discovery skipped for endpoints that authenticate by header
instead.

### NVIDIA NIM via the gateway's native route — [#12](https://github.com/phillias/CFOS/pull/12)

NIM traffic moved from a custom `/compat` route (earlier commit `f9504eb`) to the AI Gateway's
**provider-specific native route**: tokenless binding transport with the provider key supplied by
the user (BYOK); the gateway token remains required only for Google. Includes the
`HTTPS_ONLY_PROVIDERS` update and tokenless tests.

## What was investigated but not built

### Agent-operations scoping

A survey mapping five external agent-ops capabilities onto this codebase's extension points, with
effort estimates and a cheapest-first ordering:

- **Log sanitization** (small): the one verified gap — policy exists but nothing redacts the error
  pipeline or model input. A shared redaction module at two choke points was judged the cheapest
  win.
- **Value-free secrets inspection** (medium): expose fingerprints/names/booleans about configured
  secrets via a gatekeeper, never values — largely satisfied here by construction, since agents see
  curated bindings rather than raw environment.
- **Model catalog discovery** (medium): a scheduled probe worker writing observations, with
  human-in-the-loop admin suggestions; flagged the risk of double-building what the gateway already
  provides.
- **Vault-backed secrets** (medium): a gatekeeper bridging an external vault, with full-value reads
  approval-gated.
- **Dynamic context pruning** (large): the platform already compacts at a threshold with
  checkpoints; the missing pieces were model-invoked compression, shunting content to storage, and
  dedup/purge — flagged as risky against the replay contract.

A supervision-layer sketch mapped an external task supervisor onto platform primitives: a task
registry on D1 + Artifacts, DO alarms as the wake queue, chat as the steering plane, per-task gadget
isolation, and the approval queue as the decision surface. A lighter "bridge" shape was also
sketched — running the supervisor's work through workshops behind an Access-gated task API.

### External comparisons

- **Clopinette-ai** (single-Worker personal assistant): a different layer than this platform, but a
  rich source of adoptable patterns, in priority order: context compression (structured summary +
  iterative merge at a message threshold), memory security scanning (invisible-Unicode and homoglyph
  detection), smart routing of simple turns to a smaller model, error taxonomies with fallback,
  parallel fact-flush before compression, hybrid keyword+vector search, periodic self-learning
  review, a code-mode sandbox, and messaging-gateway integrations.
- **cloudroom-core** (Rust harness orchestrating multiple coding-agent CLIs on a Linux VM): the
  strongest OSS reference found for heterogeneous-agent orchestration — idempotent durable receipts,
  queued prompts, sleep/recovery, native-auth passthrough (never storing OAuth), capability
  advertisement, quota-aware recovery. Its spine is portable; its process/cgroup/disk isolation is
  irreducibly Linux and was never to be ported to Workers.

A three-layer synthesis was sketched from these: an assistant layer, an execution layer (a VM
bridged in as a tool), and this platform as the governance layer keeping the approval queue.

## Parked

One-line reminders of areas noted but not started:

- **Context management** — dynamic pruning beyond threshold compaction (see agent-ops scoping).
- **Model catalog probe** — scheduled discovery feeding admin suggestions.
- **Namespaced memory ids** — richer memory id schemes beyond the owner column.
- **Messaging** — messaging-platform gateways for agent conversations.
- **Self-learning memory** — periodic review that promotes recurring patterns into memory.
- **Semantic memory** — activating the dark `MEMORY_SEMANTIC` path (see above).
- **Usage patterns** — documenting real usage and tuning defaults from it.
- **VM provisioning** — provisioning execution VMs and bridging them in as tools.
- **Customer isolation** — one deployment per customer as the tenant boundary.

## Resuming work

- The memory gatekeeper is fully merged: [#13](https://github.com/phillias/CFOS/pull/13) and
  [#14](https://github.com/phillias/CFOS/pull/14). Start from
  [packages/gatekeeper-memory/README.md](../packages/gatekeeper-memory/README.md); deployment wiring
  is in the [starter repository](https://github.com/cloudflare/cloudflare-os-starter)
  (`scripts/deploy.ts`, `deployment.jsonc`).
- The memory design record (approved decisions and rationale) is summarized in this document.
  Per-feature design docs live under [plans/](../plans/); topical docs live beside this one in
  [docs/](.).
- The only open pull requests on this repository are dependency bumps; no feature work is in flight.
