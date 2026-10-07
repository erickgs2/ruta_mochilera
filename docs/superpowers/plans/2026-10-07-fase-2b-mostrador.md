# Fase 2B — El mostrador opera · Plan de implementación

> **For agentic workers:** Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que un trabajador atienda en el mostrador —alta de cliente, reserva, cobro en efectivo— y que el cliente reciba su recibo PDF; que el saldo a favor y el cambio de precio funcionen; y que la agencia pueda cargar su historia.

**Architecture:** Se extiende lo que dejó la 2A. Dos dominios nuevos (`libs/domain/customers`, `libs/domain/imports`), saldo a favor y folio de recibo dentro de `libs/domain/payments`, un adaptador de PDF (`libs/receipts`) detrás de un puerto, un job nuevo en `apps/worker`, y pantallas nuevas en el panel y en la app cliente.

**Tech Stack:** el de la 2A, más `pdf-lib` (con `@pdf-lib/fontkit` para Poppins) para los recibos.

**Spec:** `docs/superpowers/specs/2026-10-07-fase-2b-mostrador-diseno.md`

---

## Global Constraints

Las de la 2A siguen vigentes sin cambios (`docs/superpowers/plans/2026-10-03-fase-2a-reservas-y-pagos.md`, «Global Constraints»): código en inglés, dinero en centavos `Int`, fechas de calendario en la zona de la organización, `libs/domain` sin HTTP, nada de `@prisma/client`, sin `tx as Db`, códigos de error estables en `STATUS_BY_CODE` y en **ambos** catálogos, TDD, verificación sin caché, documentación viva en el mismo commit.

Además, aprendidas al cerrar la 2A:

- **Ninguna llamada de red dentro de una transacción.** Stripe, Resend o el almacenamiento van después del commit, o encolados con la bandeja de salida. Ver `docs/business-rules/payments.md`, «La llamada al proveedor ocurre después del commit».
- **`reservations` y `payments` no se importan entre sí.** Cuando una operación de un dominio debe escribir algo del otro en la misma transacción (cancelar crea saldo a favor; cambiar el precio también), el otro dominio expone la función y la API la **inyecta** como gancho tipado estructuralmente, igual que `CancelPendingPaymentIntents`.
- **Nada de rutas absolutas a assets** (`/assets/...`) en las apps: siempre relativas al `base href`.
- **Colores y tipografía** sólo desde los tokens de `docs/brand.md`.
- **Toda prueba E2E nueva** va a `apps/client-e2e` con el arranque determinista que ya existe.

### Donde este plan y el código difieran, manda el código

Igual que en la 2A: las pruebas se describen con precisión porque son la especificación; las implementaciones, por contrato e invariantes. Un defecto del plan se corrige y se reporta, no se copia.

### Estado heredado que ya existe

| Pieza | Dónde |
|---|---|
| Reservas, cupo bajo bloqueo, cancelar y rechazar solicitudes | `@rm/domain-reservations` |
| `recordPayment`, `confirmPaymentWithin`, webhook | `@rm/domain-payments` |
| Avisos con bandeja de salida transaccional | `@rm/domain-notifications`, job `SEND_NOTIFICATION_EMAIL_JOB` |
| Restablecer contraseña con token de un solo uso | `@rm/domain-identity` (`password-reset.ts`) |
| Puerto de correo | `@rm/email` |
| Almacenamiento | `@rm/storage` |
| Permisos ya en el catálogo | `customer.view`, `customer.manage`, `reservation.create`, `payment.register`, `payment.credit.apply`, `trip.change_price`, `data.backfill`, `import.manage`, `settings.manage` |
| E2E | `apps/client-e2e` |

### Requisitos externos

| Requisito | Bloquea | Sin él |
|---|---|---|
| Dominio verificado en Resend | Que invitaciones y recibos lleguen al correo | Todo se construye y se prueba igual con el proveedor de consola |

---

## Estructura de archivos

