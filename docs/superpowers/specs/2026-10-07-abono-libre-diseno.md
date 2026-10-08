# Diseño: Abono libre desde la app

**Fecha:** 2026-10-07
**Estado:** **aprobado** por el dueño del producto el 2026-10-07, con las diez decisiones de §15
tal como se recomendaron. Siguiente paso: el plan de implementación.
**Antecede:** `docs/superpowers/specs/2026-10-03-fase-2a-reservas-y-pagos-diseno.md` (Fase 2A) y
`docs/superpowers/specs/2026-10-07-fase-2b-mostrador-diseno.md` (Fase 2B), ambas en `main`.
**Alcance:** API y dominio (`libs/contracts`, `libs/domain/payments`, `libs/payments-stripe`,
`apps/api`, `apps/worker`, `libs/db`, `libs/receipts`). Las pantallas se diseñan dentro del rediseño
de la Fase 3 y no forman parte de este documento.

---

## 1. Qué cambia y por qué

El inventario de flujos del rediseño (`.impeccable/review/flow-inventory.md`, hallazgo 1) encontró
que **la app no permite pagar en abonos**, aunque es la promesa central de la agencia («aparta tu
lugar y paga el resto en mensualidades»):

| Hoy | Por qué |
|---|---|
| La app sólo ofrece «todo el saldo» o «el anticipo mínimo» | `CreatePaymentIntentRequest` sólo acepta `intent: FULL \| DEPOSIT` (`libs/contracts/src/lib/payments.ts:4,20-23`) |
| Pagado el anticipo, sólo queda «todo el saldo» | `DEPOSIT` sólo existe mientras la reserva está `HELD` |
| OXXO falla siempre en una reserva `ACTIVE` | La ficha vence con el apartado, y una `ACTIVE` no tiene apartado (`payment-intent-service.ts:110-112,143`; `stripe-payment-provider.ts:164-165`) |
| SPEI no aparece en la app | Decisión 1 de `docs/decisiones-fase-2a.md` («SPEI queda para después») |

Resultado: después del anticipo, el viajero sólo puede pagar **todo lo que debe, con tarjeta**,
mientras el texto de la app le dice «puedes abonar lo que quieras».

**Criterio de cierre:** un viajero con una reserva `ACTIVE` abona una cantidad elegida por él, mayor
o igual al mínimo, con tarjeta, en OXXO o por SPEI. El dinero se acredita sólo cuando Stripe lo
confirma por webhook, y si excede lo que debía, el excedente aparece en su saldo a favor.

**Entrega en dos planes.** Este spec cubre un solo diseño, pero se implementa en dos planes para que
lo verificable no espere a lo que no lo es:

| Plan | Contenido | Depende de |
|---|---|---|
| Previo | El sobrepago que hoy no se acredita (§5.3) y el orden de bloqueo único (§6.2), que ya fallan en `main` sin abono libre. El dueño pidió corregirlos antes, como su propio ticket (rama `fix/payments-overpayment-and-lock-order`) | — |
| A | Contrato (§4), mínimos y máximos (§5.1–§5.2), sobrepago a saldo a favor (§5.3), OXXO en `ACTIVE` (§5.4), tarjeta (§5.6), mensualidad (§5.8), orden de bloqueo (§6), conciliación y recibos (§7), job (§9) sin la parte SPEI | Las respuestas del dueño (§15) |
| B | SPEI (§5.5, §6.4 y la parte SPEI de §9) | Plan A integrado y la verificación en modo de prueba de Stripe (D6) |

---

## 2. Decisión del dueño del producto (2026-10-07)

Recibida a través de Alpha (líder del equipo), en estas palabras:

> «Abono libre»: el viajero elige cuánto pagar, **con un mínimo**, con **tarjeta, OXXO o SPEI**
> desde la app, en reservas **`HELD` y `ACTIVE`**; una ficha de OXXO sobre una reserva `ACTIVE`
> tiene **su propio vencimiento**.

Esta decisión **reemplaza** la decisión 1 de la Fase 2A («SPEI queda para después»). Los valores
concretos (cuánto es el mínimo, cuántos días dura una ficha, etc.) los decidió el dueño al aprobar
este documento y están en §15.

---

## 3. Decisiones de arquitectura

| Área | Decisión | Razón |
|---|---|---|
| Contrato | `intent` pasa a ser una unión discriminada: `FULL`, `DEPOSIT` (sin cambios) y **`AMOUNT`**, la única que lleva `amountCents` | La app actual sigue funcionando sin cambios; el monto viaja sólo donde tiene sentido |
| La regla «el monto nunca lo decide el cliente» | Se reformula: **el cliente propone, el servidor dispone**. El servidor valida la propuesta contra la reserva y contra los mínimos, y nunca cobra un monto que no validó | La Regla 2 de la 2A protegía contra cobrar algo distinto de lo que se debe. La protección sigue en el servidor; lo que cambia es que el cliente puede pedir *menos* que el total |
| Dinero confirmado que excede el saldo | **Se divide**: lo que cabe se aplica a la reserva y el excedente se vuelve saldo a favor (`OVERPAYMENT`) | Con abono libre, dos pagos pendientes que juntos exceden el saldo pasan a ser frecuentes. Rechazar dinero que Stripe ya cobró no es una opción |
| Vencimiento sin apartado | OXXO y SPEI sobre `ACTIVE` vencen a los N días que fije la configuración | Una `ACTIVE` no tiene `hold_expires_at` con el que acotar la ficha |
| Límites y vigencias | Viven en `SystemSetting`, no en código | El dueño puede ajustarlos sin un despliegue, igual que `organization.timezone` |
| SPEI | Exige un **Customer de Stripe** por viajero, guardado en `customer_profiles.stripe_customer_id` | Stripe modela SPEI como `customer_balance`, que no existe sin Customer. El adaptador actual no lo manda (`stripe-payment-provider.ts:189-202`) |
| Orden de bloqueo | **Uno solo** en todo camino de dinero: viaje → reserva → cliente → contador de folios | Hoy el webhook toma el contador antes que la reserva y el cobro en mostrador al revés (§6.2) |
| Dominio sin HTTP | Todo lo anterior vive en `libs/domain/payments`; la ruta sólo autentica, valida con Zod y llama | `CLAUDE.md`, «la regla que no se rompe» |

