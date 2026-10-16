# Repository defaults receiving, 2026-10-16

The authorized sweep enabled `delete_branch_on_merge` for 117 verified Group
repositories. Independent authenticated reads received all 117 changes. Another
292 active selected repositories already had the setting enabled; three archived
repositories were skipped. The inventory covered 779 repositories across eleven
pages; 367 personal repositories without established Group membership were
excluded from mutation.

`coverage.json` records the inventory, selection counts, observation times and
evidence hashes. `verified-changes.jsonl` and `exact-setting-changes.csv` retain
the exact changed identities and before/after observations. Three immediate
readbacks lagged successful updates; later independent observations received all
three without retrying their mutations.

The sweep used the existing authenticated GitHub CLI directly. It preceded the
reusable owner reconciler in this change and is not evidence that the new CLI
performed the sweep. `qualification.json` separately records the 31 passing
owner tests, exact tested source hashes, packed bytes and live no-op receiving
of the packaged CLI in plan and apply modes. Shared compute qualification held
the existing exclusive lease. Creation and mutation behavior was tested at the
provider boundary; no test repository was created.

`recovery-qualification.json` records the subsequent source-review repair:
45 owner tests, three acceptance tests in the existing private service consumer,
the packed owner, and live CLI no-op receiving with a hostile inherited
`GH_HOST`. It supersedes the initial source qualification for the changed
implementation while preserving the original 117-setting observations.

GitHub documents `delete_branch_on_merge` as false when omitted during
[organization repository creation](https://docs.github.com/en/rest/repos/repos#create-an-organization-repository),
and requires an organization owner to set it true on that request. The creation
path now requests that value explicitly and verifies the returned repository
identity through a separate read. Provider refusal remains a failure; this
change does not grant or broaden authority.

Existing-branch cleanup remains the Git Services owner's separate procedure and
receipts. This record contains no credentials, environment-file contents or
unverified personal-repository names. Source review, integration, publication
and deployment remain separate from these observations.
