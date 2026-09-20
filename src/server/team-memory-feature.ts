/**
 * Workspace memory total switch.
 *
 * Stored per workspace in app_state. Absent / any value other than "false"
 * reads as enabled so existing workspaces gain memory behavior by default.
 */

export const workspaceMemoryEnabledKey = (workspaceId: string) =>
  `workspace.${workspaceId}.memory.enabled`

export const workspaceMemoryDreamEnabledKey = (workspaceId: string) =>
  `workspace.${workspaceId}.memory.dream.enabled`

export const readWorkspaceMemoryEnabled = (raw: string | null | undefined): boolean =>
  raw !== 'false'

export const serializeWorkspaceMemoryEnabled = (enabled: boolean): string =>
  enabled ? 'true' : 'false'

export const readWorkspaceMemoryDreamEnabled = (raw: string | null | undefined): boolean =>
  raw !== 'false'

export const serializeWorkspaceMemoryDreamEnabled = (enabled: boolean): string =>
  enabled ? 'true' : 'false'
