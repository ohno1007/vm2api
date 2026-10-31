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

Production upgrade evidence and rollback files are stored outside the repository
under `/opt/vm2api-upgrade-1430-20261101`. The deployment replaces the control
container and synchronizes selected enabled slots; it preserves runtime
configuration, database contents, credentials, VM disks, and existing slot and
Sub2API containers. Do not replace this build with the unmodified upstream image.
