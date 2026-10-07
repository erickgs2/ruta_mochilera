/**
 * Hands a downloaded `Blob` (a receipt PDF) to the browser as a file. The
 * same helper as `saveFile` in `@rm/ui`, duplicated for the reason
 * `ErrorCodePipe` explains: this app does not consume `@rm/ui`.
 */
export function saveFile(blob: Blob, fileName: string, doc: Document = document): void {
  const url = URL.createObjectURL(blob);
  const link = doc.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  doc.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
