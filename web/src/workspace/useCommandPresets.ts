import { useEffect, useRef, useState } from 'react'

import { type CommandPreset, listCommandPresets } from '../api.js'
import { useI18n } from '../i18n.js'

const DEFAULT_COMMAND_PRESET_ID = 'claude'

const chooseDefaultCommandPresetId = (presets: CommandPreset[]): string =>
  presets.some((preset) => preset.id === DEFAULT_COMMAND_PRESET_ID && preset.available)
    ? DEFAULT_COMMAND_PRESET_ID
    : (presets.find((preset) => preset.available)?.id ??
      presets[0]?.id ??
      DEFAULT_COMMAND_PRESET_ID)

export interface CommandPresetsState {
  commandPresets: CommandPreset[]
  commandPresetId: string
  commandPresetError: string | null
  onCommandPresetChange: (value: string) => void
}

/**
 * Loads the available CLI command presets and tracks the chosen one. Lifted out of
 * AddWorkspaceDialog so the mobile ServerBrowseAddWorkspace surface reuses the exact preset-selection
 * logic instead of forking it. Loads while `enabled` (the dialog is open); a load failure surfaces a
 * localized error and falls back to the default preset id.
 */
export const useCommandPresets = (enabled: boolean): CommandPresetsState => {
  const { t } = useI18n()
  const tRef = useRef(t)
  useEffect(() => {
    tRef.current = t
  }, [t])

  const [commandPresets, setCommandPresets] = useState<CommandPreset[]>([])
  const [commandPresetId, setCommandPresetId] = useState(DEFAULT_COMMAND_PRESET_ID)
  const [commandPresetError, setCommandPresetError] = useState<string | null>(null)
  const chosenIdRef = useRef(DEFAULT_COMMAND_PRESET_ID)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    setCommandPresetError(null)
    listCommandPresets()
      .then((presets) => {
        if (cancelled) return
        const keepCurrent = presets.some(
          (preset) => preset.id === chosenIdRef.current && preset.available
        )
        const nextId = keepCurrent ? chosenIdRef.current : chooseDefaultCommandPresetId(presets)
        chosenIdRef.current = nextId
        setCommandPresets(presets)
        setCommandPresetId(nextId)
      })
      .catch(() => {
        if (cancelled) return
        chosenIdRef.current = DEFAULT_COMMAND_PRESET_ID
        setCommandPresets([])
        setCommandPresetId(DEFAULT_COMMAND_PRESET_ID)
        setCommandPresetError(tRef.current('workspace.preset.loadFailed'))
      })
    return () => {
      cancelled = true
    }
  }, [enabled])

  const onCommandPresetChange = (value: string) => {
    chosenIdRef.current = value
    setCommandPresetId(value)
  }

  return { commandPresets, commandPresetId, commandPresetError, onCommandPresetChange }
}
