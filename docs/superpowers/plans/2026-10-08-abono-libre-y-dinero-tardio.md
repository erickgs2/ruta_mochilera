# Plan de implementación: abono libre y dinero tardío

> **Para agentes:** SUB-SKILL REQUERIDA: usa superpowers:subagent-driven-development (recomendada) o
> superpowers:executing-plans para implementar este plan tarea por tarea. Los pasos usan casillas
> (`- [ ]`) para el seguimiento.

**Objetivo:** que un viajero abone la cantidad que elija (con mínimo) con tarjeta u OXXO —y SPEI
detrás de un interruptor— en reservas `HELD` y `ACTIVE`, y que todo pago confirmado sobre una reserva
`EXPIRED` o `CANCELLED` abra un caso de seguimiento (`LatePaymentCase`) en la cola del Mostrador que
reemplaza la alerta `ORPHAN_PAYMENT`.

**Arquitectura:** las reglas viven en `@rm/domain-payments` («el cliente propone, el servidor
dispone»); el puerto `PaymentProvider` gana límites por método y la vigencia de OXXO sin apartado; los
valores ajustables viven en `SystemSetting`. El caso de pago tardío es un registro propio, único por
`providerIntentId`, abierto en la transacción del webhook y cerrado por una acción del personal o,
automáticamente, por la reactivación de la reserva.

**Stack:** Next.js (Route Handlers) · Prisma 7 sobre PostgreSQL 15 · Zod 4 · Vitest (dominio, API,
worker) · pg-boss (`apps/worker`) · Luxon.

**Specs:**
- `docs/superpowers/specs/2026-10-07-abono-libre-diseno.md` (aprobado, con D1–D10 de §15).
- `LatePaymentCase`: `.impeccable/review/admin-api-gaps.md` §2c y la decisión del dueño del
  2026-10-08 (transmitida por Alpha), que este plan transcribe en «Decisiones que el plan fija».

**Base:** `main` 9ca2f56 (incluye `feat/alerts-by-permission`; el plan se escribió sobre 4aebac6).
Ya están en `main` y **no** se rehacen aquí: el reparto del sobrepago
(`settleConfirmedPayment`, `OVERPAYMENT`, `PAYMENT_EXCESS_CREDITED`), el orden único de candados
(`lockReservationForMoney`), «un aviso por pago liquidado» (`settledNow`) y la resta de `OVERPAYMENT`
en `reconcilePaidCents` (rama `fix/payments-overpayment-and-lock-order`, merge 99904b4).

---

## Restricciones globales

Cada tarea las cumple aunque no las repita.

- Código, nombres, comentarios y commits en **inglés**; sólo `docs/**` en español (`CLAUDE.md`).
- Dinero: `Int` en centavos MXN. Nunca `Float`.
- `libs/domain` no importa nada de HTTP; recibe el cliente Prisma y devuelve `Result<T>`.
- Una ruta: autenticar, verificar permiso, validar con Zod, llamar al dominio. Nada más.
- Un pago sólo existe cuando Stripe lo confirma por webhook; el cliente nunca mueve `paid_cents`.
- Errores: códigos estables; cada código nuevo va en `DomainErrorCode`
  (`libs/shared-utils/src/lib/result.ts`), `STATUS_BY_CODE` (`apps/api/src/lib/http/problem.ts`) y
  `errors.*` de `libs/i18n/src/assets/es.json` y `en.json`.
- `libs/api-client/src/lib/schema.d.ts` sólo se regenera con `pnpm api:types`.
- Documentación en el **mismo commit** que el código, según la tabla de `CLAUDE.md`:
  `libs/domain/payments/**` → `docs/business-rules/payments.md` + `docs/diagrams/payment-flow.md`;
  `libs/domain/notifications/**` → `docs/business-rules/notifications.md`;
  `libs/domain/reservations/**` → `docs/business-rules/reservations.md` +
  `docs/diagrams/trip-reservation.md`.
- Orden de candados en todo camino de dinero: **viaje → reserva → cliente → contador de folios**
  (comentario «Lock order» al inicio de `payment-service.ts`). Nada nuevo lo invierte.
- Valores del dueño (§15 del spec): mínimo de abono **$300.00** (30 000 centavos); D2 **sí**
  (en `HELD` el abono cubre al menos lo que falta del anticipo); ficha OXXO en `ACTIVE` **3 días
  naturales**; D4 **no acotar** por la fecha límite; SPEI en `ACTIVE` **72 h**; SPEI **apagado**
  (`payments.spei_enabled = false`); excedente **automático** a saldo a favor; **sin límite** de
  fichas abiertas; tarjeta abandonada a las **24 h**; abono OXXO sobre el máximo por ficha **se
  rechaza**.
- Carga de la máquina (regla de Alpha, 2026-10-08): `NX_DAEMON=false` delante de todo `nx`; sólo los
  specs afectados, con `--maxWorkers=1` en Jest y sin correr proyectos completos salvo al cerrar una
  tarea. Las suites completas las corre Charlie. Proyectos de prueba siempre con `--parallel=1`.
- Trabajo en una rama propia y en su worktree (`.worktrees/<rama>`), con `.env` copiado.

## Decisiones que el plan fija (aceptadas por Alpha el 2026-10-08)

| # | Decisión | Por qué |
|---|---|---|
| P1 | **Un caso por `providerIntentId`** (`@unique`), abierto también en el camino `NEEDS_A_HUMAN` (fila ya `EXPIRED`/`FAILED` → `WRITTEN_OFF`; sin reserva → `UNMATCHED`). | La decisión del dueño pide unicidad por intento y que cierre NB5: dos `evt_` del mismo intento escalaban dos veces. |
| P2 | «Dejar como saldo a favor» escribe un movimiento **`EXPIRATION`** con `payment_id` por la parte que cupo; «devuelto» escribe ese mismo movimiento y enseguida un **`REFUND`** por el mismo monto, en la misma transacción. | Es exactamente lo que `payments.md` («Caso límite») pide hacer a mano hoy (`ADJUSTMENT` + `REFUND`), pero atómico y con un tipo que `reclaimCreditForRevival` ya sabe recuperar: si después se revive, el saldo vuelve a la reserva sin código nuevo; si ya se devolvió, la reactivación responde `CREDIT_INSUFFICIENT`, que es lo correcto. |
| P3 | La reactivación (`reviveForPayment`) cierra con `REVIVED`, en su transacción, todo caso `AFTER_EXPIRY` abierto de esa reserva. `REVIVED` no se acepta desde la API. | «Revival closes it automatically» (dueño). |
| P4 | Casos que **sólo piden acuse** (`ACKNOWLEDGED`): `AFTER_CANCELLATION` y `AFTER_EXPIRY` sin parte pendiente (todo fue `OVERPAYMENT`). | «CANCELLED only asks for an ack» (dueño); un pago tardío que ya es saldo a favor completo está en el mismo caso. |
| P5 | `WRITTEN_OFF` y `UNMATCHED` (dinero que Stripe cobró y que **no** está en nuestros libros) se cierran con `REFUNDED` (devuelto en el panel de Stripe) o `ACKNOWLEDGED`, los dos **con nota obligatoria**; ninguno mueve saldo. | Aceptar ese dinero en los libros «deshace una decisión tomada en otro lado» (spec §14). El dueño confirmó que no habrá acción «aceptar» (Q1). |
| P6 | El webhook deja de emitir `ORPHAN_PAYMENT`; en su lugar, **una sola vez por caso** (sólo cuando la inserción del caso ganó), avisa al personal con `LATE_PAYMENT_OPENED`, audiencia `payment.view` + `payment.credit.apply`. El tipo `ORPHAN_PAYMENT` queda en el catálogo por las filas históricas. | «Replaces ORPHAN_PAYMENT» y la decisión del 2026-10-08 de alertas de dinero por permiso. Alpha confirmó el aviso y además la cola (Q2). |
| P7 | Sin backfill: los `ORPHAN_PAYMENT` anteriores no abren casos. | No hay un registro durable del que reconstruirlos (§2c); y todavía no hay producción (Q3). |

## Decisiones confirmadas (2026-10-08)

Plan aprobado por Alpha con P1–P7 tal como están escritas. Respuestas a las preguntas que quedaban
abiertas:

| # | Pregunta | Respuesta | Quién | Consecuencia en el plan |
|---|---|---|---|---|
| Q1 | ¿Acción «aceptar el dinero» para `WRITTEN_OFF`? | **No.** `WRITTEN_OFF` y `UNMATCHED` se cierran sólo con `REFUNDED` o `ACKNOWLEDGED`, con nota | Dueño | P5 queda como está; no hay tarea L3b |
| Q2 | ¿Aviso `LATE_PAYMENT_OPENED` o sólo la cola? | **Las dos cosas**: el aviso, exactamente uno por caso (idempotente por la unicidad del propio caso), para `payment.view` y `payment.credit.apply`, y además la cola | Alpha | L2 paso 4 va completo |
| Q3 | ¿Backfill de casos anteriores? | **No.** Todavía no hay producción, así que no existen `ORPHAN_PAYMENT` reales que reconstruir | Dueño | P7 queda como está; no hay tarea L6 |

**Dependencia resuelta:** `feat/alerts-by-permission` está en `main` (9ca2f56); L2 no espera a nadie.

**Reparto confirmado por Alpha:**
- **Bravo**, en una sola rama `feat/abono-libre-basics`, antes de su catálogo: A1, A2, A3, A6, A7.
  Después, L4 y L5.
- **Echo**: A4 en `feat/abono-libre-port`; L1 → L2 → L3 en `feat/late-payment-cases`; A5 cuando
  A1–A3 estén listos, en `feat/abono-libre` (que integra `basics` + `port`); luego A8 y A9.
- Ramas desde `main` 9ca2f56.

## Foco de revisión

Entradas o condiciones que el spec implica y que ninguna prueba del camino feliz toca. Cada una tiene
su prueba en la tarea que posee el código.

1. **Monto entre el saldo y el mínimo**: debe $200 y el mínimo es $300 → el mínimo es lo que se debe;
   $200 pasa y $199 no (A5, paso 1).
2. **OXXO en `ACTIVE` creada a las 23:58 de Ciudad de México**: la ficha debe durar 3 días completos
   de Stripe, no 2 (A4, paso 1).
3. **Dos intentos de tarjeta creados a la vez en la misma reserva**: nunca se cancelan entre sí; sólo
   el más viejo se cancela (A8, paso 1).
4. **Resolver un caso «saldo a favor» mientras el mostrador revive la reserva con efectivo**: el mismo
   peso nunca cuenta en el saldo y en la reserva viva (L3, paso 6).
5. **Dos entregas distintas (`evt_`) del mismo intento por el camino `NEEDS_A_HUMAN`, a la vez**: un
   solo caso y un solo aviso (L2, paso 3; cierra NB5).

---

## Mapa de archivos

| Archivo | Responsabilidad | Tareas |
|---|---|---|
| `libs/shared-utils/src/lib/result.ts` | Códigos `PAYMENT_BELOW_MINIMUM`, `PAYMENT_METHOD_UNAVAILABLE`, `NOTHING_DUE` | A1 |
| `apps/api/src/lib/http/problem.ts` | HTTP de esos códigos | A1 |
| `libs/i18n/src/assets/{es,en}.json` | `errors.*` de esos códigos | A1 |
| `libs/domain/payments/src/lib/payment-settings.ts` (nuevo) | Leer los cinco `payments.*` con su valor por omisión | A2 |
| `libs/db/prisma/seed.ts` | Sembrar los cinco `payments.*` | A2 |
| `libs/contracts/src/lib/payments.ts` | Unión discriminada `FULL`/`DEPOSIT`/`AMOUNT`; `bankTransfer` | A3 |
| `libs/contracts/src/lib/reservations.ts` | `paymentOptions` en `ReservationDetail` | A3 |
| `apps/api/src/lib/openapi/registry.ts`, `libs/api-client/**` | Registro y tipos generados | A3, L4 |
| `libs/payments-stripe/src/lib/payment-provider.ts` | Puerto: `limitsFor`, `ProviderLimits` | A4 |
| `libs/payments-stripe/src/lib/stripe-payment-provider.ts` | Límites, `oxxoDeadlineAfterDays` | A4 |
| `libs/payments-stripe/src/lib/fake-payment-provider.ts` | Límites configurables para pruebas | A4 |
| `libs/payments-stripe/README.md` | OXXO en `ACTIVE`, límites | A4 |
| `libs/domain/payments/src/lib/charge-amount.ts` (nuevo) | Regla pura: cuánto se cobra o por qué no | A5 |
| `libs/domain/payments/src/lib/payment-options.ts` (nuevo) | `paymentOptions` para la UI | A5 |
| `libs/domain/payments/src/lib/payment-intent-service.ts` | `AMOUNT`, mínimos, OXXO en `ACTIVE`, límites | A5, A8 |
| `apps/api/src/app/api/v1/reservations/[reservationId]/payment-intents/route.ts` | Pasar el `intent` completo | A5 |
| `apps/api/src/lib/http/reservation-response.ts` | Añadir `paymentOptions` | A5 |
| `libs/domain/payments/src/lib/instalment.ts`, `payment-service.ts` (`suggestedMonthlyForReservation`) | Tope inferior | A6 |
| `libs/receipts/src/lib/receipt-renderer.ts`, `pdf-lib-receipt-renderer.ts` | `creditedCents` y su línea | A7 |
| `libs/domain/payments/src/lib/receipt-service.ts` (`loadReceipt`) | Leer el `OVERPAYMENT` del pago | A7 |
| `libs/domain/payments/src/lib/payment-intent-cancellation.ts` | Cancelar intentos de tarjeta más viejos | A8 |
| `apps/worker/src/jobs/expire-stale-payment-intents.ts` (nuevo), `apps/worker/src/main.ts`, `libs/jobs/src/lib/job-names.ts` | Job horario | A9, B2 |
| `libs/db/prisma/schema.prisma` + migración | `LatePaymentCase`, enums, índices | L1 |
| `libs/domain/payments/src/lib/late-payment-case.ts` (nuevo) | Abrir, listar, resolver, cerrar por reactivación | L2, L3 |
| `libs/domain/payments/src/lib/webhook-handler.ts` | Abrir casos en vez de `ORPHAN_PAYMENT` | L2 |
| `libs/domain/notifications/src/lib/templates.ts`, `delivery-service.ts` | `LATE_PAYMENT_OPENED` y su audiencia | L2 |
| `libs/domain/payments/src/lib/credit-service.ts` (`reviveForPayment`) | Cerrar casos al revivir | L3 |
| `libs/contracts/src/lib/late-payments.ts` (nuevo), `apps/api/src/app/api/v1/admin/late-payments/**` | Lista y resolución | L4 |
| `libs/domain/reservations/src/lib/work-queue-summary.ts`, `libs/contracts/src/lib/work-queue.ts` | Quinto conteo | L5 |

