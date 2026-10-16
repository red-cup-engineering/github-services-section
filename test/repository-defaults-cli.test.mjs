import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("../scripts/reconcile-repository-defaults.mjs", import.meta.url));
const valid = { repository: "union/project", expectedId: 123 };
for (const [label, selection] of [
  ["empty selection", []],
  ["duplicate repository ID", [valid, { repository: "union/other", expectedId: 123 }]],
  ["case-alias name", [valid, { repository: "Union/Project", expectedId: 456 }]],
  ["traversal after a valid entry", [valid, { repository: "../project", expectedId: 456 }]],
]) {
  test(`the complete ${label} is refused before any provider command`, () => {
    const root = mkdtempSync(join(tmpdir(), "github-defaults-cli-"));
    try {
      const input = join(root, "selection.json");
      writeFileSync(input, JSON.stringify(selection));
      // No gh executable or credential context is available: a provider call
      // would fail differently and cannot make this input-validation test pass.
      const result = spawnSync(process.execPath, [script, input, "apply"], {
        encoding: "utf8", env: { PATH: "", HOME: root, TMPDIR: root },
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /select at least one verified repository|selection must contain distinct exact repository names and numeric IDs/);
      assert.equal(result.stdout, "");
      assert.doesNotMatch(result.stderr, /spawnSync gh/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
