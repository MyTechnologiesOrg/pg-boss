const delay = require('delay')

const WORKER_STATES = {
  created: 'created',
  active: 'active',
  stopping: 'stopping',
  stopped: 'stopped'
}

class Worker {
  constructor ({ id, name, options, interval, fetch, onFetch, onError }) {
    this.id = id
    this.name = name
    this.options = options
    this.fetch = fetch
    this.onFetch = onFetch
    this.onError = onError
    this.interval = interval
    this.held = new Set()
    this.fetching = null
    this.abandoned = false
    this.onRelease = null
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
    return Array.from(this.held, entry => entry.job)
  }

  async fetchAndHold () {
    const entries = (await this.fetch()) || []

    for (const entry of entries) {
      entry.abandoned = this.abandoned
      this.held.add(entry)
    }

    return entries
  }

  async waitForFetch () {
    if (this.fetching) {
      try {
        await this.fetching
      } catch {}
    }
  }

  release (entry) {
    if (this.held.delete(entry) && this.onRelease) {
      this.onRelease()
    }
  }

  abandon () {
    this.abandoned = true

    for (const entry of this.held) {
      entry.abandoned = true
    }

    return Array.from(this.held)
  }

  async waitForRelease () {
    while (this.held.size > 0) {
      await new Promise(resolve => { this.onRelease = resolve })
      this.onRelease = null
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

      let entries = []

      try {
        this.beenNotified = false

        this.fetching = this.fetchAndHold()

        try {
          entries = await this.fetching
        } finally {
          this.fetching = null
        }

        this.lastFetchedOn = Date.now()

        if (entries.length > 0 && !this.abandoned) {
          this.lastJobStartedOn = this.lastFetchedOn

          await this.onFetch(entries)

          this.lastJobEndedOn = Date.now()
        }
      } catch (err) {
        for (const entry of entries) {
          if (!entry.abandoned) {
            this.release(entry)
          }
        }

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

    await this.waitForRelease()

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
