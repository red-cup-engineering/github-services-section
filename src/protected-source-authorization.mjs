import { semanticId } from "@red-cup-engineering/computer-content-address-engineering-services-section/semiotic-content-address";

const SHA = /^[a-f0-9]{40}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const PROTECTED_REF = /^refs\/heads\/[A-Za-z0-9._/-]+$/u;
const WORKFLOW = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml@refs\/heads\/[A-Za-z0-9._/-]+$/u;
const RECEIPT_TYPE = "GitHubProtectedSourceAuthorizationReceipt";

function exact(value, label, pattern) {
  if (typeof value !== "string" || !pattern.test(value)) throw new TypeError(`invalid ${label}`);
  return value;
}

function positiveInteger(value, label) {
  const number = typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < 1) throw new TypeError(`invalid ${label}`);
  return number;
}


export function createProtectedSourceAuthorization({
  repository,
  sourceSha,
  checkedOutSha,
  protectedRef = "refs/heads/main",
  comparison,
  observedProtectedSha: observedProtectedShaInput,
  workflow,
  environment,
  runId,
  runAttempt,
  authorizedAt = new Date().toISOString(),
}) {
  exact(repository, "repository", REPOSITORY);
  exact(sourceSha, "source SHA", SHA);
  exact(checkedOutSha, "checked-out SHA", SHA);
  exact(protectedRef, "protected ref", PROTECTED_REF);
  exact(workflow, "workflow ref", WORKFLOW);
  if (checkedOutSha !== sourceSha) throw new Error("checked-out Git object disagrees with requested source");
  if (typeof environment !== "string" || environment === "" || /[\r\n]/u.test(environment)) throw new TypeError("invalid protected environment identity");
  if (!comparison || !new Set(["ahead", "identical"]).has(comparison.status)) throw new Error("requested source is not an ancestor of the protected ref");
  const observedProtectedSha = exact(observedProtectedShaInput ?? comparison.head_commit?.sha, "observed protected-ref SHA", SHA);
  const comparedBaseSha = exact(comparison.base_commit?.sha, "comparison base SHA", SHA);
  const mergeBaseSha = exact(comparison.merge_base_commit?.sha, "comparison merge-base SHA", SHA);
  if (comparedBaseSha !== sourceSha || mergeBaseSha !== sourceSha) throw new Error("requested source is not the protected ref's exact comparison base and merge base");
  const aheadBy = Number(comparison.ahead_by);
  const behindBy = Number(comparison.behind_by);
  if (!Number.isSafeInteger(aheadBy) || aheadBy < 0 || behindBy !== 0
    || (comparison.status === "identical" && (aheadBy !== 0 || observedProtectedSha !== sourceSha))
    || (comparison.status === "ahead" && (aheadBy < 1 || observedProtectedSha === sourceSha))) {
    throw new Error("protected-ref comparison is internally inconsistent");
  }
  const body = Object.freeze({
    type: RECEIPT_TYPE,
    version: 1,
    repository,
    sourceSha,
    checkedOutSha,
    protectedRef,
    observedProtectedSha,
    relation: comparison.status === "identical" ? "identical" : "ancestor",
    aheadBy,
    workflow,
    environment,
    run: Object.freeze({ id: positiveInteger(runId, "workflow run ID"), attempt: positiveInteger(runAttempt, "workflow run attempt") }),
    authorizedAt: exact(authorizedAt, "authorization timestamp", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u),
  });
  return Object.freeze({ ...body, receiptDigest: semanticId(body) });
}

export function verifyProtectedSourceAuthorization(receipt, expected = {}) {
  if (!receipt || receipt.type !== RECEIPT_TYPE || receipt.version !== 1) throw new TypeError("unsupported protected-source authorization receipt");
  const { receiptDigest, ...body } = receipt;
  if (receiptDigest !== semanticId(body)) throw new Error("protected-source authorization receipt digest is invalid");
  exact(receipt.repository, "receipt repository", REPOSITORY);
  exact(receipt.sourceSha, "receipt source SHA", SHA);
  exact(receipt.checkedOutSha, "receipt checked-out SHA", SHA);
  exact(receipt.protectedRef, "receipt protected ref", PROTECTED_REF);
  exact(receipt.observedProtectedSha, "receipt observed protected-ref SHA", SHA);
  exact(receipt.workflow, "receipt workflow ref", WORKFLOW);
  exact(receipt.authorizedAt, "receipt authorization timestamp", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u);
  if (typeof receipt.environment !== "string" || receipt.environment === "" || /[\r\n]/u.test(receipt.environment)) throw new TypeError("invalid receipt protected environment identity");
  positiveInteger(receipt.run?.id, "receipt workflow run ID");
  positiveInteger(receipt.run?.attempt, "receipt workflow run attempt");
  for (const [field, value] of Object.entries(expected)) {
    if (value !== undefined && receipt[field] !== value) throw new Error(`protected-source authorization ${field} disagrees with the receiver`);
  }
  if (receipt.checkedOutSha !== receipt.sourceSha || !new Set(["ancestor", "identical"]).has(receipt.relation)
    || !Number.isSafeInteger(receipt.aheadBy) || receipt.aheadBy < 0
    || (receipt.relation === "identical" && (receipt.aheadBy !== 0 || receipt.observedProtectedSha !== receipt.sourceSha))
    || (receipt.relation === "ancestor" && (receipt.aheadBy < 1 || receipt.observedProtectedSha === receipt.sourceSha))) throw new Error("protected-source authorization identity is invalid");
  return Object.freeze(structuredClone(receipt));
}

export async function authorizeProtectedSourceFromGitHub(input, { fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("GitHub comparison fetch is required");
  const repository = exact(input?.repository, "repository", REPOSITORY);
  const sourceSha = exact(input?.sourceSha, "source SHA", SHA);
  const protectedRef = exact(input?.protectedRef ?? "refs/heads/main", "protected ref", PROTECTED_REF);
  const token = input?.token;
  if (typeof token !== "string" || token === "") throw new TypeError("GitHub token is required");
  const branch = protectedRef.slice("refs/heads/".length);
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "user-agent": "github-protected-source-authorization-service",
    "x-github-api-version": "2022-11-28",
  };
  const refResponse = await fetchImpl(`https://api.github.com/repos/${repository}/git/ref/heads/${encodeURIComponent(branch)}`, { headers });
  if (!refResponse?.ok) throw new Error(`GitHub protected-ref observation failed with status ${refResponse?.status ?? "unknown"}`);
  const ref = await refResponse.json();
  if (ref?.object?.type !== "commit") throw new Error("GitHub protected ref does not resolve to a commit");
  const observedProtectedSha = exact(ref.object.sha, "observed protected-ref SHA", SHA);
  const url = `https://api.github.com/repos/${repository}/compare/${sourceSha}...${observedProtectedSha}`;
  const response = await fetchImpl(url, { headers });
  if (!response?.ok) throw new Error(`GitHub protected-ref comparison failed with status ${response?.status ?? "unknown"}`);
  return createProtectedSourceAuthorization({ ...input, repository, sourceSha, protectedRef, observedProtectedSha, comparison: await response.json() });
}
