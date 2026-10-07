interface TripImage {
  url: string;
  isCover: boolean;
  position: number;
  altText: string | null;
}

/** The image flagged as cover, else the first by position, else `null` for a trip with no photos. */
export function coverImage<T extends TripImage>(images: readonly T[]): T | null {
  return images.find((image) => image.isCover) ?? [...images].sort((a, b) => a.position - b.position)[0] ?? null;
}
