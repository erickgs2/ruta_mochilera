# Fase 2A — Clientes, reservas y pagos · Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que un cliente se registre, reserve un viaje y lo pague desde su teléfono con tarjeta, OXXO o SPEI.

**Architecture:** Se extiende el monorepo de la Fase 1 con dos dominios nuevos (`reservations`, `payments`), un proceso de trabajos en segundo plano (`apps/worker`) sobre pg-boss, un adaptador de Stripe detrás de un puerto, y una segunda aplicación Angular (`apps/client`) empaquetada con Capacitor. La API y la base de datos son las mismas; los route handlers siguen siendo delgados y toda la lógica vive en `libs/domain`.

**Tech Stack:** Nx · pnpm · Node 24 · Next.js 16.3.6 · Prisma 7 · PostgreSQL · Zod 4 · Stripe (Payment Intents + Elements) · pg-boss · Resend · Angular 22 · Capacitor · Vitest / Jest · Playwright

**Spec:** `docs/superpowers/specs/2026-10-03-fase-2a-reservas-y-pagos-diseno.md`

---

## Global Constraints

Estas reglas aplican a **todas** las tareas y no se repiten en cada una.

- **Todo el código en inglés, sin excepción**: variables, funciones, clases, archivos, tablas, columnas, ramas, mensajes de commit y comentarios. Sólo `docs/**` va en español, junto con los catálogos `es.json` / `en.json`, que son contenido.
- **Nomenclatura**: `PascalCase` en modelos Prisma, `snake_case` en PostgreSQL vía `@@map`/`@map`, `camelCase` en TypeScript, `kebab-case` en archivos.
- **Dinero**: siempre `Int` en centavos MXN. Jamás `Float` ni `Decimal`.
- **Fechas**: `timestamptz` en UTC. Toda regla de calendario se evalúa en la zona de `SystemSetting['organization.timezone']`, **nunca hardcodeada**. Existe `organizationTimeZone(db)` en `libs/domain/trips` y `monthStartsBetween` / `isPastDate` en `@rm/shared-utils`.
- **`libs/domain` no importa nada de Next.js, Angular ni `@nx/*`.** Recibe un cliente Prisma inyectado y devuelve `Result<T>`.
- **Nunca importar `@prisma/client`.** Todo sale de `@rm/db`, que reexporta `Db`, `DbTransactionClient`, el namespace `Prisma`, los tipos de modelo y `uniqueViolationIndex`.
- **Sin `tx as Db`.** Los helpers que corren dentro de una transacción se tipan `DbTransactionClient`, que **no** es asignable a `Db`.
- **El backend nunca envía texto para mostrar a una persona.** Códigos estables; Angular traduce. Todo código nuevo va al mapa exhaustivo `STATUS_BY_CODE` y a **ambos** catálogos, o el build falla.
- **TDD obligatorio**: la prueba se escribe y se ve fallar antes de la implementación.
- **Verificación**: `pnpm nx run-many -t typecheck lint test build --skip-nx-cache`. Un verde cacheado no es evidencia.
- **Documentación viva**: tocar `libs/domain/**` exige actualizar `docs/business-rules/` en el mismo commit; tocar reservas o pagos exige además su diagrama. El guardián de CI lo hace cumplir.
- **Commits frecuentes**, Conventional Commits, en inglés.

### Lección de la Fase 1 que cambia cómo se usa este plan

El plan de la Fase 1 incluía el código completo de cada implementación, y **unos veinticinco de esos bloques contenían defectos** que los implementadores copiaron fielmente: un cast que no compilaba, dos pruebas de modos distintos esperando el mismo número, un `COPY . .` que habría horneado secretos en una imagen, una comprobación de permiso que nunca se aplicaba.

Por eso este plan invierte el peso: **las pruebas se dan completas, porque son la especificación**, y las implementaciones se describen por su contrato, su algoritmo y sus invariantes, dejando la escritura a quien tiene el código real delante.

**Donde este plan y el código ya commiteado difieran, manda el código.** Si un bloque de este plan no compila o contradice un patrón establecido, eso es un defecto del plan: corrígelo, dilo en tu reporte, y no lo copies.

### Estado heredado que ya existe y no hay que reconstruir

| Pieza | Dónde | Notas |
|---|---|---|
| Envoltorio `route()` | `apps/api/src/lib/http/route.ts` | Unión discriminada; `actor` no nulo en rutas autenticadas; `permission` o `anyPermission`; exige `application/json` en rutas con cuerpo |
| Arnés de pruebas | `@rm/db/testing` | `withTestDb`, `prepareTestDb`, `resetDatabase`, `closeTestDb`, `uniqueViolationIndex`. Aislamiento por esquema por worker |
| Sesión | `libs/domain/identity` + `apps/api/src/lib/http/refresh-cookie.ts` | Access token corto; refresh en cookie `httpOnly/Secure/SameSite=Strict`; rotación con detección de reuso; limitador de intentos reutilizable |
| Auditoría | `@rm/domain-audit` | `recordAudit(tx: DbTransactionClient, …)`, dentro de la transacción que registra |
| Almacenamiento | `@rm/storage` | Puerto `StorageProvider`, local y S3 |
| Contrato | `libs/contracts` + `apps/api/src/lib/openapi/registry.ts` | Zod como fuente de verdad; `pnpm api:types` regenera y debe ser no-op |
| Viajes y costeo | `@rm/domain-trips`, `@rm/domain-costing` | Incluye el stub `committedSeats` que esta fase rellena |

### Requisitos externos que bloquean tareas

El plan **empieza** verificándolos (Tarea 1) porque dos bloquean trabajo real:

| Requisito | Bloquea | Sin él |
|---|---|---|
| Cuenta de Stripe México con claves de prueba | Tareas 8–10, 16 | No hay cobro que probar |
| Dominio verificado en Resend | Tareas 6, 12 | El código OTP no llega y nadie se registra |
| IDs de cliente OAuth de Google | Tarea 13 | Login con Google desactivado |
| Cuenta de desarrollador de Apple | Tarea 13 | Login con Apple desactivado |

El login social se construye **desactivable por configuración**: si las cuentas no llegan, la fase cierra igual con correo y contraseña.

---

## Estructura de archivos

```
apps/
  worker/                        proceso pg-boss (nuevo)
    src/jobs/{expire-holds,warn-expiring-holds,reconcile-paid-cents}.ts
  client/                        app Angular + Capacitor (nueva)
  api/src/app/api/v1/
    public/trips/                catálogo sin autenticación
    reservations/                crear, listar propias, detalle, solicitud de cancelación
    reservations/[id]/payment-intents/
    payments/                    historial propio
    notifications/               bandeja
    webhooks/stripe/             entrada de eventos
libs/
  domain/reservations/           cupo con bloqueo, apartado, estados, pertenencia
  domain/payments/               saldo, registro de pagos, mensualidad sugerida
  domain/notifications/          entregas (correo + bandeja)
  payments-stripe/               adaptador: puerto PaymentProvider + implementación Stripe
  email/                         puerto EmailProvider + implementación Resend
  jobs/                          contratos de job y registro, compartidos por api y worker
docs/business-rules/{reservations,payments,notifications}.md
docs/diagrams/{trip-reservation,payment-flow}.md
```

**Por qué `libs/payments-stripe` y `libs/email` separados del dominio:** ambos hablan con un servicio externo. El dominio recibe un puerto y nunca sabe quién lo implementa — el mismo patrón que `StorageProvider` en la Fase 1, que permitió escribir S3 sin poder ejecutarlo.

---

## Tarea 1: Verificar requisitos externos y cerrar la deuda heredada

Esta tarea no entrega funcionalidad: comprueba que la fase puede ejecutarse y paga dos deudas que la Fase 1 marcó como bloqueantes al abrir ésta. Va primero porque descubrir en la Tarea 10 que no hay cuenta de Stripe es caro.

**Files:**
- Modify: `libs/shared-utils/src/lib/money.ts`, `money.spec.ts`
- Modify: `libs/domain/trips/src/lib/trip-service.ts` (`listTrips`)
- Test: `libs/domain/trips/src/lib/trip-service.spec.ts`
- Modify: `.env.example`, `README.md`

**Interfaces:**
- Produces: `roundUpToPeso` con comportamiento definido para negativos; `listTrips` sin N+1.

- [ ] **Step 1: Reportar el estado de los cuatro requisitos externos**

No escribas código todavía. Comprueba y **reporta** qué hay disponible:

```bash
printenv | grep -E '^(STRIPE_|RESEND_|GOOGLE_OAUTH_|APPLE_)' | sed 's/=.*/=<definida>/'
```

Si falta la clave de Stripe o el dominio de Resend, **dilo en el reporte y continúa igual**: las tareas afectadas se identifican en la cabecera del plan y el coordinador decidirá si se reordenan. No inventes credenciales ni mocks que oculten la ausencia.

- [ ] **Step 2: Escribir la prueba que fija el comportamiento de `roundUpToPeso` con negativos**

