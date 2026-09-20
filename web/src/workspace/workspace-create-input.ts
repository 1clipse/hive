export interface WorkspaceCreateInput {
  controllerMode?: 'internal' | 'codex_app'
  commandPresetId: string | null
  name: string
  path: string
  startupCommand?: string
}
