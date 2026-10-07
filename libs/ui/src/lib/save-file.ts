/**
 * Hands a downloaded `Blob` (a receipt PDF, a CSV template) to the browser
 * as a file named `fileName`. The object URL is released right after the
 * click: the browser has its own reference to the download by then.
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
