import type { Database } from './sqlite.js'

/**
 * Local retention signals (issue #23): per-day counts of team protocol
 * events, stored in SQLite, readable from the diagnostics surface.
 *
 * Hard boundaries:
 * - LOCAL ONLY. Nothing is ever sent over the network; the only consumers are
 *   the diagnostics route and the support bundle the user explicitly copies.
 * - Recording must never break a protocol operation: `record` swallows every
 *   error (a stats hiccup must not fail a dispatch or report).
 * - Days are the user's LOCAL calendar days — "did I use Hive on Tuesday" is
 *   a local-time question, and streaks would look off-by-one near midnight
 *   under UTC bucketing.
 */
export type ProtocolEvent = 'send' | 'report' | 'status' | 'cancel'

export interface RetentionDailyRow {
  day: string
  send: number
  report: number
  status: number
  cancel: number
}

export interface RetentionSignals {
  /** First local day with any protocol activity (install-age proxy). */
  first_event_day: string | null
  /** Count of distinct local days with at least one protocol event. */
  days_active_total: number
  /** Consecutive active days ending today or yesterday (0 when cold). */
  current_streak_days: number
  totals: Record<ProtocolEvent, number>
  /** Most recent `windowDays` local days that had activity, ascending. */
  daily: RetentionDailyRow[]
}

export const localDayKey = (timestamp: number): string => {
  const date = new Date(timestamp)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const dayOfMonth = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${dayOfMonth}`
}

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_WINDOW_DAYS = 30

interface CountRow {
  day: string
  event: string
  count: number
}

export const createProtocolEventStats = (db: Database, now: () => number = Date.now) => {
  const record = (event: ProtocolEvent): void => {
    try {
      db.prepare(
        `INSERT INTO protocol_event_daily (day, event, count) VALUES (?, ?, 1)
         ON CONFLICT(day, event) DO UPDATE SET count = count + 1`
      ).run(localDayKey(now()), event)
    } catch (error) {
      // Never let stats failures touch the protocol path.
      console.error('[hive] swallowed:protocolEventStats.record', error)
    }
  }

  const getRetentionSignals = (windowDays = DEFAULT_WINDOW_DAYS): RetentionSignals => {
    const empty: RetentionSignals = {
      first_event_day: null,
      days_active_total: 0,
      current_streak_days: 0,
      totals: { send: 0, report: 0, status: 0, cancel: 0 },
      daily: [],
    }
    let rows: CountRow[]
    try {
      rows = db
        .prepare('SELECT day, event, count FROM protocol_event_daily ORDER BY day ASC')
        .all() as CountRow[]
    } catch (error) {
      console.error('[hive] swallowed:protocolEventStats.read', error)
      return empty
    }
    if (rows.length === 0) return empty

    const byDay = new Map<string, RetentionDailyRow>()
    const totals: Record<ProtocolEvent, number> = { send: 0, report: 0, status: 0, cancel: 0 }
    for (const row of rows) {
      if (!(row.event in totals)) continue
      const event = row.event as ProtocolEvent
      let daily = byDay.get(row.day)
      if (!daily) {
        daily = { day: row.day, send: 0, report: 0, status: 0, cancel: 0 }
        byDay.set(row.day, daily)
      }
      daily[event] += row.count
      totals[event] += row.count
    }
    const activeDays = [...byDay.keys()].sort()
    if (activeDays.length === 0) return empty

    const active = new Set(activeDays)
    const ts = now()
    // Streak ends today, or yesterday when today simply has no activity YET —
    // checking at 9am must not show a broken streak for a daily-evening user.
    // Anchor the walk to local noon so a DST hour shift can never make a
    // 24h step skip or repeat a local day key.
    const localNoon = (timestamp: number): number => {
      const date = new Date(timestamp)
      date.setHours(12, 0, 0, 0)
      return date.getTime()
    }
    let cursor = localNoon(active.has(localDayKey(ts)) ? ts : ts - DAY_MS)
    let streak = 0
    while (active.has(localDayKey(cursor))) {
      streak += 1
      cursor -= DAY_MS
    }

    const windowDayKeys = activeDays.slice(-Math.max(1, windowDays))
    return {
      first_event_day: activeDays[0] ?? null,
      days_active_total: activeDays.length,
      current_streak_days: streak,
      totals,
      daily: windowDayKeys.map((day) => byDay.get(day) as RetentionDailyRow),
    }
  }

  return { record, getRetentionSignals }
}

export type ProtocolEventStats = ReturnType<typeof createProtocolEventStats>
