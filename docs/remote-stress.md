# Remote-access stress + Windows acceptance (M6)

Two runnable stress drivers plus the manual acceptance that is intentionally NOT automated. The
runnable scripts are deterministic, in-process, and CI-friendly; the soak/real-phone/real-Windows runs
are deferred to a human because faking them would prove nothing.

## Runnable now

Both drivers boot a real Hive runtime, a real outbound daemon tunnel, and a real `ws` gateway
stand-in, then drive real M1-sealed frames end-to-end (no mocked PTY, socket, or crypto). They exit
non-zero on failure, so they double as smoke gates.

### Single-daemon multi-device concurrency (`H-STRESS-1`)

```
pnpm stress:multidevice            # defaults: 8 devices, 25 rounds, 4 in-flight/device
pnpm stress:multidevice --devices 16 --rounds 50 --inflight 6
```

Pairs N phones to ONE daemon, holds live terminal io streams on half of them, and fires concurrent
`/api` waves across all. This is the scale exercise for `H-NET-4`: multiple devices legitimately
allocate the same odd streamId, and a per-stream-id-only owner map would black-hole the second
device's stream. A black-holed stream surfaces as a per-round timeout (FAIL), not an infinite wait.
The in-suite regression is `tests/server/remote-multi-device.test.ts`.

### Terminal high-throughput over the tunnel (`H-STRESS-2`)

```
pnpm stress:throughput             # defaults: 8s, 4KB lines, never-acking phone
pnpm stress:throughput --seconds 30 --lineKb 8
```

Runs a firehose PTY producer over a terminal io stream pointed at a phone that NEVER acks (a stalled
mobile). Verifies the `VULN-RELIABILITY-1` sender-window fix: the forwarded daemon->phone bytes stay
bounded (under 3x the 256KB window) instead of draining the whole producer, and daemon RSS plateaus
instead of climbing with the burst. The `--expose-gc` in the npm script makes the RSS sampling clean.
The in-suite regression is `tests/server/remote-tunnel-bridge.test.ts` case `(b3)`.

## Deferred MANUAL acceptance — do NOT fake these

These are real-world runs that the in-process drivers cannot stand in for. They must be run by a human
before the 2.0 release and the result recorded in the plan checklist.

- **72h soak** — daemon + a real phone over real 4G/Wi-Fi for 72h. Watch for: daemon RSS leak, zombie
  terminal streams after lock-screen/network-switch reconnects, and that an interrupted in-flight
  request fails fast (never hangs). The runnable throughput driver checks the memory bound for a few
  seconds; only the soak proves it over days with a real radio.
- **Real phone equal-authority pass** — enter the desktop pairing code on a phone,
  desktop-confirm, then exercise the full mobile UI (terminal IME input, dispatch,
  task graph) over the real gateway.
- **Real Windows CI** — `pnpm test:windows` runs the Windows-relevant suite locally green, but the
  actual Windows runner is deferred to push. The remote code is pure JS (no new native deps: only the
  pre-existing better-sqlite3 / esbuild / node-pty are built), the loopback bridge dials a numeric
  127.0.0.1/[::1] host with an already-canonicalized path, and the path whitelist rejects backslash, so
  it is Windows-safe by construction (`tests/unit/remote-windows-compat.test.ts` pins this). Confirm on
  the Windows runner after push.