La Fase 1 dejó registrado que `roundUpToPeso(-150)` devuelve `-100`, porque redondea hacia cero. Hoy es inalcanzable; esta fase introduce saldos y la 2B introduce reembolsos.

```ts
describe('roundUpToPeso with negative input', () => {
  it('rounds away from zero so a refund is never understated', () => {
    expect(roundUpToPeso(-150)).toBe(-200);
    expect(roundUpToPeso(-100)).toBe(-100);
    expect(roundUpToPeso(-1)).toBe(-100);
  });
});
```

La dirección es deliberada: en un reembolso, redondear hacia cero devuelve **menos** de lo debido. Un peso de más para la agencia es preferible a un peso de menos para el cliente, y es la misma lógica por la que el precio de venta redondea hacia arriba.

- [ ] **Step 3: Verla fallar, implementar, verla pasar**

Run: `pnpm nx test shared-utils --skip-nx-cache`
Expected FAIL: `expected -100 to be -200`.

Implementa usando `Math.floor` para los negativos en lugar de `Math.ceil`. Comprueba que las pruebas existentes de positivos siguen pasando sin tocarlas.

- [ ] **Step 4: Escribir la prueba que detecta el N+1 de `listTrips`**

`listTrips` llama `committedSeats` por viaje dentro de un `Promise.all`. Mientras el stub devolvía ceros no tocaba la base; la Tarea 3 lo rellena con consultas reales y entonces es una consulta por viaje.

Escribe una prueba que cree **cinco** viajes y cuente las consultas emitidas. La forma más simple en este stack es un `$on('query')` de Prisma o un espía sobre el delegado que `committedSeats` use. La prueba debe afirmar que el número de consultas **no crece con el número de viajes**.

- [ ] **Step 5: Verla fallar y reemplazar por una consulta agrupada**

`committedSeats` debe ganar una variante que acepte varios `tripId` y devuelva un mapa. `listTrips` la llama una vez. La variante de un solo viaje se conserva para `toDto`.

Mantén intacto el comentario del stub que nombra la Fase 2 — ahora es esta fase quien lo rellena, y la Tarea 3 lo hará; aquí sólo se corrige la forma de llamarlo.

- [ ] **Step 6: Documentar las variables de entorno nuevas**

Añade a `.env.example` y a `.env.prod.example`, con marcadores y nunca valores reales:

```bash
STRIPE_SECRET_KEY=CHANGE_ME
STRIPE_WEBHOOK_SECRET=CHANGE_ME
STRIPE_PUBLISHABLE_KEY=CHANGE_ME
RESEND_API_KEY=CHANGE_ME
RESEND_FROM_ADDRESS=no-reply@CHANGE_ME
GOOGLE_OAUTH_CLIENT_ID=
APPLE_OAUTH_CLIENT_ID=
```

Los dos últimos quedan **vacíos a propósito**: vacío significa "proveedor desactivado", que es como el login social se degrada cuando las cuentas no están listas. Documéntalo en el comentario.

- [ ] **Step 7: Verificar y commitear**

Run: `pnpm nx run-many -t typecheck lint test build --skip-nx-cache`

```bash
git add -A
git commit -m "fix: round negatives away from zero and batch committed-seat lookups"
```

---

## Tarea 2: Esquema de reservas, pagos y avisos

**Files:**
- Modify: `libs/db/prisma/schema.prisma`
- Create: migración bajo `libs/db/prisma/migrations/`
- Test: `libs/db/src/lib/reservations-schema.spec.ts`
- Modify: `libs/db/src/index.ts` si hace falta reexportar tipos nuevos

**Interfaces:**
- Produces: modelos `Reservation`, `Payment`, `StripeEvent`, `NotificationDelivery` y sus enums, reexportados desde `@rm/db`.

- [ ] **Step 1: Escribir las pruebas de esquema que fallan**

Tres pruebas de integración, siguiendo el patrón de `libs/db/src/lib/schema.spec.ts` (que usa `prepareTestDb`, `resetDatabase` y `closeTestDb`):

1. **Una reserva se almacena con sus montos congelados.** Crea viaje y cliente, inserta una `Reservation` en `HELD` con `total_price_cents` y `minimum_deposit_cents`, y comprueba que vuelven intactos y que `paid_cents` y `credit_cents` arrancan en cero.
2. **Dos reservas vivas del mismo cliente en el mismo viaje son rechazadas.** Inserta una en `HELD`, intenta otra en `ACTIVE`, y afirma que la base la rechaza con una violación de índice único, usando `uniqueViolationIndex` para comprobar que es **ese** índice y no otro.
3. **Una reserva `CANCELLED` no bloquea una nueva.** Misma pareja viaje-cliente, la primera en `CANCELLED`: la segunda debe insertarse. Esto es lo que hace que el índice sea **parcial** y no total, y es la prueba que lo distingue.

- [ ] **Step 2: Verlas fallar**

Run: `pnpm nx test db --skip-nx-cache`
Expected FAIL: los modelos no existen.

- [ ] **Step 3: Escribir el esquema**

Los modelos están en §4 de la spec, con sus campos y tipos exactos. Puntos que la spec fija y que no son negociables:

- Todos los montos `Int`.
- `payment_deadline` y las fechas de calendario `@db.Date`; los instantes `@db.Timestamptz`.
- El índice único **parcial** sobre `(trip_id, customer_id)` restringido a `status IN ('HELD','ACTIVE')`. Prisma no expresa índices parciales en el esquema: se añaden con SQL crudo dentro de la migración. Escríbelo a mano y comprueba que `prisma migrate dev` lo conserva.
- `Payment.receipt_number`, `receipt_key` y `receipt_sent_at` se declaran ahora y **sólo los llena la 2B**. Se incluyen para no migrar la tabla dos veces; añade un comentario que lo diga.
- `StripeEvent.stripe_event_id` único: es la idempotencia de los webhooks.
- `CustomerProfile` gana `accepted_terms_at` (§4.4 de la spec), nullable: los clientes que ya existen no lo tienen y no se les puede inventar una fecha.
- `NotificationDelivery` con índice `(customer_id, created_at)`, que es como la bandeja consulta.

- [ ] **Step 4: Generar la migración y verla aplicar**

```bash
pnpm db:migrate --name reservations_payments_notifications
```

Revisa el SQL generado antes de aceptarlo. Confirma que el índice parcial aparece con su cláusula `WHERE`, porque es el único que Prisma no genera solo.

- [ ] **Step 5: Verificar, documentar y commitear**

Run: `pnpm nx run-many -t typecheck lint test build --skip-nx-cache`

Crea `docs/business-rules/reservations.md` con una sección inicial que describa los estados y el índice parcial — el guardián de CI exige que un cambio en el dominio traiga su documentación, y aunque esta tarea toca `libs/db` y no `libs/domain`, empezar el archivo ahora evita que la Tarea 3 tenga que crearlo y documentarlo a la vez.

```bash
git add -A
git commit -m "feat: add reservation, payment, stripe event and notification delivery models"
```

---

## Tarea 3: Cupo disponible con bloqueo de fila

Es la tarea con más riesgo de concurrencia de la fase. Va sola porque merece su propia revisión.

**Files:**
- Create: `libs/domain/reservations/src/lib/capacity.ts`, `capacity.spec.ts`
- Modify: `libs/domain/trips/src/lib/trip-service.ts` (rellenar `committedSeats`)
- Modify: `docs/business-rules/reservations.md`

**Interfaces:**
- Consumes: `Db`, `DbTransactionClient` de `@rm/db`; `availableSeats` de `@rm/domain-trips`.
- Produces:
  - `countCommittedSeats(db: DbTransactionClient, tripId: string): Promise<{ activeReservations: number; liveHolds: number }>`
  - `countCommittedSeatsForTrips(db: DbTransactionClient, tripIds: readonly string[]): Promise<Map<string, { activeReservations: number; liveHolds: number }>>`
  - `lockTripForCapacity(tx: DbTransactionClient, tripId: string): Promise<void>`

- [ ] **Step 1: Escribir la prueba de concurrencia que falla**

Ésta es la prueba que justifica la tarea. Un viaje con **un** lugar disponible y dos intentos simultáneos de reservarlo:

```ts
it('lets exactly one of two concurrent reservations take the last seat', async () => {
  const trip = await seedTrip(db, { totalCapacity: 1, preSoldSeats: 0 });
  const [a, b] = await seedCustomers(db, 2);

  const results = await Promise.all([
    createReservation(db, { tripId: trip.id, customerId: a.id }),
    createReservation(db, { tripId: trip.id, customerId: b.id }),
  ]);

  const succeeded = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  expect(succeeded).toHaveLength(1);
  expect(failed).toHaveLength(1);
  if (!failed[0].ok) expect(failed[0].error.code).toBe('TRIP_SOLD_OUT');

  const live = await db.reservation.count({
    where: { tripId: trip.id, status: { in: ['HELD', 'ACTIVE'] } },
  });
  expect(live).toBe(1);
});
```

Las dos llamadas deben lanzarse **antes** de esperar ninguna: un `await` de la primera convierte la prueba en secuencial y deja de probar concurrencia. Éste es el error que la Fase 1 encontró y corrigió en la rotación de tokens, y la prueba de allí (`auth-service.spec.ts`) es el modelo a seguir.

