import * as Dialog from '@radix-ui/react-dialog'
import { BookOpenCheck, FileText, Hammer, Sparkles } from 'lucide-react'
import { type ReactNode, useState } from 'react'

import {
  SCENARIO_PRESETS,
  type ScenarioId,
  type ScenarioPreset,
} from '../../../src/shared/scenario-presets.js'
import { applyScenarioTeam } from '../api.js'
import { type TranslationKey, useI18n } from '../i18n.js'
import { useToast } from '../ui/useToast.js'

type ScenarioTeamCardsProps = {
  workspaceId: string
}

const SCENARIO_TEXT: Record<
  ScenarioId,
  { descKey: TranslationKey; icon: ReactNode; titleKey: TranslationKey }
> = {
  build_review_test: {
    icon: <Hammer size={16} aria-hidden />,
    titleKey: 'scenario.build_review_test.title',
    descKey: 'scenario.build_review_test.desc',
  },
  research_factcheck: {
    icon: <BookOpenCheck size={16} aria-hidden />,
    titleKey: 'scenario.research_factcheck.title',
    descKey: 'scenario.research_factcheck.desc',
  },
  docs_pipeline: {
    icon: <FileText size={16} aria-hidden />,
    titleKey: 'scenario.docs_pipeline.title',
    descKey: 'scenario.docs_pipeline.desc',
  },
}

/**
 * One-click team assembly cards, shown while a workspace has no workers yet.
 * Picking a card opens a goal dialog prefilled with the scenario's template;
 * applying creates the preset workers server-side and hands the goal to the
 * orchestrator. The cards vanish on their own once the workers poll updates.
 */
export const ScenarioTeamCards = ({ workspaceId }: ScenarioTeamCardsProps) => {
  const { language, t } = useI18n()
  const toast = useToast()
  const [active, setActive] = useState<ScenarioPreset | null>(null)
  const [goal, setGoal] = useState('')
  const [applying, setApplying] = useState(false)

  const openScenario = (preset: ScenarioPreset) => {
    setGoal(preset.goalTemplate[language])
    setActive(preset)
  }

  const close = () => {
    if (applying) return
    setActive(null)
  }

  const apply = () => {
    if (!active || applying || !goal.trim()) return
    setApplying(true)
    void applyScenarioTeam(workspaceId, active.id, goal, language)
      .then(() => {
        toast.show({ kind: 'success', message: t('scenario.applied') })
        setActive(null)
      })
      .catch((error: unknown) => {
        toast.show({
          kind: 'error',
          message: error instanceof Error ? error.message : String(error),
        })
      })
      .finally(() => setApplying(false))
  }

  return (
    <div className="mx-auto mt-6 w-full max-w-[420px]" data-testid="scenario-team-cards">
      <div className="mb-2 flex items-center justify-center gap-1.5 text-xs font-medium uppercase tracking-wide text-ter">
        <Sparkles size={12} aria-hidden />
        {t('scenario.sectionTitle')}
      </div>
      <div className="flex flex-col gap-2">
        {SCENARIO_PRESETS.map((preset) => {
          const text = SCENARIO_TEXT[preset.id]
          return (
            <button
              key={preset.id}
              type="button"
              onClick={() => openScenario(preset)}
              className="rounded border bg-1 p-3 text-left transition-colors hover:bg-3"
              style={{ borderColor: 'var(--border)' }}
              data-testid={`scenario-card-${preset.id}`}
            >
              <div className="flex items-center gap-2 text-pri">
                {text.icon}
                <span className="text-sm font-medium">{t(text.titleKey)}</span>
              </div>
              <div className="mt-1 text-xs text-ter">{t(text.descKey)}</div>
            </button>
          )
        })}
      </div>

      <Dialog.Root
        open={active !== null}
        onOpenChange={(open) => {
          if (!open) close()
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="app-overlay fixed inset-0 z-[60]" />
          <div className="pointer-events-none fixed inset-0 z-[70] grid place-items-center p-4">
            <Dialog.Content
              data-testid="scenario-goal-dialog"
              className="dialog-scale-pop elev-2 pointer-events-auto w-[480px] max-w-[calc(100vw-32px)] rounded-lg border p-5"
              style={{
                background: 'var(--bg-elevated)',
                borderColor: 'var(--border-bright)',
              }}
              onEscapeKeyDown={(event) => {
                if (applying) event.preventDefault()
              }}
              onPointerDownOutside={(event) => {
                if (applying) event.preventDefault()
              }}
            >
              <Dialog.Title className="text-lg font-semibold text-pri">
                {active ? t(SCENARIO_TEXT[active.id].titleKey) : ''}
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-xs text-ter">
                {t('scenario.goalHint')}
              </Dialog.Description>
              <label className="mt-4 block">
                <span className="mb-1 block text-xs font-medium text-sec">
                  {t('scenario.goalLabel')}
                </span>
                <textarea
                  value={goal}
                  onChange={(event) => setGoal(event.target.value)}
                  rows={5}
                  className="w-full resize-y rounded border bg-1 p-2 text-sm text-pri outline-none focus:border-[var(--accent)]"
                  style={{ borderColor: 'var(--border)' }}
                  disabled={applying}
                  data-testid="scenario-goal-input"
                />
              </label>
              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  className="icon-btn"
                  onClick={close}
                  disabled={applying}
                  data-testid="scenario-goal-cancel"
                >
                  {t('scenario.cancel')}
                </button>
                <button
                  type="button"
                  className="icon-btn icon-btn--primary disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={apply}
                  disabled={applying || !goal.trim()}
                  data-testid="scenario-goal-apply"
                >
                  {applying ? t('scenario.applying') : t('scenario.apply')}
                </button>
              </div>
            </Dialog.Content>
          </div>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  )
}
