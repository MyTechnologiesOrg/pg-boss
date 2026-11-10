const assert = require('assert')
const delay = require('delay')
const { Client } = require('pg')
const helper = require('./testHelper')
const PgBoss = require('../')
const { ATTEMPT_STARTED_ON } = require('../src/plans')

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

  // Holds every statement that matches until open() is called: before it runs, or with its result
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

  // Counts the statements that complete or fail a worker's attempt from now on
  const countAttemptWrites = (boss) => {
    const executeSql = boss.db.executeSql.bind(boss.db)
    const writes = { count: 0 }

    boss.db.executeSql = async (text, values) => {
      if (text === boss.manager.completeActiveAttemptsCommand || text === boss.manager.failActiveAttemptsCommand) {
        writes.count++
      }

      return await executeSql(text, values)
    }

    return writes
  }

  // Past its retention, a queued singleton queue job no longer stands in for an active job's retry but
  // still holds the key, so failing the active job throws a unique violation (see useSingletonQueue)
  const pastRetention = async (schema, jobId) => {
    const db = await helper.getDb()
    await db.executeSql(`UPDATE ${schema}.job SET keepUntil = now() - interval '1 second' WHERE id = $1`, [jobId])
    await db.close()
  }

  const getStates = async (schema, queue) => {
    const { rows } = await helper.findJobs(schema, 'name = $1', [queue])
    return rows.map(job => job.state)
  }

  // As if the job expired and is ready to be fetched again, while its first handler keeps running
  const expireAttempt = async (schema, jobId) => {
    const db = await helper.getDb()
    await db.executeSql(`UPDATE ${schema}.job SET state = 'retry', startAfter = now() - interval '1 second' WHERE id = $1`, [jobId])
    await db.close()
  }

  const failFailActiveWrites = (boss) => {
    const executeSql = boss.db.executeSql.bind(boss.db)

    boss.db.executeSql = async (text, values) => {
      if (text === boss.manager.failActiveAttemptsCommand) {
        throw new Error('fail write failed')
      }

      return await executeSql(text, values)
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

  it('should emit a wip event without the job once a teamRefill job finishes', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })
    const queue = this.test.bossConfig.schema

    await boss.send(queue)

    const wipEvents = []

    boss.on('wip', data => wipEvents.push(data))

    await boss.work(queue, { teamSize: 2, teamRefill: true, newJobCheckInterval: 100 }, () => delay(200))

    await waitFor(async () => (await getStates(this.test.bossConfig.schema, queue)).join() === 'completed')
    await waitFor(() => boss.manager.getWipData().length === 0)

    // wip events are debounced for up to 2s
    await delay(2500)

    assert.strictEqual(wipEvents[0][0].count, 1)
    assert.deepStrictEqual(wipEvents[wipEvents.length - 1], [])
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

  it('should start a new stop when stop() is called after a stop fails', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })

    const supervisorStop = boss.boss.stop.bind(boss.boss)
    let failures = 0

    boss.boss.stop = async () => {
      if (failures++ === 0) {
        throw new Error('supervisor stop failed')
      }

      return await supervisorStop()
    }

    await assert.rejects(boss.stop({ graceful: false }), { message: 'supervisor stop failed' })

    assert.strictEqual(boss.stopped, false)

    await boss.stop({ graceful: false })

    assert(boss.stopped)
  })

  it('should stop the maintenance worker again after a restart', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, noScheduling: true })

    await boss.stop({ graceful: false })
    await boss.start()

    const [maintenance] = boss.manager.getWorkers().filter(worker => worker.name === '__pgboss__maintenance' && !worker.stopping && !worker.stopped)

    assert(maintenance)

    await boss.stop({ graceful: false })

    assert(maintenance.stopping || maintenance.stopped)
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

  it('should let a later stop() end the wait of a running stop, fail its jobs and close the pool', async function () {
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
    // The running stop is between its checks of the workers
    await waitFor(() => boss.currentStop.sleep !== null)

    const joinedOn = Date.now()

    await boss.stop({ graceful: false, failActive: true, destroy: true })

    // The later stop() cuts short the sleep between the running stop's checks
    assert(Date.now() - joinedOn < 500, `the later stop() took ${Date.now() - joinedOn}ms`)
    assert(boss.stopped)
    assert.strictEqual(boss.db.opened, false)

    // Failed before the pool closed, or the write would have been dropped
    const job = await helper.getJobById(schema, jobId)

    assert.strictEqual(job.state, 'retry')

    release()
  })

  it('should return straight away from a later stop() without wait', async function () {
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

    await boss.stop({ timeout: 30000 })

    const returned = await Promise.race([
      boss.stop({ timeout: 20000 }).then(() => true),
      delay(500).then(() => false)
    ])

    assert(returned)
    assert.strictEqual(boss.stopped, false)

    release()

    await boss.stop({ wait: true })

    assert(boss.stopped)
  })

  it('should stop at the deadline of a later stop() that joins while the supervisor is stopping', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })

    const supervisorStop = boss.boss.stop.bind(boss.boss)

    let open
    let reach
    const opened = new Promise(resolve => { open = resolve })
    const reached = new Promise(resolve => { reach = resolve })

    boss.boss.stop = async () => {
      reach()
      await opened
      return await supervisorStop()
    }

    await boss.stop({ timeout: 30000 })
    await reached

    const joined = boss.stop({ graceful: false })

    open()

    const openedOn = Date.now()

    await joined

    assert(Date.now() - openedOn < 500, `stopped ${Date.now() - openedOn}ms after the supervisor stopped`)
    assert(boss.stopped)
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

    const writes = countAttemptWrites(boss)

    release()
    await delay(500)

    // The released worker doesn't try to record the handler's late result
    assert.strictEqual(writes.count, 0)
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

    const writes = countAttemptWrites(boss)

    release()
    await delay(500)

    assert.strictEqual(started, 1)
    assert.strictEqual(writes.count, 0)
  })

  it('should run the rest of a team when recording a failure fails', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })
    const queue = this.test.bossConfig.schema
    const schema = this.test.bossConfig.schema

    await boss.send(queue)
    await boss.send(queue)

    const executeSql = boss.db.executeSql.bind(boss.db)
    let failWrites = 0

    boss.db.executeSql = async (text, values) => {
      if (text === boss.manager.failActiveAttemptsCommand && failWrites++ === 0) {
        throw new Error('fail write failed')
      }

      return await executeSql(text, values)
    }

    const startedIds = []

    await boss.work(queue, { teamSize: 2, teamConcurrency: 1, newJobCheckInterval: 100 }, async (job) => {
      startedIds.push(job.id)

      if (startedIds.length === 1) {
        throw new Error('handler failed')
      }
    })

    await waitFor(() => startedIds.length === 2)
    await waitFor(() => boss.manager.getWipData().length === 0)

    assert.strictEqual((await helper.getJobById(schema, startedIds[0])).state, 'active')
    assert.strictEqual((await helper.getJobById(schema, startedIds[1])).state, 'completed')
  })

  it('should fail the running job of a teamRefill worker when failActive is true', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })
    const queue = this.test.bossConfig.schema
    const schema = this.test.bossConfig.schema

    await boss.send(queue, null, { retryLimit: 1, retryDelay: 60 })
    await boss.send(queue, null, { retryLimit: 1, retryDelay: 60 })

    const startedIds = []
    let release
    const released = new Promise(resolve => { release = resolve })

    await boss.work(queue, { teamSize: 2, teamConcurrency: 1, teamRefill: true, newJobCheckInterval: 100 }, async (job) => {
      startedIds.push(job.id)

      if (startedIds.length > 1) {
        await released
      }
    })

    // The first job's completion is recorded, so onFetch has returned while the second job runs
    await waitFor(() => startedIds.length === 2)

    await boss.stop({ graceful: false, failActive: true })

    assert.strictEqual((await helper.getJobById(schema, startedIds[0])).state, 'completed')
    assert.strictEqual((await helper.getJobById(schema, startedIds[1])).state, 'retry')

    release()
  })

  it('should fail the jobs of an onComplete() worker when failActive is true', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })
    const queue = this.test.bossConfig.schema
    const schema = this.test.bossConfig.schema

    await boss.send(queue, null, { onComplete: true })

    const job = await boss.fetch(queue)

    await boss.complete(job.id)

    let release
    let started = false

    await boss.onComplete(queue, { newJobCheckInterval: 100 }, () => {
      started = true
      return new Promise(resolve => { release = resolve })
    })

    await waitFor(() => started)

    await boss.stop({ graceful: false, failActive: true })

    const { rows: [completionJob] } = await helper.findJobs(schema, 'name = $1', [helper.COMPLETION_JOB_PREFIX + queue])

    assert.strictEqual(completionJob.state, 'failed')
    assert.strictEqual(completionJob.output.message, 'pg-boss stopped before the job finished')

    release()
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

    const writes = countAttemptWrites(boss)

    release()
    await delay(500)

    assert.strictEqual(writes.count, 0)
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

  it('should fail a maintenance job still running when failActive is true', async function () {
    const schema = this.test.bossConfig.schema
    const boss = this.test.boss = new PgBoss({ ...this.test.bossConfig, noScheduling: true })

    boss.on('error', err => console.log({ schema, message: err.message }))

    // Holds the maintenance handler in its first statement
    const archiving = holdStatement(boss, text => text === boss.boss.archiveCommand, { before: true })

    await boss.start()
    await archiving.reached

    const { rows } = await helper.findJobs(schema, 'name = $1 AND state = $2', ['__pgboss__maintenance', 'active'])

    assert.strictEqual(rows.length, 1)

    await boss.stop({ graceful: false, failActive: true })

    const job = await helper.getJobById(schema, rows[0].id)

    assert.strictEqual(job.state, 'failed')
    assert.strictEqual(job.output.message, 'pg-boss stopped before the job finished')

    archiving.open()
  })

  it('should fail the other jobs when failing one of them fails and failActive is true', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })
    const schema = this.test.bossConfig.schema
    const singletonQueue = `${schema}-singleton`
    const otherQueue = `${schema}-other`

    const singletonId = await boss.send(singletonQueue, null, { singletonKey: 'key', useSingletonQueue: true, retryLimit: 1, retryDelay: 60 })
    const otherId = await boss.send(otherQueue, null, { retryLimit: 1, retryDelay: 60 })

    let started = 0
    let release
    const released = new Promise(resolve => { release = resolve })

    const handler = async () => {
      started++
      await released
    }

    await boss.work(singletonQueue, { newJobCheckInterval: 100 }, handler)
    await boss.work(otherQueue, { newJobCheckInterval: 100 }, handler)

    await waitFor(() => started === 2)

    await pastRetention(schema, await boss.send(singletonQueue, null, { singletonKey: 'key', useSingletonQueue: true }))

    await assert.rejects(boss.stop({ graceful: false, failActive: true }), { constraint: 'job_singleton_queue' })

    assert.strictEqual((await helper.getJobById(schema, otherId)).state, 'retry')
    assert.strictEqual((await helper.getJobById(schema, singletonId)).state, 'active')

    release()
  })

  it('should fail same-key singleton queue jobs one at a time when failing another job fails', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })
    const schema = this.test.bossConfig.schema
    const collidingQueue = `${schema}-colliding`
    const pairQueue = `${schema}-pair`
    const singletonOptions = { useSingletonQueue: true, retryLimit: 1, retryDelay: 60 }

    const collidingId = await boss.send(collidingQueue, null, { ...singletonOptions, singletonKey: 'colliding' })

    let started = 0
    let release
    const released = new Promise(resolve => { release = resolve })

    const handler = async () => {
      started++
      await released
    }

    await boss.work(collidingQueue, { newJobCheckInterval: 100 }, handler)
    await boss.work(pairQueue, { newJobCheckInterval: 100 }, handler)
    await boss.work(pairQueue, { newJobCheckInterval: 100 }, handler)

    // A singleton queue holds one queued job per key, so the second job is sent once the first is active
    const pairIds = [await boss.send(pairQueue, null, { ...singletonOptions, singletonKey: 'pair' })]
    await waitFor(() => started === 2)
    pairIds.push(await boss.send(pairQueue, null, { ...singletonOptions, singletonKey: 'pair' }))
    await waitFor(() => started === 3)

    await pastRetention(schema, await boss.send(collidingQueue, null, { ...singletonOptions, singletonKey: 'colliding' }))

    // Each fail write is held briefly, so writes made at the same time would overlap
    const executeSql = boss.db.executeSql.bind(boss.db)
    let writing = 0
    let mostWriting = 0

    boss.db.executeSql = async (text, values) => {
      if (text !== boss.manager.failActiveAttemptsCommand) {
        return await executeSql(text, values)
      }

      writing++
      mostWriting = Math.max(mostWriting, writing)

      try {
        await delay(50)
        return await executeSql(text, values)
      } finally {
        writing--
      }
    }

    await assert.rejects(boss.stop({ graceful: false, failActive: true }), err => {
      assert.strictEqual(err.constraint, 'job_singleton_queue')
      assert(err.detail.includes(collidingQueue), err.detail)
      return true
    })

    assert.strictEqual(mostWriting, 1)
    assert.strictEqual((await helper.getJobById(schema, collidingId)).state, 'active')

    // As in a single statement, one job retries and the other ends failed, since its retry would collide
    const pairStates = await Promise.all(pairIds.map(async id => (await helper.getJobById(schema, id)).state))

    assert.deepStrictEqual(pairStates.sort(), ['failed', 'retry'])

    release()
  })

  it('should finish the stop before reporting a failActive error', async function () {
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

    failFailActiveWrites(boss)

    let stoppedEmitted = false

    boss.once('stopped', () => { stoppedEmitted = true })

    await assert.rejects(boss.stop({ graceful: false, failActive: true }), { message: 'fail write failed' })

    assert(stoppedEmitted)
    assert(boss.stopped)

    release()
    await delay(500)

    // stop() took the job, so its handler's result isn't recorded even though failing the job failed
    const job = await helper.getJobById(schema, jobId)

    assert.strictEqual(job.state, 'active')
    assert.strictEqual(job.output, null)
  })

  it('should start again after a stop whose failActive writes fail', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })
    const queue = this.test.bossConfig.schema
    const schema = this.test.bossConfig.schema

    await boss.send(queue)

    let release
    let started = false

    await boss.work(queue, { newJobCheckInterval: 100 }, () => {
      started = true
      return new Promise(resolve => { release = resolve })
    })

    await waitFor(() => started)

    failFailActiveWrites(boss)

    await assert.rejects(boss.stop({ graceful: false, failActive: true }), { message: 'fail write failed' })

    await boss.start()

    const jobId = await boss.send(queue)

    await boss.work(queue, { newJobCheckInterval: 100 }, async () => {})

    await waitFor(async () => (await helper.getJobById(schema, jobId)).state === 'completed')

    release()
  })

  it('should emit a failActive error once from a graceful stop() without wait', async function () {
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

    failFailActiveWrites(boss)

    const errors = []

    boss.on('error', err => errors.push(err.message))

    const stopped = new Promise(resolve => boss.once('stopped', resolve))

    await boss.stop({ timeout: 1000, failActive: true })
    await stopped
    await delay(100)

    assert.deepStrictEqual(errors, ['fail write failed'])

    release()
  })

  it('should report a failActive error only to a later stop() that waits for it', async function () {
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

    failFailActiveWrites(boss)

    const errors = []

    boss.on('error', err => errors.push(err.message))

    await boss.stop({ timeout: 30000 })

    await assert.rejects(boss.stop({ graceful: false, failActive: true }), { message: 'fail write failed' })

    await delay(100)

    assert.deepStrictEqual(errors, [])

    release()
  })

  it('should leave a newer attempt of the job alone when failActive is true', async function () {
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

    await expireAttempt(schema, jobId)

    const newerAttempt = await boss.fetch(queue)

    assert.strictEqual(newerAttempt.id, jobId)

    await boss.stop({ graceful: false, failActive: true })

    const job = await helper.getJobById(schema, jobId)

    assert.strictEqual(job.state, 'active')
    assert.strictEqual(job.retrycount, 1)

    release()
  })

  for (const outcome of ['resolves', 'throws']) {
    it(`should leave a newer attempt of the job alone when the earlier handler ${outcome}`, async function () {
      const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })
      const queue = this.test.bossConfig.schema
      const schema = this.test.bossConfig.schema

      const jobId = await boss.send(queue)

      let settle
      let started = false

      await boss.work(queue, { newJobCheckInterval: 100 }, () => {
        started = true
        return new Promise((resolve, reject) => {
          settle = outcome === 'resolves' ? () => resolve('late result') : () => reject(new Error('late failure'))
        })
      })

      await waitFor(() => started)

      await expireAttempt(schema, jobId)

      const newerAttempt = await boss.fetch(queue)

      assert.strictEqual(newerAttempt.id, jobId)

      settle()

      // The worker lets go of the job once its write has run
      await waitFor(() => boss.manager.getWipData().length === 0)

      const job = await helper.getJobById(schema, jobId)

      assert.strictEqual(job.state, 'active')
      assert.strictEqual(job.retrycount, 1)
      assert.strictEqual(job.output, null)
    })
  }

  it('should record nothing when a handler fails after its job left active', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })
    const queue = this.test.bossConfig.schema
    const schema = this.test.bossConfig.schema

    const jobId = await boss.send(queue, null, { retryLimit: 1 })

    let fail
    let started = false

    await boss.work(queue, { newJobCheckInterval: 100 }, () => {
      started = true
      return new Promise((resolve, reject) => { fail = () => reject(new Error('late failure')) })
    })

    await waitFor(() => started)

    // As if the job expired into retry, with a retry time far enough out that the worker doesn't fetch it again
    const db = await helper.getDb()
    await db.executeSql(`UPDATE ${schema}.job SET state = 'retry', startAfter = now() + interval '1 hour' WHERE id = $1`, [jobId])
    await db.close()

    const expired = await helper.getJobById(schema, jobId)

    fail()

    await waitFor(() => boss.manager.getWipData().length === 0)

    const job = await helper.getJobById(schema, jobId)

    assert.strictEqual(job.state, 'retry')
    assert.strictEqual(job.output, null)
    assert.strictEqual(job.startafter.getTime(), expired.startafter.getTime())
  })

  const lockedChanges = {
    'moves it to retry': { set: "state = 'retry'", state: 'retry' },
    'fetches it again': { set: 'startedOn = now(), retryCount = retryCount + 1', state: 'active' }
  }

  for (const [change, { set, state }] of Object.entries(lockedChanges)) {
    it(`should leave the job alone when failActive waits for its row lock while another transaction ${change}`, async function () {
      const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })
      const queue = this.test.bossConfig.schema
      const schema = this.test.bossConfig.schema

      const jobId = await boss.send(queue, null, { retryLimit: 1 })

      let release
      let started = false

      await boss.work(queue, { newJobCheckInterval: 100 }, () => {
        started = true
        return new Promise(resolve => { release = resolve })
      })

      await waitFor(() => started)

      const locker = new Client(helper.getConfig())
      const db = await helper.getDb()

      let stopped

      try {
        await locker.connect()
        await locker.query('BEGIN')
        await locker.query(`SELECT id FROM ${schema}.job WHERE id = $1 FOR UPDATE`, [jobId])

        const { rows: [{ pid }] } = await locker.query('SELECT pg_backend_pid() AS pid')

        stopped = boss.stop({ graceful: false, failActive: true })

        // failActive's write has read the job as active and now waits for the lock
        await waitFor(async () => {
          const { rows } = await db.executeSql('SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [pid])
          return rows.length > 0
        })

        await locker.query(`UPDATE ${schema}.job SET ${set} WHERE id = $1`, [jobId])
        await locker.query('COMMIT')
      } finally {
        await locker.end()
        await db.close()
      }

      await stopped

      const job = await helper.getJobById(schema, jobId)

      assert.strictEqual(job.state, state)
      assert.strictEqual(job.output, null)

      release()
    })
  }

  for (const batchOptions of [{}, { batchSize: 2 }]) {
    it(`should keep the attempt it tracks off the jobs a handler sees${batchOptions.batchSize ? ' in batch mode' : ''}`, async function () {
      const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })
      const queue = this.test.bossConfig.schema

      await boss.send(queue)

      let seen = null

      await boss.work(queue, { includeMetadata: true, newJobCheckInterval: 100, ...batchOptions }, async (value) => {
        seen = [].concat(value)
      })

      await waitFor(() => seen)

      for (const job of seen) {
        assert(job.startedon)
        assert(!(ATTEMPT_STARTED_ON in job))
      }
    })
  }

  it('should let go of the jobs of a worker whose onFetch throws', async function () {
    const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults, __test__throw_worker: true })
    const queue = this.test.bossConfig.schema

    await boss.send(queue)

    const errored = new Promise(resolve => boss.once('error', resolve))

    await boss.work(queue, { newJobCheckInterval: 100 }, () => {})
    await errored

    assert.deepStrictEqual(boss.manager.getWipData(), [])

    const [worker] = boss.manager.getWorkers()
    const stopStartedOn = Date.now()

    await boss.stop({ timeout: 8000, wait: true })

    assert(Date.now() - stopStartedOn < 4000, `stopped after ${Date.now() - stopStartedOn}ms`)
    assert(worker.stopped)
  })

  const batchChanges = {
    replaces: jobs => {
      for (let i = 0; i < jobs.length; i++) {
        jobs[i] = { ...jobs[i] }
      }
    },
    empties: jobs => {
      jobs.length = 0
    }
  }

  for (const [change, changeJobs] of Object.entries(batchChanges)) {
    it(`should record the results of a batch whose handler ${change} its jobs`, async function () {
      const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })
      const queue = this.test.bossConfig.schema
      const schema = this.test.bossConfig.schema

      await boss.send(queue)
      await boss.send(queue)

      const errors = []

      boss.on('error', err => errors.push(err.message))

      await boss.work(queue, { batchSize: 2, newJobCheckInterval: 100 }, async (jobs) => {
        changeJobs(jobs)
      })

      await waitFor(async () => (await getStates(schema, queue)).join() === 'completed,completed')
      await waitFor(() => boss.manager.getWipData().length === 0)

      assert.deepStrictEqual(errors, [])
    })
  }

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
