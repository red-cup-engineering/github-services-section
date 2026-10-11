#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { githubApi } from "@red-cup-engineering/github-services-section";
import { admittedRunnerRepository, admitPublicTestDispatch, MAX_PATCH_BYTES, WORKFLOW_COMMIT, WORKFLOW_GIT_BLOB, WORKFLOW_PATH, WORKFLOW_REF, WORKFLOW_RELEASE_ID, WORKFLOW_SHA256 } from "../src/admission.mjs";
import { sha256Hex } from "@red-cup-engineering/cryptographic-computer-data-engineering-services-section/integrity";

function usage() {
  return "usage: dispatch-public-test-compute OWNER/REPO 40_HEX_COMMIT [PATCH_FILE]";
}

const [targetRepository, targetCommit, patchPath, ...extra] = process.argv.slice(2);
if (!targetRepository || !targetCommit || extra.length) throw new Error(usage());
const config = JSON.parse(await readFile(fileURLToPath(new URL("../content/config/github-public-compute.json", import.meta.url)), "utf8"));
const runnerRepository = admittedRunnerRepository(config);
const workflowBytes = await readFile(fileURLToPath(new URL(`../content/workflows/${basename(WORKFLOW_PATH)}`, import.meta.url)));
if (config.workflowRef !== WORKFLOW_REF || config.workflowCommit !== WORKFLOW_COMMIT || config.workflowGitBlob !== WORKFLOW_GIT_BLOB || config.workflowSha256 !== WORKFLOW_SHA256 || config.workflowReleaseId !== WORKFLOW_RELEASE_ID || sha256Hex(workflowBytes) !== WORKFLOW_SHA256) throw new Error("local public-compute workflow binding is not the admitted immutable revision");

const patch = patchPath ? await readFile(patchPath) : Buffer.alloc(0);
if (patch.length > MAX_PATCH_BYTES) throw new Error(`patch exceeds ${MAX_PATCH_BYTES} bytes`);
const github = githubApi();
const [runner, policy, target, commit, workflowRef, workflow, release] = await Promise.all([
  github.getRepo(runnerRepository),
  github.getActionsPermissions(runnerRepository),
  github.getRepo(targetRepository),
  github.getCommit(targetRepository, targetCommit),
  github.getTagRef(runnerRepository, WORKFLOW_REF),
  github.getContentRecord(runnerRepository, WORKFLOW_COMMIT, WORKFLOW_PATH),
  github.getReleaseByTag(runnerRepository, WORKFLOW_REF),
]);
if (commit.sha?.toLowerCase() !== targetCommit.toLowerCase()) throw new Error("target commit identity drifted");
const remoteWorkflow = workflow?.encoding === "base64" && typeof workflow.content === "string" ? Buffer.from(workflow.content.replace(/\s/gu, ""), "base64") : null;
if (workflowRef?.object?.type !== "commit" || workflowRef.object.sha !== WORKFLOW_COMMIT || workflow?.type !== "file" || workflow.sha !== WORKFLOW_GIT_BLOB || !remoteWorkflow || sha256Hex(remoteWorkflow) !== WORKFLOW_SHA256 || !remoteWorkflow.equals(workflowBytes)) throw new Error("public-compute workflow tag or bytes drifted from the admitted revision");
const workflowReleaseImmutable = release?.id === WORKFLOW_RELEASE_ID && release.tag_name === WORKFLOW_REF && release.draft === false && release.immutable === true;
if (!workflowReleaseImmutable) throw new Error("public-compute workflow tag lacks its exact published immutable release");

const decision = admitPublicTestDispatch({
  runnerRepository,
  runnerVisibility: runner.visibility,
  actionsEnabled: policy.enabled,
  targetRepository,
  targetVisibility: target.visibility,
  targetCommit,
  patchBytes: patch.length,
  workflowPath: WORKFLOW_PATH,
  workflowRef: WORKFLOW_REF,
  workflowCommit: workflowRef.object.sha,
  workflowGitBlob: workflow.sha,
  workflowSha256: sha256Hex(remoteWorkflow),
  workflowReleaseId: release.id,
  workflowReleaseImmutable,
});
if (!decision.admitted) throw new Error(`dispatch refused: ${decision.reason}`);

await github.dispatchWorkflow(runnerRepository, basename(WORKFLOW_PATH), WORKFLOW_REF, {
  target_repository: decision.targetRepository,
  target_commit: decision.targetCommit,
  patch_base64: patch.toString("base64"),
});
process.stdout.write(`${JSON.stringify({
  type: "GitHubPublicTestComputeDispatchAccepted",
  runnerRepository,
  targetRepository: decision.targetRepository,
  targetCommit: decision.targetCommit,
  patchBytes: decision.patchBytes,
  workflowRef: decision.workflowRef,
  workflowCommit: decision.workflowCommit,
  workflowSha256: decision.workflowSha256,
  workflowReleaseId: decision.workflowReleaseId,
  runner: decision.runner,
  timeoutMinutes: decision.timeoutMinutes,
})}\n`);
