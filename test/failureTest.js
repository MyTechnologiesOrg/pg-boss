const delay = require('delay')
const assert = require('assert')
const helper = require('./testHelper')
const pMap = require('p-map')

describe('failure', function () {
  it('should reject missing id argument', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)

    try {
      await boss.fail()
      assert(false)
    } catch (err) {
      assert(err)
    }
  })

  it('should fail a job when requested', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema

    await boss.send(queue)

    const job = await boss.fetch(queue)

    await boss.fail(job.id)
  })

  it('worker for job failure', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema

    const jobId = await boss.send(queue, null, { onComplete: true })

    const job = await boss.fetch(queue)

    await boss.fail(job.id)

    return new Promise((resolve, reject) => {
      boss.onComplete(queue, async job => {
        assert.strictEqual(jobId, job.data.request.id)
        assert.strictEqual('failed', job.data.state)
        resolve()
      }).catch(reject)
    })
  })

  it('should fail a batch of jobs', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema

    await Promise.all([
      boss.send(queue),
      boss.send(queue),
      boss.send(queue)
    ])

    const jobs = await boss.fetch(queue, 3)

    await boss.fail(jobs.map(job => job.id))
  })

  it('should fail a batch of jobs with a data arg', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema
    const message = 'some error'

    await Promise.all([
      boss.send(queue),
      boss.send(queue),
      boss.send(queue)
    ])

    const jobs = await boss.fetch(queue, 3)

    await boss.fail(jobs.map(job => job.id), new Error(message))

    const results = await pMap(jobs, job => boss.getJobById(job.id))

    assert(results.every(i => i.output.message === message))
  })

  it('should accept a payload', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema

    const failPayload = { someReason: 'nuna' }

    const jobId = await boss.send(queue, null, { onComplete: true })

    await boss.fail(jobId, failPayload)

    const job = await boss.fetchCompleted(queue)

    assert.strictEqual(job.data.state, 'failed')
    assert.strictEqual(job.data.response.someReason, failPayload.someReason)
  })

  it('should preserve nested objects within a plain object payload', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema

    const failPayload = { message: 'Something went wrong', some: { deeply: { nested: { reason: 'nuna' } } } }

    const jobId = await boss.send(queue, null, { onComplete: true })

    await boss.fail(jobId, failPayload)

    const job = await boss.fetchCompleted(queue)

    assert.strictEqual(job.data.state, 'failed')
    assert.strictEqual(job.data.response.some.deeply.nested.reason, failPayload.some.deeply.nested.reason)
  })

  it('should only store name, message, stack, code and cause of an Error payload', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema

    const cause = new Error('connection refused')
    cause.config = { headers: { Authorization: 'Bearer cause-secret' } }

    const failPayload = new Error('request failed', { cause })
    failPayload.code = 'ERR_BAD_RESPONSE'
    failPayload.config = { headers: { Authorization: 'Bearer secret' } }
    failPayload.toJSON = () => ({ message: 'request failed', config: failPayload.config })

    const jobId = await boss.send(queue, null, { onComplete: true })

    await boss.fail(jobId, failPayload)

    const job = await boss.fetchCompleted(queue)
    const { response } = job.data

    assert.strictEqual(job.data.state, 'failed')
    assert.deepStrictEqual(Object.keys(response).sort(), ['cause', 'code', 'message', 'name', 'stack'])
    assert.strictEqual(response.name, 'Error')
    assert.strictEqual(response.message, failPayload.message)
    assert.strictEqual(response.code, failPayload.code)
    assert(response.stack.includes(failPayload.message))
    assert.strictEqual(response.cause.message, cause.message)
    assert.strictEqual(response.cause.config, undefined)
    assert(!JSON.stringify(response).includes('secret'))

    const failedJob = await boss.getJobById(jobId)
    assert(!JSON.stringify(failedJob.output).includes('secret'))
  })

  it('failure via Promise reject() should pass string wrapped in value prop', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema
    const failPayload = 'mah error'

    await boss.work(queue, job => Promise.reject(failPayload))
    await boss.send(queue, null, { onComplete: true })

    await delay(7000)

    const job = await boss.fetchCompleted(queue)

    assert.strictEqual(job.data.state, 'failed')
    assert.strictEqual(job.data.response.value, failPayload)
  })

  it('failure via Promise reject() should pass object payload', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema
    const something = 'clever'

    const errorResponse = { message: 'custom error', something }

    await boss.work(queue, job => Promise.reject(errorResponse))
    await boss.send(queue, null, { onComplete: true })

    await delay(7000)

    const job = await boss.fetchCompleted(queue)

    assert.strictEqual(job.data.state, 'failed')
    assert.strictEqual(job.data.response.something, something)
  })

  it('failure with Error object should get stored in the failure job', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema
    const message = 'a real error!'

    await boss.send(queue, null, { onComplete: true })
    await boss.work(queue, async () => { throw new Error(message) })

    await delay(2000)

    const job = await boss.fetchCompleted(queue)

    assert.strictEqual(job.data.state, 'failed')
    assert(job.data.response.message.includes(message))
  })

  it('should fail a job with custom connection', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema

    await boss.send(queue)

    const job = await boss.fetch(queue)

    let called = false
    const _db = await helper.getDb()
    const db = {
      async executeSql (sql, values) {
        called = true
        return _db.pool.query(sql, values)
      }
    }

    await boss.fail(job.id, null, { db })

    assert.strictEqual(called, true)
  })

  it('failure with circular payload should be safely serialized', async function () {
    const boss = this.test.boss = await helper.start(this.test.bossConfig)
    const queue = this.test.bossConfig.schema

    await boss.send(queue, null, { onComplete: true })

    await boss.work(queue, async job => {
      const err = {
        message: 'something'
      }

      err.myself = err

      throw err
    })

    await delay(2000)

    const job = await boss.fetchCompleted(queue)

    assert(job)
  })
})
