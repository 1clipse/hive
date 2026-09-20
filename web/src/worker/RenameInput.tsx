import { type KeyboardEvent, useEffect, useRef, useState } from 'react'
import { useToast } from '../ui/useToast.js'

interface RenameInputProps {
  initialValue: string
  saving: boolean
  setSaving: (saving: boolean) => void
  onSave: (newName: string) => Promise<{ error: string | null }>
  onCancel: () => void
  className?: string
}

export const RenameInput = ({
  initialValue,
  saving,
  setSaving,
  onSave,
  onCancel,
  className,
}: RenameInputProps) => {
  const toast = useToast()
  const [draft, setDraft] = useState(initialValue)
  const inputRef = useRef<HTMLInputElement>(null)
  const isCancelling = useRef(false)

  useEffect(() => {
    // Auto focus and select on mount
    const timer = setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 50)
    return () => clearTimeout(timer)
  }, [])

  const handleSave = async () => {
    const trimmed = draft.trim()
    if (!trimmed || trimmed === initialValue) {
      onCancel()
      return
    }
    setSaving(true)
    try {
      const res = await onSave(trimmed)
      if (res.error) {
        toast.show({ kind: 'error', message: res.error })
        setDraft(initialValue)
        // Reset and keep editing on error
        setTimeout(() => {
          inputRef.current?.focus()
          inputRef.current?.select()
        }, 50)
        setSaving(false)
        return
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to rename worker'
      toast.show({ kind: 'error', message: msg })
      setDraft(initialValue)
      setTimeout(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      }, 50)
      setSaving(false)
      return
    }
    setSaving(false)
    onCancel()
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // Stop event propagation to avoid triggering top-level hotkeys
    e.stopPropagation()
    if (e.key === 'Enter') {
      e.preventDefault()
      void handleSave()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      isCancelling.current = true
      onCancel()
    }
  }

  const handleBlur = () => {
    if (isCancelling.current) return
    void handleSave()
  }

  return (
    <input
      ref={inputRef}
      type="text"
      value={draft}
      disabled={saving}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={handleKeyDown}
      onBlur={handleBlur}
      maxLength={64}
      className={className}
      onClick={(e) => e.stopPropagation()}
    />
  )
}
