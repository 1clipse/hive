import { ForbiddenError } from './http-errors.js'
import type { RemoteAuditRecord } from './remote-audit-store.js'
import {
  REMOTE_DAEMON_TOKEN_KEY,
  REMOTE_ENABLED_KEY,
  REMOTE_GATEWAY_URL_KEY,
} from './remote-config-keys.js'
import type { RemoteDeviceRecord } from './remote-device-store.js'
import { HIVE_REMOTE_DEVICE_HEADER } from './remote-loopback-auth.js'
import type { PairingTicket, PendingPairingView } from './remote-pairing.js'
import { getRequiredParam, readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteContext, RouteDefinition } from './route-types.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'

// Remote-access device-management + pairing routes (M4). Two gate classes:
//   - gateUi: the standard local-OR-tunnel gate every equal-authority route uses. A paired phone may
//     reach these (list devices, revoke, status, audit) exactly like the desktop.
//   - gateLocalDesktopOnly: the TRUST ROOT (Authority Model). Pairing begin/confirm/reject can ONLY be
//     driven from the local desktop cookie path; a tunnel-tagged (phone) request is refused with 403.
//     This is a pairing-ceremony invariant, NOT a feature permission — a phone can never self-approve
//     a new device. Defense in depth: these three paths are ALSO hard-denied on the bridge
//     (remote-bridge-routing DENIED pairing matcher), so even a bypassed gate gets Reset there.

// Standard local-OR-tunnel gate. A request with no secret header falls to the cookie path (a browser);
// a tunnel-stamped request short-circuits as authorized. Used by the equal-authority endpoints.
const gateUi = ({ request, store }: RouteContext): void => {
  requireUiTokenFromRequest(request, store.validateUiToken, store.authorizeRemoteTunnelRequest)
}

// TRUST-ROOT gate: local desktop ONLY. A tunnel-tagged request (authorizeRemoteTunnelRequest === true)
// is a phone; refuse it. We audit the forbidden attempt with the concrete reason BEFORE throwing
// (HARDEN D0.3): the audit spec lists "被拒请求及原因" as a required audited action, and the route is
// the only layer that can attribute a 403 here to 'pairing_confirm_forbidden' (the bridge's onEnd
// audits the loopback request status-agnostically). Then we pass NO tunnel authorizer to the token
// check, so even the short-circuit can't admit a tunnel request that slipped a cookie too.
const gateLocalDesktopOnly = ({ request, store }: RouteContext): void => {
  if (store.authorizeRemoteTunnelRequest(request)) {
    const rawDeviceId = request.headers[HIVE_REMOTE_DEVICE_HEADER]
    store.getRemoteAuditStore().enqueue({
      action: 'reject',
      deviceId: typeof rawDeviceId === 'string' ? rawDeviceId : null,
      endpoint: request.url ?? null,
      result: 'rejected',
      rejectReason: 'pairing_confirm_forbidden',
    })
    throw new ForbiddenError('device approval is desktop-only')
  }
  requireUiTokenFromRequest(request, store.validateUiToken)
}

const isLoggedIn = (store: RouteContext['store']): boolean =>
  (store.settings.getAppState(REMOTE_GATEWAY_URL_KEY)?.value ?? null) !== null &&
  (store.settings.getAppState(REMOTE_DAEMON_TOKEN_KEY)?.value ?? null) !== null

const remoteStatus = (store: RouteContext['store']) => {
  const status = store.getRemoteTunnelStatus()
  return {
    enabled: store.settings.getAppState(REMOTE_ENABLED_KEY)?.value === 'true',
    logged_in: isLoggedIn(store),
    gateway_url: store.settings.getAppState(REMOTE_GATEWAY_URL_KEY)?.value ?? null,
    connected: status === 'online',
    // The FULL tunnel state, not just online/offline — the desktop dot was stuck looking "connected or
    // not" and couldn't show connecting / reconnecting / revoked / logged-out. (connecting+reconnecting
    // are the states a flaky link spends real time in; surfacing them is what makes the dot honest.)
    connection: status,
  }
}

// HTTP responses stay snake_case even though the store uses camelCase records.
const toPairingTicketView = (ticket: PairingTicket) => ({
  pairing_id: ticket.pairingId,
  qr: ticket.qr,
  code: ticket.code,
  expires_at: ticket.expiresAt,
})

const toPendingPairingView = (pending: PendingPairingView) => ({
  pairing_id: pending.pairingId,
  device_name: pending.deviceName,
  sas: pending.sas,
  expires_at: pending.expiresAt,
})

const toDeviceView = (record: RemoteDeviceRecord) => ({
  id: record.id,
  name: record.name,
  created_at: record.createdAt,
  last_active: record.lastActive,
  revoked_at: record.revokedAt,
})

const toAuditView = (record: RemoteAuditRecord) => ({
  id: record.id,
  device_id: record.deviceId,
  ts: record.ts,
  workspace_id: record.workspaceId,
  action: record.action,
  endpoint: record.endpoint,
  result: record.result,
  reject_reason: record.rejectReason,
  byte_count: record.byteCount,
  preview: record.preview,
})

const getSearchParams = (url: string | undefined) => new URL(url ?? '', 'http://x').searchParams

const hasCompatFlag = (params: URLSearchParams, snakeName: string, camelName: string) =>
  params.has(snakeName) || params.has(camelName)

const getCompatParam = (
  params: URLSearchParams,
  snakeName: string,
  camelName: string
): string | null => params.get(snakeName) ?? params.get(camelName)

