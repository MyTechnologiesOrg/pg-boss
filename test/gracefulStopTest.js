const assert = require('assert')
const delay = require('delay')
const helper = require('./testHelper')
const Db = require('../src/db')

describe('graceful stop', function () {
  const defaults = {
    noSupervisor: true,
    noScheduling: true
  }

  const isFetch = text => text.includes('FOR UPDATE SKIP LOCKED')
  const isGuardedWrite = text => text.includes('$3::bigint[]')

  // wraps a real pool so a test can hold back chosen queries
  async function openDelayedDb (config, shouldDelay) {
    const db = new Db({ ...config })
    await db.open()

    const delayed = { settled: 0 }

    return {
      db,
      delayed,
      wrapper: {
        executeSql: async (text, values) => {
          const ms = shouldDelay(text, values)

          if (!ms) {
            return await db.executeSql(text, values)
          }

          try {
            await delay(ms)
            return await db.executeSql(text, values)
          } finally {
            delayed.settled++
          }
        }
      }
    }
  }

  async function waitUntil (check, timeout = 8000) {
    const started = Date.now()

    while (Date.now() - started < timeout) {
      if (await check()) {
        return
      }

      await delay(100)
    }

    throw new Error('waitUntil timed out')
  }

  describe('tracking', function () {
    it('should wait for teamRefill jobs still running after onFetch returned', async function () {
      const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })
      const queue = this.test.bossConfig.schema

      const jobId = await boss.send(queue)

      let started = false
      let finished = false

      await boss.work(queue, { teamSize: 2, teamRefill: true, newJobCheckInterval: 100 }, async () => {
        started = true
        await delay(3000)
        finished = true
      })

      await waitUntil(() => started)

      await boss.stop({ wait: true, timeout: 10000 })

      assert(finished)

      const job = await helper.getJobById(this.test.bossConfig.schema, jobId)

      assert.strictEqual(job.state, 'completed')
    })

    it('should wait for a fetch still in flight and the jobs it returns', async function () {
      const config = { ...this.test.bossConfig, ...defaults }
      const queue = config.schema

      let slowFetch = false

      const { db, wrapper } = await openDelayedDb(config, text => slowFetch && isFetch(text) ? 2000 : 0)

      try {
        const boss = this.test.boss = await helper.start({ ...config, db: wrapper })

        const jobId = await boss.send(queue)

        let handled = false

        slowFetch = true

        await boss.work(queue, async () => {
          await delay(500)
          handled = true
        })

        await delay(200)

        await boss.stop({ wait: true, timeout: 10000 })

        assert(handled)

        const job = await helper.getJobById(queue, jobId)

        assert.strictEqual(job.state, 'completed')
      } finally {
        await db.close()
      }
    })

    it('should wait for a completion write still in flight', async function () {
      const config = { ...this.test.bossConfig, ...defaults }
      const queue = config.schema

      const { db, wrapper } = await openDelayedDb(config, text => isGuardedWrite(text) ? 2000 : 0)

      try {
        const boss = this.test.boss = await helper.start({ ...config, db: wrapper })

        const jobId = await boss.send(queue)

        let handled = false

        await boss.work(queue, { newJobCheckInterval: 100 }, async () => { handled = true })

        await waitUntil(() => handled)

        await boss.stop({ wait: true, timeout: 10000 })

        const job = await helper.getJobById(queue, jobId)

        assert.strictEqual(job.state, 'completed')
      } finally {
        await db.close()
      }
    })

    it('should release fetched jobs when onFetch throws before running them', async function () {
      const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })
      const queue = this.test.bossConfig.schema

      await boss.send(queue)

      boss.once('wip', () => { throw new Error('wip listener failed') })

      const workerError = new Promise(resolve => boss.once('error', resolve))

      await boss.work(queue, { newJobCheckInterval: 100 }, async () => {})

      const err = await workerError

      assert(err.message.includes('wip listener failed'))

      const [worker] = boss.manager.getWorkers()

      assert.strictEqual(worker.held.size, 0)

      const before = Date.now()

      await boss.stop({ wait: true, timeout: 8000 })

      assert(Date.now() - before < 4000)
    })

    it('should count running teamRefill jobs in wip data', async function () {
      const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })
      const queue = this.test.bossConfig.schema

      await boss.send(queue)

      let started = false

      await boss.work(queue, { teamSize: 2, teamRefill: true, newJobCheckInterval: 100 }, async () => {
        started = true
        await delay(2000)
      })

      await waitUntil(() => started)

      await delay(300)

      const wip = boss.manager.getWipData()

      assert.strictEqual(wip.length, 1)
      assert.strictEqual(wip[0].count, 1)
    })
  })

  describe('synchronous handler errors', function () {
    for (const [label, options] of [['teamSize', { teamSize: 2 }], ['batchSize', { batchSize: 2 }]]) {
      it(`should fail the job when a ${label} handler throws synchronously`, async function () {
        const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })
        const queue = this.test.bossConfig.schema

        const jobId = await boss.send(queue, null, { retryLimit: 0 })

        await boss.work(queue, { ...options, newJobCheckInterval: 100 }, () => { throw new Error('sync throw') })

        await waitUntil(async () => (await boss.getJobById(jobId)).state === 'failed')

        const job = await boss.getJobById(jobId)

        assert.strictEqual(job.output.message, 'sync throw')
      })
    }
  })

  describe('attempt guard', function () {
    for (const outcome of ['complete', 'fail']) {
      it(`should not ${outcome} a newer attempt of the same job`, async function () {
        this.timeout(20000)

        const config = { ...this.test.bossConfig, ...defaults }
        const queue = config.schema

        let slowWrite = false

        const { db, delayed, wrapper } = await openDelayedDb(config, text => slowWrite && isGuardedWrite(text) ? 4000 : 0)

        try {
          const boss = this.test.boss = await helper.start({ ...config, db: wrapper })

          const jobId = await boss.send(queue, null, { retryLimit: 2, retryDelay: 0, expireInSeconds: 1 })

          let handled = false

          slowWrite = true

          await boss.work(queue, { newJobCheckInterval: 100 }, async () => {
            handled = true

            if (outcome === 'fail') {
              throw new Error('late failure')
            }
          })

          await waitUntil(() => handled)

          await boss.offWork(queue)

          await delay(1500)

          await boss.expire()

          const retry = await boss.getJobById(jobId)
          assert.strictEqual(retry.state, 'retry')

          const [refetched] = await boss.fetch(queue, 1)
          assert.strictEqual(refetched.id, jobId)

          await waitUntil(() => delayed.settled === 1, 8000)

          const job = await boss.getJobById(jobId)

          assert.strictEqual(job.state, 'active')
          assert.strictEqual(job.retrycount, 1)
          assert.strictEqual(job.output, null)
        } finally {
          await db.close()
        }
      })
    }

    it('should still complete the attempt the worker fetched', async function () {
      const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })
      const queue = this.test.bossConfig.schema

      const jobId = await boss.send(queue, null, { retryLimit: 1, retryDelay: 0 })

      let calls = 0

      await boss.work(queue, { newJobCheckInterval: 100 }, async () => {
        calls++

        if (calls === 1) {
          throw new Error('first attempt fails')
        }

        return { attempt: calls }
      })

      await waitUntil(async () => (await boss.getJobById(jobId)).state === 'completed')

      const job = await boss.getJobById(jobId)

      assert.strictEqual(job.retrycount, 1)
      assert.deepStrictEqual(job.output, { attempt: 2 })
    })
  })

  describe('stop options', function () {
    it('wait should resolve after stopped is emitted', async function () {
      const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })

      let stoppedEmitted = false
      boss.once('stopped', () => { stoppedEmitted = true })

      await boss.stop({ wait: true, timeout: 1000 })

      assert(stoppedEmitted)
      assert.strictEqual(boss.stopped, true)
    })

    it('wait should reject when the stop fails instead of emitting error', async function () {
      const boss = await helper.start({ ...this.test.bossConfig, ...defaults, __test__throw_stop: 'stop failed' })

      let errorEmitted = false
      boss.on('error', () => { errorEmitted = true })

      try {
        await assert.rejects(() => boss.stop({ wait: true, timeout: 1000 }), /stop failed/)

        assert.strictEqual(errorEmitted, false)
        assert.strictEqual(boss.stoppingOn, null)
        assert.strictEqual(boss.stopped, false)
      } finally {
        await boss.db.close()
      }
    })

    it('failActive should fail held jobs when the graceful timeout is reached', async function () {
      const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })
      const queue = this.test.bossConfig.schema

      const jobId = await boss.send(queue, null, { retryLimit: 1, retryDelay: 0, expireInSeconds: 60 })

      let started = false

      await boss.work(queue, { newJobCheckInterval: 100 }, async () => {
        started = true
        await delay(3000)
      })

      await waitUntil(() => started)

      await boss.stop({ wait: true, timeout: 1000, failActive: true })

      const job = await helper.getJobById(this.test.bossConfig.schema, jobId)

      assert.strictEqual(job.state, 'retry')
      assert(job.output.message.includes('pg-boss stopped'))
    })

    it('failActive should fail held jobs immediately when not graceful', async function () {
      const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })
      const queue = this.test.bossConfig.schema

      const jobId = await boss.send(queue, null, { retryLimit: 0, expireInSeconds: 60 })

      let started = false

      await boss.work(queue, { teamSize: 2, teamRefill: true, newJobCheckInterval: 100 }, async () => {
        started = true
        await delay(3000)
      })

      await waitUntil(() => started)

      const before = Date.now()

      await boss.stop({ graceful: false, failActive: true })

      assert(Date.now() - before < 3000)

      const job = await helper.getJobById(this.test.bossConfig.schema, jobId)

      assert.strictEqual(job.state, 'failed')
    })

    it('failActive should fail jobs from a fetch in flight without running them', async function () {
      const config = { ...this.test.bossConfig, ...defaults }
      const queue = config.schema

      let slowFetch = false

      const { db, wrapper } = await openDelayedDb(config, text => slowFetch && isFetch(text) ? 1500 : 0)

      try {
        const boss = this.test.boss = await helper.start({ ...config, db: wrapper })

        const jobId = await boss.send(queue, null, { retryLimit: 1, retryDelay: 0 })

        let handled = false

        slowFetch = true

        await boss.work(queue, async () => { handled = true })

        await delay(200)

        await boss.stop({ graceful: false, failActive: true })

        const job = await helper.getJobById(queue, jobId)

        assert.strictEqual(handled, false)
        assert.strictEqual(job.state, 'retry')
      } finally {
        await db.close()
      }
    })

    it('failActive should not start team jobs that were waiting for teamConcurrency', async function () {
      const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })
      const queue = this.test.bossConfig.schema

      await boss.insert([1, 2, 3].map(() => ({ name: queue, retryLimit: 1, retryDelay: 0, expireInSeconds: 60 })))

      let calls = 0

      await boss.work(queue, { teamSize: 3, teamConcurrency: 1, newJobCheckInterval: 100 }, async () => {
        calls++
        await delay(2000)
      })

      await waitUntil(() => calls === 1)

      await boss.stop({ wait: true, timeout: 1000, failActive: true })

      assert.strictEqual(await helper.countJobs(queue, "name = $1 AND state = 'retry'", [queue]), 3)

      await delay(2500)

      assert.strictEqual(calls, 1)
    })

    it('failActive should skip the late result write of a job it failed', async function () {
      const config = { ...this.test.bossConfig, ...defaults }
      const queue = config.schema

      let closed = false
      let lateWrites = 0

      const { db, wrapper } = await openDelayedDb(config, text => {
        if (closed && isGuardedWrite(text)) {
          lateWrites++
        }

        return 0
      })

      try {
        const boss = this.test.boss = await helper.start({ ...config, db: wrapper })

        const errors = []
        boss.on('error', err => errors.push(err))

        await boss.send(queue, null, { retryLimit: 1, retryDelay: 0, expireInSeconds: 60 })

        let finished = false

        await boss.work(queue, { batchSize: 1, newJobCheckInterval: 100 }, async () => {
          await delay(1500)
          finished = true
        })

        await delay(500)

        await boss.stop({ graceful: false, failActive: true })

        closed = true

        await waitUntil(() => finished)
        await delay(300)

        assert.strictEqual(lateWrites, 0)
        assert.strictEqual(errors.length, 0)
      } finally {
        await db.close()
      }
    })

    it('failActive should fail jobs from a fetch that returns after it gave up waiting', async function () {
      this.timeout(20000)

      const config = { ...this.test.bossConfig, ...defaults }
      const queue = config.schema

      let slowFetch = false

      const { db, wrapper } = await openDelayedDb(config, text => slowFetch && isFetch(text) ? 6500 : 0)

      try {
        const boss = this.test.boss = await helper.start({ ...config, db: wrapper })

        const jobId = await boss.send(queue, null, { retryLimit: 1, retryDelay: 0 })

        let handled = false

        slowFetch = true

        await boss.work(queue, async () => { handled = true })

        await delay(200)

        await boss.stop({ graceful: false, failActive: true })

        slowFetch = false

        await waitUntil(async () => (await helper.getJobById(queue, jobId)).state === 'retry', 10000)

        await delay(200)

        assert.strictEqual(handled, false)
        assert.strictEqual(boss.manager.isBusy({ includeInternal: true }), false)
      } finally {
        await db.close()
      }
    })

    it('failActive should keep holding jobs when failing them fails, so a retried stop can', async function () {
      const config = { ...this.test.bossConfig, ...defaults }
      const queue = config.schema

      let breakFail = false

      const { db, wrapper } = await openDelayedDb(config, text => {
        if (breakFail && isGuardedWrite(text) && text.includes('retry_collides')) {
          throw new Error('fail write broken')
        }

        return 0
      })

      try {
        const boss = this.test.boss = await helper.start({ ...config, db: wrapper })

        const jobId = await boss.send(queue, null, { retryLimit: 1, retryDelay: 0, expireInSeconds: 60 })

        let started = false

        await boss.work(queue, { newJobCheckInterval: 100 }, async () => {
          started = true
          await delay(3000)
        })

        await waitUntil(() => started)

        breakFail = true

        await assert.rejects(() => boss.stop({ wait: true, graceful: false, failActive: true }), /fail write broken/)

        assert.strictEqual(boss.manager.getWorkers()[0].held.size, 1)

        breakFail = false

        await boss.stop({ wait: true, graceful: false, failActive: true })

        const job = await helper.getJobById(queue, jobId)

        assert.strictEqual(job.state, 'retry')
      } finally {
        await db.close()
      }
    })

    it('failActive should not restore jobs that settled while its failed write was in flight', async function () {
      const config = { ...this.test.bossConfig, ...defaults }
      const queue = config.schema

      let breakFail = false

      const { db, wrapper } = await openDelayedDb(config, () => 0)

      const brokenWrapper = {
        executeSql: async (text, values) => {
          if (breakFail && isGuardedWrite(text) && text.includes('retry_collides')) {
            await delay(2000)
            throw new Error('fail write broken')
          }

          return await wrapper.executeSql(text, values)
        }
      }

      try {
        const boss = this.test.boss = await helper.start({ ...config, db: brokenWrapper })

        await boss.send(queue, null, { retryLimit: 1, retryDelay: 0, expireInSeconds: 60 })

        let started = false

        await boss.work(queue, { newJobCheckInterval: 100 }, async () => {
          started = true
          await delay(1000)
        })

        await waitUntil(() => started)

        const [worker] = boss.manager.getWorkers()

        breakFail = true

        await assert.rejects(() => boss.stop({ wait: true, graceful: false, failActive: true }), /fail write broken/)

        breakFail = false

        assert.strictEqual(worker.held.size, 0)
      } finally {
        await db.close()
      }
    })

    it('should not pass the attempt token to handlers with includeMetadata', async function () {
      const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })
      const queue = this.test.bossConfig.schema

      const jobId = await boss.send(queue)

      let received

      await boss.work(queue, { includeMetadata: true, newJobCheckInterval: 100 }, async job => { received = job })

      await waitUntil(async () => (await boss.getJobById(jobId)).state === 'completed')

      assert.strictEqual(received.id, jobId)
      assert(received.startedon)
      assert(!Object.keys(received).some(key => key.includes('attempt')))
    })

    it('should leave held jobs active at timeout without failActive', async function () {
      const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })
      const queue = this.test.bossConfig.schema

      const jobId = await boss.send(queue, null, { expireInSeconds: 60 })

      let started = false

      await boss.work(queue, { newJobCheckInterval: 100 }, async () => {
        started = true
        await delay(2500)
      })

      await waitUntil(() => started)

      await boss.stop({ wait: true, timeout: 1000 })

      const job = await helper.getJobById(this.test.bossConfig.schema, jobId)

      assert.strictEqual(job.state, 'active')
    })

    it('a second stop() with wait should join the running stop', async function () {
      const boss = this.test.boss = await helper.start({ ...this.test.bossConfig, ...defaults })
      const queue = this.test.bossConfig.schema

      await boss.send(queue)

      let started = false
      let finished = false

      await boss.work(queue, { newJobCheckInterval: 100 }, async () => {
        started = true
        await delay(2000)
        finished = true
      })

      await waitUntil(() => started)

      let stoppedCount = 0
      boss.on('stopped', () => { stoppedCount++ })

      await boss.stop({ timeout: 10000 })

      await boss.stop({ graceful: false, failActive: true })

      assert.strictEqual(stoppedCount, 0)
      assert.strictEqual(finished, false)

      await boss.stop({ wait: true, graceful: false, failActive: true })

      assert(finished)
      assert.strictEqual(stoppedCount, 1)
      assert.strictEqual(boss.stopped, true)
    })
  })
})