---

## 4. Contrato de API

### 4.1 Crear un intento de pago

`POST /api/v1/reservations/{reservationId}/payment-intents` (propio, sin permiso; la pertenencia la
verifica el dominio).

```ts
// libs/contracts/src/lib/payments.ts
export const createPaymentIntentRequestSchema = z.discriminatedUnion('intent', [
  z.object({ intent: z.literal('FULL'), method: paymentIntentMethodSchema }),
  z.object({ intent: z.literal('DEPOSIT'), method: paymentIntentMethodSchema }),
  z.object({
    intent: z.literal('AMOUNT'),
    method: paymentIntentMethodSchema,
    amountCents: z.number().int().positive(),
  }),
]);
```

- `FULL` y `DEPOSIT` conservan exactamente su significado actual. Por dentro se traducen al mismo
  camino que `AMOUNT` (el saldo, o lo que falta del anticipo), así que las reglas de §5 son una
  sola implementación.
- La respuesta (`createdPaymentIntentSchema`) gana un bloque opcional para SPEI:

```ts
bankTransfer: z.object({
  clabe: z.string(),
  reference: z.string(),
  bankName: z.string(),
  amountRemainingCents: z.number().int(),
  hostedInstructionsUrl: z.string(),
  expiresAt: z.iso.datetime(),
}).optional()
```

### 4.2 Lo que la UI necesita para no duplicar reglas

La app no puede adivinar el mínimo ni qué métodos sirven en este momento, y calcularlo en Angular
sería una segunda implementación que tarde o temprano diverge (lo mismo que ya se decidió para la
mensualidad sugerida). `ReservationDetail` (`GET /reservations/{id}`) gana:

```ts
paymentOptions: z.object({
  minAmountCents: z.number().int(),      // 0 cuando no se debe nada
  maxAmountCents: z.number().int(),      // = balanceCents
  depositOwedCents: z.number().int(),    // 0 en una ACTIVE
  methods: z.array(z.object({
    method: paymentIntentMethodSchema,
    available: z.boolean(),
    reason: z.enum(['NOT_CONFIGURED', 'WINDOW_TOO_SHORT', 'ABOVE_PROVIDER_LIMIT', 'DISABLED']).optional(),
  })),
})
```

Este bloque es informativo. La validación que cuenta sigue siendo la del `POST`: entre la lectura y
el pago el saldo puede cambiar.

Los pagos pendientes de una reserva, con su ficha o sus datos de transferencia y su vencimiento, ya
salen de `GET /payments` (`provider_voucher_url`, `voucher_expires_at`). Mostrarlos sin pedir
`/payments` completo es tarea del rediseño; si hace falta un filtro `?reservationId=`, se añade allí.

### 4.3 Errores

| Código | HTTP | Cuándo | `details` |
|---|---|---|---|
| `PAYMENT_BELOW_MINIMUM` (nuevo) | 422 | `AMOUNT` en una `ACTIVE`, por debajo del mínimo vigente | `minAmountCents` |
| `DEPOSIT_BELOW_MINIMUM` (ya existe en el catálogo, sin uso hasta hoy) | 422 | `AMOUNT` en una `HELD`, por debajo de lo que falta del anticipo (si D2 se decide así) | `depositOwedCents` |
| `PAYMENT_EXCEEDS_BALANCE` (existe) | 422 | Monto mayor que el saldo pendiente | `balanceCents` |
| `PAYMENT_METHOD_UNAVAILABLE` (nuevo) | 422 | OXXO sin ventana de un día completo; monto fuera de los límites del proveedor; SPEI desactivado | `method`, `reason` (mismo enum de §4.2) |
| `NOTHING_DUE` (nuevo) | 409 | `FULL`/`DEPOSIT` sin nada que cobrar (hoy sale como `VALIDATION_FAILED` con `reason: nothing_due`) | — |
| `INVALID_STATUS_TRANSITION` (existe) | 409 | Reserva `CANCELLED` o `EXPIRED` | `status` |

Hoy el viajero que elige OXXO en una `ACTIVE` ve «Revisa los datos capturados» porque el adaptador
responde `VALIDATION_FAILED`. Con `PAYMENT_METHOD_UNAVAILABLE`, Angular puede decir la verdad. Cada
código nuevo va en los tres lugares que exige el catálogo: `DomainErrorCode`
(`libs/shared-utils/src/lib/result.ts`), `STATUS_BY_CODE` (`apps/api/src/lib/http/problem.ts`) y
`es.json`/`en.json`.

`schema.d.ts` se regenera con `pnpm api:types`; nunca se edita a mano.

---

## 5. Reglas de negocio

### 5.1 Mínimo y máximo de un abono

Para `AMOUNT`, en este orden, **antes** de llamar al proveedor:

1. La reserva es del viajero (`RESERVATION_NOT_OWNED`, 404) y está `HELD` o `ACTIVE`
   (`INVALID_STATUS_TRANSITION`). Sin cambios.
2. `amountCents` es un entero mayor que cero (Zod lo garantiza; el dominio lo vuelve a comprobar).
   Si el saldo ya es cero → `NOTHING_DUE`, antes que cualquier otra comprobación de monto.
3. **Máximo:** `amountCents ≤ balance_cents` → si no, `PAYMENT_EXCEEDS_BALANCE`. El saldo **no
   descuenta los pagos pendientes** (§5.3 explica por qué no hace falta).
