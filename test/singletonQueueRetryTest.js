const assert = require('assert')
const helper = require('./testHelper')

describe('singleton queue retry collisions', function () {
  const singletonKey = 'collision'
  const jobOptions = { singletonKey, useSingletonQueue: true, retryLimit: 2, onComplete: true }
  const enforce = { enforceSingletonQueueActiveLimit: true }

  async function backdateStart (schema, ids) {
    const db = await helper.getDb()
    try {
      await db.executeSql(`UPDATE ${schema}.job SET startedOn = now() - interval '1 hour' WHERE id = ANY($1::uuid[])`, [ids])
    } finally {
      await db.close()
    }
  }

  async function startWithActiveAndQueuedSibling (bossConfig, queue) {
    const boss = await helper.start({ ...bossConfig, noSupervisor: true })
    const activeId = await boss.send(queue, null, jobOptions)
    const active = await boss.fetch(queue, undefined, enforce)
    assert.strictEqual(active.id, activeId)
    const siblingId = await boss.send(queue, null, jobOptions)
    assert(siblingId)
    return { boss, activeId, siblingId }
  }

  async function assertTerminalWithCompletion ({ boss, schema, queue, id, state }) {
    const job = await boss.getJobById(id)
    assert.strictEqual(job.state, state)
    assert(job.completedon)

    const completion = await helper.findJobs(schema, 'name = $1 AND data->\'request\'->>\'id\' = $2', [helper.COMPLETION_JOB_PREFIX + queue, id])
    assert.strictEqual(completion.rows.length, 1)
    assert.strictEqual(completion.rows[0].data.state, state)
  }

  async function assertSiblingFetchedNext (boss, queue, siblingId) {
    const next = await boss.fetch(queue, undefined, enforce)
    assert(next)
    assert.strictEqual(next.id, siblingId)
  }

  describe('fail', function () {
    it('fails the active job instead of retrying when a sibling is queued', async function () {
      const { schema } = this.test.bossConfig
      const queue = 'fail-collision'
      const { boss, activeId, siblingId } = await startWithActiveAndQueuedSibling(this.test.bossConfig, queue)
      this.test.boss = boss

      const result = await boss.fail(activeId, { reason: 'boom' })

      assert.strictEqual(result.updated, 1)
      await assertTerminalWithCompletion({ boss, schema, queue, id: activeId, state: 'failed' })
      assert.deepStrictEqual((await boss.getJobById(activeId)).output, { reason: 'boom' })
      assert.strictEqual((await boss.getJobById(siblingId)).state, 'created')
      await assertSiblingFetchedNext(boss, queue, siblingId)
    })

    it('fails the active job instead of retrying when the queued sibling is itself a retry', async function () {
      const queue = 'fail-collision-retry-sibling'
      const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, noSupervisor: true })
      const activeId = await boss.send(queue, null, jobOptions)
      await boss.fetch(queue)
      const siblingId = await boss.send(queue, null, jobOptions)
      await boss.fetch(queue)
      await boss.fail(siblingId)
      const sibling = await boss.getJobById(siblingId)
      assert.strictEqual(sibling.state, 'retry')

      await boss.fail(activeId)

      await assertTerminalWithCompletion({ boss, schema: this.test.bossConfig.schema, queue, id: activeId, state: 'failed' })
      const siblingAfter = await boss.getJobById(siblingId)
      assert.strictEqual(siblingAfter.state, 'retry')
      assert.strictEqual(siblingAfter.retrycount, sibling.retrycount)
      assert.strictEqual(siblingAfter.startafter.getTime(), sibling.startafter.getTime())
    })

    it('still retries a singleton queue job with no queued sibling', async function () {
      const queue = 'fail-no-collision'
      const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, noSupervisor: true })
      const jobId = await boss.send(queue, null, jobOptions)
      await boss.fetch(queue, undefined, enforce)

      await boss.fail(jobId)

      const job = await boss.getJobById(jobId)
      assert.strictEqual(job.state, 'retry')
      assert.strictEqual(job.completedon, null)

      const refetched = await boss.fetch(queue, undefined, { ...enforce, includeMetadata: true })
      assert.strictEqual(refetched.id, jobId)
      assert.strictEqual(refetched.retrycount, 1)
    })

    it('retries only the oldest of several active same-key jobs failed together', async function () {
      const queue = 'fail-many-active'
      const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, noSupervisor: true })
      const firstId = await boss.send(queue, null, jobOptions)
      await boss.fetch(queue)
      const secondId = await boss.send(queue, null, jobOptions)
      await boss.fetch(queue)

      const result = await boss.fail([secondId, firstId])

      assert.strictEqual(result.updated, 2)
      assert.strictEqual((await boss.getJobById(firstId)).state, 'retry')
      await assertTerminalWithCompletion({ boss, schema: this.test.bossConfig.schema, queue, id: secondId, state: 'failed' })
    })

    it('keeps the queued sibling as the retry when both are failed together', async function () {
      const queue = 'fail-active-and-queued'
      const { boss, activeId, siblingId } = await startWithActiveAndQueuedSibling(this.test.bossConfig, queue)
      this.test.boss = boss

      await boss.fail([activeId, siblingId])

      assert.strictEqual((await boss.getJobById(siblingId)).state, 'retry')
      await assertTerminalWithCompletion({ boss, schema: this.test.bossConfig.schema, queue, id: activeId, state: 'failed' })
    })
  })

  describe('expire', function () {
    it('expires the active job instead of retrying when a sibling is queued, without blocking other queues', async function () {
      const { schema } = this.test.bossConfig
      const queue = 'expire-collision'
      const otherQueue = 'expire-collision-other'
      const { boss, activeId, siblingId } = await startWithActiveAndQueuedSibling(this.test.bossConfig, queue)
      this.test.boss = boss

      const otherId = await boss.send(otherQueue, null, { onComplete: true })
      await boss.fetch(otherQueue)
      await backdateStart(schema, [activeId, otherId])

      await boss.boss.expire()

      await assertTerminalWithCompletion({ boss, schema, queue, id: activeId, state: 'expired' })
      await assertTerminalWithCompletion({ boss, schema, queue: otherQueue, id: otherId, state: 'expired' })
      assert.strictEqual((await boss.getJobById(siblingId)).state, 'created')
      await assertSiblingFetchedNext(boss, queue, siblingId)
    })

    it('still retries an expired singleton queue job with no queued sibling', async function () {
      const queue = 'expire-no-collision'
      const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, noSupervisor: true })
      const jobId = await boss.send(queue, null, jobOptions)
      await boss.fetch(queue, undefined, enforce)
      await backdateStart(this.test.bossConfig.schema, [jobId])

      await boss.boss.expire()

      const job = await boss.getJobById(jobId)
      assert.strictEqual(job.state, 'retry')
      assert.strictEqual(job.completedon, null)

      const refetched = await boss.fetch(queue, undefined, { ...enforce, includeMetadata: true })
      assert.strictEqual(refetched.id, jobId)
      assert.strictEqual(refetched.retrycount, 1)
    })

    it('retries only the oldest of several overdue same-key jobs', async function () {
      const { schema } = this.test.bossConfig
      const queue = 'expire-many-active'
      const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, noSupervisor: true })
      const firstId = await boss.send(queue, null, jobOptions)
      await boss.fetch(queue)
      const secondId = await boss.send(queue, null, jobOptions)
      await boss.fetch(queue)
      await backdateStart(schema, [firstId, secondId])

      await boss.boss.expire()

      assert.strictEqual((await boss.getJobById(firstId)).state, 'retry')
      await assertTerminalWithCompletion({ boss, schema, queue, id: secondId, state: 'expired' })
    })
  })
})
