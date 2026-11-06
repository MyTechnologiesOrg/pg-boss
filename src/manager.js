const assert = require('assert')
const EventEmitter = require('events')
const delay = require('delay')
const uuid = require('uuid')
const debounce = require('lodash.debounce')
const { serializeError: stringify } = require('serialize-error')
const Attorney = require('./attorney')
const Worker = require('./worker')
const pMap = require('p-map')

const { QUEUES: BOSS_QUEUES } = require('./boss')
const { QUEUES: TIMEKEEPER_QUEUES } = require('./timekeeper')

const INTERNAL_QUEUES = Object.values(BOSS_QUEUES).concat(Object.values(TIMEKEEPER_QUEUES)).reduce((acc, i) => ({ ...acc, [i]: i }), {})

const plans = require('./plans')
const { COMPLETION_JOB_PREFIX, SINGLETON_QUEUE_KEY, ATTEMPT_COLUMN } = plans

const FETCH_SETTLE_TIMEOUT = 5000

const WIP_EVENT_INTERVAL = 2000
const WIP_DEBOUNCE_OPTIONS = { leading: true, trailing: true, maxWait: WIP_EVENT_INTERVAL }

const events = {
  error: 'error',
  wip: 'wip'
}

const MAX_ERROR_CAUSE_DEPTH = 3

// Other own properties and toJSON() output of errors (e.g. HTTP client request config) can carry credentials
const pickErrorFields = (error, depth = 0) => {
  const { name, message, stack, code, cause } = error

  const result = { name, message, stack }

  if (typeof code === 'string' || typeof code === 'number') {
    result.code = code
  }

  if (cause instanceof Error && depth < MAX_ERROR_CAUSE_DEPTH) {
    result.cause = pickErrorFields(cause, depth + 1)
  }

  return result
}

const resolveWithinSeconds = async (promise, seconds) => {
  const timeout = Math.max(1, seconds) * 1000
  const reject = delay.reject(timeout, { value: new Error(`handler execution exceeded ${timeout}ms`) })

  let result

  try {
    result = await Promise.race([promise, reject])
  } finally {
    try {
      reject.clear()
    } catch {}
  }

  return result
}

class Manager extends EventEmitter {
  constructor (db, config) {
    super()

    this.config = config
    this.db = db

    this.events = events
    this.workers = new Map()

    this.nextJobCommand = plans.fetchNextJob(config.schema)
    this.insertJobCommand = plans.insertJob(config.schema)
    this.insertJobsCommand = plans.insertJobs(config.schema)
    this.completeJobsCommand = plans.completeJobs(config.schema)
    this.completeAttemptsCommand = plans.completeJobs(config.schema, true)
    this.cancelJobsCommand = plans.cancelJobs(config.schema)
    this.resumeJobsCommand = plans.resumeJobs(config.schema)
    this.failJobsCommand = plans.failJobs(config.schema)
    this.failAttemptsCommand = plans.failJobs(config.schema, true)
    this.getJobByIdCommand = plans.getJobById(config.schema)
    this.getArchivedJobByIdCommand = plans.getArchivedJobById(config.schema)
    this.subscribeCommand = plans.subscribe(config.schema)
    this.unsubscribeCommand = plans.unsubscribe(config.schema)
    this.getQueuesForEventCommand = plans.getQueuesForEvent(config.schema)

    // exported api to index
    this.functions = [
      this.complete,
      this.cancel,
      this.resume,
      this.fail,
      this.fetch,
      this.fetchCompleted,
      this.work,
      this.offWork,
      this.notifyWorker,
      this.onComplete,
      this.offComplete,
      this.publish,
      this.subscribe,
      this.unsubscribe,
      this.insert,
      this.send,
      this.sendDebounced,
      this.sendThrottled,
      this.sendOnce,
      this.sendAfter,
      this.sendSingleton,
      this.deleteQueue,
      this.deleteAllQueues,
      this.clearStorage,
      this.getQueueSize,
      this.getJobById
    ]

    this.emitWipThrottled = debounce(() => this.emit(events.wip, this.getWipData()), WIP_EVENT_INTERVAL, WIP_DEBOUNCE_OPTIONS)
  }

  start () {
    this.stopping = false
  }

