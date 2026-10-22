# GitHub services section

<!-- 561-group-standards:badges:start -->
[![Red Cup Engineering](https://img.shields.io/badge/561%20Group-Red%20Cup%20Engineering-c0392b)](https://github.com/red-cup-engineering)
[![License: MIT](https://img.shields.io/badge/license-MIT-c0392b)](LICENSE)
[![Indigenous data: CARE](https://img.shields.io/badge/Indigenous%20data-CARE-4b6f44)](https://github.com/red-cup-engineering/.github/blob/main/GOVERNANCE.md)
[![Tips welcome](https://img.shields.io/badge/tips-welcome-d4a017)](https://github.com/561-group/.github/blob/main/TIPS.md)
<!-- 561-group-standards:badges:end -->

This package owns bounded GitHub API contracts shared by automation.

`githubApi().createOrgRepository` explicitly enables `delete_branch_on_merge`
and returns the POST receipt without a fallible follow-up call. The existing
sovereign software-induction owner persists the returned numeric repository
identity before receiving the default through a separate read. GitHub's
omitted-field default is false.

The durable induction saga records a creation attempt before POST. Receiving
failure after a successful creation retains that ID and permits the exact same
request to re-verify its proposal and resume receiving after restart. Settings
updates are also recorded before PATCH: an uncertain update is observed on
replay and is never blindly repeated. Compare-and-set transitions fence the
old receiver before publication. A lost creation response without a durable
numeric ID remains creation-uncertain; it cannot authorize another POST or
adoption of a same-name repository. Provider permission/validation denials,
identity changes and proposal verification failures remain terminal refusals.

`reconcile-github-repository-defaults SELECTION.json [plan|apply]` repairs drift
using the existing authenticated GitHub CLI, explicitly pinned to `github.com`
regardless of inherited `GH_HOST`. The JSON selection is an array of
`{ "repository": "owner/name", "expectedId": 123 }` records whose ownership and
authority the caller has already verified. The default mode is read-only. Apply
mode checks the current identity and administrator capability, skips archived
or disabled repositories, and sends only `{ "delete_branch_on_merge": true }`.
Every attempted change is read back, including uncertain responses; replays of
enabled repositories do not write. Results are emitted per repository as JSON
lines, and any failed item makes the command exit unsuccessfully.

The reconciler does not enumerate or delete existing refs, widen access,
unarchive repositories, or create a schedule. Protected branches remain subject
to GitHub's existing controls. Run it from the existing authorized provisioning
or maintenance work when checking repository defaults; unverified personal
repositories are not an implied selection.

`authorize-protected-source` separates an immutable release source from the
moving tip of its protected branch. It compares the requested full commit to
the current protected ref through GitHub's compare API and admits only an exact
checkout whose commit is the ref itself or an ancestor of it. Ordinary commits
landing on `main` therefore do not revoke an already selected release, while a
diverged, force-pushed, abbreviated, or foreign commit remains inadmissible.

The resulting receipt binds the requested and checked-out SHA, the
observed protected-ref SHA and ancestry relation, repository, workflow,
protected environment identity, workflow run/attempt, and authorization time.
Downstream jobs verify that receipt without consulting a newer branch tip.
GitHub protected environments continue to own approval; this service records
the environment under which the workflow invoked it and does not emulate
GitHub's approval mechanism.