- [ ] **Step 2: Verla fallar por la razón correcta**

Run: `pnpm nx test reservations --skip-nx-cache`
Expected FAIL: `createReservation` no existe todavía. Esta prueba vive junto a la Tarea 4; si prefieres, escríbela aquí y déjala fallando hasta la Tarea 4, pero **no la borres ni la marques como pendiente** — debe estar roja y visible.

- [ ] **Step 3: Implementar el bloqueo y los conteos**

`lockTripForCapacity` emite `SELECT id FROM trips WHERE id = $1 FOR UPDATE` con `$queryRaw` parametrizado. Es un bloqueo de fila, no de tabla: dos reservas a viajes distintos no se estorban.

`countCommittedSeats` cuenta en una sola consulta las reservas `ACTIVE` y las `HELD` con `hold_expires_at > now()`. Agrúpalo con `groupBy` en lugar de dos consultas.

`countCommittedSeatsForTrips` hace lo mismo para varios viajes con un `IN`, devolviendo un mapa; es lo que la Tarea 1 dejó preparado para que `listTrips` no haga N+1. Un viaje sin reservas debe aparecer en el mapa con ceros, no ausente — un llamador que use `map.get(id)!` sobre un viaje sin reservas no debe reventar.

Rellena el stub `committedSeats` de `@rm/domain-trips` delegando en estas funciones, y **borra el comentario que dice que la Fase 2 lo rellenará**, porque ya está rellenado.

- [ ] **Step 4: Verla pasar y comprobar que detecta la regresión**

Run: `pnpm nx test reservations --skip-nx-cache`

Luego quita temporalmente la llamada a `lockTripForCapacity`, vuelve a correr la prueba de concurrencia y **confirma que falla** con dos éxitos. Restaura. Un bloqueo que nunca se vio hacer falta no está verificado — es el mismo estándar que se aplicó a cada guarda de la Fase 1.

- [ ] **Step 5: Documentar y commitear**

Añade a `docs/business-rules/reservations.md` la fórmula del cupo, por qué no se almacena, y que el cálculo exige el bloqueo. La Fase 1 dejó un comentario en `capacity.ts` diciendo que el bloqueo haría falta cuando hubiera contención: ahora la hay, así que actualiza también ese comentario para que no siga hablando en futuro.

```bash
git add -A
git commit -m "feat: compute committed seats under a row lock"
```

---

## Tarea 4: Servicio de reservas — crear, apartar, consultar

**Files:**
- Create: `libs/domain/reservations/src/lib/reservation-service.ts`, `reservation-service.spec.ts`
- Create: `libs/domain/reservations/src/lib/reservation-code.ts`, `reservation-code.spec.ts`
- Modify: `libs/domain/reservations/src/index.ts`, `libs/shared-utils/src/lib/result.ts`, `docs/business-rules/reservations.md`

**Interfaces:**
- Consumes: `countCommittedSeats`, `lockTripForCapacity` (Tarea 3); `availableSeats` de `@rm/domain-trips`; `recordAudit` de `@rm/domain-audit`.
- Produces:
  - `createReservation(db, input: { tripId; customerId }): Promise<Result<ReservationDto>>`
  - `getReservationForCustomer(db, reservationId, customerId): Promise<Result<ReservationDto>>`
  - `listReservationsForCustomer(db, customerId): Promise<Result<ReservationSummaryDto[]>>`
  - `requestCancellation(db, reservationId, customerId, reason?): Promise<Result<ReservationDto>>`
  - `interface ReservationDto { id; code; tripId; customerId; status; holdExpiresAt: Date | null; totalPriceCents; minimumDepositCents; paidCents; creditCents; balanceCents; paymentDeadline: Date; cancellationRequestedAt: Date | null; createdAt: Date }`

Códigos de error nuevos a añadir a `DomainErrorCode`, a `STATUS_BY_CODE` y a **ambos** catálogos: `TRIP_NOT_PUBLISHED` (409), `PAYMENT_DEADLINE_PASSED` (409), `RESERVATION_NOT_OWNED` (404).

> `RESERVATION_NOT_OWNED` responde **404 y no 403** a propósito: un 403 confirmaría que la reserva existe. Un cliente que prueba identificadores ajenos no debe poder distinguir "no es tuya" de "no existe".

- [ ] **Step 1: Escribir las pruebas que fallan**

Además de la prueba de concurrencia de la Tarea 3, que ahora debe pasar:

1. **Crea una reserva en `HELD` con el precio congelado.** El `total_price_cents` de la reserva es el `price_per_seat_cents` del viaje **en ese momento**; cambiar el precio del viaje después no la altera.
2. **`hold_expires_at` sale de `trip.hold_ttl_hours`**, no de una constante.
3. **Rechaza si el viaje no está `PUBLISHED`** → `TRIP_NOT_PUBLISHED`. Pruébalo con `DRAFT` y con `CANCELLED`.
4. **Rechaza si la fecha límite de pago ya pasó** → `PAYMENT_DEADLINE_PASSED`, evaluada en la zona de `SystemSetting`, no contra `new Date()` crudo.
5. **Rechaza una segunda reserva viva del mismo cliente** → `DUPLICATE_RESERVATION`. Y acepta una nueva si la anterior está `CANCELLED`.
6. **Rechaza si el correo no está verificado** → `EMAIL_NOT_VERIFIED`.
7. **`getReservationForCustomer` con el id de otro cliente** → `RESERVATION_NOT_OWNED`, y comprueba que el mensaje no revela nada del dueño real.
8. **`requestCancellation` sella la fecha y no cambia el estado.** Una reserva `HELD` sigue `HELD` y su `hold_expires_at` sigue corriendo. Solicitar dos veces no duplica ni falla.
9. **El folio es único.** Crea cincuenta reservas y comprueba que no se repite ninguno.

- [ ] **Step 2: Verlas fallar**

Run: `pnpm nx test reservations --skip-nx-cache`

- [ ] **Step 3: Implementar el folio**

`reservation-code.ts` genera un folio legible y único. Legible importa: el cliente lo dicta por teléfono al mostrador. Evita caracteres ambiguos (`O`/`0`, `I`/`1`).

La unicidad se garantiza con un índice único en la base **más** un respaldo ante colisión, siguiendo el patrón que `trip-service.ts` ya usa para el slug: bucle de generación como camino normal, captura de la violación única como red. No confíes sólo en el bucle.

- [ ] **Step 4: Implementar el servicio**

`createReservation` entero dentro de una transacción: bloquear el viaje, verificar publicación, fecha límite, correo verificado, duplicado y cupo, insertar, auditar. El orden importa — bloquear primero y comprobar después, o dos transacciones leerán el mismo cupo.

`requestCancellation` sella `cancellation_requested_at` y `cancellation_reason`, audita, y **no toca el estado**. Es una solicitud, no una cancelación: la spec es explícita en que ningún movimiento de dinero ni liberación de cupo ocurre sin que una persona decida.

- [ ] **Step 5: Verlas pasar, documentar y commitear**

Run: `pnpm nx run-many -t typecheck lint test build --skip-nx-cache`

Documenta en `docs/business-rules/reservations.md` las ocho reglas y la tabla de errores. Crea `docs/diagrams/trip-reservation.md` con el flujo en Mermaid: desde el botón de reservar hasta `HELD`, con las cinco bifurcaciones de rechazo. **Cita cualquier etiqueta que contenga `>` o `?`** — la Fase 1 envió un diagrama con un `>` sin comillas y no hay renderizador aquí para detectarlo.

```bash
git add -A
git commit -m "feat: add reservation service with holds and cancellation requests"
```

---

## Tarea 5: Servicio de pagos — saldo, registro y mensualidad sugerida

**Files:**
- Create: `libs/domain/payments/src/lib/payment-service.ts`, `payment-service.spec.ts`
- Create: `libs/domain/payments/src/lib/instalment.ts`, `instalment.spec.ts`
- Modify: `libs/domain/payments/src/index.ts`, `docs/business-rules/payments.md`

**Interfaces:**
- Consumes: `monthStartsBetween` de `@rm/shared-utils`; `organizationTimeZone` de `@rm/domain-trips`; `recordAudit`.
- Produces:
  - `suggestedMonthly(balanceCents: number, monthsRemaining: number): number`
  - `recordPayment(tx: DbTransactionClient, input: { reservationId; amountCents; method; status; provider; providerIntentId?; paidAt? }): Promise<Result<PaymentDto>>`
  - `confirmPayment(db, input: { providerIntentId; paidAt }): Promise<Result<PaymentDto>>`
  - `listPaymentsForCustomer(db, customerId): Promise<Result<PaymentDto[]>>`

Código nuevo: `PAYMENT_EXCEEDS_BALANCE` ya existe en el catálogo desde la Fase 1 y nunca se usó; ahora se usa.

- [ ] **Step 1: Escribir las pruebas de la mensualidad sugerida**

Es aritmética pura y va en su propio archivo, sin base de datos:

