const assert = require('assert')
const delay = require('delay')
const helper = require('./testHelper')

describe('graceful stop', function () {
  const defaults = { noSupervisor: true, noScheduling: true }
  const pollInterval = { newJobCheckInterval: 100 }

  async function waitUntil (condition, timeout = 5000) {
    const started = Date.now()

    while (!(await condition())) {
      if (Date.now() - started > timeout) {
        throw new Error('condition not met in time')
      }

      await delay(50)
    }
  }

  async function getState (schema, id) {
    const job = await helper.getJobById(schema, id)
    return job.state
  }

  async function makeOverdue (schema, id) {
    const db = await helper.getDb()
    await db.executeSql(`UPDATE ${schema}.job SET startedOn = now() - interval '1 hour' WHERE id = $1`, [id])
    await db.close()
  }

  describe('teamRefill', function () {
    it('counts a running teamRefill job as work in progress', async function () {
      const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })
      const queue = this.test.bossConfig.schema

      let release
      const gate = new Promise(resolve => { release = resolve })
      let started = false

      await boss.send(queue)
      await boss.work(queue, { ...pollInterval, teamSize: 2, teamRefill: true }, async () => {
        started = true
        await gate
      })

      await waitUntil(() => started)

      const count = boss.manager.getWipData().reduce((acc, i) => acc + i.count, 0)

      release()

      assert.strictEqual(count, 1)
    })

    it('keeps the pool open until a teamRefill handler completes its job on a graceful destroy', async function () {
      const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })
      const queue = this.test.bossConfig.schema

      let started = false

      const id = await boss.send(queue)
      await boss.work(queue, { ...pollInterval, teamSize: 2, teamRefill: true }, async () => {
        started = true
        await delay(3000)
      })

      await waitUntil(() => started)

      const stopped = new Promise(resolve => boss.once('stopped', resolve))

      await boss.stop({ destroy: true, timeout: 8000 })
      await stopped

      assert.strictEqual(await getState(this.test.bossConfig.schema, id), 'completed')
    })
  })

  describe('synchronous handler errors', function () {
    it('fails a job whose handler throws synchronously', async function () {
      const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })
      const queue = this.test.bossConfig.schema
      const schema = this.test.bossConfig.schema

      const id = await boss.send(queue)
      await boss.work(queue, { ...pollInterval, teamSize: 2, teamConcurrency: 2 }, () => {
        throw new Error('sync failure')
      })

      await waitUntil(async () => (await getState(schema, id)) === 'failed')

      const job = await helper.getJobById(schema, id)

      assert.strictEqual(job.output.message, 'sync failure')
    })

    it('gives a teamRefill slot back when its handler throws synchronously', async function () {
      const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })
      const queue = this.test.bossConfig.schema
      const schema = this.test.bossConfig.schema

      const first = await boss.send(queue, { fail: true })
      const second = await boss.send(queue, { fail: false })

      await boss.work(queue, { ...pollInterval, teamSize: 1, teamRefill: true }, (job) => {
        if (job.data.fail) {
          throw new Error('sync failure')
        }
      })

      await waitUntil(async () => (await getState(schema, second)) === 'completed')

      assert.strictEqual(await getState(schema, first), 'failed')
    })

    it('fails a batch whose handler throws synchronously', async function () {
      const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })
      const queue = this.test.bossConfig.schema
      const schema = this.test.bossConfig.schema

      const first = await boss.send(queue)
      const second = await boss.send(queue)

      await boss.work(queue, { ...pollInterval, batchSize: 2 }, () => {
        throw new Error('sync failure')
      })

      await waitUntil(async () => (await getState(schema, first)) === 'failed' && (await getState(schema, second)) === 'failed')
    })
  })

  describe('late results', function () {
    async function startNewerAttempt (test, settle) {
      const boss = test.boss = await helper.start({ ...test.bossConfig, ...defaults })
      const queue = test.bossConfig.schema
      const schema = test.bossConfig.schema

      let resolveHandler
      let rejectHandler
      let started = false

      const id = await boss.send(queue, null, { retryLimit: 1, expireInSeconds: 60 })

      await boss.work(queue, pollInterval, () => {
        started = true
        return new Promise((resolve, reject) => {
          resolveHandler = resolve
          rejectHandler = reject
        })
      })

      await waitUntil(() => started)

      await makeOverdue(schema, id)
      await boss.expire()

      const [retried] = await boss.fetch(queue, 1)

      assert.strictEqual(retried.id, id)

      settle({ resolve: resolveHandler, reject: rejectHandler })

      await delay(500)

      const job = await helper.getJobById(schema, id)

      return { boss, id, job }
    }

    it('does not complete a newer attempt of the job', async function () {
      const { boss, id, job } = await startNewerAttempt(this.test, ({ resolve }) => resolve('late'))

      assert.strictEqual(job.state, 'active')
      assert.strictEqual(job.retrycount, 1)

      const result = await boss.complete(id)

      assert.strictEqual(result.updated, 1)
    })

    it('does not fail a newer attempt of the job', async function () {
      const { job } = await startNewerAttempt(this.test, ({ reject }) => reject(new Error('late')))

      assert.strictEqual(job.state, 'active')
      assert.strictEqual(job.retrycount, 1)
    })
  })

  describe('stop options', function () {
    it('resolves stop({ wait: true }) after the stop has finished', async function () {
      const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })
      const queue = this.test.bossConfig.schema

      let started = false
      let stopped = false

      const id = await boss.send(queue)
      await boss.work(queue, pollInterval, async () => {
        started = true
        await delay(1500)
      })

      await waitUntil(() => started)

      boss.once('stopped', () => { stopped = true })

      await boss.stop({ wait: true, timeout: 8000 })

      assert(stopped)
      assert.strictEqual(await getState(this.test.bossConfig.schema, id), 'completed')
    })

    it('fails jobs still running at the deadline with failOnTimeout and ignores their late result', async function () {
      const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })
      const queue = this.test.bossConfig.schema
      const schema = this.test.bossConfig.schema

      let finished = false

      const id = await boss.send(queue, null, { retryLimit: 1, expireInSeconds: 60 })
      await boss.work(queue, pollInterval, async () => {
        await delay(2500)
        finished = true
      })

      await waitUntil(async () => (await getState(schema, id)) === 'active')

      await boss.stop({ wait: true, timeout: 1000, failOnTimeout: true })

      const job = await helper.getJobById(schema, id)

      assert.strictEqual(job.state, 'retry')
      assert.strictEqual(job.output.message, 'pg-boss stopped before the job finished')

      await waitUntil(() => finished)
      await delay(300)

      assert.strictEqual(await getState(schema, id), 'retry')
    })

    it('fails queued team jobs at the deadline without starting them', async function () {
      const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })
      const queue = this.test.bossConfig.schema
      const schema = this.test.bossConfig.schema

      let calls = 0

      const first = await boss.send(queue, null, { retryLimit: 1 })
      const second = await boss.send(queue, null, { retryLimit: 1 })

      await boss.work(queue, { ...pollInterval, teamSize: 2, teamConcurrency: 1 }, async () => {
        calls++
        await delay(2500)
      })

      await waitUntil(() => calls === 1)

      await boss.stop({ wait: true, timeout: 1000, failOnTimeout: true })

      assert.strictEqual(await getState(schema, first), 'retry')
      assert.strictEqual(await getState(schema, second), 'retry')

      await delay(2000)

      assert.strictEqual(calls, 1)
    })

    it('fails jobs returned by a fetch still in flight at the deadline without running them', async function () {
      const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })
      const queue = this.test.bossConfig.schema
      const schema = this.test.bossConfig.schema

      const fetchJobs = boss.manager.fetchJobs.bind(boss.manager)
      let fetched = false
      let calls = 0

      boss.manager.fetchJobs = async (...args) => {
        const rows = await fetchJobs(...args)

        if (rows) {
          fetched = true
          await delay(1500)
        }

        return rows
      }

      const id = await boss.send(queue, null, { retryLimit: 1 })
      await boss.work(queue, pollInterval, () => { calls++ })

      await waitUntil(() => fetched)

      await boss.stop({ graceful: false, wait: true, failOnTimeout: true })

      assert.strictEqual(await getState(schema, id), 'retry')

      await delay(500)

      assert.strictEqual(calls, 0)
    })

    it('lets a stop({ wait: true }) during a stop wait for it to finish', async function () {
      const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })
      const queue = this.test.bossConfig.schema

      let started = false
      let stopped = false

      const id = await boss.send(queue)
      await boss.work(queue, pollInterval, async () => {
        started = true
        await delay(1500)
      })

      await waitUntil(() => started)

      boss.once('stopped', () => { stopped = true })

      await boss.stop({ timeout: 8000 })
      await boss.stop({ wait: true })

      assert(stopped)
      assert.strictEqual(await getState(this.test.bossConfig.schema, id), 'completed')
    })

    it('lets a stop({ graceful: false }) during a stop cut it short', async function () {
      const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })
      const queue = this.test.bossConfig.schema
      const schema = this.test.bossConfig.schema

      const id = await boss.send(queue, null, { retryLimit: 1, expireInSeconds: 60 })
      await boss.work(queue, pollInterval, () => delay(6000))

      await waitUntil(async () => (await getState(schema, id)) === 'active')

      await boss.stop({ timeout: 30000 })

      const cutAt = Date.now()

      await boss.stop({ graceful: false, wait: true, failOnTimeout: true })

      assert(Date.now() - cutAt < 3000)
      assert.strictEqual(await getState(schema, id), 'retry')
    })
  })
})
