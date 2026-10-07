/**
 * A small RFC 4180 reader and writer: commas, double-quoted fields with
 * `""` escapes, embedded commas and line breaks, CRLF or LF, and a leading
 * UTF-8 byte-order mark (what Excel writes when it saves "CSV UTF-8").
 * Enough for the two import templates, without a dependency.
 */

export function parseCsv(text: string): string[][] {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;

  while (i < input.length) {
    const char = input[i] as string;
    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += char;
      i += 1;
      continue;
    }
    if (char === '"' && field === '') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      if (char === '\r' && input[i + 1] === '\n') i += 1;
    } else {
      field += char;
    }
    i += 1;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // A trailing newline, or blank lines a spreadsheet leaves behind, are not rows.
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ''));
}

function escapeField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** CRLF line endings, the CSV convention spreadsheets expect. */
export function toCsv(rows: string[][]): string {
  return rows.map((row) => row.map(escapeField).join(',')).join('\r\n') + '\r\n';
}
