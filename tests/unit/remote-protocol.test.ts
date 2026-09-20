import { describe, expect, test } from 'vitest'
import {
  CHANNEL_STREAM_ID,
  createFlowController,
  createStreamIdAllocator,
  createStreamMachine,
  decodeAckPayload,
  decodeHeader,
  decodeHello,
  decodeHttpData,
  decodeOpenPayload,
  decodeResetPayload,
  decodeWsMessage,
  encodeAckPayload,
  encodeHeader,
  encodeHello,
  encodeHttpBodyChunk,
  encodeHttpHead,
  encodeOpenPayload,
  encodeResetPayload,
  encodeWsMessage,
  FLOW,
  type FrameHeader,
  FrameKind,
  HEADER_BYTES,
  type HelloMeta,
  type HttpResponseHead,
  isReservedFlagsClear,
  negotiateVersion,
  PROTOCOL_VERSION,
  ProtocolError,
  ResetCode,
  type StreamMeta,
  StreamTransport,
} from '../../src/shared/remote-protocol.js'

// ── header (R1/R5: 12-byte binary header IS the AEAD AAD) ─────────────────────

describe('header codec', () => {
  // §4 protocol-1: round-trip exact offsets, distinct value per field, byte placement.
  test('round-trips and lands each field at its documented offset', () => {
    const h: FrameHeader = {
      version: PROTOCOL_VERSION,
      kind: FrameKind.Data,
      flags: 0x0001,
      streamId: 0x01020304,
      seq: 0x0a0b0c0d,
    }
    const bytes = encodeHeader(h)
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(bytes.length).toBe(HEADER_BYTES)
    expect(bytes.length).toBe(12)

    // documented layout: version@0(u8) kind@1(u8) flags@2(u16be) streamId@4(u32be) seq@8(u32be)
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    expect(dv.getUint8(0)).toBe(PROTOCOL_VERSION)
    expect(dv.getUint8(1)).toBe(FrameKind.Data)
    expect(dv.getUint16(2)).toBe(0x0001)
    expect(dv.getUint32(4)).toBe(0x01020304)
    expect(dv.getUint32(8)).toBe(0x0a0b0c0d)

    expect(decodeHeader(bytes)).toEqual(h)
  })

  // SEAM with remote-crypto: crypto reads streamId@4 and seq@8 directly out of these bytes.
  test('streamId sits at byte offset 4 and seq at offset 8 (crypto AAD seam)', () => {
    const h: FrameHeader = {
      version: PROTOCOL_VERSION,
      kind: FrameKind.Data,
      flags: 0,
      streamId: 7,
      seq: 9,
    }
    const bytes = encodeHeader(h)
    // bytes 4..7 == u32be(7), bytes 8..11 == u32be(9)
    expect(Array.from(bytes.slice(4, 8))).toEqual([0, 0, 0, 7])
    expect(Array.from(bytes.slice(8, 12))).toEqual([0, 0, 0, 9])
  })

  // §4 protocol-2: short buffer must throw, never silently read garbage.
  test('decodeHeader throws ProtocolError on a short (<12) buffer', () => {
    const ok = encodeHeader({
      version: PROTOCOL_VERSION,
      kind: FrameKind.Ping,
      flags: 0,
      streamId: 0,
      seq: 0,
    })
    expect(() => decodeHeader(ok.slice(0, 11))).toThrow(ProtocolError)
  })

  // §4 protocol-3: version field is checked, not just read.
  test('decodeHeader rejects a wrong version with VersionMismatch', () => {
    const bytes = encodeHeader({
      version: PROTOCOL_VERSION,
      kind: FrameKind.Data,
      flags: 0,
      streamId: 1,
      seq: 0,
    })
    bytes[0] = (PROTOCOL_VERSION + 1) & 0xff
    let caught: unknown
    try {
      decodeHeader(bytes)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ProtocolError)
    expect((caught as ProtocolError).code).toBe(ResetCode.VersionMismatch)
  })

  // §4 protocol-3: unknown kind enum must throw, not pass through.
  test('decodeHeader rejects an unknown kind with ProtocolError', () => {
    const bytes = encodeHeader({
      version: PROTOCOL_VERSION,
      kind: FrameKind.Data,
      flags: 0,
      streamId: 1,
      seq: 0,
    })
    bytes[1] = 0x7f // not a FrameKind
    let caught: unknown
    try {
      decodeHeader(bytes)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ProtocolError)
    expect((caught as ProtocolError).code).toBe(ResetCode.ProtocolError)
  })

  // §4 protocol-3 + harden (canonical AAD): reserved flag bits MUST be rejected so a given
  // semantic header has exactly one byte encoding (else AAD is non-canonical).
  test('decodeHeader rejects reserved flag bits on a Data frame (only bit0/FIN allowed)', () => {
    const bytes = encodeHeader({
      version: PROTOCOL_VERSION,
      kind: FrameKind.Data,
      flags: 0,
      streamId: 1,
      seq: 0,
    })
    // set bit1 (reserved) on a Data frame
    new DataView(bytes.buffer).setUint16(2, 0x0002)
    expect(() => decodeHeader(bytes)).toThrow(ProtocolError)
  })

  // harden (canonical AAD): on a non-Data frame ALL 16 flag bits are reserved, incl. bit0.
  test('decodeHeader rejects any flag bit (incl. bit0) on a non-Data frame', () => {
    for (const kind of [
      FrameKind.Open,
      FrameKind.End,
      FrameKind.Reset,
      FrameKind.Ping,
      FrameKind.Ack,
    ]) {
      const bytes = encodeHeader({
        version: PROTOCOL_VERSION,
        kind,
        flags: 0,
        streamId: 1,
        seq: 0,
      })
      new DataView(bytes.buffer).setUint16(2, 0x0001) // bit0 set — illegal on non-Data
      expect(() => decodeHeader(bytes)).toThrow(ProtocolError)
    }
  })

  test('Data frame with FIN (bit0) decodes and preserves the flag', () => {
    const h: FrameHeader = {
      version: PROTOCOL_VERSION,
      kind: FrameKind.Data,
      flags: 0x0001,
      streamId: 3,
      seq: 5,
    }
    expect(decodeHeader(encodeHeader(h))).toEqual(h)
  })

  test('isReservedFlagsClear flags non-zero high bits', () => {
    expect(isReservedFlagsClear(0x0000)).toBe(true)
    expect(isReservedFlagsClear(0x0001)).toBe(true) // bit0 is FIN, not reserved
    expect(isReservedFlagsClear(0x0002)).toBe(false)
    expect(isReservedFlagsClear(0x8000)).toBe(false)
  })

  // encodeHeader must reject out-of-range fields so it can never emit a non-canonical header.
  test('encodeHeader rejects out-of-range streamId / seq', () => {
    expect(() =>
      encodeHeader({
        version: PROTOCOL_VERSION,
        kind: FrameKind.Data,
        flags: 0,
        streamId: 0x1_0000_0000,
        seq: 0,
      })
    ).toThrow(RangeError)
    expect(() =>
      encodeHeader({
        version: PROTOCOL_VERSION,
        kind: FrameKind.Data,
        flags: 0,
        streamId: 0,
        seq: 0x1_0000_0000,
      })
    ).toThrow(RangeError)
  })
})

