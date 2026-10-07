import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import type { EmailMessage, EmailProvider } from '@rm/email';
import { ok } from '@rm/shared-utils';
import { loginAs, loginAsCustomer, seedPermissionCatalog } from '../../../../../test-support/auth-fixtures';
import { setEmail } from '../../../../../lib/email';
import { POST as acceptRoute } from '../../auth/invitation/accept/route';
import { POST as inviteRoute } from './[customerId]/invitation/route';
import { GET as detailRoute } from './[customerId]/route';
import { GET as searchRoute, POST as createRoute } from './route';

const db = withTestDb();

class RecordingEmail implements EmailProvider {
  readonly sent: EmailMessage[] = [];
  async send(message: EmailMessage) {
    this.sent.push(message);
    return ok({ providerMessageId: `msg-${this.sent.length}` });
  }
}

function request(url: string, token: string | undefined, body?: unknown) {
  return new Request(`http://localhost${url}`, {
    method: body === undefined ? 'GET' : 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
}
const noParams = { params: Promise.resolve({}) };
const withCustomer = (customerId: string) => ({ params: Promise.resolve({ customerId }) });

const NEW_CUSTOMER = {
  fullName: 'María Peña',
  email: 'maria@example.com',
  phone: '352 100 80 79',
  birthDate: '1990-05-17',
};

describe('counter customer endpoints', () => {
  let mail: RecordingEmail;

  beforeAll(async () => {
    await prepareTestDb();
    await db.$connect();
  });
  beforeEach(async () => {
    await resetDatabase(db);
    await seedPermissionCatalog(db);
    mail = new RecordingEmail();
    setEmail(mail);
  });
  afterEach(() => setEmail(undefined));
  afterAll(async () => {
    await closeTestDb();
  });

  it('registers with customer.manage (201, invitation sent) and finds the customer with customer.view', async () => {
    const manager = await loginAs(db, 'desk@agency.test', ['customer.manage', 'customer.view']);

    const created = await createRoute(request('/api/v1/admin/customers', manager, NEW_CUSTOMER), noParams);
    expect(created.status).toBe(201);
    const body = await created.json();
    expect(body).toMatchObject({ email: 'maria@example.com', origin: 'BRANCH', hasPassword: false, invitationSent: true });

    const found = await searchRoute(request('/api/v1/admin/customers?search=maria', manager), noParams);
    expect(found.status).toBe(200);
    expect((await found.json()).items.map((c: { id: string }) => c.id)).toEqual([body.id]);

    const detail = await detailRoute(request(`/api/v1/admin/customers/${body.id}`, manager), withCustomer(body.id));
    expect(detail.status).toBe(200);
    expect((await detail.json()).reservations).toEqual([]);
  });

  it('answers 409 CUSTOMER_ALREADY_EXISTS with the existing id', async () => {
    const manager = await loginAs(db, 'desk@agency.test', ['customer.manage']);
    const first = await (await createRoute(request('/api/v1/admin/customers', manager, NEW_CUSTOMER), noParams)).json();

    const again = await createRoute(request('/api/v1/admin/customers', manager, NEW_CUSTOMER), noParams);

    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: 'CUSTOMER_ALREADY_EXISTS', details: { customerId: first.id } });
  });

  it('requires customer.view to search and customer.manage to register; a customer reaches neither', async () => {
    const viewer = await loginAs(db, 'viewer@agency.test', ['customer.view']);
    const nobody = await loginAs(db, 'guide@agency.test', ['reservation.view']);
    const { token: customer } = await loginAsCustomer(db, 'traveler@example.com');

    expect((await createRoute(request('/api/v1/admin/customers', viewer, NEW_CUSTOMER), noParams)).status).toBe(403);
    expect((await searchRoute(request('/api/v1/admin/customers', nobody), noParams)).status).toBe(403);
    expect((await searchRoute(request('/api/v1/admin/customers', customer), noParams)).status).toBe(403);
    expect((await searchRoute(request('/api/v1/admin/customers', undefined), noParams)).status).toBe(401);
  });

  it('lets the customer accept the invitation once, then resend is refused', async () => {
    const manager = await loginAs(db, 'desk@agency.test', ['customer.manage']);
    const created = await (await createRoute(request('/api/v1/admin/customers', manager, NEW_CUSTOMER), noParams)).json();
    const token = /token=([A-Za-z0-9_-]+)/.exec(mail.sent[0]?.text ?? '')?.[1];

    const accepted = await acceptRoute(
      request('/api/v1/auth/invitation/accept', undefined, { token, password: 'Correct-Horse-1', acceptTerms: true }),
      noParams
    );
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ email: 'maria@example.com' });

    const reused = await acceptRoute(
      request('/api/v1/auth/invitation/accept', undefined, { token, password: 'Correct-Horse-1', acceptTerms: true }),
      noParams
    );
    expect(reused.status).toBe(401);

    const resend = await inviteRoute(request(`/api/v1/admin/customers/${created.id}/invitation`, manager, {}), withCustomer(created.id));
    expect(resend.status).toBe(409);
  });

  it('refuses an invitation accepted without the terms', async () => {
    const response = await acceptRoute(
      request('/api/v1/auth/invitation/accept', undefined, { token: 'x', password: 'Correct-Horse-1', acceptTerms: false }),
      noParams
    );
    expect(response.status).toBe(422);
  });
});