```ts
describe('suggestedMonthly', () => {
  it('divides the balance across the remaining month-starts, rounding up to the peso', () => {
    expect(suggestedMonthly(1_000_000, 4)).toBe(250_000);
    expect(suggestedMonthly(1_000_00, 3)).toBe(3_400);   // 100.00 / 3 = 33.33 -> 34.00
  });

  it('returns the whole balance when no month-start remains', () => {
    expect(suggestedMonthly(500_000, 0)).toBe(500_000);
  });

  it('returns zero for a settled reservation', () => {
    expect(suggestedMonthly(0, 5)).toBe(0);
  });
});
```

El segundo caso es el que distingue: redondear hacia abajo dejaría al cliente corto y la suma de las mensualidades no cubriría el total.

- [ ] **Step 2: Escribir las pruebas del registro de pagos**

1. **Un pago confirmado incrementa `paid_cents` en la misma transacción.** Lee la fila después y comprueba que el saldo cuadra con la suma de pagos `SUCCEEDED`.
2. **Un pago `PENDING` no mueve el saldo.** Es la regla que sostiene toda la experiencia de OXXO.
3. **Un pago mayor al saldo se rechaza** → `PAYMENT_EXCEEDS_BALANCE`.
4. **Alcanzar el anticipo mínimo pasa la reserva de `HELD` a `ACTIVE` y anula `hold_expires_at`.** Y un pago que **no** lo alcanza la deja en `HELD`.
5. **Dos confirmaciones del mismo `providerIntentId` producen un solo pago.** Lánzalas concurrentemente, como en la Tarea 3.
6. **La mensualidad sugerida se recalcula, nunca se almacena.** Comprueba que no existe columna para ella.

- [ ] **Step 3: Verlas fallar, implementar, verlas pasar**

`recordPayment` recibe `DbTransactionClient` porque siempre corre dentro de la transacción de quien lo llama — el webhook de Stripe o el cobro en sucursal de la 2B. `confirmPayment` abre su propia transacción y delega.

La idempotencia del punto 5 se ancla en un índice único sobre `provider_intent_id` cuando no es nulo, más la captura de la violación. El mismo patrón de siempre: camino normal más red.

- [ ] **Step 4: Documentar y commitear**

`docs/business-rules/payments.md`: la fórmula de la mensualidad y por qué redondea hacia arriba, la regla de que un pago pendiente no mueve el saldo, el umbral del anticipo, y la idempotencia.

```bash
git add -A
git commit -m "feat: add payment service with balances and suggested instalments"
```

---

## Tarea 6: Puerto de correo y adaptador de Resend

**Files:**
- Create: `libs/email/src/lib/email-provider.ts`, `resend-email-provider.ts`, `console-email-provider.ts`, `create-email.ts`
- Create: `libs/email/src/testing/email-contract.ts`
- Test: `libs/email/src/lib/console-email-provider.spec.ts`

**Interfaces:**
- Produces:
  - `interface EmailMessage { to: string; subject: string; html: string; text: string }`
  - `interface EmailProvider { send(message: EmailMessage): Promise<Result<{ providerMessageId: string }>> }`
  - `createEmail(env: AppEnv): EmailProvider`
  - `runEmailContract(name, factory)` desde `@rm/email/testing`

- [ ] **Step 1: Escribir el contrato compartido**

Mismo patrón que `StorageProvider` en la Fase 1, **con su lección aprendida**: aquel contrato sólo ejercitaba una de las cinco operaciones y por eso no detectó que las dos implementaciones divergían en otra. Aquí sólo hay una operación, así que cubre sus modos: envío correcto, dirección inválida, y fallo del proveedor devuelto como `Result` y no como excepción.

- [ ] **Step 2: Implementar el proveedor de consola y correrlo contra el contrato**

`ConsoleEmailProvider` imprime el mensaje y devuelve un id sintético. Es lo que se usa en desarrollo y en pruebas, y es la razón por la que el dominio puede probarse sin tocar Resend.

**No imprime el cuerpo completo por defecto.** Un código OTP en los logs de desarrollo es un código OTP en los logs; imprime destinatario y asunto, y el cuerpo sólo bajo una variable de entorno explícita.

- [ ] **Step 3: Implementar el adaptador de Resend**

Lee `RESEND_API_KEY` y `RESEND_FROM_ADDRESS` de `AppEnv`, que ya valida con Zod desde la Fase 1 — añade allí las dos claves con su validación condicional, igual que `STORAGE_S3_BUCKET` sólo se exige cuando el driver es `s3`.

Un fallo de red o una respuesta de error del proveedor devuelven `Result` fallido, **nunca lanzan**: un correo que no sale no debe tumbar la transacción que lo originó.

- [ ] **Step 4: `createEmail` elige por entorno**

Consola en `development` y `test`, Resend en el resto. Igual que `createStorage`. Nada fuera de esta función ramifica sobre el proveedor.

- [ ] **Step 5: Verificar y commitear**

Run: `pnpm nx run-many -t typecheck lint test build --skip-nx-cache`

```bash
git add -A
git commit -m "feat: add email port with resend and console providers"
```

---

## Tarea 7: Entregas de aviso — correo más bandeja

**Files:**
- Create: `libs/domain/notifications/src/lib/delivery-service.ts`, `delivery-service.spec.ts`
- Create: `libs/domain/notifications/src/lib/templates.ts`, `templates.spec.ts`
- Create: `docs/business-rules/notifications.md`

**Interfaces:**
- Consumes: `EmailProvider` de `@rm/email` (inyectado como puerto, nunca importando el adaptador).
- Produces:
  - `type DeliveryEventType = 'HOLD_EXPIRING' | 'HOLD_EXPIRED' | 'PAYMENT_CONFIRMED' | 'PAYMENT_FAILED' | 'RESERVATION_CANCELLED' | 'CANCELLATION_REQUESTED' | 'ORPHAN_PAYMENT' | 'PAID_CENTS_MISMATCH'`
  - `notifyCustomer(tx: DbTransactionClient, email: EmailProvider, input: { customerId; eventType: DeliveryEventType; params: Record<string, string> }): Promise<void>`
  - `notifyAdmins(tx: DbTransactionClient, email: EmailProvider, input: { eventType: DeliveryEventType; params: Record<string, string> }): Promise<void>`
  - `listInbox(db, customerId, { limit, cursor }): Promise<Result<InboxPageDto>>`
  - `markRead(db, deliveryId, customerId): Promise<Result<null>>`

- [ ] **Step 1: Escribir las pruebas que fallan**

1. **Un aviso crea dos filas**, una `EMAIL` y una `INBOX`, con el mismo texto renderizado. Es lo que hace que el cliente vea en la app exactamente lo que recibió por correo.
2. **El texto se renderiza en el idioma del cliente** y se **guarda ya resuelto**. Cambiar el idioma del cliente después no reescribe el historial.
3. **Un fallo del proveedor de correo marca la fila `EMAIL` como `FAILED` con su error, deja la `INBOX` en `SENT`, y no lanza.** El cliente sigue viendo el aviso en la app aunque el correo no saliera.
4. **`markRead` de una entrega ajena** devuelve `DELIVERY_NOT_OWNED`, que es 404 por la misma razón que `RESERVATION_NOT_OWNED`: un 403 confirmaría que la entrega existe. Es un código propio, no el de reservas; añádelo al catálogo y a ambas traducciones.
5. **La bandeja pagina por cursor** y devuelve lo más reciente primero.
6. **`notifyAdmins` escribe una entrega por cada usuario de personal vivo con el permiso `reservation.cancel`**, y ninguna si no hay ninguno — sin lanzar. Tres avisos de esta fase van al administrador y no al cliente: la solicitud de cancelación (§5.6), el pago huérfano de §5.3 y la desviación de `paid_cents` de la conciliación nocturna. Sin esta función esos tres avisos no tienen a dónde ir.

- [ ] **Step 2: Implementar las plantillas**

`templates.ts` mapea cada `DeliveryEventType` y locale a un asunto y un cuerpo, interpolando `params`. Vive en el dominio y **no** en los catálogos de i18n de Angular: estos textos los renderiza el servidor al enviar, no el cliente al mostrar.

Un `eventType` sin plantilla debe ser un error de compilación, no de ejecución: usa un `Record<DeliveryEventType, …>` exhaustivo, igual que `STATUS_BY_CODE`. Es el mismo mecanismo que en la Fase 1 impidió que un código de error quedara sin traducir.

- [ ] **Step 3: Implementar el servicio, verificar y commitear**

`notifyCustomer` recibe la transacción porque las filas de entrega deben crearse con el hecho que las origina: si el pago se revierte, el aviso de pago confirmado no debe quedar. El **envío** del correo, en cambio, ocurre después de commitear — enviar dentro de la transacción significaría enviar un correo sobre algo que puede deshacerse.

Documenta esa distinción en `notifications.md`: **las filas son transaccionales, el envío no**.

```bash
git add -A
git commit -m "feat: add notification deliveries over email and in-app inbox"
```

---