// ── payload codecs ────────────────────────────────────────────────────────────

describe('payload codecs', () => {
  // §4 protocol-4: Open round-trips, distinct values, preserves duplicate header keys & order.
  test('Open (http) round-trips with duplicate header keys preserved in order', () => {
    const m: StreamMeta = {
      transport: StreamTransport.Http,
      http: {
        method: 'POST',
        path: '/api/x?y=1',
        headers: [
          ['accept', 'text/event-stream'],
          ['cookie', 'a=1'],
          ['cookie', 'b=2'],
        ],
        hasBody: true,
      },
    }
    const decoded = decodeOpenPayload(encodeOpenPayload(m))
    expect(decoded).toEqual(m)
    // order + duplicates intact (a Map would collapse the two cookies)
    expect(decoded.http?.headers).toEqual([
      ['accept', 'text/event-stream'],
      ['cookie', 'a=1'],
      ['cookie', 'b=2'],
    ])
  })

  test('Open (ws) round-trips with and without subprotocol', () => {
    const withSub: StreamMeta = {
      transport: StreamTransport.Ws,
      ws: { path: '/term', subprotocol: 'hive.v1' },
    }
    const noSub: StreamMeta = { transport: StreamTransport.Ws, ws: { path: '/term' } }
    expect(decodeOpenPayload(encodeOpenPayload(withSub))).toEqual(withSub)
    expect(decodeOpenPayload(encodeOpenPayload(noSub))).toEqual(noSub)
  })

  test('Open (ws) round-trips the query field (clientId/cols/rows ride here, not the path)', () => {
    const withQuery: StreamMeta = {
      transport: StreamTransport.Ws,
      ws: {
        path: '/ws/terminal/r1/io',
        query: [
          ['clientId', 'c1'],
          ['cols', '80'],
        ],
      },
    }
    expect(decodeOpenPayload(encodeOpenPayload(withQuery))).toEqual(withQuery)
    // a non-list query is rejected as a protocol error
    expect(() =>
      decodeOpenPayload(
        encodeOpenPayload({
          transport: StreamTransport.Ws,
          // biome-ignore lint/suspicious/noExplicitAny: deliberately malformed query for the decoder
          ws: { path: '/term', query: 'clientId=c1' as any },
        })
      )
    ).toThrow()
  })

  test('Hello round-trips and surfaces ids (transcript-binding seam for M3)', () => {
    const m: HelloMeta = {
      protocolVersion: PROTOCOL_VERSION,
      role: 'daemon',
      daemonId: 'daemon-abc',
      deviceId: 'device-xyz',
    }
    expect(decodeHello(encodeHello(m))).toEqual(m)
  })

  test('Ack round-trips a u32 cumulative byte count', () => {
    for (const n of [0, 1, 0xffff, 0xffffffff]) {
      expect(decodeAckPayload(encodeAckPayload(n))).toBe(n)
    }
  })

  // §4 protocol-6: Ack codec rejects a wrong-length buffer (under/over-read).
  test('decodeAckPayload rejects a 3-byte buffer', () => {
    expect(() => decodeAckPayload(new Uint8Array([0, 0, 0]))).toThrow(ProtocolError)
    expect(() => decodeAckPayload(new Uint8Array([0, 0, 0, 0, 0]))).toThrow(ProtocolError)
  })

  test('Reset round-trips each ResetCode', () => {
    for (const code of Object.values(ResetCode)) {
      expect(decodeResetPayload(encodeResetPayload(code))).toBe(code)
    }
  })

  test('decodeResetPayload rejects an unknown code', () => {
    expect(() => decodeResetPayload(new Uint8Array([0x7f]))).toThrow(ProtocolError)
    expect(() => decodeResetPayload(new Uint8Array([]))).toThrow(ProtocolError)
  })

  test('encodeAckPayload rejects out-of-range cumulative', () => {
    expect(() => encodeAckPayload(-1)).toThrow(RangeError)
    expect(() => encodeAckPayload(0x1_0000_0000)).toThrow(RangeError)
  })
})

