import * as Dialog from '@radix-ui/react-dialog'
import { Sparkles } from 'lucide-react'

import { useI18n } from '../i18n.js'
import type { ChangelogEntry } from './changelog.js'

type WhatsNewDialogProps = {
  open: boolean
  entries: ChangelogEntry[]
  onClose: () => void
}

export const WhatsNewDialog = ({ open, entries, onClose }: WhatsNewDialogProps) => {
  const { t, language } = useI18n()

  const handleOpenChange = (isOpen: boolean) => {
    if (!isOpen) onClose()
  }

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="app-overlay fixed inset-0 z-40" />
        <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center p-4">
          <Dialog.Content
            aria-label={t('whatsNew.title')}
            className="dialog-scale-pop elev-2 pointer-events-auto flex max-h-[calc(100vh-64px)] w-[480px] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-lg border"
            style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border-bright)' }}
          >
            <div className="flex shrink-0 items-center gap-3 px-6 pt-6">
              <div
                aria-hidden
                className="flex h-10 w-10 items-center justify-center rounded-lg"
                style={{
                  background: 'color-mix(in oklab, var(--accent) 15%, transparent)',
                  color: 'var(--accent)',
                  border: '1px solid color-mix(in oklab, var(--accent) 30%, transparent)',
                }}
              >
                <Sparkles size={20} />
              </div>
              <div>
                <Dialog.Title className="text-lg font-semibold text-pri">
                  {t('whatsNew.title')}
                </Dialog.Title>
                <Dialog.Description className="text-xs text-ter">
                  {t('whatsNew.subtitle')}
                </Dialog.Description>
              </div>
            </div>

            <div className="scroll-y mx-6 mt-4 flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto pr-3">
              {entries.map((release) => {
                const lines = language === 'zh' ? release.zh : release.en
                return (
                  <section key={release.version} className="flex flex-col gap-2">
                    <div className="flex items-baseline gap-2">
                      <span className="text-sm font-medium text-pri">
                        {t('whatsNew.versionLabel', { version: release.version })}
                      </span>
                      <span className="text-xs text-ter">{release.date}</span>
                    </div>
                    <ul className="flex flex-col gap-1.5">
                      {lines.map((line) => (
                        <li key={line} className="flex items-start gap-2 text-sm text-sec">
                          <span
                            aria-hidden
                            className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-accent"
                          />
                          <span>{line}</span>
                        </li>
                      ))}
                    </ul>
                  </section>
                )
              })}
            </div>

            <div
              className="flex shrink-0 justify-end border-t px-6 py-5"
              style={{ borderColor: 'var(--border)' }}
            >
              <button
                type="button"
                onClick={onClose}
                className="icon-btn icon-btn--primary justify-center"
              >
                {t('whatsNew.gotIt')}
              </button>
            </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