4. **Mínimo**, que nunca supera el saldo (si se debe menos que el mínimo, el mínimo es lo que se
   debe):
   - `HELD`: `min(anticipo_pendiente, saldo)`, donde
     `anticipo_pendiente = max(0, minimum_deposit_cents − paid_cents)` → `DEPOSIT_BELOW_MINIMUM`.
     **Sujeto a D2.**
   - `ACTIVE`: `min(payments.min_installment_cents, saldo)` → `PAYMENT_BELOW_MINIMUM`. **Valor
     sujeto a D1.**
5. **Límites del proveedor** por método (mínimo y máximo por transacción de Stripe; para OXXO el
   máximo por ficha, §5.4) → `PAYMENT_METHOD_UNAVAILABLE` con `ABOVE_PROVIDER_LIMIT`.

La validación lee la reserva **sin bloqueo**: crear un intento no mueve dinero. La comprobación que
protege el dinero ocurre al confirmar (§5.3), bajo el candado de la reserva.

`DEPOSIT` se convierte en `AMOUNT` con `anticipo_pendiente`; `FULL`, en `AMOUNT` con el saldo. Si el
resultado es 0 → `NOTHING_DUE`.

**Fecha límite de pago.** Hoy ningún camino rechaza un pago por llegar después de
`payment_deadline` (sólo se valida al crear la reserva). Este diseño conserva eso salvo que D4 diga
lo contrario.

### 5.2 Abonos sobre un apartado (`HELD`)

- El umbral del anticipo sigue siendo **acumulado** (`payments.md`, «Umbral del anticipo»): un
  abono confirmado que lleva `paid_cents` al anticipo pasa la reserva a `ACTIVE` en el mismo
  `updateMany` condicionado de hoy.
- Un abono **pendiente** no detiene el apartado: el reloj sigue corriendo hasta que Stripe confirme.
- Ficha OXXO y referencia SPEI sobre una `HELD` **vencen con el apartado**, como hoy. Si al
  apartado le queda menos de un día completo en el calendario de Stripe, OXXO responde
  `PAYMENT_METHOD_UNAVAILABLE` (`WINDOW_TOO_SHORT`), igual que hoy pero con un código traducible.
- `expireHolds` ya cancela en el proveedor **todo** pago `PENDING` con `provider_intent_id` de la
  reserva que vence (`payment-intent-cancellation.ts`), así que SPEI queda cubierto sin código
  nuevo.
- Si D2 permite abonos menores al anticipo sobre una `HELD`: un abono así no asegura el lugar, el
  apartado vence igual, y lo pagado pasa a saldo a favor como `EXPIRATION` (decisión 16, ya
  implementada). El riesgo es de experiencia: el viajero cree que «ya abonó» y pierde el lugar.

### 5.3 Confirmación: el dinero que Stripe cobró nunca se rechaza por exceder el saldo

**El hueco que existe hoy.** `confirmPaymentWithin` pasa una fila `PENDING` a `SUCCEEDED` y suma su
monto a `paid_cents` **sin comparar contra el saldo** (`payment-service.ts:433-447`). Si se pagan
dos fichas por el total, `paid_cents` queda por encima de `total_price_cents`, el saldo se ve en
cero, la conciliación no alerta (cuadra contra los pagos) y **el excedente no aparece en ninguna
parte como saldo a favor**. `webhook-handler.ts:62-66` y `payments.md:41-45` dicen que «la Fase 2B
lo convierte en saldo a favor», pero la 2B no lo implementó. Con abono libre, el caso deja de ser
raro: una ficha de $1,000 pendiente más una tarjeta por el resto, y luego el viajero paga la ficha.

**La regla nueva**, en la transacción del webhook, bajo el candado de la reserva:

```
si la reserva está HELD o ACTIVE:
    aplicado  = min(monto, saldo)          -- saldo leído bajo el candado
    excedente = monto − aplicado
    paid_cents += aplicado
    si HELD y paid_cents ≥ anticipo → ACTIVE (sin cambios)
    si excedente > 0 → movimiento OVERPAYMENT (+excedente, reservation_id, payment_id)
```

- La fila `Payment` conserva `amount_cents` = **todo lo que se recibió**: es el dinero que se movió.
- Vale para los dos caminos del webhook: confirmar la fila `PENDING` y `recordIfMissing` (hoy éste
  responde `PAYMENT_EXCEEDS_BALANCE` y escala a una persona sin registrar el pago). Como
  `recordIfMissing` pasa por `recordPayment`, éste gana una opción explícita
  (`excessToCredit: true`) que **sólo** pasa el webhook; sin ella, `recordPayment` sigue rechazando
  con `PAYMENT_EXCEEDS_BALANCE`. Para una reserva viva, `PAYMENT_EXCEEDS_BALANCE` deja de
  alcanzarse desde el webhook; se queda en `NEEDS_A_HUMAN` como defensa.
- **No cambia** para efectivo, saldo aplicado, captura histórica ni importación: ahí el monto lo
  teclea una persona y rechazarlo con `PAYMENT_EXCEEDS_BALANCE` sigue siendo lo correcto.
- **No cambia** para una reserva `EXPIRED` (pago tardío registrado, `paid_cents` sube, sin saldo a
  favor, decisión humana: `payments.md`, «Caso límite») ni para una `CANCELLED` (todo el monto a
  saldo a favor como `CANCELLATION`).
- Aviso al viajero: `PAYMENT_CONFIRMED` si no hubo excedente; si lo hubo, `PAYMENT_EXCESS_CREDITED`
  (nuevo) con monto recibido, monto aplicado y monto a saldo a favor. Es una plantilla propia por
  la misma razón que `PAYMENT_AFTER_CANCELLATION`: es prosa distinta en cada idioma
  (`notifications.md`). **Sujeto a D7.**