// ── binary safety (terminal stdin must survive byte-for-byte) ──────────────────

describe('binary-safe data / WS messages', () => {
  // §4 protocol-5: Data carries raw bytes incl. NUL/high/ESC, never utf8-coerced.
  test('WS binary message round-trips bytes incl. 0x00 0xFF 0x80 0x1b', () => {
    const data = new Uint8Array([0x00, 0xff, 0x80, 0x7f, 0x1b, 0x00])
    const r = decodeWsMessage(encodeWsMessage(data, false))
    expect(r.isText).toBe(false)
    expect(Array.from(r.data)).toEqual(Array.from(data))
  })

  test('WS text flag is carried independently of the bytes', () => {
    const data = new Uint8Array([0x68, 0x69]) // "hi"
    const r = decodeWsMessage(encodeWsMessage(data, true))
    expect(r.isText).toBe(true)
    expect(Array.from(r.data)).toEqual([0x68, 0x69])
  })

  // §4 protocol-20: both directions are byte-identical; the codec has no direction state.
  test('WS bidirectional binary round-trip stays byte-identical incl. 0x1b/0x00', () => {
    const c2s = new Uint8Array([0x1b, 0x5b, 0x41, 0x00, 0xff])
    const s2c = new Uint8Array([0x00, 0x1b, 0x4f, 0x80])
    expect(Array.from(decodeWsMessage(encodeWsMessage(c2s, false)).data)).toEqual(Array.from(c2s))
    expect(Array.from(decodeWsMessage(encodeWsMessage(s2c, true)).data)).toEqual(Array.from(s2c))
  })
})

