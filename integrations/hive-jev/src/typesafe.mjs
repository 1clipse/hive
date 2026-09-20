const DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone'

export async function callJev(state, questions, options = {}) {
  const apiKey = (options.apiKey ?? process.env.TYPESAFE_API_KEY ?? '').trim()
  if (!apiKey) throw new Error('TYPESAFE_API_KEY is required; no action was executed.')

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000)
  try {
    const response = await fetch(
      options.baseUrl ?? process.env.TYPESAFE_BASE_URL ?? DEFAULT_ENDPOINT,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: options.model ?? process.env.TYPESAFE_MODEL ?? 'jev-latest',
          state,
          questions,
        }),
        signal: controller.signal,
      }
    )
    if (!response.ok)
      throw new Error(`TypeSafe returned HTTP ${response.status}; no action was executed.`)
    const result = await response.json()
    if (
      !result ||
      typeof result !== 'object' ||
      !result.answers ||
      typeof result.answers !== 'object'
    ) {
      throw new Error('TypeSafe returned an invalid response; no action was executed.')
    }
    return result
  } catch (error) {
    if (error?.name === 'AbortError')
      throw new Error('TypeSafe request timed out; no action was executed.')
    throw error
  } finally {
    clearTimeout(timeout)
  }
}
