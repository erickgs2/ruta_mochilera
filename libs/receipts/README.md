# receipts

Payment receipts as PDF (Phase 2B, business rule 5.4 in
`docs/business-rules/payments.md`).

- `ReceiptRenderer` is the port; `PdfLibReceiptRenderer` draws one US Letter
  page with `pdf-lib`, Poppins embedded through `@pdf-lib/fontkit`.
- `FakeReceiptRenderer` is for tests: its "PDF" carries the data it was given.
- Fonts and logo are embedded as base64 in `embedded-assets.generated.ts`, so
  nothing is read from disk at runtime (the worker runs under `tsx`, the API
  inside the Next.js bundle). Regenerate with
  `node libs/receipts/scripts/embed-assets.mjs`.