// ── HTTP head/body discriminator + reassembly ─────────────────────────────────

describe('http data envelope', () => {
  // §4 protocol-17: head vs body discriminator; dup header keys; non-ASCII body bytes intact.
  test('discriminates head from body and preserves duplicate header keys', () => {
    const head: HttpResponseHead = {
      status: 206,
      headers: [
        ['content-type', 'text/plain'],
        ['set-cookie', 'a=1'],
        ['set-cookie', 'b=2'],
      ],
    }
    const decodedHead = decodeHttpData(encodeHttpHead(head))
    expect(decodedHead.kind).toBe('head')
    if (decodedHead.kind === 'head') {
      expect(decodedHead.head.status).toBe(206)
      expect(decodedHead.head.headers).toEqual(head.headers)
    }

    const body = new Uint8Array([0xe2, 0x9c, 0x93, 0x00, 0xff]) // ✓ + NUL + 0xFF
    const decodedBody = decodeHttpData(encodeHttpBodyChunk(body))
    expect(decodedBody.kind).toBe('body')
    if (decodedBody.kind === 'body') {
      expect(Array.from(decodedBody.data)).toEqual(Array.from(body))
    }
  })

  // §4 protocol-18: N streamed body chunks reassemble to the exact original, in order.
  test('streamed body chunks reassemble in order to the exact original', () => {
    const chunks = [
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4]),
      new Uint8Array([5, 6, 0x00, 0xff]),
    ]
    const out: number[] = []
    for (const c of chunks) {
      const d = decodeHttpData(encodeHttpBodyChunk(c))
      expect(d.kind).toBe('body')
      if (d.kind === 'body') out.push(...Array.from(d.data))
    }
    expect(out).toEqual([1, 2, 3, 4, 5, 6, 0x00, 0xff])
  })

  test('decodeHttpData rejects an unknown discriminator byte', () => {
    expect(() => decodeHttpData(new Uint8Array([0x02]))).toThrow(ProtocolError)
    expect(() => decodeHttpData(new Uint8Array([]))).toThrow(ProtocolError)
  })
})

// ── per-stream FSM (half-close, illegal transitions) ──────────────────────────

