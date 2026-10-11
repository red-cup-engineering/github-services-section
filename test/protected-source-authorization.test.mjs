import assert from "node:assert/strict";
import test from "node:test";
import { authorizeProtectedSourceFromGitHub, createProtectedSourceAuthorization, verifyProtectedSourceAuthorization } from "../src/protected-source-authorization.mjs";

const sourceSha = "a".repeat(40);
const mainSha = "b".repeat(40);
const base = {
  repository: "emsenn/bare-cedar-fog",
  sourceSha,
  checkedOutSha: sourceSha,
  protectedRef: "refs/heads/main",
  workflow: "emsenn/bare-cedar-fog/.github/workflows/build-youtube-image.yml@refs/heads/main",
  environment: "youtube-image-build",
  runId: "42",
  runAttempt: "2",
  authorizedAt: "2026-08-15T12:00:00.000Z",
};

test("an older exact source remains authorized when protected main advances", () => {
  const receipt = createProtectedSourceAuthorization({ ...base, comparison: {
    status: "ahead", ahead_by: 7, behind_by: 0, base_commit: { sha: sourceSha }, head_commit: { sha: mainSha }, merge_base_commit: { sha: sourceSha },
  } });
  assert.equal(receipt.sourceSha, sourceSha);
  assert.equal(receipt.observedProtectedSha, mainSha);
  assert.equal(receipt.relation, "ancestor");
  assert.equal(receipt.aheadBy, 7);
  assert.match(receipt.receiptDigest, /^ni:\/\/\/sha-256;[A-Za-z0-9_-]{43}$/u);
  assert.deepEqual(verifyProtectedSourceAuthorization(receipt, { sourceSha, environment: "youtube-image-build" }), receipt);
});

test("identical protected source is admitted but diverged or foreign source is refused", () => {
  assert.equal(createProtectedSourceAuthorization({ ...base, comparison: {
    status: "identical", ahead_by: 0, behind_by: 0, base_commit: { sha: sourceSha }, head_commit: { sha: sourceSha }, merge_base_commit: { sha: sourceSha },
  } }).relation, "identical");
  assert.throws(() => createProtectedSourceAuthorization({ ...base, comparison: {
    status: "diverged", ahead_by: 1, behind_by: 1, base_commit: { sha: sourceSha }, head_commit: { sha: mainSha }, merge_base_commit: { sha: "c".repeat(40) },
  } }), /not an ancestor/u);
  assert.throws(() => createProtectedSourceAuthorization({ ...base, comparison: {
    status: "ahead", ahead_by: 1, behind_by: 0, base_commit: { sha: sourceSha }, head_commit: { sha: mainSha }, merge_base_commit: { sha: "c".repeat(40) },
  } }), /comparison base and merge base/u);
  assert.throws(() => createProtectedSourceAuthorization({ ...base, checkedOutSha: "c".repeat(40), comparison: {
    status: "ahead", ahead_by: 1, behind_by: 0, base_commit: { sha: sourceSha }, head_commit: { sha: mainSha }, merge_base_commit: { sha: sourceSha },
  } }), /checked-out Git object/u);
});

test("receipt mutation or receiver disagreement is refused", () => {
  const receipt = createProtectedSourceAuthorization({ ...base, comparison: {
    status: "ahead", ahead_by: 1, behind_by: 0, base_commit: { sha: sourceSha }, head_commit: { sha: mainSha }, merge_base_commit: { sha: sourceSha },
  } });
  assert.throws(() => verifyProtectedSourceAuthorization({ ...receipt, environment: "other" }), /digest/u);
  assert.throws(() => verifyProtectedSourceAuthorization(receipt, { workflow: "other" }), /workflow disagrees/u);
});

test("GitHub comparison snapshots the protected ref then compares two exact commits", async () => {
  const calls = [];
  const receipt = await authorizeProtectedSourceFromGitHub({ ...base, token: "secret" }, { fetchImpl: async (url, init) => {
    calls.push({ url, init });
    if (url.includes("/git/ref/")) return { ok: true, status: 200, async json() { return { object: { type: "commit", sha: mainSha } }; } };
    return { ok: true, status: 200, async json() { return {
      status: "ahead", ahead_by: 3, behind_by: 0, base_commit: { sha: sourceSha }, merge_base_commit: { sha: sourceSha },
    }; } };
  } });
  assert.equal(receipt.aheadBy, 3);
  assert.equal(calls[0].url, "https://api.github.com/repos/emsenn/bare-cedar-fog/git/ref/heads/main");
  assert.equal(calls[1].url, `https://api.github.com/repos/emsenn/bare-cedar-fog/compare/${sourceSha}...${mainSha}`);
  assert.equal(calls[1].init.headers.authorization, "Bearer secret");
});
