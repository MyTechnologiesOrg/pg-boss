const assert = require('assert')
const PgBoss = require('../')
const helper = require('./testHelper')

describe('database', function () {
  it('should fail on invalid database host', async function () {
    const boss = new PgBoss('postgres://bobby:tables@wat:12345/northwind')

    try {
      await boss.start()
      assert(false)
    } catch (err) {
      assert(true)
    }
  })

  it('can be swapped out via BYODB', async function () {
    const query = 'SELECT something FROM somewhere'

    const mydb = {
      executeSql: async (text, values) => ({ rows: [], text, rowCount: 0 })
    }

    const boss = new PgBoss({ db: mydb })
    const response = await boss.db.executeSql(query)

    assert(response.text === query)
  })

  describe('executeSqlInTransaction', function () {
    it('should apply setup statements to the query transaction only', async function () {
      const db = await helper.getDb()

      try {
        const { rows: [before] } = await db.executeSql('SELECT current_setting($1) as jit', ['jit'])
        const { rows: [inside] } = await db.executeSqlInTransaction('SELECT current_setting($1) as jit', ['jit'], ['SET LOCAL jit = OFF'])
        const { rows: [after] } = await db.executeSql('SELECT current_setting($1) as jit', ['jit'])

        assert.strictEqual(inside.jit, 'off')
        assert.strictEqual(after.jit, before.jit)
      } finally {
        await db.close()
      }
    })

    it('should rethrow and release the client when the query fails', async function () {
      const db = await helper.getDb()

      try {
        await db.executeSqlInTransaction('SELECT 1/0', [])
        assert(false, 'Error was expected but did not occur')
      } catch (err) {
        assert(err.message.includes('division by zero'))
        assert.strictEqual(db.pool.totalCount, 1)
        assert.strictEqual(db.pool.idleCount, 1)
      } finally {
        await db.close()
      }
    })
  })
})
