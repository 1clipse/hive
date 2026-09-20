import {
  buildDreamPrompt,
  DREAM_PROMPT_MEMORY_LIMIT,
  DREAM_PROMPT_MESSAGE_LIMIT,
} from './team-memory-dream-prompt.js'
import type { DreamMessageInput, DreamRunRecord } from './team-memory-dream-store.js'
import type { MemoryEntryWithSources } from './team-memory-store.js'

export interface MemoryDreamInput {
  prompt: string
  run: DreamRunRecord
}

export interface MemoryDreamInputServices {
  teamMemoryDreamStore: {
    listInputMessages: (
      workspaceId: string,
      from: number | null,
      to: number | null
    ) => DreamMessageInput[]
  }
  teamMemoryStore: {
    listAllEntries: (workspaceId: string) => MemoryEntryWithSources[]
  }
}

export const buildMemoryDreamInput = (
  services: MemoryDreamInputServices,
  workspaceId: string,
  run: DreamRunRecord
): MemoryDreamInput => {
  const messages = services.teamMemoryDreamStore
    .listInputMessages(workspaceId, run.inputSeqFrom, run.inputSeqTo)
    .slice(-DREAM_PROMPT_MESSAGE_LIMIT)
  const memories = services.teamMemoryStore
    .listAllEntries(workspaceId)
    .filter((memory) => memory.status === 'active' && memory.updatedAt <= run.startedAt)
    .slice(0, DREAM_PROMPT_MEMORY_LIMIT)
  return {
    prompt: buildDreamPrompt({ memories, messages, workspaceId }),
    run,
  }
}