```
libs/
  domain/customers/            búsqueda, alta en mostrador, invitación (nuevo)
  domain/imports/              plantillas, validación y aplicación de CSV (nuevo)
  domain/payments/             + credit-service.ts, receipt-number.ts, counter-payment.ts
  domain/reservations/         + branch reservations, backfill, price change
  receipts/                    puerto ReceiptRenderer + pdf-lib (nuevo)
  email/                       + adjuntos
apps/
  worker/src/jobs/send-receipt.ts
  api/src/app/api/v1/admin/{customers,imports,backfill,settings}/…
  admin/src/app/features/{customers,imports,settings}/…
  client/src/app/features/{auth/invitation,account/credit}/…
docs/business-rules/{customers,imports}.md
docs/diagrams/{counter-sale,customer-credit}.md
```

---

## Tarea 1: Esquema de la Fase 2B

**Files:**
- Modify: `libs/db/prisma/schema.prisma`, `libs/db/prisma/seed.ts`
- Create: migración `phase_2b_counter`
- Modify: `libs/domain/reservations` (quitar `creditCents` del DTO), `libs/contracts`, `registry.ts`, `schema.d.ts` (vía `pnpm api:types`), fixtures que lo usan

Modelos y cambios de la spec §4: `CustomerCreditEntry`, `ReceiptCounter`, `ReservationPriceChange`, `ImportBatch`, `PasswordReset.purpose`, `PaymentMethod.CREDIT`, `Payment.receipt_number` único, se elimina `Reservation.credit_cents`. Claves nuevas de `SystemSetting` sembradas con los datos de los carteles.

- [ ] **Step 1: Pruebas de esquema que fallan** (`libs/db/src/lib/*-schema.spec.ts`)
  1. La base **rechaza** un `CustomerCreditEntry` con `amount_cents = 0` (CHECK).
  2. La base **rechaza** dos pagos con el mismo `receipt_number`.
  3. `ReceiptCounter` tiene `year` como llave primaria.
  4. `PasswordReset.purpose` existe con valor por omisión `RESET`: las filas de la 2A siguen siendo restablecimientos.
  5. La columna `reservations.credit_cents` ya no existe.
- [ ] **Step 2: Migración, `pnpm db:generate`, seed, verlas pasar.** El seed agrega `organization.name`, `organization.address`, `organization.phone`, `organization.website` e `invitation.ttl_days = 7`, sin pisar valores existentes.
- [ ] **Step 3: Quitar `creditCents`** del DTO, del contrato y de sus pruebas; `pnpm api:types` debe quedar sin cambios después.
- [ ] **Step 4: Verificar, documentar (`reservations.md`, `payments.md`) y commitear** — `feat(db): add the phase 2b counter, credit and import models`

---

## Tarea 2: Folio de recibo sin huecos

**Files:** Create `libs/domain/payments/src/lib/receipt-number.ts` (+ spec). Modify `payment-service.ts`.

**Produces:** `assignReceiptNumber(tx: DbTransactionClient, paymentId: string, paidAt: Date): Promise<string>`.

- Año = año de `paid_at` en la zona de la organización. `INSERT ... ON CONFLICT DO NOTHING` de la fila del año, luego `SELECT ... FOR UPDATE`, incremento y escritura del número, todo en el `tx` del llamador.
- Formato `{receipt.prefix}-{año}-{6 dígitos}`.
- Se llama en **todo** camino que deja un pago en `SUCCEEDED`: `recordPayment` cuando el estado inicial es `SUCCEEDED` y `confirmPaymentWithin` en la transición `PENDING → SUCCEEDED`.

- [ ] **Step 1: Pruebas que fallan**
  1. El primer pago de 2027 recibe `RM-2027-000001`; el segundo, `RM-2027-000002`.
  2. El año sale de `paid_at` en la zona de la organización: un pago a las 23:30 del 31 de diciembre en Ciudad de México es del año que termina, aunque en UTC ya sea 1 de enero.
  3. **Concurrencia**: veinte pagos confirmados en paralelo reciben veinte folios distintos y consecutivos, sin huecos.
  4. Una transacción que se revierte después de pedir folio **no deja hueco**: el siguiente pago recibe el número que la revertida no usó.
  5. Un pago `PENDING` no tiene folio; lo recibe al confirmarse por el webhook.
  6. Un pago `FAILED` o `EXPIRED` nunca tiene folio.
- [ ] **Step 2–3: Implementar, verlas pasar, documentar (`payments.md`, `payment-flow.md`) y commitear** — `feat(payments): number receipts per year without gaps`

---

## Tarea 3: Saldo a favor

