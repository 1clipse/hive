import type { Database } from './sqlite.js'

const tableExists = (db: Database, table: string) =>
  Boolean(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as
      | { name: string }
      | undefined
  )

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
  // Trigram FTS does not index tokens shorter than 3 characters. Probing
  // those always misses and would rebuild every boot.
  if (chars.length < 3) return null
  return chars.slice(0, 3).join('')
}

const ftsHasSampleHit = (
  db: Database,
  table: 'messages_fts' | 'messages_fts_trigram' | 'dispatches_fts' | 'dispatches_fts_trigram',
  term: string
) =>
  (
    db
      .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${table} MATCH ?`)
      .get(quoteFtsToken(term)) as { count: number }
  ).count > 0

const shouldRebuildMessageIndexes = (db: Database) => {
  const sample = db
    .prepare(
      `SELECT text
       FROM messages
       ORDER BY sequence ASC
       LIMIT 1`
    )
    .get() as { text: string | null } | undefined
  if (!sample) return false

  const unicodeTerm = firstUnicodeTerm(sample.text)
  const trigramTerm = firstTrigramTerm(sample.text)
  if (!unicodeTerm && !trigramTerm) return false

  const unicodeHealthy = unicodeTerm ? ftsHasSampleHit(db, 'messages_fts', unicodeTerm) : true
  const trigramHealthy = trigramTerm
    ? ftsHasSampleHit(db, 'messages_fts_trigram', trigramTerm)
    : true
  return !(unicodeHealthy && trigramHealthy)
}

const shouldRebuildDispatchIndexes = (db: Database) => {
  const sample = db
    .prepare(
      `SELECT text, report_text
       FROM dispatches
       ORDER BY sequence ASC
       LIMIT 1`
    )
    .get() as { report_text: string | null; text: string | null } | undefined
  if (!sample) return false

  const unicodeTerm = firstUnicodeTerm(sample.text) ?? firstUnicodeTerm(sample.report_text)
  const trigramTerm = firstTrigramTerm(sample.text) ?? firstTrigramTerm(sample.report_text)
  if (!unicodeTerm && !trigramTerm) return false

  const unicodeHealthy = unicodeTerm ? ftsHasSampleHit(db, 'dispatches_fts', unicodeTerm) : true
  const trigramHealthy = trigramTerm
    ? ftsHasSampleHit(db, 'dispatches_fts_trigram', trigramTerm)
    : true
  return !(unicodeHealthy && trigramHealthy)
}

export const applySchemaVersion25 = (db: Database) => {
  const messagesFtsExists = tableExists(db, 'messages_fts')
  const messagesFtsTrigramExists = tableExists(db, 'messages_fts_trigram')
  const dispatchesFtsExists = tableExists(db, 'dispatches_fts')
  const dispatchesFtsTrigramExists = tableExists(db, 'dispatches_fts_trigram')

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
      USING fts5(text, content='messages', content_rowid='sequence', tokenize='unicode61');
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts_trigram
      USING fts5(text, content='messages', content_rowid='sequence', tokenize='trigram');

    CREATE VIRTUAL TABLE IF NOT EXISTS dispatches_fts
      USING fts5(text, report_text, content='dispatches', content_rowid='sequence', tokenize='unicode61');
    CREATE VIRTUAL TABLE IF NOT EXISTS dispatches_fts_trigram
      USING fts5(text, report_text, content='dispatches', content_rowid='sequence', tokenize='trigram');

    CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, text) VALUES (new.sequence, new.text);
      INSERT INTO messages_fts_trigram(rowid, text) VALUES (new.sequence, new.text);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, text) VALUES('delete', old.sequence, old.text);
      INSERT INTO messages_fts_trigram(messages_fts_trigram, rowid, text)
        VALUES('delete', old.sequence, old.text);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, text) VALUES('delete', old.sequence, old.text);
      INSERT INTO messages_fts(rowid, text) VALUES (new.sequence, new.text);
      INSERT INTO messages_fts_trigram(messages_fts_trigram, rowid, text)
        VALUES('delete', old.sequence, old.text);
      INSERT INTO messages_fts_trigram(rowid, text) VALUES (new.sequence, new.text);
    END;

    CREATE TRIGGER IF NOT EXISTS dispatches_fts_ai AFTER INSERT ON dispatches BEGIN
      INSERT INTO dispatches_fts(rowid, text, report_text)
        VALUES (new.sequence, new.text, new.report_text);
      INSERT INTO dispatches_fts_trigram(rowid, text, report_text)
        VALUES (new.sequence, new.text, new.report_text);
    END;
    CREATE TRIGGER IF NOT EXISTS dispatches_fts_ad AFTER DELETE ON dispatches BEGIN
      INSERT INTO dispatches_fts(dispatches_fts, rowid, text, report_text)
        VALUES('delete', old.sequence, old.text, old.report_text);
      INSERT INTO dispatches_fts_trigram(dispatches_fts_trigram, rowid, text, report_text)
        VALUES('delete', old.sequence, old.text, old.report_text);
    END;
    CREATE TRIGGER IF NOT EXISTS dispatches_fts_au AFTER UPDATE ON dispatches BEGIN
      INSERT INTO dispatches_fts(dispatches_fts, rowid, text, report_text)
        VALUES('delete', old.sequence, old.text, old.report_text);
      INSERT INTO dispatches_fts(rowid, text, report_text)
        VALUES (new.sequence, new.text, new.report_text);
      INSERT INTO dispatches_fts_trigram(dispatches_fts_trigram, rowid, text, report_text)
        VALUES('delete', old.sequence, old.text, old.report_text);
      INSERT INTO dispatches_fts_trigram(rowid, text, report_text)
        VALUES (new.sequence, new.text, new.report_text);
    END;
  `)

  if (
    !messagesFtsExists ||
    !messagesFtsTrigramExists ||
    !dispatchesFtsExists ||
    !dispatchesFtsTrigramExists ||
    shouldRebuildMessageIndexes(db) ||
    shouldRebuildDispatchIndexes(db)
  ) {
    db.exec(`
      INSERT INTO messages_fts(messages_fts) VALUES('rebuild');
      INSERT INTO messages_fts_trigram(messages_fts_trigram) VALUES('rebuild');
      INSERT INTO dispatches_fts(dispatches_fts) VALUES('rebuild');
      INSERT INTO dispatches_fts_trigram(dispatches_fts_trigram) VALUES('rebuild');
    `)
  }
}