---

## Reparto, dependencias y olas

Una tarea **simple** va a Bravo; una **compleja** (dinero bajo candado, concurrencia, varios
módulos), a Echo. Ramas: `feat/abono-libre-basics` (Bravo: A1, A2, A3, A6, A7), `feat/abono-libre-port`
(Echo: A4), `feat/abono-libre` (integra las dos, para A5, A8, A9) y `feat/late-payment-cases` para
L*, cada una desde `main` 9ca2f56; `feat/abono-libre-spei` para B*, desde `feat/abono-libre` integrada.

| Tarea | Quién | Depende de | Toca (para evitar choques) |
|---|---|---|---|
| A1 Errores nuevos | Bravo (simple) | — | `result.ts`, `problem.ts`, `es/en.json` |
| A2 Configuración de pagos | Bravo (simple) | — | `payment-settings.ts`, `seed.ts`, `payments.md` §Configuración |
| A3 Contrato | Bravo (simple) | A1 | `contracts`, `registry.ts`, `api-client` |
| A4 Puerto: límites y OXXO sin apartado | Echo (compleja) | — | `libs/payments-stripe/**` |
| A5 Crear intento con `AMOUNT` + `paymentOptions` | Echo (compleja) | A1, A2, A3, A4 | `charge-amount.ts`, `payment-options.ts`, `payment-intent-service.ts`, 2 archivos de `apps/api` |
| A6 Mensualidad con tope inferior | Bravo (simple) | A2 | `instalment.ts`, `payment-service.ts` (sólo `suggestedMonthlyForReservation`) |
| A7 Recibo con la línea del excedente | Bravo (simple) | — | `libs/receipts/**`, `receipt-service.ts` |
| A8 Un intento de tarjeta abierto | Echo (compleja) | A5 | `payment-intent-cancellation.ts`, `payment-intent-service.ts` |
| A9 Job de intentos vencidos (tarjeta) | Echo (compleja) | A2 | `apps/worker/**`, `libs/jobs/**` |
| L1 Modelo `LatePaymentCase` | Echo (compleja) | — | `schema.prisma`, migración |
| L2 El webhook abre casos | Echo (compleja) | L1 (`feat/alerts-by-permission` ya en `main`) | `webhook-handler.ts`, `late-payment-case.ts`, `templates.ts`, `delivery-service.ts` |
| L3 Resolver y cerrar por reactivación | Echo (compleja) | L2 | `late-payment-case.ts`, `credit-service.ts`, `credit-ledger.ts` |
| L4 API de casos | Bravo (simple) | L3 | `contracts/late-payments.ts`, `apps/api/.../late-payments/**`, `registry.ts`, `api-client` |
| L5 Quinto conteo de la cola | Bravo (simple) | L1; **rama de Bravo `feat/admin-work-queue-api`** en `main` | `work-queue-summary.ts`, `work-queue.ts` (contrato) |
| B1 Adaptador SPEI con Customer | Echo (compleja) | A4 integrada; claves de prueba de Stripe para la lista de §11 | `libs/payments-stripe/**`, migración `stripe_customer_id` |
| B2 SPEI en el dominio y en el job | Echo (compleja) | A5, A9, B1 | `payment-intent-service.ts`, `expire-stale-payment-intents.ts`, `templates.ts` |
| B3 Eventos SPEI del webhook | Echo (compleja) | B2 | `webhook-handler.ts`, `templates.ts`, `delivery-service.ts` |

**Olas** (lo que puede ir en paralelo sin chocar en archivos):

1. A1, A2, A7 (Bravo) · A4, L1 (Echo).
2. A3, A6 (Bravo) · L2 (Echo).
3. A5 (Echo) · L3 (Echo, después de L2) · L5 (Bravo, si la cola ya está en `main`).
4. A8, A9 (Echo) · L4 (Bravo).
5. B1 → B2 → B3 (Echo), sólo con claves de prueba de Stripe; SPEI sale apagado.

**Choques conocidos:** `payments.md` lo tocan casi todas; cada tarea edita **sólo** las secciones que
nombra. `registry.ts` y `schema.d.ts` los tocan A3 y L4: L4 se rebasa sobre A3 si llegan juntas.
`webhook-handler.ts` lo tocan L2 y B3: B3 va después. `templates.ts` lo tocan L2, B2 y B3, en ese
orden. `payment-intent-service.ts` lo tocan A5 y A8 (secuenciales) y B2.

---

## Comandos de referencia

```bash
# Un spec de dominio (Vitest), con poca carga
NX_DAEMON=false npx pnpm nx test payments -- charge-amount
# Un spec del worker
NX_DAEMON=false npx pnpm nx test worker -- expire-stale-payment-intents
# Un spec de API
NX_DAEMON=false npx pnpm nx test api -- payment-intents
# Lint y tipos de un proyecto, al cerrar la tarea
NX_DAEMON=false npx pnpm nx run-many -t lint typecheck -p payments --parallel=1
# Tipos del cliente generado
npx pnpm api:types
# Migración nueva (sin aplicarla a rm_dev desde una tarea)
npx prisma migrate dev --create-only --name <nombre>
```

---

# Parte A — Abono libre (tarjeta y OXXO)

### Tarea A1: errores nuevos del abono libre (simple · Bravo)

**Archivos:**
- Modificar: `libs/shared-utils/src/lib/result.ts` (unión `DomainErrorCode`)
- Modificar: `apps/api/src/lib/http/problem.ts` (`STATUS_BY_CODE`)
- Modificar: `libs/i18n/src/assets/es.json`, `libs/i18n/src/assets/en.json` (`errors.*`)
- Modificar: `libs/i18n/src/lib/error-catalog.spec.ts` (`ALL_DOMAIN_ERROR_CODES`)
- Prueba: `apps/api/src/lib/http/problem.spec.ts` (si no existe un caso por código, añadirlo)

**Interfaces:**
- Produce: `'PAYMENT_BELOW_MINIMUM' | 'PAYMENT_METHOD_UNAVAILABLE' | 'NOTHING_DUE'` en `DomainErrorCode`.

- [ ] **Paso 1: prueba que falla.** Añade los tres códigos a `ALL_DOMAIN_ERROR_CODES` en
  `error-catalog.spec.ts`. El `switch` exhaustivo `assertKnownCode` deja de compilar y la prueba de
  traducciones falla porque `es.json`/`en.json` no los tienen.
- [ ] **Paso 2: verlo fallar.** `NX_DAEMON=false npx pnpm nx test i18n -- error-catalog` → FAIL
  (tipo desconocido / traducción faltante).
- [ ] **Paso 3: implementar.**

```ts
// libs/shared-utils/src/lib/result.ts, dentro de DomainErrorCode, junto a PAYMENT_EXCEEDS_BALANCE
  | 'PAYMENT_BELOW_MINIMUM'
  | 'PAYMENT_METHOD_UNAVAILABLE'
  | 'NOTHING_DUE'
```

```ts
// apps/api/src/lib/http/problem.ts, STATUS_BY_CODE
  PAYMENT_BELOW_MINIMUM: 422,
  PAYMENT_METHOD_UNAVAILABLE: 422,
  NOTHING_DUE: 409,
```

```jsonc
// es.json → "errors"
"PAYMENT_BELOW_MINIMUM": "El abono es menor que el mínimo permitido.",
"PAYMENT_METHOD_UNAVAILABLE": "Ese método de pago no está disponible para este abono.",
"NOTHING_DUE": "Esta reservación no tiene saldo pendiente."
// en.json → "errors"
"PAYMENT_BELOW_MINIMUM": "The payment is below the minimum allowed.",
"PAYMENT_METHOD_UNAVAILABLE": "That payment method is not available for this payment.",
"NOTHING_DUE": "This reservation has nothing left to pay."
```

- [ ] **Paso 4: verlo pasar.** `NX_DAEMON=false npx pnpm nx test i18n -- error-catalog` y
  `NX_DAEMON=false npx pnpm nx test api -- problem` → PASS.
- [ ] **Paso 5: commit.** `feat(errors): codes for free-amount payments`. Sin docs de reglas (no toca
  `libs/domain`).

**Charlie:** los tres códigos con su HTTP en `problem.spec.ts`; ninguna traducción vacía en es/en.

---

### Tarea A2: configuración de pagos (simple · Bravo)

**Archivos:**
- Crear: `libs/domain/payments/src/lib/payment-settings.ts`
- Crear: `libs/domain/payments/src/lib/payment-settings.spec.ts`
- Modificar: `libs/domain/payments/src/index.ts` (exportar)
- Modificar: `libs/db/prisma/seed.ts` (`DEFAULT_SETTINGS`)
- Docs: `docs/business-rules/payments.md` — sección nueva «Configuración de pagos» (sólo esa).
  `payment-flow.md` no cambia (no hay flujo nuevo): dilo en el commit.

**Interfaces:**
- Produce:

```ts
export interface PaymentSettings {
  minInstallmentCents: number;
  oxxoActiveVoucherDays: number;
  speiActiveLifetimeHours: number;
  speiEnabled: boolean;
  cardIntentStaleHours: number;
}
export const DEFAULT_PAYMENT_SETTINGS: PaymentSettings;
export async function readPaymentSettings(db: Db | DbTransactionClient): Promise<PaymentSettings>;
```

- [ ] **Paso 1: prueba que falla.**

```ts
// payment-settings.spec.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, prepareTestDb, resetDatabase, withTestDb } from '@rm/db/testing';
import { DEFAULT_PAYMENT_SETTINGS, readPaymentSettings } from './payment-settings';

const db = withTestDb();

describe('readPaymentSettings', () => {
  beforeAll(() => prepareTestDb(db));
  beforeEach(() => resetDatabase(db));
  afterAll(() => closeTestDb(db));

  it('falls back to the owner-approved defaults when the seed never ran', async () => {
    expect(await readPaymentSettings(db)).toEqual({
      minInstallmentCents: 30_000,
      oxxoActiveVoucherDays: 3,
      speiActiveLifetimeHours: 72,
      speiEnabled: false,
      cardIntentStaleHours: 24,
    });
    expect(DEFAULT_PAYMENT_SETTINGS.minInstallmentCents).toBe(30_000);
  });

  it('reads what staff stored', async () => {
    await db.systemSetting.createMany({
      data: [
        { key: 'payments.min_installment_cents', value: 50_000 },
        { key: 'payments.spei_enabled', value: true },
      ],
    });
    const settings = await readPaymentSettings(db);
    expect(settings.minInstallmentCents).toBe(50_000);
    expect(settings.speiEnabled).toBe(true);
    expect(settings.oxxoActiveVoucherDays).toBe(3);
  });

  // A typo in the admin (a string, a fraction, zero) must never become a
  // minimum of 0 or a voucher that expires today.
  it.each([
    ['payments.min_installment_cents', 'trescientos'],
    ['payments.min_installment_cents', 12.5],
    ['payments.oxxo_active_voucher_days', 0],
    ['payments.card_intent_stale_hours', -1],
    ['payments.spei_enabled', 'yes'],
  ])('ignores a malformed %s (%j) and keeps the default', async (key, value) => {
    await db.systemSetting.create({ data: { key, value } });
    expect(await readPaymentSettings(db)).toEqual(DEFAULT_PAYMENT_SETTINGS);
  });
});
```

- [ ] **Paso 2: verlo fallar.** `NX_DAEMON=false npx pnpm nx test payments -- payment-settings` →
  FAIL (módulo no existe).
- [ ] **Paso 3: implementar.**

```ts
// payment-settings.ts
import type { Db, DbTransactionClient } from '@rm/db';

export interface PaymentSettings {
  minInstallmentCents: number;
  oxxoActiveVoucherDays: number;
  speiActiveLifetimeHours: number;
  speiEnabled: boolean;
  cardIntentStaleHours: number;
}

/** The owner's decisions D1, D3, D5, D6 and D9 (abono libre spec §15). Also the fallback for an unseeded database. */
export const DEFAULT_PAYMENT_SETTINGS: PaymentSettings = {
  minInstallmentCents: 30_000,
  oxxoActiveVoucherDays: 3,
  speiActiveLifetimeHours: 72,
  speiEnabled: false,
  cardIntentStaleHours: 24,
};

const KEYS: Record<keyof PaymentSettings, string> = {
  minInstallmentCents: 'payments.min_installment_cents',
  oxxoActiveVoucherDays: 'payments.oxxo_active_voucher_days',
  speiActiveLifetimeHours: 'payments.spei_active_lifetime_hours',
  speiEnabled: 'payments.spei_enabled',
  cardIntentStaleHours: 'payments.card_intent_stale_hours',
};

const isPositiveInt = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0;

/**
 * The adjustable payment rules, read on every use (no cache: staff change them
 * without a deploy). A missing or malformed row keeps its default, so a typo in
 * the admin can never turn into a minimum of zero.
 */
export async function readPaymentSettings(db: Db | DbTransactionClient): Promise<PaymentSettings> {
  const rows = await db.systemSetting.findMany({ where: { key: { in: Object.values(KEYS) } } });
  const stored = new Map(rows.map((row) => [row.key, row.value as unknown]));
  const int = (field: Exclude<keyof PaymentSettings, 'speiEnabled'>) => {
    const value = stored.get(KEYS[field]);
    return isPositiveInt(value) ? value : DEFAULT_PAYMENT_SETTINGS[field];
  };
  const flag = stored.get(KEYS.speiEnabled);
  return {
    minInstallmentCents: int('minInstallmentCents'),
    oxxoActiveVoucherDays: int('oxxoActiveVoucherDays'),
    speiActiveLifetimeHours: int('speiActiveLifetimeHours'),
    speiEnabled: typeof flag === 'boolean' ? flag : DEFAULT_PAYMENT_SETTINGS.speiEnabled,
    cardIntentStaleHours: int('cardIntentStaleHours'),
  };
}
```

```ts
// seed.ts → DEFAULT_SETTINGS, después de 'receipt.prefix'
  // Abono libre (spec 2026-10-07, §15): D1, D3, D5, D6, D9. Mirror of
  // DEFAULT_PAYMENT_SETTINGS in @rm/domain-payments.
  'payments.min_installment_cents': 30_000,
  'payments.oxxo_active_voucher_days': 3,
  'payments.spei_active_lifetime_hours': 72,
  'payments.spei_enabled': false,
  'payments.card_intent_stale_hours': 24,
```

