import assert from "node:assert/strict";
import test from "node:test";
import { githubApi } from "../src/github-api.mjs";

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