## Tarea 8: Proceso de trabajos y los tres jobs

**Files:**
- Create: `apps/worker/` (aplicación Node), `src/main.ts`, `src/jobs/*.ts` y sus specs
- Create: `libs/jobs/src/lib/job-names.ts`
- Modify: `infra/compose/compose.prod.yml`, `infra/docker/Dockerfile.worker`, `.env.example`

**Interfaces:**
- Produces: los tres jobs como funciones puras del cliente de base — `expireHolds(db, email)`, `warnExpiringHolds(db, email)`, `reconcilePaidCents(db)` — para que puedan probarse sin pg-boss.

> **Separar el job de su programación es la decisión de diseño de esta tarea.** pg-boss sólo decide *cuándo* se llama; la función es un `async` normal que recibe el cliente y hace su trabajo. Así cada job se prueba invocándolo dos veces seguidas, sin arrancar un planificador.

- [ ] **Step 1: Escribir las pruebas de los tres jobs**

**`expireHolds`:**
1. Una reserva `HELD` con `hold_expires_at` en el pasado pasa a `EXPIRED` y su lugar vuelve al cupo.
2. Una `HELD` vigente **no** se toca.
3. Una `ACTIVE` nunca se toca, aunque tuviera una fecha vieja.
4. **Ejecutarlo dos veces seguidas no cambia nada la segunda vez.**
5. Expirar genera el aviso `HOLD_EXPIRED`.

**`expireHolds` también debe cancelar en Stripe los Payment Intents pendientes de la reserva** (§5.3). El puerto de pagos todavía no existe en esta tarea: déjalo detrás de una dependencia opcional inyectada y **no la inventes aquí**. La Tarea 9 la cablea y añade su prueba. Deja un comentario que lo diga, igual que la Fase 1 dejó el stub de `committedSeats` con su nota honesta.

**`warnExpiringHolds`:**
1. Avisa cuando queda menos de un cuarto del plazo del viaje, con mínimo de una hora — **no** un umbral fijo. Prueba con un viaje de 72 horas y otro de 6: el de 6 horas no debe avisar en el instante de reservar.
2. No avisa dos veces por la misma reserva.
3. No avisa si ya alcanzó el anticipo.

**`reconcilePaidCents`:**
1. Una reserva cuyo `paid_cents` coincide con la suma de sus pagos `SUCCEEDED` no produce alerta.
2. Una desviada produce una alerta al administrador con los dos números.
3. **No corrige el dato por su cuenta.** Alerta y nada más: una corrección automática escondería el bug que causó la desviación.

- [ ] **Step 2: Verlas fallar e implementar los jobs**

Para la idempotencia de `warnExpiringHolds` necesitas saber si ya se avisó: consulta `NotificationDelivery` por `(customer_id, event_type)` ligado a esa reserva. Si eso resulta ambiguo porque un cliente puede tener varias reservas, añade `reservation_id` nullable a `NotificationDelivery` en una migración — **y dilo en el reporte**, porque es un cambio de esquema que este plan no anticipó.

- [ ] **Step 3: Crear `apps/worker` y cablear pg-boss**

Un proceso Node que arranca pg-boss contra el mismo `DATABASE_URL`, registra los tres jobs con sus cadencias (`expire-holds` cada 5 min, `warn-expiring-holds` cada hora, `reconcile-paid-cents` nocturno) y nada más. La lógica ya está probada aparte.

Separado de `apps/api` a propósito: si los jobs viven dentro de Next.js, cada redespliegue mata trabajos a medias.

Apagado limpio: al recibir `SIGTERM` debe dejar de tomar trabajos y esperar a que termine el que tenga en curso. Un contenedor que se reinicia a mitad de `expireHolds` no debe dejar reservas a medio expirar.

- [ ] **Step 4: Añadir el servicio al despliegue**

`Dockerfile.worker` y un servicio `worker` en `compose.prod.yml`, con el mismo `env_file: ../../.env.prod` y `NODE_ENV: production` en el bloque `environment` — **la Fase 1 descubrió por las malas que `env_file` por sí solo deja entrar el `NODE_ENV=development` de la raíz**, así que repite la fijación explícita.

Sin puertos publicados: el worker no atiende peticiones.

- [ ] **Step 5: Verificar, documentar y commitear**

Documenta los tres jobs, sus cadencias y su garantía de idempotencia en `docs/business-rules/reservations.md` y `payments.md` según corresponda.

```bash
git add -A
git commit -m "feat: add background worker with hold expiry, warnings and reconciliation"
```

---

## Tarea 9: Puerto de pagos y adaptador de Stripe

**Files:**
- Create: `libs/payments-stripe/src/lib/payment-provider.ts`, `stripe-payment-provider.ts`, `fake-payment-provider.ts`, `create-payment-provider.ts`
- Create: `libs/payments-stripe/src/testing/payment-contract.ts`
- Test: `libs/payments-stripe/src/lib/fake-payment-provider.spec.ts`

**Interfaces:**
- Produces:
  - `interface PaymentIntentRequest { reservationId; amountCents; method: 'CARD'|'OXXO'|'SPEI'; customerEmail; voucherExpiresAt?: Date }`
  - `interface PaymentIntentResult { providerIntentId; clientSecret; voucherUrl?: string; voucherExpiresAt?: Date }`
  - `interface PaymentProvider { createIntent(req): Promise<Result<PaymentIntentResult>>; cancelIntent(id): Promise<Result<null>>; verifyWebhook(payload: string, signature: string): Result<WebhookEvent> }`
  - `createPaymentProvider(env: AppEnv): PaymentProvider`

- [ ] **Step 1: Escribir el contrato compartido y el proveedor falso**

El `FakePaymentProvider` no es un mock de pruebas suelto: es una implementación del puerto que vive en `libs/` y que el contrato ejercita igual que al real. Permite probar todo el flujo de reserva y pago sin credenciales de Stripe — y por tanto permite que las Tareas 10 a 17 avancen aunque la cuenta no esté lista.

El contrato cubre: crear un intento de cada método, cancelar uno pendiente, cancelar uno ya cancelado (idempotente), y rechazar una firma de webhook inválida.

- [ ] **Step 2: Implementar el adaptador de Stripe**

`createIntent` construye un Payment Intent **con el monto que el backend decide**, nunca uno recibido del cliente. Para OXXO fija la expiración del voucher igual a `voucherExpiresAt`, que el llamador pondrá igual al `hold_expires_at` de la reserva.

`verifyWebhook` usa la verificación de firma de Stripe con `STRIPE_WEBHOOK_SECRET` y devuelve `Result`, nunca lanza.

- [ ] **Step 3: Cablear la cancelación de intents en `expireHolds`**

La Tarea 8 dejó el hueco. Ahora existe el puerto: inyéctalo en `expireHolds` y llama a `cancelIntent` por cada `Payment` en `PENDING` de la reserva que expira. Añade la prueba que falta — **expirar un apartado con un Payment Intent pendiente lo cancela en el proveedor**, y hacerlo dos veces no cancela dos veces. Con el proveedor falso esto es comprobable sin Stripe.

Un fallo al cancelar en el proveedor **no debe impedir que la reserva expire**: el lugar se libera igual y el fallo se registra. Lo contrario deja un lugar bloqueado por una caída de un tercero.

- [ ] **Step 4: Verificar que el adaptador real typechequea y commitear**

Igual que `S3Storage` en la Fase 1: el adaptador de Stripe se escribe y se typechequea aunque su contrato no pueda ejecutarse sin credenciales. **No debilites el contrato compartido para que parezca cubierto.** Declara en el reporte que corre contra el falso y no contra Stripe.

```bash
git add -A
git commit -m "feat: add payment provider port with stripe and fake implementations"
```

---

## Tarea 10: Webhook de Stripe con idempotencia

**Files:**
- Create: `apps/api/src/app/api/v1/webhooks/stripe/route.ts`
- Create: `libs/domain/payments/src/lib/webhook-handler.ts`, `webhook-handler.spec.ts`
- Test: `apps/api/src/app/api/v1/webhooks/stripe/stripe-webhook.integration.spec.ts`

**Interfaces:**
- Consumes: `PaymentProvider.verifyWebhook`, `confirmPayment`, `notifyCustomer`.
- Produces: `handleStripeEvent(db, email, event): Promise<Result<null>>`

> Es el **único endpoint público que escribe**. Merece la revisión más cuidadosa de la fase junto con la Tarea 3.

- [ ] **Step 1: Escribir las pruebas que fallan**

