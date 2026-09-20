import { queryCollaborationMetrics } from './collaboration-metrics.js'
import type { RuntimeStore } from './runtime-store-contract.js'
import type { RuntimeStoreServices } from './runtime-store-helpers.js'

type RuntimeStoreDiagnosticsMethods = Pick<
  RuntimeStore,
  'getCollaborationMetrics' | 'getRetentionSignals'
>

export const createRuntimeStoreDiagnosticsMethods = (
  services: RuntimeStoreServices
): RuntimeStoreDiagnosticsMethods => ({
  getCollaborationMetrics: (workspaceId, windowDays) =>
    queryCollaborationMetrics(services.db, workspaceId, windowDays),
  getRetentionSignals: () => services.protocolEventStats.getRetentionSignals(),
})
