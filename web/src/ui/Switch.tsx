/**
 * A premium toggle switch component that replaces native checkboxes in settings.
 * Follows the Twenty/Hive design language with smooth transitions and proper
 * touch targets for mobile.
 */

interface SwitchProps {
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
  'data-testid'?: string
  'aria-label'?: string
}

export const Switch = ({ checked, disabled, onChange, ...rest }: SwitchProps) => {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={rest['aria-label']}
      disabled={disabled}
      className="settings-switch"
      data-checked={checked || undefined}
      data-testid={rest['data-testid']}
      onClick={(e) => {
        e.stopPropagation()
        onChange(!checked)
      }}
    >
      <span className="settings-switch__thumb" />
    </button>
  )
}