- [ ] **Paso 4: verlo pasar.** Mismo comando → PASS.
- [ ] **Paso 5: docs + commit.** En `payments.md`, sección «Configuración de pagos»: tabla clave →
  significado → valor por omisión → qué pasa con un valor mal escrito. Commit
  `feat(payments): adjustable payment settings for free-amount payments`.

**Charlie:** sin sembrar, los valores por omisión; con `pnpm db:seed`, las cinco filas; un valor mal
escrito no rompe nada.

---

### Tarea A3: contrato del intento y de las opciones de pago (simple · Bravo)

**Archivos:**
- Modificar: `libs/contracts/src/lib/payments.ts`
- Modificar: `libs/contracts/src/lib/reservations.ts` (`reservationDetailSchema`)
- Crear: `libs/contracts/src/lib/payments.spec.ts` (si no existe)
- Modificar: `apps/api/src/lib/openapi/registry.ts` (los esquemas nuevos y su `DateToString`)
- Regenerar: `libs/api-client/src/lib/schema.d.ts` (`npx pnpm api:types`)
- Modificar: `libs/api-client/src/lib/endpoints.ts` (comentario del POST de intentos; el tipo sale solo)

**Interfaces:**
- Produce (las usan A5 y la UI del rediseño):

```ts
export const paymentIntentKindSchema = z.enum(['FULL', 'DEPOSIT', 'AMOUNT']);
export const createPaymentIntentRequestSchema; // unión discriminada, §4.1 del spec
export const paymentOptionReasonSchema = z.enum(['NOT_CONFIGURED', 'WINDOW_TOO_SHORT', 'ABOVE_PROVIDER_LIMIT', 'DISABLED']);
export const paymentOptionsSchema; // §4.2 del spec
export const bankTransferSchema;   // §4.1 del spec, opcional en createdPaymentIntentSchema
export type PaymentOptionsContract = z.infer<typeof paymentOptionsSchema>;
// reservationDetailSchema gana: paymentOptions: paymentOptionsSchema
```

- [ ] **Paso 1: prueba que falla.**

```ts
// libs/contracts/src/lib/payments.spec.ts
import { describe, expect, it } from 'vitest';
import { createPaymentIntentRequestSchema } from './payments';

describe('createPaymentIntentRequestSchema', () => {
  it('keeps FULL and DEPOSIT exactly as the current app sends them', () => {
    expect(createPaymentIntentRequestSchema.safeParse({ intent: 'FULL', method: 'CARD' }).success).toBe(true);
    expect(createPaymentIntentRequestSchema.safeParse({ intent: 'DEPOSIT', method: 'OXXO' }).success).toBe(true);
  });

  it('takes an amount only with AMOUNT', () => {
    expect(createPaymentIntentRequestSchema.safeParse({ intent: 'AMOUNT', method: 'CARD', amountCents: 30_000 }).success).toBe(true);
    expect(createPaymentIntentRequestSchema.safeParse({ intent: 'AMOUNT', method: 'CARD' }).success).toBe(false);
  });

  // A FULL that carried an amount would be a second way to say how much;
  // there must be exactly one.
  it('drops an amount sent with FULL or DEPOSIT', () => {
    const parsed = createPaymentIntentRequestSchema.parse({ intent: 'FULL', method: 'CARD', amountCents: 1 });
    expect('amountCents' in parsed).toBe(false);
  });

  it.each([0, -100, 12.5, '30000'])('refuses an amount of %j', (amountCents) => {
    expect(createPaymentIntentRequestSchema.safeParse({ intent: 'AMOUNT', method: 'CARD', amountCents }).success).toBe(false);
  });
});
```

- [ ] **Paso 2: verlo fallar.** `NX_DAEMON=false npx pnpm nx test contracts -- payments` → FAIL.
- [ ] **Paso 3: implementar.**

```ts
// payments.ts
export const paymentIntentKindSchema = z.enum(['FULL', 'DEPOSIT', 'AMOUNT']);

/**
 * The body of `POST /reservations/{reservationId}/payment-intents`.
 *
 * The client proposes, the server decides (abono libre spec §3): `FULL` and
 * `DEPOSIT` carry no amount and keep their meaning; only `AMOUNT` carries one,
 * which `@rm/domain-payments` validates against the reservation and the
 * minimums before anything is charged.
 */
export const createPaymentIntentRequestSchema = z.discriminatedUnion('intent', [
  z.object({ intent: z.literal('FULL'), method: paymentIntentMethodSchema }),
  z.object({ intent: z.literal('DEPOSIT'), method: paymentIntentMethodSchema }),
  z.object({
    intent: z.literal('AMOUNT'),
    method: paymentIntentMethodSchema,
    amountCents: z.number().int().positive(),
  }),
]);

export const paymentOptionReasonSchema = z.enum(['NOT_CONFIGURED', 'WINDOW_TOO_SHORT', 'ABOVE_PROVIDER_LIMIT', 'DISABLED']);

/** What the app needs to offer a payment without re-implementing the rules (spec §4.2). Informative: the POST decides. */
export const paymentOptionsSchema = z.object({
  minAmountCents: z.number().int(),
  maxAmountCents: z.number().int(),
  depositOwedCents: z.number().int(),
  methods: z.array(
    z.object({
      method: paymentIntentMethodSchema,
      available: z.boolean(),
      reason: paymentOptionReasonSchema.optional(),
    })
  ),
});

/** SPEI instructions (Part B). Absent for CARD and OXXO. */
export const bankTransferSchema = z.object({
  clabe: z.string(),
  reference: z.string(),
  bankName: z.string(),
  amountRemainingCents: z.number().int(),
  hostedInstructionsUrl: z.string(),
  expiresAt: z.iso.datetime(),
});

// createdPaymentIntentSchema: añadir
//   bankTransfer: bankTransferSchema.optional(),

export type PaymentOptionsContract = z.infer<typeof paymentOptionsSchema>;
```

```ts
// reservations.ts
export const reservationDetailSchema = reservationSchema.extend({
  suggestedMonthlyCents: z.number().int(),
  paymentOptions: paymentOptionsSchema,
});
```

  En `registry.ts`, registrar `PaymentOptions` y `BankTransfer` con `.meta({ id })` como
  `ReservationDetail` (línea ~131) y añadir su par `DateToString` en la comprobación de paridad.
  Correr `npx pnpm api:types`.
- [ ] **Paso 4: verlo pasar.** `NX_DAEMON=false npx pnpm nx test contracts -- payments` y
  `NX_DAEMON=false npx pnpm nx test api -- registry` → PASS. `git diff --stat
  libs/api-client/src/lib/schema.d.ts` muestra sólo los esquemas nuevos.
- [ ] **Paso 5: commit.** `feat(contracts): free-amount intents and payment options`.
  Nota: `reservation-response.ts` no compila hasta A5 si `ReservationDetail` exige `paymentOptions`.
  Para no dejar `main` roto, **A3 y A5 se integran juntas** (A3 en la rama de A5), o A3 declara
  `paymentOptions` con `.optional()` y A5 lo vuelve obligatorio. Elige lo segundo.

**Charlie:** la app actual (`FULL`/`DEPOSIT`) sigue creando intentos; `schema.d.ts` sin ediciones a
mano (la cabecera intacta y `api:types` no deja diferencias).

---

### Tarea A4: el puerto conoce sus límites y la vigencia de OXXO sin apartado (compleja · Echo)

**Archivos:**
- Modificar: `libs/payments-stripe/src/lib/payment-provider.ts`
- Modificar: `libs/payments-stripe/src/lib/stripe-payment-provider.ts`
- Modificar: `libs/payments-stripe/src/lib/fake-payment-provider.ts`
- Modificar: el contrato compartido `runPaymentContract` (en su archivo actual) y
  `stripe-payment-provider.spec.ts`, `fake-payment-provider.spec.ts`
- Docs: `libs/payments-stripe/README.md` (OXXO en `ACTIVE`, límites «a verificar»)

**Interfaces:**
- Produce:

```ts
export interface ProviderLimits {
  /** Smallest amount the provider charges for this method, in MXN cents. */
  minCents: number;
  /** Largest, or `null` when the provider documents none. */
  maxCents: number | null;
}
// PaymentProvider gana:
limitsFor(method: PaymentIntentMethod): ProviderLimits;
// stripe-payment-provider.ts exporta además:
export function oxxoDeadlineAfterDays(days: number, now?: Date): Date;
export const STRIPE_LIMITS: Record<PaymentIntentMethod, ProviderLimits>;
// FakePaymentProvider: constructor(webhookSecret?: string, limits?: Partial<Record<PaymentIntentMethod, ProviderLimits>>)
```

- [ ] **Paso 1: pruebas que fallan.**

```ts
// stripe-payment-provider.spec.ts
import { DateTime } from 'luxon';
import { oxxoDeadlineAfterDays, oxxoExpiresAfterDays } from './stripe-payment-provider';

describe('oxxoDeadlineAfterDays', () => {
  const at = (iso: string) => DateTime.fromISO(iso, { zone: 'America/Mexico_City' }).toJSDate();

  // Stripe: expires_after_days = N expires at 23:59 Mexico City time N days
  // after creation. The deadline the domain stores must round-trip to the
  // same N, or the voucher would be shorter than the owner's 3 days.
  it.each(['2026-10-08T00:01', '2026-10-08T12:00', '2026-10-08T23:58', '2026-12-31T23:59'])(
    'round-trips 1..31 days from %s',
    (iso) => {
      const now = at(iso);
      for (let days = 1; days <= 31; days += 1) {
        expect(oxxoExpiresAfterDays(oxxoDeadlineAfterDays(days, now), now)).toBe(days);
      }
    }
  );

  it('ends at the last minute of the Nth Mexico City day', () => {
    const deadline = DateTime.fromJSDate(oxxoDeadlineAfterDays(3, at('2026-10-08T23:58')), { zone: 'America/Mexico_City' });
    expect(deadline.toFormat('yyyy-MM-dd HH:mm')).toBe('2026-10-11 23:59');
  });
});

describe('limitsFor', () => {
  it('states the documented Stripe limits per method', () => {
    const provider = new StripePaymentProvider(/* test config as in this spec */);
    expect(provider.limitsFor('OXXO')).toEqual({ minCents: 1_000, maxCents: 1_000_000 });
    expect(provider.limitsFor('CARD').minCents).toBe(1_000);
  });
});
```

  Revisa la firma real de `oxxoExpiresAfterDays` (línea ~74) y úsala tal cual en la prueba; si no
  recibe `now`, añade el parámetro opcional `now = new Date()` en el paso 3 sin cambiar a quien ya la
  llama.

  En el contrato compartido (`runPaymentContract`), un caso nuevo: «an OXXO intent asked to expire
  three days out never comes back expiring later» con `voucherExpiresAt: oxxoDeadlineAfterDays(3)`.

- [ ] **Paso 2: verlo fallar.** `NX_DAEMON=false npx pnpm nx test payments-stripe` → FAIL
  (`oxxoDeadlineAfterDays` y `limitsFor` no existen).
- [ ] **Paso 3: implementar.**

```ts
// stripe-payment-provider.ts
/**
 * The inverse of `oxxoExpiresAfterDays`: the instant a voucher created now
 * with `expires_after_days = days` stops being payable -- 23:59 Mexico City
 * time, `days` calendar days after `now` (Stripe's own definition). The domain
 * sends it as `voucherExpiresAt` for an ACTIVE reservation, which has no hold
 * to bound the voucher (abono libre spec §5.4).
 */
export function oxxoDeadlineAfterDays(days: number, now: Date = new Date()): Date {
  return DateTime.fromJSDate(now, { zone: STRIPE_OXXO_TIME_ZONE })
    .plus({ days })
    .set({ hour: 23, minute: 59, second: 0, millisecond: 0 })
    .toJSDate();
}

/**
 * Stripe's per-transaction limits for MXN, as documented -- **to verify
 * against the real account** (spec §5.4, §13). MXN 10.00 minimum for every
 * method; OXXO caps a voucher at MXN 10,000.00.
 */
export const STRIPE_LIMITS: Record<PaymentIntentMethod, ProviderLimits> = {
  CARD: { minCents: 1_000, maxCents: null },
  OXXO: { minCents: 1_000, maxCents: 1_000_000 },
  SPEI: { minCents: 1_000, maxCents: null },
};

// en la clase:
  limitsFor(method: PaymentIntentMethod): ProviderLimits {
    return STRIPE_LIMITS[method];
  }
```

  `FakePaymentProvider` usa `STRIPE_LIMITS` salvo lo que el constructor reciba en `limits`, para que
  una prueba de dominio pueda forzar un máximo pequeño. `createIntent` de los dos rechaza un monto fuera
  de los límites con `fail('PAYMENT_METHOD_UNAVAILABLE', { method, reason: 'ABOVE_PROVIDER_LIMIT' })`
  (red de seguridad; el dominio lo comprueba antes). La ventana corta de OXXO deja de ser
  `VALIDATION_FAILED`: pasa a `fail('PAYMENT_METHOD_UNAVAILABLE', { method: 'OXXO', reason:
  'WINDOW_TOO_SHORT' })`. Actualiza la prueba vigente que espera `VALIDATION_FAILED` («surfaces the
  real Stripe adapter...» en `payment-intent-service.spec.ts`): es el cambio buscado por §4.3.

- [ ] **Paso 4: verlo pasar.** `NX_DAEMON=false npx pnpm nx test payments-stripe` y
  `NX_DAEMON=false npx pnpm nx test payments -- payment-intent-service` → PASS.
- [ ] **Paso 5: docs + commit.** README: «OXXO sobre una reserva `ACTIVE`» y «Límites por método (a
  verificar)». Commit `feat(payments-stripe): provider limits and OXXO vouchers without a hold`.

**Charlie:** el ida y vuelta de días con horas al borde de la medianoche de CDMX; el contrato
compartido pasa para `FakePaymentProvider` y `StripePaymentProvider` (cuerpos grabados, sin red).

---

### Tarea A5: crear un intento con `AMOUNT`, y las opciones de pago (compleja · Echo)

**Archivos:**
- Crear: `libs/domain/payments/src/lib/charge-amount.ts` + `charge-amount.spec.ts`
- Crear: `libs/domain/payments/src/lib/payment-options.ts` + `payment-options.spec.ts`
- Modificar: `libs/domain/payments/src/lib/payment-intent-service.ts` (+ su spec)
- Modificar: `libs/domain/payments/src/index.ts`
- Modificar: `apps/api/src/app/api/v1/reservations/[reservationId]/payment-intents/route.ts` (+ su
  spec de integración)
