import test from "node:test";
import assert from "node:assert/strict";
import { admittedRunnerRepository, admitPublicTestDispatch, MAX_PATCH_BYTES, WORKFLOW_COMMIT, WORKFLOW_GIT_BLOB, WORKFLOW_PATH, WORKFLOW_REF, WORKFLOW_RELEASE_ID, WORKFLOW_SHA256 } from "../src/admission.mjs";

const valid = Object.freeze({
  runnerRepository: "union/public-runner",
  runnerVisibility: "public",
  actionsEnabled: true,
  targetRepository: "upstream/project",
  targetVisibility: "public",
  targetCommit: "a".repeat(40),
  patchBytes: 1024,
  workflowPath: WORKFLOW_PATH,
  workflowRef: WORKFLOW_REF,
  workflowCommit: WORKFLOW_COMMIT,
  workflowGitBlob: WORKFLOW_GIT_BLOB,
  workflowSha256: WORKFLOW_SHA256,
  workflowReleaseId: WORKFLOW_RELEASE_ID,
  workflowReleaseImmutable: true,
});

test("admits exact public standard-runner test work", () => {
  assert.deepEqual(admitPublicTestDispatch(valid), {
    admitted: true,
    runnerRepository: "union/public-runner",
    targetRepository: "upstream/project",
    targetCommit: "a".repeat(40),
    patchBytes: 1024,
    workflowPath: WORKFLOW_PATH,
    workflowRef: WORKFLOW_REF,
    workflowCommit: WORKFLOW_COMMIT,
    workflowGitBlob: WORKFLOW_GIT_BLOB,
    workflowSha256: WORKFLOW_SHA256,
    workflowReleaseId: WORKFLOW_RELEASE_ID,
    runner: "ubuntu-latest",
    timeoutMinutes: 15,
  });
});

test("the admitted runner cannot be replaced by ambient process configuration", () => {
  const config = { runnerRepository: "emsenn/union-free-compute-runner" };
  assert.equal(admittedRunnerRepository(config, {}), config.runnerRepository);
  assert.equal(admittedRunnerRepository(config, { GITHUB_PUBLIC_COMPUTE_REPO: config.runnerRepository }), config.runnerRepository);
  assert.throws(() => admittedRunnerRepository(config, { GITHUB_PUBLIC_COMPUTE_REPO: "emsenn/bounty-runner" }), /may not override/u);
});

for (const [name, change, reason] of [
  ["private runner", { runnerVisibility: "private" }, "runner-not-public"],
  ["disabled Actions", { actionsEnabled: false }, "runner-actions-disabled"],
  ["private target", { targetVisibility: "private" }, "target-not-public"],
  ["mutable ref", { targetCommit: "main" }, "target-commit-not-immutable"],
  ["oversized patch", { patchBytes: MAX_PATCH_BYTES + 1 }, "patch-too-large"],
  ["larger workflow surface", { workflowPath: ".github/workflows/paid.yml" }, "workflow-not-admitted"],
  ["mutable workflow ref", { workflowRef: "develop" }, "workflow-ref-not-admitted"],
  ["different workflow commit", { workflowCommit: "b".repeat(40) }, "workflow-commit-not-admitted"],
  ["different workflow bytes", { workflowSha256: "b".repeat(64) }, "workflow-bytes-not-admitted"],
  ["mutable workflow release", { workflowReleaseImmutable: false }, "workflow-release-not-immutable"],
]) {
  test(`refuses ${name}`, () => {
    assert.deepEqual(admitPublicTestDispatch({ ...valid, ...change }), { admitted: false, reason });
  });
}
