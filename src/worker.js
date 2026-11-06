const delay = require('delay')

const WORKER_STATES = {
  created: 'created',
  active: 'active',
  stopping: 'stopping',
  stopped: 'stopped'
}

class Worker {
  constructor ({ id, name, options, interval, held = new Set(), fetch, onFetch, onError }) {
    this.id = id
    this.name = name
    this.options = options
    this.fetch = fetch
    this.onFetch = onFetch
    this.onError = onError
    this.interval = interval
    // jobs fetched by this worker whose complete/fail write hasn't settled yet, including teamRefill jobs still running after onFetch returned
    this.held = held
    this.fetchPromise = null
    this.abandonError = null
    this.createdOn = Date.now()
    this.lastFetchedOn = null
    this.lastJobStartedOn = null
    this.lastJobEndedOn = null
    this.lastError = null
    this.lastErrorOn = null
    this.state = WORKER_STATES.created
    this.stopping = false
    this.stopped = false
    this.loopDelayPromise = null
    this.beenNotified = false
  }

  get jobs () {
    return Array.from(this.held, ({ job }) => job)
  }

  isBusy () {
    return this.fetchPromise !== null || this.held.size > 0
  }

  abandon (error) {
    this.abandonError = error
  }

  take () {
    const entries = Array.from(this.held)
    this.held.clear()
    return entries
  }

  // entries whose handler or write settled meanwhile stay released, or the worker would look busy forever
  restore (entries) {
    for (const entry of entries) {
      if (!entry.settled) {
        this.held.add(entry)
      }
    }
  }

  notify () {
    this.beenNotified = true

    if (this.loopDelayPromise) {
      this.loopDelayPromise.clear()
    }
  }

  async start () {
    this.state = WORKER_STATES.active

    while (!this.stopping) {
      const started = Date.now()

      try {
        this.beenNotified = false
        this.fetchPromise = this.fetch()

        let jobs

        try {
          jobs = await this.fetchPromise
        } finally {
          this.fetchPromise = null
        }

        this.lastFetchedOn = Date.now()

        if (jobs) {
          this.lastJobStartedOn = this.lastFetchedOn

          await this.onFetch(jobs)

          this.lastJobEndedOn = Date.now()
        }
      } catch (err) {
        this.lastErrorOn = Date.now()
        this.lastError = err

        err.message = `${err.message} (Queue: ${this.name}, Worker: ${this.id})`

        this.onError(err)
      }

      const duration = Date.now() - started

      this.lastJobDuration = duration

      if (!this.stopping && !this.beenNotified && duration < this.interval) {
        this.loopDelayPromise = delay(this.interval - duration)
        await this.loopDelayPromise
        this.loopDelayPromise = null
      }
    }

    this.stopping = false
    this.stopped = true
    this.state = WORKER_STATES.stopped
  }

  stop () {
    this.stopping = true
    this.state = WORKER_STATES.stopping

    if (this.loopDelayPromise) {
      this.loopDelayPromise.clear()
    }
  }
}

module.exports = Worker
