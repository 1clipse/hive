import { SELF } from 'cloudflare:test'
import { expect, test } from 'vitest'

// Harness proof: a real request through the worker under workerd, asserting a
// concrete response. Fails if the worker doesn't boot or routing is wrong.
test('GET /healthz returns ok through workerd', async () => {
  const res = await SELF.fetch('https://app.hivehq.dev/healthz')
  expect(res.status).toBe(200)
  expect(await res.text()).toBe('ok')
})

test('unknown route is 404, not a crash', async () => {
  const res = await SELF.fetch('https://app.hivehq.dev/nope')
  expect(res.status).toBe(404)
})
