import { useCallback, useEffect, useRef, useState } from 'react'

import { getApiTransport, getWorkspaceTasks, saveWorkspaceTasks } from '../api.js'
import type { TransportSocket } from '../transport/api-transport.js'
import {
  appendChildTaskAtLine,
  appendTaskToContent,
  deleteTaskLine,
  toggleTaskLine,
  updateTaskTextAtLine,
} from './task-markdown.js'

const shouldIgnoreRemoteUpdate = (
  nextContent: string,
  savedContent: string,
  currentContent: string
) => nextContent === savedContent || nextContent === currentContent

export const useTasksFile = (workspaceId: string | null, demoContent?: string) => {
  const [content, setContent] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [hasConflict, setHasConflict] = useState(false)
  const [remoteContent, setRemoteContent] = useState<string | null>(null)
  const dirtyRef = useRef(false)
  const savedContentRef = useRef('')
  const contentRef = useRef('')

  const applyRemoteContent = useCallback((nextContent: string, currentContent: string) => {
    if (!dirtyRef.current) {
      savedContentRef.current = nextContent
      contentRef.current = nextContent
      setContent(nextContent)
      setHasConflict(false)
      setRemoteContent(null)
      return
    }
    if (shouldIgnoreRemoteUpdate(nextContent, savedContentRef.current, currentContent)) {
      return
    }
    setRemoteContent(nextContent)
    setHasConflict(true)
  }, [])

  useEffect(() => {
    if (!workspaceId) {
      setContent('')
      setLoaded(false)
      setHasConflict(false)
      setRemoteContent(null)
      dirtyRef.current = false
      savedContentRef.current = ''
      contentRef.current = ''
      return
    }
    let cancelled = false
    setContent('')
    setLoaded(false)
    setHasConflict(false)
    setRemoteContent(null)
    dirtyRef.current = false
    savedContentRef.current = ''
    contentRef.current = ''
    void getWorkspaceTasks(workspaceId)
      .then(({ content: nextContent }) => {
        if (cancelled) return
        savedContentRef.current = nextContent
        dirtyRef.current = false
        contentRef.current = nextContent
        setContent(nextContent)
        setLoaded(true)
        setHasConflict(false)
        setRemoteContent(null)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        savedContentRef.current = ''
        dirtyRef.current = false
        contentRef.current = ''
        setContent('')
        setLoaded(true)
        setHasConflict(false)
        console.error('[hive] swallowed:tasks.initialLoad', error)
        setRemoteContent(null)
      })
    return () => {
      cancelled = true
    }
  }, [workspaceId])

  useEffect(() => {
    if (!workspaceId) return
    let closed = false
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let attempt = 0
    // Track the live socket so cleanup can close it even when the ref lives in openSocket's scope.
    let activeSocket: TransportSocket | null = null

    const openSocket = (): void => {
      if (closed) return
      const socket = getApiTransport().openWebSocket(`/ws/tasks/${workspaceId}`)
      activeSocket = socket
      socket.onmessage = (event) => {
        if (closed) return
        // The tasks channel is text-only (JSON snapshots); coerce since the transport socket's
        // message type is the broader string | binary union.
        const payload = JSON.parse(String(event.data)) as { content?: string; type: string }
        if (payload.type !== 'tasks-snapshot' && payload.type !== 'tasks-updated') return
        if (typeof payload.content !== 'string') return
        attempt = 0
        applyRemoteContent(payload.content, contentRef.current)
      }
      socket.onclose = () => {
        if (closed) return
        // Capped exponential backoff: 500ms, 1s, 2s, 4s … up to 30s.
        attempt += 1
        const delay = Math.min(30_000, 500 * 2 ** (attempt - 1))
        retryTimer = setTimeout(openSocket, delay)
      }
    }

    openSocket()
    return () => {
      closed = true
      if (retryTimer !== null) {
        clearTimeout(retryTimer)
        retryTimer = null
      }
      activeSocket?.close()
    }
  }, [applyRemoteContent, workspaceId])

  // Demo short-circuit: all hooks have run above; now return static fixture data.
  // workspaceId is null when demoContent is provided, so no server calls were made.
  if (demoContent !== undefined) {
    return {
      content: demoContent,
      hasConflict: false,
      loaded: true,
      onChange: (_value: string) => {},
      onKeepLocal: () => {},
      onReload: () => {},
      onSave: async () => {},
      toggleTaskAtLine: async (_lineIndex: number) => {},
      appendTask: async (_text: string) => {},
      appendSubtask: async (_parentLine: number, _text: string) => {},
      updateTaskText: async (_lineIndex: number, _nextText: string) => {},
      deleteTask: async (_lineIndex: number) => {},
    }
  }

  const persistTransform = async (
    transform: (current: string) => string,
    operationLabel: string
  ) => {
    if (!workspaceId) return
    const previous = contentRef.current
    const next = transform(previous)
    if (next === previous) return
    savedContentRef.current = next
    contentRef.current = next
    dirtyRef.current = false
    setContent(next)
    try {
      const response = await saveWorkspaceTasks(workspaceId, { content: next })
      savedContentRef.current = response.content
      contentRef.current = response.content
      setContent(response.content)
    } catch (error) {
      savedContentRef.current = previous
      contentRef.current = previous
      setContent(previous)
      console.error(`[hive] swallowed:tasks.${operationLabel}`, error)
      throw error
    }
  }

  return {
    content,
    hasConflict,
    loaded,
    onChange: (value: string) => {
      dirtyRef.current = value !== savedContentRef.current
      contentRef.current = value
      setContent(value)
    },
    onKeepLocal: () => {
      setHasConflict(false)
      setRemoteContent(null)
    },
    onReload: () => {
      const nextContent = remoteContent ?? savedContentRef.current
      savedContentRef.current = nextContent
      dirtyRef.current = false
      contentRef.current = nextContent
      setContent(nextContent)
      setHasConflict(false)
      setRemoteContent(null)
    },
    onSave: async () => {
      if (!workspaceId) return
      const response = await saveWorkspaceTasks(workspaceId, { content })
      savedContentRef.current = response.content
      dirtyRef.current = false
      contentRef.current = response.content
      setContent(response.content)
      setHasConflict(false)
      setRemoteContent(null)
    },
    toggleTaskAtLine: async (lineIndex: number) => {
      if (!workspaceId) return
      const previous = contentRef.current
      const next = toggleTaskLine(previous, lineIndex)
      if (next === previous) return
      savedContentRef.current = next
      contentRef.current = next
      dirtyRef.current = false
      setContent(next)
      try {
        const response = await saveWorkspaceTasks(workspaceId, { content: next })
        savedContentRef.current = response.content
        contentRef.current = response.content
        setContent(response.content)
      } catch (error) {
        savedContentRef.current = previous
        contentRef.current = previous
        setContent(previous)
        throw error
      }
    },
    appendTask: async (text: string) => {
      const trimmed = text.trim()
      if (!workspaceId || !trimmed) return
      const previous = contentRef.current
      const next = appendTaskToContent(previous, trimmed)
      savedContentRef.current = next
      contentRef.current = next
      dirtyRef.current = false
      setContent(next)
      try {
        const response = await saveWorkspaceTasks(workspaceId, { content: next })
        savedContentRef.current = response.content
        contentRef.current = response.content
        setContent(response.content)
      } catch (error) {
        savedContentRef.current = previous
        contentRef.current = previous
        setContent(previous)
        throw error
      }
    },
    appendSubtask: async (parentLine: number, text: string) => {
      const trimmed = text.trim()
      if (!trimmed) return
      await persistTransform(
        (current) => appendChildTaskAtLine(current, parentLine, trimmed),
        'appendSubtask'
      )
    },
    updateTaskText: async (lineIndex: number, nextText: string) => {
      const trimmed = nextText.trim()
      if (!trimmed) return
      await persistTransform(
        (current) => updateTaskTextAtLine(current, lineIndex, trimmed),
        'updateTaskText'
      )
    },
    deleteTask: async (lineIndex: number) => {
      await persistTransform((current) => deleteTaskLine(current, lineIndex), 'deleteTask')
    },
  }
}
