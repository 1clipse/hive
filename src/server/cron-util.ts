import { CronExpressionParser } from 'cron-parser'

import { BadRequestError } from './http-errors.js'

/**
 * Validate a 5-field cron string and return its next fire time (ms-epoch).
 * Throws BadRequestError on an unparseable expression. Shared by the UI
 * schedule PATCH route and the agent `team workflow schedule` route so cron
 * validation behaves identically on both paths. UTC, like the scheduler.
 */
export const validateCronNextRunAt = (cron: string): number => {
  try {
    return CronExpressionParser.parse(cron, { currentDate: new Date(), tz: 'UTC' })
      .next()
      .toDate()
      .getTime()
  } catch (error) {
    throw new BadRequestError(
      `Invalid cron expression: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}
