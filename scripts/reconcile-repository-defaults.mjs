#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { reconcileRepositoryDefaults } from "../src/github-api.mjs";

const [selectionFile, mode = "plan"] = process.argv.slice(2);
if (!selectionFile || !["plan", "apply"].includes(mode)) {
  throw new Error("usage: reconcile-github-repository-defaults SELECTION.json [plan|apply]");
}
// This is an explicit invocation selection, not a repository-ownership registry.
// The caller must independently establish Group ownership and authority.
const selection = JSON.parse(readFileSync(selectionFile, "utf8"));
if (!Array.isArray(selection) || selection.length === 0) throw new Error("select at least one verified repository");
const ids = new Set(), names = new Set();
for (const row of selection) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(row?.repository ?? "")
      || row.repository.split("/").some((part) => part === "." || part === "..")
      || !Number.isSafeInteger(row.expectedId) || row.expectedId < 1
      || ids.has(row.expectedId) || names.has(row.repository.toLowerCase())) {
    throw new Error("selection must contain distinct exact repository names and numeric IDs");
  }
  ids.add(row.expectedId); names.add(row.repository.toLowerCase());
}
const request = (method, repository, body) => JSON.parse(execFileSync("gh", [
  "api", "--method", method, `repos/${repository}`, ...(body ? ["--input", "-"] : []),
], { encoding: "utf8", input: body ? JSON.stringify(body) : undefined, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 }));
const api = {
  getRepo: (repository) => request("GET", repository),
  enableMergedBranchDeletion: (repository) => request("PATCH", repository, { delete_branch_on_merge: true }),
};
for (const row of selection) {
  try {
    const result = await reconcileRepositoryDefaults({ ...row, apply: mode === "apply" }, api);
    process.stdout.write(JSON.stringify({ ...result, observedAt: new Date().toISOString() }) + "\n");
  } catch (error) {
    process.exitCode = 1;
    process.stdout.write(JSON.stringify({ repository: row.repository, id: row.expectedId, disposition: "failed", error: error.message }) + "\n");
  }
}
