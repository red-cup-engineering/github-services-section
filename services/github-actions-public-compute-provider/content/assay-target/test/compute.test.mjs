import test from "node:test";
import assert from "node:assert/strict";
import { createHash, pbkdf2Sync } from "node:crypto";

test("standard runner performs deterministic SHA-256 work", () => {
  assert.equal(
    createHash("sha256").update("bare cedar fog").digest("hex"),
    "08a24097f1fe8103288b66696be26cc78aa866b69e2e80533a028aa4e5adf58c",
  );
});

test("standard runner performs bounded PBKDF2 work", () => {
  const result = pbkdf2Sync(
    "harmonious union",
    "github-actions-public-compute/v1",
    120_000,
    32,
    "sha256",
  );
  assert.equal(result.length, 32);
  assert.equal(result.toString("hex"), "6949bec817a8726b715cbc9c91950757c71098050124c94f20839b3c64a6e4f0");
});
