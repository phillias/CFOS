// Artifacts git mirror for the Memory store: bootstrap, shallow clone/fetch for reads, and
// single-writer push for writes (with non-FF retry). Adapted from gatekeeper-context's
// artifact-sync.ts; cannot import it because NO upstream package changes are allowed.

import {
  add as gitAdd,
  checkout as gitCheckout,
  commit as gitCommit,
  clone,
  fetch,
  init as gitInit,
  listFiles as listGitFiles,
  listServerRefs,
  push,
  readBlob,
  remove as gitRemove,
  resolveRef,
  statusMatrix,
  writeRef as gitWriteRef,
} from "isomorphic-git";
import { request as baseHttpRequest } from "isomorphic-git/http/web";
import type { GitHttpResponse, HttpClient } from "isomorphic-git/http/web";
import * as fs from "node:fs";
import { promises as fsp } from "node:fs";
import { posix as posixPath } from "node:path";
import type { MemoryRepo, MemoryWriteOp } from "./memory-store.js";
import { MEMORY_BRANCH, MEMORY_REPO_NAME } from "./memory-store.js";
import { logger } from "./observability.js";

const MAX_GIT_DIR_BYTES = 64 * 1024 * 1024;
const WRITE_TOKEN_TTL_SECONDS = 3600;
const PUSH_RETRY_LIMIT = 3;

class SyncConflictError extends Error {
  constructor() {
    super("Git push failed after retries (non-fast-forward or rejected).");
    this.name = "SyncConflictError";
  }
}

class GitTransferTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Repository too large: Git transfer exceeded ${maxBytes} bytes.`);
    this.name = "GitTransferTooLargeError";
  }
}

async function* limitBody(body: AsyncIterableIterator<Uint8Array>, maxBytes: number): AsyncIterableIterator<Uint8Array> {
  let seenBytes = 0;
  for await (let chunk of body) {
    seenBytes += chunk.byteLength;
    if (seenBytes > maxBytes) throw new GitTransferTooLargeError(maxBytes);
    yield chunk;
  }
}

function makeHttp(maxBytes: number): HttpClient {
  return {
    async request(request): Promise<GitHttpResponse> {
      let response = await baseHttpRequest(request);
      return response.body
        ? { ...response, body: limitBody(response.body, maxBytes) }
        : response;
    },
  };
}

function isEnoent(err: unknown): boolean {
  return err instanceof Error && "code" in err && err.code === "ENOENT";
}

/** A git op failed because the path is not in the index/worktree (isomorphic-git NotFoundError or fs ENOENT). */
function isMissingPath(err: unknown): boolean {
  let code = (err as { code?: unknown })?.code;
  let message = err instanceof Error ? err.message : String(err);
  return code === "ENOENT" || code === "NotFoundError" || /not found/i.test(message);
}

async function dirSizeBytes(dir: string): Promise<number> {
  let entries = await fsp.readdir(dir, { withFileTypes: true }).catch((err) => {
    if (isEnoent(err)) return [];
    throw err;
  });
  let size = 0;
  for (let entry of entries) {
    let path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      size += await dirSizeBytes(path);
    } else if (entry.isFile()) {
      size += await fsp.stat(path).then(stat => stat.size, (err) => {
        if (isEnoent(err)) return 0;
        throw err;
      });
    }
  }
  return size;
}

async function gitdirStats(dir: string): Promise<{ exists: boolean; sizeBytes: number }> {
  let exists = await fsp.stat(`${dir}/.git`).then(stat => stat.isDirectory(), () => false);
  return {
    exists,
    sizeBytes: exists ? await dirSizeBytes(dir) : 0,
  };
}

async function deleteCachedRepo(dir: string): Promise<void> {
  await fsp.rm(dir, { recursive: true, force: true }).catch((cleanupErr) => {
    if (isEnoent(cleanupErr)) return;
    logger.warn("failed to clean up Artifacts git cache", {
      event: "memory.git.cache.cleanup.failed",
      operation: "deleteCachedRepo",
      repoName: MEMORY_REPO_NAME,
      commit: "",
      bodyBytes: 0,
      dirty: 0,
      attempts: 0,
      vendorId: "memory",
      memoryId: "",
      query: "",
      total: 0,
      error: cleanupErr as Error,
    });
  });
}

async function cloneRepo(dir: string, url: string, onAuth: () => { username: string; password: string }): Promise<void> {
  try {
    await fsp.mkdir(dir, { recursive: true });
    await clone({
      fs,
      http: makeHttp(MAX_GIT_DIR_BYTES),
      dir,
      url,
      ref: MEMORY_BRANCH,
      singleBranch: true,
      depth: 1,
      noCheckout: true,
      noTags: true,
      onAuth,
    });
  } catch (err) {
    logger.warn("memory git clone failed; cleaning up partial clone", {
      event: "memory.git.clone.failed",
      operation: "cloneRepo",
      repoName: MEMORY_REPO_NAME,
      commit: "",
      bodyBytes: 0,
      dirty: 0,
      attempts: 0,
      vendorId: "memory",
      memoryId: "",
      query: "",
      total: 0,
      error: err as Error,
    });
    await deleteCachedRepo(dir);
    throw err;
  }
}

async function recloneRepo(dir: string, url: string, onAuth: () => { username: string; password: string }): Promise<string> {
  await deleteCachedRepo(dir);
  await cloneRepo(dir, url, onAuth);
  return resolveRef({ fs, dir, ref: "HEAD" });
}

async function fetchRepo(
  dir: string, url: string,
  onAuth: () => { username: string; password: string },
  maxBytes: number,
): Promise<string> {
  let result = await fetch({
    fs,
    http: makeHttp(maxBytes),
    dir,
    url,
    ref: MEMORY_BRANCH,
    singleBranch: true,
    depth: 1,
    prune: true,
    onAuth,
  });
  if (!result.fetchHead) throw new Error("Git fetch did not return a commit.");
  return result.fetchHead;
}

async function fetchOrRecloneRepo(
  dir: string, url: string,
  onAuth: () => { username: string; password: string },
): Promise<string> {
  let { sizeBytes } = await gitdirStats(dir);
  let remainingBytes = MAX_GIT_DIR_BYTES - sizeBytes;
  if (remainingBytes <= 0) {
    logger.warn("memory git cache exceeded transfer budget; recloning shallow cache", {
      event: "memory.git.cache.transfer.budget.exceeded",
      operation: "fetchOrRecloneRepo",
      repoName: MEMORY_REPO_NAME,
      commit: "",
      bodyBytes: 0,
      dirty: 0,
      attempts: 0,
      vendorId: "memory",
      memoryId: "",
      query: "",
      total: 0,
    });
    return recloneRepo(dir, url, onAuth);
  }
  try {
    return await fetchRepo(dir, url, onAuth, remainingBytes);
  } catch (err) {
    logger.warn("memory git fetch failed; cleaning up before recloning", {
      event: "memory.git.fetch.failed",
      operation: "fetchOrRecloneRepo",
      repoName: MEMORY_REPO_NAME,
      commit: "",
      bodyBytes: 0,
      dirty: 0,
      attempts: 0,
      vendorId: "memory",
      memoryId: "",
      query: "",
      total: 0,
      error: err as Error,
    });
    return recloneRepo(dir, url, onAuth);
  }
}

/**
 * ArtifactsGitRepo: the MemoryRepo implementation over Cloudflare Artifacts.
 * One instance per MemoryStorage DO; the DO is the single writer.
 */
export class ArtifactsGitRepo implements MemoryRepo {
  #artifacts: Artifacts;
  #dir: string;
  #remoteUrl: string | null = null;

  constructor(artifacts: Artifacts, dir?: string) {
    this.#artifacts = artifacts;
    this.#dir = dir ?? `/tmp/memory/${MEMORY_REPO_NAME}`;
  }

  async ensureRepo(): Promise<string> {
    if (this.#remoteUrl) return this.#remoteUrl;
    let repo: ArtifactsRepo;
    try {
      repo = await this.#artifacts.get(MEMORY_REPO_NAME);
    } catch (err) {
      // Not found → create. Artifacts auto-creates an initial write token when the repo is
      // first created; we don't want or need it, so revoke it immediately (context-collection
      // pattern).
      let created = await this.#artifacts.create(MEMORY_REPO_NAME, {
        description: "Durable agent memories (decisions, failures, how-tos, constraints, preferences)",
        setDefaultBranch: MEMORY_BRANCH,
      });
      repo = await this.#artifacts.get(MEMORY_REPO_NAME);
      await repo.revokeToken(created.token).catch((err2) => {
        logger.warn("failed to revoke initial Artifacts token for memory repo", {
          event: "memory.artifacts.initial.token.revoke.failed",
          operation: "ensureRepo",
          repoName: MEMORY_REPO_NAME,
          commit: "",
          bodyBytes: 0,
          dirty: 0,
          attempts: 0,
          vendorId: "memory",
          memoryId: "",
          query: "",
          total: 0,
          error: err2 as Error,
        });
      });
    }
    let info = await repo.info();
    this.#remoteUrl = info.remote;
    return this.#remoteUrl;
  }

  async #withToken<T>(scope: "read" | "write", fn: (token: { plaintext: string; id: string }) => Promise<T>): Promise<T> {
    let repo = await this.#artifacts.get(MEMORY_REPO_NAME);
    let token = await repo.createToken(scope, WRITE_TOKEN_TTL_SECONDS);
    try {
      return await fn(token);
    } finally {
      await repo.revokeToken(token.id).catch((err) => {
        logger.warn("failed to revoke temporary Artifacts token", {
          event: "memory.artifacts.token.revoke.failed",
          operation: "withToken",
          repoName: MEMORY_REPO_NAME,
          commit: "",
          bodyBytes: 0,
          dirty: 0,
          attempts: 0,
          vendorId: "memory",
          memoryId: "",
          query: "",
          total: 0,
          error: err as Error,
        });
      });
    }
  }

  async serverTip(): Promise<string | null> {
    let url = await this.ensureRepo();
    return this.#withToken("read", async (token) => {
      let onAuth = () => ({ username: "x-access-token", password: token.plaintext });
      let refs = await listServerRefs({
        http: makeHttp(MAX_GIT_DIR_BYTES),
        url,
        prefix: `refs/heads/${MEMORY_BRANCH}`,
        onAuth,
      });
      let branchRef = refs.find(ref => ref.ref === `refs/heads/${MEMORY_BRANCH}`);
      return branchRef?.oid ?? null;
    });
  }

  async fetchDocuments(currentCommit?: string): Promise<{
    commit: string;
    changed: boolean;
    documents: Map<string, string>;
  }> {
    let url = await this.ensureRepo();
    return this.#withToken("read", async (token) => {
      let onAuth = () => ({ username: "x-access-token", password: token.plaintext });

      // Cheap revalidation: if tip hasn't moved, no fetch needed.
      let refs = await listServerRefs({
        http: makeHttp(MAX_GIT_DIR_BYTES),
        url,
        prefix: `refs/heads/${MEMORY_BRANCH}`,
        onAuth,
      });
      let branchRef = refs.find(ref => ref.ref === `refs/heads/${MEMORY_BRANCH}`);
      if (!branchRef) {
        return { commit: "", changed: currentCommit !== "", documents: new Map() };
      }
      if (branchRef.oid === currentCommit) {
        return { commit: currentCommit ?? "", changed: false, documents: new Map() };
      }

      // Fetch (or clone if no local mirror)
      let commit: string;
      if ((await gitdirStats(this.#dir)).exists) {
        commit = await fetchOrRecloneRepo(this.#dir, url, onAuth);
      } else {
        await cloneRepo(this.#dir, url, onAuth);
        commit = await resolveRef({ fs, dir: this.#dir, ref: "HEAD" });
      }
      if (!commit) {
        return { commit: "", changed: true, documents: new Map() };
      }

      // Read all objects/**/*.md files
      let documents = new Map<string, string>();
      let filepaths = await listGitFiles({ fs, dir: this.#dir, ref: commit });
      for (let filepath of filepaths) {
        if (!filepath.startsWith("objects/") || !filepath.endsWith(".md")) continue;
        let { blob } = await readBlob({ fs, dir: this.#dir, oid: commit, filepath });
        documents.set(filepath, new TextDecoder().decode(blob));
      }
      return { commit, changed: true, documents };
    });
  }

  async pushOps(ops: MemoryWriteOp[], message: string, author: string): Promise<string> {
    let url = await this.ensureRepo();
    return this.#withToken("write", async (token) => {
      let onAuth = () => ({ username: "x-access-token", password: token.plaintext });

      for (let attempt = 0; attempt < PUSH_RETRY_LIMIT; attempt++) {
        try {
          // Ensure local mirror exists and is at server tip
          let tip = await this.serverTip();
          let unborn = false;
          if (!tip) {
            // Empty repo: start a fresh local repo with an unborn branch; the ops below
            // form the root commit and the push creates the branch.
            await deleteCachedRepo(this.#dir);
            await gitInit({ fs, dir: this.#dir, defaultBranch: MEMORY_BRANCH });
            unborn = true;
          } else if ((await gitdirStats(this.#dir)).exists) {
            let fetched = await fetchOrRecloneRepo(this.#dir, url, onAuth);
            if (fetched) {
              // fetch() only moves the tracking ref; fast-forward the local branch to
              // the fetched tip before checking out, or the push would be non-FF.
              await gitWriteRef({
                fs,
                dir: this.#dir,
                ref: `refs/heads/${MEMORY_BRANCH}`,
                value: fetched,
                force: true,
              });
            }
            await gitCheckout({ fs, dir: this.#dir, ref: MEMORY_BRANCH, force: true });
          } else {
            await cloneRepo(this.#dir, url, onAuth);
            await gitCheckout({ fs, dir: this.#dir, ref: MEMORY_BRANCH, force: true });
          }

          // Apply ops to the working tree (plain fs writes; isomorphic-git has no
          // writeFile command) and stage them.
          for (let op of ops) {
            let fullPath = posixPath.join(this.#dir, op.path);
            if (op.op === "write") {
              await fsp.mkdir(posixPath.dirname(fullPath), { recursive: true });
              await fsp.writeFile(fullPath, op.content ?? "", "utf8");
            } else {
              try {
                await gitRemove({ fs, dir: this.#dir, filepath: op.path });
              } catch (err) {
                // Already gone (another writer deleted it): a no-op for us.
                if (isMissingPath(err)) continue;
                throw err;
              }
            }
          }
          await gitAdd({ fs, dir: this.#dir, filepath: "." });

          if (!unborn) {
            let status = await statusMatrix({ fs, dir: this.#dir });
            if (!status.some((row) => row[1] !== row[3])) {
              // The ops produced no change (an identical rewrite already landed): succeed
              // idempotently at the current tip instead of committing an empty change.
              return await resolveRef({ fs, dir: this.#dir, ref: MEMORY_BRANCH });
            }
          }
          let authorName = author || "memory-agent";
          await gitCommit({
            fs,
            dir: this.#dir,
            message,
            author: { name: authorName },
          });

          // Push
          let pushResult = await push({
            fs,
            http: makeHttp(MAX_GIT_DIR_BYTES),
            dir: this.#dir,
            remote: "origin",
            ref: MEMORY_BRANCH,
            onAuth,
          });
          if (!pushResult.ok) {
            throw pushResult.error ?? new Error("Push failed.");
          }

          let newTip = await resolveRef({ fs, dir: this.#dir, ref: MEMORY_BRANCH });
          return newTip;
        } catch (err) {
          // Non-FF or rejection: re-fetch and retry (the next attempt re-clones/re-fetches
          // and replays the ops on the new tip)
          logger.warn("memory push attempt failed", {
            event: "memory.git.push.retry",
            operation: "pushOps",
            repoName: MEMORY_REPO_NAME,
            commit: "",
            bodyBytes: 0,
            dirty: 0,
            attempts: attempt + 1,
            vendorId: "memory",
            memoryId: "",
            query: "",
            total: 0,
            error: err as Error,
          });
        }
      }
      throw new SyncConflictError();
    });
  }
}