**Files:** Create `libs/domain/payments/src/lib/credit-service.ts` (+ spec). Modify `libs/domain/reservations/src/lib/reservation-service.ts` (gancho en `cancelReservation`), la ruta de cancelación.

**Produces:**
- `creditBalance(db | tx, customerId): Promise<number>`
- `listCreditEntries(db, customerId): Promise<Result<CreditEntryDto[]>>`
- `addCreditEntry(tx, { customerId, amountCents, kind, reservationId?, paymentId?, reason?, actorId? }): Promise<Result<CreditEntryDto>>` — bloquea la fila del cliente (`customer_profiles ... FOR UPDATE`), suma bajo el bloqueo, rechaza si el saldo quedaría negativo.
- `refundCredit(db, { customerId, amountCents, reason, actorId })` y `adjustCredit(db, { customerId, amountCents (con signo), reason, actorId })`.
- `applyCreditToReservation(db, queue, { reservationId, amountCents, actorId })`: en una transacción, bloquea la reserva, verifica que sea viva y del mismo cliente, crea el `Payment` `CREDIT` vía `recordPayment` (folio incluido, activa si cubre el anticipo), escribe el `APPLIED` y encola el recibo.
- `creditFromCancellation(tx, reservation)`: el gancho que `cancelReservation` recibe **inyectado** y llama dentro de su transacción cuando `paid_cents > 0`.

- [ ] **Step 1: Pruebas que fallan**
  1. Cancelar una reserva con $1,500 pagados deja un `CANCELLATION` de +150 000 y saldo 150 000. Cancelar una sin pagos no crea movimiento. Cancelar dos veces no lo duplica.
  2. La reserva cancelada conserva su `paid_cents` y sus pagos.
  3. `refundCredit` y `adjustCredit` exigen motivo; `adjustCredit` acepta positivos y negativos; ninguno deja el saldo bajo cero (`CREDIT_INSUFFICIENT`).
  4. `applyCreditToReservation` crea un pago `CREDIT` con folio, mueve `paid_cents`, activa una `HELD` que cubre el anticipo y deja un `APPLIED` del mismo monto.
  5. No aplica más que el saldo del cliente ni más que el saldo pendiente de la reserva; no aplica a una reserva de otro cliente ni a una no viva.
  6. **Concurrencia**: dos aplicaciones simultáneas de $1,000 sobre un saldo de $1,500: una pasa, la otra es `CREDIT_INSUFFICIENT`.
  7. Cada movimiento queda en `AuditLog` con el actor y el motivo.
  8. La conciliación nocturna sigue sin desviación tras aplicar saldo.
- [ ] **Step 2–3: Implementar, verlas pasar, documentar** (`payments.md` con la sección de saldo a favor, `reservations.md` para la cancelación, `docs/diagrams/customer-credit.md` nuevo) **y commitear** — `feat(payments): add the customer credit ledger`

---

## Tarea 4: Recibos en PDF

**Files:** Create `libs/receipts` (puerto `ReceiptRenderer`, `PdfLibReceiptRenderer`, `FakeReceiptRenderer`, fuentes Poppins). Modify `libs/email` (adjuntos).

**Produces:**
- `interface ReceiptData { locale; organization: { name; address; phone; website }; receiptNumber; paidAt; customerName; tripName; tripDates; reservationCode; amountCents; method; totalCents; paidCents; balanceCents }`
- `ReceiptRenderer.render(data): Promise<Uint8Array>`
- `EmailMessage.attachments?: { filename; contentType; content: Uint8Array }[]`, soportado por Resend (base64) y por el proveedor de consola (registra nombre y tamaño).

- [ ] **Step 1: Pruebas que fallan**
  1. El PDF empieza con `%PDF-` y contiene el folio, el nombre del cliente, el monto formateado y los datos de la agencia (extraer el texto con `pdf-lib` o con un lector en la prueba).
  2. En inglés, las etiquetas y el formato de fecha y dinero cambian.
  3. Un nombre con acentos y «ñ» se dibuja correctamente (la fuente incrustada lo cubre).
  4. El proveedor de Resend envía el adjunto en base64 con su nombre y tipo; el de consola no falla con adjuntos.
- [ ] **Step 2–3: Implementar, verlas pasar y commitear** — `feat: render payment receipts as PDF`

---

## Tarea 5: Envío del recibo

