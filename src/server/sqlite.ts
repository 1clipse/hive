import { DatabaseSync, type SQLInputValue, type StatementResultingChanges } from 'node:sqlite'

export interface Statement {
  get(...parameters: SQLInputValue[]): unknown
  all(...parameters: SQLInputValue[]): unknown[]
  run(...parameters: SQLInputValue[]): StatementResultingChanges
}

/** Synchronous SQLite with the nested atomic mutations used by Hive stores. */
export class Database {
  private readonly connection: DatabaseSync
  private savepointSequence = 0

  constructor(path: string, options: { readOnly?: boolean } = {}) {
    this.connection = new DatabaseSync(path, { timeout: 5000, ...options })
    if (typeof this.connection.isTransaction !== 'boolean') {
      this.connection.close()
      throw new Error(
        'Hive requires Node.js 22.18+ or 24+ with built-in SQLite transaction support'
      )
    }
  }

  get isOpen() {
    return this.connection.isOpen
  }
  exec(sql: string) {
    this.connection.exec(sql)
  }
  close() {
    this.connection.close()
  }
  prepare(sql: string): Statement {
    return this.connection.prepare(sql)
  }

  transaction<Args extends unknown[], Result>(mutation: (...args: Args) => Result) {
    return (...args: Args): Result => {
      const nested = this.connection.isTransaction
      const savepoint = `hive_transaction_${this.savepointSequence++}`
      this.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN')
      try {
        const result = mutation(...args)
        if (
          result !== null &&
          (typeof result === 'object' || typeof result === 'function') &&
          typeof Reflect.get(result, 'then') === 'function'
        ) {
          throw new TypeError('SQLite transactions must be synchronous')
        }
        this.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT')
        return result
      } catch (error) {
        // SQLite may already have rolled back after a conflict or I/O failure.
        if (this.connection.isTransaction) {
          this.exec(nested ? `ROLLBACK TO ${savepoint}` : 'ROLLBACK')
          if (nested) this.exec(`RELEASE ${savepoint}`)
        }
        throw error
      }
    }
  }
}

export default Database
