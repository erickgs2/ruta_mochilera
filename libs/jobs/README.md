# jobs

Job (queue entry) names and payload types shared between the producers that
enqueue them (`libs/domain/notifications`) and the consumer that registers
and runs them (`apps/worker`). No pg-boss import here on purpose: this
library only names things, so a producer can name a job without depending
on the queue library's runtime.

This library was generated with [Nx](https://nx.dev).

## Running unit tests

Run `nx test jobs` to execute the unit tests via [Vitest](https://vitest.dev/).
