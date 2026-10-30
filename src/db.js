const EventEmitter = require('events')
const pg = require('pg')

class Db extends EventEmitter {
  constructor (config) {
    super()

    config.application_name = config.application_name || 'pgboss'

    this.config = config
  }

  async open () {
    this.pool = new pg.Pool(this.config)
    this.pool.on('error', error => this.emit('error', error))
    this.opened = true
  }

  async close () {
    if (!this.pool.ending) {
      this.opened = false
      await this.pool.end()
    }
  }

  async executeSql (text, values) {
    if (this.opened) {
      return await this.pool.query(text, values)
    }
  }

  async executeSqlInTransaction (text, values, setup = []) {
    if (this.opened) {
      const client = await this.pool.connect()
      let releaseError

      try {
        await client.query('BEGIN')

        for (const statement of setup) {
          await client.query(statement)
        }

        const result = await client.query(text, values)

        await client.query('COMMIT')

        return result
      } catch (err) {
        try {
          await client.query('ROLLBACK')
        } catch (rollbackErr) {
          // a client that can't roll back is discarded rather than returned to the pool
          releaseError = rollbackErr
        }

        throw err
      } finally {
        client.release(releaseError)
      }
    }
  }
}

module.exports = Db
