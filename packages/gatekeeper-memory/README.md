# Memory Gatekeeper

Durable agent memory: decisions with rationale, failures with root causes, how-tos, constraints,
and preferences, stored as markdown in one Git repository on
[Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/) and mirrored into a SQLite
Durable Object for fast reads. Each account gets a private namespace, plus one shared namespace
for the whole sharing boundary — visibility is enforced at the storage layer, not by convention.
Agents reach it through the `MEMORY` binding; humans can clone the repository and edit memories
with any Git client.

## Architecture

Two Durable Object classes, both in this Worker:

- **`MemoryGatekeeper`** — the `Gatekeeper<MemorySession>` facet the Workshop instantiates per
  account (the same role `ContextGatekeeper` plays for Context). It holds the pending-write store
  for the action queue and forwards everything else to storage.
- **`MemoryStorage`** — the physical store, keyed by `sharingDomain` and reached via
  `ctx.exports.MemoryStorage.getByName(...)`, so every account in a sharing boundary shares one
  index and one Git repo; it hosts every account's private namespace plus the shared namespace.

The split exists because facet identity is per (parent Durable Object, facet name): a facet cannot
globalize itself through props, and one physical store is what all namespaces share. A per-user
facet alone would have split the index and the repo; `MemoryStorage` is the globalizing move, and
`MemoryGatekeeper` stays per-user exactly like the rest of the Gatekeeper family, carrying the
account id that names each session's viewer.

`MemoryStorage` owns:

- the SQLite mirror (`memories`, `sync_state`, `write_outbox`, `embedding_meta` tables), applied
  via `ctx.storage.sql` on first use,
- the Git mirror at `/tmp/memory/agent-memories` (isomorphic-git, clone/fetch/push with
  short-lived repo-scoped tokens minted per operation and revoked in `finally`),
- a 15-minute alarm that refreshes the mirror, retries outbox writes, and (in v2) backfills
  embeddings.

## Namespaces: private + shared

Every memory carries an `owner`: an empty owner is the shared namespace (visible to every
account); an account id is that account's private namespace. The session passes its account id as
the viewer on every read and write, and visibility is enforced in the SQL layer — a private
memory is unreachable through any store method by construction. Writes are private by default;
`add()` with `shared: true` records into the shared namespace. Reads fail closed: without a
viewer, only the shared namespace is visible.

Data written by v1 (which predates namespaces and was account-wide by design) migrates to the
shared namespace on first use — in SQLite via an `ALTER TABLE` that adds the `owner` column, and
in Git by reading files without an `owner` frontmatter field as shared. The migration is
lossless: no v1 memory becomes invisible to its deployment.

## The agent surface

`MemoryStore`, as delivered by `getTypeScriptTypes()`:

- `search(query, opts?)` — literal substring prefilter plus token re-ranking (title hits weigh 10,
  body hits 1); `{ regex: true }` scores a regex against title and body; `'*'` matches everything.
- `get(id, opts?)` — body preview unless `{ full: true }`.
- `add(args)` / `update(id, patch)` / `delete(id)` — writes; `delete` is idempotent.
- `stats()` — `total`, `byType`, `lastSync`, `dirty`, `repoOk`, `semantic`.
- `help()` — the write policy, for the agent to read.

Every error is `{ error, code, help }` with codes
`NOT_FOUND | DUPLICATE | VALIDATION | SECRET_REFUSED | SYNC_CONFLICT | REPO_UNAVAILABLE | NOT_ENABLED`.
Bodies are capped at 64 KB, titles at 200 chars, and secret-shaped values (GitHub tokens,
`sk-` keys, bearer headers, AWS keys, Slack tokens, `password:`-style assignments) are refused
outright — no exceptions, no override. Near-duplicate titles (normalized-word-set Jaccard
similarity ≥ 0.85) merge into the existing memory instead of creating a new one.

## Writes flow through the action queue

`add`/`update`/`delete` submit a `memory.write` action and return synchronously with
`commit: "pending"` — the real Git commit only exists once the write is approved and pushed.
`getAutoApprovableActions()` reports the `memory.write` kind, so a user can make memory writes
always-allowed with the standard one-click approval rule; without the rule each write pauses for
approval like any other gatekeeper action. When the push fails (repository unavailable, non-fast-
forward after three replay attempts), the write sits in the store's outbox and the alarm retries
it; `stats().dirty` counts queued writes and `repoOk` reports repository health. Reads always
serve the last-good mirror.

## Human access

```
git clone https://<ACCOUNT_ID>.artifacts.cloudflare.net/git/cfos-memory/agent-memories.git
```

Tokens are minted in the Artifacts dashboard, up to one year of validity. Every memory is
`objects/<type>/<id>.md` with YAML frontmatter; hand edits are picked up on the next refresh
(at most a minute after a read, at latest the alarm).

## Deployment and setup

The starter wires this Worker into the deployment: the `GATEKEEPER_MEMORY` service binding on the
Workshop (with the `GatekeeperVendor` entrypoint, carrying the `sharingDomain` prop) and on the
router (no entrypoint), plus the `ARTIFACTS` and `AI` bindings and the `MEMORY_SEMANTIC` var on
the memory Worker itself. Memory shares the Context gatekeeper's `sharingDomain` boundary, so one
sharing domain sees one store.

The repository (`agent-memories` in the `cfos-memory` namespace) is created on first
use. Then open `/admin` and set the **Memory** Gatekeeper to enabled (or optional) — vendor
discovery is binding-driven, but accounts are only auto-provisioned for enabled vendors. Users
then approve memory writes individually or via the always-allow rule for `memory.write`.

## v2: semantic search (not yet shipped)

The `embedding`/`embedded_at` columns, the `embedding_meta` table, and the `MEMORY_SEMANTIC` var
are scaffolding for embedding-backed search (`@cf/baai/bge-small-en-v1.5` through the `AI`
binding). v1 ships literal search only with `MEMORY_SEMANTIC: "false"`; flipping the var before v2
exists does nothing.

## Development

```
pnpm --filter @gadgets/gatekeeper-memory test:run
pnpm --filter @gadgets/gatekeeper-memory build
```

Tests are a plain Node suite (no workerd pool): the store core takes an injected SQLite database
and an injected repository, so sync, dedup, the secret scan, outbox retries, and the TOON output
shapes all run against real SQLite semantics without Workers. Live Artifacts and Workshop action-
queue integration are not covered here; they need a deployed environment.
