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
    this.currentStop = null
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
    const { destroy = false, graceful = true, timeout = 30000, wait = false, failActive = false } = options
    const deadline = Date.now() + (graceful ? Math.max(timeout, 1000) : 0)
    const waits = wait || !graceful

    if (this.currentStop) {
      // A stop() made while another is running joins it: the earlier deadline wins, and destroy and failActive add up
      const stop = this.currentStop

      stop.deadline = Math.min(stop.deadline, deadline)
      stop.destroy = stop.destroy || destroy
      stop.failActive = stop.failActive || failActive

      if (stop.sleep) {
        stop.sleep.clear()
      }

      if (waits) {
        stop.awaited = true
        await stop.promise
      }

      return
    }

    if (this.stopped) {
      this.emit(events.stopped)
    }

    this.stoppingOn = Date.now()

    const stop = this.currentStop = { deadline, destroy, failActive, sleep: null, awaited: waits }

    const stopWorkers = async () => {
      await this.manager.stop()
      await this.timekeeper.stop()
    }

    const finish = async () => {
      let closing = false

      while (Date.now() < stop.deadline) {
        if (!this.manager.hasBusyWorkers({ includeInternal: closing })) {
          if (closing) {
            break
          }

          closing = true

          await this.boss.stop()
        }

        // Capped at the deadline, which a stop() that joins while this.boss.stop() runs may have moved
        stop.sleep = delay(Math.max(0, Math.min(1000, stop.deadline - Date.now())))
        await stop.sleep
        stop.sleep = null
      }

      await this.boss.stop()

      let failActiveError = null

      if (stop.failActive) {
        try {
          await this.manager.failActiveJobs()
        } catch (err) {
          failActiveError = err
        }
      }

      this.stopped = true
      this.stoppingOn = null

      try {
        if (this.db.isOurs && this.db.opened && stop.destroy) {
          await this.db.close()
        }
      } finally {
        this.currentStop = null
      }

      this.emit(events.stopped)

      // Reported only now, so a failed write still leaves a finished stop
      if (failActiveError) {
        throw failActiveError
      }
    }

    const workersStopped = stopWorkers()

    stop.promise = workersStopped.then(finish)
    // A failed stop rejects every call that waits for it, and is emitted as an error only if none does
    stop.promise.catch(() => {})

    await workersStopped

    if (waits) {
      await stop.promise
    } else {
      stop.promise.catch(err => {
        if (!stop.awaited) {
          this.emit(events.error, err)
        }
      })
    }
  }
}

module.exports = PgBoss
module.exports.states = plans.states