- **Invariante** (sustituye la de `payments.md`, «Lo pagado de un apartado vencido»): para cada
  reserva, `paid_cents` = Σ pagos `SUCCEEDED` − Σ `PRICE_DECREASE` − Σ `OVERPAYMENT` de esa
  reserva; y el saldo que la reserva dejó en el cliente más su `paid_cents` si está viva es Σ de sus
  pagos `SUCCEEDED`.

### 5.4 Ficha de OXXO sin apartado (`ACTIVE`)

- `HELD`: sin cambios (vence con el apartado, nunca después).
- `ACTIVE`: vence a los **N días naturales** (`payments.oxxo_active_voucher_days`, **D3**), con la
  semántica de Stripe: `expires_after_days = N` vence a las 23:59 de Ciudad de México del día N.
  Acotado al mínimo de 1 y al máximo de `MAX_OXXO_EXPIRES_AFTER_DAYS` del adaptador.
- Si D4 limita los abonos a la fecha límite de pago, N también se acota al fin de ese día de
  calendario en la zona de la organización. Si no cabe un día completo → `WINDOW_TOO_SHORT`.
- Una ficha de `ACTIVE` que vence **no libera ningún lugar**: sólo cierra el pago (`EXPIRED`, aviso
  `VOUCHER_EXPIRED`, por el webhook de hoy).
- **El puerto cambia de significado, no de forma.** `PaymentIntentRequest.voucherExpiresAt` deja de
  ser «siempre el apartado» y pasa a ser «el instante que la ficha nunca rebasa»; quien lo decide es
  el dominio (apartado para `HELD`, N días para `ACTIVE`). La garantía del contrato del proveedor
  («nunca después de lo pedido») no cambia.
- **Límite por ficha:** Stripe documenta un máximo por transacción para OXXO, del orden de
  $10,000.00 MXN (**a verificar** contra la cuenta real). Un abono mayor responde
  `PAYMENT_METHOD_UNAVAILABLE` (`ABOVE_PROVIDER_LIMIT`). **D10** decide si además se ofrece
  partirlo. Esto también afecta hoy a `FULL` por OXXO en viajes caros (Brasil, Colombia).
- Si mientras una ficha de `HELD` está pendiente la reserva pasa a `ACTIVE` por otro pago, la ficha
  conserva su vencimiento original (el del apartado) y se puede pagar hasta entonces; el excedente,
  si lo hay, cae en §5.3.

### 5.5 SPEI

Todo lo que sigue sobre el comportamiento de Stripe está **sin verificar** contra una cuenta real,
igual que el adaptador actual (`libs/payments-stripe/README.md`). Por eso **D6** propone entregarlo
apagado por configuración hasta verificarlo en modo de prueba.

- **Customer de Stripe.** `customer_balance` exige un Customer. Columna nueva
  `customer_profiles.stripe_customer_id` (única, nula). Se crea al primer intento SPEI del viajero,
  **fuera** de toda transacción (llamada de red), con la clave de idempotencia de Stripe derivada
  del id del cliente, y se guarda después con una escritura condicional (`WHERE stripe_customer_id
  IS NULL`), así dos intentos simultáneos no crean dos Customers.
- **El intento** se crea y se confirma en el servidor (`payment_method_data[type]=customer_balance`,
  `funding_type=bank_transfer`, `mx_bank_transfer`). De `next_action.display_bank_transfer_instructions`
  se toman CLABE, referencia, banco, monto pendiente y la URL de instrucciones alojada por Stripe, y
  se devuelven en `bankTransfer` (§4.1).
- **Se guarda** en las columnas que ya existen: `provider_voucher_url` = URL de instrucciones,
  `voucher_expires_at` = nuestra vigencia. Sin columnas nuevas en `payments`.
- **Vigencia de la referencia.** La CLABE de `mx_bank_transfer` es del Customer y, según Stripe, no
  caduca (**a verificar**). Lo que caduca es **nuestro intento**: en `HELD`, con el apartado
  (`expireHolds`); en `ACTIVE`, a las **N horas** de `payments.spei_active_lifetime_hours` (**D5**),
  mediante el job de §9.
- **Fondos parciales.** Si el viajero transfiere menos, Stripe deja el intento esperando el resto
  (`payment_intent.partially_funded`, **a verificar**). Para nosotros **no se mueve dinero** hasta
  `succeeded`, y se avisa al viajero cuánto falta (`TRANSFER_PARTIALLY_FUNDED`, nuevo).
- **Fondos de más, o después de vencer.** El dinero que no cabe en un intento abierto se queda en el
  saldo de efectivo del Customer **dentro de Stripe**, fuera de nuestros libros. La conciliación
  automática de Stripe puede aplicarlo a otro intento abierto del mismo Customer; ése llega por el
  webhook normal y es correcto (es dinero del mismo viajero). Lo que quede sin aplicar se avisa al
  personal (`customer_cash_balance_transaction.created` → `CASH_BALANCE_UNAPPLIED`, nuevo, por
  `notifyAdmins`), porque devolverlo o aplicarlo es decisión humana desde el panel de Stripe. Nunca
  se registra como `Payment` sin un intento detrás.
- **Límites del proveedor**, como en §5.1, paso 5.

### 5.6 Tarjeta: un intento abierto por reserva

Un intento de tarjeta que el viajero abrió y no confirmó se queda `PENDING` para siempre y ensucia
el historial («Pendiente» sin ficha ni nada que hacer). Con abono libre, abrir y abandonar intentos
es más probable.

- Al crear un intento `CARD`, después del commit, se cancelan en el proveedor los demás intentos
  `CARD` `PENDING` de la misma reserva (el mismo cierre de `payment-intent-cancellation.ts`, mejor
  esfuerzo: un fallo sólo se registra). Si uno de ellos ya cobró, Stripe rechaza la cancelación y
  el webhook lo registra; el excedente cae en §5.3.
