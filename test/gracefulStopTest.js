const assert = require('assert')
const delay = require('delay')
const helper = require('./testHelper')

describe('graceful stop', function () {
  const defaults = {
    noSupervisor: true,
    noScheduling: true
  }

  const waitFor = async (predicate, timeout = 5000) => {
    const deadline = Date.now() + timeout

    while (!(await predicate())) {
      assert(Date.now() < deadline, 'condition not met in time')
      await delay(20)
    }
  }

  it('should wait for teamRefill jobs still running', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })
    const queue = this.test.bossConfig.schema

    await boss.send(queue)
    await boss.send(queue)

    let started = 0
    let finished = 0

    await boss.work(queue, { teamSize: 2, teamConcurrency: 2, teamRefill: true, newJobCheckInterval: 100 }, async () => {
      started++
      await delay(started === 1 ? 100 : 2500)
      finished++
    })

    await waitFor(() => started === 2)

    const stopped = new Promise(resolve => boss.once('stopped', resolve))

    await boss.stop({ timeout: 8000 })
    await stopped

    assert.strictEqual(finished, 2)

    const { rows } = await helper.findJobs(this.test.bossConfig.schema, 'name = $1', [queue])

    assert.deepStrictEqual(rows.map(job => job.state), ['completed', 'completed'])
  })

  it('should leave a newer attempt of the job alone', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })
    const queue = this.test.bossConfig.schema
    const schema = this.test.bossConfig.schema

    const jobId = await boss.send(queue)

    let release
    let started = false

    await boss.work(queue, { newJobCheckInterval: 100 }, () => {
      started = true
      return new Promise(resolve => { release = resolve })
    })

    await waitFor(() => started)

    // As if the job expired and another worker fetched it again while this handler kept running
    const db = await helper.getDb()
    await db.executeSql(`UPDATE ${schema}.job SET state = 'retry', startAfter = now() - interval '1 second' WHERE id = $1`, [jobId])
    await db.close()

    const newerAttempt = await boss.fetch(queue)

    assert.strictEqual(newerAttempt.id, jobId)

    release()
    await delay(500)

    const afterHandler = await helper.getJobById(schema, jobId)

    assert.strictEqual(afterHandler.state, 'active')
  })

  for (const batchOptions of [{}, { batchSize: 2 }]) {
    it(`should fail the job of a handler that throws synchronously${batchOptions.batchSize ? ' in batch mode' : ''}`, async function () {
      const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })
      const queue = this.test.bossConfig.schema
      const schema = this.test.bossConfig.schema

      const jobId = await boss.send(queue)

      await boss.work(queue, { newJobCheckInterval: 100, ...batchOptions }, () => {
        throw new Error('thrown synchronously')
      })

      await waitFor(async () => (await helper.getJobById(schema, jobId)).state === 'failed')

      const job = await helper.getJobById(schema, jobId)

      assert.strictEqual(job.output.message, 'thrown synchronously')
    })
  }
})
