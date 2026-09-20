import { MessageSquare, Terminal } from 'lucide-react'
import { useId } from 'react'

import { useI18n } from '../i18n.js'

export const ControllerModeSelect = ({
  value,
  onChange,
}: {
  value: 'internal' | 'codex_app'
  onChange: (value: 'internal' | 'codex_app') => void
}) => {
  const { t } = useI18n()
  const groupId = useId()
  return (
    <fieldset className="min-w-0 text-sm text-sec">
      <legend className="mb-2 font-medium text-pri">{t('controller.mode')}</legend>
      <div className="flex flex-col gap-2">
        {(['internal', 'codex_app'] as const).map((mode) => {
          const selected = value === mode
          const Icon = mode === 'internal' ? Terminal : MessageSquare
          const hintId = `${groupId}-${mode}-hint`
          return (
            <label
              key={mode}
              className="flex min-h-16 cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors hover:bg-2 focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--accent)]"
              style={{
                borderColor: selected ? 'var(--accent)' : 'var(--border)',
                background: selected ? 'var(--bg-2)' : undefined,
              }}
            >
              <input
                type="radio"
                name={groupId}
                value={mode}
                checked={selected}
                onChange={() => onChange(mode)}
                aria-describedby={hintId}
                className="h-4 w-4 shrink-0 accent-[var(--accent)]"
              />
              <Icon size={18} aria-hidden className="shrink-0 text-sec" />
              <span className="min-w-0">
                <span className="block font-medium text-pri">
                  {mode === 'internal' ? t('controller.internal') : 'Codex App'}
                </span>
                <span id={hintId} className="mt-0.5 block text-xs leading-relaxed text-sec">
                  {t(mode === 'internal' ? 'controller.internalHint' : 'controller.externalHint')}
                </span>
              </span>
            </label>
          )
        })}
      </div>
      {value === 'codex_app' && (
        <p className="mt-2 text-xs leading-relaxed text-sec">{t('controller.createHint')}</p>
      )}
    </fieldset>
  )
}
