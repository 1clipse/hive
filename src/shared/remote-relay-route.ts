// Daemon↔gateway hop only: a cleartext device-id prefix so RelayDO can deliver
// daemon→phone frames to one socket without opening E2E ciphertext.
//
// The phone never sees this envelope — the gateway strips it. Unprefixed bytes
// (ConnSalt, legacy opaque test payloads) stay unrouted / broadcast.
//
// Mirrored in gateway/src/relay-route.ts (Workers package cannot import src/).
// tests/unit/remote-relay-route.test.ts pins the magic so the copies cannot drift.

export const RELAY_ROUTE_MAGIC = new Uint8Array([0x48, 0x52, 0x54, 0x31]) // HRT1
export const RELAY_ROUTE_MAX_DEVICE_ID = 128

const te = new TextEncoder()
const td = new TextDecoder()

export const wrapRelayRoute = (deviceId: string, frame: Uint8Array): Uint8Array => {
  const id = te.encode(deviceId)
  if (id.length === 0 || id.length > RELAY_ROUTE_MAX_DEVICE_ID) {
    throw new RangeError('relay route deviceId length')
  }
  const out = new Uint8Array(RELAY_ROUTE_MAGIC.length + 1 + id.length + frame.length)
  out.set(RELAY_ROUTE_MAGIC, 0)
  out[RELAY_ROUTE_MAGIC.length] = id.length
  out.set(id, RELAY_ROUTE_MAGIC.length + 1)
  out.set(frame, RELAY_ROUTE_MAGIC.length + 1 + id.length)
  return out
}

export const unwrapRelayRoute = (
  message: Uint8Array
): { deviceId: string | null; frame: Uint8Array } => {
  const magicLen = RELAY_ROUTE_MAGIC.length
  if (message.length < magicLen + 2) return { deviceId: null, frame: message }
  for (let i = 0; i < magicLen; i++) {
    if (message[i] !== RELAY_ROUTE_MAGIC[i]) return { deviceId: null, frame: message }
  }
  const idLen = message[magicLen] ?? 0
  if (idLen < 1 || idLen > RELAY_ROUTE_MAX_DEVICE_ID) return { deviceId: null, frame: message }
  const idStart = magicLen + 1
  if (message.length < idStart + idLen) return { deviceId: null, frame: message }
  return {
    deviceId: td.decode(message.subarray(idStart, idStart + idLen)),
    frame: message.subarray(idStart + idLen),
  }
}
