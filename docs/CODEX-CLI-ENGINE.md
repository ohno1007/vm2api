# Official Codex CLI slot engine

Implemented and deployed on 2026-11-01 (Asia/Shanghai), on custom vm2api v1.4.030.
Branch: `feat/codex-cli-slot-engine-20261101`.

## Runtime

Official Codex CLI **0.166.0** app-server runs inside an Ubuntu 24.04 KVM guest.
One long-lived process per enabled slot serves separate threads per request.
Default concurrency is two (API range 1–16); model discovery is cached for 60 seconds.
Locks and process-group cleanup prevent duplicate/orphaned processes. Cold startup
waits for guest SSH readiness.

New CLI slots receive source-generated persistent UUIDs, machine IDs, MAC addresses,
hostnames and disk serials. SMBIOS truthfully describes QEMU. Existing identities
are preserved. This engine does not invoke kin-computer or the old Codex kernel;
unused guest Claude kernel services are disabled.

The full cloud-image Dockerfile and `docker/kin-kvm/Dockerfile.cached` are available.
Deployment reused the installed Ubuntu cloud disk to avoid another 600 MB download;
all lifecycle/setup/execution scripts were replaced with repository versions. The
whole runner image was not rebuilt from an independently verified base.

Import and binding remain passive. Explicit preparation installs the pinned binary
and seeds managed CLI credentials from a bound OAuth account when available.
Explicit login reuses that account or starts official device-code authorization.
The CLI owns token refresh; the gateway mirrors credentials locally. Existing
mailbox/password/2FA, session export and subscription features remain available.
Manually disabled slots reject preparation/login/probes and are skipped by background
refresh, quota probes and kernel watchdogs. First-login setup is separately allowed
for a slot parked only for missing credentials; inference remains blocked until
login succeeds. Turning scheduling off stops any active device-login process.
Guest boot does not start an unprepared CLI, and cold startup waits for both SSH
and the shared-home permissions to become ready.

## Network and overhead

A bound non-local proxy and exit-geography-derived timezone are required. Guest
TCP/DNS use that proxy. A slot-specific firewall allows only proxy/DNS ports,
blocks direct forwarding and other host ports, and disables IPv6. Private VM
management is separate from public outbound traffic.

Deployed slot `vm-90` uses the authorized vm-02 test account. Original vm-02 remains
`schedulable:false`; do not enable both copies of the same refresh-token grant.
The guest has one vCPU, 1 GB RAM, a sparse disk overlay and a hard-linked shared CLI
binary where possible. Its observed exit is the bound US proxy and its timezone is
America/Los_Angeles. Production measurement: guest 330 MB used / 624 MB available;
CLI RSS 154,660 KiB (about 151 MiB).

Disabling unused CLI tools/discovery/context reduced a tiny request from 9,231 to
roughly 4,700 input tokens, then 4,275 after explicitly disabling the CLI interaction
tool in the r2 deployment. These are individual observations, not a representative
benchmark. Three warm candidate Fast requests took 4.37, 3.94 and 3.87 seconds;
production Fast smoke generation took 6.28 seconds. This does not establish a
guaranteed speedup or meaningful long-output TPS.

## API and accounting

Supported: Responses and Chat Completions, JSON/SSE, structured history, caller-side
function tools including parallel calls, tool results, structured output and
disconnect cancellation. Local shell/filesystem tools are disabled.

History is caller-key scoped and in memory: 15-minute TTL, 256 entries, 32 MB.
`store:false` disables retention; restart loses `previous_response_id` history.
Unsupported controls explicitly return 400: max_output_tokens, max_tokens,
max_completion_tokens, temperature, top_p, logprobs, top_logprobs, seed, stop,
n other than 1, and parallel_tool_calls:false. Legacy host-side search/image helpers
and credit reset are unsupported. Manual quota reads use the guest CLI.

Tiers: Standard (default/standard), Fast (priority/fast), Ultrafast (ultrafast).
Flex is a distinct catalog tier, not an Ultrafast alias.
Eligibility comes from the CLI catalog; there is no silent downgrade. Standard
and Fast succeeded. The test account has no Ultrafast and correctly receives
400 service_tier_unavailable. The genuine CLI passed priority/ultrafast wire-tier
tests with an offline provider catalog in a network-isolated container; this
verifies engine support, not that the live test account has Ultrafast access.
The CLI exposes configured tier but no upstream billed-tier receipt, so response
service_tier remains null and metadata identifies the requested configuration.

Usage is cumulative thread/tokenUsage/updated counters minus pre-turn baseline.
Repeated snapshots are not added again; invalid/regressing counters are rejected.
Cache is within input, reasoning within output; neither is double-counted. Missing
usage stays null; failed/cancelled turns retain reported usage when available.
The existing DB stores uncached input separately; API/average-input metrics restore
inclusive input.

