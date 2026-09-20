import { describe, expect, test } from 'vitest'
import { createProtocolEventStats, localDayKey } from '../../src/server/protocol-event-stats.js'
import Database from '../../src/server/sqlite.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'

const DAY_MS = 24 * 60 * 60 * 1000
// Fixed local-noon anchor so day arithmetic in the test itself can't straddle
// a midnight boundary while the suite runs.
const noonToday = (() => {
  const date = new Date()
  date.setHours(12, 0, 0, 0)
  return date.getTime()
})()

const makeStats = (nowValue: () => number) => {
  const db = new Database(':memory:')
  initializeRuntimeDatabase(db)
  return { db, stats: createProtocolEventStats(db, nowValue) }
}

describe('protocol event stats (local retention signals)', () => {
  test('record aggregates per local day and per event, with totals', () => {
    let clock = noonToday - 2 * DAY_MS
    const { stats } = makeStats(() => clock)
    stats.record('send')
    stats.record('send')
    stats.record('report')
    clock = noonToday
    stats.record('send')
    stats.record('status')
    stats.record('cancel')

    const signals = stats.getRetentionSignals()
    expect(signals.totals).toEqual({ send: 3, report: 1, status: 1, cancel: 1 })
    expect(signals.daily).toEqual([
      {
        day: localDayKey(noonToday - 2 * DAY_MS),
        send: 2,
        report: 1,
        status: 0,
        cancel: 0,
      },
      { day: localDayKey(noonToday), send: 1, report: 0, status: 1, cancel: 1 },
    ])
  })

  test('streak counts consecutive active days ending today', () => {
    let clock = noonToday - 2 * DAY_MS
    const { stats } = makeStats(() => clock)
    stats.record('send')
    clock = noonToday - DAY_MS
    stats.record('report')
    clock = noonToday
    stats.record('send')
    expect(stats.getRetentionSignals().current_streak_days).toBe(3)
  })

  test('a one-day gap breaks the streak', () => {
    let clock = noonToday - 3 * DAY_MS
    const { stats } = makeStats(() => clock)
    stats.record('send')
    // skip noonToday - 2*DAY_MS entirely
    clock = noonToday - DAY_MS
    stats.record('send')
    clock = noonToday
    stats.record('send')
    const signals = stats.getRetentionSignals()
    expect(signals.current_streak_days).toBe(2)
    expect(signals.days_active_total).toBe(3)
  })

  test('today inactive but yesterday active still counts as a live streak', () => {
    let clock = noonToday - 2 * DAY_MS
    const { stats } = makeStats(() => clock)
    stats.record('send')
    clock = noonToday - DAY_MS
    stats.record('send')
    clock = noonToday
    expect(stats.getRetentionSignals().current_streak_days).toBe(2)
  })

  test('first_event_day is the earliest active local day', () => {
    let clock = noonToday - 9 * DAY_MS
    const { stats } = makeStats(() => clock)
    stats.record('status')
    clock = noonToday
    stats.record('send')
    expect(stats.getRetentionSignals().first_event_day).toBe(localDayKey(noonToday - 9 * DAY_MS))
  })

  test('cold start returns the empty shape', () => {
    const { stats } = makeStats(() => noonToday)
    expect(stats.getRetentionSignals()).toEqual({
      first_event_day: null,
      days_active_total: 0,
      current_streak_days: 0,
      totals: { send: 0, report: 0, status: 0, cancel: 0 },
      daily: [],
    })
  })

  test('daily window keeps only the most recent N active days, ascending', () => {
    let clock = noonToday - 5 * DAY_MS
    const { stats } = makeStats(() => clock)
    for (let offset = 5; offset >= 0; offset -= 1) {
      clock = noonToday - offset * DAY_MS
      stats.record('send')
    }
    const signals = stats.getRetentionSignals(3)
    expect(signals.daily.map((row) => row.day)).toEqual([
      localDayKey(noonToday - 2 * DAY_MS),
      localDayKey(noonToday - DAY_MS),
      localDayKey(noonToday),
    ])
    // The window trims the listing but not the lifetime aggregates.
    expect(signals.days_active_total).toBe(6)
    expect(signals.totals.send).toBe(6)
  })

  test('record never throws into the protocol path, even with the table gone', () => {
    const { db, stats } = makeStats(() => noonToday)
    db.exec('DROP TABLE protocol_event_daily')
    expect(() => stats.record('send')).not.toThrow()
    expect(stats.getRetentionSignals()).toEqual(
      expect.objectContaining({ days_active_total: 0, current_streak_days: 0 })
    )
  })
})
