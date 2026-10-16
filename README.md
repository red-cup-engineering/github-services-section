# GitHub services section

This package owns bounded GitHub API contracts shared by automation.

`githubApi().createOrgRepository` explicitly enables `delete_branch_on_merge`
and reads the created repository back before returning. This default reaches
the existing sovereign software-induction creation path; GitHub's omitted-field
default is false.

`reconcile-github-repository-defaults SELECTION.json [plan|apply]` repairs drift
using the existing authenticated GitHub CLI. The JSON selection is an array of
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