  async stop () {
    this.stopping = true

    for (const sub of this.workers.values()) {
      if (!INTERNAL_QUEUES[sub.name]) {
        await this.offWork(sub.name)
      }
    }
  }

  async work (name, ...args) {
    const { options, callback } = Attorney.checkWorkArgs(name, args, this.config)
    return await this.watch(name, options, callback)
  }

  async onComplete (name, ...args) {
    const { options, callback } = Attorney.checkWorkArgs(name, args, this.config)
    return await this.watch(COMPLETION_JOB_PREFIX + name, options, callback)
  }

  addWorker (worker) {
    this.workers.set(worker.id, worker)
  }

  removeWorker (worker) {
    this.workers.delete(worker.id)
  }

  getWorkers () {
    return Array.from(this.workers.values())
  }

  emitWip (name) {
    if (!INTERNAL_QUEUES[name]) {
      this.emitWipThrottled()
    }
  }

  isBusy (options = {}) {
    const { includeInternal = false } = options

    return this.getWorkers().some(w => w.isBusy() && (includeInternal || !INTERNAL_QUEUES[w.name]))
  }

  // Fails every job this instance still holds so it retries elsewhere instead of staying active until it expires
  async failHeld (error) {
    for (const worker of this.getWorkers()) {
      worker.abandon(error)
    }

    const fetches = this.getWorkers().map(w => w.fetchPromise).filter(Boolean)

    if (fetches.length) {
      const settleTimeout = delay(FETCH_SETTLE_TIMEOUT)

      try {
        await Promise.race([Promise.allSettled(fetches), settleTimeout])
      } finally {
        settleTimeout.clear()
      }
    }

    const taken = this.getWorkers().map(worker => ({ worker, entries: worker.take() }))
    const entries = taken.flatMap(i => i.entries)

    if (entries.length) {
      try {
        await this.failAttempts(entries, error)
      } catch (err) {
        // still ours: their handlers may write results and a retried stop can fail them
        for (const { worker, entries } of taken) {
          worker.restore(entries)
        }

        throw err
      }
    }

    return entries.length
  }

  async completeAttempts (entries, data) {
    return await this.db.executeSql(this.completeAttemptsCommand, [entries.map(i => i.id), this.mapCompletionDataArg(data), entries.map(i => i.attempt)])
  }

  async failAttempts (entries, data) {
    return await this.db.executeSql(this.failAttemptsCommand, [entries.map(i => i.id), this.mapCompletionDataArg(data), entries.map(i => i.attempt)])
  }

  getWipData (options = {}) {
    const { includeInternal = false } = options

    const data = this.getWorkers()
      .map(({
        id,
        name,
        options,
        state,
        jobs,
        createdOn,
        lastFetchedOn,
        lastJobStartedOn,
        lastJobEndedOn,
        lastError,
        lastErrorOn
      }) => ({
        id,
        name,
        options,
        state,
        count: jobs.length,
        createdOn,
        lastFetchedOn,
        lastJobStartedOn,
        lastJobEndedOn,
        lastError,
        lastErrorOn
      }))
      .filter(i => i.count > 0 && (!INTERNAL_QUEUES[i.name] || includeInternal))

    return data
  }

