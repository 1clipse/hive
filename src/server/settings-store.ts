import { type AppStateRecord, type AppStateValue, createAppStateStore } from './app-state-store.js'
import {
  type CommandPresetInput,
  type CommandPresetRecord,
  createCommandPresetStore,
} from './command-preset-store.js'
import {
  createRoleTemplateStore,
  type RoleTemplateInput,
  type RoleTemplateRecord,
} from './role-template-store.js'
import type { Database } from './sqlite.js'

export interface SettingsStore {
  createCommandPreset: (input: CommandPresetInput) => CommandPresetRecord
  createRoleTemplate: (input: RoleTemplateInput) => RoleTemplateRecord
  deleteCommandPreset: (id: string) => void
  deleteRoleTemplate: (id: string) => void
  /** TIER 2 #4 — workflow runner uses this to resolve a non-built-in
   *  agentType against the user's curated role library. */
  findRoleTemplateByName: (name: string) => RoleTemplateRecord | undefined
  getAppState: (key: string) => AppStateRecord | undefined
  getCommandPreset: (id: string) => CommandPresetRecord | undefined
  listCommandPresets: () => CommandPresetRecord[]
  listRoleTemplates: () => RoleTemplateRecord[]
  setAppState: (key: string, value: AppStateValue) => void
  updateCommandPreset: (id: string, input: CommandPresetInput) => CommandPresetRecord
  updateRoleTemplate: (id: string, input: RoleTemplateInput) => RoleTemplateRecord
}

export type {
  AppStateRecord,
  AppStateValue,
  CommandPresetInput,
  CommandPresetRecord,
  RoleTemplateInput,
  RoleTemplateRecord,
}

export const createSettingsStore = (db: Database): SettingsStore => {
  const appStateStore = createAppStateStore(db)
  const commandPresetStore = createCommandPresetStore(db)
  const roleTemplateStore = createRoleTemplateStore(db)

  return {
    createCommandPreset: commandPresetStore.create,
    createRoleTemplate: roleTemplateStore.create,
    deleteCommandPreset: commandPresetStore.remove,
    deleteRoleTemplate: roleTemplateStore.remove,
    findRoleTemplateByName: roleTemplateStore.findByName,
    getAppState: appStateStore.get,
    getCommandPreset: commandPresetStore.get,
    listCommandPresets: commandPresetStore.list,
    listRoleTemplates: roleTemplateStore.list,
    setAppState: appStateStore.set,
    updateCommandPreset: commandPresetStore.update,
    updateRoleTemplate: roleTemplateStore.update,
  }
}
