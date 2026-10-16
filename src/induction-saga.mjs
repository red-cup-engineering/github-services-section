import { isDeepStrictEqual } from "node:util";
import { isDefinitiveGithubRejection } from "./github-api.mjs";

export const STATES = Object.freeze(["received", "admitted", "materialized", "verified", "repository-creation-attempted", "repository-creation-uncertain", "repository-created", "repository-receiving", "repository-defaults-attempted", "repository-receiving-pending", "repository-ready", "publication-attempted", "bound", "refused", "publication-uncertain", "response-delivered"]);
const TERMINAL = new Set(["bound", "refused", "publication-uncertain", "response-delivered"]);
const RECEIVING = new Set(["repository-created", "repository-receiving", "repository-defaults-attempted", "repository-receiving-pending"]);
// A durable repository-ready transition precedes fallible Git object publication.
// It is a recoverable boundary, not evidence that a branch or commit exists.
const RESUMABLE = new Set(["admitted", "materialized", "verified", "repository-ready", ...RECEIVING]);
const TRANSPORT_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN",
  "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"]);
function transientSourceOrProviderFailure(error) {
  if (isDefinitiveGithubRejection(error)) return false;
  if (error?.retryable === true || error?.status === 408 || error?.status === 429
      || (Number.isInteger(error?.status) && error.status >= 500 && error.status < 600)
      || TRANSPORT_CODES.has(error?.code)) return true;
  return error?.cause && error.cause !== error
    ? transientSourceOrProviderFailure(error.cause) : false;
}
const errorBody = (error) => ({ name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error) });

/**
 * Durable operation-store contract, supplied by the hosting runtime:
 *   get(operation) -> immutable current record or null
 *   compareAndSet(operation, expectedVersion|null, record) -> stored record
 *
 * `compareAndSet` must reject a stale expectedVersion and return a record with
 * its new opaque `version`. SQLite provides this contract on the active host.
 */
function assertStore(store) {
  if (!store || typeof store.get !== "function" || typeof store.compareAndSet !== "function") {
    throw new Error("GitHub induction requires an injected durable operation store with get and compareAndSet");
  }
}
function pending(record) { return new Error(`GitHub induction operation is already ${record.state}; its admitted owner must resume or reconcile it`); }

export async function executeInductionSaga(request, { induce, provider = {}, operationStore } = {}) {
  if (typeof request?.id !== "string" || request.id === "") throw new Error("induction saga requires the exact request identity");
  if (typeof induce !== "function") throw new Error("induction saga requires an induction operation");
  assertStore(operationStore);
  const key = request.id;
  let saga = await operationStore.get(key);
  const transition = async (state, extra = {}) => {
    const next = { operation: key, input: request.input, ...saga, ...extra, version: undefined, updatedAt: new Date().toISOString(), state };
    saga = await operationStore.compareAndSet(key, saga?.version ?? null, next);
    if (!saga || saga.operation !== key || saga.state !== state || saga.version === undefined) throw new Error("durable operation store returned an invalid transition record");
    return saga;
  };
  if (!saga) {
    try { await transition("received"); } catch (error) { saga = await operationStore.get(key); if (!saga) throw error; }
  }
  if (saga.operation !== key) throw new Error("induction saga coordinate collision");
  if (!isDeepStrictEqual(saga.input, request.input)) throw new Error("induction saga request input differs from its durable identity");
  if (saga.result && TERMINAL.has(saga.state)) return saga.result;
  if (saga.state === "publication-attempted") {
    const target = request.input?.target ?? { repository: request.input?.source?.repository, ref: "heads/main" };
    try {
      const head = await provider.api?.getRef?.(target.repository, target.ref.slice("heads/".length));
      const commit = head && await provider.api?.getCommit?.(target.repository, head), marker = `Induction-Request: ${key}`;
      if (commit?.message?.includes(marker) && (target.create || commit.parents?.some((parent) => (parent.sha ?? parent) === request.input?.source?.commit))) {
        const result = Object.freeze({ disposition: "bound", provider: "urn:ame:github-software-induction-service", operation: key, repository: target.repository, ref: target.ref, priorCommit: target.create ? null : request.input.source.commit, commit: head, recovered: true });
        await transition("bound", { result }); return result;
      }
    } catch (error) { await transition("publication-uncertain", { error: errorBody(error) }); throw error; }
    const error = new Error("GitHub publication outcome is uncertain; refusing to rerun mutation"); await transition("publication-uncertain", { error: errorBody(error) }); throw error;
  }
  const repositoryRecovery = saga.createdRepository && RESUMABLE.has(saga.state)
    ? { createdRepository: saga.createdRepository, repositoryDefaultsAttempted: saga.repositoryDefaultsAttempted === true }
    : undefined;
  if (repositoryRecovery && (request.input?.target?.create !== true
      || repositoryRecovery.createdRepository.repository.toLowerCase() !== request.input.target.repository?.toLowerCase()
      || !Number.isSafeInteger(repositoryRecovery.createdRepository.id) || repositoryRecovery.createdRepository.id < 1)) {
    throw new Error("durable created repository does not match the admitted target");
  }
  if (saga.state !== "received" && !repositoryRecovery) throw pending(saga);
  // This CAS is the admission ownership claim. A concurrent delivery that loses
  // it cannot reach the GitHub mutation and must observe/retry the owner.
  try { await transition("admitted"); } catch (error) { saga = await operationStore.get(key); if (saga?.state !== "admitted") throw error; throw pending(saga); }
  try {
    const result = await induce(request.input, { ...provider, operationKey: key, repositoryRecovery,
      onState: async (state, evidence) => { await transition(state, evidence); } });
    const correlated = Object.freeze({ ...result, operation: key }); await transition("bound", { result: correlated }); return correlated;
  } catch (error) {
    if (saga.state !== "publication-attempted") {
      // No repository ID means no evidence that would authorize adopting a
      // same-name repository or issuing POST again after an ambiguous attempt.
      const state = saga.state === "repository-creation-attempted" && !isDefinitiveGithubRejection(error)
        ? "repository-creation-uncertain"
        : saga.createdRepository && (
            (RECEIVING.has(saga.state) && !isDefinitiveGithubRejection(error))
            || (RESUMABLE.has(saga.state) && transientSourceOrProviderFailure(error)))
          ? "repository-receiving-pending" : "refused";
      await transition(state, { error: errorBody(error) });
    }
    throw error;
  }
}

export async function markInductionResponseDelivered(requestId, { operationStore } = {}) {
  assertStore(operationStore);
  const saga = await operationStore.get(requestId);
  if (!saga || saga.operation !== requestId || !saga.result) throw new Error("cannot mark an unknown induction response delivered");
  return operationStore.compareAndSet(requestId, saga.version, { ...saga, version: undefined, state: "response-delivered", updatedAt: new Date().toISOString() });
}