describe('stream state machine', () => {
  // §4 protocol-7: legal lifecycle is the positive baseline for every negative below.
  test('legal lifecycle open -> data*3 -> end reaches remoteClosed', () => {
    const m = createStreamMachine()
    expect(m.state()).toBe('idle')
    expect(m.onRecv(FrameKind.Open)).toEqual({ ok: true })
    expect(m.state()).toBe('open')
    for (let i = 0; i < 3; i++) expect(m.onRecv(FrameKind.Data)).toEqual({ ok: true })
    expect(m.onRecv(FrameKind.End)).toEqual({ ok: true })
    expect(m.state()).toBe('remoteClosed')
  })

  // §4 protocol-8 (hard-acceptance reverse-the-line): data before open is illegal.
  test('rejects Data received before Open (no lazy auto-open)', () => {
    const m = createStreamMachine()
    expect(m.onRecv(FrameKind.Data)).toEqual({ ok: false, reset: ResetCode.ProtocolError })
    // must NOT have transitioned to open
    expect(m.state()).toBe('idle')
  })

  // §4 protocol-9: use-after-close — data after recv End is illegal.
  test('rejects Data received after End (use-after-close)', () => {
    const m = createStreamMachine()
    m.onRecv(FrameKind.Open)
    m.onRecv(FrameKind.End)
    expect(m.state()).toBe('remoteClosed')
    expect(m.onRecv(FrameKind.Data)).toEqual({ ok: false, reset: ResetCode.ProtocolError })
  })

  // §4 protocol-10: duplicate Open is a collision, not a silent state reset.
  test('rejects a duplicate Open', () => {
    const m = createStreamMachine()
    m.onRecv(FrameKind.Open)
    expect(m.onRecv(FrameKind.Open)).toEqual({ ok: false, reset: ResetCode.ProtocolError })
    expect(m.state()).toBe('open')
  })

  // §4 protocol-11: write after local half-close is illegal.
  test('rejects onSendData after onLocalEnd (write after half-close)', () => {
    const m = createStreamMachine()
    m.onRecv(FrameKind.Open)
    expect(m.onSendData()).toEqual({ ok: true })
    m.onLocalEnd()
    expect(m.state()).toBe('localClosed')
    expect(m.onSendData()).toEqual({ ok: false, reset: ResetCode.ProtocolError })
  })

  test('localClosed still delivers inbound Data, then End closes', () => {
    const m = createStreamMachine()
    m.onRecv(FrameKind.Open)
    m.onLocalEnd()
    expect(m.state()).toBe('localClosed')
    expect(m.onRecv(FrameKind.Data)).toEqual({ ok: true })
    expect(m.onRecv(FrameKind.End)).toEqual({ ok: true })
    expect(m.state()).toBe('closed')
  })

  test('onLocalEnd from remoteClosed reaches closed', () => {
    const m = createStreamMachine()
    m.onRecv(FrameKind.Open)
    m.onRecv(FrameKind.End)
    expect(m.state()).toBe('remoteClosed')
    m.onLocalEnd()
    expect(m.state()).toBe('closed')
  })

  // §4 protocol-19 (hard-acceptance): Reset is real teardown, not a clean End.
  test('Reset tears the stream down to closed from any live state', () => {
    const m = createStreamMachine()
    m.onRecv(FrameKind.Open)
    m.onRecv(FrameKind.Data)
    expect(m.onRecv(FrameKind.Reset)).toEqual({ ok: true })
    expect(m.state()).toBe('closed')
    // after closed: sending data is illegal, a second Reset is idempotent-ok
    expect(m.onSendData()).toEqual({ ok: false, reset: ResetCode.ProtocolError })
    expect(m.onRecv(FrameKind.Reset)).toEqual({ ok: true })
  })

  test('Reset from idle goes straight to closed', () => {
    const m = createStreamMachine()
    expect(m.onRecv(FrameKind.Reset)).toEqual({ ok: true })
    expect(m.state()).toBe('closed')
  })
})

// ── flow control (dual-watermark credit window; non-happy-path is the point) ───