**Files:** Create `apps/worker/src/jobs/send-receipt.ts` (+ spec); `SEND_RECEIPT_JOB` en `libs/jobs`. Modify los caminos que confirman pagos para encolarlo; `apps/worker/src/main.ts`.

**Produces:** `enqueueReceipt(tx, queue, paymentId)` en `@rm/domain-payments`, y `sendReceipt(db, storage, renderer, email, paymentId)` en el worker.

- Encolado en la **misma transacción** que confirma el pago (patrón de la Regla 11), salvo cuando el llamador lo silencia.
- `sendReceipt`: si no hay `receipt_key`, arma `ReceiptData` (foto del saldo **en el momento del pago**: total, pagado y pendiente tras este pago, guardados al confirmar o reconstruidos de los pagos anteriores), genera el PDF y lo guarda en `receipts/{año}/{folio}.pdf`; después lo envía adjunto y sella `receipt_sent_at`. Idempotente; un fallo del proveedor deja el PDF guardado y el envío para reintento.

- [ ] **Step 1: Pruebas que fallan**
  1. Un pago en efectivo encola exactamente un `SEND_RECEIPT`; uno silenciado, ninguno.
  2. Si la transacción del pago se revierte, el job no existe.
  3. `sendReceipt` guarda el PDF, lo envía al correo actual del cliente con el adjunto y sella `receipt_sent_at`; correrlo dos veces no reenvía.
  4. El recibo refleja el saldo de **ese** momento, no el actual: un segundo pago posterior no cambia el PDF del primero.
  5. Con el correo del proveedor fallando, el PDF queda guardado y `receipt_sent_at` sigue nulo.
- [ ] **Step 2–3: Implementar, verlas pasar, documentar (`payments.md`, `notifications.md`) y commitear** — `feat(worker): send payment receipts`

---

## Tarea 6: Clientes en mostrador

**Files:** Create `libs/domain/customers` (+ specs). Modify `libs/domain/identity` (aceptar invitación), rutas `admin/customers`, `auth/invitation/accept`, contratos, OpenAPI.

**Produces:** `searchCustomers(db, { query, page })`, `getCustomerForStaff(db, id)`, `createBranchCustomer(db, email, input, { sendInvitation, actorId })`, `sendInvitation(db, email, customerId)`, `acceptInvitation(db, { token, password, acceptTerms })`.

- [ ] **Step 1: Pruebas que fallan**
  1. La búsqueda encuentra por nombre parcial sin acentos («maria» encuentra «María»), por correo y por teléfono; pagina; no devuelve personal.
  2. El alta crea un `CUSTOMER` verificado, sin contraseña, `origin = BRANCH`, auditado, y envía la invitación salvo que se desmarque.
  3. Un correo ya registrado responde `CUSTOMER_ALREADY_EXISTS` con el id existente y no crea nada.
  4. Aceptar la invitación fija la contraseña, sella `activated_at` y los términos, y consume el token; un token usado, vencido o de restablecimiento no sirve como invitación (`TOKEN_INVALID`).
  5. Reenviar invalida la invitación anterior.
  6. Las rutas exigen `customer.view` / `customer.manage`; un `CUSTOMER` no las alcanza.
- [ ] **Step 2–3: Implementar, verlas pasar, documentar (`docs/business-rules/customers.md` nuevo, tabla de `CLAUDE.md`, guardián de CI) y commitear** — `feat: let the counter find, register and invite customers`

---

## Tarea 7: Reserva en mostrador y cobro en efectivo

**Files:** Modify `@rm/domain-reservations` (`createBranchReservation`), Create `libs/domain/payments/src/lib/counter-payment.ts`; rutas `POST /admin/reservations`, `POST /admin/reservations/{id}/payments`.

**Produces:** `createBranchReservation(db, queue, { tripId, customerId, actorId, initialPaymentCents? })` y `registerCashPayment(db, queue, { reservationId, amountCents, actorId })`.

La reserva con pago inicial necesita reservas **y** pagos en una transacción: el pago se inyecta como gancho (Global Constraints).

