// Daemon → gateway HTTP client (plan D5). The pairing data-plane rides the wss
// tunnel, but the device-row creation is a separate, daemon-token-authed HTTPS
// call: only a real daemon (post-desktop-confirm) may create the gateway's device
// row, which is what later lets the phone's /pair/session mint a device-bound
// cookie. A phone has no daemon token, so it can never self-promote.
//
// Wire contract mirrors gateway/src/pair.ts POST /pair/confirm and the shape the
// gateway tests exercise (gateway/test/pairing-relay.test.ts postConfirm):
//   POST ${gatewayUrl}/pair/confirm
//   Authorization: Bearer <daemonToken>
//   { deviceId, devicePubkey, name, boundJti }   (devicePubkey is base64url)
// The gateway 200s on create-or-idempotent; any non-2xx is a hard failure here so
// the confirm path can refuse to tell the phone "confirmed" (see remote-pairing).
//
// trimSlash + the header/body shape deliberately match src/cli/hive-remote.ts so
// the daemon and CLI speak the gateway identically.

export interface PostPairConfirmDeps {
  gatewayUrl: string
  daemonToken: string
  /** Inject a fetch for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch
}

export interface PairConfirmBody {
  deviceId: string
  /** The device's X25519 public key, base64url — opaque to the gateway. */
  devicePubkey: string
  name: string
  boundJti: string
}

const trimSlash = (url: string): string => url.replace(/\/+$/, '')

export const postPairConfirm = async (
  deps: PostPairConfirmDeps,
  body: PairConfirmBody
): Promise<void> => {
  const fetchImpl = deps.fetchImpl ?? fetch
  const res = await fetchImpl(`${trimSlash(deps.gatewayUrl)}/pair/confirm`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${deps.daemonToken}`,
    },
    body: JSON.stringify({
      deviceId: body.deviceId,
      devicePubkey: body.devicePubkey,
      name: body.name,
      boundJti: body.boundJti,
    }),
  })
  if (!res.ok) {
    throw new Error(`gateway /pair/confirm failed: ${res.status}`)
  }
}

// POST /pair/revoke — daemon-token-authed. Marks the gateway device row + session jti revoked
// so a locally revoked phone cannot keep using /pair/relay-token or /relay.
// Only success acknowledges a revoke. A 404 can mean a different account or a
// missing route. The gateway returns success for owned, already-revoked devices.
export const postPairRevoke = async (
  deps: PostPairConfirmDeps,
  deviceId: string
): Promise<void> => {
  const fetchImpl = deps.fetchImpl ?? fetch
  const res = await fetchImpl(`${trimSlash(deps.gatewayUrl)}/pair/revoke`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${deps.daemonToken}`,
    },
    body: JSON.stringify({ deviceId }),
    signal: AbortSignal.timeout(5_000),
  })
  if (!res.ok) {
    throw new Error(`gateway /pair/revoke failed: ${res.status}`)
  }
}
