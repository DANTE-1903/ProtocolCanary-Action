# Shared contracts

The interfaces this Action shares with `Protocol-Canary` and
`ProtocolCanary-Fixtures` are defined once, in
[`Protocol-Canary/docs/contracts/`](https://github.com/StellarCanary/Protocol-Canary/blob/main/docs/contracts/README.md).
This page lists what each contract asks of the Action. It does not repeat the
rules.

The Action stays a thin wrapper: the CLI decides compatibility, verifies
fixture digests and lockfiles, and computes comparisons. The Action runs it and
shows the answer. Some of the work below is implemented; the rest is
incomplete or waits on a CLI release. The table separates the two.

| Contract | What the Action does | Status |
|---|---|---|
| [CF-01 Report](https://github.com/StellarCanary/Protocol-Canary/blob/main/docs/contracts/cf-01-report.md) | Validates reports as section 7 describes (`parseReport` in `src/output.ts`), tolerates reserved additive fields, rejects duplicate result identities, and never shows a zero-check run as a success (`allow-empty` must be set to accept one). | Implemented |
| [CF-03 Lockfile](https://github.com/StellarCanary/Protocol-Canary/blob/main/docs/contracts/cf-03-lockfile.md) | Would surface the CLI's lock verification result and not parse digests itself. | Not implemented: the Action has no lockfile handling today |
| [CF-05 Comparison](https://github.com/StellarCanary/Protocol-Canary/blob/main/docs/contracts/cf-05-report-comparison.md) | The `baseline-report` input is validated before the run (the file must exist and be a complete schemaVersion 1 report) and its target protocol must match the run's. The CLI `diff` command is not released (#335), so the baseline is not passed to it and the Action produces no comparison or regression verdict. | Partial: baseline validation only; comparison deferred until `diff` ships |
| [CF-06 Fixture releases](https://github.com/StellarCanary/Protocol-Canary/blob/main/docs/contracts/cf-06-fixture-releases.md) | `fixtures-pack-version` and `fixtures-pack-protocol` are validated (an unpinned tag such as `latest` is rejected) and the Action logs a note when they are set, but they are not forwarded: `stellar-canary check` has no fixture-pack flag. The Action does not download a pack, check an archive checksum or hand a pack to the CLI. To pin a pack, check out its tag into `fixtures-dir`. | Partial: input validation and logging only; download and verification deferred |
| [CF-07 Project roots](https://github.com/StellarCanary/Protocol-Canary/blob/main/docs/contracts/cf-07-project-roots-and-detection.md) | Maps a `working-directory` input to the CLI's `--project-root`. | Implemented |
| [CF-08 Viewer and Action](https://github.com/StellarCanary/Protocol-Canary/blob/main/docs/contracts/cf-08-viewer-and-action.md) | Defines the inputs, outputs, failure mapping, diagnostics redaction and summary limits. Current inputs and outputs are listed below. | Partly implemented; compare the contract with `action.yml` for what remains |

## Facts about this repository that the contracts rely on

Checked against `main` at `f5b9072` on 2026-11-20. `action.yml` is the
authority for the full list and defaults; this is a summary.

- Inputs: `protocol`, `config`, `working-directory`, `network`,
  `network-passphrase`, `rpc-max-retries`, `rpc-retry-delay-ms`, `rpc-url`,
  `fixtures-dir`, `fixture`, `surface`, `cache-dir`, `version`, `upload-report`,
  `report-retention-days`, `annotations`, `diagnostics`, `timeout-minutes`,
  `allow-empty`, `rpc-timeout-seconds`, `max-concurrency`, `no-cache`,
  `live-cache-ttl-seconds`, `fail-on-warning`, `offline`,
  `fixtures-pack-version`, `fixtures-pack-protocol`, `baseline-report`,
  `github-token`, `strict-integrity`, `pr-comment`, `junit-report`,
  `engine-env-passthrough` and `generate-receipt`.
- Outputs: `status`, `passed`, `warnings`, `failures`, `errors`, `total`,
  `skipped`, `replayed-count`, `engine-version`, `observed-protocol`,
  `pack-protocol`, `pack-version`, `pack-digest`, `report`, `coverage-state`,
  `receipt-path`, `junit-report-path`, `artifact-name` and `artifact-id`.
- `fixtures-pack-version`, `fixtures-pack-protocol` and `baseline-report` are
  the inputs whose contract work is incomplete (see CF-05 and CF-06 above).
- Engine installation: see [download-policy.md](download-policy.md) and
  [integrity-model.md](integrity-model.md). A downloaded release binary needs an
  exact platform asset checksum; `strict-integrity: true` also rejects source
  builds, including cached ones. A checksum proves integrity, not the release
  author's identity, and release signing is deferred.
- When the engine cannot run or the report cannot be parsed, no report artifact
  is uploaded, and `status` is `execution-failed`.
