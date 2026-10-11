# GitHub services section

This package owns bounded GitHub API contracts shared by automation.

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