- OXXO y SPEI **no** se cancelan al crear otro intento: el viajero puede tener la ficha impresa.
- Un intento `CARD` `PENDING` más viejo que `payments.card_intent_stale_hours` (**D9**) lo cancela
  el job de §9.

### 5.7 Dinero que llega tarde o después de vencer

| Situación | Resultado | ¿Cambia? |
|---|---|---|
| Reserva viva, monto ≤ saldo | Se aplica; folio; `PAYMENT_CONFIRMED` | No |
| Reserva viva, monto > saldo (dos fichas, ficha + tarjeta, liquidada por otro camino, bajada de precio en medio) | Se divide; `OVERPAYMENT`; `PAYMENT_EXCESS_CREDITED` | **Sí** (§5.3) |
| Apartado vencido (`EXPIRED`) | Se registra, `paid_cents` sube, sin saldo a favor; `PAYMENT_AFTER_EXPIRY` + `ORPHAN_PAYMENT` | No |
| Reserva `CANCELLED` | Todo el monto a saldo a favor (`CANCELLATION`); `PAYMENT_AFTER_CANCELLATION` + `ORPHAN_PAYMENT` | No |
| La fila ya era `EXPIRED`/`FAILED` (nosotros la cerramos, Stripe cobró igual) | `INVALID_STATUS_TRANSITION` → `ORPHAN_PAYMENT`, decisión humana | No (se vuelve más probable con el job de §9; ver §14) |
| Después de la fecha límite de pago o de la salida del viaje | Se acepta como cualquier abono | Sujeto a **D4** |
| SPEI transferido después de vencer nuestro intento | Queda en Stripe; `CASH_BALANCE_UNAPPLIED` al personal | **Nuevo** (§5.5) |

### 5.8 Mensualidad sugerida

La fórmula no cambia (`payments.md`, «Mensualidad sugerida»), salvo un tope inferior: **nunca menor
que el mínimo vigente** (salvo que el saldo sea menor):

```
suggested_monthly_cents = min(saldo, max(redondeo_arriba(saldo / max(meses, 1)), mínimo_vigente))
```

Es la misma razón que ya justifica el tope superior: sugerir un monto que la propia API rechaza
(`PAYMENT_BELOW_MINIMUM`) es peor que sugerir uno raro. Toca `instalment.ts` y sus pruebas.

---

## 6. Webhook: la idempotencia no se toca

### 6.1 Lo que se conserva tal cual

- La fila de `stripe_events` se inserta **primero y dentro** de la transacción; una violación de
  `stripe_events_pkey` es «ya procesado» → 200 sin efecto. Un efecto fallido revierte todo, fila de
  `stripe_events` incluida.
- La transición `PENDING → SUCCEEDED` sigue condicionada a `status = 'PENDING'`: de dos entregas,
  sólo la que gana la actualización aplica dinero, toma folio, encola recibo y escribe el
  `OVERPAYMENT`.
- Un intento, un pago (`payments_provider_intent_id_key`).
- Un tipo de evento desconocido responde 200 y no hace nada.

### 6.2 Lo que cambia: un solo orden de bloqueo

Hoy el webhook (`confirmPaymentWithin`) toma el **contador de folios** antes que la **reserva**
(`payment-service.ts:446-447`), y el efectivo y el saldo aplicado toman la **reserva** antes que el
**contador** (`recordPayment`, `payment-service.ts:262,290`; `credit-service.ts:280-306`). Un cobro
en mostrador y una confirmación de Stripe sobre la misma reserva, en el mismo instante, pueden
bloquearse mutuamente. PostgreSQL detecta el bloqueo y aborta uno: no se corrompe dinero, pero el
mostrador ve un error o Stripe reintenta. Con el `OVERPAYMENT` entra además el candado del cliente.

El orden único para todo camino de dinero queda así:

```
viaje (si aplica) → reserva → cliente (si hay saldo a favor) → contador de folios
```

En el webhook:

1. `INSERT stripe_events`.
2. Leer el `Payment` del intento **sin bloqueo**: sólo hace falta su `reservation_id`, que nunca
   cambia.
3. `SELECT … FROM reservations … FOR UPDATE`.
4. `UPDATE payments … WHERE status = 'PENDING'`, condicional. Si no gana: devolver el pago como está.
5. Calcular aplicado y excedente con el saldo leído en el paso 3; mover `paid_cents`; activar.
6. **Todo movimiento de saldo a favor del webhook va aquí, antes del folio**: el `OVERPAYMENT` de
   una reserva viva y también el `CANCELLATION` de una reserva cancelada (que hoy se escribe
   *después* del folio, en `applySucceeded`). Candado del cliente y movimiento.
7. Folio (`assignReceiptNumber`) **al final**, y la foto del saldo del recibo.
8. Encolar el recibo y el aviso (misma transacción, Regla 11).

El paso 6 importa por sí solo: `applyCreditToReservation` toma cliente → contador, y una rama
`CANCELLED` que tomara contador → cliente podría bloquearse con ella si el mismo viajero aplica saldo
en el mostrador mientras llega un pago tardío de otra reserva suya.

### 6.3 Red de seguridad del excedente

Índice único parcial `customer_credit_entries (payment_id) WHERE kind = 'OVERPAYMENT'`. El camino
normal nunca lo toca (sólo la entrega que gana el paso 4 llega al paso 6), pero si alguna vez dos
escrituras lo intentaran, una falla y revierte todo, en vez de acreditar dos veces.

### 6.4 Eventos nuevos