- [ ] **Step 1: Pruebas que fallan**
  1. Con pago ≥ anticipo, la reserva nace `ACTIVE` sin apartado, con el pago `CASH` con folio y el recibo encolado, todo o nada.
  2. Con pago < anticipo, nace `HELD` con el apartado del viaje y el pago registrado.
  3. Sin pago, nace `HELD`; el modo «con pago» exige monto > 0.
  4. Respeta cupo bajo bloqueo, viaje publicado, fecha límite y una reserva viva por cliente; si algo falla, no queda ni reserva ni pago.
  5. `registerCashPayment`: `> 0`, `≤ saldo`, sólo sobre reservas vivas, activa una `HELD` que cubre el anticipo, `recorded_by` = el trabajador.
  6. Permisos: crear exige `reservation.create`, y con pago además `payment.register`.
- [ ] **Step 2–3: Implementar, verlas pasar, documentar (`reservations.md`, `payments.md`, `docs/diagrams/counter-sale.md` nuevo) y commitear** — `feat: take reservations and cash at the counter`

---

## Tarea 8: Cambio de precio a reservas existentes

**Files:** Modify `@rm/domain-reservations` (`previewPriceChange`, `applyPriceChange`); plantilla `PRICE_CHANGED`; rutas `admin/trips/{id}/price-change`.

- [ ] **Step 1: Pruebas que fallan**
  1. La vista previa lista sólo las reservas `HELD`/`ACTIVE` cuyo total difiere del precio vigente, con total anterior, nuevo, pagado y efecto; sin ninguna, `NO_PRICE_CHANGE`.
  2. Aplicar sin texto en español es `VALIDATION_FAILED`.
  3. Una subida aumenta el total y el saldo; el estado no cambia; se registra `ReservationPriceChange`.
  4. Una bajada por debajo de lo pagado crea `PRICE_DECREASE` por la diferencia y deja el saldo en cero.
  5. Cada cliente afectado recibe `PRICE_CHANGED` con el texto del administrador y sus propios números, en su idioma (inglés si existe; si no, español).
  6. Todo en una transacción bajo el bloqueo del viaje: un pago simultáneo se aplica antes o después, nunca a medias.
  7. Exige `trip.change_price`.
- [ ] **Step 2–3: Implementar, verlas pasar, documentar (`reservations.md`, `notifications.md`, `trip-reservation.md`, `costing.md` con el vínculo) y commitear** — `feat: bring existing reservations to the trip's current price`

---

## Tarea 9: Captura histórica

**Files:** Modify `@rm/domain-reservations` (`createBackfilledReservation`), `@rm/domain-payments` (`recordBackfilledPayments`); rutas `admin/backfill/*`.

- [ ] **Step 1: Pruebas que fallan**
  1. Una reserva histórica sobre un viaje `IN_PROGRESS` o `COMPLETED` se crea con `created_at` pasado, `is_backfilled`, sin apartado, y cuenta para el cupo.
  2. Sobre un viaje `DRAFT` o `CANCELLED` se rechaza.
  3. Los pagos históricos llevan `paid_at` pasado, `is_backfilled`, folio del año de `paid_at`; abono único o desglose.
  4. Sin la casilla de envío no se encola ningún recibo ni invitación; con ella, sí.
  5. Exige `data.backfill`; todo auditado.
- [ ] **Step 2–3: Implementar, verlas pasar, documentar y commitear** — `feat: capture historical reservations and payments`

---

## Tarea 10: Importación CSV

**Files:** Create `libs/domain/imports` (+ specs); rutas `admin/imports/*`.

**Produces:** `importTemplate(type)`, `validateImport(db, type, csvText, { actorId, fileName, sendEmails })` → `ImportBatch` `VALIDATED` con la vista previa, `applyImport(db, queue, batchId, actorId)`.

- [ ] **Step 1: Pruebas que fallan**
  1. Las plantillas tienen exactamente las columnas de la spec §5.8 y una fila de ejemplo que valida sin errores.
  2. Validar no escribe nada salvo el lote; cada error trae fila, columna y código (`REQUIRED`, `INVALID_EMAIL`, `INVALID_DATE`, `INVALID_AMOUNT`, `UNKNOWN_TRIP`, `UNKNOWN_CUSTOMER`, `UNKNOWN_METHOD`, `DUPLICATE_IN_FILE`).
  3. Aplicar procesa las filas válidas aunque otras fallen, y el reporte dice cuál pasó y cuál no.
  4. Clientes: un correo ya existente es `EXISTS`, no error, y no duplica.
  5. Pagos: crea la reserva histórica si no hay una viva; `external_ref` repetido (en el archivo o ya importado) no se importa dos veces.
  6. Aplicar dos veces el mismo lote es `IMPORT_ALREADY_APPLIED`; más de 5,000 filas o 5 MB es `IMPORT_TOO_LARGE`.
  7. Montos en pesos con dos decimales se convierten a centavos sin error de punto flotante («1500.10» → 150 010).
