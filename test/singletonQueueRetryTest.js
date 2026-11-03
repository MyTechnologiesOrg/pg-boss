const assert = require('assert')
const { randomUUID } = require('crypto')
const helper = require('./testHelper')
const pg = require('pg')

describe('singleton queue retry collisions', function () {
  const queueOptions = { singletonKey: 'myKey', useSingletonQueue: true, retryLimit: 2 }
  const enforce = { enforceSingletonQueueActiveLimit: true }

  async function startBoss (test) {
    return (test.boss = await helper.start({ ...test.bossConfig, noSupervisor: true, onComplete: true }))
  }

  async function makeOverdue (schema, ids) {
    const db = await helper.getDb()
    await db.executeSql(`UPDATE ${schema}.job SET startedOn = now() - interval '1 hour' WHERE id = ANY($1::uuid[])`, [ids])
    await db.close()
  }

  async function setColumn (schema, id, assignment) {
    const db = await helper.getDb()
    await db.executeSql(`UPDATE ${schema}.job SET ${assignment} WHERE id = $1`, [id])
    await db.close()
  }

  async function holdUpdateWhile (schema, id, assignment, run) {
    const client = new pg.Client({ connectionString: helper.getConnectionString() })
    await client.connect()

    try {
      await client.query('BEGIN')
      await client.query(`UPDATE ${schema}.job SET ${assignment} WHERE id = $1`, [id])

      const running = run()
      await new Promise((resolve) => setTimeout(resolve, 500))
      await client.query('COMMIT')
      return await running
    } finally {
      await client.end()
    }
  }

  async function getState (schema, id) {
    const job = await helper.getJobById(schema, id)
    return { state: job.state, retryCount: job.retrycount }
  }

  async function getCompletionStates (schema, queue, id) {
    const result = await helper.findJobs(schema, "name = $1 AND data->'request'->>'id' = $2", [helper.COMPLETION_JOB_PREFIX + queue, id])
    return result.rows.map(({ data }) => ({ state: data.state, failed: data.failed }))
  }

  async function activeWithQueuedSibling (boss, queue) {
    const activeId = await boss.send(queue, null, queueOptions)
    const job = await boss.fetch(queue, undefined, enforce)
    assert.strictEqual(job.id, activeId)

    const siblingId = await boss.send(queue, null, queueOptions)
    assert(siblingId)

    assert.strictEqual(await boss.fetch(queue, undefined, enforce), null)

    return { activeId, siblingId }
  }

  it('fail() fails an active job whose retry would collide with a queued sibling', async function () {
    const boss = await startBoss(this.test)
    const { schema } = this.test.bossConfig
    const queue = 'sq-fail-collision'

    const { activeId, siblingId } = await activeWithQueuedSibling(boss, queue)

    const result = await boss.fail(activeId, new Error('boom'))
    assert.strictEqual(result.updated, 1)

    assert.deepStrictEqual(await getState(schema, activeId), { state: 'failed', retryCount: 0 })
    assert.strictEqual((await helper.getJobById(schema, activeId)).output.message, 'boom')
    assert.deepStrictEqual(await getCompletionStates(schema, queue, activeId), [{ state: 'failed', failed: true }])

    const next = await boss.fetch(queue, undefined, enforce)
    assert.strictEqual(next.id, siblingId)
  })

  it('expire() expires an active job whose retry would collide and still processes other queues', async function () {
    const boss = await startBoss(this.test)
    const { schema } = this.test.bossConfig
    const queue = 'sq-expire-collision'
    const otherQueue = 'sq-expire-other'

    const { activeId, siblingId } = await activeWithQueuedSibling(boss, queue)

    const otherId = await boss.send(otherQueue, null, { retryLimit: 1 })
    await boss.fetch(otherQueue)

    await makeOverdue(schema, [activeId, otherId])

    await boss.expire()

    assert.deepStrictEqual(await getState(schema, activeId), { state: 'expired', retryCount: 0 })
    assert.deepStrictEqual(await getCompletionStates(schema, queue, activeId), [{ state: 'expired', failed: true }])
    assert.strictEqual((await getState(schema, otherId)).state, 'retry')

    const next = await boss.fetch(queue, undefined, enforce)
    assert.strictEqual(next.id, siblingId)
  })

  it('fail() still retries a singleton queue job with no queued sibling', async function () {
    const boss = await startBoss(this.test)
    const { schema } = this.test.bossConfig
    const queue = 'sq-fail-no-sibling'

    const jobId = await boss.send(queue, null, queueOptions)
    await boss.fetch(queue, undefined, enforce)

    await boss.fail(jobId)

    assert.deepStrictEqual(await getState(schema, jobId), { state: 'retry', retryCount: 0 })
    assert.deepStrictEqual(await getCompletionStates(schema, queue, jobId), [])

    const retried = await boss.fetch(queue, undefined, enforce)
    assert.strictEqual(retried.id, jobId)
    assert.strictEqual((await getState(schema, jobId)).retryCount, 1)
  })

  it('expire() still retries a singleton queue job with no queued sibling', async function () {
    const boss = await startBoss(this.test)
    const { schema } = this.test.bossConfig
    const queue = 'sq-expire-no-sibling'

    const jobId = await boss.send(queue, null, queueOptions)
    await boss.fetch(queue, undefined, enforce)
    await makeOverdue(schema, [jobId])

    await boss.expire()

    assert.deepStrictEqual(await getState(schema, jobId), { state: 'retry', retryCount: 0 })

    const retried = await boss.fetch(queue, undefined, enforce)
    assert.strictEqual(retried.id, jobId)
    assert.strictEqual((await getState(schema, jobId)).retryCount, 1)
  })

  it('fail() still retries a queued singleton queue job', async function () {
    const boss = await startBoss(this.test)
    const { schema } = this.test.bossConfig
    const queue = 'sq-fail-queued'

    const jobId = await boss.send(queue, null, queueOptions)

    await boss.fail(jobId)

    assert.strictEqual((await getState(schema, jobId)).state, 'retry')
  })

  it('fail() on an active job and its queued sibling together retries only the sibling', async function () {
    const boss = await startBoss(this.test)
    const { schema } = this.test.bossConfig
    const queue = 'sq-fail-batch'

    const { activeId, siblingId } = await activeWithQueuedSibling(boss, queue)

    await boss.fail([activeId, siblingId])

    assert.strictEqual((await getState(schema, activeId)).state, 'failed')
    assert.strictEqual((await getState(schema, siblingId)).state, 'retry')
  })

  it('fail() on an active job and an exhausted queued sibling together fails both', async function () {
    const boss = await startBoss(this.test)
    const { schema } = this.test.bossConfig
    const queue = 'sq-fail-batch-exhausted'

    const activeId = await boss.send(queue, null, queueOptions)
    await boss.fetch(queue, undefined, enforce)
    const siblingId = await boss.send(queue, null, { ...queueOptions, retryLimit: 0 })

    await boss.fail([activeId, siblingId])

    assert.strictEqual((await getState(schema, activeId)).state, 'failed')
    assert.strictEqual((await getState(schema, siblingId)).state, 'failed')
  })

  it('fail() retries only the newest of several active jobs with the same key', async function () {
    const boss = await startBoss(this.test)
    const { schema } = this.test.bossConfig
    const queue = 'sq-fail-multiple-active'

    const firstId = await boss.send(queue, null, queueOptions)
    await boss.fetch(queue)
    const secondId = await boss.send(queue, null, queueOptions)
    await boss.fetch(queue)

    await boss.fail([firstId, secondId])

    assert.strictEqual((await getState(schema, firstId)).state, 'failed')
    assert.deepStrictEqual(await getCompletionStates(schema, queue, firstId), [{ state: 'failed', failed: true }])
    assert.strictEqual((await getState(schema, secondId)).state, 'retry')
  })

  it('expire() retries only the newest of several active jobs with the same key', async function () {
    const boss = await startBoss(this.test)
    const { schema } = this.test.bossConfig
    const queue = 'sq-expire-multiple-active'

    const firstId = await boss.send(queue, null, queueOptions)
    await boss.fetch(queue)
    const secondId = await boss.send(queue, null, queueOptions)
    await boss.fetch(queue)

    await makeOverdue(schema, [firstId, secondId])

    await boss.expire()

    assert.strictEqual((await getState(schema, firstId)).state, 'expired')
    assert.strictEqual((await getState(schema, secondId)).state, 'retry')
  })

  it('expire() retries the older active job when the newer one has no retries left', async function () {
    const boss = await startBoss(this.test)
    const { schema } = this.test.bossConfig
    const queue = 'sq-expire-newer-exhausted'

    const olderId = await boss.send(queue, null, queueOptions)
    await boss.fetch(queue)
    const newerId = await boss.send(queue, null, { ...queueOptions, retryLimit: 0 })
    await boss.fetch(queue)

    await makeOverdue(schema, [olderId, newerId])

    await boss.expire()

    assert.strictEqual((await getState(schema, olderId)).state, 'retry')
    assert.strictEqual((await getState(schema, newerId)).state, 'expired')
  })

  it('expire() keeps retrying plain singletonKey and singletonOn jobs', async function () {
    const boss = await startBoss(this.test)
    const { schema } = this.test.bossConfig
    const queue = 'sq-expire-plain'

    const keyedId = await boss.send(queue, null, { singletonKey: 'plain', retryLimit: 2 })
    const throttledId = await boss.send(queue, null, { singletonKey: 'throttled', singletonSeconds: 60, retryLimit: 2 })
    await boss.fetch(queue, 2)

    await makeOverdue(schema, [keyedId, throttledId])

    await boss.expire()

    assert.strictEqual((await getState(schema, keyedId)).state, 'retry')
    assert.strictEqual((await getState(schema, throttledId)).state, 'retry')
  })

  it('fail() keeps retrying plain singletonKey and singletonOn jobs', async function () {
    const boss = await startBoss(this.test)
    const { schema } = this.test.bossConfig
    const queue = 'sq-fail-plain'

    const keyedId = await boss.send(queue, null, { singletonKey: 'plain', retryLimit: 2 })
    const throttledId = await boss.send(queue, null, { singletonKey: 'throttled', singletonSeconds: 60, retryLimit: 2 })
    await boss.fetch(queue, 2)

    await boss.fail([keyedId, throttledId])

    assert.strictEqual((await getState(schema, keyedId)).state, 'retry')
    assert.strictEqual((await getState(schema, throttledId)).state, 'retry')
  })

  it('expire() rechecks the deadline of a job restarted while it waited for the row lock', async function () {
    const boss = await startBoss(this.test)
    const { schema } = this.test.bossConfig
    const queue = 'sq-expire-relocked'

    const jobId = await boss.send(queue, null, { retryLimit: 2 })
    await boss.fetch(queue)
    await makeOverdue(schema, [jobId])

    await holdUpdateWhile(schema, jobId, 'startedOn = now()', () => boss.expire())

    assert.strictEqual((await getState(schema, jobId)).state, 'active')
  })

  it('fail() fails an active job whose sibling is in retry state', async function () {
    const boss = await startBoss(this.test)
    const { schema } = this.test.bossConfig
    const queue = 'sq-fail-retry-sibling'

    const activeId = await boss.send(queue, null, queueOptions)
    await boss.fetch(queue)
    const siblingId = await boss.send(queue, null, queueOptions)
    await boss.fetch(queue)
    await boss.fail(siblingId)
    assert.strictEqual((await getState(schema, siblingId)).state, 'retry')

    await boss.fail(activeId)

    assert.strictEqual((await getState(schema, activeId)).state, 'failed')
    assert.strictEqual((await getState(schema, siblingId)).state, 'retry')
  })

  it('fail() retries the queued job over a newer active one in the same call', async function () {
    const boss = await startBoss(this.test)
    const { schema } = this.test.bossConfig
    const queue = 'sq-fail-queued-first'

    const olderId = await boss.send(queue, null, queueOptions)
    await boss.fetch(queue)
    const newerId = await boss.send(queue, null, queueOptions)
    await boss.fetch(queue)
    await boss.fail(olderId)
    assert.strictEqual((await getState(schema, olderId)).state, 'retry')

    await boss.fail([newerId, olderId])

    assert.strictEqual((await getState(schema, olderId)).state, 'retry')
    assert.strictEqual((await getState(schema, newerId)).state, 'failed')
  })

  it('fail() fails an active sendSingleton() job whose retry would collide', async function () {
    const boss = await startBoss(this.test)
    const { schema } = this.test.bossConfig
    const queue = 'sq-fail-send-singleton'

    const activeId = await boss.sendSingleton(queue, null, { retryLimit: 2 })
    await boss.fetch(queue, undefined, enforce)
    const siblingId = await boss.sendSingleton(queue, null, { retryLimit: 2 })
    assert(siblingId)

    await boss.fail(activeId)

    assert.strictEqual((await getState(schema, activeId)).state, 'failed')
    assert.strictEqual((await boss.fetch(queue, undefined, enforce)).id, siblingId)
  })

  it('fail() retries a throttled singleton queue job despite a queued unthrottled sibling', async function () {
    const boss = await startBoss(this.test)
    const { schema } = this.test.bossConfig
    const queue = 'sq-fail-throttled'

    const throttledId = await boss.send(queue, null, { ...queueOptions, singletonSeconds: 60 })
    await boss.fetch(queue)
    const siblingId = await boss.send(queue, null, queueOptions)
    assert(siblingId)

    await boss.fail(throttledId)

    assert.strictEqual((await getState(schema, throttledId)).state, 'retry')
    assert.strictEqual((await getState(schema, siblingId)).state, 'created')
  })

  it('expire() does not rank a throttled job against an unthrottled one with the same key', async function () {
    const boss = await startBoss(this.test)
    const { schema } = this.test.bossConfig
    const queue = 'sq-expire-throttled'

    const unthrottledId = await boss.send(queue, null, queueOptions)
    await boss.fetch(queue)
    const throttledId = await boss.send(queue, null, { ...queueOptions, singletonSeconds: 60 })
    await boss.fetch(queue)

    await makeOverdue(schema, [unthrottledId, throttledId])

    await boss.expire()

    assert.strictEqual((await getState(schema, unthrottledId)).state, 'retry')
    assert.strictEqual((await getState(schema, throttledId)).state, 'retry')
  })

  it('maintenance retries an expired job whose queued sibling is past keepUntil', async function () {
    const boss = await startBoss(this.test)
    const { schema } = this.test.bossConfig
    const queue = 'sq-maintenance-stale-sibling'
    const errors = []
    boss.on('error', (err) => errors.push(err))

    const { activeId, siblingId } = await activeWithQueuedSibling(boss, queue)
    await makeOverdue(schema, [activeId])
    await setColumn(schema, siblingId, "keepUntil = now() - interval '1 minute'")

    await boss.boss.onMaintenance({ id: randomUUID() })

    assert.deepStrictEqual(errors, [])
    assert.strictEqual((await getState(schema, activeId)).state, 'retry')
    assert(await helper.getArchivedJobById(schema, siblingId))
  })

  it('fail() does not count a queued sibling past keepUntil as the retry', async function () {
    const boss = await startBoss(this.test)
    const { schema } = this.test.bossConfig
    const queue = 'sq-fail-stale-sibling'

    const { activeId, siblingId } = await activeWithQueuedSibling(boss, queue)
    await setColumn(schema, siblingId, "keepUntil = now() - interval '1 minute'")

    await assert.rejects(boss.fail(activeId), { code: '23505', constraint: 'job_singleton_queue' })

    assert.strictEqual((await getState(schema, activeId)).state, 'active')
  })

  it('expire() runs again when a same-key job moves to retry after its snapshot', async function () {
    const boss = await startBoss(this.test)
    const { schema } = this.test.bossConfig
    const queue = 'sq-expire-concurrent-retry'

    const overdueId = await boss.send(queue, null, queueOptions)
    await boss.fetch(queue)
    const siblingId = await boss.send(queue, null, queueOptions)
    await boss.fetch(queue)
    await makeOverdue(schema, [overdueId])

    await holdUpdateWhile(schema, siblingId, "state = 'retry'", () => boss.expire())

    assert.strictEqual((await getState(schema, overdueId)).state, 'expired')
    assert.strictEqual((await getState(schema, siblingId)).state, 'retry')
  })
})
