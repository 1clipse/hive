import { ImagePlus, RotateCcw } from 'lucide-react'
import { useRef, useState } from 'react'

import type { WorkerRole } from '../../../src/shared/types.js'
import {
  normalizeWorkerAvatar,
  WORKER_AVATAR_MAX_CHARS,
} from '../../../src/shared/worker-avatar.js'
import { useI18n } from '../i18n.js'
import { CliAgentAvatar } from './CliAgentAvatar.js'

const MAX_SOURCE_IMAGE_BYTES = 5 * 1024 * 1024
const OUTPUT_VARIANTS = [
  { quality: 0.86, size: 192, type: 'image/webp' },
  { quality: 0.78, size: 160, type: 'image/webp' },
  { quality: 0.76, size: 128, type: 'image/jpeg' },
] as const

type WorkerAvatarPickerProps = {
  avatar?: string | null
  commandPresetId?: string | undefined
  disabled?: boolean
  onChange: (avatar: string | null) => void
  workerRole: WorkerRole
  showStatus?: boolean
}

type AvatarFileMessages = {
  avatarTooLarge: string
  loadFailed: string
  notImage: string
  sourceTooLarge: string
}

const loadImage = (file: File, loadFailedMessage: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => {
      URL.revokeObjectURL(url)
      resolve(image)
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error(loadFailedMessage))
    }
    image.src = url
  })

const encodeAvatar = (image: HTMLImageElement, avatarTooLargeMessage: string): string => {
  const sourceSize = Math.min(image.naturalWidth, image.naturalHeight)
  const sourceX = Math.max(0, Math.floor((image.naturalWidth - sourceSize) / 2))
  const sourceY = Math.max(0, Math.floor((image.naturalHeight - sourceSize) / 2))
  let lastError: unknown = null
  for (const variant of OUTPUT_VARIANTS) {
    const canvas = document.createElement('canvas')
    canvas.width = variant.size
    canvas.height = variant.size
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Canvas is not available')
    context.drawImage(
      image,
      sourceX,
      sourceY,
      sourceSize,
      sourceSize,
      0,
      0,
      variant.size,
      variant.size
    )
    try {
      return normalizeWorkerAvatar(canvas.toDataURL(variant.type, variant.quality)) ?? ''
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error(avatarTooLargeMessage)
}

export const readWorkerAvatarFile = async (
  file: File,
  messages: AvatarFileMessages
): Promise<string> => {
  if (!file.type.startsWith('image/')) throw new Error(messages.notImage)
  if (file.size > MAX_SOURCE_IMAGE_BYTES) throw new Error(messages.sourceTooLarge)
  const image = await loadImage(file, messages.loadFailed)
  const avatar = encodeAvatar(image, messages.avatarTooLarge)
  if (avatar.length > WORKER_AVATAR_MAX_CHARS) throw new Error(messages.avatarTooLarge)
  return avatar
}

export const WorkerAvatarPicker = ({
  avatar,
  commandPresetId,
  disabled = false,
  onChange,
  workerRole,
  showStatus = false,
}: WorkerAvatarPickerProps) => {
  const { t } = useI18n()
  const inputRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [isDragging, setIsDragging] = useState(false)

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    if (disabled || loading) return
    setIsDragging(true)
  }

  const handleDragLeave = () => {
    setIsDragging(false)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    if (disabled || loading) return
    const file = e.dataTransfer.files?.[0]
    if (!file) return

    setLoading(true)
    setError(null)
    void readWorkerAvatarFile(file, {
      avatarTooLarge: t('worker.avatarTooLarge'),
      loadFailed: t('worker.avatarLoadFailed'),
      notImage: t('worker.avatarNotImage'),
      sourceTooLarge: t('worker.avatarSourceTooLarge'),
    })
      .then((nextAvatar) => onChange(nextAvatar))
      .catch((uploadError) => {
        setError(uploadError instanceof Error ? uploadError.message : String(uploadError))
      })
      .finally(() => setLoading(false))
  }

  return (
    <div className="worker-avatar-picker">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: drag and drop target container */}
      <div
        className="worker-avatar-picker__surface"
        data-dragging={isDragging || undefined}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <button
          type="button"
          className="group worker-avatar-picker__preview"
          disabled={disabled || loading}
          onClick={() => inputRef.current?.click()}
          aria-label={t('worker.avatarUpload')}
        >
          <CliAgentAvatar
            commandPresetId={commandPresetId}
            customAvatar={avatar}
            workerRole={workerRole}
            size={56}
          />
          <div className="worker-avatar-picker__preview-overlay">
            <ImagePlus size={16} />
          </div>
        </button>

        <div className="worker-avatar-picker__details">
          <div className="worker-avatar-picker__actions">
            <button
              type="button"
              className="icon-btn worker-avatar-picker__button"
              disabled={disabled || loading}
              onClick={() => inputRef.current?.click()}
            >
              <ImagePlus size={12} aria-hidden />
              {loading ? t('common.loading') : t('worker.avatarUpload')}
            </button>
            {avatar ? (
              <button
                type="button"
                className="icon-btn icon-btn--ghost worker-avatar-picker__button"
                disabled={disabled || loading}
                onClick={() => {
                  setError(null)
                  onChange(null)
                }}
              >
                <RotateCcw size={12} aria-hidden />
                {t('worker.avatarDefault')}
              </button>
            ) : null}

            {showStatus ? (
              <div className="worker-avatar-picker__status" data-custom={Boolean(avatar)}>
                <span className="worker-avatar-picker__status-dot" />
                <span>
                  {avatar ? t('worker.avatarUsingCustom') : t('worker.avatarUsingDefault')}
                </span>
              </div>
            ) : null}
          </div>

          <p className="worker-avatar-picker__help">{t('worker.avatarHelpText')}</p>

          <input
            ref={inputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            disabled={disabled || loading}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0]
              event.currentTarget.value = ''
              if (!file) return
              setLoading(true)
              setError(null)
              void readWorkerAvatarFile(file, {
                avatarTooLarge: t('worker.avatarTooLarge'),
                loadFailed: t('worker.avatarLoadFailed'),
                notImage: t('worker.avatarNotImage'),
                sourceTooLarge: t('worker.avatarSourceTooLarge'),
              })
                .then((nextAvatar) => onChange(nextAvatar))
                .catch((uploadError) => {
                  setError(uploadError instanceof Error ? uploadError.message : String(uploadError))
                })
                .finally(() => setLoading(false))
            }}
          />

          {error ? <span className="worker-avatar-picker__error">{error}</span> : null}
        </div>
      </div>
    </div>
  )
}
