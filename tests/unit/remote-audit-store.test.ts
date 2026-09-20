import { afterEach, describe, expect, test } from 'vitest'
import {
  AUDIT_PREVIEW_MAX,
  createRemoteAuditStore,
  type RemoteAuditRecord,
} from '../../src/server/remote-audit-store.js'
import Database from '../../src/server/sqlite.js'
import { initializeRuntimeDatabase } from '../../src/server/sqlite-schema.js'

const dbs: Database[] = []

const firstRow = (rows: RemoteAuditRecord[]): RemoteAuditRecord => {
  const row = rows[0]
  expect(row).toBeDefined()
  return row as RemoteAuditRecord
}

const openDb = () => {
  const db = new Database(':memory:')
  initializeRuntimeDatabase(db)
  dbs.push(db)
  return db
}

afterEach(() => {
  for (const db of dbs.splice(0)) db.close()
})

describe('remote-audit-store', () => {
  test('enqueue does not write synchronously — the row lands after a flush', async () => {
    const db = openDb()
    const store = createRemoteAuditStore(db)

    store.enqueue({ action: 'http', endpoint: '/api/workspaces', result: 'ok' })

    // Read the raw table directly so we bypass the store's own writePending().
    const beforeFlush = db.prepare('SELECT COUNT(*) AS n FROM remote_audit').get() as { n: number }
    // If this asserted >0, the store would be writing on the caller's stack —
    // i.e. blocking the forwarding path, which the audit spec forbids.
    expect(beforeFlush.n).toBe(0)

    await store.flush()

    const afterFlush = db.prepare('SELECT COUNT(*) AS n FROM remote_audit').get() as { n: number }
    expect(afterFlush.n).toBe(1)
  })

  test('records the full event shape including device, endpoint and workspace', async () => {
    const db = openDb()
    const store = createRemoteAuditStore(db)

    store.enqueue({
      deviceId: 'device-7',
      action: 'http',
      endpoint: '/api/workspaces',
      workspaceId: 'ws-1',
      result: 'ok',
    })
    await store.flush()

    const row = firstRow(store.list())
    expect(row).toMatchObject({
      deviceId: 'device-7',
      action: 'http',
      endpoint: '/api/workspaces',
      workspaceId: 'ws-1',
      result: 'ok',
      rejectReason: null,
    })
    expect(row.ts).toBeGreaterThan(0)
  })

  test('a rejection records the concrete reason, not just result=rejected', async () => {
    const db = openDb()
    const store = createRemoteAuditStore(db)

    store.enqueue({
      deviceId: 'device-7',
      action: 'reject',
      endpoint: '/etc/passwd',
      result: 'rejected',
      rejectReason: 'path-not-whitelisted',
    })
    await store.flush()

    const row = firstRow(store.list())
    expect(row.result).toBe('rejected')
    // The whole point of the audit layer for the security tests: the reason
    // string is the failure, not a generic flag. If the store dropped it this
    // would be null and the security test downstream couldn't bite.
    expect(row.rejectReason).toBe('path-not-whitelisted')
  })

  test('WS input is summarised: byte count is kept, preview is truncated, full text is never stored', async () => {
    const db = openDb()
    const store = createRemoteAuditStore(db)

    const secret = `${'A'.repeat(AUDIT_PREVIEW_MAX)}TAIL-SHOULD-NOT-BE-STORED`
    store.enqueue({
      deviceId: 'device-7',
      action: 'ws_input',
      result: 'ok',
      byteCount: secret.length,
      preview: secret,
    })
    await store.flush()

    const row = firstRow(store.list())
    expect(row.byteCount).toBe(secret.length)
    expect(row.preview).not.toBeNull()
    // Bounded to AUDIT_PREVIEW_MAX (+ ellipsis); the tail must be gone.
    expect((row.preview as string).length).toBeLessThanOrEqual(AUDIT_PREVIEW_MAX + 1)
    expect(row.preview).not.toContain('TAIL-SHOULD-NOT-BE-STORED')
  })

  test('list returns newest-first', async () => {
    const db = openDb()
    const store = createRemoteAuditStore(db)

    store.enqueue({ action: 'http', endpoint: '/api/a', result: 'ok' })
    store.enqueue({ action: 'http', endpoint: '/api/b', result: 'ok' })
    store.enqueue({ action: 'http', endpoint: '/api/c', result: 'ok' })
    await store.flush()

    expect(store.list().map((r) => r.endpoint)).toEqual(['/api/c', '/api/b', '/api/a'])
  })

  test('listForDevice scopes to one device', async () => {
    const db = openDb()
    const store = createRemoteAuditStore(db)

    store.enqueue({ deviceId: 'device-a', action: 'http', endpoint: '/api/a', result: 'ok' })
    store.enqueue({ deviceId: 'device-b', action: 'http', endpoint: '/api/b', result: 'ok' })
    await store.flush()

    const forA = store.listForDevice('device-a')
    expect(forA).toHaveLength(1)
    expect(forA[0]?.endpoint).toBe('/api/a')
  })

  test('a burst of enqueues coalesces and all rows survive a single flush', async () => {
    const db = openDb()
    const store = createRemoteAuditStore(db)

    for (let i = 0; i < 50; i++) {
      store.enqueue({ action: 'ws_input', result: 'ok', byteCount: i })
    }
    await store.flush()

    const count = db.prepare('SELECT COUNT(*) AS n FROM remote_audit').get() as { n: number }
    expect(count.n).toBe(50)
  })
})
