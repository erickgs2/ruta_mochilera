import { randomUUID } from 'node:crypto';
import type { Db } from '@rm/db';
import { fail, ok, type Result } from '@rm/shared-utils';
import type { StorageProvider } from '@rm/storage';

/**
 * What the customer's own profile screen reads (spec §223). `email` is
 * read-only here: changing it would require verifying the new address again,
 * which is not part of this phase, so no function in this file writes it.
 */
export interface CustomerProfileDto {
  fullName: string;
  phone: string;
  email: string;
  photoUrl: string | null;
}

/** The only fields a customer may change on their own profile. */
export interface UpdateCustomerProfileInput {
  fullName?: string;
  phone?: string;
}

/** An already validated image: the HTTP layer sniffs the bytes and derives type and extension from them. */
export interface CustomerPhotoInput {
  buffer: Buffer;
  contentType: string;
  extension: string;
}

async function loadProfile(db: Db, storage: StorageProvider, userId: string): Promise<Result<CustomerProfileDto>> {
  const user = await db.user.findUnique({ where: { id: userId }, include: { customerProfile: true } });
  // Staff users have no customer profile; this resource is the customer's own.
  if (!user?.customerProfile) return fail('NOT_FOUND');
  const { fullName, phone, photoKey } = user.customerProfile;
  return ok({ fullName, phone, email: user.email, photoUrl: photoKey ? storage.publicUrl(photoKey) : null });
}

export async function getCustomerProfile(
  db: Db,
  storage: StorageProvider,
  userId: string
): Promise<Result<CustomerProfileDto>> {
  return loadProfile(db, storage, userId);
}

/** Changes the name and/or the phone; a field left out keeps its value. */
export async function updateCustomerProfile(
  db: Db,
  storage: StorageProvider,
  userId: string,
  input: UpdateCustomerProfileInput
): Promise<Result<CustomerProfileDto>> {
  const existing = await db.customerProfile.findUnique({ where: { userId }, select: { userId: true } });
  if (!existing) return fail('NOT_FOUND');

  await db.customerProfile.update({
    where: { userId },
    data: {
      ...(input.fullName !== undefined ? { fullName: input.fullName } : {}),
      ...(input.phone !== undefined ? { phone: input.phone } : {}),
    },
  });
  return loadProfile(db, storage, userId);
}

/**
 * Replaces the profile photo. The key is derived from the user id and a fresh
 * UUID -- never from anything the client sent -- so it cannot collide with or
 * overwrite another object. The previous photo is deleted only after the new
 * key is saved, so a failure in between leaves an orphaned file at worst,
 * never a profile pointing at nothing.
 */
export async function setCustomerPhoto(
  db: Db,
  storage: StorageProvider,
  userId: string,
  input: CustomerPhotoInput
): Promise<Result<CustomerProfileDto>> {
  const existing = await db.customerProfile.findUnique({ where: { userId }, select: { photoKey: true } });
  if (!existing) return fail('NOT_FOUND');

  const key = `customers/${userId}/${randomUUID()}.${input.extension}`;
  await storage.put(key, input.buffer, input.contentType);
  await db.customerProfile.update({ where: { userId }, data: { photoKey: key } });
  if (existing.photoKey) await storage.delete(existing.photoKey).catch(() => undefined);

  return loadProfile(db, storage, userId);
}