- Modificar: `apps/api/src/lib/http/reservation-response.ts`
- Modificar: `libs/contracts/src/lib/reservations.ts` (quitar el `.optional()` que dejó A3)
- Docs: `payments.md` — «Crear un Payment Intent» (reescrita: «el cliente propone, el servidor
  dispone»), «Abono libre» (nueva), «La ficha de OXXO nunca sobrevive al apartado» (añadir `ACTIVE`),
  «Umbral del anticipo» (`DEPOSIT_BELOW_MINIMUM`), «Errores». `payment-flow.md` — «El recorrido
  completo» (nota del monto) y «Tres métodos, tres tiempos» (`AMOUNT`, OXXO en `ACTIVE`).
  `docs/decisiones-fase-2a.md`: la decisión 1 queda reemplazada por §2 del spec.

**Interfaces:**
- Consume: `readPaymentSettings` (A2), `PaymentProvider.limitsFor`, `oxxoDeadlineAfterDays`,
  `oxxoExpiresAfterDays` (A4), los códigos de A1, `createPaymentIntentRequestSchema` (A3).
- Produce:

```ts
// charge-amount.ts
export type ChargeRequest = { intent: 'FULL' } | { intent: 'DEPOSIT' } | { intent: 'AMOUNT'; amountCents: number };
export interface ChargeableReservation {
  status: ReservationStatus;
  totalPriceCents: number;
  paidCents: number;
  minimumDepositCents: number;
}
export function balanceOf(reservation: ChargeableReservation): number;
export function depositOwedCents(reservation: ChargeableReservation): number;
export function minimumChargeCents(reservation: ChargeableReservation, settings: Pick<PaymentSettings, 'minInstallmentCents'>): number;
export function chargeAmount(
  reservation: ChargeableReservation,
  request: ChargeRequest,
  settings: Pick<PaymentSettings, 'minInstallmentCents'>
): Result<number>;
// payment-options.ts
export interface PaymentOptionsDto { minAmountCents: number; maxAmountCents: number; depositOwedCents: number; methods: { method: PaymentIntentMethod; available: boolean; reason?: PaymentOptionReason }[] }
export async function paymentOptionsForReservation(db: Db, provider: PaymentProvider, reservationId: string, now?: Date): Promise<Result<PaymentOptionsDto>>;
// payment-intent-service.ts
export interface CreatePaymentIntentInput { reservationId: string; customerId: string; request: ChargeRequest; method: PaymentIntentMethod; now?: Date }
```

- [ ] **Paso 1: prueba de la regla pura (tabla), que falla.**

```ts
// charge-amount.spec.ts
import { describe, expect, it } from 'vitest';
import { chargeAmount, minimumChargeCents } from './charge-amount';

const settings = { minInstallmentCents: 30_000 };
const held = { status: 'HELD' as const, totalPriceCents: 500_000, minimumDepositCents: 100_000, paidCents: 0 };
const active = { status: 'ACTIVE' as const, totalPriceCents: 500_000, minimumDepositCents: 100_000, paidCents: 200_000 };

describe('chargeAmount', () => {
  it('keeps FULL as the balance and DEPOSIT as what is left of the deposit', () => {
    expect(chargeAmount(held, { intent: 'FULL' }, settings)).toEqual({ ok: true, value: 500_000 });
    expect(chargeAmount({ ...held, paidCents: 40_000 }, { intent: 'DEPOSIT' }, settings)).toEqual({ ok: true, value: 60_000 });
  });

  it.each([
    // [reservation, amount, expected]
    ['ACTIVE, at the minimum', active, 30_000, { ok: true, value: 30_000 }],
    ['ACTIVE, below the minimum', active, 29_999, { ok: false, error: { code: 'PAYMENT_BELOW_MINIMUM', details: { minAmountCents: 30_000 } } }],
    ['ACTIVE, the whole balance', active, 300_000, { ok: true, value: 300_000 }],
    ['ACTIVE, above the balance', active, 300_001, { ok: false, error: { code: 'PAYMENT_EXCEEDS_BALANCE', details: { balanceCents: 300_000 } } }],
    ['HELD, exactly what is left of the deposit', held, 100_000, { ok: true, value: 100_000 }],
    ['HELD, below what is left of the deposit (D2)', held, 99_999, { ok: false, error: { code: 'DEPOSIT_BELOW_MINIMUM', details: { depositOwedCents: 100_000 } } }],
  ] as const)('%s', (_label, reservation, amountCents, expected) => {
    expect(chargeAmount(reservation, { intent: 'AMOUNT', amountCents }, settings)).toEqual(expected);
  });

  // Review focus 1: owing less than the minimum makes the minimum what is owed.
  it('takes a balance smaller than the minimum as the minimum, and nothing below it', () => {
    const almostPaid = { ...active, paidCents: 480_000 }; // owes $200.00
    expect(minimumChargeCents(almostPaid, settings)).toBe(20_000);
    expect(chargeAmount(almostPaid, { intent: 'AMOUNT', amountCents: 20_000 }, settings)).toEqual({ ok: true, value: 20_000 });
    expect(chargeAmount(almostPaid, { intent: 'AMOUNT', amountCents: 19_999 }, settings).ok).toBe(false);
  });

  it('answers NOTHING_DUE before any amount check once nothing is owed', () => {
    const paid = { ...active, paidCents: 500_000 };
    for (const request of [{ intent: 'FULL' }, { intent: 'DEPOSIT' }, { intent: 'AMOUNT', amountCents: 30_000 }] as const) {
      expect(chargeAmount(paid, request, settings)).toEqual({ ok: false, error: { code: 'NOTHING_DUE' } });
    }
  });

  it('answers NOTHING_DUE for DEPOSIT on an ACTIVE reservation, whose deposit is covered', () => {
    expect(chargeAmount(active, { intent: 'DEPOSIT' }, settings)).toEqual({ ok: false, error: { code: 'NOTHING_DUE' } });
  });

  it('refuses a non-integer or non-positive amount even if Zod was skipped', () => {
    expect(chargeAmount(active, { intent: 'AMOUNT', amountCents: 300.5 }, settings).ok).toBe(false);
    expect(chargeAmount(active, { intent: 'AMOUNT', amountCents: 0 }, settings).ok).toBe(false);
  });
});
```

  Ajusta la forma de `fail()` en las expectativas a la que usa `@rm/shared-utils` (si `fail(code)` sin
  detalles omite `details`, quítalo de la expectativa de `NOTHING_DUE`).

- [ ] **Paso 2: verlo fallar.** `NX_DAEMON=false npx pnpm nx test payments -- charge-amount` → FAIL.
- [ ] **Paso 3: implementar la regla.**

```ts
// charge-amount.ts
import type { ReservationStatus } from '@rm/db';
import { fail, ok, type Result } from '@rm/shared-utils';
import type { PaymentSettings } from './payment-settings';

export type ChargeRequest = { intent: 'FULL' } | { intent: 'DEPOSIT' } | { intent: 'AMOUNT'; amountCents: number };

export interface ChargeableReservation {
  status: ReservationStatus;
  totalPriceCents: number;
  paidCents: number;
  minimumDepositCents: number;
}

/** What is still owed. Pending payments do not count (payments.md, «Un pago pendiente no reduce el saldo»). */
export function balanceOf(reservation: ChargeableReservation): number {
  return Math.max(0, reservation.totalPriceCents - reservation.paidCents);
}

export function depositOwedCents(reservation: ChargeableReservation): number {
  if (reservation.status !== 'HELD') return 0;
  return Math.min(balanceOf(reservation), Math.max(0, reservation.minimumDepositCents - reservation.paidCents));
}

/** Never above the balance: owing less than the minimum makes the minimum what is owed (spec §5.1, step 4). */
export function minimumChargeCents(
  reservation: ChargeableReservation,
  settings: Pick<PaymentSettings, 'minInstallmentCents'>
): number {
  const balance = balanceOf(reservation);
  return reservation.status === 'HELD' ? depositOwedCents(reservation) : Math.min(settings.minInstallmentCents, balance);
}

/**
 * How many cents to charge for a request, or why not (abono libre spec §5.1):
 * the client proposes, this decides. FULL and DEPOSIT become AMOUNT with the
 * balance or what is left of the deposit, so there is one rule, not three.
 * Ownership, status and provider limits are the caller's.
 */
export function chargeAmount(
  reservation: ChargeableReservation,
  request: ChargeRequest,
  settings: Pick<PaymentSettings, 'minInstallmentCents'>
): Result<number> {
  const balance = balanceOf(reservation);
  if (balance === 0) return fail('NOTHING_DUE');
  if (request.intent === 'FULL') return ok(balance);
  if (request.intent === 'DEPOSIT') {
    const owed = depositOwedCents(reservation);
    return owed > 0 ? ok(owed) : fail('NOTHING_DUE');
  }
  const amount = request.amountCents;
  if (!Number.isInteger(amount) || amount <= 0) return fail('VALIDATION_FAILED', { field: 'amountCents' });
  if (amount > balance) return fail('PAYMENT_EXCEEDS_BALANCE', { balanceCents: balance });
  const minimum = minimumChargeCents(reservation, settings);
  if (amount < minimum) {
    return reservation.status === 'HELD'
      ? fail('DEPOSIT_BELOW_MINIMUM', { depositOwedCents: minimum })
      : fail('PAYMENT_BELOW_MINIMUM', { minAmountCents: minimum });
  }
  return ok(amount);
}
```

  Quita de `payment-intent-service.ts` su `balanceOf` y `amountForIntent` privados y usa estos.

- [ ] **Paso 4: verlo pasar.** Mismo comando → PASS.
- [ ] **Paso 5: prueba del servicio (integración), que falla.** En `payment-intent-service.spec.ts`,
  con su `seedReservation` local y `FakePaymentProvider`:

```ts
it('creates an OXXO voucher on an ACTIVE reservation that lasts the configured days', async () => {
  const now = new Date('2026-10-08T18:00:00Z');
  const reservation = await seedReservation(db, { status: 'ACTIVE', paidCents: 200_000 });
  const created = await createPaymentIntentForReservation(db, new FakePaymentProvider(), {
    reservationId: reservation.id,
    customerId: reservation.customerId,
    request: { intent: 'AMOUNT', amountCents: 50_000 },
    method: 'OXXO',
    now,
  });
  expect(created.ok && created.value.amountCents).toBe(50_000);
  expect(created.ok && created.value.voucherExpiresAt).toEqual(oxxoDeadlineAfterDays(3, now));
  const row = await db.payment.findFirstOrThrow({ where: { reservationId: reservation.id } });
  expect(row).toMatchObject({ status: 'PENDING', amountCents: 50_000, method: 'OXXO' });
});

it('refuses OXXO on a hold with less than a whole Stripe day left, with a translatable code', async () => {
  const reservation = await seedReservation(db, { holdExpiresAt: new Date(Date.now() + 60 * 60 * 1000) });
  const created = await createPaymentIntentForReservation(db, new FakePaymentProvider(), {
    reservationId: reservation.id, customerId: reservation.customerId, request: { intent: 'DEPOSIT' }, method: 'OXXO',
  });
  expect(created).toEqual({ ok: false, error: { code: 'PAYMENT_METHOD_UNAVAILABLE', details: { method: 'OXXO', reason: 'WINDOW_TOO_SHORT' } } });
  expect(await db.payment.count()).toBe(0);
});

it('refuses an OXXO payment above the voucher limit before calling the provider (D10)', async () => {
  const provider = new FakePaymentProvider(undefined, { OXXO: { minCents: 1_000, maxCents: 100_000 } });
  const reservation = await seedReservation(db, { status: 'ACTIVE', paidCents: 100_000 });
  const created = await createPaymentIntentForReservation(db, provider, {
    reservationId: reservation.id, customerId: reservation.customerId,
    request: { intent: 'AMOUNT', amountCents: 150_000 }, method: 'OXXO',
  });
  expect(created).toEqual({ ok: false, error: { code: 'PAYMENT_METHOD_UNAVAILABLE', details: { method: 'OXXO', reason: 'ABOVE_PROVIDER_LIMIT' } } });
});

it('refuses SPEI while payments.spei_enabled is off (D6)', async () => {
  const reservation = await seedReservation(db, { status: 'ACTIVE', paidCents: 100_000 });
  const created = await createPaymentIntentForReservation(db, new FakePaymentProvider(), {
    reservationId: reservation.id, customerId: reservation.customerId,
    request: { intent: 'AMOUNT', amountCents: 50_000 }, method: 'SPEI',
  });
  expect(created).toEqual({ ok: false, error: { code: 'PAYMENT_METHOD_UNAVAILABLE', details: { method: 'SPEI', reason: 'DISABLED' } } });
});
```

  Más: las pruebas vigentes (`RESERVATION_NOT_OWNED`, `INVALID_STATUS_TRANSITION`, `FULL`, `DEPOSIT`)
  cambian sólo de `intent: 'FULL'` a `request: { intent: 'FULL' }`, y la de `nothing_due` pasa a
  esperar `NOTHING_DUE`.

- [ ] **Paso 6: verlo fallar.** `NX_DAEMON=false npx pnpm nx test payments -- payment-intent-service`.
- [ ] **Paso 7: implementar el servicio.** Orden de comprobaciones, el del spec §5.1, sin bloqueo
  (crear un intento no mueve dinero):

```ts
// payment-intent-service.ts (forma final de createPaymentIntentForReservation)
export async function createPaymentIntentForReservation(
  db: Db,
  provider: PaymentProvider,
  input: CreatePaymentIntentInput
): Promise<Result<CreatedPaymentIntentDto>> {
  const now = input.now ?? new Date();
  const reservation = await db.reservation.findUnique({ where: { id: input.reservationId } });
  if (!reservation || reservation.customerId !== input.customerId) return fail('RESERVATION_NOT_OWNED');
  if (!LIVE_STATUSES.includes(reservation.status)) return fail('INVALID_STATUS_TRANSITION', { status: reservation.status });

  const settings = await readPaymentSettings(db);
  const amount = chargeAmount(reservation, input.request, settings);
  if (!amount.ok) return amount;

  const method = methodAvailability(reservation, input.method, amount.value, provider, settings, now);
  if (!method.available) return fail('PAYMENT_METHOD_UNAVAILABLE', { method: input.method, reason: method.reason });

  const customer = await db.user.findUniqueOrThrow({ where: { id: input.customerId }, select: { email: true } });
  const created = await provider.createIntent({
    reservationId: reservation.id,
    amountCents: amount.value,
    method: input.method,
    customerEmail: customer.email,
    voucherExpiresAt: input.method === 'OXXO' ? method.voucherExpiresAt : undefined,
  });
  if (!created.ok) return created;
  // ... recordPayment PENDING, igual que hoy, con amount.value
}
```

