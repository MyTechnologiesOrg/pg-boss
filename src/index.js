const EventEmitter = require('events')
const plans = require('./plans')
const Attorney = require('./attorney')
const Contractor = require('./contractor')
const Manager = require('./manager')
const Timekeeper = require('./timekeeper')
const Boss = require('./boss')
const Db = require('./db')
const delay = require('delay')

const events = {
  error: 'error',
  stopped: 'stopped'
}
class PgBoss extends EventEmitter {
  static getConstructionPlans (schema) {
    return Contractor.constructionPlans(schema)
  }

  static getMigrationPlans (schema, version) {
    return Contractor.migrationPlans(schema, version)
  }

  static getRollbackPlans (schema, version) {
    return Contractor.rollbackPlans(schema, version)
  }

  constructor (value) {
    const config = Attorney.getConfig(value)

    super()

    const db = getDb(config)

    if (db.isOurs) {
      promoteEvent.call(this, db, 'error')
    }

    const manager = new Manager(db, config)
    Object.keys(manager.events).forEach(event => promoteEvent.call(this, manager, manager.events[event]))
    manager.functions.forEach(func => promoteFunction.call(this, manager, func))

    const bossConfig = { ...config, manager }

    const boss = new Boss(db, bossConfig)
    Object.keys(boss.events).forEach(event => promoteEvent.call(this, boss, boss.events[event]))
    boss.functions.forEach(func => promoteFunction.call(this, boss, func))

    const timekeeper = new Timekeeper(db, bossConfig)
    Object.keys(timekeeper.events).forEach(event => promoteEvent.call(this, timekeeper, timekeeper.events[event]))
    timekeeper.functions.forEach(func => promoteFunction.call(this, timekeeper, func))

    manager.timekeeper = timekeeper

    this.stoppingOn = null
    this.stopState = null
    this.stopped = true
    this.config = config
    this.db = db
    this.boss = boss
    this.contractor = new Contractor(db, config)
    this.manager = manager
    this.timekeeper = timekeeper

    function getDb (config) {
      if (config.db) {
        return config.db
      }

      const db = new Db(config)
      db.isOurs = true
      return db
    }

    function promoteFunction (obj, func) {
      this[func.name] = (...args) => {
        const shouldRun = !this.started || !((func.name === 'work' || func.name === 'onComplete') && (this.stopped || this.stoppingOn))

        if (shouldRun) {
          return func.apply(obj, args)
        } else {
          const state = this.stoppingOn ? 'stopping' : this.stopped ? 'stopped' : !this.started ? 'not started' : 'started'
          return Promise.reject(new Error(`pg-boss is ${state}.`))
        }
      }
    }

    function promoteEvent (emitter, event) {
      emitter.on(event, arg => this.emit(event, arg))
    }
  }

  async start () {
    if (!this.stopped) {
      return this
    }

    if (this.db.isOurs && !this.db.opened) {
      await this.db.open()
    }

    await this.contractor.start()

    this.stopped = false
    this.started = true

    this.manager.start()

    if (!this.config.noSupervisor) {
      await this.boss.supervise()
    }

    if (!this.config.noScheduling) {
      await this.timekeeper.start()
    }

    return this
  }

  async stop (options = {}) {
    if (this.stopState) {
      return await this.joinStop(options)
    }

    if (this.stopped) {
      this.emit(events.stopped)
    }

    const { destroy = false, graceful = true, timeout = 30000, wait = false, failOnTimeout = false } = options

    this.stoppingOn = Date.now()

    const state = {
      deadline: graceful ? this.stoppingOn + Math.max(timeout, 1000) : this.stoppingOn,
      destroy,
      failOnTimeout,
      sleep: null,
      ready: null,
      promise: null
    }

    this.stopState = state

    state.ready = this.stopWorkers()

    await state.ready

    state.promise = this.drain(state)

    if (!graceful || wait) {
      await state.promise
      return
    }

    this.emitStopErrors(state.promise)
  }

  // a stop() during a stop can only bring its deadline forward or add destroy/failOnTimeout
  async joinStop (options) {
    const state = this.stopState
    const { destroy = false, graceful = true, timeout, wait = false, failOnTimeout = false } = options

    if (!graceful) {
      state.deadline = Math.min(state.deadline, Date.now())
    } else if (timeout !== undefined) {
      state.deadline = Math.min(state.deadline, Date.now() + Math.max(timeout, 1000))
    }

    state.destroy = state.destroy || destroy
    state.failOnTimeout = state.failOnTimeout || failOnTimeout

    if (state.sleep) {
      state.sleep.clear()
    }

    if (wait) {
      await state.ready
      await state.promise
    }
  }

  async stopWorkers () {
    await this.manager.stop()
    await this.timekeeper.stop()
  }

  async emitStopErrors (promise) {
    try {
      await promise
    } catch (err) {
      this.emit(events.error, err)
    }
  }

  async drain (state) {
    let closing = false

    while (Date.now() < state.deadline) {
      if (!this.manager.hasRunningWorkers({ includeInternal: closing })) {
        if (closing) {
          break
        }

        closing = true

        await this.boss.stop()
      }

      state.sleep = delay(Math.max(0, Math.min(1000, state.deadline - Date.now())))
      await state.sleep
      state.sleep = null
    }

    await this.boss.stop()

    if (state.failOnTimeout) {
      try {
        await this.manager.failHeldJobs(new Error('pg-boss stopped before the job finished'))
      } catch (err) {
        this.emit(events.error, err)
      }
    }

    this.stopped = true
    this.stoppingOn = null
    this.stopState = null

    if (this.db.isOurs && this.db.opened && state.destroy) {
      await this.db.close()
    }

    this.emit(events.stopped)
  }
}

module.exports = PgBoss
module.exports.states = plans.states
