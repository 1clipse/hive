import { type KeyboardEvent, type MouseEvent, useCallback, useEffect, useState } from 'react'

const STORAGE_KEY = 'hive.workspace-sidebar.width'
export const WORKSPACE_SIDEBAR_MIN = 56
export const WORKSPACE_SIDEBAR_MAX = 280
const WORKSPACE_SIDEBAR_DEFAULT = WORKSPACE_SIDEBAR_MIN
const KEYBOARD_STEP = 16

// The expand/collapse toggle snaps between two presets. Collapsed is the
// icon-only minimum; expanded is wide enough that workspace names and the
// per-row delete button are visible (both hide under the 96px container
// query in globals.css). Dragging the handle is unchanged and still spans
// the full MIN..MAX range — the toggle just offers a discoverable shortcut.
export const WORKSPACE_SIDEBAR_EXPANDED = 240
const WORKSPACE_SIDEBAR_COLLAPSE_MAX = 96

const clamp = (value: number): number =>
  Math.min(WORKSPACE_SIDEBAR_MAX, Math.max(WORKSPACE_SIDEBAR_MIN, value))

const readStoredWidth = (): number => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return WORKSPACE_SIDEBAR_DEFAULT
    const parsed = Number.parseInt(raw, 10)
    return Number.isFinite(parsed) ? clamp(parsed) : WORKSPACE_SIDEBAR_DEFAULT
  } catch {
    return WORKSPACE_SIDEBAR_DEFAULT
  }
}

export const useWorkspaceSidebarResize = () => {
  const [width, setWidth] = useState(readStoredWidth)
  const [resizing, setResizing] = useState(false)

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, String(Math.round(width)))
    } catch {
      // localStorage can be unavailable in private mode; width still works in-memory.
    }
  }, [width])

  const beginResize = useCallback(
    (event: MouseEvent<HTMLHRElement>) => {
      event.preventDefault()
      const startX = event.clientX
      const startWidth = width
      setResizing(true)

      const previousCursor = document.body.style.cursor
      const previousUserSelect = document.body.style.userSelect
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'

      const handleMove = (moveEvent: globalThis.MouseEvent) => {
        setWidth(clamp(startWidth + moveEvent.clientX - startX))
      }
      const handleUp = () => {
        setResizing(false)
        document.body.style.cursor = previousCursor
        document.body.style.userSelect = previousUserSelect
        document.removeEventListener('mousemove', handleMove)
        document.removeEventListener('mouseup', handleUp)
      }

      document.addEventListener('mousemove', handleMove)
      document.addEventListener('mouseup', handleUp)
    },
    [width]
  )

  const collapsed = width <= WORKSPACE_SIDEBAR_COLLAPSE_MAX

  const toggleCollapsed = useCallback(() => {
    setWidth((current) =>
      current <= WORKSPACE_SIDEBAR_COLLAPSE_MAX ? WORKSPACE_SIDEBAR_EXPANDED : WORKSPACE_SIDEBAR_MIN
    )
  }, [])

  const onResizeKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      setWidth((current) => clamp(current - KEYBOARD_STEP))
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      setWidth((current) => clamp(current + KEYBOARD_STEP))
    } else if (event.key === 'Home') {
      event.preventDefault()
      setWidth(WORKSPACE_SIDEBAR_MIN)
    } else if (event.key === 'End') {
      event.preventDefault()
      setWidth(WORKSPACE_SIDEBAR_MAX)
    }
  }, [])

  return { beginResize, collapsed, onResizeKeyDown, resizing, toggleCollapsed, width }
}

export type WorkspaceSidebarResize = ReturnType<typeof useWorkspaceSidebarResize>
