import { verifyAccessToken } from '@rm/domain-identity';
import { loadActorPermissions, type Actor } from '@rm/domain-rbac';
import { config } from '../config';
import { db } from '../db';

/**
 * Resolves the caller from the Authorization header. Returns null when
 * anonymous or invalid.
 *
 * Deliberately re-reads the user row rather than trusting the token's
 * claims: a disabled account must lose access within the access-token TTL,
 * not only after its refresh token is next used.
 */
export async function getActor(request: Request): Promise<Actor | null> {
  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) return null;

  const claims = await verifyAccessToken(header.slice('Bearer '.length), config().jwtSecret);
  if (!claims.ok) return null;

  const user = await db().user.findUnique({ where: { id: claims.value.sub } });
  if (!user || user.status === 'DISABLED') return null;

  return {
    userId: user.id,
    type: user.type,
    locale: user.locale,
    permissions: user.type === 'STAFF' ? await loadActorPermissions(db(), user.id) : [],
  };
}