  async watch (name, options, callback) {
    if (this.stopping) {
      throw new Error('Workers are disabled. pg-boss is stopping.')
    }

    const {
      newJobCheckInterval: interval = this.config.newJobCheckInterval,
      batchSize,
      teamSize = 1,
      teamConcurrency = 1,
      teamRefill: refill = false,
      includeMetadata = false,
      enforceSingletonQueueActiveLimit = false
    } = options

    const id = uuid.v4()

    let queueSize = 0

    let refillTeamPromise
    let resolveRefillTeam

    // Setup a promise that onFetch can await for when at least one
    // job is finished and so the team is ready to be topped up
    const createTeamRefillPromise = () => {
      refillTeamPromise = new Promise((resolve) => { resolveRefillTeam = resolve })
    }

    createTeamRefillPromise()

    const onRefill = () => {
      queueSize--
      resolveRefillTeam()
      createTeamRefillPromise()
    }

    const held = new Set()

    const entryOf = new WeakMap()

    const fetch = async () => {
      const result = await this.fetchJobs(name, batchSize || (teamSize - queueSize), { includeMetadata, enforceSingletonQueueActiveLimit }, true)

      if (!result) {
        return null
      }

      for (const job of Array.isArray(result) ? result : [result]) {
        const entry = { id: job.id, attempt: job[ATTEMPT_COLUMN], job }
        delete job[ATTEMPT_COLUMN]
        entryOf.set(job, entry)
        held.add(entry)
      }

      return result
    }

    const release = entries => {
      for (const entry of entries) {
        entry.settled = true
        held.delete(entry)
      }
    }

    // the job stays held until its complete/fail write settles, so a graceful stop waits for the write too.
    // handler() is called inside the try so a synchronous throw fails the job rather than leaving it active.
    // failHeld() releases jobs it has failed; those don't start late (teamConcurrency) or write a result.
    const settle = async (jobs, expireInSeconds, handler, arg) => {
      const entries = jobs.map(job => entryOf.get(job))
      const stillHeld = () => entries.every(entry => held.has(entry))

      try {
        if (!stillHeld()) {
          return
        }

        let result

        try {
          result = await resolveWithinSeconds(handler(arg), expireInSeconds)
        } catch (err) {
          if (stillHeld()) {
            await this.failAttempts(entries, err)
          }

          return
        }

        try {
          if (stillHeld()) {
            await this.completeAttempts(entries, batchSize ? undefined : result)
          }
        } catch (err) {
          if (stillHeld()) {
            await this.failAttempts(entries, err)
          }
        }
      } finally {
        release(entries)
      }
    }

    const onFetch = async (jobs) => {
      // stop() is failing held jobs, so jobs from a fetch that returned meanwhile are failed rather than started
      if (worker.abandonError) {
        const entries = jobs.map(job => entryOf.get(job))

        try {
          await this.failAttempts(entries, worker.abandonError)
        } catch {
          // the pool may already be closed; the jobs then expire as before
        } finally {
          release(entries)
        }

        return
      }

      try {
        if (this.config.__test__throw_worker) {
          throw new Error('__test__throw_worker')
        }

        this.emitWip(name)
      } catch (err) {
        release(jobs.map(job => entryOf.get(job)))
        throw err
      }

      if (batchSize) {
        const maxExpiration = jobs.reduce((acc, i) => Math.max(acc, i.expire_in_seconds), 0)

        await settle(jobs, maxExpiration, callback, jobs)
      } else {
        if (refill) {
          queueSize += jobs.length || 1
        }

        const allTeamPromise = pMap(jobs, async job => {
          try {
            await settle([job], job.expire_in_seconds, callback, job)
          } catch {
            // a failed completion write leaves the job to expire, matching single-job workers
          }

          if (refill) {
            onRefill()
          }
        }, { concurrency: teamConcurrency })

        if (refill) {
          if (queueSize < teamSize) {
            return
          } else {
            await refillTeamPromise
          }
        } else {
          await allTeamPromise
        }
      }

      this.emitWip(name)
    }

    const onError = error => {
      this.emit(events.error, { ...error, message: error.message, stack: error.stack, queue: name, worker: id })
    }

    const worker = new Worker({ id, name, options, interval, held, fetch, onFetch, onError })

    this.addWorker(worker)

    worker.start()

    return id
  }

  async offWork (value) {
    assert(value, 'Missing required argument')

    const query = (typeof value === 'string')
      ? { filter: i => i.name === value }
      : (typeof value === 'object' && value.id)
          ? { filter: i => i.id === value.id }
          : null

    assert(query, 'Invalid argument. Expected string or object: { id }')

    const workers = this.getWorkers().filter(i => query.filter(i) && !i.stopping && !i.stopped)

    if (workers.length === 0) {
      return
    }

    for (const worker of workers) {
      worker.stop()
    }

    setImmediate(async () => {
      while (!workers.every(w => w.stopped && !w.isBusy())) {
        await delay(1000)
      }

      for (const worker of workers) {
        this.removeWorker(worker)
      }
    })
  }

  notifyWorker (workerId) {
    if (this.workers.has(workerId)) {
      this.workers.get(workerId).notify()
    }
  }

  async subscribe (event, name) {
    assert(event, 'Missing required argument')
    assert(name, 'Missing required argument')

    return await this.db.executeSql(this.subscribeCommand, [event, name])
  }