| Evento | Efecto | Aviso |
|---|---|---|
| `payment_intent.succeeded` con excedente | §5.3 | `PAYMENT_EXCESS_CREDITED` |
| `payment_intent.partially_funded` (SPEI) | Ninguno sobre el dinero | `TRANSFER_PARTIALLY_FUNDED` al viajero |
| `customer_cash_balance_transaction.created` (SPEI, fondos sin aplicar) | Ninguno | `CASH_BALANCE_UNAPPLIED` al personal |

Los dos últimos dependen de D6 y están **a verificar** en modo de prueba. Si Stripe no los emite como
se describe, se ajusta este cuadro antes de implementar SPEI, no durante.

---

## 7. Conciliación nocturna y recibos

### 7.1 `reconcilePaidCents`

La verdad contra la que se compara `paid_cents` resta también el excedente, en la **misma
sentencia** (una sola instantánea, como hoy):

```
actual = Σ pagos SUCCEEDED − Σ PRICE_DECREASE − Σ OVERPAYMENT   (de esa reserva)
```

Sin esa resta, cada sobrepago dispararía un `PAID_CENTS_MISMATCH` falso todas las noches. Sigue sin
corregir nada por su cuenta y sigue sin ser idempotente, a propósito.

### 7.2 Recibos

- **Un folio por pago**, se divida o no. El recibo es del dinero que llegó.
- Monto del recibo = `amount_cents` (lo recibido). Foto del saldo = `receipt_paid_cents` **después
  de aplicar sólo la parte que cupo**, y `receipt_total_cents`, como hoy.
- Línea nueva, sólo si hubo excedente: «De este pago, $Z quedó como saldo a favor». `ReceiptData`
  gana `creditedCents` (0 por omisión). Se lee del movimiento `OVERPAYMENT` con ese `payment_id`,
  escrito en la misma transacción que el folio y nunca editado (los movimientos son un libro), así
  que es tan estable como la foto del saldo. Bilingüe, en `libs/receipts`.
- Un PDF ya generado no cambia (`ensureReceiptPdf` sin cambios).

### 7.3 Para los reportes de la Fase 3B

El excedente **es ingreso recibido** (está en `amount_cents` de un pago `SUCCEEDED` no `CREDIT`) y a
la vez un saldo a favor que la agencia debe. Cuando después se aplique a otra reserva, ese pago
`CREDIT` ya está excluido de ingresos (`payments.md`), así que no se cuenta dos veces.

---

## 8. Modelo de datos

| Cambio | Detalle |
|---|---|
| `CreditEntryKind` + `OVERPAYMENT` | Movimiento positivo, automático, con `reservation_id` y `payment_id` |
| Índice único parcial | `customer_credit_entries (payment_id) WHERE kind = 'OVERPAYMENT'`, SQL crudo en la migración, como los otros índices parciales |
| `customer_profiles.stripe_customer_id` | `String?`, `@unique`, `@map("stripe_customer_id")` |
| `SystemSetting` nuevas | `payments.min_installment_cents` (D1), `payments.oxxo_active_voucher_days` (D3), `payments.spei_active_lifetime_hours` (D5), `payments.spei_enabled` (D6), `payments.card_intent_stale_hours` (D9). Sembradas por `pnpm db:seed` con los valores que decida el dueño |
| `payments` | Sin columnas nuevas: SPEI reutiliza `provider_voucher_url` y `voucher_expires_at` |
| Avisos | `PAYMENT_EXCESS_CREDITED`, `TRANSFER_EXPIRED`, `TRANSFER_PARTIALLY_FUNDED` (viajero) y `CASH_BALANCE_UNAPPLIED` (personal), con plantillas `es` y `en` |
| Errores | `PAYMENT_BELOW_MINIMUM`, `PAYMENT_METHOD_UNAVAILABLE`, `NOTHING_DUE` |

---

## 9. Trabajos en segundo plano

**`expireStalePaymentIntents`** (`apps/worker/src/jobs/expire-stale-payment-intents.ts`), función
pura del cliente de base, del proveedor y de la cola, como los demás. `main.ts` sólo la agenda (cada
hora).

- Candidatos, todos `PENDING` con `provider_intent_id`:
  - SPEI de reservas **`ACTIVE`** con `voucher_expires_at < ahora` (los de una `HELD` los cierra
    `expireHolds` al vencer el apartado);
  - tarjeta de reservas `HELD` o `ACTIVE` con `recorded_at` más viejo que
    `payments.card_intent_stale_hours` (un apartado puede durar más que esa vigencia).

  OXXO no: Stripe vence la ficha solo y el webhook ya lo atiende.
- Por cada uno, en su transacción: `UPDATE payments SET status = 'EXPIRED' WHERE id = … AND status =
  'PENDING'`. Sólo si la actualización ganó, encola `TRANSFER_EXPIRED` (SPEI; la tarjeta abandonada
  no se avisa). Después del commit, `cancelIntent` en el proveedor, mejor esfuerzo, como
  `expireHolds`.
- **Idempotente**: una segunda corrida no encuentra la fila en `PENDING`. El `payment_intent.canceled`
  que llega después encuentra la fila cerrada y no hace nada (`closePendingPayment`, sin cambios).
- Si Stripe cobró justo antes de la cancelación: la fila ya está `EXPIRED`, el `succeeded` cae en
  `INVALID_STATUS_TRANSITION` y escala a una persona (§5.7). Es el comportamiento vigente para
  `expireHolds`; aquí se vuelve un poco más probable (§14).

---

## 10. Documentación viva

Va **en el mismo commit** que cada parte del código, como exige `CLAUDE.md`.

**`docs/business-rules/payments.md`**
- «Un pago pendiente no reduce el saldo»: el sobrepago ya no queda pendiente de la 2B; remite a la
  sección nueva.
- «Umbral del anticipo»: `DEPOSIT_BELOW_MINIMUM`.
- «Confirmación e idempotencia» y «El webhook de Stripe»: el orden de bloqueo único (§6.2) y la
  tabla de eventos con las filas nuevas.