1. **Una firma inválida se rechaza sin tocar la base.** Comprueba que no se creó ninguna fila.
2. **Un evento ya procesado se descarta.** Inserta el `StripeEvent`, reenvía el mismo, y afirma que no hay un segundo pago. Lánzalo también **concurrentemente** — Stripe reenvía, y dos entregas simultáneas del mismo evento son posibles.
3. **`payment_intent.succeeded` registra el pago, incrementa `paid_cents` y pasa la reserva a `ACTIVE` si alcanza el anticipo.**
4. **`payment_intent.payment_failed` marca el pago `FAILED` y avisa al cliente, sin tocar el saldo.**
5. **El caso límite de la spec §5.3:** un `succeeded` para una reserva ya `EXPIRED`. El pago se registra como `SUCCEEDED`, la reserva **no** se reactiva, y se genera aviso al cliente y al administrador. Afirma las tres cosas por separado — es la regla más fácil de implementar a medias.
6. **`payment_intent.canceled` marca el pago `EXPIRED`** y no toca el saldo. Es lo que llega cuando la Tarea 9 cancela el intent de un apartado vencido, así que es un evento esperado, no una anomalía.
7. **La expiración de un voucher OXXO** deja el pago en `EXPIRED` y avisa al cliente de que su ficha venció.
8. **Un fallo del proveedor al verificar o al construir la respuesta devuelve `PAYMENT_PROVIDER_ERROR`**, nunca una traza cruda.
9. **Un evento de un tipo que no manejamos devuelve 200 y no hace nada.** Stripe reintenta ante cualquier respuesta que no sea 2xx; devolver error por un evento que no nos interesa provoca reintentos eternos.

- [ ] **Step 2: Verlas fallar e implementar**

El orden dentro de la transacción importa: **insertar el `StripeEvent` primero**, y si eso viola el único, salir sin efecto. Esa inserción es el candado de idempotencia; hacerla al final deja la ventana abierta.

La ruta se declara pública en `route()` y queda **excluida de la exigencia de `application/json`**, porque Stripe envía el cuerpo crudo y la firma se verifica sobre esos bytes exactos. Comprueba cómo lo resuelve el envoltorio hoy y, si hace falta una excepción explícita, añádela de forma acotada a esta ruta y nada más — y dilo en el reporte, porque relaja una defensa que la Fase 1 añadió por un motivo.

- [ ] **Step 3: Verificar, documentar y commitear**

Documenta en `payments.md` la idempotencia, el orden de inserción y el caso límite de §5.3. Crea `docs/diagrams/payment-flow.md` con el flujo asíncrono: intento, ficha, confirmación por webhook, y las dos ramas de fallo y expiración. Cita las etiquetas con caracteres reservados.

```bash
git add -A
git commit -m "feat: handle stripe webhooks idempotently"
```

---

## Tarea 11: Registro de clientes con verificación por código

**Files:**
- Create: `libs/domain/identity/src/lib/customer-registration.ts`, `customer-registration.spec.ts`
- Create: `libs/domain/identity/src/lib/otp.ts`, `otp.spec.ts`
- Create: endpoints `register`, `verify-email`, `resend-code` bajo `apps/api/src/app/api/v1/auth/`
- Modify: `libs/db/prisma/schema.prisma` si `EmailVerification` necesita ajustes

**Interfaces:**
- Consumes: `hashPassword` de `@rm/domain-identity`; el limitador de intentos de la Fase 1; `EmailProvider`.
- Produces: `registerCustomer`, `verifyEmail`, `resendVerificationCode`.

Códigos nuevos: `OTP_EXPIRED`, `OTP_INVALID`, `OTP_MAX_ATTEMPTS`, `OTP_RESEND_TOO_SOON`.

- [ ] **Step 1: Escribir las pruebas que fallan**

1. **El código se almacena hasheado, nunca en claro.** Léelo de la base y comprueba que no es el que se envió. Es la misma regla que ya aplica a los tokens de refresco.
2. **Un código correcto marca `email_verified_at` y se consume**: usarlo dos veces falla.
3. **Expira según `SystemSetting['otp.ttl_minutes']`**, no una constante.
4. **Agotar `otp.max_attempts` invalida el código** aunque luego se acierte → `OTP_MAX_ATTEMPTS`.
5. **Reenviar antes de `otp.resend_cooldown_seconds`** → `OTP_RESEND_TOO_SOON`.
6. **Superar `otp.max_resends_per_hour`** → `RATE_LIMITED`.
7. **Un correo ya registrado no revela que lo está.** Registrar con un correo existente devuelve lo mismo que uno nuevo y envía un correo distinto al dueño real. Si prefieres devolver `EMAIL_ALREADY_REGISTERED`, **dilo y argumenta**: es una decisión entre usabilidad y enumeración, y la Fase 1 eligió no revelar en login y en recuperación.
8. **El registro está limitado por intentos.** Reutiliza el limitador existente.

- [ ] **Step 2: Verlas fallar, implementar, verlas pasar**

Los cuatro valores viven en `SystemSetting`, sembrados por el seed con 15 / 5 / 60 / 5. Añádelos al seed existente, que es idempotente.

- [ ] **Step 3: Verificar, documentar y commitear**

```bash
git add -A
git commit -m "feat: add customer registration with hashed email verification codes"
```

---

## Tarea 12: Recuperación de contraseña y límites en los endpoints públicos

**Files:**
- Create: `libs/domain/identity/src/lib/password-reset.ts` y su spec
- Create: endpoints `forgot-password`, `reset-password`
- Modify: el limitador de la Fase 1 para cubrir los cuatro endpoints públicos nuevos

**Interfaces:**
- Produces: `requestPasswordReset(db, email, emailProvider)`, `resetPassword(db, token, newPassword)`

- [ ] **Step 1: Escribir las pruebas que fallan**

1. **La respuesta es idéntica exista o no la cuenta.** Mismo código, mismo cuerpo, y tiempos comparables — el camino de cuenta inexistente debe hacer trabajo equivalente, igual que el hash señuelo que la Fase 1 añadió al login. Esta es la prueba que más fácilmente se rompe al escribir una pantalla amable.
2. **El token se almacena hasheado** y es de un solo uso.
3. **Expira** según su valor en `SystemSetting`.
4. **Restablecer la contraseña revoca todas las sesiones vivas** del usuario. Si alguien recupera su cuenta porque sospecha que se la robaron, dejar viva la sesión del atacante hace inútil el ejercicio.
5. **Los cuatro endpoints públicos están limitados**: `register`, `verify-email`, `resend-code`, `forgot-password`. Una prueba por endpoint que supere el umbral y obtenga `RATE_LIMITED`.

- [ ] **Step 2: Implementar, verificar y commitear**

El punto 4 reutiliza la revocación por `session_id` que ya existe en `auth-service.ts` desde la Fase 1.

```bash
git add -A
git commit -m "feat: add password reset and rate limits on public auth endpoints"
```

---

## Tarea 13: Inicio de sesión con Google y Apple

**Files:**
- Create: `libs/domain/identity/src/lib/social-login.ts` y su spec
- Create: endpoints `auth/oauth/google`, `auth/oauth/apple`
- Modify: `libs/shared-utils/src/lib/env.ts`

**Interfaces:**
- Produces: `loginWithProvider(db, { provider: 'GOOGLE'|'APPLE', idToken }): Promise<Result<{ user; tokens }>>`

- [ ] **Step 1: Escribir las pruebas que fallan**

1. **Un token válido de un correo nuevo crea el usuario con `email_verified_at` puesto.** El proveedor ya verificó el correo; exigir OTP encima sería absurdo.
2. **Un token válido de un correo ya registrado con contraseña vincula el `AuthIdentity` sin duplicar el usuario.** `AuthIdentity` existe desde la Fase 1 justo para esto.
3. **Un token con firma inválida se rechaza.**
4. **Un token con audiencia que no es nuestra se rechaza.** Es el fallo clásico: verificar la firma y olvidar comprobar para quién se emitió, lo que permite reutilizar un token legítimo de otra aplicación.
5. **Un token expirado se rechaza.**
6. **Con el ID de cliente vacío, el proveedor está desactivado** y el endpoint devuelve un código estable indicando que no está disponible — no un 500.

El punto 6 es lo que permite cerrar la fase sin las cuentas externas.

- [ ] **Step 2: Implementar, verificar y commitear**

Añade los dos IDs a `AppEnv` como **opcionales**, con la semántica de que vacío significa desactivado, y documéntalo en el esquema de Zod.

```bash
git add -A
git commit -m "feat: add google and apple sign-in, disabled when unconfigured"
```

---

## Tarea 14: Endpoints de catálogo público, reservas, pagos y bandeja

**Files:**
- Create: `apps/api/src/app/api/v1/public/trips/route.ts`, `[slug]/route.ts`
- Create: `apps/api/src/app/api/v1/reservations/**`, `payments/route.ts`, `notifications/**`
- Create: contratos Zod en `libs/contracts/src/lib/{reservations,payments,notifications,public-trips}.ts`
- Modify: `apps/api/src/lib/openapi/registry.ts`

- [ ] **Step 1: Escribir las pruebas de integración que fallan**

**Catálogo público** (sin autenticación):
1. Lista sólo viajes `PUBLISHED`; un `DRAFT` no aparece.
2. El detalle por slug de un viaje publicado responde 200 con fotos, itinerario, precio y cupo disponible.
3. El detalle de un viaje no publicado responde **404**, no un detalle vacío.
4. **No expone nada interno**: ni el presupuesto, ni el margen, ni `pre_sold_seats`, ni quién lo creó. Afirma la ausencia de cada campo explícitamente — esta prueba es la que impide que un `select` demasiado generoso filtre el costeo de la agencia al público.