  async unsubscribe (event, name) {
    assert(event, 'Missing required argument')
    assert(name, 'Missing required argument')

    return await this.db.executeSql(this.unsubscribeCommand, [event, name])
  }

  async publish (event, ...args) {
    assert(event, 'Missing required argument')

    const result = await this.db.executeSql(this.getQueuesForEventCommand, [event])

    if (!result || result.rowCount === 0) {
      return []
    }

    return await Promise.all(result.rows.map(({ name }) => this.send(name, ...args)))
  }

  async offComplete (value) {
    if (typeof value === 'string') {
      value = COMPLETION_JOB_PREFIX + value
    }

    return await this.offWork(value)
  }

  async send (...args) {
    const { name, data, options } = Attorney.checkSendArgs(args, this.config)
    return await this.createJob(name, data, options)
  }

  async sendOnce (name, data, options, key) {
    options = options ? { ...options } : {}

    options.singletonKey = key || name

    const result = Attorney.checkSendArgs([name, data, options], this.config)

    return await this.createJob(result.name, result.data, result.options)
  }

  async sendSingleton (name, data, options) {
    options = options ? { ...options } : {}

    options.singletonKey = SINGLETON_QUEUE_KEY

    const result = Attorney.checkSendArgs([name, data, options], this.config)

    return await this.createJob(result.name, result.data, result.options)
  }

  async sendAfter (name, data, options, after) {
    options = options ? { ...options } : {}
    options.startAfter = after

    const result = Attorney.checkSendArgs([name, data, options], this.config)

    return await this.createJob(result.name, result.data, result.options)
  }

  async sendThrottled (name, data, options, seconds, key) {
    options = options ? { ...options } : {}
    options.singletonSeconds = seconds
    options.singletonNextSlot = false
    options.singletonKey = key

    const result = Attorney.checkSendArgs([name, data, options], this.config)

    return await this.createJob(result.name, result.data, result.options)
  }

  async sendDebounced (name, data, options, seconds, key) {
    options = options ? { ...options } : {}
    options.singletonSeconds = seconds
    options.singletonNextSlot = true
    options.singletonKey = key

    const result = Attorney.checkSendArgs([name, data, options], this.config)

    return await this.createJob(result.name, result.data, result.options)
  }

  async createJob (name, data, options, singletonOffset = 0) {
    const {
      db: wrapper,
      expireIn,
      priority,
      startAfter,
      keepUntil,
      singletonKey = null,
      singletonSeconds,
      retryBackoff,
      retryLimit,
      retryDelay,
      onComplete
    } = options

    const id = uuid[this.config.uuid]()

    const values = [
      id, // 1
      name, // 2
      priority, // 3
      retryLimit, // 4
      startAfter, // 5
      expireIn, // 6
      data, // 7
      singletonKey, // 8
      singletonSeconds, // 9
      singletonOffset, // 10
      retryDelay, // 11
      retryBackoff, // 12
      keepUntil, // 13
      onComplete // 14
    ]
    const db = wrapper || this.db
    const result = await db.executeSql(this.insertJobCommand, values)

    if (result && result.rowCount === 1) {
      return result.rows[0].id
    }

    if (!options.singletonNextSlot) {
      return null
    }

    // delay starting by the offset to honor throttling config
    options.startAfter = this.getDebounceStartAfter(singletonSeconds, this.timekeeper.clockSkew)

    // toggle off next slot config for round 2
    options.singletonNextSlot = false

    singletonOffset = singletonSeconds

    return await this.createJob(name, data, options, singletonOffset)
  }

  async insert (jobs, options = {}) {
    const { db: wrapper } = options
    const db = wrapper || this.db
    const checkedJobs = Attorney.checkInsertArgs(jobs)
    const data = JSON.stringify(checkedJobs)
    return await db.executeSql(this.insertJobsCommand, [data])
  }

  getDebounceStartAfter (singletonSeconds, clockOffset) {
    const debounceInterval = singletonSeconds * 1000

    const now = Date.now() + clockOffset

    const slot = Math.floor(now / debounceInterval) * debounceInterval

    // prevent startAfter=0 during debouncing
    let startAfter = (singletonSeconds - Math.floor((now - slot) / 1000)) || 1

    if (singletonSeconds > 1) {
      startAfter++
    }

    return startAfter
  }

  async fetch (name, batchSize, options = {}) {
    return await this.fetchJobs(name, batchSize, options, false)
  }

