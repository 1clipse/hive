import { REMOTE_DAEMON_TOKEN_KEY, REMOTE_ENABLED_KEY } from './remote-config-keys.js'
import { postPairRevoke } from './remote-gateway-client.js'
import {
  addPendingRevoke,
  getPendingRevokeGateway,
  type PendingRevoke,
  type PendingRevokesStore,
  readPendingRevokes,
  removePendingRevoke,
} from './remote-pending-revokes.js'
import type { RemoteTunnel, TunnelStatus } from './remote-tunnel.js'
import type { RuntimeStore } from './runtime-store-contract.js'
import type { RuntimeStoreServices } from './runtime-store-helpers.js'

type RuntimeStoreRemoteMethods = Pick<
  RuntimeStore,
  | 'authorizeRemoteTunnelRequest'
  | 'bindRemoteTunnel'
  | 'confirmRemotePairing'
  | 'getRemoteAuditStore'
  | 'getRemoteDeviceSessions'
  | 'getRemoteDeviceStore'
  | 'getRemotePairing'
  | 'getRemoteTunnelSecret'
  | 'getRemoteTunnelStatus'
  | 'revokeRemoteDevice'
  | 'setRemoteEnabled'
  | 'setRemoteTunnelStatus'
>

export const createRuntimeStoreRemoteMethods = (
  services: RuntimeStoreServices
): RuntimeStoreRemoteMethods => {
  // Remote tunnel handle (M4). bindRemoteTunnel sets it in hive.ts after the tunnel is constructed;
  // a runtime that never builds a tunnel leaves it null and the revoke closed loop still rejects new
  // streams via the persistent provider.
  let remoteTunnel: RemoteTunnel | null = null
  let remoteTunnelStatus: TunnelStatus = 'disabled'
  // One flush loop at a time; triggers arriving mid-pass only re-arm a follow-up
  // pass (see flushPendingRevokes).
  let flushing = false
  let flushAgain = false
  const pendingRevokes: PendingRevokesStore = {
    getAppState: (key) => services.settings.getAppState(key),
    setAppState: (key, value) => services.settings.setAppState(key, value),
    transaction: (mutation) => services.db.transaction(mutation)(),
  }

  const tryGatewayRevoke = async (entry: PendingRevoke): Promise<boolean> => {
    const gatewayUrl = getPendingRevokeGateway(pendingRevokes)
    const daemonToken = services.settings.getAppState(REMOTE_DAEMON_TOKEN_KEY)?.value
    if (!gatewayUrl || !daemonToken || entry.gatewayUrl !== gatewayUrl) return false
    try {
      await postPairRevoke({ gatewayUrl, daemonToken }, entry.deviceId)
      return true
    } catch {
      return false
    }
  }

  // Serialized, fresh-read flush: each pass re-reads the queue and acks per-id
  // (removePendingRevoke), so a pass can never overwrite a newer queued revoke
  // with a stale snapshot — the pre-fix lost-update bug.
  const flushPendingRevokes = (): void => {
    if (services.isRuntimeClosing()) return
    if (flushing) {
      flushAgain = true
      return
    }
    flushing = true
    void (async () => {
      try {
        do {
          flushAgain = false
          for (const id of readPendingRevokes(pendingRevokes)) {
            if (services.isRuntimeClosing()) return
            const delivered = await tryGatewayRevoke(id)
            if (services.isRuntimeClosing()) return
            if (delivered) removePendingRevoke(pendingRevokes, id)
          }
        } while (flushAgain && !services.isRuntimeClosing())
      } catch (error) {
        // Failed persistence leaves the queue intact. Surface the failure; an
        // HTTP success followed by a DB error is not a transport outage.
        console.error('[hive] remote revoke queue flush failed', error)
      } finally {
        flushing = false
      }
    })()
  }

  return {
    authorizeRemoteTunnelRequest: (request) => services.uiAuth.isTunnelRequest(request),
    getRemoteTunnelSecret: () => services.uiAuth.getTunnelSecret(),
    getRemoteAuditStore: () => services.remoteAuditStore,
    getRemoteDeviceSessions: () => services.remoteDeviceSessions,
    getRemotePairing: () => services.remotePairing,
    confirmRemotePairing: async (pairingId, name) => {
      // D3: the tunnel driver owns the full confirm sequence (local row -> gateway /pair/confirm ->
      // `confirmed` to the phone). If no tunnel is bound, fall back to local-only confirm.
      if (remoteTunnel) return remoteTunnel.confirmPairing(pairingId, name)
      return services.remotePairing.confirmPairing(
        pairingId,
        name === undefined ? undefined : { name }
      )
    },
    getRemoteDeviceStore: () => services.remoteDeviceStore,
    getRemoteTunnelStatus: () => remoteTunnelStatus,
    setRemoteTunnelStatus: (status) => {
      remoteTunnelStatus = status
      if (status === 'online') flushPendingRevokes()
    },
    bindRemoteTunnel: (tunnel) => {
      remoteTunnel = tunnel
    },
    setRemoteEnabled: (enabled) => {
      services.settings.setAppState(REMOTE_ENABLED_KEY, enabled ? 'true' : 'false')
      // Reconcile the outbound socket against the new flag. No-op when no tunnel is bound.
      remoteTunnel?.refresh()
    },
    revokeRemoteDevice: (deviceId) => {
      // Persist the local revoke and retry obligation together, even when
      // credentials are temporarily absent. Unknown ids never enter the queue.
      const revoked = pendingRevokes.transaction(() => {
        const changed = services.remoteDeviceStore.revoke(deviceId)
        if (changed) addPendingRevoke(pendingRevokes, deviceId)
        return changed
      })
      remoteTunnel?.closeDevice(deviceId, 'revoked')
      if (revoked) {
        services.remoteAuditStore.enqueue({ action: 'revoke', deviceId, result: 'ok' })
      }
      flushPendingRevokes()
      return revoked
    },
  }
}
