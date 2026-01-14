Queueing jobs in Node.js using PostgreSQL like a boss.

```js
async function readme() {
  const PgBoss = require('@mytechnologiesorg/pg-boss');
  const boss = new PgBoss('postgres://user:pass@host/database');

  boss.on('error', error => console.error(error));

  await boss.start();

  const queue = 'some-queue';

  let jobId = await boss.send(queue, { param1: 'foo' })

  console.log(`created job in queue ${queue}: ${jobId}`);

  await boss.work(queue, someAsyncJobHandler);
}

async function someAsyncJobHandler(job) {
  console.log(`job ${job.id} received with data:`);
  console.log(JSON.stringify(job.data));

  await doSomethingAsyncWithThis(job.data);
}
```

pg-boss is a job queue built in Node.js on top of PostgreSQL in order to provide background processing and reliable asynchronous execution to Node.js applications.

pg-boss relies on [SKIP LOCKED](https://www.2ndquadrant.com/en/blog/what-is-select-skip-locked-for-in-postgresql-9-5/), a feature added to postgres specifically for message queues, in order to resolve record locking challenges inherent with relational databases. This brings the safety of guaranteed atomic commits of a relational database to your asynchronous job processing.

This will likely cater the most to teams already familiar with the simplicity of relational database semantics and operations (SQL, querying, and backups). It will be especially useful to those already relying on PostgreSQL that want to limit how many systems are required to monitor and support in their architecture.

## Features
* Exactly-once job delivery
* Backpressure-compatible polling workers
* Cron scheduling
* Pub/sub API for fan-out queue relationships
* Deferral, retries (with exponential backoff), rate limiting, debouncing
* Completion jobs for orchestrations/sagas
* Direct table access for bulk loads via COPY or INSERT
* Multi-master compatible (for example, in a Kubernetes ReplicaSet)
* Automatic creation and migration of storage tables
* Automatic maintenance operations to manage table growth

## Requirements
* Node 16 or higher
* PostgreSQL 11 or higher

## Installation

First, configure npm to use GitHub Packages for the `@MyTechnologiesOrg` scope by adding to your `.npmrc`:

```
@mytechnologiesorg:registry=https://npm.pkg.github.com
```

Then install:

```bash
npm install @mytechnologiesorg/pg-boss
```

## Documentation
* [Docs](docs/readme.md)

## Contributing

To setup a development environment for this library:

```bash
git clone https://github.com/MyTechnologiesOrg/pg-boss.git
npm install
```

### Running Tests Locally

```bash
# run all tests
make test

# run tests with coverage (like ci)
make ci

# run a specific test file
make test-run test/configTest.js
```

#### Other Make Commands

```bash
make install   # install dependencies
make db-up     # start postgresql
make db-down   # stop postgresql
make clean     # stop postgresql and remove volumes
```

### Manual Database Setup

Alternatively, you can run tests against your own PostgreSQL instance. You will need to give pg-boss access to an empty postgres database:

```sql
CREATE DATABASE pgboss;
CREATE user postgres WITH PASSWORD 'postgres';
GRANT ALL PRIVILEGES ON DATABASE pgboss to postgres;
-- run the following command in the context of the pgboss database
CREATE EXTENSION pgcrypto;
```

If you use a different database name, username or password, or want to run the test suite against a database that is running on a remote machine then you will need to edit the `test/config.json` file with the appropriate connection values.

You can then run the linter and test suite using:

```bash
npm test
```

## Attribution

This is a fork of [pg-boss](https://github.com/timgit/pg-boss) by Tim Jones, forked from version 9.0.3 (July 2023). This fork is maintained independently by My Technology, Inc. and is not affiliated with the original project.
