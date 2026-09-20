# Codex App external controller — issue #57 implementation plan

Approved scope: new local macOS workspaces may select a Codex App conversation as the sole running controller. Hive retains member PTYs, dispatch ledger, report storage and UI. Members keep `team report`; Runtime queues fixed notifications to Codex. Internal mode remains supported. No live-team migration, cross-machine support, second controller model, or claimed wakeup after App exit.

## Gate evidence

Local codex-cli 0.153.4: a normal process with only HOME/PATH/TMPDIR invoked `codex queue`; an idle App thread produced a new turn with the expected nonce. A temporary ordinary stdio MCP subsequently received `params._meta.threadId` and `x-codex-turn-metadata.thread_id` matching that App thread, with empty tool arguments and no CODEX_THREAD_ID environment variable. The same process handled multiple calls: identity must be read per call, not inferred from process lifetime. The temporary global MCP registration was removed after the probe.

Thread identity is routing within the same-user local trust boundary, not a secret or isolation from malicious same-user processes. Desktop confirmation selects the binding. Calls without host metadata fail closed. A second thread and stale bindings must be rejected by the Runtime.

## Sequence and ownership

1. Primary: MCP metadata extraction, direct controller tool surface, private spec update, integration and validation.
2. Runtime worker: server/shared workspace mode, binding requests and desktop confirmation, scoped action checks, idempotent mutations, report notification/ack state, lifecycle guards and migrations. Keep runtime-store.ts <= 200 lines.
3. UI worker: external mode create flow, controller connection pane, member-centric layout and localization. No fake online status or controller PTY.
4. Integrate: true HTTP/SQLite/PTY flow in isolated data directory, App-to-MCP binding and readback; existing relevant and migration/full regression suites per repository rules, biome/build/pack as applicable.
5. Four independent reviews: architecture, bugs/concurrency, test quality, spec alignment. Resolve each severe finding, repeat dimensions rated C+ or lower.
6. Commit isolated branch and open reviewable private PR; do not merge or release without user authorization.

## Contracts

Create accepts `controller_mode: internal | codex_app`, defaults internal. UI GET `/api/workspaces/:id/controller`; POST `.../confirm` with request_id; POST `.../disconnect` when no open tasks or unreceived reports. API checks remain authoritative.

MCP connect posts `/api/controller/request` with workspace_id. Action posts `/api/controller/action`; metadata-derived x-hive-controller-thread-id plus local Supervisor auth identifies caller. Explicit desktop confirmation is required before mutations.

Actions: inspect, send(worker_name,text), spawn(role,cli,name?), start/stop(worker_name), cancel(dispatch_id,reason), read_reports, ack_reports(report_ids). Resource/task mutations require stable operation_id; same key/same payload replays stored result; same key/different payload rejects; ambiguous in-progress actions are never blindly repeated.

Reported, notification queued, and received are distinct; receiving does not mean accepting the work. Only actionable events wake the model. Ordinary progress stays readable. Notification failure never rolls back completed work. Persist pending state, tolerate duplicate wakeups, never interpret queue acceptance as model completion.

## Validation policy

Do not add or edit tests during the repository temporary mode. Use existing tests and temporary assertion-based integration harnesses with real HTTP, SQLite and PTY. Schema/core changes require full existing suite per AGENTS §0.1. Do not alter product semantics to satisfy stale tests; record any conflicting existing expectation. Browser/real-device checks are distinct from build and test success.