describe('flow controller', () => {
  // §4 protocol-12 (hard-acceptance): exhaustion at the exact boundary, no off-by-one.
  test('allows sends up to exactly the window then blocks the byte that would exceed it', () => {
    const w = 1000
    const fc = createFlowController(w, 100)
    expect(fc.trySend(600)).toEqual({ ok: true })
    expect(fc.trySend(400)).toEqual({ ok: true }) // cumulative == window exactly
    expect(fc.isPaused()).toBe(true)
    // the next byte exceeds -> refused, and refusal must not mutate state
    expect(fc.trySend(1)).toEqual({ ok: false, reason: 'WindowExhausted' })
    expect(fc.trySend(1)).toEqual({ ok: false, reason: 'WindowExhausted' })
  })

  // §4 protocol-13 (hard-acceptance): ack credits exactly n and resumes, not reset-to-full.
  test('ack credits exactly the consumed amount and resumes a paused sender', () => {
    const w = 1000
    const fc = createFlowController(w, 1)
    expect(fc.trySend(1000)).toEqual({ ok: true })
    expect(fc.isPaused()).toBe(true)
    // receiver consumed 400 cumulative -> 400 credit freed
    expect(fc.applyAck(400)).toEqual({ resumed: true })
    expect(fc.isPaused()).toBe(false)
    // exactly 400 freed: 400 succeeds, the 401st byte does not
    expect(fc.trySend(400)).toEqual({ ok: true })
    expect(fc.trySend(1)).toEqual({ ok: false, reason: 'WindowExhausted' })
  })

  // §4 protocol-14: stale / lower cumulative ack must not move the window (cumulative, not delta).
  test('a stale lower cumulative ack does not grow or shrink the window', () => {
    const fc = createFlowController(1000, 1)
    fc.trySend(1000)
    expect(fc.applyAck(700)).toEqual({ resumed: true }) // acked=700, unacked=300
    // a later, smaller cumulative is stale -> ignored, no resume, window unchanged
    expect(fc.applyAck(200)).toEqual({ resumed: false })
    // still only 700 of credit freed: 700 ok, 701 not
    expect(fc.trySend(700)).toEqual({ ok: true })
    expect(fc.trySend(1)).toEqual({ ok: false, reason: 'WindowExhausted' })
  })

  // §4 protocol-15: over-ack is clamped to sentBytes — window can never exceed config.
  test('an over-ack beyond sentBytes is clamped (no unbounded window growth)', () => {
    const w = 1000
    const fc = createFlowController(w, 1)
    fc.trySend(300)
    // ack far beyond what was ever sent
    fc.applyAck(300 + 999_999)
    // window is back to full but NOT larger: w succeeds, w+1 does not
    expect(fc.trySend(w)).toEqual({ ok: true })
    expect(fc.trySend(1)).toEqual({ ok: false, reason: 'WindowExhausted' })
  })

  // §4 protocol-16 / §2.5: 'resumed' means the window opened (was paused, now unacked < window).
  // A small ack lifts the pause and frees exactly that much credit — no more.
  test('a small ack frees exactly its credit, not the full blocked amount', () => {
    const fc = createFlowController(1000, 1)
    fc.trySend(1000)
    expect(fc.isPaused()).toBe(true)
    // free only 100 -> window unblocks by exactly 100 (not reset-to-full)
    expect(fc.applyAck(100)).toEqual({ resumed: true })
    expect(fc.isPaused()).toBe(false)
    // a 200-byte send still exceeds the 100 of freed credit
    expect(fc.trySend(200)).toEqual({ ok: false, reason: 'WindowExhausted' })
    // exactly 100 fits; the 101st byte does not
    expect(fc.trySend(100)).toEqual({ ok: true })
    expect(fc.trySend(1)).toEqual({ ok: false, reason: 'WindowExhausted' })
  })

  test('onConsume emits a cumulative ack only when threshold is crossed', () => {
    const fc = createFlowController(1000, 100)
    expect(fc.onConsume(50)).toBeNull() // under threshold
    expect(fc.onConsume(60)).toEqual({ ackCumulative: 110 }) // 110 - 0 >= 100
    expect(fc.onConsume(50)).toBeNull() // 160 - 110 = 50 < 100
    expect(fc.onConsume(60)).toEqual({ ackCumulative: 220 }) // 220 - 110 >= 100
  })

  test('flushAck always reports the full cumulative (used on End)', () => {
    const fc = createFlowController(1000, 100)
    fc.onConsume(40)
    expect(fc.flushAck()).toEqual({ ackCumulative: 40 })
    fc.onConsume(10)
    expect(fc.flushAck()).toEqual({ ackCumulative: 50 })
  })

  test('default window/threshold come from FLOW', () => {
    const fc = createFlowController()
    expect(fc.trySend(FLOW.INITIAL_WINDOW)).toEqual({ ok: true })
    expect(fc.trySend(1)).toEqual({ ok: false, reason: 'WindowExhausted' })
  })
})