Average tokens = sum of known measurements / measured request count. Unknown usage
is excluded, not zero. CLI generation TPS = total measured output (including
reasoning) / total generation time, not the mean of individual request speeds.
Window throughput is separate.

USD costs are **official API list-price equivalent estimates**, using configured
tier when actual billed tier is unavailable. They are not subscription invoices
or verified debits. Tier affects price, not token count. Subscription allowance
and purchased-credit multipliers are not interchangeable.

## Setup

1. Build `local/vm2api-codex-kvm:1` from Dockerfile.cached, or use the full runner
   Dockerfile with its required cloud-image inputs.
2. Run `node scripts/fetch-codex-cli.mjs` from the project root. Pinned archive and
   executable SHA-256 hashes are verified. Do not commit the binary.
3. Create a local OpenAI Ubuntu 24.04 KVM slot with the official CLI checkbox;
   bind its proxy and credentials. Compatible existing slots can enable the engine
   through the credential panel, then restart their VM to adopt the CLI runner.
   A legacy runner cannot start this engine until that restart.
4. Prepare CLI, start the guest, then click CLI login. Server helper:
   `KIN_PROJECT_ROOT=/opt/vm2api node scripts/codex-cli-prepare.mjs <vm-id>`.
5. Send a supported request, optionally `service_tier:priority`. Query the model
   catalog before selecting Ultrafast.

Executable: 319,346,888 bytes; archive: 121,764,138 bytes.

- Binary SHA-256: `b8a11fedf24b2dfb59a70c9e52b030f9a508dcd49cd2dd0d41956f4c785156b8`
- Archive SHA-256: `a0bf572d2f93f056c6712a6da348e96078dc84f3885fd7be67807ef389cb3978`

## Validation and deployment

- 177 relevant Linux tests initially passed. The first-login follow-up passed
  164 relevant Linux tests, followed by 64 lifecycle/KVM/reload regression tests
  after the final startup guards. Frontend TypeScript and Vite builds passed.
- Genuine CLI offline fixture passed initialization, history, text/usage, caller
  tools, tool results and parallel calls in a network-isolated container.
- Real Standard/Fast/quota tests passed. Pausing the isolated test proxy blocked
  HTTPS and direct IPv4; the proxy was restored. Timezone and IPv6 were verified.
- Public production tests passed status, Responses JSON, previous_response_id,
  Chat JSON, Fast SSE and Ultrafast rejection.
- Two empty candidate KVM guests exercised create, proxy-derived timezone,
  explicit preparation and real official device-code issuance. The second guest
  passed on the first cold login after the shared-home readiness fix. Manual
  scheduling-off stopped the CLI and subsequent login returned 409 slot_resting.
- Public aggregates independently matched SQLite samples, inclusive averages and
  weighted speed. One success: input 4,700 (cached 4,480), output 5, total 4,705.
  Rejected Ultrafast input/output usage remained null.
- Gateway `local/vm2api:1.4.030-codex-cli-20261101-r2` healthy; guest
  `local/vm2api-codex-kvm:1` running. Host bind remains 172.18.0.1:8787;
  public host is ai.ai.qsafehub.com.
- bear3/PostgreSQL/Redis stayed healthy without deployment restarts. Server requests
  to ai.qsafehub.com returned Cloudflare 403, so that public path was not verified.
- Isolated test containers and unused test proxy process/network were removed.

The r2 public smoke suite passed again, including existing-account login, Standard,
Fast, history, JSON/SSE and absent-Ultrafast rejection. Its public averages matched
all seven measured database requests in the verification window; generation TPS
matched all four CLI samples, and the unknown-usage rejection was excluded.
The two temporary guest disks and runtimes were removed after validation.
Immediate r2 rollback backup: `/opt/vm2api-codex-r2-backup-20261031-193933`;
its compose/source restore returns to `local/vm2api:1.4.030-codex-cli-20261101`.

Backup: `/opt/vm2api-codex-backup-20261031-191357` (UTC timestamp), with old source,
frontend, compose override and online SQLite backup. Rollback: disable/stop vm-90,
restore backed-up src/lib, src/server.mjs, web/dist, scripts and compose override,
then recreate only vm2api with `local/vm2api:1.4.030-custom`. Do not replace current
SQLite with an older snapshot unless data loss is intended. Keep vm-02 disabled.
Custom prompt/config files were not read or replaced by this work.

## References

- https://developers.openai.com/codex/app-server
- https://developers.openai.com/codex/speed
- https://developers.openai.com/api/docs/pricing
- https://developers.openai.com/codex/pricing
- Experimental schema generated from installed CLI 0.166.0.