export const remoteRoutes: RouteDefinition[] = [
  route('GET', '/api/remote/status', (ctx) => {
    gateUi(ctx)
    sendJson(ctx.response, 200, remoteStatus(ctx.store))
  }),

  route('PUT', '/api/remote/enabled', async (ctx) => {
    const { request, response, store } = ctx
    const body = await readJsonBody<{ enabled?: boolean }>(request)
    const enabled = body.enabled === true
    // D0.4 — conditional gate: a remote MAY turn the tunnel OFF (self-disconnect) but NEVER ON. So a
    // tunnel-tagged enable:true is the only enabled-route action that is desktop-only.
    if (enabled && store.authorizeRemoteTunnelRequest(request)) {
      throw new ForbiddenError('remote cannot self-enable')
    }
    gateUi(ctx)
    store.setRemoteEnabled(enabled)
    sendJson(response, 200, remoteStatus(store))
  }),

  // ── trust-root pairing set (desktop-only) ──────────────────────────────────────────────────────
  route('POST', '/api/remote/pairings', (ctx) => {
    gateLocalDesktopOnly(ctx)
    if (!isLoggedIn(ctx.store)) {
      sendJson(ctx.response, 503, { error: 'remote not logged in' })
      return
    }
    try {
      const ticket = ctx.store.getRemotePairing().beginPairing()
      sendJson(ctx.response, 200, toPairingTicketView(ticket))
    } catch {
      // beginPairing throws if gateway/daemon id vanished between the status read and here.
      sendJson(ctx.response, 503, { error: 'remote not logged in' })
    }
  }),

  route('GET', '/api/remote/pairings/pending', (ctx) => {
    // HARDEN minor: desktop-only. The confirm dialog backs this; a phone has no use for another
    // device's in-flight SAS, and exposing it would needlessly widen the secret surface (invariant 7).
    gateLocalDesktopOnly(ctx)
    sendJson(
      ctx.response,
      200,
      ctx.store.getRemotePairing().listPending().map(toPendingPairingView)
    )
  }),

  route('POST', '/api/remote/pairings/:pairingId/confirm', async (ctx) => {
    const { params, request, response, store } = ctx
    const pairingId = getRequiredParam(response, params, 'pairingId', 'Pairing id is required')
    if (!pairingId) return
    gateLocalDesktopOnly(ctx)
    const body = await readJsonBody<{ name?: string }>(request).catch(
      () => ({}) as { name?: string }
    )
    // THE trust-root action (D3): confirmRemotePairing drives the engine's local insert (the only
    // caller of deviceStore.insert) AND the gateway device-row registration + the `confirmed` signal
    // to the phone, in that order. A gateway-POST failure (or a missing boundJti) rejects here: the
    // local row exists but the phone is NOT told OK, so it can re-scan. Surface 502 so the desktop
    // operator sees the pairing didn't complete end-to-end rather than a false success.
    let record: RemoteDeviceRecord | null
    try {
      record = await store.confirmRemotePairing(
        pairingId,
        body.name === undefined ? undefined : body.name
      )
    } catch {
      sendJson(response, 502, { error: 'gateway registration failed; rescan to retry' })
      return
    }
    if (!record) {
      // Unknown / expired / wrong-state pairing. Nothing persisted.
      sendJson(response, 404, { error: 'pairing not found or no longer confirmable' })
      return
    }
    // The newly-persisted device is live in the provider now. Reconcile the tunnel so a freshly
    // enabled remote starts connecting (no-op if already online / disabled).
    store.setRemoteEnabled(store.settings.getAppState(REMOTE_ENABLED_KEY)?.value === 'true')
    sendJson(response, 200, { device: toDeviceView(record) })
  }),

  route('POST', '/api/remote/pairings/:pairingId/reject', (ctx) => {
    const { params, response, store } = ctx
    const pairingId = getRequiredParam(response, params, 'pairingId', 'Pairing id is required')
    if (!pairingId) return
    gateLocalDesktopOnly(ctx)
    store.getRemotePairing().rejectPairing(pairingId, 'user_rejected')
    response.statusCode = 204
    response.end()
  }),

  // ── equal-authority device management ──────────────────────────────────────────────────────────
  route('GET', '/api/remote/devices', (ctx) => {
    gateUi(ctx)
    const params = getSearchParams(ctx.request.url)
    const includeRevoked = hasCompatFlag(params, 'include_revoked', 'includeRevoked')
    sendJson(
      ctx.response,
      200,
      ctx.store.getRemoteDeviceStore().list(includeRevoked).map(toDeviceView)
    )
  }),

  route('POST', '/api/remote/devices/:deviceId/revoke', (ctx) => {
    const { params, response, store } = ctx
    const deviceId = getRequiredParam(response, params, 'deviceId', 'Device id is required')
    if (!deviceId) return
    gateUi(ctx)
    // Revocation closed loop (§6 orchestrator in the runtime store): provider drop + tunnel close +
    // audit. Equal-authority: a phone may revoke any device, including itself.
    store.revokeRemoteDevice(deviceId)
    response.statusCode = 204
    response.end()
  }),

  route('GET', '/api/remote/audit', (ctx) => {
    gateUi(ctx)
    const params = getSearchParams(ctx.request.url)
    const rawLimit = Number(params.get('limit'))
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 100
    const deviceId = getCompatParam(params, 'device_id', 'deviceId')
    const audit = ctx.store.getRemoteAuditStore()
    const records = deviceId ? audit.listForDevice(deviceId, limit) : audit.list(limit)
    sendJson(ctx.response, 200, records.map(toAuditView))
  }),
]