// ── version negotiation ───────────────────────────────────────────────────────

describe('version negotiation', () => {
  const hello = (v: number, role: 'daemon' | 'device'): HelloMeta => ({
    protocolVersion: v,
    role,
    daemonId: 'd',
    deviceId: 'p',
  })

  // §4 protocol-21: match (positive baseline).
  test('matching versions negotiate ok', () => {
    expect(
      negotiateVersion(hello(PROTOCOL_VERSION, 'daemon'), hello(PROTOCOL_VERSION, 'device'))
    ).toEqual({
      ok: true,
      version: PROTOCOL_VERSION,
    })
  })

  // §4 protocol-22 (hard-acceptance): mismatch is a typed VersionMismatch, never silent fallback.
  test('a mismatched peer version is rejected with VersionMismatch, no coercion', () => {
    const r = negotiateVersion(
      hello(PROTOCOL_VERSION, 'daemon'),
      hello(PROTOCOL_VERSION + 1, 'device')
    )
    expect(r).toEqual({ ok: false, reset: ResetCode.VersionMismatch })
  })

  // §4 protocol-23 (hard-acceptance): a spliced old frame is rejected at decode even post-negotiation.
  test('a frame whose version byte is not PROTOCOL_VERSION is rejected at decodeHeader', () => {
    const bytes = encodeHeader({
      version: PROTOCOL_VERSION,
      kind: FrameKind.Data,
      flags: 0,
      streamId: 1,
      seq: 0,
    })
    bytes[0] = 0x00 // downgrade splice
    let caught: unknown
    try {
      decodeHeader(bytes)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ProtocolError)
    expect((caught as ProtocolError).code).toBe(ResetCode.VersionMismatch)
  })
})

// ── stream-id allocator ───────────────────────────────────────────────────────

describe('stream id allocator', () => {
  // §4 protocol-24: daemon even, device odd, never the reserved channel id (0), no collision.
  test('daemon yields evens, device yields odds, never 0, no collisions in 1000 allocations', () => {
    const dAlloc = createStreamIdAllocator('daemon')
    const pAlloc = createStreamIdAllocator('device')
    const daemonIds = new Set<number>()
    const deviceIds = new Set<number>()
    for (let i = 0; i < 1000; i++) {
      const d = dAlloc()
      const p = pAlloc()
      expect(d % 2).toBe(0)
      expect(p % 2).toBe(1)
      expect(d).not.toBe(CHANNEL_STREAM_ID)
      expect(p).not.toBe(CHANNEL_STREAM_ID)
      expect(daemonIds.has(d)).toBe(false)
      expect(deviceIds.has(p)).toBe(false)
      daemonIds.add(d)
      deviceIds.add(p)
    }
    expect(daemonIds.size).toBe(1000)
    expect(deviceIds.size).toBe(1000)
    // the two ranges never overlap (even vs odd)
    expect(CHANNEL_STREAM_ID).toBe(0)
  })
})

// ── version is the single shared constant (R6) ────────────────────────────────

describe('shared version constant', () => {
  test('PROTOCOL_VERSION is re-exported from crypto and equals 2', () => {
    expect(PROTOCOL_VERSION).toBe(2)
  })
})
