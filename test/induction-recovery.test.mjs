import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { executeInductionSaga } from "../src/induction-saga.mjs";
import { fixture, recordAt, remoteAt, request, run, store } from "./fixtures/induction-recovery.mjs";

const worker = fileURLToPath(new URL("./fixtures/induction-recovery.mjs", import.meta.url));
const restart = (root, mode) => spawnSync(process.execPath, [worker, root, mode], { encoding: "utf8", timeout: 30_000 });
const setup = (t) => {
  const root = mkdtempSync(join(tmpdir(), "induction-recovery-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  fixture(root); return root;
};
for (const mode of ["get-failure", "get-not-yet-visible", "crash-created", "patch-read-failure"]) {
  test(`a fresh process resumes ${mode} using the retained repository ID without duplicate creation`, (t) => {
    const root = setup(t), failed = restart(root, mode);
    assert.equal(failed.status, mode === "crash-created" ? 91 : 1, failed.stderr);
    assert.equal(recordAt(root).state, mode === "crash-created" ? "repository-created" : "repository-receiving-pending");
    assert.deepEqual(recordAt(root).createdRepository, { repository: "union/created", id: 123 });
    const recovered = restart(root, "healthy");
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(JSON.parse(recovered.stdout).disposition, "bound");
    const remote = remoteAt(root);
    assert.equal(remote.creates, 1);
    assert.equal(remote.patches, mode === "patch-read-failure" ? 1 : 0);
    assert.equal(remote.commits, 1); assert.equal(remote.refs, 1);
    const duplicate = restart(root, "healthy");
    assert.equal(duplicate.status, 0, duplicate.stderr);
    assert.deepEqual(JSON.parse(duplicate.stdout), JSON.parse(recovered.stdout));
    assert.deepEqual(remoteAt(root), remote);
  });
}
test("an unresolved settings attempt is observed on restart but never blindly repeated", (t) => {
  const root = setup(t);
  assert.equal(restart(root, "patch-pending").status, 1);
  const replay = restart(root, "healthy");
  assert.equal(replay.status, 1); assert.match(replay.stderr, /refusing to repeat/);
  assert.equal(recordAt(root).state, "repository-receiving-pending");
  assert.equal(remoteAt(root).creates, 1); assert.equal(remoteAt(root).patches, 1);
  assert.equal(remoteAt(root).refs, 0);
  const received = remoteAt(root); received.repository.delete_branch_on_merge = true;
  writeFileSync(join(root, "remote.json"), JSON.stringify(received));
  const recovered = restart(root, "healthy");
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(remoteAt(root).patches, 1); assert.equal(remoteAt(root).refs, 1);
});
for (const mode of ["post-denied", "get-denied", "patch-denied", "identity-changed"]) {
  test(`${mode} remains a genuine refusal across process restart`, (t) => {
    const root = setup(t);
    assert.equal(restart(root, mode).status, 1);
    assert.equal(recordAt(root).state, "refused");
    if (mode !== "post-denied") assert.equal(recordAt(root).createdRepository.id, 123);
    const remote = remoteAt(root), replay = restart(root, "healthy");
    assert.equal(replay.status, 1); assert.match(replay.stderr, /already refused/);
    assert.deepEqual(remoteAt(root), remote); assert.equal(remote.refs, 0);
  });
}
test("a lost POST response cannot authorize another creation or adoption by name", (t) => {
  const root = setup(t);
  assert.equal(restart(root, "post-lost").status, 1);
  assert.equal(recordAt(root).state, "repository-creation-uncertain");
  assert.equal(recordAt(root).createdRepository, undefined);
  assert.equal(remoteAt(root).repository.id, 123);
  const remote = remoteAt(root), replay = restart(root, "healthy");
  assert.equal(replay.status, 1); assert.match(replay.stderr, /creation-uncertain/);
  assert.deepEqual(remoteAt(root), remote);
});
test("source verification denial during receiving recovery becomes a persistent refusal", (t) => {
  const root = setup(t);
  assert.equal(restart(root, "get-failure").status, 1);
  const denied = restart(root, "verification-denied");
  assert.equal(denied.status, 1); assert.match(denied.stderr, /before-state drift/);
  assert.equal(recordAt(root).state, "refused");
  assert.equal(recordAt(root).createdRepository.id, 123);
  assert.equal(restart(root, "healthy").status, 1);
  assert.equal(remoteAt(root).creates, 1); assert.equal(remoteAt(root).refs, 0);
});
test("a reused request ID cannot substitute another target during recovery", async (t) => {
  const root = setup(t);
  assert.equal(restart(root, "get-failure").status, 1);
  const altered = structuredClone(request); altered.input.target.repository = "union/foreign";
  await assert.rejects(executeInductionSaga(altered, { operationStore: store(root), induce: async () => assert.fail("must not induce") }), /input differs/);
  assert.equal(recordAt(root).state, "repository-receiving-pending");
});
test("a resumed receiver fences the original invocation before publication", async (t) => {
  const root = setup(t);
  let release, waiting;
  const gate = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { waiting = resolve; });
  const original = run(root, "healthy", async () => { waiting(); await gate; });
  const originalOutcome = original.then((value) => ({ value }), (error) => ({ error }));
  await entered;
  try {
    assert.equal((await run(root)).disposition, "bound");
  } finally { release(); }
  assert.match((await originalOutcome).error.message, /stale operation-store version/);
  assert.equal(recordAt(root).state, "bound");
  assert.equal(remoteAt(root).creates, 1); assert.equal(remoteAt(root).commits, 1); assert.equal(remoteAt(root).refs, 1);
});
