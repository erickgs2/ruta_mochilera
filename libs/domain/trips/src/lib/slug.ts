/** Builds a stable, URL-safe identifier from the Spanish trip name and its departure year. */
export function slugify(name: string, departureDate: Date): string {
  const base = name
    .normalize('NFD')
    // U+0300-U+036F is the Unicode "Combining Diacritical Marks" block: after
    // NFD normalization, an accented letter like "á" decomposes into "a" plus
    // one of these combining marks, so stripping the block removes accents
    // without touching the base letters. Written as an escaped range (not
    // literal combining characters) so an editor or a copy-paste cannot
    // silently mangle the character class.
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${base}-${departureDate.getUTCFullYear()}`;
}
