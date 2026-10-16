import assert from "node:assert/strict";
import test from "node:test";
import { githubApi, reconcileRepositoryDefaults } from "../src/github-api.mjs";

const repositorySnapshot = (extra = {}) => ({ id: 123, full_name: "union/project", archived: false,
  disabled: false, visibility: "private", default_branch: "main", permissions: { admin: true }, delete_branch_on_merge: false, ...extra });

test("organization creation returns its numeric receipt without a fallible receiving call", async () => {
  const requests = [];
  const api = githubApi({ fetchImpl: async (url, init) => {
    requests.push({ url: String(url), method: init.method, body: init.body && JSON.parse(init.body) });
    return new Response(JSON.stringify(repositorySnapshot({ delete_branch_on_merge: true })), { status: 200 });
  } });
  const created = await api.createOrgRepository("union", { name: "project", description: "source", visibility: "private" });
  assert.deepEqual(requests, [
    { url: "https://api.github.com/orgs/union/repos", method: "POST", body: { name: "project", description: "source", visibility: "private", auto_init: false, delete_branch_on_merge: true } },
  ]);
  assert.equal(created.id, 123);
  assert.equal(created.delete_branch_on_merge, true);
});

test("repository defaults repair only the one flag, read it back and replay without another write", async () => {
  const requests = [];
  let enabled = false;
  const api = githubApi({ fetchImpl: async (url, init) => {
    requests.push({ url: String(url), method: init.method, body: init.body && JSON.parse(init.body) });
    if (init.method === "PATCH") enabled = true;
    return new Response(JSON.stringify(repositorySnapshot({ delete_branch_on_merge: enabled })), { status: 200 });
  } });
  const selection = { repository: "union/project", expectedId: 123, apply: true };
  assert.equal((await reconcileRepositoryDefaults(selection, api)).disposition, "enabled");
  assert.equal((await reconcileRepositoryDefaults(selection, api)).disposition, "already-enabled");
  assert.deepEqual(requests.map((r) => r.method), ["GET", "PATCH", "GET", "GET"]);
  assert.deepEqual(requests[1].body, { delete_branch_on_merge: true });
  assert.ok(requests.every((r) => r.url === "https://api.github.com/repos/union/project"));
});

test("repository defaults preview and inactive targets never mutate", async () => {
  for (const [extra, disposition] of [[{}, "would-enable"], [{ archived: true }, "skipped-inactive"], [{ disabled: true }, "skipped-inactive"]]) {
    let writes = 0;
    const api = { getRepo: async () => repositorySnapshot(extra), enableMergedBranchDeletion: async () => { writes++; } };
    assert.equal((await reconcileRepositoryDefaults({ repository: "union/project", expectedId: 123, apply: disposition === "skipped-inactive" }, api)).disposition, disposition);
    assert.equal(writes, 0);
  }
});

test("repository defaults refuse identity, permission and missing-setting ambiguity before writing", async () => {
  for (const extra of [{ id: 456 }, { full_name: "foreign/project" }, { permissions: { admin: false } }, { delete_branch_on_merge: undefined }]) {
    let writes = 0;
    const api = { getRepo: async () => repositorySnapshot(extra), enableMergedBranchDeletion: async () => { writes++; } };
    await assert.rejects(reconcileRepositoryDefaults({ repository: "union/project", expectedId: 123, apply: true }, api));
    assert.equal(writes, 0);
  }
  await assert.rejects(reconcileRepositoryDefaults({ repository: "union/project", expectedId: 123, apply: "false" }, {}), /exact numeric repository ID/);
  await assert.rejects(reconcileRepositoryDefaults({ repository: "../project", expectedId: 123 }, {}), /owner\/name/);
});

test("uncertain update responses are reconciled by observation without a second mutation", async () => {
  let reads = 0, writes = 0;
  const api = { getRepo: async () => repositorySnapshot({ delete_branch_on_merge: ++reads > 1 }), enableMergedBranchDeletion: async () => { writes++; throw new Error("response lost"); } };
  const result = await reconcileRepositoryDefaults({ repository: "union/project", expectedId: 123, apply: true }, api);
  assert.equal(result.disposition, "enabled-after-uncertain-response");
  assert.equal(writes, 1);
  assert.equal(reads, 2);
});

test("a successful PATCH without matching readback cannot qualify repository defaults", async () => {
  for (const extra of [{ delete_branch_on_merge: false }, { id: 456, delete_branch_on_merge: true }, { visibility: "public", delete_branch_on_merge: true }]) {
    let reads = 0, writes = 0;
    const api = { getRepo: async () => repositorySnapshot(++reads > 1 ? extra : {}), enableMergedBranchDeletion: async () => { writes++; } };
    await assert.rejects(reconcileRepositoryDefaults({ repository: "union/project", expectedId: 123, apply: true }, api));
    assert.equal(writes, 1);
  }
});

test("repository tarball bytes cross the codeload boundary while credentials do not", async () => {
  const prior = process.env.GITHUB_SERVICES_TOKEN;
  process.env.GITHUB_SERVICES_TOKEN = "provider-owned-secret";
  const requests = [];
  try {
    const api = githubApi({ fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      if (requests.length === 1) return new Response(null, { status: 302, headers: { location: "https://codeload.github.com/acme/widgets/legacy.tar.gz/refs/heads/feature/a" } });
      return new Response(Uint8Array.from([31, 139, 8, 0]), { status: 200 });
    } });
    const bytes = await api.getRepositoryTarball("acme/widgets", "feature/a");
    assert.deepEqual([...bytes], [31, 139, 8, 0]);
    assert.equal(requests[0].url, "https://api.github.com/repos/acme/widgets/tarball/feature%2Fa");
    assert.equal(requests[0].init.headers.authorization, "Bearer provider-owned-secret");
    assert.equal(requests[1].url, "https://codeload.github.com/acme/widgets/legacy.tar.gz/refs/heads/feature/a");
    assert.equal(requests[1].init.headers.authorization, undefined);
    assert.equal(Object.hasOwn(bytes, "token"), false);
  } finally {
    if (prior === undefined) delete process.env.GITHUB_SERVICES_TOKEN;
    else process.env.GITHUB_SERVICES_TOKEN = prior;
  }
});

