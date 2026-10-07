# db

This library was generated with [Nx](https://nx.dev).

## Running unit tests

Run `nx test db` to execute the unit tests via [Vitest](https://vitest.dev/).

## Test schemas

Integration tests share one PostgreSQL database (`rm_test`) and give every
Vitest worker its own schema inside it, named
`test_<fingerprint>_<project>_w<id>`. The fingerprint is a stable 6-character
hash of the workspace root, so the main working tree and each git worktree
get different schemas and can test in parallel without truncating each
other's rows. Set `TEST_SCHEMA_PREFIX` to use a name you choose instead of
the fingerprint; it goes behind a `custom_` marker (`TEST_SCHEMA_PREFIX=api`
gives `test_custom_api_<project>_w<id>`), so a custom scope can never be
taken for the old shared names (`test_api_w0`) or for another checkout's
fingerprint.

Schemas are reused between runs (that is what keeps `prepareTestDb()` cheap),
so they pile up. To clean up:

```bash
pnpm db:test:clean                  # dry run: list the schemas by owner
pnpm db:test:clean --apply          # drop this checkout's schemas
pnpm db:test:clean --apply --legacy # also the old shared test_<project>_w<id> ones
pnpm db:test:clean --apply --others # also other checkouts' (asks first; --yes skips it)
```

Another checkout's schemas may be in use right now, so only `--others`
touches them. A schema that cannot be locked within 3 seconds is reported and
skipped. If you run with `TEST_SCHEMA_PREFIX`, run the cleanup with the same
value so it knows which schemas are yours.