**Reservas y pagos** (autenticado como cliente):
5. Un cliente ve **sólo** sus reservas. Siembra dos clientes con una reserva cada uno y comprueba que cada quien ve una.
6. Pedir la reserva de otro → **404**.
7. Crear una reserva sin el correo verificado → `EMAIL_NOT_VERIFIED`.
8. **Un actor de personal (`STAFF`) no puede usar los endpoints de cliente.** El catálogo RBAC gobierna al personal; estos endpoints son de clientes y la comprobación es de pertenencia, no de permiso.
9. **Solicitar la cancelación sella `cancellation_requested_at`, avisa al personal y deja el estado intacto.** Afirma el estado después: es la regla que más fácilmente se implementa como un cambio de estado, que es justo lo que §5.6 prohíbe.
10. Solicitar la cancelación de una reserva ajena → 404.
11. Sin token → 401.

**Bandeja:**
12. Lista las entregas propias, más recientes primero, paginadas.
13. Marcar leída una ajena → 404.

- [ ] **Step 2: Verlas fallar e implementar**

Los handlers siguen siendo delgados: autenticar, validar, llamar al dominio. La **comprobación de pertenencia vive en el dominio**, no en el handler — un importador o una consola deben obtenerla igual. Es la misma lección que la Fase 1 aprendió con las reglas de imágenes.

- [ ] **Step 3: Documentar en OpenAPI y regenerar**

Registra cada ruta con sus respuestas, incluidas 401 y 404 donde apliquen, y los esquemas compartidos como componentes con nombre. Para las respuestas modeladas a mano, **añade la aserción de asignabilidad mutua contra el DTO del dominio** que la Fase 1 introdujo en `registry.ts`: sin ella el contrato puede desviarse del código sin que nada falle.

Run: `pnpm api:types` y confirma que una segunda ejecución es no-op.

- [ ] **Step 4: Verificar y commitear**

```bash
git add -A
git commit -m "feat: expose public catalogue, reservations, payments and inbox"
```

---

## Tarea 15: Cascarón de la app cliente y la sesión dentro de Capacitor

Esta tarea existe para resolver pronto el riesgo que la spec §8 señala: **la cookie `httpOnly` de la Fase 1 y el empaquetado con Capacitor nunca se diseñaron el uno pensando en el otro.** Descubrir en la Tarea 17 que la sesión no sobrevive dentro del contenedor nativo sería caro.

**Files:**
- Create: `apps/client/**` (aplicación Angular), configuración de Capacitor
- Modify: `libs/auth-web` si la sesión necesita adaptarse

- [ ] **Step 1: Generar la aplicación y montar el cascarón**

Angular standalone con señales, consumiendo `@rm/api-client`, `@rm/auth-web`, `@rm/i18n` y `@rm/shared-utils`. **No** consume `@rm/ui`: el panel es denso en datos y el cliente es mobile-first.

- [ ] **Step 2: Probar la sesión en el navegador y reportar lo observado**

Antes de añadir Capacitor: levanta la app, regístrate, inicia sesión, recarga la página y comprueba que la sesión sobrevive, igual que se hizo con el panel en la Fase 1.

- [ ] **Step 3: Añadir Capacitor y probar la sesión dentro del contenedor**

`nx build client` seguido de `cap sync`, con los assets **empaquetados** y no un `server.url` remoto — Apple rechaza contenedores de URL bajo la guía 4.2.

Entonces la pregunta que esta tarea existe para contestar: **¿la cookie `httpOnly` sobrevive en el WebView?** Una app empaquetada carga desde `capacitor://localhost` o `https://localhost` según la plataforma, y la API vive en otro origen — lo que convierte la cookie en una cookie de tercera parte, con `SameSite=Strict` impidiendo que se envíe.

**Investiga y reporta antes de implementar un remedio.** Hay varias salidas —un plugin de cookies nativas, un proxy en el contenedor, cambiar el modelo de sesión para móvil— y la elección es arquitectónica. Si concluyes que la cookie no puede funcionar en Capacitor, **para y dilo**: puede implicar que móvil use almacenamiento seguro nativo y web use cookie, que es lo que la spec de la Fase 1 decía originalmente y que perdimos de vista al unificar.

- [ ] **Step 4: Verificar y commitear**

```bash
git add -A
git commit -m "feat: add client app shell and verify session inside capacitor"
```

---

## Tarea 16: Catálogo y registro en la app cliente

**Files:**
- Create: `apps/client/src/app/features/catalogue/{trip-list,trip-detail}.component.ts` y sus specs
- Create: `apps/client/src/app/features/auth/{register,verify-email,login,forgot-password}.component.ts` y sus specs
- Modify: `libs/i18n/src/lib/catalogs/{es,en}.json`

**Interfaces:**
- Consumes: los endpoints públicos de la Tarea 14 y los de autenticación de las Tareas 11–13, vía `@rm/api-client`.

- [ ] **Step 1: Escribir las pruebas de componente que fallan**

1. La lista pide el catálogo público **sin token** y pinta una tarjeta por viaje.
2. Un viaje sin lugares se muestra agotado y **sin** botón de reservar.
3. El detalle de un slug inexistente muestra el estado de no encontrado, no una pantalla en blanco.
4. El registro valida el correo y la fecha de nacimiento **antes** de llamar a la API.
5. Tras registrarse, la app lleva a la pantalla del código de verificación.
6. Un código incorrecto muestra el mensaje traducido de `OTP_INVALID`; agotar intentos muestra el de `OTP_MAX_ATTEMPTS`. **Afirma contra la clave de traducción, no contra el texto en español** — así la prueba no se rompe al pulir la redacción.
7. El botón de reenviar queda deshabilitado durante el enfriamiento y vuelve solo.
8. **La pantalla no muestra ningún texto que venga del backend.** Dale una respuesta con un código desconocido y comprueba que aparece el mensaje genérico, no el código crudo.

- [ ] **Step 2: Verlas fallar e implementar**

Componentes standalone con señales, siguiendo el patrón del panel. Las rutas del catálogo y las de autenticación son **públicas**; el resto queda tras el guard de sesión que la Fase 1 ya tiene.

Añade todas las claves nuevas a **ambos** catálogos. Un catálogo con menos claves que el otro ya rompe el build desde la Fase 1.

- [ ] **Step 3: Verificar en el navegador y commitear**

Levanta la app, registra una cuenta real contra la base local, recibe el código (con el proveedor de consola está en el log, sin el cuerpo: usa la base o el modo verboso explícito) y verifica. **Reporta lo que viste, no lo que esperabas ver.**

```bash
git add -A
git commit -m "feat: add public catalogue and customer registration screens"
```

---

## Tarea 17: Reservar y pagar desde la app

Es la tarea que define la fase: aquí el cliente hace lo que la Fase 2A promete.

**Files:**
- Create: `apps/client/src/app/features/reservations/{reserve,reservation-detail}.component.ts` y sus specs
- Create: `apps/client/src/app/features/payments/{payment-method,card-form,voucher}.component.ts` y sus specs
- Create: `apps/client/src/app/core/stripe/stripe-loader.ts`

**Interfaces:**
- Consumes: `POST /reservations`, `POST /reservations/:id/payment-intents`, `GET /reservations/:id`.

- [ ] **Step 1: Escribir las pruebas que fallan**

1. La pantalla de reserva muestra **el total, el anticipo mínimo y la mensualidad sugerida** que vienen de la API. No los recalcula en el cliente: duplicar el cálculo de la mensualidad en Angular garantiza que algún día diverja del backend.
2. Elegir "pagar todo" frente a "pagar el anticipo" cambia el monto enviado; ningún otro campo cambia.
3. **El monto nunca viaja como entrada libre del usuario.** El cliente envía una intención (`FULL` o `DEPOSIT`) y el backend decide los centavos. Afirma la forma del cuerpo enviado.
4. Elegir OXXO muestra la ficha con su fecha límite y el saldo **sin cambiar**, con el aviso de que se acreditará al pagar.
5. Un viaje que se agotó mientras el usuario miraba la pantalla devuelve `TRIP_SOLD_OUT` y se muestra traducido, sin dejar la pantalla en estado de carga.
6. Un cliente con el correo sin verificar ve la invitación a verificar en lugar del botón de reservar.
7. El detalle muestra el estado del apartado con su cuenta regresiva, y cuando expira la pantalla lo refleja al refrescar.

- [ ] **Step 2: Verlas fallar e implementar**

Stripe Elements se carga de forma diferida y **sólo** en la pantalla de pago: montarlo en el arranque penaliza cada apertura de la app para la mayoría de sesiones que nunca pagan.

La clave publicable sale de la configuración de entorno de la app, nunca incrustada en el código fuente.

Después de confirmar en Elements, la app **no asume que el pago está hecho**: muestra "procesando" y consulta el estado de la reserva, porque la verdad llega por el webhook. Es la diferencia entre una interfaz que miente y una que espera.

- [ ] **Step 3: Verificar el flujo completo a mano**

