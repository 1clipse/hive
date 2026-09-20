# Issue #57 validation receipt

Validated on macOS arm64, Codex CLI 0.153.4, 2026-09-05. This is local implementation evidence, not release or user acceptance. Work used an isolated checkout and data directories.

## Product path

- Ordinary stdio MCP received the actual App thread identity in per-call host metadata, with no thread argument or process environment identity. Missing/conflicting identity and a different bound caller were rejected.
- Created an external workspace; the App requested binding through MCP and the isolated Hive UI API confirmed it. No internal orchestrator PTY was started.
- App started and dispatched to a deterministic real PTY protocol fixture. Its real `team report` persisted the result; Runtime `codex queue` generated a new App turn, which read and acknowledged it. Dispatch: `62f693e1-8d10-40ca-b5be-81b2c583a640`.
- Repeated with an actual Codex CLI model member created by the App. Dispatch `18e2bff1-cd66-4163-a2fb-61c66140a6a3` returned `HIVE57_REAL_MODEL_OK`; a Runtime-triggered App turn returned `HIVE57_MODEL_LOOP_ACK`. Both outbox records were `accepted` and acknowledged. Native task messaging initialized the checks; it did not relay member results or trigger the result turns.
- After restarting the final Runtime build, the original binding remained usable and dispatch `f88494cf-f24d-4e93-8635-86ec02065b86` produced a fresh `HIVE57_FINAL_RESTART_ACK` App turn.
- Browser walkthrough covered external creation, hidden internal engine fields, connection pane, member controls, and 390×844 responsive controller/member tabs. This was browser emulation, not physical-phone acceptance.

## Reliability checks

Temporary assertion harnesses outside the repository used real HTTP, SQLite, PTY and `team report`. They cover same-operation replay without extra dispatch, changed-payload rejection, wrong caller, unread-report binding guard, notification failure with results retained, member exit as an independent attention event while the dispatch stays open, explicit cancellation, ack and disconnect.

Two normal restarts preserved binding, unread results, operation receipts and acknowledgement without duplicate work. A separate SIGKILL check killed a runtime while notification state was `sending`: a deliberately hanging CLI fixture represented the transport, and a directly inserted pending operation represented a crash after reservation. Recovery retained results and binding, changed ambiguous states to `unknown`, refused blind operation replay and did not resend the ambiguous notification. This failure injection is not evidence of every possible real Codex timeout outcome.

## Initial baseline commands and regression results