- «Crear un Payment Intent»: reformulada como «el cliente propone, el servidor dispone»; `AMOUNT`;
  mínimos y máximos; límites del proveedor.
- «La ficha de OXXO nunca sobrevive al apartado»: queda la regla de `HELD` y se añade la vigencia
  propia en `ACTIVE`.
- «Mensualidad sugerida»: el tope inferior.
- «`reconcilePaidCents`»: resta `OVERPAYMENT`.
- «Saldo a favor: las reglas»: fila `OVERPAYMENT` en la tabla y la invariante nueva.
- «Recibos en PDF»: la línea del excedente.
- «Errores» y «Qué vive dónde».
- Secciones nuevas: «Abono libre», «Sobrepago confirmado», «SPEI» e «Intentos vencidos sin
  apartado».

**`docs/diagrams/payment-flow.md`**
- «El recorrido completo»: la nota «El monto lo decide el backend» pasa a «el cliente propone, el
  backend valida».
- «Tres métodos, tres tiempos»: `AMOUNT`, la vigencia de OXXO en `ACTIVE`, SPEI con Customer,
  instrucciones y vigencia. Se quita el párrafo «SPEI está en la API… pero no en la app» cuando SPEI
  se encienda.
- «La conciliación nocturna»: resta `OVERPAYMENT`.
- Diagramas nuevos: «Confirmación con excedente» (flowchart) y «Un solo orden de bloqueo»
  (secuencia: webhook y efectivo sobre la misma reserva).

**También:** `docs/diagrams/customer-credit.md` (movimiento `OVERPAYMENT`),
`docs/business-rules/notifications.md` (los cuatro avisos nuevos; se toca
`libs/domain/notifications`), `libs/payments-stripe/README.md` (Customer para SPEI, OXXO en
`ACTIVE`) y un registro de decisiones que deje la decisión 1 de la 2A como reemplazada por §2.

---

## 11. Estrategia de pruebas

La misma de la 2A y la 2B: cada prueba se ve fallar antes de implementar, integración contra
PostgreSQL real (schema por worker en `rm_test`) y **mutación deliberada** en lo crítico, para
comprobar que la prueba de verdad detecta el error.

**Unitarias**
- Mínimo y máximo, en tabla: `HELD`/`ACTIVE` × debajo / igual / encima del mínimo × saldo menor
  que el mínimo × límites del proveedor.
- Mensualidad sugerida con el tope inferior.
- Vencimiento de OXXO en `ACTIVE` con la semántica de días de Stripe, incluido el acotamiento por
  fecha límite si D4 lo pide.
- El esquema Zod: `AMOUNT` sin `amountCents`, `FULL` con `amountCents`, montos no enteros.

**Integración (dominio con PostgreSQL y `FakePaymentProvider`)**
- Cada código de error de §4.3.
- Confirmación: exacto, con excedente, con saldo ya en cero (todo a saldo a favor), y las ramas
  `EXPIRED` y `CANCELLED` sin cambios.
- `recordIfMissing` con excedente: se divide en vez de escalar.
- `reconcilePaidCents` sin alerta falsa tras un sobrepago, y con alerta si se rompe `paid_cents` a
  mano.
- `ReceiptData.creditedCents`.
- `expireStalePaymentIntents` corrido dos veces seguidas: el mismo resultado.
- SPEI con el proveedor falso: Customer creado una sola vez con dos intentos simultáneos.

**Concurrencia** (cada caso repetido 30 veces, como `revival.spec.ts` y `expire-holds.spec.ts`)

1. Dos `succeeded` de **intentos distintos** de la misma reserva a la vez, que juntos exceden el
   saldo: se aplica exactamente el saldo, el excedente se acredita una vez, `paid_cents ≤ total`, y
   la invariante de §5.3 se cumple.
2. El **mismo evento** entregado dos veces a la vez: dinero aplicado una vez, a lo más un
   `OVERPAYMENT`. Es la prueba vigente «never lets a simultaneous redelivery reach the effect»,
   que debe seguir pasando sin tocarla.
3. Dos eventos con distinto `evt_` para el **mismo intento**: un folio, un recibo, un movimiento.
4. Webhook contra **efectivo en mostrador** sobre la misma reserva: los dos terminan, sin bloqueo
   mutuo. Mutación: devolver el folio antes de la reserva en el webhook y ver fallar la prueba.
5. Webhook contra **saldo aplicado** sobre la misma reserva: el saldo a favor nunca negativo, la
   invariante se cumple.
6. Webhook contra **bajada de precio** (`applyPriceChange`): ningún peso acreditado dos veces.
7. Webhook contra **`expireHolds`** sobre una `HELD` con abono parcial: la prueba vigente, más la
   variante con excedente.
8. Webhook contra **`expireStalePaymentIntents`**: o `SUCCEEDED` (el job no hace nada) o `EXPIRED` +
   escalamiento; nunca dinero aplicado sobre una fila `EXPIRED`.
9. **Crear un intento** validado contra un saldo que una confirmación simultánea reduce: el
   excedente cae en §5.3.

**Mutaciones obligatorias:** quitar el `min()` del reparto (falla 1); quitar la resta de
`OVERPAYMENT` en la conciliación (falla su prueba); quitar el índice parcial (falla 2 con una
inyección deliberada de doble escritura).

**Adaptador de Stripe:** `runPaymentContract` gana OXXO con vencimiento propio, SPEI con Customer e
instrucciones, y los límites por método. Las respuestas de Stripe se prueban con cuerpos grabados del
modo de prueba (sin red en CI). Lista de verificación manual en modo de prueba antes de encender
SPEI (D6): instrucciones, fondos parciales, fondos de más, transferencia después de cancelar, CLABE
reutilizada.

**API:** pruebas de ruta para la unión discriminada y los códigos de §4.3. No hay E2E de pantalla
aquí: la UI llega con el rediseño.

