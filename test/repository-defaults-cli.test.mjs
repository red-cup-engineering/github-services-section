import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("the packaged CLI pins github.com despite an inherited hostile GH_HOST", () => {
  const root = mkdtempSync(join(tmpdir(), "github-defaults-host-"));
  try {
    const input = join(root, "selection.json"), trace = join(root, "calls.jsonl");
    writeFileSync(input, JSON.stringify([valid]));
    writeFileSync(join(root, "gh"), `#!${process.execPath}
import fs from "node:fs";
const args = process.argv.slice(2), at = args.indexOf("--hostname");
const host = at < 0 ? process.env.GH_HOST : args[at + 1];
fs.appendFileSync(process.env.GH_TRACE, JSON.stringify({ args, host, inheritedHost: process.env.GH_HOST }) + "\\n");
if (host !== "github.com") process.exit(87);
process.stdout.write(JSON.stringify({ id: 123, full_name: "union/project", delete_branch_on_merge: true }));
`, { mode: 0o755 });
    for (const mode of ["plan", "apply"]) {
      const result = spawnSync(process.execPath, [script, input, mode], {
        encoding: "utf8", env: { PATH: root, HOME: root, TMPDIR: root, GH_HOST: "hostile.example.invalid", GH_TRACE: trace },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).disposition, "already-enabled");
    }
    const calls = readFileSync(trace, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(calls.length, 2);
    assert.ok(calls.every(({ host, inheritedHost, args }) => host === "github.com"
      && inheritedHost === "hostile.example.invalid" && args[args.indexOf("--method") + 1] === "GET"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
