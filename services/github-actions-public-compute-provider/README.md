# GitHub Actions Public Compute Provider

This provider spends GitHub's free, unlimited standard-runner allowance for
public repositories on bounded software tests. It is not a general shell or a
durable server. Each dispatch names an immutable commit in a public repository
and may add one base64-encoded unified diff of at most 48 KiB. The workflow
chooses a known test harness and stops after 15 minutes.

Dispatch uses the independently owned `github-services-section` provider for
every GitHub REST read and workflow dispatch. The caller supplies no raw
GitHub URL or request shape; provider credential custody is through
`GITHUB_SERVICES_TOKEN`.

Dispatch uses the `bounded-public-test-v1` tag only after resolving it to the
admitted commit and verifying both the Git blob identity and SHA-256 bytes of
the remote workflow against the provider-carried workflow. The tag is bound to
published immutable GitHub release `358118180`; GitHub makes that tag
unmovable and non-reusable at the server boundary. An absent or mutable
release, moved tag, or changed workflow fails closed before GitHub receives a
dispatch.

The runner repository and its logs are public. Do not submit proprietary source,
secrets, personal data, or secret-bearing tests. The workflow uses no cache,
artifact, environment secret, third-party action, larger runner, or self-hosted
runner. The local dispatcher refuses unless GitHub reports both the runner and
target repositories public and Actions enabled on the runner.