---

## 12. Fuera de alcance

- Las pantallas (rediseño de la Fase 3), incluida la de la ficha pendiente que el inventario
  señaló.
- Pagar con saldo a favor desde la app: el saldo lo administra el personal (decisión del dueño,
  2026-10-07, `payments.md`).
- Aplicar automáticamente un excedente a otra reserva del mismo viajero.
- Reembolsos por Stripe, CFDI y otras monedas.
- Recordatorio del día 28 y alerta del 40 % (Fase 3A), aunque los dos dependen de esto.

## 13. Requisitos externos

| Requisito | Bloquea | Sin él |
|---|---|---|
| Claves de prueba de Stripe con OXXO y `customer_balance` (`mx_bank_transfer`) habilitados | Verificar SPEI (D6), los límites de OXXO y los eventos de §6.4 | Tarjeta y OXXO se construyen y prueban con el proveedor falso; SPEI queda apagado |

## 14. Riesgos

| Riesgo | Mitigación |
|---|---|
| Sobrepagos más frecuentes | Reparto bajo candado, `OVERPAYMENT` idempotente, conciliación que lo descuenta, pruebas 1 a 3 |
| Bloqueo mutuo webhook / mostrador | Orden único de candados (§6.2), prueba 4 con mutación |
| Más pagos cobrados sobre filas que cerramos nosotros (job de §9) | Mismo camino que `expireHolds`: escala a una persona; vigencias holgadas (D5, D9). La alternativa (aceptar el dinero sobre una fila `EXPIRED`) deshace una decisión tomada en otro lado y no se propone |
| SPEI se comporta distinto de lo documentado | Apagado por configuración hasta verificarlo (D6); §6.4 se corrige antes de implementar |
| Dinero de SPEI que queda en Stripe, fuera de los libros | Aviso `CASH_BALANCE_UNAPPLIED` al personal; nunca un `Payment` sin intento |
| Abonos minúsculos llenan avisos y recibos | Mínimo configurable (D1) |
| Romper la app actual | `FULL` y `DEPOSIT` no cambian de significado |

---

## 15. Decisiones del dueño (2026-10-07)

Se presentaron como decisiones abiertas, cada una con una recomendación de Echo. **El dueño del
producto aprobó las diez tal como se recomendaron, el 2026-10-07** (respuesta recibida a través de
Alpha). La columna «Decisión» es, por lo tanto, la decisión vigente.

| # | Pregunta | Decisión | Por qué |
|---|---|---|---|
| **D1** | ¿Cuál es el **monto mínimo de un abono** sobre una reserva `ACTIVE`? (Si se debe menos, el mínimo es lo que se debe.) | **$300.00 MXN**, editable en configuración | Cada abono genera un recibo, un aviso y una comisión fija del proveedor. A $300 la parte fija pesa poco, y sigue siendo alcanzable para un mochilero |
| **D2** | Sobre un apartado (`HELD`), ¿el abono debe cubrir **por lo menos lo que falta del anticipo**? | **Sí** | Un abono menor no asegura el lugar: el apartado vence igual y el dinero se vuelve saldo a favor. El viajero cree que «ya abonó» y pierde el lugar |
| **D3** | ¿Cuántos días dura una **ficha de OXXO** sobre una reserva `ACTIVE`? | **3 días naturales** (vence a las 23:59 de CDMX del tercer día) | Es el plazo por omisión de Stripe para OXXO y deja un fin de semana de margen |
| **D4** | ¿Se aceptan abonos en línea **después de la fecha límite de pago**? ¿Y una ficha puede vencer después de esa fecha? | **Sí a las dos**: no acotar por la fecha límite | Hoy ningún camino rechaza dinero tardío; rechazarlo no ayuda a cobrar y obliga al viajero a ir al mostrador |
| **D5** | ¿Cuánto dura una **referencia SPEI** sobre una reserva `ACTIVE`? (En `HELD` vence con el apartado.) | **72 horas** | La misma ventana que OXXO (D3): una sola regla que explicar. Una transferencia SPEI liquida en minutos en día hábil |
| **D6** | ¿SPEI se entrega **junto** con tarjeta y OXXO, o **apagado** hasta verificarlo en modo de prueba de Stripe? | **En la misma entrega de código, apagado** (`payments.spei_enabled = false`) hasta pasar la lista de verificación de §11 | Todo el comportamiento de SPEI está sin verificar; tarjeta y OXXO no dependen de él |
| **D7** | Cuando el dinero confirmado **excede lo que se debía**, ¿pasa **automáticamente a saldo a favor** (con aviso al viajero), o queda para que una persona decida? | **Automático a saldo a favor**, con aviso `PAYMENT_EXCESS_CREDITED` | Extiende tu decisión de la 2B para cancelaciones («el dinero se vuelve saldo a favor»). Dejarlo a una persona deja dinero invisible, que es lo que pasa hoy |
| **D8** | ¿Se limita cuántas **fichas OXXO o referencias SPEI abiertas** puede tener una reserva a la vez? | **Sin límite** | Con D7, una ficha de más nunca pierde dinero, y un límite dejaría atorado a quien imprimió una ficha y prefiere pagar con tarjeta |
| **D9** | ¿Después de cuántas horas se cancela un **intento de tarjeta abandonado**? (Técnica; se puede dejar el valor recomendado.) | **24 horas** | Ningún pago con tarjeta legítimo tarda tanto; evita «Pendiente» sin acción en el historial |
| **D10** | Si un abono por OXXO **supera el máximo por ficha de Stripe** (del orden de $10,000 MXN, a verificar), ¿se rechaza o se parte en varias fichas? | **Se rechaza** con un mensaje que lo explique | Con abono libre el viajero ya puede elegir un monto menor; partir fichas multiplica pendientes y casos de §5.7 |