  async fetchJobs (name, batchSize, options, withAttempt) {
    const values = Attorney.checkFetchArgs(name, batchSize, options)
    const db = options.db || this.db
    const preparedStatement = this.nextJobCommand(options.includeMetadata || false, options.enforceSingletonQueueActiveLimit || false, withAttempt)
    const statementValues = [values.name, batchSize || 1]

    let result
    if (options.enforceSingletonQueueActiveLimit && !options.db && typeof db.executeSqlInTransaction === 'function') {
      // JIT can slow things down significantly
      result = await db.executeSqlInTransaction(preparedStatement, statementValues, ['SET LOCAL jit = OFF'])
    } else {
      result = await db.executeSql(preparedStatement, statementValues)
    }

    if (!result || result.rows.length === 0) {
      return null
    }

    return result.rows.length === 1 && !batchSize ? result.rows[0] : result.rows
  }

  async fetchCompleted (name, batchSize, options = {}) {
    return await this.fetch(COMPLETION_JOB_PREFIX + name, batchSize, options)
  }

  mapCompletionIdArg (id, funcName) {
    const errorMessage = `${funcName}() requires an id`

    assert(id, errorMessage)

    const ids = Array.isArray(id) ? id : [id]

    assert(ids.length, errorMessage)

    return ids
  }

  mapCompletionDataArg (data) {
    if (data === null || typeof data === 'undefined' || typeof data === 'function') { return null }

    const result = (data instanceof Error)
      ? pickErrorFields(data)
      : (typeof data === 'object' && !Array.isArray(data))
          ? data
          : { value: data }

    return stringify(result)
  }

  mapCompletionResponse (ids, result) {
    return {
      jobs: ids,
      requested: ids.length,
      updated: result && result.rows ? parseInt(result.rows[0].count) : 0
    }
  }

  async complete (id, data, options = {}) {
    const db = options.db || this.db
    const ids = this.mapCompletionIdArg(id, 'complete')
    const result = await db.executeSql(this.completeJobsCommand, [ids, this.mapCompletionDataArg(data)])
    return this.mapCompletionResponse(ids, result)
  }

  async fail (id, data, options = {}) {
    const db = options.db || this.db
    const ids = this.mapCompletionIdArg(id, 'fail')
    const result = await db.executeSql(this.failJobsCommand, [ids, this.mapCompletionDataArg(data)])
    return this.mapCompletionResponse(ids, result)
  }

  async cancel (id, options = {}) {
    const db = options.db || this.db
    const ids = this.mapCompletionIdArg(id, 'cancel')
    const result = await db.executeSql(this.cancelJobsCommand, [ids])
    return this.mapCompletionResponse(ids, result)
  }

  async resume (id, options = {}) {
    const db = options.db || this.db
    const ids = this.mapCompletionIdArg(id, 'resume')
    const result = await db.executeSql(this.resumeJobsCommand, [ids])
    return this.mapCompletionResponse(ids, result)
  }

  async deleteQueue (queue, options) {
    assert(queue, 'Missing queue name argument')
    const sql = plans.deleteQueue(this.config.schema, options)
    const result = await this.db.executeSql(sql, [queue])
    return result ? result.rowCount : null
  }

  async deleteAllQueues (options) {
    const sql = plans.deleteAllQueues(this.config.schema, options)
    const result = await this.db.executeSql(sql)
    return result ? result.rowCount : null
  }

  async clearStorage () {
    const sql = plans.clearStorage(this.config.schema)
    await this.db.executeSql(sql)
  }

  async getQueueSize (queue, options) {
    assert(queue, 'Missing queue name argument')

    const sql = plans.getQueueSize(this.config.schema, options)

    const result = await this.db.executeSql(sql, [queue])

    return result ? parseFloat(result.rows[0].count) : null
  }

  async getJobById (id, options = {}) {
    const db = options.db || this.db
    const result1 = await db.executeSql(this.getJobByIdCommand, [id])

    if (result1 && result1.rows && result1.rows.length === 1) {
      return result1.rows[0]
    }

    const result2 = await db.executeSql(this.getArchivedJobByIdCommand, [id])

    if (result2 && result2.rows && result2.rows.length === 1) {
      return result2.rows[0]
    }

    return null
  }
}

module.exports = Manager