- [ ] **Step 2–3: Implementar, verlas pasar, documentar (`docs/business-rules/imports.md` nuevo, `CLAUDE.md`, guardián) y commitear** — `feat: import customers and payments from CSV`

---

## Tarea 11: Datos de la agencia

**Files:** rutas `admin/settings/organization`; pantalla en el panel.

- [ ] **Step 1: Pruebas que fallan** — lee y guarda los cuatro datos; exige `settings.manage`; un recibo generado después usa los datos nuevos y uno ya generado no cambia.
- [ ] **Step 2–3: Implementar, verlas pasar y commitear** — `feat: let the agency edit its receipt details`

---

## Tarea 12: Panel — Clientes y mostrador

**Files:** `apps/admin/src/app/features/customers/*` (lista con búsqueda, alta, detalle con reservas, pagos y saldo a favor), acciones de mostrador en el detalle de reserva (registrar efectivo, recibos), navegación.

- [ ] **Step 1: Specs que fallan**: búsqueda con debounce; alta que, ante `CUSTOMER_ALREADY_EXISTS`, abre al cliente existente; nueva reserva con y sin pago; registrar efectivo con monto ≤ saldo; aplicar, devolver y ajustar saldo con motivo y confirmación; descargar y reenviar recibo; cada acción oculta sin su permiso.
- [ ] **Step 2: Implementar con la identidad visual** y verificar en 360, 768 y 1280 px.
- [ ] **Step 3: Commitear** — `feat(admin): add customers and counter screens`

---

## Tarea 13: Panel — Precio, captura histórica, importaciones y configuración

- [ ] **Step 1: Specs que fallan**: vista previa del cambio de precio antes de aplicar, aviso en español obligatorio; captura histórica con la casilla de envío desmarcada por omisión; importación: subir, ver errores por fila, confirmar, ver el reporte, descargar plantillas; configuración de la agencia.
- [ ] **Step 2–3: Implementar, verificar en los tres anchos y commitear** — `feat(admin): add price change, backfill, imports and settings screens`

---

## Tarea 14: App cliente

**Files:** `apps/client`: invitación, saldo a favor en «Mi cuenta», recibos en el historial de pagos, solicitud de cancelación en el detalle de reserva.

- [ ] **Step 1: Specs que fallan**: la invitación con token válido fija contraseña y lleva al inicio de sesión; con token inválido muestra el error traducido; el saldo a favor y sus movimientos se ven sin acciones; cada pago confirmado tiene su recibo descargable; solicitar cancelación con motivo opcional y confirmación; ver el estado «en revisión» y el rechazo con su motivo.
- [ ] **Step 2–3: Implementar con la identidad visual, verificar y commitear** — `feat(client): invitation, credit, receipts and cancellation requests`

---

## Tarea 15: Extremo a extremo, documentación y cierre

- [ ] **Step 1: E2E nuevos** en `apps/client-e2e`: (1) el trabajador da de alta a un cliente, crea una reserva con pago en efectivo que cubre el anticipo, la reserva queda `ACTIVE` y el recibo queda encolado con folio; (2) el cliente acepta la invitación con el token leído de la base y entra a la app, donde ve su reserva y descarga su recibo.
- [ ] **Step 2: Diagramas** `counter-sale.md` y `customer-credit.md` completos, todos los Mermaid validados.
- [ ] **Step 3: Verificación completa sin caché, E2E, revisión de toda la rama, y decisiones en `docs/decisiones-fase-2b.md`.**
- [ ] **Step 4: Commitear** — `docs: complete phase 2b documentation and end-to-end coverage`

---

## Cierre de la fase

Suite completa sin caché sobre el árbol a integrar, revisión final de la rama, y la integración la decide el dueño del producto.

**Lo que esta fase deliberadamente no hace:** todo lo de la Fase 3, reembolsos por Stripe, SPEI en la app y el cobro real con tarjeta (esperan las claves), y timbrado CFDI.
