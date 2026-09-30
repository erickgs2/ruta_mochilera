import { ok, type Result } from '@rm/shared-utils';
import { storage } from '../storage';

/**
 * Adds the storage-computed `url` to each of a trip's gallery images before
 * it goes out over the wire.
 *
 * A URL is a transport concern, not a business rule: `local` and `s3`
 * compute one completely differently (see `LocalFileStorage.publicUrl` vs.
 * `S3Storage.publicUrl` in `@rm/storage`), and it depends on the deployment
 * host. That is exactly why `@rm/domain-trips`'s read path (`getTrip`,
 * `listTrips`, and the `toDto` both call) never receives a `StorageProvider`
 * -- unlike `addTripImage`/`deleteTripImage`, which inject one because
 * writing to storage genuinely is part of what those two do. This helper is
 * what fills the gap instead, applied here at the HTTP boundary to every
 * route that returns a full trip, reusing the same `storage().publicUrl(key)`
 * call the upload endpoint (`images/route.ts`) already makes for a
 * freshly-created `TripImage`.
 */
export function withImageUrls<T extends { images: readonly { storageKey: string }[] }>(
  trip: T
): T & { images: (T['images'][number] & { url: string })[] } {
  return {
    ...trip,
    images: trip.images.map((image) => ({ ...image, url: storage().publicUrl(image.storageKey) })),
  };
}

/** Applies `withImageUrls` to a successful `Result`, passing a failure through untouched. */
export function withImageUrlsResult<T extends { images: readonly { storageKey: string }[] }>(
  result: Result<T>
): Result<T & { images: (T['images'][number] & { url: string })[] }> {
  return result.ok ? ok(withImageUrls(result.value)) : result;
}
