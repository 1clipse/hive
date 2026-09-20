import type { BuildMemoryDiagnosticsInput, MemoryDiagnostics } from './team-memory-diagnostics.js'
import type {
  AddMemoryEntryInput,
  LogMemoryInjectionsInput,
  MemoryEntryWithSources,
  MemoryInjectionWithMemory,
  MemoryListOptions,
  MemorySearchOptions,
  MemorySearchResult,
} from './team-memory-store.js'

interface RuntimeStoreMemoryServices {
  teamMemoryExport: {
    schedule: (workspaceId: string) => void
  }
  teamMemoryDiagnostics: {
    build: (input: BuildMemoryDiagnosticsInput) => MemoryDiagnostics
  }
  teamMemoryStore: {
    addEntry: (input: AddMemoryEntryInput) => MemoryEntryWithSources
    approveCandidate: (workspaceId: string, memoryId: string) => MemoryEntryWithSources
    archiveEntry: (workspaceId: string, memoryId: string) => MemoryEntryWithSources
    getEntryWithSources: (
      workspaceId: string,
      memoryId: string
    ) => MemoryEntryWithSources | undefined
    listEntries: (workspaceId: string, options?: MemoryListOptions) => MemoryEntryWithSources[]
    listInjections: (workspaceId: string, limit?: number) => MemoryInjectionWithMemory[]
    listInjectionsForDispatch: (
      workspaceId: string,
      dispatchId: string
    ) => MemoryInjectionWithMemory[]
    logInjections: (input: LogMemoryInjectionsInput) => string[]
    rejectCandidate: (workspaceId: string, memoryId: string) => MemoryEntryWithSources
    searchEntries: (
      workspaceId: string,
      query: string,
      options?: MemorySearchOptions
    ) => MemorySearchResult[]
    setDisabled: (
      workspaceId: string,
      memoryId: string,
      disabled: boolean
    ) => MemoryEntryWithSources
    setPinned: (workspaceId: string, memoryId: string, pinned: boolean) => MemoryEntryWithSources
  }
}

export const createRuntimeStoreMemoryMethods = (services: RuntimeStoreMemoryServices) => ({
  addMemoryEntry(input: AddMemoryEntryInput) {
    const memory = services.teamMemoryStore.addEntry(input)
    services.teamMemoryExport.schedule(input.workspaceId)
    return memory
  },
  approveMemoryCandidate(workspaceId: string, memoryId: string) {
    const memory = services.teamMemoryStore.approveCandidate(workspaceId, memoryId)
    services.teamMemoryExport.schedule(workspaceId)
    return memory
  },
  archiveMemoryEntry(workspaceId: string, memoryId: string) {
    const memory = services.teamMemoryStore.archiveEntry(workspaceId, memoryId)
    services.teamMemoryExport.schedule(workspaceId)
    return memory
  },
  getMemoryEntry: (workspaceId: string, memoryId: string) =>
    services.teamMemoryStore.getEntryWithSources(workspaceId, memoryId),
  listMemoryEntries: (workspaceId: string, options?: MemoryListOptions) =>
    services.teamMemoryStore.listEntries(workspaceId, options),
  getMemoryDiagnostics: (input: BuildMemoryDiagnosticsInput) =>
    services.teamMemoryDiagnostics.build(input),
  listMemoryInjectionsForDispatch: (workspaceId: string, dispatchId: string) =>
    services.teamMemoryStore.listInjectionsForDispatch(workspaceId, dispatchId),
  logMemoryInjections: (input: LogMemoryInjectionsInput) =>
    services.teamMemoryStore.logInjections(input),
  rejectMemoryCandidate(workspaceId: string, memoryId: string) {
    const memory = services.teamMemoryStore.rejectCandidate(workspaceId, memoryId)
    services.teamMemoryExport.schedule(workspaceId)
    return memory
  },
  searchMemoryEntries: (workspaceId: string, query: string, options?: MemorySearchOptions) =>
    services.teamMemoryStore.searchEntries(workspaceId, query, options),
  setMemoryDisabled(workspaceId: string, memoryId: string, disabled: boolean) {
    const memory = services.teamMemoryStore.setDisabled(workspaceId, memoryId, disabled)
    services.teamMemoryExport.schedule(workspaceId)
    return memory
  },
  setMemoryPinned(workspaceId: string, memoryId: string, pinned: boolean) {
    const memory = services.teamMemoryStore.setPinned(workspaceId, memoryId, pinned)
    services.teamMemoryExport.schedule(workspaceId)
    return memory
  },
})