```ts
// payment-options.ts: la misma decisión de disponibilidad, compartida con el POST
export type PaymentOptionReason = 'NOT_CONFIGURED' | 'WINDOW_TOO_SHORT' | 'ABOVE_PROVIDER_LIMIT' | 'DISABLED';
export type MethodAvailability =
  | { available: true; voucherExpiresAt?: Date }
  | { available: false; reason: PaymentOptionReason };

/**
 * Whether `method` can take `amountCents` on this reservation right now. One
 * function for the POST and for `paymentOptions`, so the screen never offers
 * what the POST refuses.
 */
export function methodAvailability(
  reservation: Pick<Reservation, 'status' | 'holdExpiresAt'>,
  method: PaymentIntentMethod,
  amountCents: number,
  provider: PaymentProvider,
  settings: PaymentSettings,
  now: Date
): MethodAvailability {
  if (method === 'SPEI' && !settings.speiEnabled) return { available: false, reason: 'DISABLED' };
  const limits = provider.limitsFor(method);
  if (amountCents < limits.minCents || (limits.maxCents !== null && amountCents > limits.maxCents)) {
    return { available: false, reason: 'ABOVE_PROVIDER_LIMIT' };
  }
  if (method !== 'OXXO') return { available: true };
  if (reservation.status === 'HELD') {
    const hold = reservation.holdExpiresAt;
    if (!hold || oxxoExpiresAfterDays(hold, now) === undefined) return { available: false, reason: 'WINDOW_TOO_SHORT' };
    return { available: true, voucherExpiresAt: hold };
  }
  // ACTIVE: its own validity (D3), never bounded by the payment deadline (D4).
  return { available: true, voucherExpiresAt: oxxoDeadlineAfterDays(settings.oxxoActiveVoucherDays, now) };
}
```

  `paymentOptionsForReservation(db, provider, reservationId, now)`: lee la reserva; para `EXPIRED` o
  `CANCELLED` devuelve `minAmountCents = maxAmountCents = depositOwedCents = 0` y los tres métodos
  `available: false` sin `reason`; si no, `min = minimumChargeCents`, `max = balanceOf`,
  `depositOwedCents`, y por método `methodAvailability(…, min, …)` (si ni el mínimo cabe en el método,
  no está disponible). Con saldo 0, los tres `available: false`.

  Ruta: pasa `request: body` (la unión ya validada) y `method: body.method`. Actualiza el comentario
  «No amount travels in the request body».

  `reservation-response.ts`: `paymentOptions` junto a `suggestedMonthlyCents`, con
  `paymentProvider()`.

- [ ] **Paso 8: verlo pasar.** `NX_DAEMON=false npx pnpm nx test payments -- payment-intent-service
  charge-amount payment-options` y `NX_DAEMON=false npx pnpm nx test api -- payment-intents
  reservations` → PASS.
- [ ] **Paso 9: docs + commit.** Las secciones listadas arriba, en el mismo commit.
  `feat(payments): free-amount payments with a minimum, and OXXO without a hold`.

**Charlie (con el proveedor falso y la API real):**
- Cada código de §4.3 desde `POST /payment-intents` con su HTTP y `details`.
- `GET /reservations/{id}` trae `paymentOptions` y lo que dice coincide con lo que el POST acepta
  (probar el mínimo exacto, un centavo menos y el máximo).
- Concurrencia 9 del spec: crear un intento validado contra un saldo que una confirmación simultánea
  reduce → el exceso cae en el `OVERPAYMENT` ya existente; `paid_cents ≤ total`.
- Concurrencia 1 del spec (dos `succeeded` de intentos distintos que juntos exceden el saldo, 30
  veces): aplica exactamente el saldo y acredita el resto una vez. Ya pasaba en `main`; se vuelve a
  correr porque `AMOUNT` lo hace frecuente.

---

### Tarea A6: la mensualidad sugerida nunca es menor que el mínimo (simple · Bravo)

**Archivos:**
- Modificar: `libs/domain/payments/src/lib/instalment.ts` + `instalment.spec.ts`
- Modificar: `libs/domain/payments/src/lib/payment-service.ts` (sólo `suggestedMonthlyForReservation`)
- Docs: `payments.md` — «Mensualidad sugerida» (el tope inferior). `payment-flow.md` no cambia;
  dilo en el commit.

**Interfaces:**
- Consume: `readPaymentSettings` (A2).
- Produce: `suggestedMonthly(balanceCents: Cents, monthsRemaining: number, minimumCents?: Cents): Cents`
  (el tercer parámetro es opcional y vale 0, para no romper a quien ya la llama).

- [ ] **Paso 1: prueba que falla.**

```ts
// instalment.spec.ts
it('never suggests less than the minimum the API accepts', () => {
  // $3,000 over 12 months would be $250, below the $300 minimum.
  expect(suggestedMonthly(300_000, 12, 30_000)).toBe(30_000);
});

it('suggests the whole balance when it is below the minimum', () => {
  expect(suggestedMonthly(20_000, 12, 30_000)).toBe(20_000);
});

it('keeps the plain formula when it is already above the minimum', () => {
  expect(suggestedMonthly(1_200_000, 4, 30_000)).toBe(300_000);
});
```

- [ ] **Paso 2: verlo fallar.** `NX_DAEMON=false npx pnpm nx test payments -- instalment` → FAIL.
- [ ] **Paso 3: implementar.**

```ts
export function suggestedMonthly(balanceCents: Cents, monthsRemaining: number, minimumCents: Cents = 0): Cents {
  if (balanceCents <= 0) return 0;
  const months = Math.max(monthsRemaining, 1);
  return Math.min(balanceCents, Math.max(roundUpToPeso(balanceCents / months), minimumCents));
}
```

  En `suggestedMonthlyForReservation`, pasar `minimumChargeCents(reservation, await
  readPaymentSettings(db))` (de A5 si ya está; si A6 llega antes, usa
  `settings.minInstallmentCents` directo: el `Math.min(balance)` de la fórmula ya hace el resto).
  Actualiza el doc comment («Purely motivational…»): ahora el mínimo sí existe.
- [ ] **Paso 4: verlo pasar.** Mismo comando → PASS.
- [ ] **Paso 5: commit.** `feat(payments): the suggested instalment respects the minimum`.

**Charlie:** una reserva `ACTIVE` con saldo $3,000 y 12 meses sugiere $300, y el POST con `AMOUNT`
$300 la acepta.

---

### Tarea A7: el recibo dice cuánto del pago quedó como saldo a favor (simple · Bravo)

**Archivos:**
- Modificar: `libs/receipts/src/lib/receipt-renderer.ts` (`ReceiptData.creditedCents`)
- Modificar: `libs/receipts/src/lib/pdf-lib-receipt-renderer.ts` (+ spec), `fake-receipt-renderer.ts`
- Modificar: `libs/domain/payments/src/lib/receipt-service.ts` (`loadReceipt`) + `receipt-service.spec.ts`
- Docs: `payments.md` — «Recibos en PDF» (la línea nueva). `payment-flow.md` no cambia.

**Interfaces:**
- Produce: `ReceiptData.creditedCents: number` (0 cuando no hubo excedente).

- [ ] **Paso 1: prueba que falla.**

```ts
// receipt-service.spec.ts
it('carries the part of the payment that became credit (spec §7.2)', async () => {
  // seed: ACTIVE reservation owing 50_000, a SUCCEEDED payment of 80_000 with
  // receiptNumber, and its OVERPAYMENT entry of 30_000 with paymentId.
  const loaded = await loadReceipt(db, payment.id);
  expect(loaded.ok && loaded.value.data.creditedCents).toBe(30_000);
  expect(loaded.ok && loaded.value.data.amountCents).toBe(80_000);
});

it('says 0 for a payment that fit', async () => {
  const loaded = await loadReceipt(db, plainPayment.id);
  expect(loaded.ok && loaded.value.data.creditedCents).toBe(0);
});
```

```ts
// pdf-lib-receipt-renderer.spec.ts
it('prints the credited line only when there is one, in the receipt language', async () => {
  const withCredit = await textOf(await renderer.render({ ...baseData, locale: 'es', creditedCents: 30_000 }));
  expect(withCredit).toContain('De este pago, $300.00 MXN quedó como saldo a favor');
  const without = await textOf(await renderer.render({ ...baseData, locale: 'es', creditedCents: 0 }));
  expect(without).not.toContain('saldo a favor');
  const english = await textOf(await renderer.render({ ...baseData, locale: 'en', creditedCents: 30_000 }));
  expect(english).toContain('$300.00 MXN of this payment became account credit');
});
```

  Usa el extractor de texto que ya usa esa spec (`textOf` o el que exista); si no hay ninguno, compara
  el número de operadores de texto y deja la verificación de la frase a Charlie en el PDF real.
- [ ] **Paso 2: verlo fallar.** `NX_DAEMON=false npx pnpm nx test receipts` y
  `NX_DAEMON=false npx pnpm nx test payments -- receipt-service` → FAIL.
- [ ] **Paso 3: implementar.** `loadReceipt` lee
  `tx.customerCreditEntry.findFirst({ where: { paymentId, kind: 'OVERPAYMENT' }, select: { amountCents: true } })`
  y pone `creditedCents: entry?.amountCents ?? 0`. El renderer añade una línea bajo el monto, sólo si
  `creditedCents > 0`, con `formatMoney(creditedCents, locale)`.
- [ ] **Paso 4: verlo pasar.** Mismos comandos → PASS.
- [ ] **Paso 5: commit.** `feat(receipts): the receipt names the part that became credit`.

**Charlie:** descargar el PDF de un pago con excedente (es y en) y de uno sin excedente; un PDF ya
generado antes del cambio no se regenera (`ensureReceiptPdf` sin cambios).

---

### Tarea A8: un intento de tarjeta abierto por reserva (compleja · Echo)

**Archivos:**
- Modificar: `libs/domain/payments/src/lib/payment-intent-cancellation.ts`
- Modificar: `libs/domain/payments/src/lib/payment-intent-service.ts` (llamarla después del commit)
- Prueba: `payment-intent-service.spec.ts`
- Docs: `payments.md` — «Tarjeta: un intento abierto por reserva» (nueva). `payment-flow.md` —
  «Tres métodos, tres tiempos», una línea.

**Interfaces:**
- Produce:

```ts
/** Cancels at the provider the CARD intents of a reservation still PENDING and recorded before `before` (best effort). */
export async function cancelOlderCardIntents(
  client: Db | DbTransactionClient,
  provider: PaymentProvider,
  input: { reservationId: string; before: Date; keepPaymentId: string }
): Promise<void>;
```

- [ ] **Paso 1: pruebas que fallan.**

```ts
it('cancels the older open card intent of the same reservation, not OXXO, not itself', async () => {
  const provider = new FakePaymentProvider();
  const reservation = await seedReservation(db, { status: 'ACTIVE', paidCents: 100_000 });
  const ask = (method: 'CARD' | 'OXXO') => createPaymentIntentForReservation(db, provider, {
    reservationId: reservation.id, customerId: reservation.customerId,
    request: { intent: 'AMOUNT', amountCents: 30_000 }, method,
  });
  const firstCard = await ask('CARD');
  const voucher = await ask('OXXO');
  const secondCard = await ask('CARD');

  expect(provider.cancelledIntentIds()).toEqual([firstCard.ok && firstCard.value.providerIntentId]);
  expect(provider.cancelledIntentIds()).not.toContain(voucher.ok && voucher.value.providerIntentId);
  expect(provider.cancelledIntentIds()).not.toContain(secondCard.ok && secondCard.value.providerIntentId);
});

// Review focus 3: two card intents created at once never cancel each other.
it('leaves at least one card intent open when two are created at the same time', async () => {
  for (let round = 0; round < 30; round += 1) {
    const provider = new FakePaymentProvider();
    const reservation = await seedReservation(db, { status: 'ACTIVE', paidCents: 100_000 });
    const ask = () => createPaymentIntentForReservation(db, provider, {
      reservationId: reservation.id, customerId: reservation.customerId,
      request: { intent: 'AMOUNT', amountCents: 30_000 }, method: 'CARD',
    });
    const [a, b] = await Promise.all([ask(), ask()]);
    const ids = [a, b].map((r) => r.ok && r.value.providerIntentId);
    expect(ids.filter((id) => !provider.cancelledIntentIds().includes(id as string)).length).toBeGreaterThanOrEqual(1);
  }
});
```

  Si `FakePaymentProvider` no registra las cancelaciones, añade `cancelledIntentIds(): string[]` en
  A4 o aquí (método de prueba de la clase falsa, no del puerto).
- [ ] **Paso 2: verlo fallar.** `NX_DAEMON=false npx pnpm nx test payments -- payment-intent-service`.
- [ ] **Paso 3: implementar.** Después del `recordPayment` (fuera de la transacción), si el método es
  `CARD`: `cancelOlderCardIntents(db, provider, { reservationId, before: recorded.recordedAt,
  keepPaymentId: recorded.id })`, que busca `method: 'CARD', status: 'PENDING', providerIntentId: not
  null, recordedAt: { lt: before }, id: { not: keepPaymentId }` y cancela cada uno, registrando un
  fallo sin propagarlo (mismo estilo que `createCancelPendingPaymentIntents`). **No** cambia el estado
  de la fila: lo cierra el `payment_intent.canceled` del webhook (`closePendingPayment`), o el job de
  A9 si nunca llega. Con `recordedAt` estrictamente menor, dos intentos del mismo milisegundo no se
  cancelan entre sí; el job de A9 recoge al que quede.
- [ ] **Paso 4: verlo pasar.** Mismo comando → PASS.
- [ ] **Paso 5: commit.** `feat(payments): one open card intent per reservation`.

**Charlie:** con Stripe de prueba, abrir dos intentos de tarjeta seguidos: el primero queda
`canceled` en Stripe y `EXPIRED` en la app tras el webhook. Si el primero ya cobró, Stripe rechaza la
cancelación, el webhook lo registra y el excedente es `OVERPAYMENT` (no se pierde dinero).

---

### Tarea A9: el job de intentos vencidos, parte de tarjeta (compleja · Echo)

