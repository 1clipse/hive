import {
  Code2,
  Crown,
  FlaskConical,
  type LucideIcon,
  SearchCheck,
  SlidersHorizontal,
} from 'lucide-react'

import type { WorkerRole } from '../../../src/shared/types.js'
import { Avatar } from '../ui/Avatar.js'

type FullRole = WorkerRole | 'orchestrator'

type StatusRing = 'working' | 'idle' | 'stopped' | 'none'

type RoleAvatarProps = {
  role: FullRole
  size?: number
  /** Optional ring around the avatar matching agent status. */
  statusRing?: StatusRing
}

// A glyph per role instead of an English two-letter tag. In a zh UI "Co / Re /
// Te / Cu / Or" read as opaque initials; a code bracket / magnifier / flask /
// sliders / crown say what the role *does* at a glance.
const iconByRole: Record<FullRole, LucideIcon> = {
  orchestrator: Crown, // hive "queen" — the coordinator that dispatches work
  coder: Code2,
  reviewer: SearchCheck,
  tester: FlaskConical,
  custom: SlidersHorizontal,
}

// Stable, lucide-version-independent name for the chosen glyph. Exposed as
// `data-icon` so tests can assert "this role shows that icon" without coupling
// to lucide's internal SVG class names (which can churn across releases).
const iconNameByRole: Record<FullRole, string> = {
  orchestrator: 'crown',
  coder: 'code',
  reviewer: 'review',
  tester: 'test',
  custom: 'custom',
}

const colorByRole: Record<FullRole, string> = {
  orchestrator: 'var(--accent)',
  coder: 'var(--status-blue)',
  reviewer: 'var(--status-purple)',
  tester: 'var(--status-orange)',
  custom: 'var(--text-secondary)',
}

const ringColorByStatus: Record<Exclude<StatusRing, 'none'>, string> = {
  working: 'var(--status-green)',
  idle: 'var(--text-tertiary)',
  stopped: 'var(--status-red)',
}

export const RoleAvatar = ({ role, size = 32, statusRing = 'none' }: RoleAvatarProps) => {
  const Icon = iconByRole[role]
  return (
    <Avatar
      size={size}
      color={colorByRole[role]}
      ringColor={statusRing === 'none' ? null : ringColorByStatus[statusRing]}
      ringSurface="var(--bg-2)"
      testId="role-avatar"
      data={{ role, icon: iconNameByRole[role], 'status-ring': statusRing }}
    >
      <Icon size={Math.round(size * 0.56)} aria-hidden />
    </Avatar>
  )
}
