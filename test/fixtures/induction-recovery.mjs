import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { githubApi } from "../../src/github-api.mjs";
import { executeInductionSaga } from "../../src/induction-saga.mjs";
import { induceGithubSoftwareProposalLocally } from "../../src/software-induction.mjs";

const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const write = (path, value) => writeFileSync(path, JSON.stringify(value));
const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
export const request = {
  id: "request:durable-creation", input: {
    source: { kind: "github-repository", repository: "union/seed", commit: "a".repeat(40) },
    target: { repository: "union/created", ref: "heads/main", create: true },
    writablePaths: ["file.txt"], verifyCommand: "node verify.mjs",
    proposal: { type: "SoftwareMissionChangeProposal", proposalOnly: true, customerMutation: false, changes: [{
      path: "file.txt", beforeExisted: true, beforeDigest: digest("before\n"),
      afterDigest: digest("after\n"), afterBytesBase64: Buffer.from("after\n").toString("base64"),
    }] },
  },
};
export const recordAt = (root) => read(join(root, "operation.json"));
export const remoteAt = (root) => read(join(root, "remote.json"));
export function fixture(root) {
  const seed = join(root, "seed");
  mkdirSync(seed);
  writeFileSync(join(seed, "file.txt"), "before\n");
  writeFileSync(join(seed, "verify.mjs"), 'import { readFileSync } from "node:fs";\nif (readFileSync("file.txt", "utf8") !== "after\\n") process.exit(1);\n');
  execFileSync("tar", ["-czf", join(root, "source.tar.gz"), "-C", root, "seed"]);
  write(join(root, "remote.json"), { creates: 0, patches: 0, reads: 0, blobs: 0, trees: 0, commits: 0, refs: 0 });
}
export function store(root, mode) {
  const path = join(root, "operation.json");
  return {
    async get() { return existsSync(path) ? read(path) : null; },
    async compareAndSet(key, version, next) {
      const current = existsSync(path) ? read(path) : null;
      if ((current?.version ?? null) !== version) throw new Error("stale operation-store version");
      const result = { ...next, operation: key, version: (current?.version ?? 0) + 1 };
      write(path, result);
      if (mode === "crash-created" && result.state === "repository-created") process.exit(91);
      if (mode === "crash-ready" && result.state === "repository-ready") process.exit(92);
      return result;
    },
  };
}
export function api(root, mode = "healthy", beforeGet = async () => {}) {
  const mutate = (change) => { const remote = remoteAt(root); change(remote); write(join(root, "remote.json"), remote); return remote; };
  const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
  return {
    ...githubApi({ fetchImpl: async (url, init) => {
      const path = new URL(url).pathname;
      if (init.method === "POST" && path === "/orgs/union/repos") {
        assert.equal(recordAt(root).state, "repository-creation-attempted");
        assert.equal(JSON.parse(init.body).delete_branch_on_merge, true);
        const remote = mutate((r) => {
          r.creates++;
          if (mode !== "post-denied") r.repository = { id: 123, full_name: "union/created", archived: false,
            disabled: false, visibility: "public", default_branch: "main", permissions: { admin: true },
            delete_branch_on_merge: !mode.startsWith("patch-") };
        });
        if (mode === "post-denied") return response({ message: "creation denied" }, 403);
        if (mode === "post-lost") throw new Error("creation response lost");
        return response(remote.repository, 201);
      }
      assert.equal(path, "/repos/union/created");
      // The actual caller must durably retain the numeric POST receipt before
      // making even the first follow-up provider observation.
      assert.deepEqual(recordAt(root).createdRepository, { repository: "union/created", id: 123 });
      if (init.method === "GET") {
        await beforeGet();
        const remote = mutate((r) => { r.reads++; });
        if (mode === "get-denied") return response({ message: "read denied" }, 403);
        if (mode === "get-not-yet-visible") return response({ message: "not yet visible" }, 404);
        if (mode === "identity-changed") return response({ ...remote.repository, id: 456 });
        if (mode === "get-failure" || (mode.startsWith("patch-") && mode !== "patch-denied" && remote.patches > 0)) {
          return response({ message: "receiving unavailable" }, 503);
        }
        return response(remote.repository);
      }
      assert.equal(init.method, "PATCH");
      assert.equal(recordAt(root).repositoryDefaultsAttempted, true);
      assert.deepEqual(JSON.parse(init.body), { delete_branch_on_merge: true });
      const remote = mutate((r) => { r.patches++; if (mode !== "patch-pending" && mode !== "patch-denied") r.repository.delete_branch_on_merge = true; });
      if (mode === "patch-denied") return response({ message: "update denied" }, 403);
      if (mode.startsWith("patch-")) return response({ message: "update response lost" }, 503);
      return response(remote.repository);
    } }),
    downloadRepositoryTarball: async (_repo, _commit, destination) => {
      if (mode === "source-unavailable") throw Object.assign(
        new Error("source archive temporarily unavailable"), { status: 503, retryable: true });
      return cpSync(join(root, "source.tar.gz"), destination);
    },
    getTreeEntries: async () => {
      if (mode === "source-read-unavailable") throw Object.assign(
        new Error("source tree temporarily unavailable"), { status: 503, retryable: true });
      return [{ path: "file.txt", mode: "100644", type: "blob", sha: "old-blob" }];
    },
    getContentBytes: async () => Buffer.from(mode === "verification-denied" ? "drift\n" : "before\n"),
    createBlob: async () => { mutate((r) => { r.blobs++; }); return { sha: "blob" }; },
    createTree: async () => { mutate((r) => { r.trees++; }); return { sha: "tree" }; },
    createCommit: async () => { mutate((r) => { r.commits++; }); return { sha: "c".repeat(40) }; },
    createRef: async () => { mutate((r) => { r.refs++; }); },
  };
}
export const run = (root, mode = "healthy", beforeGet) => executeInductionSaga(request, {
  induce: induceGithubSoftwareProposalLocally, operationStore: store(root, mode), provider: { api: api(root, mode, beforeGet) },
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(JSON.stringify(await run(process.argv[2], process.argv[3]))); }
  catch (error) { process.stderr.write(error.message); process.exitCode = 1; }
}