**Archivos:**
- Crear: `apps/worker/src/jobs/expire-stale-payment-intents.ts` + `.spec.ts`
- Modificar: `libs/jobs/src/lib/job-names.ts` (`EXPIRE_STALE_PAYMENT_INTENTS_JOB`, en `JOB_NAMES`)
- Modificar: `apps/worker/src/main.ts` (agenda cada hora)
- Docs: `payments.md` — «Intentos vencidos sin apartado» (nueva). `payment-flow.md` — una línea en
  «Tres métodos, tres tiempos». Actualiza el párrafo de `apps/worker` en `CLAUDE.md`, que enumera los
  jobs (el job nuevo debe aparecer).

**Interfaces:**
- Consume: `readPaymentSettings` (A2), `PaymentProvider.cancelIntent`.
- Produce:

```ts
export async function expireStalePaymentIntents(
  db: Db,
  provider: PaymentProvider,
  queue: NotificationQueue,
  now?: Date
): Promise<{ expired: number }>;
```

- [ ] **Paso 1: pruebas que fallan.**

```ts
describe('expireStalePaymentIntents', () => {
  it('closes a card intent older than the stale window and cancels it at the provider', async () => {
    const now = new Date('2026-10-08T12:00:00Z');
    const stale = await seedPendingPayment(db, { method: 'CARD', recordedAt: new Date(now.getTime() - 25 * HOUR) });
    const fresh = await seedPendingPayment(db, { method: 'CARD', recordedAt: new Date(now.getTime() - 23 * HOUR) });
    const voucher = await seedPendingPayment(db, { method: 'OXXO', recordedAt: new Date(now.getTime() - 72 * HOUR) });
    const provider = new FakePaymentProvider();

    expect(await expireStalePaymentIntents(db, provider, queue, now)).toEqual({ expired: 1 });
    expect((await db.payment.findUniqueOrThrow({ where: { id: stale.id } })).status).toBe('EXPIRED');
    expect((await db.payment.findUniqueOrThrow({ where: { id: fresh.id } })).status).toBe('PENDING');
    // OXXO expires at Stripe on its own; the webhook already handles it.
    expect((await db.payment.findUniqueOrThrow({ where: { id: voucher.id } })).status).toBe('PENDING');
    expect(provider.cancelledIntentIds()).toEqual([stale.providerIntentId]);
  });

  it('is idempotent: a second run changes nothing and cancels nothing again', async () => {
    // same seed, two runs → { expired: 1 } then { expired: 0 }, one cancellation in total
  });

  it('tells nobody about an abandoned card intent', async () => {
    // after a run, notification_deliveries is empty
  });

  it('leaves a payment the webhook settled in the same instant alone', async () => {
    // seed stale CARD; flip it to SUCCEEDED between the candidate query and the update
    // (pausing client, as in webhook-handler.spec.ts's clientPausingAt) → stays SUCCEEDED, not cancelled
  });
});
```

  Copia `seedPendingPayment` del estilo de `expire-holds.spec.ts` (reserva + `Payment` `PENDING` con
  `providerIntentId` único y `recordedAt` dado).
- [ ] **Paso 2: verlo fallar.** `NX_DAEMON=false npx pnpm nx test worker -- expire-stale-payment-intents`.
- [ ] **Paso 3: implementar.** Candidatos: `status: 'PENDING', method: 'CARD', providerIntentId: not
  null, recordedAt < now − cardIntentStaleHours, reservation.status in ['HELD','ACTIVE']`. Por cada
  uno, su transacción con `updateMany({ where: { id, status: 'PENDING' }, data: { status: 'EXPIRED' }
  })`; sólo si `count === 1`, después del commit, `provider.cancelIntent` (mejor esfuerzo, error
  registrado). La parte SPEI la añade B2. `main.ts`: `createQueue`, `schedule(..., '15 * * * *')`,
  `work(...)` como `WARN_EXPIRING_HOLDS_JOB`.
- [ ] **Paso 4: verlo pasar.** Mismo comando → PASS.
- [ ] **Paso 5: commit.** `feat(worker): expire abandoned card intents`.

**Charlie:** concurrencia 8 del spec (webhook contra este job, 30 veces): o `SUCCEEDED` y el job no
hace nada, o `EXPIRED` y el `succeeded` tardío abre un caso `WRITTEN_OFF` (con L2) — nunca dinero
aplicado sobre una fila `EXPIRED`.

---

# Parte L — Dinero tardío: `LatePaymentCase`

### Tarea L1: el modelo del caso (compleja · Echo)

**Archivos:**
- Modificar: `libs/db/prisma/schema.prisma`
- Crear: `libs/db/prisma/migrations/<timestamp>_late_payment_cases/migration.sql`
- Prueba: `libs/db/src/schema.spec.ts` (o el spec de esquema que ya compruebe índices parciales)
- Docs: `payments.md` — sección nueva «Dinero tardío: el caso de seguimiento» (modelo y estados).
  Este commit no toca `libs/domain`, pero el modelo es regla de negocio: se documenta ya.

**Interfaces:**
- Produce (Prisma):

```prisma
enum LatePaymentKind {
  /// Confirmed after the hold expired. `pendingCents` is the part that fit
  /// and waits for a person; the excess already became OVERPAYMENT.
  AFTER_EXPIRY
  /// Confirmed after staff cancelled: every cent is already credit. Ack only.
  AFTER_CANCELLATION
  /// Stripe charged an intent we had already closed (EXPIRED/FAILED). The
  /// money is not in our books.
  WRITTEN_OFF
  /// Money with no reservation to attach it to. Not in our books.
  UNMATCHED
}

enum LatePaymentResolution {
  REVIVED
  KEPT_AS_CREDIT
  REFUNDED
  ACKNOWLEDGED
}

/// One per provider intent (owner decision 2026-10-08): the Mostrador's
/// record of late money until a person decides. Replaces ORPHAN_PAYMENT.
model LatePaymentCase {
  id               String                 @id @default(uuid()) @db.Uuid
  providerIntentId String                 @unique @map("provider_intent_id")
  paymentId        String?                @unique @map("payment_id") @db.Uuid
  reservationId    String?                @map("reservation_id") @db.Uuid
  kind             LatePaymentKind
  amountCents      Int                    @map("amount_cents")
  pendingCents     Int                    @map("pending_cents")
  openedAt         DateTime               @default(now()) @map("opened_at") @db.Timestamptz
  resolvedAt       DateTime?              @map("resolved_at") @db.Timestamptz
  resolvedById     String?                @map("resolved_by") @db.Uuid
  resolution       LatePaymentResolution?
  note             String?

  payment     Payment?     @relation(fields: [paymentId], references: [id], onDelete: SetNull)
  reservation Reservation? @relation(fields: [reservationId], references: [id], onDelete: SetNull)
  resolvedBy  User?        @relation(fields: [resolvedById], references: [id], onDelete: SetNull)

  @@index([reservationId])
  @@map("late_payment_cases")
}
```

  Añade las relaciones inversas en `Payment`, `Reservation` y `User`.

```sql
-- migration.sql, al final de lo que genere Prisma
-- The queue reads open cases oldest first.
CREATE INDEX late_payment_cases_open_idx ON late_payment_cases (opened_at) WHERE resolved_at IS NULL;
-- A resolved case says how and by whom; an open one says neither.
ALTER TABLE late_payment_cases ADD CONSTRAINT late_payment_cases_resolution_complete
  CHECK ((resolved_at IS NULL) = (resolution IS NULL));
ALTER TABLE late_payment_cases ADD CONSTRAINT late_payment_cases_amounts
  CHECK (amount_cents > 0 AND pending_cents >= 0 AND pending_cents <= amount_cents);
-- A late payment kept as credit is credited once (decision P2).
CREATE UNIQUE INDEX customer_credit_entries_late_payment_key
  ON customer_credit_entries (payment_id) WHERE kind = 'EXPIRATION' AND payment_id IS NOT NULL;
```

- [ ] **Paso 1: prueba que falla.** En el spec de esquema: insertar dos casos con el mismo
  `provider_intent_id` falla con `P2002`; un caso con `resolved_at` y sin `resolution` falla por el
  `CHECK`; `pending_cents > amount_cents` falla; dos `EXPIRATION` con el mismo `payment_id` fallan y
  dos con `payment_id` nulo (los de `expireHolds`) no.
- [ ] **Paso 2: verlo fallar.** `NX_DAEMON=false npx pnpm nx test db -- schema`.
- [ ] **Paso 3: implementar.** `npx prisma migrate dev --create-only --name late_payment_cases`, añadir
  el SQL de arriba, `npx prisma generate`.
- [ ] **Paso 4: verlo pasar.** Mismo comando → PASS.
- [ ] **Paso 5: commit.** `feat(db): late payment cases`.

**Charlie:** la migración se aplica sobre una copia de `rm_dev` sin perder datos; `db:test:clean`
sigue funcionando.

---

### Tarea L2: el webhook abre un caso en vez de `ORPHAN_PAYMENT` (compleja · Echo)

**Archivos:**
- Crear: `libs/domain/payments/src/lib/late-payment-case.ts` (sólo `openLatePaymentCase` en esta
  tarea) + `late-payment-case.spec.ts`
- Modificar: `libs/domain/payments/src/lib/webhook-handler.ts` (+ `webhook-handler.spec.ts`)
- Modificar: `libs/domain/notifications/src/lib/templates.ts` (`LATE_PAYMENT_OPENED`, es y en) +
  `templates.spec.ts`
- Modificar: `libs/domain/notifications/src/lib/delivery-service.ts` (`ADMIN_ALERT_AUDIENCE`, ya en
  `main`)
- Docs: `payments.md` — «Dinero tardío: el caso de seguimiento» (cuándo se abre, por cuál de los
  cuatro caminos, unicidad), «Caso límite: pago confirmado de una reserva ya expirada» y «Sobrepago
  confirmado» (sustituir las menciones de `ORPHAN_PAYMENT`), «El webhook de Stripe». `payment-flow.md`
  — diagrama nuevo «Dinero tardío» (flowchart: `succeeded` → estado de la reserva → kind →
  `pendingCents` → aviso). `notifications.md` — `LATE_PAYMENT_OPENED`, y que `ORPHAN_PAYMENT` ya no se
  emite.

**Dependencia:** `feat/alerts-by-permission` (Delta), ya en `main` (9ca2f56).

**Interfaces:**
- Consume: el modelo de L1.
- Produce:

```ts
export interface OpenLatePaymentCaseInput {
  providerIntentId: string;
  kind: LatePaymentKind;
  amountCents: number;
  pendingCents: number;
  paymentId?: string;
  reservationId?: string;
}
/** Opens the case for this intent unless one exists. `true` only for the call that opened it. */
export async function openLatePaymentCase(tx: DbTransactionClient, input: OpenLatePaymentCaseInput): Promise<boolean>;
```

- [ ] **Paso 1: pruebas que fallan** (en `webhook-handler.spec.ts`, reemplazando las aserciones de
  `ORPHAN_PAYMENT`):

```ts
describe('late money opens one case per intent (owner decision 2026-10-08)', () => {
  it('opens AFTER_EXPIRY with the part that fit as pending', async () => {
    const reservation = await seedReservation(db, { status: 'EXPIRED', totalPriceCents: 500_000 });
    await seedPendingPayment(db, reservation.id, 'pi_late', 150_000);
    await handleStripeEvent(db, queue, event({ intent: { providerIntentId: 'pi_late' } }));

    const lateCase = await db.latePaymentCase.findUniqueOrThrow({ where: { providerIntentId: 'pi_late' } });
    expect(lateCase).toMatchObject({ kind: 'AFTER_EXPIRY', amountCents: 150_000, pendingCents: 150_000, reservationId: reservation.id, resolvedAt: null });
    expect(await noticesFor(staffId, 'ORPHAN_PAYMENT')).toBe(0);
  });

  it('opens AFTER_EXPIRY with nothing pending when all of it became credit', async () => {
    const reservation = await seedReservation(db, { status: 'EXPIRED', totalPriceCents: 500_000, paidCents: 500_000 });
    await seedPendingPayment(db, reservation.id, 'pi_all_excess', 100_000);
    await handleStripeEvent(db, queue, event({ intent: { providerIntentId: 'pi_all_excess' } }));
    expect(await db.latePaymentCase.findUniqueOrThrow({ where: { providerIntentId: 'pi_all_excess' } })).toMatchObject({ pendingCents: 0 });
  });

  it('opens AFTER_CANCELLATION with nothing pending', async () => {
    // CANCELLED reservation → kind AFTER_CANCELLATION, pendingCents 0
  });

  it('opens WRITTEN_OFF for money charged on an intent we had already closed', async () => {
    // payment row EXPIRED → INVALID_STATUS_TRANSITION path → kind WRITTEN_OFF, paymentId set, pendingCents = amount
  });

  it('opens UNMATCHED for money with no reservation', async () => {
    // intent without metadata → kind UNMATCHED, reservationId null, paymentId null
  });

  // Review focus 5, NB5: the NEEDS_A_HUMAN path had no settled payment to guard it.
  it('opens one case and sends one notice for two different events of the same written-off intent, even at once', async () => {
    for (let round = 0; round < 30; round += 1) {
      await resetDatabase(db);
      const reservation = await seedReservation(db, { status: 'ACTIVE' });
      await seedClosedPayment(db, reservation.id, `pi_dup_${round}`, 'EXPIRED');
      const deliver = (n: number) => handleStripeEvent(db, queue, event({ id: `evt_${round}_${n}`, intent: { providerIntentId: `pi_dup_${round}` } }));
      await Promise.all([deliver(1), deliver(2)]);
      expect(await db.latePaymentCase.count({ where: { providerIntentId: `pi_dup_${round}` } })).toBe(1);
      expect(await noticesFor(staffId, 'LATE_PAYMENT_OPENED')).toBe(2); // INBOX + EMAIL of one notice
    }
  });
});
```

  Si un caso de la regla vigente no necesita a una persona (`ORPHAN_PAYMENT` no salía), la prueba
  vigente que lo afirmaba se conserva cambiando sólo el nombre del aviso.
- [ ] **Paso 2: verlo fallar.** `NX_DAEMON=false npx pnpm nx test payments -- webhook-handler`.
- [ ] **Paso 3: implementar `openLatePaymentCase` y cablearla.**

