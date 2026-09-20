import type { Database } from './sqlite.js'

interface ApplySchemaVersion27Options {
  rebuild?: boolean
}

const tableExists = (db: Database, table: string) =>
  Boolean(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as
      | { name: string }
      | undefined
  )

const ensureFtsRowidColumn = (db: Database) => {
  const columns = new Set(
    (db.prepare('PRAGMA table_info(memory_entries)').all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  )
  if (!columns.has('fts_rowid')) {
    db.exec('ALTER TABLE memory_entries ADD COLUMN fts_rowid INTEGER')
  }
  db.exec(`
    UPDATE memory_entries
    SET fts_rowid = rowid
    WHERE fts_rowid IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_entries_fts_rowid
      ON memory_entries(fts_rowid)
      WHERE fts_rowid IS NOT NULL;
  `)
}

const quoteFtsToken = (value: string) => `"${value.replaceAll('"', '""')}"`

const firstUnicodeTerm = (value: string | null) => {
  if (!value) return null
  const token = value.trim().split(/\s+/).find(Boolean)
  if (!token) return null
  return token
}

const firstTrigramTerm = (value: string | null) => {
  const token = firstUnicodeTerm(value)
  if (!token) return null
  const chars = [...token]
  if (chars.length < 3) return null
  return chars.slice(0, 3).join('')
}

const ftsHasSampleHit = (db: Database, table: 'memory_fts' | 'memory_fts_trigram', term: string) =>
  (
    db
      .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${table} MATCH ?`)
      .get(quoteFtsToken(term)) as { count: number }
  ).count > 0

const shouldRebuildExistingIndex = (db: Database) => {
  const sample = db
    .prepare(
      `SELECT body, tags
       FROM memory_entries
       WHERE scope = 'workspace'
       ORDER BY created_at ASC, id ASC
       LIMIT 1`
    )
    .get() as { body: string | null; tags: string | null } | undefined
  if (!sample) return false

  const unicodeTerm = firstUnicodeTerm(sample.body) ?? firstUnicodeTerm(sample.tags)
  const trigramTerm = firstTrigramTerm(sample.body) ?? firstTrigramTerm(sample.tags)
  if (!unicodeTerm && !trigramTerm) return false

  const unicodeHealthy = unicodeTerm ? ftsHasSampleHit(db, 'memory_fts', unicodeTerm) : true
  const trigramHealthy = trigramTerm ? ftsHasSampleHit(db, 'memory_fts_trigram', trigramTerm) : true
  return !(unicodeHealthy && trigramHealthy)
}

export const applySchemaVersion27 = (db: Database, options: ApplySchemaVersion27Options = {}) => {
  ensureFtsRowidColumn(db)
  const memoryFtsExists = tableExists(db, 'memory_fts')
  const memoryFtsTrigramExists = tableExists(db, 'memory_fts_trigram')

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts
      USING fts5(body, tags, content='memory_entries', content_rowid='fts_rowid', tokenize='unicode61');
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts_trigram
      USING fts5(body, tags, content='memory_entries', content_rowid='fts_rowid', tokenize='trigram');

    CREATE TRIGGER IF NOT EXISTS memory_fts_ai AFTER INSERT ON memory_entries BEGIN
      INSERT INTO memory_fts(rowid, body, tags) VALUES (new.fts_rowid, new.body, new.tags);
      INSERT INTO memory_fts_trigram(rowid, body, tags)
        VALUES (new.fts_rowid, new.body, new.tags);
    END;
    CREATE TRIGGER IF NOT EXISTS memory_fts_ad AFTER DELETE ON memory_entries BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, body, tags)
        VALUES('delete', old.fts_rowid, old.body, old.tags);
      INSERT INTO memory_fts_trigram(memory_fts_trigram, rowid, body, tags)
        VALUES('delete', old.fts_rowid, old.body, old.tags);
    END;
    CREATE TRIGGER IF NOT EXISTS memory_fts_au AFTER UPDATE ON memory_entries BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, body, tags)
        VALUES('delete', old.fts_rowid, old.body, old.tags);
      INSERT INTO memory_fts(rowid, body, tags) VALUES (new.fts_rowid, new.body, new.tags);
      INSERT INTO memory_fts_trigram(memory_fts_trigram, rowid, body, tags)
        VALUES('delete', old.fts_rowid, old.body, old.tags);
      INSERT INTO memory_fts_trigram(rowid, body, tags)
        VALUES (new.fts_rowid, new.body, new.tags);
    END;
  `)

  if (
    options.rebuild === true ||
    !memoryFtsExists ||
    !memoryFtsTrigramExists ||
    shouldRebuildExistingIndex(db)
  ) {
    db.exec(`
      INSERT INTO memory_fts(memory_fts) VALUES('rebuild');
      INSERT INTO memory_fts_trigram(memory_fts_trigram) VALUES('rebuild');
    `)
  }
}