- `pnpm check`, `pnpm build`, `pnpm pack:check`: passed.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm pack:smoke`: passed with Node 24 / npm 11.16.0.
- Existing package-tarball suite: 2/2 passed with npm 11 on PATH. npm 12 returns a different pack JSON shape and breaks the existing smoke/test parser; packaging scripts are unchanged here (separate issue #56).
- Full existing `pnpm test`: 359 files passed, 10 failed, 1 skipped; 2500 tests passed, 30 failed, 3 skipped. This initial run is not reported as green. Failures were followed up against the final changes below.
- Existing legacy Supervisor/MCP external-goal bridge: 6/6 passed.
- Existing team atomicity/replay and workspace persistence/legacy hydration: 35/35 passed after fixing internal payload compatibility and keeping host routing in Runtime.
- Existing workspace picker: 21/21 passed after retaining the internal-mode callback payload. Marketplace: 4/4 passed on focused rerun (full-run timeout did not recur).
- CLI plus foreign-schema suites: 36 passed; the one default-port test was blocked by an existing listener on 9483. The user runtime was not terminated.
- Existing schema suite: 28 passed; one assertion still hardcodes schema version 40, while this feature correctly migrates to 41.
- Remaining old UI expectations: welcome copy still expects “choose an orchestrator”; task drawer expects 640px while unchanged baseline implementation uses 700px.

The initial delivery followed the temporary no-test-change rule. The user subsequently authorized a task-specific exception to update stale expectations and add real controller regression coverage; the follow-up below supersedes that initial restriction for this task.

## Self-Review

Four independent reviewers checked architecture, bugs/concurrency, validation quality and spec alignment. Earlier blockers were fixed: durable process-exit notification, bounded notification scanning, schema version consistency, pending binding cancellation, inspect progress and snake_case fields, and internal workspace compatibility. Final grades: architecture B+, bugs B+, validation B, spec A-. The validation reviewer caught a harness blind spot: checking no resend after reading reports could be masked by read_at. The harness was corrected to assert no resend while read_at was still null, and passed again.

The remaining duplicated MCP/HTTP action field tables are accepted as separate input-validation boundaries; no generic framework was introduced. No merge, release, existing-team migration, App-exit wakeup or other-client support is claimed.

## Authorized completion follow-up

- Browser fault injection held a pre-confirmation GET response, confirmed the binding through the real UI, then released the old response; the displayed binding remained current.
- Unified the wire status in `src/shared/types.ts`, preserving the old type exports. UI mutations consume their returned state instead of issuing an extra GET. Polls begun before a mutation settled cannot overwrite the newer result.
- Updated the schema-41 assertion and actual welcome/drawer expectations. No product semantics were changed to satisfy old assertions.
- Reproduced the two workflow DAG CI timeouts on the unchanged base using two CPUs: the tests waited for three simultaneous tasks with only two default slots. The test now explicitly supplies CPU capacity for three slots; real HTTP/SQLite/PTY and existing assertions remain intact. Base low-CPU: 3/5; corrected low-CPU: 5/5.
- Added `controller-integration.test.ts`: real stdio metadata rejection and connection, explicit UI confirmation, wrong caller, real member report, simultaneous idempotent requests, restart persistence, duplicate ack, exit, cancellation and authenticated late report rejection.
- Added `controller-notification-close.test.ts`: real report, controlled external notification process, in-flight close waiting, accepted receipt persisted before DB close, and restart without resending an unread accepted report. Fixtures do not contact a user's App and do not mock HTTP, SQLite or PTY.
- Focused final regression command covering the two controller suites, schema, DAG HTTP, legacy MCP, welcome and task drawer: 7 files / 63 tests passed. `pnpm check` and `pnpm build` passed after the simplification. New full CI is required on the pushed final head before completion.
- Independent follow-up review: architecture B+, bugs B+, validation B+, spec A-. Fixed the identified stale-poll race and order-dependent concurrent test assumption. No outstanding confirmed severe finding.

Source-only follow-up rollback is a revert of the follow-up commit; it does not change the schema or stored data. Retained protections and notification/ack distinctions are unchanged. No merge or release is authorized by this validation receipt.

## UI and onboarding completion

- Creation offers native radio choices with descriptions; external mode hides internal engine controls. The controller pane shows setup, pending approval, connected/no-members, connected/team, and report recovery as separate states. Setup and connection requests can be copied; adding the first member opens the existing member dialog.
- Setup commands use the HTTP listener port supplied by the Runtime, not the browser/proxy port. Real HTTP assertions cover GET and confirm responses. Remote tunnel viewers receive a return-to-Mac instruction and cannot click local-only binding mutations. Remote access was code-reviewed, not newly verified on a physical phone in this pass.
- Confirmation moves keyboard focus to the stable controller heading and announces the bound state. Browser accessibility output confirmed the actual focus target. Native radio selection and hiding of internal CLI controls were exercised with browser actions; screen-reader speech and keyboard arrow keys were not separately tested.
- One batched desktop/mobile walkthrough and one confirmation round checked the real isolated server. At 390×844, discovered and fixed the workspace sheet's clipped footer and overlap with mobile navigation: the body scrolls, footer remains visible, and modal layers cover navigation. This remains browser emulation, not physical-phone or user visual acceptance.
- Legacy one-click scenario cards depend on an internal orchestrator terminal and are omitted from external teams. External users add members directly and ask the App to plan/dispatch. No second controller or unsupported scenario dispatch path is advertised.
- Removed obsolete controller onboarding translation keys. Updated the shared add-member description to describe assignment without naming an internal-only command.
- `pnpm check`, `pnpm build`: passed. Controller integration, notification close and workspace picker: 3 files / 23 tests passed. Impeccable detector reported no findings on the initial UX targets. No new UI tests were added.
- CI on `9324459`: Linux passed; macOS had one unrelated existing remote handshake race. The unchanged base reproduced `seal` before connection keys were armed. Updated the shared test boot to wait for the real `armed()` condition, without fixed sleeps or product fallbacks; all 14 remote-tunnel-bridge tests passed. Final-head CI must still finish before claiming completion.
- Independent UX follow-up: architecture B+, bugs B+, validation B+, spec A-. Fixed all identified P2 items (proxy port, remote binding controls, post-confirmation focus). No outstanding confirmed severe finding; actual hardware acceptance remains outside the local evidence.

### Windows compatibility probe cleanup

The superseded Windows job was cancelled to retrieve its complete log: SQLite and PTY both reported `ok`, both optional CLIs were absent, and the JSON report was written, but the process remained alive for 22 minutes. This is a completed probe with retained native resources, not a controller-test failure. The installed node-pty Windows implementation releases its ConPTY worker in `kill()`, while natural process exit only closes the output socket. The one-shot compatibility probe now releases that terminal on Windows after natural exit, unless the timeout path already killed it. Unix exit behavior and the original output/exit-code success criteria are unchanged. Local native probe with a clean PATH and Biome passed; Windows CI must demonstrate clean process termination. No forced process exit or skipped gate was introduced.

Windows CI on `b2c886b` proved the compatibility probe now terminates successfully and reaches build/tests. The dependency's console-list cleanup helper emits `AttachConsole failed` for the already-exited probe and adds about five seconds before exit; independent bug review classified this as accepted P3 diagnostic noise. It does not change the native result, and we did not access private node-pty fields or add a process-exit workaround.

The Windows test stage then passed 477/480 tests. Its three failures were unchanged baseline CLI display expectations omitting required quotes around Windows paths. Only those expected displayed commands were corrected; product update code, exit-code/argument assertions and real spawn tests were retained. Local full CLI file: 33 passed, one default-port test blocked by the user's existing 9483 listener (left untouched). Biome passed; the Windows expectation change still requires the next CI run.
