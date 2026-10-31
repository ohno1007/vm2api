# vm2api v1.4.030 custom branch

This branch merges upstream `8749e65c1` (v1.4.030), including the nested OAuth
runtime-health fix, while preserving the existing account-pool workflow.

## Preserved behavior

- Importing email/password or email/password/2FA credentials only saves them.
  Binding credentials to a slot does not start login. Explicit login uses that
  slot's browser environment and proxy.
- Microsoft mailbox login, browser control, ChatGPT Session export, and verified
  website subscription status and renewal controls remain available.
- Operator-disabled slots skip quota probes, credential refresh, browser tasks,
  model tests, watchdog recovery, and restart-policy migration.
- Existing custom configuration and user prompt files stay in the deployment's
  independent configuration mount and are not replaced by this source upgrade.

## Compatibility fixes

- Keep API classifier assembly aligned with upstream; remove the obsolete extra
  billing prompt injection that violated the classifier body contract.
- Import the JWT decoder used for Codex token expiration, preventing account
  summary and credential eligibility failures.
- Support file ownership handling on Windows without `process.getgid()`.
- Keep Session export and renewal actions in the slot menu, and retain visible
  subscription expiry in the rack view.

## Validation

Linux containers using the v1.4.030 payload passed 189 focused backend tests,
including credential import/binding, mailbox login, subscription verification,
Session export, classifier/API forwarding, and disabled-slot maintenance.
The restart-policy tests also passed after adding a disabled-slot case.
All 72 frontend suites / 536 tests passed, followed by TypeScript and Vite build.
Both worker and API kernel passed `go test -race ./...`.

The complete backend run scanned 324 isolated test files. Fifteen initially
failed due to old custom protocol/ACL assertions, obsolete ownership helpers,
root-user assumptions, or missing runtime binaries and Docker fixture responses.
After aligning those fixtures with the current upstream behavior and installing
the pinned helpers in the isolated test container, all 215 tests in those fifteen
files passed on rerun. A separate isolated image startup returned HTTP 200 at
`/health` before production replacement.

Production upgrade evidence and rollback files are stored outside the repository
under `/opt/vm2api-upgrade-1430-20261101`. The deployment replaces the control
container and synchronizes selected enabled slots; it preserves runtime
configuration, database contents, credentials, VM disks, and existing slot and
Sub2API containers. Do not replace this build with the unmodified upstream image.

## Production result (2026-11-01)

The deployed image is `local/vm2api:1.4.030-custom`, image ID
`sha256:f6fbe775784cc57508775bd4c75e6ce895fdd9e2d16b0259ed575ba79a4402c9`.
The authenticated version endpoint reports `1.4.030`; the control container is
healthy. The credential-pool and slot login-status endpoints respond normally.
An explicit test on enabled `vm-01` with its configured `gpt-6-sol` model returned
HTTP 200, `ok: true`, and `OK` through the production inference path.

Both public hostnames responded with HTTP 200 to browser-style requests.
Runtime configuration checksums and slot scheduling states matched the backup;
disabled-slot credential files were unchanged. Existing slot and Sub2API
container IDs and start times matched their pre-upgrade values. No production
login, Session export, or subscription modification was initiated by validation.
