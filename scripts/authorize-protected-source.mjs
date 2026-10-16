#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { authorizeProtectedSourceFromGitHub, verifyProtectedSourceAuthorization } from "../src/protected-source-authorization.mjs";

const args = process.argv.slice(2);
const operation = args.shift();
const option = (name, required = true) => {
  const index = args.indexOf(name);
  if (index >= 0 && args[index + 1]) return args[index + 1];
  if (required) throw new TypeError(`${name} is required`);
  return undefined;
};

if (operation === "create") {
  const receipt = await authorizeProtectedSourceFromGitHub({
    repository: process.env.GITHUB_REPOSITORY,
    token: process.env.GITHUB_TOKEN,
    sourceSha: option("--source-sha"),
    checkedOutSha: option("--checked-out-sha"),
    protectedRef: option("--protected-ref"),
    workflow: process.env.GITHUB_WORKFLOW_REF,
    environment: option("--environment"),
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  });
  await writeFile(resolve(option("--receipt")), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
} else if (operation === "verify") {
  const receipt = JSON.parse(await readFile(resolve(option("--receipt")), "utf8"));
  const admitted = verifyProtectedSourceAuthorization(receipt, {
    repository: process.env.GITHUB_REPOSITORY,
    sourceSha: option("--source-sha"),
    checkedOutSha: option("--checked-out-sha"),
    protectedRef: option("--protected-ref"),
    workflow: process.env.GITHUB_WORKFLOW_REF,
    environment: option("--environment"),
  });
  process.stdout.write(`${JSON.stringify(admitted)}\n`);
} else {
  throw new TypeError("operation must be create or verify");
}
