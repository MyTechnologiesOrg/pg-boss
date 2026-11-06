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

  // Holds the first statement that matches until open() is called: before it runs, or with its result
  const holdStatement = (boss, matches, { before = false } = {}) => {
    const executeSql = boss.db.executeSql.bind(boss.db)

    let open
    let reach
    const opened = new Promise(resolve => { open = resolve })
    const reached = new Promise(resolve => { reach = resolve })

    boss.db.executeSql = async (text, values) => {
      if (!matches(text)) {
        return await executeSql(text, values)
      }

      if (before) {
        reach()
        await opened
        return await executeSql(text, values)
      }

      const result = await executeSql(text, values)
      reach()
      await opened
      return result
    }

    return { reached, open }
  }

  const getStates = async (schema, queue) => {
    const { rows } = await helper.findJobs(schema, 'name = $1', [queue])
    return rows.map(job => job.state)
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

  it('should keep a teamRefill worker until its jobs finish after offWork()', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })
    const queue = this.test.bossConfig.schema

    await boss.send(queue)
    await boss.send(queue)

    let started = 0
    let finished = 0

    await boss.work(queue, { teamSize: 2, teamConcurrency: 2, teamRefill: true, newJobCheckInterval: 100 }, async () => {
      started++
      await delay(started === 1 ? 100 : 2000)
      finished++
    })

    // The first job's completion has been recorded and the second job is still running
    await waitFor(() => finished === 1 && boss.manager.getWipData()[0].count === 1)

    await boss.offWork(queue)

    const [wip] = boss.manager.getWipData()

    assert.strictEqual(wip.count, 1)
    assert.strictEqual(wip.state, 'stopping')

    await waitFor(() => boss.manager.getWorkers().length === 0, 5000)

    assert.strictEqual(finished, 2)
    assert.deepStrictEqual(await getStates(this.test.bossConfig.schema, queue), ['completed', 'completed'])
  })

  it('should resolve stop() once stopped when wait is true', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })
    const queue = this.test.bossConfig.schema

    await boss.send(queue)

    let started = false
    let finished = false
    let stoppedEmitted = false

    boss.once('stopped', () => { stoppedEmitted = true })

    await boss.work(queue, { newJobCheckInterval: 100 }, async () => {
      started = true
      await delay(1500)
      finished = true
    })

    await waitFor(() => started)

    await boss.stop({ timeout: 8000, wait: true })

    assert(finished)
    assert(stoppedEmitted)
  })

  it('should reject stop() when wait is true and the stop fails', async function () {
    const boss = await helper.start({ ...this.test.bossConfig, ...defaults, __test__throw_stop: 'boss stop failed' })

    await assert.rejects(boss.stop({ timeout: 1000, wait: true }), { message: 'boss stop failed' })

    await boss.db.close()
  })

  it('should let a later stop() with wait: true wait for the running stop', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })
    const queue = this.test.bossConfig.schema

    await boss.send(queue)

    let started = false
    let finished = false
    let stoppedEmitted = false

    boss.once('stopped', () => { stoppedEmitted = true })

    await boss.work(queue, { newJobCheckInterval: 100 }, async () => {
      started = true
      await delay(1500)
      finished = true
    })

    await waitFor(() => started)

    await boss.stop({ timeout: 8000 })
    await boss.stop({ wait: true })

    assert(finished)
    assert(stoppedEmitted)
  })

  it('should let a later stop() end the wait of a running stop and fail its jobs', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })
    const queue = this.test.bossConfig.schema
    const schema = this.test.bossConfig.schema

    const jobId = await boss.send(queue, null, { retryLimit: 1, retryDelay: 60 })

    let release
    let started = false

    await boss.work(queue, { newJobCheckInterval: 100 }, () => {
      started = true
      return new Promise(resolve => { release = resolve })
    })

    await waitFor(() => started)

    await boss.stop({ timeout: 30000 })
    await boss.stop({ graceful: false, failActive: true })

    assert(boss.stopped)

    const job = await helper.getJobById(schema, jobId)

    assert.strictEqual(job.state, 'retry')

    release()
  })

  it('should fail jobs still running at the timeout when failActive is true', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })
    const queue = this.test.bossConfig.schema
    const schema = this.test.bossConfig.schema

    const jobId = await boss.send(queue, null, { retryLimit: 1, retryDelay: 60 })

    let release
    let started = false

    await boss.work(queue, { newJobCheckInterval: 100 }, () => {
      started = true
      return new Promise(resolve => { release = resolve })
    })

    await waitFor(() => started)

    await boss.stop({ timeout: 1000, wait: true, failActive: true })

    const failed = await helper.getJobById(schema, jobId)

    assert.strictEqual(failed.state, 'retry')
    assert.strictEqual(failed.output.message, 'pg-boss stopped before the job finished')

    release()
    await delay(500)

    const afterHandler = await helper.getJobById(schema, jobId)

    assert.strictEqual(afterHandler.state, 'retry')
  })

  it('should fail queued team jobs without starting them when failActive is true', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })
    const queue = this.test.bossConfig.schema

    for (let i = 0; i < 3; i++) {
      await boss.send(queue, null, { retryLimit: 1, retryDelay: 60 })
    }

    let started = 0
    let release
    const released = new Promise(resolve => { release = resolve })

    await boss.work(queue, { teamSize: 3, teamConcurrency: 1, newJobCheckInterval: 100 }, async () => {
      started++
      await released
    })

    await waitFor(() => started === 1)

    await boss.stop({ graceful: false, failActive: true })

    assert.deepStrictEqual(await getStates(this.test.bossConfig.schema, queue), ['retry', 'retry', 'retry'])

    release()
    await delay(500)

    assert.strictEqual(started, 1)
    assert.deepStrictEqual(await getStates(this.test.bossConfig.schema, queue), ['retry', 'retry', 'retry'])
  })

  it('should fail a batch still running at the timeout when failActive is true', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })
    const queue = this.test.bossConfig.schema

    await boss.send(queue, null, { retryLimit: 1, retryDelay: 60 })
    await boss.send(queue, null, { retryLimit: 1, retryDelay: 60 })

    let release
    let started = false

    await boss.work(queue, { batchSize: 2, newJobCheckInterval: 100 }, () => {
      started = true
      return new Promise(resolve => { release = resolve })
    })

    await waitFor(() => started)

    await boss.stop({ timeout: 1000, wait: true, failActive: true })

    assert.deepStrictEqual(await getStates(this.test.bossConfig.schema, queue), ['retry', 'retry'])

    release()
    await delay(500)

    assert.deepStrictEqual(await getStates(this.test.bossConfig.schema, queue), ['retry', 'retry'])
  })

  it('should keep the result a worker is recording when failActive is true', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })
    const queue = this.test.bossConfig.schema
    const schema = this.test.bossConfig.schema

    const jobId = await boss.send(queue, null, { retryLimit: 1, retryDelay: 60 })

    const completing = holdStatement(boss, text => text === boss.manager.completeActiveAttemptsCommand, { before: true })

    await boss.work(queue, { newJobCheckInterval: 100 }, async () => 'done')

    await completing.reached

    let stopped = false
    const stopping = boss.stop({ graceful: false, failActive: true, destroy: true }).then(() => { stopped = true })

    await delay(300)

    assert.strictEqual(stopped, false)

    completing.open()
    await stopping

    assert.strictEqual((await helper.getJobById(schema, jobId)).state, 'completed')
    assert.strictEqual(boss.db.opened, false)
  })

  it('should fail jobs from a fetch still in flight when failActive is true', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })
    const queue = this.test.bossConfig.schema
    const schema = this.test.bossConfig.schema

    const jobId = await boss.send(queue, null, { retryLimit: 1, retryDelay: 60 })

    const fetchCommand = boss.manager.nextJobCommand(false, false, true)
    const fetching = holdStatement(boss, text => text === fetchCommand)

    let started = false

    await boss.work(queue, { newJobCheckInterval: 100 }, () => { started = true })

    await fetching.reached

    const stopping = boss.stop({ graceful: false, failActive: true })

    await delay(200)
    fetching.open()
    await stopping

    const job = await helper.getJobById(schema, jobId)

    assert.strictEqual(job.state, 'retry')
    assert.strictEqual(job.output.message, 'pg-boss stopped before the job finished')

    await delay(300)

    assert.strictEqual(started, false)
  })

  for (const failActive of [false, true]) {
    it(`should wait for a fetch still in flight during a graceful stop${failActive ? ' when failActive is true' : ''}`, async function () {
      const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })
      const queue = this.test.bossConfig.schema
      const schema = this.test.bossConfig.schema

      const jobId = await boss.send(queue)

      const fetchCommand = boss.manager.nextJobCommand(false, false, true)
      const fetching = holdStatement(boss, text => text === fetchCommand)

      let started = false

      await boss.work(queue, { newJobCheckInterval: 100 }, () => { started = true })

      await fetching.reached

      let stopped = false
      const stopping = boss.stop({ timeout: 10000, wait: true, failActive }).then(() => { stopped = true })

      // Past the stop's first two checks, a second apart
      await delay(2500)

      assert.strictEqual(stopped, false)

      fetching.open()
      await stopping

      assert(started)
      assert.strictEqual((await helper.getJobById(schema, jobId)).state, 'completed')
    })
  }

  it('should finish the stop before reporting a failActive error', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })
    const queue = this.test.bossConfig.schema

    await boss.send(queue)

    let release
    let started = false

    await boss.work(queue, { newJobCheckInterval: 100 }, () => {
      started = true
      return new Promise(resolve => { release = resolve })
    })

    await waitFor(() => started)

    const executeSql = boss.db.executeSql.bind(boss.db)

    boss.db.executeSql = async (text, values) => {
      if (text === boss.manager.failActiveAttemptsCommand) {
        throw new Error('fail write failed')
      }

      return await executeSql(text, values)
    }

    let stoppedEmitted = false

    boss.once('stopped', () => { stoppedEmitted = true })

    await assert.rejects(boss.stop({ graceful: false, failActive: true }), { message: 'fail write failed' })

    assert(stoppedEmitted)
    assert(boss.stopped)

    release()
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

    await boss.stop({ graceful: false, failActive: true })

    const afterStop = await helper.getJobById(schema, jobId)

    assert.strictEqual(afterStop.state, 'active')
    assert.strictEqual(afterStop.retrycount, 1)

    release()
    await delay(500)

    const afterHandler = await helper.getJobById(schema, jobId)

    assert.strictEqual(afterHandler.state, 'active')
  })

  it('should record the results of a batch whose handler replaces its jobs', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })
    const queue = this.test.bossConfig.schema
    const schema = this.test.bossConfig.schema

    await boss.send(queue)
    await boss.send(queue)

    await boss.work(queue, { batchSize: 2, newJobCheckInterval: 100 }, async (jobs) => {
      for (let i = 0; i < jobs.length; i++) {
        jobs[i] = { ...jobs[i] }
      }
    })

    await waitFor(async () => (await getStates(schema, queue)).join() === 'completed,completed')
    await waitFor(() => boss.manager.getWipData().length === 0)
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