```ts
// late-payment-case.ts
import { Prisma, type DbTransactionClient, type LatePaymentKind } from '@rm/db';

/**
 * Opens the late-money case for one provider intent, at most once: two
 * deliveries of the same intent (distinct `evt_` ids, even concurrent) meet
 * on the unique `provider_intent_id`, and `ON CONFLICT DO NOTHING` lets the
 * loser go on without aborting its transaction. Only the call that opened
 * the case should tell anyone.
 *
 * Lock order: every writer of a reservation's cases holds that reservation's
 * lock first (the webhook through `lockReservationForMoney`, revival and
 * resolution likewise), so this row never takes part in a cycle.
 */
export async function openLatePaymentCase(tx: DbTransactionClient, input: OpenLatePaymentCaseInput): Promise<boolean> {
  const inserted = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
    INSERT INTO late_payment_cases (id, provider_intent_id, payment_id, reservation_id, kind, amount_cents, pending_cents)
    VALUES (gen_random_uuid(), ${input.providerIntentId}, ${input.paymentId ?? null}::uuid, ${input.reservationId ?? null}::uuid,
            ${input.kind}::"LatePaymentKind", ${input.amountCents}, ${input.pendingCents})
    ON CONFLICT (provider_intent_id) DO NOTHING
    RETURNING id
  `);
  return inserted.length === 1;
}
```

  En `webhook-handler.ts`:
  - `applySucceeded`, rama `EXPIRED`: en lugar de `escalateOrphanPayment`, `openLatePaymentCase(tx, {
    providerIntentId, kind: 'AFTER_EXPIRY', amountCents: confirmed.value.amountCents, pendingCents:
    confirmed.value.amountCents - creditedCents, paymentId: confirmed.value.id, reservationId })`. El
    caso se abre **también** cuando todo fue excedente (antes no había alerta): sin aviso al personal
    si `pendingCents === 0` (P4).
  - Rama `CANCELLED`: `kind: 'AFTER_CANCELLATION', pendingCents: 0`, sin aviso al personal.
  - Camino `NEEDS_A_HUMAN`: `INVALID_STATUS_TRANSITION` → `WRITTEN_OFF` con el `paymentId` de la fila;
    `NOT_FOUND` y `PAYMENT_EXCEEDS_BALANCE` → `UNMATCHED`, con `reservationTheMoneyBelongsTo` como
    `reservationId`. `pendingCents = amountCents` (todo está fuera de los libros).
  - Borra `escalateOrphanPayment`.
- [ ] **Paso 4: aviso `LATE_PAYMENT_OPENED`.** Plantilla es/en («Llegó un pago de {{amount}} para
  {{reservationCode}} que necesita una decisión: {{kind}}»; `kind` traducido dentro de la plantilla,
  no como `{{reason}}`), audiencia `['payment.view', 'payment.credit.apply']` en
  `ADMIN_ALERT_AUDIENCE`, emitido sólo si `openLatePaymentCase` devolvió `true` **y** el caso tiene
  algo que decidir (`AFTER_EXPIRY` con `pendingCents > 0`, `WRITTEN_OFF`, `UNMATCHED`).
- [ ] **Paso 5: verlo pasar.** `NX_DAEMON=false npx pnpm nx test payments -- webhook-handler
  late-payment-case` y `NX_DAEMON=false npx pnpm nx test notifications -- templates` → PASS. Y la
  carrera vigente de la API: `NX_DAEMON=false npx pnpm nx test api -- cash-vs-webhook` → PASS.
- [ ] **Paso 6: commit.** `feat(payments): late money opens a case instead of an orphan alert`.

**Charlie:**
- Los cuatro caminos abren su `kind` con `amountCents`/`pendingCents` correctos.
- NB5: dos `evt_` distintos del mismo intento escrito, en paralelo, 30 veces → un caso, un aviso.
- Redelivery del mismo `evt_` (la prueba vigente «never lets a simultaneous redelivery reach the
  effect») sigue pasando sin tocarla.
- Ningún `ORPHAN_PAYMENT` nuevo en `notification_deliveries` tras la batería.
- La carrera de efectivo contra webhook (≥100 rondas, cero `40P01`) sigue limpia.

---

### Tarea L3: resolver un caso, y cerrarlo al revivir (compleja · Echo)

**Archivos:**
- Modificar: `libs/domain/payments/src/lib/late-payment-case.ts` (+ spec)
- Modificar: `libs/domain/payments/src/lib/credit-service.ts` (`reviveForPayment`; exportar dentro de
  la librería `outstandingExpirationCredit`)
- Modificar: `libs/domain/payments/src/lib/credit-ledger.ts` (`AddCreditEntryInput` acepta `paymentId`
  para `EXPIRATION`, si aún no)
- Modificar: `libs/domain/payments/src/index.ts`
- Docs: `payments.md` — «Dinero tardío: el caso de seguimiento» (las salidas y quién las toma),
  «Caso límite…» (la advertencia del `ADJUSTMENT` + `REFUND` manual se sustituye por la acción),
  «Revivir con un cobro» (cierra los casos). `payment-flow.md` — secuencia «Resolver un caso».
  `docs/diagrams/customer-credit.md` — `EXPIRATION` con `payment_id`.

**Interfaces:**
- Consume: `openLatePaymentCase` (L2), `lockReservationForMoney`, `lockCustomer`, `addCreditEntry`,
  `outstandingExpirationCredit`.
- Produce:

```ts
export type ResolvableResolution = 'KEPT_AS_CREDIT' | 'REFUNDED' | 'ACKNOWLEDGED';
export interface ResolveLatePaymentInput { caseId: string; resolution: ResolvableResolution; note?: string; actorId: string }
export interface LatePaymentCaseDto { /* el registro + kind, amounts, resolución */ }
/** The exits a case allows (decisions P2, P4, P5). */
export function allowedResolutions(lateCase: Pick<LatePaymentCase, 'kind' | 'pendingCents'>): readonly ResolvableResolution[];
export function noteRequired(lateCase: Pick<LatePaymentCase, 'kind'>, resolution: ResolvableResolution): boolean;
export async function resolveLatePaymentCase(db: Db, input: ResolveLatePaymentInput): Promise<Result<LatePaymentCaseDto>>;
/** In the revival's transaction, after the seat and the reclaim: closes the reservation's open AFTER_EXPIRY cases as REVIVED. */
export async function closeLatePaymentCasesOnRevival(tx: DbTransactionClient, input: { reservationId: string; actorId: string }): Promise<number>;
```

- [ ] **Paso 1: prueba de la regla pura, que falla.**

```ts
describe('allowedResolutions', () => {
  it.each([
    [{ kind: 'AFTER_EXPIRY', pendingCents: 150_000 }, ['KEPT_AS_CREDIT', 'REFUNDED']],
    [{ kind: 'AFTER_EXPIRY', pendingCents: 0 }, ['ACKNOWLEDGED']],
    [{ kind: 'AFTER_CANCELLATION', pendingCents: 0 }, ['ACKNOWLEDGED']],
    [{ kind: 'WRITTEN_OFF', pendingCents: 150_000 }, ['REFUNDED', 'ACKNOWLEDGED']],
    [{ kind: 'UNMATCHED', pendingCents: 150_000 }, ['REFUNDED', 'ACKNOWLEDGED']],
  ] as const)('%j allows %j', (lateCase, expected) => {
    expect(allowedResolutions(lateCase)).toEqual(expected);
  });

  it('asks for a note when the money is outside our books, and for a refund always', () => {
    expect(noteRequired({ kind: 'WRITTEN_OFF' }, 'ACKNOWLEDGED')).toBe(true);
    expect(noteRequired({ kind: 'AFTER_EXPIRY' }, 'REFUNDED')).toBe(true);
    expect(noteRequired({ kind: 'AFTER_EXPIRY' }, 'KEPT_AS_CREDIT')).toBe(false);
    expect(noteRequired({ kind: 'AFTER_CANCELLATION' }, 'ACKNOWLEDGED')).toBe(false);
  });
});
```

- [ ] **Paso 2: verlo fallar.** `NX_DAEMON=false npx pnpm nx test payments -- late-payment-case`.
- [ ] **Paso 3: implementar la regla** (dos funciones de tablas, sin base).
- [ ] **Paso 4: pruebas de integración de `resolveLatePaymentCase`, que fallan.**

```ts
describe('resolveLatePaymentCase', () => {
  it('KEPT_AS_CREDIT credits the pending part once, as EXPIRATION tied to the payment', async () => {
    const { lateCase, reservation, payment } = await openAfterExpiry(db, { amountCents: 150_000 });
    const resolved = await resolveLatePaymentCase(db, { caseId: lateCase.id, resolution: 'KEPT_AS_CREDIT', actorId: staffId });
    expect(resolved.ok && resolved.value).toMatchObject({ resolution: 'KEPT_AS_CREDIT', resolvedById: staffId });
    const entries = await db.customerCreditEntry.findMany({ where: { paymentId: payment.id } });
    expect(entries).toEqual([expect.objectContaining({ kind: 'EXPIRATION', amountCents: 150_000, reservationId: reservation.id })]);
  });

  it('REFUNDED credits and refunds in one transaction, leaving the balance where it was', async () => {
    const { lateCase, reservation } = await openAfterExpiry(db, { amountCents: 150_000 });
    const before = await creditBalance(db, reservation.customerId);
    await resolveLatePaymentCase(db, { caseId: lateCase.id, resolution: 'REFUNDED', note: 'Transferencia 8 oct', actorId: staffId });
    expect(await creditBalance(db, reservation.customerId)).toBe(before);
    // and the ledger shows EXPIRATION +150_000 then REFUND -150_000, the refund carrying the note
  });

  it('refuses a resolution the case does not allow, a missing note, and a second resolution', async () => {
    // AFTER_CANCELLATION + KEPT_AS_CREDIT → VALIDATION_FAILED { field: 'resolution' }
    // AFTER_EXPIRY + REFUNDED without note → VALIDATION_FAILED { field: 'note' }
    // resolve twice → INVALID_STATUS_TRANSITION { status: 'RESOLVED' }; nothing written the second time
  });

  it('refuses to credit a case whose reservation is no longer EXPIRED', async () => {
    // revive the reservation by hand (status ACTIVE) without closing the case → INVALID_STATUS_TRANSITION
  });

  it('closes its open AFTER_EXPIRY cases when the reservation is revived at the counter', async () => {
    // counter cash on the EXPIRED reservation (reviveForPayment path) → case resolution REVIVED,
    // resolvedById = the cashier, and paid_cents counts the late payment exactly once
  });

  it('lets a revival take back a KEPT_AS_CREDIT credit, and refuses it after a REFUNDED one', async () => {
    // KEPT_AS_CREDIT then counter cash: REVIVAL reclaims 150_000; balance back to before
    // REFUNDED then counter cash: CREDIT_INSUFFICIENT, nothing written
  });
});
```

- [ ] **Paso 5: implementar.**

```ts
export async function resolveLatePaymentCase(db: Db, input: ResolveLatePaymentInput): Promise<Result<LatePaymentCaseDto>> {
  return rollbackable(db, async (tx) => {
    const found = await tx.latePaymentCase.findUnique({ where: { id: input.caseId }, select: { reservationId: true } });
    if (!found) return fail('NOT_FOUND');
    // Lock order: trip → reservation (lockReservationForMoney) → this case → customer.
    if (found.reservationId) await lockReservationForMoney(tx, found.reservationId);
    const [lateCase] = await tx.$queryRaw<LatePaymentCase[]>`SELECT * FROM late_payment_cases WHERE id = ${input.caseId}::uuid FOR UPDATE`;
    if (lateCase.resolved_at) return fail('INVALID_STATUS_TRANSITION', { status: 'RESOLVED' });
    // (mapear columnas snake_case → camelCase, o releer con Prisma después del FOR UPDATE)

    if (!allowedResolutions(lateCase).includes(input.resolution)) return fail('VALIDATION_FAILED', { field: 'resolution' });
    const note = normalizedReason(input.note);
    if (noteRequired(lateCase, input.resolution) && !note) return fail('VALIDATION_FAILED', { field: 'note' });

    if (lateCase.kind === 'AFTER_EXPIRY' && input.resolution !== 'ACKNOWLEDGED') {
      const reservation = await tx.reservation.findUniqueOrThrow({ where: { id: lateCase.reservationId! } });
      if (reservation.status !== 'EXPIRED') return fail('INVALID_STATUS_TRANSITION', { status: reservation.status });
      await lockCustomer(tx, reservation.customerId);
      const uncredited = reservation.paidCents - (await outstandingExpirationCredit(tx, reservation.id));
      if (uncredited < lateCase.pendingCents) return fail('CONFLICT', { reason: 'already_credited' });
      const credited = await addCreditEntry(tx, {
        customerId: reservation.customerId, amountCents: lateCase.pendingCents, kind: 'EXPIRATION',
        reservationId: reservation.id, paymentId: lateCase.paymentId!, actorId: input.actorId,
      });
      if (!credited.ok) throw new RollbackWith(credited);
      if (input.resolution === 'REFUNDED') {
        const refunded = await addCreditEntry(tx, {
          customerId: reservation.customerId, amountCents: -lateCase.pendingCents, kind: 'REFUND',
          reservationId: reservation.id, paymentId: lateCase.paymentId!, reason: note!, actorId: input.actorId,
        });
        if (!refunded.ok) throw new RollbackWith(refunded);
      }
    }

    const resolved = await tx.latePaymentCase.update({
      where: { id: input.caseId },
      data: { resolvedAt: new Date(), resolvedById: input.actorId, resolution: input.resolution, note },
    });
    return ok(toLatePaymentCaseDto(resolved));
  });
}
```

  `closeLatePaymentCasesOnRevival`: `updateMany({ where: { reservationId, kind: 'AFTER_EXPIRY',
  resolvedAt: null }, data: { resolvedAt: now, resolvedById: actorId, resolution: 'REVIVED' } })`.
  Llamada en `reviveForPayment`, rama `previousStatus === 'EXPIRED'`, **después** de
  `reclaimCreditForRevival` con éxito (ya bajo reserva y cliente). Ajusta la firma de `addCreditEntry`
  si hoy no recibe `paymentId`/`reason` para estos tipos.
- [ ] **Paso 6: carrera (foco de revisión 4), que falla sin el candado del caso.**

```ts
it('never counts the same late peso in the credit and in a revived reservation (30 rounds)', async () => {
  for (let round = 0; round < 30; round += 1) {
    const { lateCase, reservation } = await openAfterExpiry(db, { amountCents: 150_000 });
    await Promise.allSettled([
      resolveLatePaymentCase(db, { caseId: lateCase.id, resolution: 'KEPT_AS_CREDIT', actorId: staffId }),
      registerCounterPayment(db, reviveReservationSeatForTests, { reservationId: reservation.id, amountCents: 100_000, actorId: staffId }),
    ]);
    // invariant: credit the reservation left with the customer + (paid_cents if live) = Σ SUCCEEDED
    await expectReservationMoneyInvariant(db, reservation.id);
  }
});
```

  Usa el `reviveReservationSeat` falso que ya usan las specs de `counter-payment` (el dominio de pagos
  no importa `@rm/domain-reservations`). Mutación: quitar `lockReservationForMoney` de
  `resolveLatePaymentCase` y ver fallar la invariante.
- [ ] **Paso 7: verlo pasar.** `NX_DAEMON=false npx pnpm nx test payments -- late-payment-case
  counter-payment credit-service` → PASS.
- [ ] **Paso 8: commit.** `feat(payments): resolve late money, and revival closes its cases`.

**Charlie:**
- Cada salida permitida y cada rechazo (resolución no permitida, sin nota, ya resuelto, reserva ya no
  `EXPIRED`).
- Carreras, 30 veces cada una: resolver contra revivir en mostrador (foco 4); dos resoluciones del
  mismo caso a la vez (una gana, la otra `INVALID_STATUS_TRANSITION`, un solo movimiento); webhook
  tardío contra revivir sobre la misma reserva (sin `40P01`).
- `reconcilePaidCents` no alerta tras ninguna de las salidas (no tocan `paid_cents`).

---

### Tarea L4: la API de casos (simple · Bravo)

**Archivos:**
- Crear: `libs/contracts/src/lib/late-payments.ts` (+ `index.ts`)
- Crear: `apps/api/src/app/api/v1/admin/late-payments/route.ts` (GET)
- Crear: `apps/api/src/app/api/v1/admin/late-payments/[caseId]/resolve/route.ts` (POST)
- Crear: `apps/api/src/app/api/v1/admin/late-payments/late-payments.integration.spec.ts`
- Modificar: `libs/domain/payments/src/lib/late-payment-case.ts` (sólo `listLatePaymentCases`)
- Modificar: `apps/api/src/lib/openapi/registry.ts`; regenerar `schema.d.ts`; `libs/api-client/src/lib/endpoints.ts`
- Docs: `payments.md` — «Dinero tardío…», subsección «API».

**Interfaces:**
- Consume: `resolveLatePaymentCase`, `LatePaymentCaseDto` (L3).
- Produce:

```ts
export const latePaymentStateSchema = z.enum(['OPEN', 'RESOLVED']);
export const listLatePaymentsQuerySchema = z.object({
  state: latePaymentStateSchema.default('OPEN'),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
});
export const latePaymentCaseSchema = z.object({
  id: uuidSchema,
  kind: z.enum(['AFTER_EXPIRY', 'AFTER_CANCELLATION', 'WRITTEN_OFF', 'UNMATCHED']),
  providerIntentId: z.string(),
  amountCents: z.number().int(),
  pendingCents: z.number().int(),
  allowedResolutions: z.array(z.enum(['KEPT_AS_CREDIT', 'REFUNDED', 'ACKNOWLEDGED'])),
  openedAt: z.iso.datetime(),
  resolvedAt: z.iso.datetime().nullable(),
  resolution: z.enum(['REVIVED', 'KEPT_AS_CREDIT', 'REFUNDED', 'ACKNOWLEDGED']).nullable(),
  note: z.string().nullable(),
  payment: z.object({ id: uuidSchema, method: paymentMethodSchema, paidAt: z.iso.datetime().nullable(), receiptNumber: z.string().nullable() }).nullable(),
  reservation: z.object({ id: uuidSchema, code: z.string(), status: reservationStatusSchema, tripName: z.string() }).nullable(),
  customer: z.object({ id: uuidSchema, fullName: z.string() }).nullable(),
});
export const latePaymentPageSchema = z.object({ items: z.array(latePaymentCaseSchema), nextCursor: z.string().nullable() });
export const resolveLatePaymentRequestSchema = z.object({
  resolution: z.enum(['KEPT_AS_CREDIT', 'REFUNDED', 'ACKNOWLEDGED']),
  note: z.string().trim().max(500).optional(),
});
```

- [ ] **Paso 1: pruebas de ruta que fallan.** `GET` sin `payment.view` → 403; con permiso, los casos
  abiertos, más viejos primero, paginados con cursor sobre `(opened_at, id)` (mismo cursor opaco que
  la bandeja); `POST resolve` sin `payment.credit.apply` → 403; con permiso, cada código de L3 con su
  HTTP; un `resolution: 'REVIVED'` → 400 (Zod).
- [ ] **Paso 2: verlo fallar.** `NX_DAEMON=false npx pnpm nx test api -- late-payments`.
- [ ] **Paso 3: implementar.** Rutas de cuatro pasos (`route({ permission, handler })`); el GET valida
  su query a mano contra `listLatePaymentsQuerySchema`, como `admin/reservations/route.ts`.
  `listLatePaymentCases` usa el índice parcial de L1 para `OPEN`. `allowedResolutions` sale de la
  regla de L3 para que la UI no la repita.
- [ ] **Paso 4: verlo pasar.** Mismo comando y `NX_DAEMON=false npx pnpm nx test api -- registry` →
  PASS; `npx pnpm api:types` sin diferencias pendientes.
- [ ] **Paso 5: commit.** `feat(api): late payment cases for the Mostrador`.

**Charlie:** permisos (cuatro combinaciones); paginación con cursor falsificado → 400, nunca 500 (como
`af2dcd9`); la lista no expone datos de costeo.

---

### Tarea L5: el quinto conteo de la cola (simple · Bravo)

**Dependencia:** `feat/admin-work-queue-api` (Bravo) integrada en `main`, y L1.

**Archivos:**
- Modificar: `libs/domain/reservations/src/lib/work-queue-summary.ts` (+ `work-queue.spec.ts`)
- Modificar: `libs/contracts/src/lib/work-queue.ts` (`latePayments`)
- Regenerar `schema.d.ts`; `registry.ts` si la paridad lo pide.
- Docs: `reservations.md` (sección de la cola) y `trip-reservation.md` si el diagrama de la cola nombra
  los conteos.

**Interfaces:**
- Produce: `StaffWorkQueueSummaryDto.latePayments: number | null` (`payment.view`).

- [ ] **Paso 1: prueba que falla.** Con dos casos abiertos y uno resuelto, un actor con
  `payment.view` ve `latePayments: 2`; sin él, `null`.
- [ ] **Paso 2: verlo fallar.** `NX_DAEMON=false npx pnpm nx test reservations -- work-queue`.
- [ ] **Paso 3: implementar.** En el `Promise.all`:
  `canSeePayments ? db.latePaymentCase.count({ where: { resolvedAt: null } }) : Promise.resolve(null)`.
  El mismo predicado que la lista `OPEN` de L4 (un conteo nunca contradice su pantalla).
- [ ] **Paso 4: verlo pasar.** Mismo comando → PASS.
- [ ] **Paso 5: commit.** `feat(reservations): the work queue counts open late payments`.

**Charlie:** el badge y la lista de L4 dan el mismo número antes y después de resolver un caso.

---

# Parte B — SPEI (detrás de `payments.spei_enabled`, D6)

Requisito externo (spec §13): claves de prueba de Stripe con OXXO y `customer_balance`
(`mx_bank_transfer`). Sin ellas, B1–B3 se construyen con cuerpos grabados y SPEI **queda apagado**;
encenderlo exige pasar la lista manual de §11 (instrucciones, fondos parciales, fondos de más,
transferencia después de cancelar, CLABE reutilizada). Si Stripe se comporta distinto de lo que dice
§5.5/§6.4, se corrige el spec **antes** de seguir.

### Tarea B1: el adaptador crea SPEI con Customer (compleja · Echo)

**Archivos:** `libs/payments-stripe/src/lib/{payment-provider,stripe-payment-provider,fake-payment-provider}.ts`
(+ specs y contrato compartido), `libs/payments-stripe/README.md`, `schema.prisma` + migración
(`customer_profiles.stripe_customer_id String? @unique`).

**Interfaces:**
- Produce: `PaymentProvider.ensureCustomer(input: { customerId: string; email: string; name: string }):
  Promise<Result<{ providerCustomerId: string }>>` (idempotencia de Stripe con clave
  `rm-customer-<customerId>`); `PaymentIntentRequest.providerCustomerId?: string` (obligatorio para
  SPEI); `PaymentIntentResult.bankTransfer?: { clabe; reference; bankName; amountRemainingCents;
  hostedInstructionsUrl }`.

- [ ] Pruebas que fallan: el contrato compartido pide SPEI sin `providerCustomerId` → `VALIDATION_FAILED`;
  con él, devuelve `bankTransfer` completo (cuerpo grabado de `next_action.display_bank_transfer_instructions`);
  `ensureCustomer` dos veces con el mismo `customerId` → el mismo id.
- [ ] Verlas fallar, implementar, verlas pasar (`NX_DAEMON=false npx pnpm nx test payments-stripe`).
- [ ] Commit `feat(payments-stripe): SPEI intents with a Stripe customer`.

**Charlie:** cuerpos grabados del modo de prueba, sin red; la lista manual de §11 la corre Charlie con
las claves de prueba cuando existan.

### Tarea B2: SPEI en el dominio y en el job (compleja · Echo)

**Archivos:** `payment-intent-service.ts`, `payment-options.ts`, `apps/worker/src/jobs/expire-stale-payment-intents.ts`,
`templates.ts` (`TRANSFER_EXPIRED`), docs `payments.md` («SPEI», «Intentos vencidos sin apartado»),
`payment-flow.md` («Tres métodos, tres tiempos»: quitar «SPEI está en la API… pero no en la app»
**sólo** cuando se encienda), `notifications.md`.

- [ ] Pruebas que fallan:
  - Con `spei_enabled = true`, el primer intento SPEI del viajero crea el Customer **fuera** de la
    transacción y lo guarda con `updateMany({ where: { userId, stripeCustomerId: null } })`; dos
    intentos simultáneos (30 rondas) dejan un solo Customer.
  - `bankTransfer.expiresAt` = apartado en `HELD`; `now + speiActiveLifetimeHours` en `ACTIVE`.
  - El job cierra SPEI `PENDING` de reservas `ACTIVE` con `voucher_expires_at < now`, avisa
    `TRANSFER_EXPIRED` una vez y cancela en el proveedor; los de `HELD` no los toca (`expireHolds`).
- [ ] Verlas fallar, implementar, verlas pasar (`nx test payments -- payment-intent-service`,
  `nx test worker -- expire-stale-payment-intents`, `nx test notifications -- templates`).
- [ ] Commit `feat(payments): SPEI behind payments.spei_enabled`.

### Tarea B3: eventos SPEI del webhook (compleja · Echo)

**Archivos:** `webhook-handler.ts` (+ spec), `payment-provider.ts` (`parseStripeEventBody` lee
`customer_cash_balance_transaction`), `templates.ts` (`TRANSFER_PARTIALLY_FUNDED`,
`CASH_BALANCE_UNAPPLIED`), `delivery-service.ts` (audiencia de `CASH_BALANCE_UNAPPLIED`:
`payment.view`, `payment.credit.apply`), docs `payments.md` («El webhook de Stripe», tabla de
eventos), `payment-flow.md`, `notifications.md`.

- [ ] Pruebas que fallan: `payment_intent.partially_funded` no mueve dinero y avisa al viajero cuánto
  falta, una vez por evento; `customer_cash_balance_transaction.created` sin intento → aviso al
  personal, ningún `Payment`; ambos idempotentes por `evt_` (fila de `stripe_events`).
- [ ] Verlas fallar, implementar, verlas pasar (`nx test payments -- webhook-handler`).
- [ ] Commit `feat(payments): SPEI partial funds and unapplied balance`.

---

## Lo que Charlie valida al cerrar cada parte

**Parte A (antes de integrar `feat/abono-libre`):**
- Concurrencias 1, 2, 3, 4, 5, 6, 7, 9 del spec §11 (30 rondas cada una; las vigentes deben seguir
  pasando sin tocarlas) y la 8 cuando A9 está.
- Mutaciones obligatorias del spec: quitar el `min()` del reparto (falla 1), quitar la resta de
  `OVERPAYMENT` en la conciliación, quitar el índice parcial de `OVERPAYMENT`.
- La app actual sin cambios de UI sigue pagando con `FULL`/`DEPOSIT` (e2e `happy-path`).
- Con Stripe de prueba (si hay claves): OXXO en `ACTIVE` con vigencia de 3 días; abono OXXO sobre el
  máximo rechazado con `PAYMENT_METHOD_UNAVAILABLE`.

**Parte L (antes de integrar `feat/late-payment-cases`):**
- Los cuatro `kind`, las salidas, NB5, y las tres carreras de L3.
- Invariante del spec §5.3 tras cada escenario: para cada reserva, `paid_cents` = Σ `SUCCEEDED` − Σ
  `PRICE_DECREASE` − Σ `OVERPAYMENT`; el saldo que dejó en el cliente más su `paid_cents` si está viva
  = Σ `SUCCEEDED`, salvo lo pendiente de casos `AFTER_EXPIRY` abiertos.
- `reconcilePaidCents` sin alertas falsas.

**Parte B:** la lista manual de §11 del spec con claves de prueba; hasta entonces sólo cuerpos
grabados y `spei_enabled = false`.

---

## Cobertura del spec (autorrevisión)

| Spec | Tarea |
|---|---|
| §4.1 contrato, unión discriminada, `bankTransfer` | A3 (+ B1 para llenarlo) |
| §4.2 `paymentOptions` | A3, A5 |
| §4.3 errores | A1, A4, A5 |
| §5.1 mínimo y máximo, `NOTHING_DUE` | A5 |
| §5.2 abonos sobre `HELD` (D2) | A5 |
| §5.3 sobrepago | ya en `main` (99904b4); A5 lo vuelve a probar |
| §5.4 OXXO en `ACTIVE`, límite por ficha (D3, D10) | A4, A5 |
| §5.5 SPEI | B1, B2, B3 |
| §5.6 tarjeta: un intento abierto, vencimiento por job | A8, A9 |
| §5.7 dinero tardío | L1–L5 (sustituye las filas con `ORPHAN_PAYMENT`) |
| §5.8 mensualidad con tope inferior | A6 |
| §6.1–6.3 idempotencia y orden de candados | ya en `main`; L2/L3 respetan el orden |
| §6.4 eventos nuevos | B3 (`succeeded` con excedente ya en `main`) |
| §7.1 conciliación | ya en `main` |
| §7.2 recibos `creditedCents` | A7 |
| §8 modelo de datos | A2 (settings), L1, B1 (`stripe_customer_id`); `OVERPAYMENT` ya en `main` |
| §9 job | A9 (tarjeta), B2 (SPEI) |
| §10 documentación viva | en cada tarea |
| §11 pruebas | en cada tarea y en «Lo que Charlie valida» |
| Decisión 2026-10-08 (`LatePaymentCase`) | L1–L5, decisiones P1–P7 |
