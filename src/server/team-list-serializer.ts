import type {
  TeamListItem,
  TeamListItemPayload,
  TeamListOpenDispatchPayload,
} from '../shared/types.js'

type SerializeTeamListItemOptions = {
  includeAvatar?: boolean
}

export const serializeTeamListItem = (
  {
    avatar,
    commandPresetId,
    configuredCommand,
    configuredModel,
    description,
    ephemeral,
    id,
    lastPtyLine,
    name,
    pendingTaskCount,
    role,
    spawnedBy,
    startupReadyAt,
    status,
  }: TeamListItem,
  openDispatches?: TeamListOpenDispatchPayload[],
  options: SerializeTeamListItemOptions = {}
): TeamListItemPayload => ({
  id,
  name,
  role,
  status,
  pending_task_count: pendingTaskCount,
  ...(description !== undefined ? { description } : {}),
  ...(configuredCommand !== undefined ? { configured_command: configuredCommand } : {}),
  ...(configuredModel !== undefined ? { configured_model: configuredModel } : {}),
  ...(options.includeAvatar === true && avatar ? { avatar } : {}),
  last_pty_line: lastPtyLine ?? null,
  command_preset_id: commandPresetId ?? null,
  startup_ready_at: startupReadyAt ?? null,
  ...(ephemeral === true ? { ephemeral: true } : {}),
  ...(spawnedBy ? { spawned_by: spawnedBy } : {}),
  ...(openDispatches && openDispatches.length > 0 ? { open_dispatches: openDispatches } : {}),
})
