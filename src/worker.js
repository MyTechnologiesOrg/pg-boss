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
    this.jobs = []
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
    this.fetching = null
    this.fetchInFlight = false
    this.settling = new Set()
    this.released = false
    this.jobsRemoved = []
  }

  // Jobs are tracked as soon as their fetch returns, so stop() can find them before onFetch runs
  async fetchJobs () {
    this.fetchInFlight = true

    try {
      const jobs = await this.fetch()

      if (jobs) {
        this.jobs = this.jobs.concat(jobs)
      }

      return jobs
    } finally {
      this.fetchInFlight = false
    }
  }

  async fetched () {
    try {
      await this.fetching
    } catch {}
  }

  // A fetch in flight counts, since the jobs it fetches are already active
  isBusy () {
    return this.fetchInFlight || this.jobs.length > 0
  }

  removeJobs (jobs) {
    this.jobs = this.jobs.filter(job => !jobs.includes(job))

    for (const job of jobs) {
      this.settling.delete(job)
    }

    const waiting = this.jobsRemoved

    this.jobsRemoved = []

    for (const resolve of waiting) {
      resolve()
    }
  }

  async jobRemoved () {
    await new Promise(resolve => { this.jobsRemoved.push(resolve) })
  }

  // Resolves once the writes this worker started have finished or failed
  async recorded () {
    while (this.settling.size > 0) {
      await this.jobRemoved()
    }
  }

  // Claims the jobs for recording their handler's result, unless release() has already taken them
  settle (jobs) {
    if (!jobs.every(job => this.jobs.includes(job))) {
      return false
    }

    for (const job of jobs) {
      this.settling.add(job)
    }

    return true
  }

  // Hands stop() every job whose result isn't already being recorded. A released worker starts
  // no more handlers and leaves what it fetches afterwards for the next release() call.
  release () {
    this.released = true

    const jobs = this.jobs.filter(job => !this.settling.has(job))

    this.removeJobs(jobs)

    return jobs
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
        this.fetching = this.fetchJobs()
        const jobs = await this.fetching

        this.lastFetchedOn = Date.now()

        if (jobs && !this.released) {
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

    // A teamRefill worker leaves the loop while jobs it fetched are still running, and a released
    // worker may still hold jobs that stop() is about to fail
    while (this.jobs.length > 0) {
      await this.jobRemoved()
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
