// Independently hireable GitHub REST protocol carrier. Every
// method is small and isolated so the executor can be tested with a fake in its place.
// The token needs: repo read (target trees/contents), gist create/delete, and
// actions:write + actions:read on the RUNNER repo. It is never exposed to untrusted job code.
const GH = "https://api.github.com";
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const DEFAULT_TARBALL_LIMIT = 64 * 1024 * 1024;

async function boundedBytes(response, maximumBytes) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) throw new Error(`github response exceeds ${maximumBytes} bytes`);
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader(), chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel("response byte limit exceeded");
      throw new Error(`github response exceeds ${maximumBytes} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

export function githubApi({ fetchImpl = fetch } = {}) {
  // Credential material remains owned by this protocol carrier.  A deployed
  // service receives GITHUB_SERVICES_TOKEN; GitHub-hosted and controlled
  // interactive runtime receive the same scoped credential as GITHUB_TOKEN.
  const token = process.env.GITHUB_SERVICES_TOKEN ?? process.env.GITHUB_TOKEN;
  const headers = { accept: "application/vnd.github+json", "user-agent": "red-cup-engineering-github-capability" };
  if (token) headers.authorization = `Bearer ${token}`;
  const j = async (method, path, body) => {
    const res = await fetchImpl(`${GH}${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!res.ok) throw new Error(`github ${method} ${path} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res.status === 204 ? {} : res.json();
  };
  const repositoryArchiveResponse = async (repo, ref) => {
    if (!REPOSITORY.test(repo ?? "")) throw new TypeError("GitHub repository must be owner/name");
    const suffix = ref ? `/${encodeURIComponent(ref)}` : "";
    const path = `/repos/${repo}/tarball${suffix}`;
    const initial = await fetchImpl(`${GH}${path}`, { headers, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(initial.status)) {
      if (!initial.ok) throw new Error(`github GET ${path} -> ${initial.status} ${(await initial.text()).slice(0, 200)}`);
      return initial;
    }
    const location = new URL(initial.headers.get("location") ?? "", GH);
    if (location.protocol !== "https:" || location.hostname !== "codeload.github.com") throw new Error("GitHub tarball redirect left the admitted codeload origin");
    const downloaded = await fetchImpl(location, { headers: { accept: "application/octet-stream", "user-agent": headers["user-agent"] }, redirect: "error" });
    if (!downloaded.ok) throw new Error(`github codeload GET ${location.pathname} -> ${downloaded.status} ${(await downloaded.text()).slice(0, 200)}`);
    return downloaded;
  };
  return {
    async searchIssues({ query, perPage = 30, page = 1 }) {
      return j("GET", `/search/issues?q=${encodeURIComponent(query)}&sort=created&order=desc&per_page=${perPage}&page=${page}`);
    },
    async getIssueComments(repo, n) { return j("GET", `/repos/${repo}/issues/${n}/comments?per_page=100`); },
    async getRepositoryTarball(repo, ref, { maximumBytes = DEFAULT_TARBALL_LIMIT } = {}) {
      if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new TypeError("GitHub tarball byte limit must be a positive safe integer");
      return boundedBytes(await repositoryArchiveResponse(repo, ref), maximumBytes);
    },
    async downloadRepositoryTarball(repo, ref, destination) {
      if (typeof destination !== "string" || destination.length === 0) throw new TypeError("GitHub tarball destination is required");
      const response = await repositoryArchiveResponse(repo, ref);
      if (!response.body) throw new Error("GitHub tarball response has no body");
      await pipeline(Readable.fromWeb(response.body), createWriteStream(destination, { flags: "wx" }));
      return destination;
    },
    async getRepo(repo) { return j("GET", `/repos/${repo}`); },
    async getActionsPermissions(repo) {
      if (!REPOSITORY.test(repo ?? "")) throw new TypeError("GitHub repository must be owner/name");
      return j("GET", `/repos/${repo}/actions/permissions`);
    },
    async getTagRef(repo, tag) {
      if (!REPOSITORY.test(repo ?? "") || typeof tag !== "string" || tag.length === 0) throw new TypeError("GitHub repository and tag are required");
      return j("GET", `/repos/${repo}/git/ref/tags/${encodeURIComponent(tag)}`);
    },
    async getReleaseByTag(repo, tag) {
      if (!REPOSITORY.test(repo ?? "") || typeof tag !== "string" || tag.length === 0) throw new TypeError("GitHub repository and tag are required");
      return j("GET", `/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`);
    },
    async getIssue(repo, n) { const i = await j("GET", `/repos/${repo}/issues/${n}`); return { title: i.title, body: i.body || "" }; },
    // --- posting surface (used only by the gated post-attempt path) ---
    async getAuthUser() { return j("GET", `/user`); },
    async createIssueComment(repo, n, body) { return j("POST", `/repos/${repo}/issues/${n}/comments`, { body }); },
    async forkRepo(repo) { const f = await j("POST", `/repos/${repo}/forks`, {}); return { full_name: f.full_name, owner: f.owner?.login, default_branch: f.default_branch }; },
    async getRef(repo, branch) { const r = await j("GET", `/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`); return r.object?.sha; },
    async createRef(repo, ref, sha) { return j("POST", `/repos/${repo}/git/refs`, { ref, sha }); },
    async getCommit(repo, sha) { return j("GET", `/repos/${repo}/git/commits/${encodeURIComponent(sha)}`); },
    async createBlob(repo, bytes) { return j("POST", `/repos/${repo}/git/blobs`, { content: Buffer.from(bytes).toString("base64"), encoding: "base64" }); },
    async createTree(repo, { baseTree, entries }) {
      return j("POST", `/repos/${repo}/git/trees`, { ...(baseTree ? { base_tree: baseTree } : {}), tree: entries });
    },
    async createCommit(repo, { message, tree, parents }) { return j("POST", `/repos/${repo}/git/commits`, { message, tree, parents }); },
    async createOrgRepository(org, { name, description, visibility = "public" }) {
      return j("POST", `/orgs/${encodeURIComponent(org)}/repos`, {
        name,
        description,
        visibility,
        auto_init: false,
      });
    },
    async updateRef(repo, ref, sha) { return j("PATCH", `/repos/${repo}/git/refs/${ref.split("/").map(encodeURIComponent).join("/")}`, { sha, force: false }); },
    async getFileSha(repo, path, branch) {
      try { const c = await j("GET", `/repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(branch)}`); return c.sha; } catch { return undefined; }
    },
    async putFile(repo, path, { message, content, branch, sha }) {
      return j("PUT", `/repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}`, { message, content, branch, ...(sha ? { sha } : {}) });
    },
    async createPullRequest(repo, { title, head, base, body }) { return j("POST", `/repos/${repo}/pulls`, { title, head, base, body }); },
    async getRunJobs(runnerRepo, runId) { const r = await j("GET", `/repos/${runnerRepo}/actions/runs/${runId}/jobs`); return r.jobs || []; },
    async getJobLog(runnerRepo, jobId) {
      const res = await fetchImpl(`${GH}/repos/${runnerRepo}/actions/jobs/${jobId}/logs`, { headers });
      return res.ok ? res.text() : "";
    },
    async getTree(repo, ref) {
      const t = await j("GET", `/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
      return (t.tree || []).filter((e) => e.type === "blob").map((e) => e.path);
    },
    async getTreeEntries(repo, ref) {
      const t = await j("GET", `/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
      return (t.tree || []).filter((entry) => entry.type === "blob" || entry.type === "commit")
        .map(({ path, mode, type, sha }) => ({ path, mode, type, sha }));
    },
    async getContentRecord(repo, ref, path) {
      if (!REPOSITORY.test(repo ?? "") || typeof ref !== "string" || ref.length === 0 || typeof path !== "string" || path.length === 0) throw new TypeError("GitHub repository, ref, and path are required");
      return j("GET", `/repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`);
    },
    async getContent(repo, ref, path) {
      const c = await this.getContentRecord(repo, ref, path);
      return c.content ? Buffer.from(c.content, "base64").toString("utf8") : "";
    },
    async getContentBytes(repo, ref, path) {
      try {
        const c = await j("GET", `/repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`);
        return c.content ? Buffer.from(c.content, "base64") : Buffer.alloc(0);
      } catch (error) {
        if (/ -> 404 /u.test(error.message)) return null;
        throw error;
      }
    },
    async createGist(files) {
      const payload = { public: false, files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, { content: v || "\n" }])) };
      const g = await j("POST", `/gists`, payload);
      const first = Object.values(g.files || {})[0] || {};
      return { id: g.id, rawUrl: first.raw_url };
    },
    async deleteGist(id) { return j("DELETE", `/gists/${id}`); },
    async dispatchWorkflow(runnerRepo, workflowFile, ref, inputs) {
      return j("POST", `/repos/${runnerRepo}/actions/workflows/${encodeURIComponent(workflowFile)}/dispatches`, { ref, inputs });
    },
    async latestRun(runnerRepo, workflowFile) {
      const r = await j("GET", `/repos/${runnerRepo}/actions/workflows/${encodeURIComponent(workflowFile)}/runs?per_page=1`);
      const run = (r.workflow_runs || [])[0];
      return run ? { id: run.id, status: run.status, conclusion: run.conclusion, createdAt: run.created_at } : null;
    },
    async listRuns(runnerRepo, workflowFile, perPage = 20) {
      const r = await j("GET", `/repos/${runnerRepo}/actions/workflows/${encodeURIComponent(workflowFile)}/runs?event=workflow_dispatch&per_page=${perPage}`);
      return (r.workflow_runs || []).map((run) => ({ id: run.id, status: run.status, conclusion: run.conclusion, createdAt: run.created_at, displayTitle: run.display_title }));
    },
    // First-cut result: pass = run concluded success. Structured per-step output (logs/artifact)
    // is a documented refinement; the executor treats this behind the api so it can harden later.
    async getRunResult(runnerRepo, runId) {
      const run = await j("GET", `/repos/${runnerRepo}/actions/runs/${runId}`);
      const start = run.run_started_at || run.created_at;
      const end = run.updated_at;
      const durationSeconds = start && end ? Math.max(0, (Date.parse(end) - Date.parse(start)) / 1000) : null;
      return { passed: run.conclusion === "success", output: `run ${runId} conclusion=${run.conclusion}`, runId, durationSeconds };
    },
  };
}
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