Con las claves de prueba de Stripe: reserva, paga con la tarjeta de prueba, confirma que el webhook llega (usa `stripe listen --forward-to`), que `paid_cents` sube y que la reserva pasa a `ACTIVE`. Repite con OXXO y comprueba que la ficha aparece y el saldo no se mueve.

Si no hay claves, **dilo**, deja las pruebas automatizadas contra el proveedor falso y marca el reporte como DONE_WITH_CONCERNS. No simules haberlo probado.

- [ ] **Step 4: Documentar y commitear**

```bash
git add -A
git commit -m "feat: add reservation and payment flow with stripe elements"
```

---

## Tarea 18: Bandeja, historial de pagos y perfil

**Files:**
- Create: `apps/client/src/app/features/inbox/inbox.component.ts`, `features/payments/payment-history.component.ts`, `features/profile/profile.component.ts` y sus specs
- Modify: `libs/i18n/src/lib/catalogs/{es,en}.json`

- [ ] **Step 1: Escribir las pruebas que fallan**

1. La bandeja lista las entregas propias, más recientes primero, y marca leída al abrir.
2. El contador de no leídas baja al abrir una.
3. El historial muestra cada pago con su método, fecha y monto, y **la deuda restante y la fecha límite** del viaje.
4. Un pago `PENDING` de OXXO se distingue visualmente de uno `SUCCEEDED` y **no** cuenta en lo pagado.
5. El perfil permite cambiar nombre, teléfono y foto; **el correo no se edita aquí** — cambiarlo exigiría volver a verificar y eso no está en esta fase. Si la pantalla lo ofrece, es un defecto.
6. Cerrar sesión borra la sesión y vuelve al catálogo público.

- [ ] **Step 2: Implementar, verificar y commitear**

```bash
git add -A
git commit -m "feat: add customer inbox, payment history and profile"
```

---

## Tarea 19: El panel atiende las solicitudes de cancelación

La spec §5.6 dice que **una persona decide**: el cliente solicita y el administrador resuelve. La Tarea 4 construyó la solicitud; sin esta tarea, las solicitudes entran y nadie puede responderlas, y el permiso `reservation.cancel` seguiría definido desde la Fase 1 sin usarse nunca — exactamente el defecto de costura que la Fase 1 cometió con `trip.cancel`.

**Files:**
- Create: `apps/api/src/app/api/v1/admin/reservations/route.ts`, `[id]/cancel/route.ts`
- Create: `apps/admin/src/app/features/reservations/{reservation-list,reservation-detail}.component.ts` y sus specs
- Modify: `libs/domain/reservations/src/lib/reservation-service.ts` (`listReservationsForStaff`, `cancelReservation`)

**Interfaces:**
- Produces: `listReservationsForStaff(db, filter)`, `cancelReservation(db, email, { reservationId, actorId, reason })`

- [ ] **Step 1: Escribir las pruebas que fallan**

**Dominio:**
1. Cancelar libera el lugar: el cupo disponible del viaje sube en uno.
2. Cancelar **conserva** `paid_cents` y los pagos registrados. Aplicar o devolver ese dinero es 2B; borrarlo aquí destruiría el registro contable.
3. Cancelar una reserva ya `CANCELLED` es idempotente y no vuelve a notificar.
4. Cancelar genera el aviso `RESERVATION_CANCELLED` al cliente y una entrada de auditoría con el actor y el motivo.

**HTTP:**
5. Sin el permiso `reservation.cancel` → 403 `PERMISSION_DENIED`.
6. Con el permiso → 200. Usa `anyPermission` sólo si realmente hay dos grants válidos; si hay uno solo, declara `permission`.
7. Un actor `CUSTOMER` no alcanza estos endpoints aunque tuviera el permiso: son rutas de personal.
8. El listado filtra por viaje y por estado, y **destaca las que tienen `cancellation_requested_at` sin resolver** — es la bandeja de trabajo real del administrador.

- [ ] **Step 2: Verlas fallar, implementar, verlas pasar**

La liberación del lugar no es una columna que se decremente: el cupo es derivado (§5.1), así que cancelar sólo cambia el `status`, y el conteo de la Tarea 3 deja de contarla. **Si te encuentras restando de un contador almacenado, el modelo se rompió.**

- [ ] **Step 3: Pantalla del panel**

Lista con filtros, detalle con el historial de pagos y el motivo de la solicitud, y la acción de cancelar tras una confirmación que diga qué se libera y qué se conserva. El botón se oculta sin el permiso — comodidad visual, nunca seguridad: la comprobación real está en el paso 1.

- [ ] **Step 4: Verificar, documentar y commitear**

Actualiza `reservations.md` con la regla de cancelación y completa el diagrama de estados.

```bash
git add -A
git commit -m "feat: let staff review and resolve cancellation requests"
```

---

## Tarea 20: Responsive, despliegue y diagramas

**Files:**
- Modify: `infra/nginx/*.conf`, `infra/compose/compose.prod.yml`, `infra/docker/Dockerfile.client`
- Create: `docs/diagrams/trip-reservation.md`
- Modify: `docs/diagrams/payment-flow.md`, `docs/business-rules/{reservations,payments,notifications}.md`, `CLAUDE.md`, `README.md`

- [ ] **Step 1: Verificar la app en tres anchos reales**

360, 768 y 1280 píxeles, en el navegador, recorriendo catálogo → registro → reserva → pago. **Reporta lo que se rompe**, no una afirmación de que es responsive. La spec exige móvil, tableta y escritorio; esto es la comprobación de esa exigencia.

- [ ] **Step 2: Servir la app cliente desde el mismo Nginx**

El panel vive en `/admin/`; la app cliente en `/app/`, con su propia raíz estática y el mismo `try_files … /index.html` para las rutas de Angular. `/` redirige a `/app/` — los clientes son muchos más que los administradores. Verifica que la redirección anterior a `/admin/` ya no aplica y que ambas apps cargan sus assets con la base correcta (`--base-href`).

El build de Capacitor usa los mismos assets pero empaquetados; no depende de Nginx.

- [ ] **Step 3: Completar los diagramas**

`trip-reservation.md` con el ciclo completo: `HELD` → `ACTIVE` → `COMPLETED`, con las salidas `EXPIRED` y `CANCELLED`, quién dispara cada transición y qué job la provoca. `payment-flow.md` ya existe desde la Tarea 10; complétalo con OXXO y SPEI y con el caso límite de §5.3.

Mermaid dentro de Markdown, nunca imágenes. Cita las etiquetas que lleven paréntesis, dos puntos o acentos.

- [ ] **Step 4: Actualizar `CLAUDE.md`**

Añade a la tabla de documentación viva las filas que faltan y documenta: que `apps/worker` existe y por qué está separado de la API, que `/app/` sirve la app cliente, y la convención de que **la verdad de un pago llega por webhook, nunca por la respuesta del cliente**.

- [ ] **Step 5: Verificación completa y commit**

```bash
pnpm nx run-many -t typecheck lint test build --skip-nx-cache
git add -A
git commit -m "docs: complete phase 2a diagrams, deployment and conventions"
```

---

## Tarea 21: Pruebas de extremo a extremo

Va al final a propósito: un E2E escrito contra pantallas que aún cambian se pasa la fase entera roto.

**Files:**
- Create: `apps/client-e2e/` con la configuración de Playwright y los specs
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Escribir los tres recorridos**

1. **El camino feliz completo**: registrarse → verificar con el código (leído de la base, no del correo) → abrir un viaje → reservar con anticipo → pagar con la tarjeta de prueba → ver la reserva `ACTIVE` y el saldo correcto.
2. **El apartado que expira**: reservar sin pagar, forzar el vencimiento ejecutando `expireHolds` directamente, y comprobar que la pantalla muestra la reserva expirada y que el lugar volvió al catálogo.
3. **El límite de cupo**: un viaje con un solo lugar, dos clientes intentando reservar; uno gana y el otro ve `TRIP_SOLD_OUT`. Es la verificación de extremo a extremo de la Tarea 3.

- [ ] **Step 2: Hacer el arranque determinista**

Base sembrada desde cero antes de la corrida, el proveedor de pagos falso salvo que haya claves de Stripe, el reloj controlado donde haga falta. Un E2E que depende de un servicio externo es un E2E que falla los viernes.

- [ ] **Step 3: Añadirlo a CI y commitear**

Un job aparte del de unidades, con Postgres como servicio y los navegadores cacheados. Si la corrida supera los diez minutos, **reporta el tiempo** en lugar de recortar casos.

```bash
git add -A
git commit -m "test: add end-to-end coverage for registration, booking and payment"
```

---

## Cierre de la fase

Al terminar la Tarea 21, la fase cierra con `superpowers:finishing-a-development-branch`: suite completa sin caché sobre el árbol que se va a integrar, y la decisión de integración es del usuario.

**Lo que esta fase deliberadamente no hace** (queda para 2B y 3): el mostrador cobrando en efectivo, los recibos en PDF, el saldo a favor, la importación CSV, las campañas de notificaciones programadas y los reportes de ingresos y egresos.
