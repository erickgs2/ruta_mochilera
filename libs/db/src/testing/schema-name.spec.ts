import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyTestSchema, composeSchemaName, isDroppableTestSchema, schemaScope, workspaceFingerprint } from './schema-name';

const MAIN = '/work/ruta_mochilera';
const WORKTREE = '/work/ruta_mochilera/.worktrees/phase-2b-fixes';

describe('test schema names', () => {
  // A developer's own TEST_SCHEMA_PREFIX must not decide what these assert.
  beforeEach(() => {
    vi.stubEnv('TEST_SCHEMA_PREFIX', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('differ between two workspace roots for the same project and worker', () => {
    const main = composeSchemaName({ project: 'api', workerId: '0', workspaceRoot: MAIN });
    const worktree = composeSchemaName({ project: 'api', workerId: '0', workspaceRoot: WORKTREE });

    expect(main).not.toBe(worktree);
  });

  it('are the same for the same workspace root, run after run', () => {
    const first = composeSchemaName({ project: 'api', workerId: '3', workspaceRoot: WORKTREE });
    const second = composeSchemaName({ project: 'api', workerId: '3', workspaceRoot: WORKTREE });

    expect(first).toBe(second);
    expect(first).toBe(`test_${workspaceFingerprint(WORKTREE)}_api_w3`);
  });

  it('still tell projects and workers apart within one workspace', () => {
    const names = new Set(
      ['api', 'db', 'customers'].flatMap((project) =>
        ['0', '1'].map((workerId) => composeSchemaName({ project, workerId, workspaceRoot: MAIN }))
      )
    );

    expect(names.size).toBe(6);
  });

  it('use a short, fixed-length fingerprint of the root', () => {
    expect(workspaceFingerprint(MAIN)).toMatch(/^[0-9a-f]{6}$/);
    expect(workspaceFingerprint(`${MAIN}/`)).toBe(workspaceFingerprint(MAIN));
  });

  it('never exceed 63 bytes, keep the scope, and stay unique when the project name is long', () => {
    const long = 'a-very-long-project-name-'.repeat(4);
    const first = composeSchemaName({ project: `${long}one`, workerId: '12', workspaceRoot: MAIN });
    const second = composeSchemaName({ project: `${long}two`, workerId: '12', workspaceRoot: MAIN });

    for (const name of [first, second]) {
      expect(Buffer.byteLength(name)).toBeLessThanOrEqual(63);
      expect(name).toMatch(/^[a-z0-9_]+$/);
      expect(name.startsWith(`test_${workspaceFingerprint(MAIN)}_`)).toBe(true);
    }
    expect(first).not.toBe(second);
  });

  it('take TEST_SCHEMA_PREFIX in place of the fingerprint', () => {
    expect(schemaScope(MAIN, 'My-Run 7')).toBe('custom_my_run_7');
    expect(schemaScope(MAIN, undefined)).toBe(workspaceFingerprint(MAIN));
    expect(composeSchemaName({ project: 'api', workerId: '0', workspaceRoot: MAIN, scope: schemaScope(MAIN, 'My-Run 7') })).toBe(
      'test_custom_my_run_7_api_w0'
    );
  });

  it('are classified by owner for the cleanup script', () => {
    const scope = workspaceFingerprint(MAIN);
    const other = workspaceFingerprint(WORKTREE);

    expect(classifyTestSchema(composeSchemaName({ project: 'api', workerId: '0', workspaceRoot: MAIN }), scope)).toBe('own');
    expect(classifyTestSchema(`test_${scope}_api_w0_jobs`, scope)).toBe('own');
    expect(classifyTestSchema(composeSchemaName({ project: 'api', workerId: '0', workspaceRoot: WORKTREE }), scope)).toBe('other-scope');
    expect(other).not.toBe(scope);
    expect(classifyTestSchema('test_api_w0', scope)).toBe('legacy');
    expect(classifyTestSchema('test_domain_reservations_w12_jobs', scope)).toBe('legacy');
    expect(classifyTestSchema('test_database_backup', scope)).toBe('unrelated');
    expect(classifyTestSchema('public', scope)).toBe('unrelated');
  });

  it('never mistake a legacy schema for one of ours, whatever TEST_SCHEMA_PREFIX says', () => {
    const scope = schemaScope(MAIN, 'api');
    const own = composeSchemaName({ project: 'api', workerId: '0', workspaceRoot: MAIN, scope });

    expect(own).toBe('test_custom_api_api_w0');
    expect(classifyTestSchema(own, scope)).toBe('own');
    expect(classifyTestSchema('test_api_w0', scope)).toBe('legacy');
    expect(classifyTestSchema('test_api_w0_jobs', scope)).toBe('legacy');
    // A custom scope is not a fingerprint either.
    expect(classifyTestSchema(own, workspaceFingerprint(MAIN))).not.toBe('own');
  });

  it('are only dropped when they are plain, short test identifiers', () => {
    expect(isDroppableTestSchema('test_2f4276_api_w0_jobs')).toBe(true);
    expect(isDroppableTestSchema('test_api_w0')).toBe(true);
    expect(isDroppableTestSchema('public')).toBe(false);
    expect(isDroppableTestSchema('test_x"; DROP SCHEMA public; --_w0')).toBe(false);
    expect(isDroppableTestSchema('test_Upper_w0')).toBe(false);
    expect(isDroppableTestSchema('test_with space_w0')).toBe(false);
    expect(isDroppableTestSchema(`test_${'a'.repeat(60)}_w0`)).toBe(false);
  });
});
