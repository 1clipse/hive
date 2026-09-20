# Design Decisions

This document records the non-obvious design choices in Hive — the ones people
reasonably question on first contact. Each entry states the decision, the
reasoning, and the trade-off we accepted. The goal is that you can disagree with
a choice, but you should not be surprised by it.

---

## Remote access: an optional cloud gateway, and the boundary that comes with it

Hive started as a strictly local tool: the runtime binds `127.0.0.1`, and nothing
leaves your machine. Remote access reverses that non-goal — but only as far as it
has to, and only when you turn it on.

The reversal is deliberately narrow. The optional cloud gateway does **identity
and routing only**: it authenticates you (GitHub / Google login) and relays
encrypted bytes between your paired phone and your daemon. It never holds your
data and never runs your agents — execution and project files stay on your
machine, exactly as before. The gateway is an opaque relay: it sees ciphertext
and routing headers, not your terminal contents or API payloads.

The boundary that makes this safe to ship: **local Hive works unchanged if the
gateway is down.** Remote access is a Settings switch, default off. With it off
there are zero outbound connections, zero listeners, and zero behavior change —
the gateway is simply not in the picture. The daemon's gateway URL is also
configurable, so you can self-host your own gateway and never touch ours.

---

## Authority model: a paired phone is an equal-authority device

> Paired remote device has the same authority as the local Hive web UI. Hive does
> not maintain mobile-specific feature permissions. Security is enforced at the
> device/session level, not the action-subset level.

A successfully paired phone has the same authority as your local browser. We do
**not** maintain a mobile-specific permission set, because any permission subset
that still lets you "send text to a YOLO agent" is already full authority
(RCE-class) — trimming buttons would be security theater: more friction, no more
safety.

Security lives entirely at the **device/session level**: OAuth login, first-time
pairing-code entry, desktop confirmation, device revocation, remote-session auditing,
and the off-by-default Remote switch. After pairing, there is no per-button
re-authorization.

There is one **trust-root exception** — it is a pairing-ceremony design, not a
permission trim, and must not later be "fixed" as an inconsistency:

- Approving a **new** device can only be done at the desktop. A paired phone
  cannot mint another device on its own.
- The Remote switch can be turned **off** remotely (self-disconnect, with a
  confirmation prompt) but can only be turned **on** at the desktop — off means
  no tunnel exists, so remote-enable is physically impossible anyway.

---

## No per-worktree isolation

Each workspace has one working tree, shared by every agent assigned to it. We
do **not** create a git worktree per agent. The obvious objection is that
concurrent agents can step on each other's files — and they can. We accept that
because avoiding it the worktree way trades one problem for a worse one: N
divergent trees that someone (you or the orchestrator) has to reconcile, plus the
disk and setup cost of cloning state per agent.

Hive's answer is that conflict avoidance is the orchestrator's job, not the
filesystem's. The orchestrator owns the task graph and is responsible for
splitting work so workers don't collide — the same way a human tech lead assigns
non-overlapping tickets. This keeps the mental model simple: one workspace, one
directory, what you see on disk is what every agent sees. If you want hard
isolation, run separate workspaces.

**One narrow exception (2026-09, #76):** a workflow script may pass
`agent(prompt, { isolation: 'worktree' })`. That single ephemeral member runs in
a git worktree under the OS tmpdir on branch `hive/wf-*`, and its report ends
with a `<hive-worktree branch=... kept=.../>` line so the *script* — not a
human — merges the branch. It exists because parallel workflow members are the
one place where "the orchestrator splits the work" cannot prevent collisions:
the script decides the fan-out before any member has looked at the files. The
default stays shared; `team spawn` and persistent members never get worktrees.

---

## No heartbeat / stall detection

Agents have exactly three states — `working`, `idle`, `stopped` — and the state
machine is driven only by protocol events: `team send` moves a worker to
`working`; `team report` (or `cancel`) moves it back to `idle`; a PTY exit makes
it `stopped`. There is no timeout, no liveness ping, no "is it stuck?" heuristic.

This looks like a missing feature until you try to build it. Guessing completion
from process activity or output silence is unreliable for CLI agents — a long
think, a slow build, and a genuinely stuck agent all look identical from the
outside. Any heuristic we picked would either nag on healthy long tasks or
falsely reassure on dead ones. So a stuck agent simply keeps showing `working`,
and **you** decide it's stuck and hit Stop or Restart. The contract is explicit:
a worker is done only when it calls `team report`. We would rather show you the
honest raw state than a confident wrong guess.

---

## `team` is PATH-injected, not globally installed

The internal `team` command (`team send` / `report` / `list` / `cancel`) ships
inside the Hive package and is made available to agents by **prepending the
package's bin directory to the PATH** of each managed PTY — not by installing a
global `team` binary.

The reason is blast radius and honesty about scope. A global install would put a
`team` command on your whole system, risk colliding with anything else named
`team`, need cleanup on uninstall, and imply Hive is a system-level tool. PATH
injection keeps `team` visible **only** inside agent sessions Hive manages — your
normal shell never sees it, nothing global changes, and uninstalling the package
removes it completely. It also makes the protocol's scope literal: `team` is a
coordination channel for Hive-managed agents, not a general-purpose CLI you're
expected to run yourself.

---

## A runtime restart does not auto-resume agents

When the Hive runtime restarts (a crash, an update, a manual restart), it does
**not** automatically relaunch your agents. It restores the workspace and shows
each agent in a resumable state with a **[Restart]** (and **[Restart All]**)
button instead.

Auto-resuming sounds friendlier but is the wrong default. Relaunching N CLI
agents — each potentially re-entering a session, re-reading context, and
immediately acting under YOLO permissions — is a surprising amount of activity to
trigger silently on boot, especially after an unexpected crash where you may want
to inspect state first. Restart is a deliberate, per-agent (or all-at-once)
action so that *you* choose when work resumes and on which agents. Underneath,
resume still uses each CLI's native session recovery where available, so pressing
Restart picks up the real conversation rather than starting cold.
