const assert = require('assert')
const delay = require('delay')
const helper = require('./testHelper')
const PgBoss = require('../')

describe('stop', function () {
  const defaults = {
    noSupervisor: true,
    noScheduling: true
  }

  const waitFor = async (condition, timeout = 5000) => {
    const started = Date.now()

    while (!(await condition())) {
      if (Date.now() - started > timeout) {
        throw new Error('waitFor timed out')
      }

      await delay(50)
    }
  }

  const getState = async (schema, id) => (await helper.getJobById(schema, id)).state

  const startWithDb = async (config, db) => {
    const boss = new PgBoss({ ...config, ...defaults, db })
    boss.on('error', err => console.log({ schema: config.schema, message: err.message }))
    await boss.start()
    return boss
  }

  it('waits for jobs still running in a teamRefill worker before emitting stopped', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })
    const queue = this.test.bossConfig.schema

    const jobId = await boss.send(queue)

    await boss.work(queue, { teamSize: 2, teamConcurrency: 2, teamRefill: true, newJobCheckInterval: 100 }, () => delay(2500))

    await waitFor(async () => await getState(queue, jobId) === 'active')

    const stopped = new Promise(resolve => boss.once('stopped', resolve))

    await boss.stop({ timeout: 10000 })

    await stopped

    assert.strictEqual(await getState(queue, jobId), 'completed')
  })

  it('waits for a fetch in flight when stop() is called and the jobs it returns', async function () {
    const config = this.test.bossConfig
    const queue = config.schema
    const realDb = await helper.getDb()

    let fetchStarted
    const fetchStartedPromise = new Promise(resolve => { fetchStarted = resolve })

    const db = {
      executeSql: async (text, values) => {
        if (text.includes('SKIP LOCKED') && values && values[0] === queue) {
          fetchStarted()
          await delay(2500)
        }

        return await realDb.executeSql(text, values)
      }
    }

    const boss = await startWithDb(config, db)

    try {
      const jobId = await boss.send(queue)

      let handled = false

      await boss.work(queue, async () => {
        await delay(200)
        handled = true
      })

      await fetchStartedPromise

      let handledAtStopped = null
      const stopped = new Promise(resolve => boss.once('stopped', () => {
        handledAtStopped = handled
        resolve()
      }))

      await boss.stop({ timeout: 10000 })

      await stopped

      assert.strictEqual(handledAtStopped, true)
      assert.strictEqual(await getState(queue, jobId), 'completed')
    } finally {
      await realDb.close()
    }
  })

  it('fails the job when a team worker handler throws synchronously', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })
    const queue = this.test.bossConfig.schema

    const jobId1 = await boss.send(queue)
    const jobId2 = await boss.send(queue)

    await boss.work(queue, { teamSize: 2, teamConcurrency: 1, newJobCheckInterval: 100 }, () => { throw new Error('sync throw') })

    await waitFor(async () => await getState(queue, jobId1) === 'failed' && await getState(queue, jobId2) === 'failed')

    const job = await helper.getJobById(queue, jobId1)
    assert.strictEqual(job.output.message, 'sync throw')
  })

  it('fails the jobs when a batch worker handler throws synchronously', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })
    const queue = this.test.bossConfig.schema

    const jobId1 = await boss.send(queue)
    const jobId2 = await boss.send(queue)

    await boss.work(queue, { batchSize: 2, newJobCheckInterval: 100 }, () => { throw new Error('sync throw') })

    await waitFor(async () => await getState(queue, jobId1) === 'failed' && await getState(queue, jobId2) === 'failed')
  })

  const lateSettleTest = async (config, handler) => {
    const queue = config.schema
    const realDb = await helper.getDb()

    let jobId
    let intercepted
    const interceptedPromise = new Promise(resolve => { intercepted = resolve })
    let releaseGate
    const gate = new Promise(resolve => { releaseGate = resolve })
    let lateWriteDone
    const lateWriteDonePromise = new Promise(resolve => { lateWriteDone = resolve })
    let held = false

    const db = {
      executeSql: async (text, values) => {
        const isWorkerSettle = !held && values && Array.isArray(values[0]) && values[0].includes(jobId)

        if (!isWorkerSettle) {
          return await realDb.executeSql(text, values)
        }

        held = true
        intercepted()
        await gate

        try {
          return await realDb.executeSql(text, values)
        } finally {
          lateWriteDone()
        }
      }
    }

    const boss = await startWithDb(config, db)

    try {
      jobId = await boss.send(queue, null, { expireInSeconds: 1, retryLimit: 1 })

      await boss.work(queue, handler)

      await interceptedPromise
      await delay(1100)

      await boss.expire()

      assert.strictEqual(await getState(queue, jobId), 'retry')

      await delay(100)

      const [retried] = await boss.fetch(queue, 1)
      assert.strictEqual(retried.id, jobId)
      assert.strictEqual(await getState(queue, jobId), 'active')

      releaseGate()
      await lateWriteDonePromise

      const job = await helper.getJobById(queue, jobId)
      assert.strictEqual(job.state, 'active')
      assert.strictEqual(job.retrycount, 1)

      await boss.complete(jobId)
      assert.strictEqual(await getState(queue, jobId), 'completed')
    } finally {
      await boss.stop({ graceful: false })
      await realDb.close()
    }
  }

  it('does not let a late fail() from a worker land on a newer attempt of the same job', async function () {
    // the handler outlives expireIn, so the worker's own timeout fails it; that write is held back
    await lateSettleTest(this.test.bossConfig, () => new Promise(() => {}))
  })

  it('does not let a late complete() from a worker land on a newer attempt of the same job', async function () {
    await lateSettleTest(this.test.bossConfig, async () => {})
  })

  it('does not expose the attempt token on fetched or worked jobs', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })
    const queue = this.test.bossConfig.schema

    await boss.send(queue)
    const [fetched] = await boss.fetch(queue, 1, { includeMetadata: true })
    assert.strictEqual('pgboss_attempt' in fetched, false)

    await boss.send(queue)
    const single = await boss.fetch(queue)
    assert.strictEqual('pgboss_attempt' in single, false)

    await boss.send(queue)
    const worked = await new Promise(resolve => boss.work(queue, { newJobCheckInterval: 100 }, async job => resolve(job)))
    assert.strictEqual('pgboss_attempt' in worked, false)
  })

  it('can stop again after a stop failed', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })

    const bossStop = boss.boss.stop
    boss.boss.stop = async () => {
      boss.boss.stop = bossStop
      throw new Error('stop failed')
    }

    await assert.rejects(boss.stop({ graceful: false }), /stop failed/)

    const stopped = new Promise(resolve => boss.once('stopped', resolve))

    await boss.stop({ graceful: false })

    await Promise.race([stopped, delay(3000).then(() => { throw new Error('second stop did nothing') })])
  })

  it('can stop again after a graceful stop failed in the background', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })

    const bossStop = boss.boss.stop
    boss.boss.stop = async () => {
      boss.boss.stop = bossStop
      throw new Error('stop failed')
    }

    const failed = new Promise(resolve => boss.once('error', resolve))

    await boss.stop({ timeout: 1000 })

    const err = await failed
    assert.strictEqual(err.message, 'stop failed')

    const stopped = new Promise(resolve => boss.once('stopped', resolve))

    await boss.stop({ timeout: 1000 })

    await Promise.race([stopped, delay(5000).then(() => { throw new Error('second stop did nothing') })])
  })

  it('stops the maintenance worker after a restart', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, noScheduling: true })

    const activeMaintenanceWorkers = () => boss.manager.getWorkers()
      .filter(w => w.name === boss.getQueueNames().MAINTENANCE && !w.stopping && !w.stopped)

    const stop = async () => {
      const stopped = new Promise(resolve => boss.once('stopped', resolve))
      await boss.stop({ timeout: 1000 })
      await stopped
    }

    await stop()
    assert.strictEqual(activeMaintenanceWorkers().length, 0)

    await boss.start()
    assert.strictEqual(activeMaintenanceWorkers().length, 1)

    await stop()
    assert.strictEqual(activeMaintenanceWorkers().length, 0)
  })
})
