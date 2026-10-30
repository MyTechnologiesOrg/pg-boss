const assert = require('assert')
const helper = require('./testHelper')

describe('wildcard', function () {
  it('fetch() should return all jobs using a wildcard pattern', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema

    await boss.send(`${queue}_1234`)
    await boss.send(`${queue}_5678`)

    const jobs = await boss.fetch(`${queue}_*`, 2)

    assert.strictEqual(jobs.length, 2)
  })

  it('work() should return all jobs using a wildcard pattern', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema

    await boss.send(`${queue}_1234`)
    await boss.send(`${queue}_5678`)

    return new Promise((resolve) => {
      boss.work(`${queue}_*`, { batchSize: 2 }, jobs => {
        assert.strictEqual(jobs.length, 2)
        resolve()
      })
    })
  })

  it('should not accidentally fetch state completion jobs from a pattern', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema

    await boss.send(`${queue}_1234`)
    const job = await boss.fetch(`${queue}_*`)
    await boss.complete(job.id)
    const job2 = await boss.fetch(`${queue}_*`)

    assert.strictEqual(job2, null)
  })

  it('fetch() should match backslashes in queue names literally', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema

    await boss.send(`${queue}x`)
    const id = await boss.send(`${queue}\\x`)

    const job = await boss.fetch(`${queue}\\x`)

    assert(job)
    assert.strictEqual(job.id, id)
    assert.strictEqual(await boss.fetch(`${queue}\\`), null)
  })

  it('fetch() should not treat a backslash as escaping a wildcard', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema

    await boss.send(`${queue}\\1234`)

    assert.strictEqual(await boss.fetch(`${queue}\\%`), null)
    assert.strictEqual(await boss.fetch(`${queue}\\_234`), null)
    assert(await boss.fetch(`${queue}\\*`))
  })
})
