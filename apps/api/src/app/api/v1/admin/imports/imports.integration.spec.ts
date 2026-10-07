import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import { APPLY_IMPORT_JOB } from '@rm/jobs';
import { closeTestQueue, resetTestQueue, withTestQueue } from '@rm/jobs/testing';
import type { PgBoss } from 'pg-boss';
import { loginAs, seedPermissionCatalog } from '../../../../../test-support/auth-fixtures';
import { setQueue } from '../../../../../lib/queue';
import { POST as applyRoute } from './[batchId]/apply/route';
import { GET as batchRoute } from './[batchId]/route';
import { GET as listRoute, POST as uploadRoute } from './route';
import { GET as templateRoute } from './templates/[type]/route';

const db = withTestDb();
const noParams = { params: Promise.resolve({}) };

function request(url: string, token: string, body?: unknown) {
  return new Request(`http://localhost${url}`, {
    method: body === undefined ? 'GET' : 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), authorization: `Bearer ${token}` },
  });
}

describe('import endpoints', () => {
  let queue: PgBoss;

  beforeAll(async () => {
    await prepareTestDb();
    await db.$connect();
    queue = await withTestQueue();
    setQueue(queue);
  });
  beforeEach(async () => {
    await resetDatabase(db);
    await resetTestQueue();
    await seedPermissionCatalog(db);
  });
  afterAll(async () => {
    setQueue(undefined);
    await closeTestQueue();
    await closeTestDb();
  });

  it('downloads a template, validates an upload, shows it, applies it once', async () => {
    const token = await loginAs(db, 'admin@agency.test', ['import.manage']);

    const template = await templateRoute(request('/api/v1/admin/imports/templates/customers', token), {
      params: Promise.resolve({ type: 'customers' }),
    });
    expect(template.status).toBe(200);
    expect(template.headers.get('content-type')).toContain('text/csv');
    const content = await template.text();
    expect(content).toContain('full_name,email,phone,birth_date,locale');

    const uploaded = await uploadRoute(
      request('/api/v1/admin/imports', token, { type: 'CUSTOMERS', fileName: 'plantilla-clientes.csv', content }),
      noParams
    );
    expect(uploaded.status).toBe(201);
    const batch = await uploaded.json();
    expect(batch).toMatchObject({ status: 'VALIDATED', rowsTotal: 1, rowsOk: 1, rowsFailed: 0, sendEmails: false });

    const listed = await listRoute(request('/api/v1/admin/imports', token), noParams);
    expect((await listed.json()).map((item: { id: string }) => item.id)).toEqual([batch.id]);
    const shown = await batchRoute(request(`/api/v1/admin/imports/${batch.id}`, token), { params: Promise.resolve({ batchId: batch.id }) });
    expect((await shown.json()).report.rows[0].status).toBe('VALID');

    const applied = await applyRoute(request(`/api/v1/admin/imports/${batch.id}/apply`, token, {}), { params: Promise.resolve({ batchId: batch.id }) });
    expect(applied.status).toBe(202);
    expect(await queue.findJobs(APPLY_IMPORT_JOB, {})).toHaveLength(1);
    const again = await applyRoute(request(`/api/v1/admin/imports/${batch.id}/apply`, token, {}), { params: Promise.resolve({ batchId: batch.id }) });
    expect(again.status).toBe(409);
    expect((await again.json()).code).toBe('IMPORT_ALREADY_APPLIED');
  });

  it('answers 413 IMPORT_TOO_LARGE and 403 without import.manage', async () => {
    const token = await loginAs(db, 'admin@agency.test', ['import.manage']);
    const other = await loginAs(db, 'desk@agency.test', ['customer.manage']);

    const tooBig = await uploadRoute(
      request('/api/v1/admin/imports', token, { type: 'CUSTOMERS', fileName: 'x.csv', content: 'a'.repeat(5 * 1024 * 1024 + 1) }),
      noParams
    );
    expect(tooBig.status).toBe(413);

    const forbidden = await uploadRoute(request('/api/v1/admin/imports', other, { type: 'CUSTOMERS', fileName: 'x.csv', content: 'a' }), noParams);
    expect(forbidden.status).toBe(403);
  });
});
