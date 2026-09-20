/**
 * Opt-in structured output for the workflow DSL `agent()` call. When a script
 * passes `outputSchema`, the runner appends an instruction asking the worker to
 * end its report with a fenced ```json block, then parses that block so the
 * script gets an object instead of brittle free-text. Kept deliberately LIGHT:
 * no schema validation library, no retry — the keys are advisory, and a parse
 * miss falls back to `{ text }` in the runner so a script can always branch on
 * a missing field (the documented safe-default discipline).
 */

/**
 * Extract and parse the LAST fenced json block in a report. Workers often emit
 * a reasoning block then a final answer block, so the last one wins. Returns
 * null on no block / invalid JSON / a non-object payload (so the caller's
 * `?? { text }` fallback fires) rather than throwing.
 */
export const extractJsonBlock = (text: string): Record<string, unknown> | null => {
  const matches = [...text.matchAll(/```(?:json)?[ \t]*\r?\n?([\s\S]*?)```/g)]
  const last = matches.at(-1)?.[1]
  if (last === undefined) return null
  try {
    const parsed: unknown = JSON.parse(last.trim())
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** The terse instruction appended to the worker prompt when a schema is set. */
export const buildSchemaInstruction = (schema: Record<string, unknown>): string => {
  const keys = Object.keys(schema)
  const keyList = keys.length > 0 ? keys.join(', ') : '(see the task)'
  return [
    '',
    'When you are done, end your report with a single fenced ```json block as the LAST thing in your message.',
    `That JSON object should use these keys: ${keyList}.`,
    'If you cannot determine a field, omit it and explain the uncertainty before the JSON block. Missing fields are inconclusive, not evidence of success.',
  ].join('\n')
}
