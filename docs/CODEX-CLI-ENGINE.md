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

Production uses `vm-02`; duplicate test slot `vm-90` is disabled and stopped with data retained.
Do not enable both copies of the same refresh-token grant.
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
function/custom/namespace tools including parallel calls, tool results, structured
output and disconnect cancellation. Caller shell/filesystem tools execute locally
in the client; gateway-owned shell/filesystem tools are not exposed.

History is caller-key scoped and in memory: 15-minute TTL, 256 entries, 32 MB.
`store:false` disables retention; restart loses `previous_response_id` history.
Unsupported controls explicitly return 400: max_output_tokens, max_tokens,
max_completion_tokens, temperature, top_p, logprobs, top_logprobs, seed, stop,
n other than 1. Legacy host-side search/image helpers
are unsupported. Manual quota reads and explicit reset-credit redemption use the guest CLI.

Quota reads preserve 5h/7d reset timestamps, credit counts/expiration, plan and paid-credit balance.
Reset-credit redemption uses `account/rateLimitResetCredit/consume` with an idempotency UUID,
checks the actual outcome and reads quota back. Queries never redeem credits. Subscription
expiry continues to come from OAuth identity claims; missing claims remain unknown and
access-token expiry is never substituted. CLI credential mirroring retains subscription
metadata when a refresh omits it and updates it when a new ID token supplies it.

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
SQLite with an older snapshot unless data loss is intended. Keep vm-90 disabled.
Custom prompt/config files were not read or replaced by this work.

## Responses tools and tier routing (2026-11-01)

Requests containing tools use our guest-side native Responses transport, with credentials
owned/refreshed by the official CLI. Plain text uses the CLI app-server. The native worker
has a fixed upstream URL, reads credentials only inside the VM, uses the same enforced
proxy network, and exits when its gateway pipe closes. No local client command runs in
the server guest. Import/binding do not launch anything. Disabling scheduling stops both
the CLI and active native transports.

Function/custom/namespace declarations, exact grammar definitions, tool choice, serial
tool settings, tool results, citations, hosted output, and SSE events are preserved.
Native model constraints enforce custom grammar; the app-server fallback adapter only
describes the grammar and is not equivalent to constrained decoding. Namespace declarations
and calls retain their namespace; use `auto`/`required` for namespace tools. The upstream
rejects the nonstandard `tool_choice.namespace` field rather than treating it as a forced
namespace selector. Missing namespace descriptions default to empty text.

Public live checks passed custom tool call/result continuation, namespace calls, web
search with citations and image generation with returned image data. `file_search` and
`code_interpreter` are rejected by this Codex subscription endpoint; the gateway returns
the real upstream error. Per operator instruction, local files, shell, and code tools
are executed by the calling client, with only nonlocal operations delegated upstream.
No vector store or remote code sandbox has been provisioned.

Fast maps to `priority`; Ultrafast remains `ultrafast`. Cold capability catalogs are
read from eligible active CLI slots before inference admission; disabled/off-shift slots
are skipped. Account-scoped routing hints expire after 15 minutes and each inference
revalidates the live 60-second CLI catalog. Known unsupported accounts are excluded before
sticky/concurrency selection; missing tier access never downgrades locally. If no account
supports the requested tier, admission returns `service_tier_unavailable`.

The native upstream receipt is retained as `service_tier`, with requested tier and mismatch
in response metadata. A live Fast request sent `priority` but received `default`: passing
the tier does not prove priority was delivered. Native usage comes directly from terminal
upstream counters, including cached input, tool usage and any injected prompt. Sparse
terminal events are supplemented with completed streamed items for JSON/history clients.

181 focused Linux tests passed, including protocol, quota, browser, routing and KVM
regressions. The pinned real CLI offline suite passed parallel tools, custom/namespace
continuation and priority/ultrafast wire tiers. Real reset-credit redemption and paid
subscription mutations were intentionally not performed.

All 11 production slots (`vm-01` through `vm-09`, `pro200`, `openai-01`) migrated to
our KVM runner and CLI-managed engine. Every migration passed existing-account login,
quota read, browser launch and proxy/persona preservation checks. The guest installer
now gates legacy service startup by engine, and systemd conditions prevent restarting
the old kernel after setup. Old containers are stopped with restart disabled and data
retained under `/opt/vm2api-fleet-backup-20261101-cli/<slot>`.

Current gateway image: `local/vm2api:1.4.030-codex-cli-20261101-tools3`.
Runner image: `local/vm2api-codex-kvm:1` (legacy startup fix included).
All 11 live catalogs returned `priority`; none advertised `ultrafast` at verification.
Ultrafast routing was verified with synthetic account catalogs and genuine CLI offline
wire tests; live Ultrafast generation remains unverified without an entitled account.

## References

- https://developers.openai.com/codex/app-server
- https://developers.openai.com/codex/speed
- https://developers.openai.com/api/docs/pricing
- https://developers.openai.com/codex/pricing
- Experimental schema generated from installed CLI 0.166.0.
# System 提示词接入

CLI 引擎沿用 `/system` 的 `routing.compatibility` 模板、分块开关、常驻约束、环境与覆盖层设置，槽位 `persona_preset` 优先于全局方案。CLI 卡片显示当前方案并提供“恢复跟随全局”。配置在下一次请求创建线程时生效，无需重启 CLI。

模板通过 `thread/start.baseInstructions` 进入官方 CLI。自定义正文不作身份替换；内置身份、agent、guidance、环境占位符使用精简的 Codex 适配值，不复制 Claude Code 的长提示词、工具说明或计费归因头。环境变量取当前槽位的时区、locale 和实际 guest 工作目录，遵守对应开关。沿用旧界面的方案名称不代表加载了完整的官方 Codex 提示词。

Responses `instructions` 保留为 developer instructions；输入中的 system 消息仅在模板使用 `{{caller_system}}` 时被消费一次。其余 system 消息保留文本和位置，映射为 CLI 的 developer 角色，避免 CLI 静默丢弃 system 历史；其他角色、图片和工具调用保持结构。未设置自定义块的“0注入”不添加网关 system 指令，调用方指令仍保留。CLI 自身的协议上下文不受这个开关控制。

多轮历史只保存原始调用方输入和模型输出，每次续接按当前配置重新渲染，避免旧提示词累积。`hide` 等旧计费隐藏开关不影响 CLI 真实用量；注入提示词所用 token 包含在 input 和总量中。运行日志和验证脚本不输出用户保存的提示词。