test("the provider admits the existing GitHub runtime credential when its service alias is absent", async () => {
  const priorService = process.env.GITHUB_SERVICES_TOKEN;
  const priorRuntime = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_SERVICES_TOKEN;
  process.env.GITHUB_TOKEN = "runtime-owned-secret";
  try {
    let authorization = null;
    const api = githubApi({ fetchImpl: async (_url, init) => {
      authorization = init.headers.authorization;
      return new Response(JSON.stringify({ visibility: "public" }), { status: 200 });
    } });
    await api.getRepo("emsenn/union-free-compute-runner");
    assert.equal(authorization, "Bearer runtime-owned-secret");
  } finally {
    if (priorService === undefined) delete process.env.GITHUB_SERVICES_TOKEN;
    else process.env.GITHUB_SERVICES_TOKEN = priorService;
    if (priorRuntime === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = priorRuntime;
  }
});

test("transient GitHub tarball failures retain provider status for ID-backed resumption", async () => {
  for (const [status, expectedRetryable] of [[503, true], [429, true], [404, true], [403, false]]) {
    const api = githubApi({ fetchImpl: async () => new Response("temporarily unavailable", { status }) });
    await assert.rejects(api.getRepositoryTarball("union/seed", "a".repeat(40)),
      (error) => error.status === status && error.retryable === expectedRetryable);
  }
  let calls = 0;
  const codeload = githubApi({ fetchImpl: async () => ++calls === 1
    ? new Response(null, { status: 302, headers: { location: "https://codeload.github.com/union/seed/legacy.tar.gz" } })
    : new Response("overloaded", { status: 503 }) });
  await assert.rejects(codeload.getRepositoryTarball("union/seed"),
    (error) => error.status === 503 && error.retryable === true && /codeload GET/.test(error.message));
  assert.equal(calls, 2);
});

test("tarball transport refuses foreign redirects and over-limit bodies", async () => {
  const foreign = githubApi({ fetchImpl: async () => new Response(null, { status: 302, headers: { location: "https://example.invalid/archive.tgz" } }) });
  await assert.rejects(foreign.getRepositoryTarball("acme/widgets"), /left the admitted codeload origin/);

  const oversized = githubApi({ fetchImpl: async () => new Response(Uint8Array.from([1, 2, 3, 4])) });
  await assert.rejects(oversized.getRepositoryTarball("acme/widgets", undefined, { maximumBytes: 3 }), /exceeds 3 bytes/);
  await assert.rejects(oversized.getRepositoryTarball("../etc/passwd"), /must be owner\/name/);
});

test("bounded public-compute GitHub observations and dispatch stay on the provider face", async () => {
  const prior = process.env.GITHUB_SERVICES_TOKEN;
  process.env.GITHUB_SERVICES_TOKEN = "provider-owned-secret";
  const requests = [];
  try {
    const api = githubApi({ fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      return init.method === "POST"
        ? new Response(null, { status: 204 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 });
    } });
    await api.getActionsPermissions("union/public-runner");
    await api.getTagRef("union/public-runner", "bounded-public-test-v1");
    await api.getReleaseByTag("union/public-runner", "bounded-public-test-v1");
    await api.getContentRecord("union/public-runner", "a".repeat(40), ".github/workflows/bounded-public-test.yml");
    await api.dispatchWorkflow("union/public-runner", "bounded-public-test.yml", "bounded-public-test-v1", { target_repository: "upstream/project" });
    assert.deepEqual(requests.map(({ url }) => url), [
      "https://api.github.com/repos/union/public-runner/actions/permissions",
      "https://api.github.com/repos/union/public-runner/git/ref/tags/bounded-public-test-v1",
      "https://api.github.com/repos/union/public-runner/releases/tags/bounded-public-test-v1",
      `https://api.github.com/repos/union/public-runner/contents/.github/workflows/bounded-public-test.yml?ref=${"a".repeat(40)}`,
      "https://api.github.com/repos/union/public-runner/actions/workflows/bounded-public-test.yml/dispatches",
    ]);
    assert.equal(requests.at(-1).init.method, "POST");
    assert.deepEqual(JSON.parse(requests.at(-1).init.body), { ref: "bounded-public-test-v1", inputs: { target_repository: "upstream/project" } });
  } finally {
    if (prior === undefined) delete process.env.GITHUB_SERVICES_TOKEN;
    else process.env.GITHUB_SERVICES_TOKEN = prior;
  }
});

test("tree entry observations preserve blobs and gitlinks", async () => {
  const api = githubApi({ fetchImpl: async () => new Response(JSON.stringify({ tree: [
    { path: "README.md", mode: "100644", type: "blob", sha: "blob-sha" },
    { path: "lib/cell", mode: "160000", type: "commit", sha: "commit-sha" },
    { path: "lib", mode: "040000", type: "tree", sha: "tree-sha" },
  ] }), { status: 200 }) });
  assert.deepEqual(await api.getTreeEntries("union/root", "a".repeat(40)), [
    { path: "README.md", mode: "100644", type: "blob", sha: "blob-sha" },
    { path: "lib/cell", mode: "160000", type: "commit", sha: "commit-sha" },
  ]);
});
