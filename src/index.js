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
    if (this.stopPromise) {
      if (options.wait) {
        await waitFor(this.stopPromise)
      }

      return
    }

    if (this.stopped) {
      this.emit(events.stopped)
    }

    let { destroy = false, graceful = true, timeout = 30000, wait = false, failActive = false } = options

    timeout = Math.max(timeout, 1000)

    this.stoppingOn = Date.now()

    const begin = (async () => {
      await this.manager.stop()
      await this.timekeeper.stop()
    })()

    const finish = async () => {
      await begin

      if (graceful) {
        await this.drain(timeout)
      }

      // before failHeld, so a failed failActive write doesn't leave maintenance workers running and abandoned
      await this.boss.stop()

      if (failActive) {
        await this.manager.failHeld(new Error('pg-boss stopped before the job finished'))
      }

      if (this.db.isOurs && this.db.opened && destroy) {
        await this.db.close()
      }

      this.stopped = true
      this.stoppingOn = null
    }

    // never rejects, so a stop nobody waits on can't become an unhandled rejection
    const stopPromise = this.stopPromise = (async () => {
      try {
        await finish()
      } catch (err) {
        this.stoppingOn = null
        this.stopPromise = null
        return err
      }

      // cleared before emitting so a stop() called from a stopped listener starts a new stop rather than joining this one
      this.stopPromise = null

      try {
        this.emit(events.stopped)
      } catch (err) {
        return err
      }

      return null
    })()

    if (wait || !graceful) {
      await waitFor(stopPromise)
      return
    }

    await begin

    setImmediate(async () => {
      const err = await stopPromise

      if (err) {
        this.emit(events.error, err)
      }
    })
  }

  async drain (timeout) {
    let closing = false

    while (Date.now() - this.stoppingOn < timeout) {
      if (!this.manager.isBusy({ includeInternal: closing })) {
        if (closing) {
          return
        }

        closing = true

        await this.boss.stop()
      }

      await delay(1000)
    }
  }
}

async function waitFor (stopPromise) {
  const err = await stopPromise

  if (err) {
    throw err
  }
}

module.exports = PgBoss
module.exports.states = plans.states
