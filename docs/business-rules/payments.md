# Pagos

Implementado en `libs/domain/payments`. Corresponde a §5.4 y §5.5 de
`docs/superpowers/specs/2026-10-03-fase-2a-reservas-y-pagos-diseno.md`.

Todo el dinero es `Int` en centavos MXN. No hay un solo `Float` en el camino,
y la única división en coma flotante del módulo —la de la mensualidad
sugerida— produce un valor que se recalcula en cada lectura y **nunca llega a
una columna**.

## Saldo

```
balance_cents = total_price_cents − paid_cents        (nunca negativo)
```

`paid_cents` está desnormalizado a propósito y lo mueve **la misma
transacción** que escribe el `Payment` que lo causa. La verdad son siempre las
filas de `payments`; la conciliación nocturna (`reconcilePaidCents`, ver más
abajo) compara la suma de los pagos `SUCCEEDED` contra `paid_cents` y avisa si
se desvían. Un pago registrado sin mover `paid_cents`, o al revés, es
desviación permanente.

El saldo a favor **no** vive en la reserva: la Fase 2B eliminó
`reservations.credit_cents` (que siempre valió 0) y lo llevó a un libro de
movimientos por cliente, `customer_credit_entries` (ver «Saldo a favor» más
abajo). Aplicar saldo a una reserva es un `Payment` más, con método `CREDIT`,
así que `paid_cents` sigue siendo exactamente la suma de pagos `SUCCEEDED`.

## Un pago pendiente no reduce el saldo

Un `Payment` en `PENDING` —la ficha de OXXO es el caso de siempre— se registra
y **no toca `paid_cents`**. La app lo muestra como pendiente, con su ficha
descargable y su plazo, y advierte que el lugar se libera si no se confirma a
tiempo.

Es la regla que sostiene toda la experiencia de OXXO: el dinero no existe
hasta que el proveedor lo confirma, y el cupo tampoco se compromete por una
ficha impresa.

Consecuencia aceptada: como las fichas pendientes no reducen el saldo, pueden
emitirse dos por el total y confirmarse las dos. Eso genera un sobrepago.
Registrarlo igual es lo correcto —dinero que se movió tiene que verse—;
rechazar la segunda confirmación dejaría un cobro real sin asiento contable.
Lo que excede el saldo se vuelve saldo a favor del cliente: ver «Sobrepago
confirmado» más abajo.

## Registro de un pago

`recordPayment(tx, …)` recibe la transacción de quien lo llama (el webhook de
Stripe hoy, el cobro en sucursal y la importación CSV en la 2B) y nunca abre
la suya. Dentro de esa transacción:

1. El monto debe ser un entero de centavos **mayor que cero**.
2. Si trae `provider_intent_id`, no puede existir ya otro pago con ese intento
   → `CONFLICT`. Se comprueba **antes** que el saldo: un reenvío es un
   duplicado diga lo que diga el saldo, y el orden contrario respondería
   `PAYMENT_EXCEEDS_BALANCE` a la segunda entrega de un pago que ya liquidó la
   reserva — "este pago está mal" cuando la verdad es "este pago ya está".
3. Se bloquea la fila de la reserva (`SELECT … FOR UPDATE`) y sólo después se
   lee el saldo. Sin el bloqueo, dos pagos simultáneos leen el mismo saldo,
   los dos caben y la reserva queda pagada de más.
4. El monto no puede superar `balance_cents` → `PAYMENT_EXCEEDS_BALANCE`.
   **Salvo** el dinero que Stripe ya cobró (`excessToCredit`, sólo desde el
   webhook): ése nunca se rechaza por exceder el saldo; el excedente se vuelve
   saldo a favor (ver «Sobrepago confirmado»).
5. Se inserta el `Payment`. `paid_at` es la fecha en que el dinero se movió —
   se rellena con "ahora" para un pago que nace `SUCCEEDED` y queda nulo
   mientras esté `PENDING`—, separada de `recorded_at`, que es cuándo se
   capturó. Los reportes leen `paid_at`, así que un pago de marzo capturado en
   septiembre aparece en marzo.
6. Si el pago nace `SUCCEEDED`, se liquida (`settleConfirmedPayment`, abajo):
   lo que cabe se aplica al saldo y el excedente, si lo hay, va al saldo a
   favor. Después, **al final**, recibe su folio (ver «Orden de bloqueo»).
7. Se escribe la entrada de auditoría `payment.recorded`.

**El estado de la reserva no se comprueba.** Un pago de una reserva
`CANCELLED` o `EXPIRED` se registra igual; lo que no hace es cambiarle el
estado (ver el caso límite más abajo).

## Umbral del anticipo: de `HELD` a `ACTIVE`

Al aplicarse un pago confirmado:

```
aplicado = min(amount_cents, balance_cents)      -- ver «Sobrepago confirmado»
paid_cents += aplicado

si reserva.status = 'HELD' y paid_cents >= minimum_deposit_cents:
    status := 'ACTIVE'  y  hold_expires_at := NULL     (en el mismo UPDATE)
```

El umbral es acumulado, no por pago: dos abonos de 400.00 y 600.00 cubren un
anticipo de 1,000.00 igual que uno solo.

Anular `hold_expires_at` **en la misma sentencia** no es cosmético. La
restricción `reservations_held_requires_hold_expiry` sólo obliga en una
dirección (`HELD` ⇒ expiración no nula), así que una reserva `ACTIVE` que
conservara su expiración es un estado que la base acepta y que el dominio
considera un sinsentido: un lugar tomado que sigue contando hacia atrás.

Un pago que no alcanza el anticipo deja la reserva en `HELD` con su apartado
corriendo. No hay anticipo "parcial" que cambie nada.

### Tarea 8: la activación es `updateMany`, no `update` por `id`

La segunda escritura (`HELD` → `ACTIVE`) se hizo `updateMany({ where: { id,
status: 'HELD' }, ... })` a partir de la Tarea 8, en vez del `update` por
`id` a solas que tenía desde la Tarea 5. Es un refuerzo, no la corrección de
un error demostrable: la primera escritura de `applyConfirmedPayment` ya
relee la fila bajo el bloqueo que esta misma función (o `recordPayment`,
según el camino) sostiene durante toda la transacción, y el `if` que guarda
la segunda escritura ya se niega a dispararse salvo que esa lectura fresca
diga `HELD` — ninguna secuencia de eventos, concurrente o no, logró que el
`update` sin condición se comportara distinto del `updateMany` condicional
(la prueba "does not resurrect..." en `payment-service.spec.ts` pasa contra
el código viejo también). Se escribe así de todos modos porque `expireHolds`
(`apps/worker`, Tarea 8) es el primer otro escritor que compite de verdad por
esta misma fila, y esta forma es correcta **por su propia cláusula `WHERE`**
en vez de serlo sólo porque alguna otra función sostiene un bloqueo durante
un tiempo determinado — el mismo criterio que ya usa la transición
`PENDING` → `SUCCEEDED` de `confirmPayment`, dos párrafos más abajo.

La mitad complementaria de esta misma garantía — que `expireHolds` tampoco
pueda resucitar ni atropellar una reservación que un pago concurrente ya
activó — vive del otro lado, en `expireHolds` mismo
(`docs/business-rules/reservations.md`, "Los jobs de fondo"), con su propia
prueba de concurrencia forzada.

## Confirmación e idempotencia

`confirmPayment(db, { providerIntentId, paidAt })` abre su propia transacción,
busca el `Payment` de ese intento y lo pasa de `PENDING` a `SUCCEEDED`,
aplicando el dinero con el mismo código que usa `recordPayment`.

Stripe reenvía webhooks, y dos entregas del mismo `payment_intent.succeeded`
pueden estar en vuelo a la vez. Dos mecanismos, y el segundo es el que
importa:

1. **Un intento, un pago.** El índice único `payments_provider_intent_id_key`
   sobre `provider_intent_id` lo garantiza pase lo que pase. La columna es
   nula para el efectivo en mostrador y para el histórico retroactivo, y
   PostgreSQL mantiene los nulos distintos en un índice único, así que esas
   filas nunca chocan entre sí. `recordPayment` además consulta antes de
   insertar, para responder `CONFLICT` en vez de abortar la transacción de
   quien llama; esa consulta es el camino normal y el índice es la red, porque
   una comprobación previa no puede ver la fila que otra transacción todavía
   no ha confirmado.
2. **La transición es condicional.** El `UPDATE` lleva `status = 'PENDING'` en
   su `WHERE`. Bajo READ COMMITTED la segunda confirmación espera el bloqueo
   de fila, reevalúa esa condición contra la fila ya confirmada y no encuentra
   nada que actualizar, así que no aplica dinero. Leer el estado y después
   escribir sin condición dejaría que dos entregas que leyeron `PENDING` las
   dos pagaran las dos.

La segunda confirmación **no es un error**: devuelve el pago tal como quedó,
para que el webhook pueda responder 200 y Stripe deje de reintentar. Vale la
primera, con su `paid_at` y su única entrada de auditoría
`payment.confirmed`.

Un pago `FAILED`, `EXPIRED` o `REFUNDED` no se puede confirmar →
`INVALID_STATUS_TRANSITION`. Esos estados los decide otro camino y un evento
`succeeded` no los deshace en silencio.

Antes de la transición condicional, `confirmPaymentWithin` toma el candado de
la **reserva** del pago (lo lee sin candado para saber cuál; la reserva de un
pago nunca cambia). Así el saldo contra el que se reparte el dinero se lee bajo
el candado, y el orden de bloqueo es el de todos los caminos (abajo).

## Sobrepago confirmado (decisión D7 del dueño, 2026-10-07)

**El dinero que Stripe ya cobró nunca se rechaza por exceder el saldo, y
`paid_cents` nunca pasa de `total_price_cents`.** Al liquidar un pago
confirmado (`settleConfirmedPayment`), bajo el candado de la reserva:

```
aplicado  = min(monto, saldo)        -- saldo leído bajo el candado
excedente = monto − aplicado
paid_cents += aplicado
si excedente > 0 → movimiento OVERPAYMENT (+excedente, reservation_id, payment_id)
```

- La fila `Payment` conserva `amount_cents` = **todo lo que llegó**: es el
  dinero que se movió. Sólo la reserva se topa.
- Vale para los dos caminos del webhook: confirmar la fila `PENDING` y
  `recordIfMissing` (antes éste respondía `PAYMENT_EXCEEDS_BALANCE` y escalaba
  a una persona **sin registrar el pago**).
- Vale en cualquier estado de la reserva. En una `HELD` o `ACTIVE` el
  excedente es saldo a favor y lo aplicado cuenta como siempre. En una
  `CANCELLED`, lo aplicado también se acredita (`CANCELLATION`, como hasta
  ahora) y el excedente es `OVERPAYMENT`: entre los dos, todo el pago tardío
  queda como saldo a favor. En una `EXPIRED`, lo aplicado sigue siendo
  decisión humana (ver el caso límite de abajo) y sólo el excedente se
  acredita.
- **No cambia** para efectivo, saldo aplicado, captura histórica ni
  importación: ahí el monto lo teclea una persona y rechazarlo con
  `PAYMENT_EXCEEDS_BALANCE` sigue siendo lo correcto.
- Aviso al cliente: `PAYMENT_EXCESS_CREDITED` en lugar de `PAYMENT_CONFIRMED`
  cuando la reserva viva no pudo absorber todo el pago (ver
  `notifications.md`). Sin aviso al personal: el dinero ya quedó donde debe.
- **Una vez por pago.** Sólo la entrega que gana la transición
  `PENDING → SUCCEEDED` liquida el pago. El índice único parcial
  `customer_credit_entries_overpayment_payment_id_key` (`payment_id` donde
  `kind = 'OVERPAYMENT'`) es la red: una segunda escritura aborta la
  transacción en vez de acreditar dos veces.

Antes de esta regla, `confirmPaymentWithin` sumaba el monto completo a
`paid_cents` sin compararlo con el saldo: dos fichas pagadas por el total
dejaban `paid_cents` por encima del total, el saldo en cero, la conciliación
sin alerta (cuadraba contra los pagos) y el excedente **en ninguna parte**
como saldo a favor.

## Orden de bloqueo

Todo camino que mueve dinero toma sus candados en **un solo orden**, escrito en
un solo lugar del código («Lock order», al inicio de
`libs/domain/payments/src/lib/payment-service.ts`):

```
viaje  →  reserva  →  cliente  →  contador de folios
```

Una transacción toma sólo los que necesita, pero nunca uno anterior en la
lista a otro que ya tiene. El **contador de folios va siempre al final**: es
una fila por año que incrementa todo pago exitoso de cualquier reserva, el
candado más disputado del sistema, y retenerlo mientras se espera otro es lo
que convertía dos pagos sin relación en un bloqueo mutuo.

Hasta que se fijó este orden, el webhook pedía el folio **antes** de bloquear
la reserva, y en la rama de reserva cancelada acreditaba el saldo a favor
**después** del folio; el efectivo y el saldo aplicado hacían lo contrario.
Un cobro en mostrador y una confirmación de Stripe sobre la misma reserva, o un
saldo aplicado y un pago tardío de otra reserva del mismo cliente, se
bloqueaban mutuamente y PostgreSQL abortaba uno (`40P01`). Hoy el webhook
bloquea la reserva, mueve la fila del pago, acredita bajo el candado del
cliente y numera al final. Lo prueba `lock-order.spec.ts`.

## Caso límite: pago confirmado de una reserva ya expirada

Spec §5.3. Si llega la confirmación de una ficha de OXXO después de que el
apartado expiró:

- El pago se registra como `SUCCEEDED` y `paid_cents` sube, hasta el total
  de la reserva; lo que lo exceda es saldo a favor (`OVERPAYMENT`, ver
  «Sobrepago confirmado»).
- La reserva **no** se reactiva: sigue `EXPIRED`.
- Se avisa al cliente con `PAYMENT_AFTER_EXPIRY` y al administrador con
  `ORPHAN_PAYMENT`, en la misma transacción.

El dinero existe y debe verse; devolverlo o aplicarlo a otro viaje es decisión
humana. Ningún movimiento de dinero es automático.

> **Advertencia: este pago no se acredita** (salvo lo que exceda el total, que
> desde la decisión D7 es `OVERPAYMENT`; lo que sigue habla de la parte que sí
> cupo en la reserva). A diferencia de una reserva
> `CANCELLED` (cuyo pago tardío sí pasa al saldo, ver más abajo) y de lo que
> `expireHolds` acredita **al vencer** (decisión 16), un pago que llega **después**
> de que la reserva ya está `EXPIRED` queda registrado y **sube `paid_cents`,
> pero no genera ningún movimiento de saldo** (la rama `EXPIRED` del webhook
> sólo avisa y escala; no llama a `creditFromCancellation` ni a
> `creditFromExpiration`). Hay dos salidas, y la elección es del personal:
>
> - **Si se va a revivir la reserva** (decisión 13): **no se ajusta el saldo.**
>   Se cobra o se revive sobre la propia reserva (efectivo o saldo en el
>   mostrador, ver «Revivir con un cobro»): el pago tardío ya cuenta en su
>   `paid_cents` y sólo falta el resto del anticipo. Si se «devolviera» antes
>   con un `ADJUSTMENT` positivo y luego se revive, el mismo dinero contaría
>   dos veces: en el saldo del cliente y en el `paid_cents` de la reserva viva.
>   `reclaimCreditForRevival` sólo recupera lo que escribió el vencimiento
>   (`EXPIRATION`/`REVIVAL`); no sabe deshacer un `ADJUSTMENT`.
> - **Si NO se va a revivir** y hay que devolver el dinero: como ese pago
>   nunca llegó al saldo, un `REFUND` directo respondería
>   `CREDIT_INSUFFICIENT` —o, peor, si el cliente tiene otro saldo, gastaría
>   ése—. La secuencia correcta, en la misma gestión, es un `ADJUSTMENT`
>   **positivo** por la parte del pago tardío que cupo en la reserva (el
>   excedente ya es saldo a favor; con motivo, que nombre el pago)
>   y enseguida un `REFUND` por el mismo monto (con motivo, que diga cómo se
>   devolvió fuera del sistema). La reserva se queda `EXPIRED` y **ya no debe
>   revivirse**: su `paid_cents` seguiría contando ese dinero.
>
> Esta salida es deliberada y está fuera del alcance de la decisión 16 (la
> decisión del dueño fue no automatizarla); `docs/decisiones-fase-2b.md` lo
> deja anotado.

**Lo mismo para una reserva `CANCELLED` (Tarea 19).** Si el personal canceló
la reserva mientras una ficha o un intento de tarjeta seguían cobrables (la
cancelación los cancela en el proveedor, pero una ficha pagada en ese mismo
minuto, o una caída de Stripe, pueden llegar igual), el pago se registra, la
reserva sigue `CANCELLED`, el cliente recibe `PAYMENT_AFTER_CANCELLATION` y el
personal `ORPHAN_PAYMENT`. Una plantilla propia y no `PAYMENT_AFTER_EXPIRY`:
esa dice «tu apartado venció», que es falso para una reserva cancelada.

El aviso al cliente **no** es `PAYMENT_CONFIRMED`. Esa plantilla cita el saldo
restante y se leería como "sí vas"; a alguien cuyo lugar se liberó hay que
decirle lo que de verdad pasó: su dinero está registrado, el lugar no, y una
persona lo va a contactar. Las tres consecuencias —pago `SUCCEEDED`, reserva
intacta en `EXPIRED`, y los dos avisos— se comprueban por separado en
`webhook-handler.spec.ts`, porque es la regla más fácil de implementar a
medias.

## El webhook de Stripe: idempotencia por orden de inserción

`handleStripeEvent(db, queue, event)` (`libs/domain/payments/src/lib/webhook-handler.ts`)
aplica un evento **ya verificado**. La firma se comprueba antes, en el borde
HTTP (`apps/api/src/app/api/v1/webhooks/stripe/route.ts`), sobre los bytes
exactos que Stripe envió; cuando un evento llega aquí ya se sabe que viene de
Stripe, y lo que **no** se sabe es si ya se procesó.

### El orden dentro de la transacción es toda la regla

La fila de `stripe_events` se inserta **primero**, antes de cualquier efecto, y
una violación de su clave primaria (`stripe_events_pkey`) significa "este
evento ya se procesó": se sale sin efecto y se responde 200. Esa inserción
**es** el candado.

- **Al final**, dos entregas simultáneas pasan las dos la pregunta "¿ya lo vi?"
  y las dos ejecutan el efecto completo antes de que ninguna escriba su fila.
  La transacción sigue siendo atómica, así que el dinero no se duplica, pero
  la segunda entrega choca contra
  `payments_provider_intent_id_key` y responde `CONFLICT` —un no-2xx— a un
  reenvío perfectamente normal. Lo demuestra la prueba "never lets a
  simultaneous redelivery reach the effect at all": pasa con la inserción
  primero y falla con la inserción al final, mientras que **todas** las
  pruebas secuenciales pasan en los dos casos.
- **Fuera de la transacción** se abre otra ventana distinta: una caída entre
  la inserción y el efecto deja un evento marcado como procesado que nunca se
  aplicó, y el reintento de Stripe —que es lo único que podría arreglarlo— lo
  descartaría por duplicado.
- **Primero y dentro**, la segunda de dos entregas simultáneas se bloquea en
  el índice de la clave primaria hasta que la primera confirma o deshace, y
  entonces o encuentra la fila (descarta, nada se aplica dos veces) o inserta
  la suya (la primera deshizo, así que aplicar es exactamente lo correcto).

**Un fallo del efecto se lleva la fila de `stripe_events` con él.** El error
sale del callback como excepción para que `$transaction` deshaga todo; así no
queda nada marcado como procesado y el siguiente reenvío de Stripe arranca
limpio en vez de descartarse. Los avisos encolados con `notifyCustomer` /
`notifyAdmins` viven en esa misma transacción (Regla 11), así que también
desaparecen: nadie recibe un correo sobre un pago que no se registró.

### Qué eventos se atienden

| Evento | Efecto | Aviso |
|---|---|---|
| `payment_intent.succeeded` | Confirma o registra el pago, sube `paid_cents`, activa la reserva si alcanza el anticipo | `PAYMENT_CONFIRMED` al cliente |
| `payment_intent.succeeded` que excede el saldo de una reserva viva (decisión D7) | Pago `SUCCEEDED` completo; `paid_cents` sube hasta el total; el excedente es `OVERPAYMENT` | `PAYMENT_EXCESS_CREDITED` al cliente |
| `payment_intent.succeeded` sobre una reserva `EXPIRED` | Pago `SUCCEEDED`, reserva intacta (§5.3 arriba); lo que exceda el total, `OVERPAYMENT` | `PAYMENT_AFTER_EXPIRY` al cliente y `ORPHAN_PAYMENT` al personal |
| `payment_intent.succeeded` sobre una reserva `CANCELLED` (Tarea 19) | Pago `SUCCEEDED`, reserva intacta; todo el pago a saldo a favor (`CANCELLATION` lo que cupo, `OVERPAYMENT` el excedente) | `PAYMENT_AFTER_CANCELLATION` al cliente y `ORPHAN_PAYMENT` al personal |
| `payment_intent.succeeded` sin reserva a la que atarlo | Ninguno: un `Payment` necesita una reserva | `ORPHAN_PAYMENT` al personal, y **200** a Stripe |
| `payment_intent.payment_failed` | Pago a `FAILED`, el saldo no se mueve | `PAYMENT_FAILED` al cliente |
| `payment_intent.payment_failed` con `payment_intent_payment_attempt_expired` | Pago a `EXPIRED`, el saldo no se mueve | `VOUCHER_EXPIRED` al cliente |
| `payment_intent.canceled` | Pago a `EXPIRED`, el saldo no se mueve | Ninguno |
| Cualquier otro tipo | Ninguno | Ninguno |

Stripe no tiene un evento propio de "la ficha de OXXO venció": llega como un
`payment_intent.payment_failed` corriente, y el código
`last_payment_error.code = payment_intent_payment_attempt_expired` es lo único
que lo distingue de una tarjeta rechazada. La distinción importa —una ficha
vencida no es un pago rechazado— así que el puerto expone el código
(`OXXO_VOUCHER_EXPIRED_FAILURE_CODE`) en vez de juntar los dos casos.

`payment_intent.canceled` **no es una anomalía**: es justo lo que llega cuando
`expireHolds` cancela el intento de un apartado que acaba de vencer (Tarea 9).
Por eso no genera aviso: el cliente ya recibió su `HOLD_EXPIRED` (o `HOLD_EXPIRED_CREDIT`) del job que
provocó esta cancelación.

**Un tipo de evento que no manejamos responde 200 y no hace nada.** Stripe
reintenta ante cualquier respuesta que no sea 2xx, y devolver un error por un
evento que no nos interesa provoca reintentos eternos. La fila de
`stripe_events` se escribe igual: es la constancia de que esa entrega llegó.

### Un `succeeded` de un intento que no tenemos registrado

`confirmPayment` nació con una firma que sólo llevaba el id del intento y una
fecha, así que únicamente podía mover una fila que ya existiera: un
`payment_intent.succeeded` cuya fila `PENDING` nunca se confirmó respondía
`NOT_FOUND` y **el dinero no se registraba en ninguna parte**. Es el peor
desenlace posible: Stripe dice que cobró y nosotros no tenemos asiento.

`ConfirmPaymentInput.recordIfMissing` cierra eso. El webhook lo rellena con el
monto, el método y el `metadata[reservationId]` que `createIntent` siempre
pone en el intento, de modo que:

- si la fila existe, el camino es el de siempre (confirmarla);
- si no existe pero el intento dice de qué reserva es, se **registra** el pago;
- si no existe y el intento no dice de qué reserva es (un intento creado desde
  el panel de Stripe, por ejemplo), no hay nada que escribir —un `Payment`
  necesita una reserva—, así que se avisa a una persona con `ORPHAN_PAYMENT` y
  se responde **200**. Devolver un error sólo haría que Stripe reenviara para
  siempre un evento que nadie puede aplicar automáticamente.

### `recordPayment` nunca lanza un `P2002`

La comprobación previa de `provider_intent_id` no puede ver una fila que otra
transacción todavía no confirmó, así que dos entregas en vuelo a la vez la
pasan las dos y la perdedora choca contra `payments_provider_intent_id_key`.
Eso salía como una excepción `P2002` cruda; dentro de un webhook, una
excepción es un 500, y Stripe reintenta un 500 eternamente. Ahora se traduce a
`CONFLICT`.

**Cuando eso ocurre, la transacción de quien llama ya está abortada.**
PostgreSQL aborta la transacción ante una violación de restricción y nada en
la API de transacciones interactivas de Prisma lo deshace; la conversión sólo
existe para que el llamador pueda razonar sobre un `Result` en vez de atrapar
una excepción, y el llamador tiene que **deshacer**, no seguir escribiendo.
`handleStripeEvent` hace exactamente eso.

## Crear un Payment Intent (Tarea 14, §9 de la spec): el monto nunca lo decide el cliente

`createPaymentIntentForReservation(db, provider, input)`
(`libs/domain/payments/src/lib/payment-intent-service.ts`) es el punto de
entrada de todo el flujo de pago: lo que `POST
/reservations/{reservationId}/payment-intents` expone al cliente.

`input` no lleva un monto. Lleva un `intent`: `'FULL'` (saldar todo el
`balance_cents`) o `'DEPOSIT'` (lo que falta del anticipo mínimo,
`minimum_deposit_cents − paid_cents`, nunca negativo y nunca por encima del
propio saldo). El monto a cobrar se calcula aquí, a partir de la reserva, y
no hay ningún campo en `CreatePaymentIntentInput` por el que un monto puesto
por el cliente pudiera viajar. Es la regla que esta función existe para
imponer: el cliente decide **hacia qué** paga, nunca **cuánto**.

### Pertenencia, no permiso

Una reserva ajena y una reserva que no existe responden el mismo
`RESERVATION_NOT_OWNED` (404, nunca 403 — ver `problem.ts`), la misma razón
que ya usa `getReservationForCustomer` en `@rm/domain-reservations`: un 403
confirmaría que el id es real. `@rm/domain-payments` es una hoja y no puede
llamar a esa función directamente, así que la misma comprobación se repite
aquí contra la fila `Reservation` que esta función ya lee de todos modos. Un
actor `STAFF` queda bloqueado por la misma comprobación sin ninguna rama
aparte: el id de un usuario de personal nunca coincide con el `customer_id`
de una reserva.

Una reserva `CANCELLED` o `EXPIRED` responde `INVALID_STATUS_TRANSITION`: no
hay nada que empezar a cobrar sobre una reserva que ya terminó.

### La ficha de OXXO nunca sobrevive al apartado

`voucherExpiresAt` enviado al proveedor es siempre el propio `hold_expires_at`
de la reserva — nunca una fecha inventada aquí.

Stripe no acepta una fecha exacta, sólo `expires_after_days = N`, y lo
interpreta como **«a las 23:59 de Ciudad de México del día calendario N»**, no
como N × 24 horas. Por eso N es el mayor número de días cuyo fin de día (en
esa zona, la de Stripe, no la de la organización) todavía no rebasa el fin del
apartado: un apartado que vence el martes a las 13:00 no admite N = 1, porque
la ficha seguiría cobrable hasta las 23:59 del martes, unas 11 horas después de
liberar el lugar. (La primera versión contaba bloques de 24 horas y tenía
justo ese hueco; lo encontró la revisión final de la rama.)

Cuando ni N = 1 cabe, `StripePaymentProvider` se niega a crear el intento en
vez de ampliar la ventana (ver `oxxoExpiresAfterDays` en `@rm/payments-stripe`
y "Cancelar el Payment Intent al expirar el apartado" más abajo): esa negativa
llega aquí como un `Result` normal — nunca una excepción — y sale de esta
función como el mismo `VALIDATION_FAILED` que cualquier otra validación de
entrada, sin ninguna rama especial para atraparla. Una reserva `ACTIVE` (que
ya no tiene `hold_expires_at`) golpea la misma negativa por el mismo motivo:
no hay `voucherExpiresAt` que enviar, y `createIntent` lo exige para OXXO.

### La fila `PENDING` nace en el mismo paso que el intento

Si el proveedor acepta, esta función llama a `recordPayment` dentro de su
propia transacción para escribir la fila `Payment` en `PENDING` con el
`provider_intent_id`, el método, el monto ya calculado y (para OXXO) la URL y
expiración de la ficha — los dos campos que `recordPayment` aprendió a
aceptar en esta misma tarea (ver `RecordPaymentInput.providerVoucherUrl` /
`voucherExpiresAt`). Esta fila es la que `confirmPaymentWithin` espera
encontrar cuando llegue el webhook; `ConfirmPaymentInput.recordIfMissing`
sigue existiendo como red de seguridad para cuando este paso no llegó a
escribirla, no como el camino normal.

## Cancelar el Payment Intent al expirar el apartado (Tarea 9, cierra el hueco de la Tarea 8)

Spec §5.3. Cuando `expireHolds` (`apps/worker/src/jobs/expire-holds.ts`)
expira un apartado `HELD`, cancela en el proveedor cada `Payment` en
`PENDING` de esa reserva que tenga `provider_intent_id`: una ficha de OXXO
sin cobrar o una intención de tarjeta sin confirmar no deben quedar
esperando dinero para un lugar que el sistema ya liberó.

El puerto (`libs/payments-stripe`, `PaymentProvider.cancelIntent`) se
inyecta en `expireHolds` mediante `createCancelPendingPaymentIntents`, el
mismo hueco que la Tarea 8 dejó deliberadamente abierto en vez de inventar
una dependencia de Stripe que esa tarea no tenía forma de probar de verdad.

**Desde la Tarea 19 vive en `@rm/domain-payments`**
(`libs/domain/payments/src/lib/payment-intent-cancellation.ts`), no en
`apps/worker`: la cancelación desde el panel (`cancelReservation`, ver
`reservations.md`) necesita el mismo cierre y una app no puede importar de
otra. El comportamiento no cambió; sus pruebas siguen en
`expire-holds.spec.ts` y la ruta del panel tiene la suya. `@rm/domain-
reservations` declara el mismo tipo de función de forma estructural, sin
importar este módulo, para que los dos dominios sigan sin depender entre sí.

**La llamada al proveedor ocurre después del commit, nunca dentro de la
transacción.** Dentro, sostendría el bloqueo de la fila durante una llamada de
red y, pasado el límite de 5 s de las transacciones de Prisma, desharía el
vencimiento: un Stripe lento dejaría el lugar bloqueado, justo lo que esta
regla promete que no pasa. Además cada llamada a Stripe tiene un límite de
10 s (`STRIPE_REQUEST_TIMEOUT_MS`). Lo mismo aplica a la cancelación desde el
panel.

**Un fallo al cancelar en el proveedor no impide que el apartado expire.**
`createCancelPendingPaymentIntents` nunca lanza: si `cancelIntent` devuelve
un error, sólo se registra con `console.error` y el lugar se libera igual.
Lo contrario —dejar que el fallo aborte la transacción que ya marcó la
reserva `EXPIRED`— permitiría que una caída de Stripe bloqueara un lugar
indefinidamente, exactamente lo que esta regla existe para evitar.

**No cancela dos veces.** `expireHolds` sólo llama a este cierre después de
que su propio `updateMany` condicional de verdad volteó la fila a `EXPIRED`;
una segunda pasada sobre una reserva ya `EXPIRED` no encuentra candidatos y
nunca vuelve a invocarlo. `cancelIntent` es además idempotente por su propio
contrato (`libs/payments-stripe/src/testing/payment-contract.ts`), así que
una segunda llamada —si alguna vez ocurriera— tampoco sería un error.

## Historial de pagos de una reserva para el personal (Tarea 19)

`listPaymentsForReservation(db, reservationId)` devuelve los pagos de una
reserva, del más reciente al más antiguo por `recorded_at`, con los
pendientes, rechazados y vencidos incluidos: quien decide una cancelación
necesita ver la ficha de OXXO que sigue abierta tanto como el dinero que ya
llegó. Mismo orden y mismas inclusiones que `listPaymentsForCustomer`.

Una reserva inexistente es `NOT_FOUND`, no una lista vacía: «todavía no hay
pagos» y «no existe esa reserva» son respuestas distintas.

La ruta (`GET /api/v1/admin/reservations/{id}/payments`) exige
`payment.view`, no `reservation.view`: el catálogo de permisos ya separa
quién ve dinero de quién ve reservas, y el detalle del panel sólo pide el
historial cuando quien mira tiene ese permiso.

## `reconcilePaidCents`: la conciliación nocturna (Tarea 8, §6 de la spec)

Implementado en `apps/worker/src/jobs/reconcile-paid-cents.ts` como función
pura del cliente de base (`reconcilePaidCents(db, queue)`, sin pg-boss
dentro), con cadencia **nocturna** registrada por `apps/worker/src/main.ts`
en la zona horaria de `SystemSetting['organization.timezone']` — nunca
hardcodeada, la misma regla que toda fecha de calendario de esta fase.

Para cada reservación, compara `paid_cents` contra `SUM(amount_cents)` de sus
pagos `SUCCEEDED` (`PENDING`, `FAILED`, `EXPIRED` y `REFUNDED` no cuentan: ver
"Un pago pendiente no reduce el saldo" arriba, por lo que tampoco deben
contar aquí). Si coinciden, no hace nada. Si no coinciden, llama a
`notifyAdmins` con `PAID_CENTS_MISMATCH` y los dos números, y nada más.

**Las dos cifras salen de una sola sentencia SQL.** En PostgreSQL una sentencia
ve una sola instantánea de la base, así que un webhook que confirma un pago a
mitad de la corrida no puede quedar contado de un lado y no del otro. La
versión anterior leía `paid_cents` y la suma en dos consultas paralelas y
podía alertar una desviación que no existía (lo encontró la revisión final de
la rama). La consulta devuelve sólo las reservas desviadas.

**No corrige el dato por su cuenta.** Alerta y para ahí. Una corrección
automática escondería el bug que causó la desviación en primer lugar —
exactamente el mismo motivo por el que ningún camino de pago mueve dinero
sin una fila `Payment` detrás (ver el caso límite de arriba). La prueba
`reconcile-paid-cents.spec.ts` ("does not correct paid_cents itself") deja
una reservación desviada, corre el job, y comprueba que `paid_cents` sigue
exactamente igual de mal que antes.

**No es idempotente, a propósito**, al contrario que `expireHolds` y
`warnExpiringHolds` (`docs/business-rules/reservations.md`, "Los jobs de
fondo"): mientras la desviación no se corrija a mano, cada corrida nocturna
vuelve a alertar. El silencio después del primer aviso se leería como "ya se
arregló", que es justo lo que no se puede asumir de un bug que nadie ha
tocado todavía.


**Fase 2B.** Lo que una bajada de precio pasó a saldo a favor salió de la
reserva: la consulta resta los movimientos `PRICE_DECREASE` con su
`reservation_id`, en la misma sentencia. **Decisión D7:** lo que un pago
confirmado trajo por encima del saldo nunca llegó a la reserva, así que también
resta los `OVERPAYMENT` de esa reserva. Ningún otro tipo de movimiento toca
`paid_cents`:

```
paid_cents = Σ pagos SUCCEEDED − Σ PRICE_DECREASE − Σ OVERPAYMENT   (de esa reserva)
```

## Mensualidad sugerida

No existe mensualidad obligatoria. El único monto exigible es el anticipo
mínimo al reservar; el compromiso es liquidar antes de `payment_deadline`.

```
months_remaining = días 01 de mes entre hoy (exclusivo) y payment_deadline
                   (inclusivo), evaluados en la zona horaria de
                   SystemSetting['organization.timezone']

suggested_monthly_cents = min(balance_cents,
                              redondeo_hacia_arriba(balance_cents /
                                                    max(months_remaining, 1)))
```

La zona horaria se lee con `organizationTimeZone` (`@rm/domain-settings`) —
antes copiada aquí, en `trips` y en `reservations`; sin cambio de regla.

**Se recalcula en cada lectura y nunca se almacena.** No hay columna para
ella, y una prueba lo comprueba contra `information_schema`: una copia
guardada quedaría obsoleta en cuanto entrara un abono.

Tres decisiones dentro de esa fórmula:

- **Redondea hacia arriba, nunca hacia abajo.** 100.00 entre tres meses son
  33.333…; sugerir 33.00 deja al cliente corto un peso cada mes y la suma de
  las mensualidades no cubre el total. Sugerir 34.00 sí lo cubre, y el último
  abono es más pequeño.
- **Nunca supera el saldo.** Redondear hacia arriba puede pasarse cuando el
  saldo es pequeño o tiene centavos (100.50 en un mes redondea a 101.00), y
  `recordPayment` rechazaría ese monto con `PAYMENT_EXCEEDS_BALANCE`. Sugerir
  una cantidad que la propia API rechaza es peor que sugerir una rara. El tope
  es además lo que hace que el último abono liquide exacto.
- **`months_remaining = 0` significa "todo".** Pasado el último día 01 no
  queda mes sobre el que repartir; la fecha límite es la fecha límite.

`payment_deadline` es una **fecha de calendario** (`@db.Date`), no un
instante: Prisma la devuelve como medianoche UTC de ese día. Leída como
instante en una zona detrás de UTC cae en el mes anterior y el cliente pierde
silenciosamente su última oportunidad de pago, así que antes de contar los
días 01 se reancla en el día de calendario de la zona de la organización. Es
el mismo cuidado que `isPastDate` aplica en `@rm/shared-utils`. El reanclaje
en sí es `endOfCalendarDay`, que vivía en este módulo y ahora está junto a
`isPastDate` y `monthStartsBetween` en `@rm/shared-utils/calendar.ts`; sin
cambio de regla.

El sistema jamás rechaza un abono por ser menor que la mensualidad sugerida.
Es motivacional: se muestra en la app y se usa en los recordatorios.

## Cobro en efectivo (Fase 2B, Tarea 7, §5.3)

`registerCashPayment` (`POST /admin/reservations/{id}/payments`, permiso
`payment.register`): un pago `CASH`, `provider = MANUAL`, `SUCCEEDED` al
instante, `recorded_by` = el trabajador, `paid_at` = ahora, con folio y job
de recibo en la misma transacción.

- Monto `> 0` y `≤` saldo pendiente (`PAYMENT_EXCEEDS_BALANCE`).
- **Sobre reservas vivas, o que el cobro revive.** Sobre una `CANCELLED` →
  `INVALID_STATUS_TRANSITION`: el dinero de un cliente sin reserva viva se
  registra como saldo a favor (`ADJUSTMENT`), no como pago de una reserva
  muerta. **Una `HELD` con el apartado vencido, o una `EXPIRED`, ya no
  responde `HOLD_EXPIRED`** (decisión 13): el cobro la revive si queda lugar
  (ver «Revivir con un cobro»).
- Una `HELD` que con este pago cubre el anticipo pasa a `ACTIVE` con el mismo
  `updateMany` condicionado del webhook.
- No genera aviso `PAYMENT_CONFIRMED`: el cliente está frente al mostrador y
  recibe el recibo por correo; un segundo correo sería ruido.
- El primer pago de una reserva hecha en mostrador usa el mismo camino
  (`createInitialCashPayment`), inyectado en la transacción de la reserva.

## Pagos históricos (Fase 2B, Tarea 9, §5.7)

`recordBackfilledPayments` (`POST /admin/backfill/payments`) y el gancho de
`createBackfilledReservation`; permiso `data.backfill`.

- Método `LEGACY` por omisión, o `CASH` si se sabe; `paid_at` en el pasado
  (nunca futuro), `is_backfilled`, `recorded_by` = el trabajador, nota
  opcional (por ejemplo, la hoja de la libreta).
- **Las fechas llegan como fecha de calendario** (`YYYY-MM-DD`), no como
  instante, y **las fecha el dominio, no la capa HTTP**: `paidAt` acepta una
  cadena `YYYY-MM-DD` o un `Date` ya decidido (la importación CSV fecha el
  suyo). Con una cadena, `recordBackfilledPayments` y el gancho de
  `createBackfilledReservation` leen la zona horaria de la organización —nunca
  la del navegador ni la del servidor— y fechan el pago a **mediodía de ese
  día en esa zona, sin pasar de ahora**: una fecha de hoy capturada antes del
  mediodía queda fechada en ese momento. Una fecha posterior a hoy en esa
  zona, o un texto que no es una fecha real, es `VALIDATION_FAILED`
  (`field: payments.<i>.paidAt`) y no se escribe nada. La regla es una sola
  función pura, `resolveBackfillMoments` (`@rm/shared-utils`), así que un
  segundo llamador (un job, una importación) la hereda sin repetirla; el
  Route Handler sólo autentica, verifica el permiso, valida la forma con Zod y
  pasa las cadenas tal cual.
- Dos caminos con la misma función: un abono único con todo lo ya pagado, o
  el desglose pago por pago. Se escriben **del más antiguo al más reciente**,
  para que la foto del saldo de cada recibo siga el orden real.
- Reciben folio **del año de su `paid_at`**, como cualquier pago
  `SUCCEEDED`: un pago de noviembre de 2025 capturado en 2026 es
  `RM-2025-…`.
- Sólo sobre reservas vivas; todo o nada (un pago que excede el saldo revierte
  los demás).
- Desde la importación CSV también pueden llegar como `CARD`, `OXXO` o `SPEI`
  (con `provider = MANUAL`: nunca pasaron por Stripe) y con `external_ref`,
  la referencia propia de la agencia: **columna única**
  (`payments_external_ref_key`), así que el mismo pago no se importa dos
  veces. Una violación de ese índice vuelve como `CONFLICT` con
  `field: externalRef` y la transacción se revierte. Ver `imports.md`.
- **Recibos silenciados por omisión**: no se encola ninguno salvo que el
  trabajador marque `sendReceipts`. El folio y el PDF existen igual: el PDF
  se genera al descargarlo o al reenviarlo.

## Saldo a favor: el modelo (Fase 2B, Tarea 1)

`customer_credit_entries` guarda movimientos con signo: `CANCELLATION`,
`PRICE_DECREASE`, `EXPIRATION`, `OVERPAYMENT` y `ADJUSTMENT` positivo suman; `APPLIED`,
`REFUND`, `REVIVAL` y `ADJUSTMENT` negativo restan. **El saldo de un cliente es la suma de sus
movimientos**, nunca una columna editable. La base rechaza un movimiento de
monto cero (CHECK `customer_credit_entries_amount_not_zero`): no mueve dinero
y sólo ensucia el historial.

## Saldo a favor: las reglas (Fase 2B, Tarea 3, §5.5)

`credit-service.ts`, sobre las primitivas de `credit-ledger.ts` (candado del
cliente, suma bajo el candado y `addCreditEntry`), que viven aparte para que
`payment-service.ts` pueda acreditar mientras liquida un pago sin que los dos
módulos se importen entre sí. Diagrama: `docs/diagrams/customer-credit.md`.

**Nunca mueve dinero solo.** El cliente lo ve en «Mi cuenta» (sólo lectura,
`GET /me/credit`); el personal lo ve con `payment.view` y lo cambia con
`payment.credit.apply`. Cada movimiento queda en `AuditLog`
(`credit.entry_created`) con el actor, el motivo y el saldo antes y después.

| Movimiento | Signo | Quién | Cuándo |
|---|---|---|---|
| `CANCELLATION` | + | Automático | Al cancelar una reserva con `paid_cents > 0`, y cuando llega dinero para una reserva ya cancelada |
| `PRICE_DECREASE` | + | Automático | Al bajar el precio por debajo de lo pagado; ese monto **sale** de `paid_cents` de la reserva (ver `reservations.md`) |
| `EXPIRATION` | + | Automático | Al vencer un apartado `HELD` con `paid_cents > 0`; la reserva `EXPIRED` conserva `paid_cents` y sus pagos |
| `REVIVAL` | − | Automático | Al revivir una reserva `EXPIRED` en el mostrador: devuelve a la reserva lo que `EXPIRATION` había pasado al saldo |
| `OVERPAYMENT` | + | Automático | Al confirmar Stripe un pago mayor que el saldo de su reserva: la parte que excede (decisión D7, «Sobrepago confirmado»). A lo más uno por pago; **nunca** entra a `paid_cents` |
| `APPLIED` | − | Personal | Aplicar saldo a una reserva viva del mismo cliente |
| `REFUND` | − | Personal | Se devolvió el dinero **fuera del sistema**; motivo obligatorio |
| `ADJUSTMENT` | ± | Personal | Corrección o cortesía; motivo obligatorio |

**Decisión del dueño del producto (2026-10-07), confirmada.** «El dinero de
una reserva cancelada se vuelve saldo a favor; la devolución se hace fuera del
sistema y después se puede aumentar o disminuir el saldo a voluntad». **Quien
modifica el saldo es el personal de la agencia**, nunca el viajero desde la
app, por motivos que ocurren fuera de la plataforma (promociones, concursos o
devoluciones en efectivo en la sucursal) — `REFUND` registra la devolución y
`ADJUSTMENT` cubre el «aumentar o disminuir a voluntad», siempre con motivo.

### Bajo bloqueo, nunca negativo

`addCreditEntry` bloquea la fila del cliente (`customer_profiles ... FOR
UPDATE`), suma sus movimientos bajo ese bloqueo y rechaza con
`CREDIT_INSUFFICIENT` (409, con `balanceCents`) el movimiento que dejaría la
suma bajo cero. Dos aplicaciones simultáneas de $1,000 sobre un saldo de
$1,500: la segunda espera el bloqueo, ve $500 y se rechaza.

**Orden de bloqueo: reserva primero, cliente después**, en toda operación que
toque ambos (aplicar saldo, cancelar, cambiar precio, liquidar un pago con
excedente), y el contador de folios después de los dos. Es el orden único de
todos los caminos de dinero; ver «Orden de bloqueo» arriba.

### Aplicar saldo a una reserva

`applyCreditToReservation` en una transacción: verifica que la reserva sea del
cliente (`RESERVATION_NOT_OWNED`, antes de bloquear nada), la **revive si su
apartado venció y queda lugar** (ver «Revivir con un cobro»), bloquea la
reserva, verifica que esté viva (`INVALID_STATUS_TRANSITION` para una
`CANCELLED`); bloquea al cliente y verifica su saldo; crea el `Payment` `CREDIT` con
`recordPayment` —con folio, mueve `paid_cents` y activa una `HELD` que cubre
el anticipo, igual que el efectivo— y escribe el `APPLIED` con el
`payment_id`. Nunca más que el saldo del cliente ni más que el saldo
pendiente de la reserva (`PAYMENT_EXCEEDS_BALANCE`).

Como es un pago más, `paid_cents` sigue siendo la suma de pagos `SUCCEEDED`
y la conciliación nocturna no necesita caso especial. Para la Fase 3: un pago
`CREDIT` es un **traslado**, no un ingreso; los reportes de ingresos deben
excluirlo para no contar dos veces el mismo dinero.

### Revivir con un cobro (decisión 13)

`registerCashPayment` y `applyCreditToReservation` reciben, como último
parámetro opcional, `reviveReservation`: el lugar lo decide
`reviveReservationSeat` de `@rm/domain-reservations` (`reservations.md`,
«Revivir una reserva vencida»), **inyectado** por las rutas de la API —los dos
dominios no se importan—. En **una sola transacción**:

1. El gancho toma el candado del viaje y luego el de la reserva. Si no queda
   lugar → `TRIP_SOLD_OUT`; viaje no publicado → `TRIP_NOT_PUBLISHED`; otra
   reserva viva del cliente en ese viaje → `DUPLICATE_RESERVATION`;
   `CANCELLED` → `INVALID_STATUS_TRANSITION`. Ninguna de estas escribe nada.
2. Una `HELD` vencida pasa a `HELD` con apartado nuevo (`hold_ttl_hours` del
   viaje desde ahora). Una `EXPIRED` además **recupera su saldo**:
   `reclaimCreditForRevival` escribe un `REVIVAL` por lo que el vencimiento
   había acreditado (`CREDIT_INSUFFICIENT` si el cliente ya lo gastó, y se
   deshace todo; el personal lo ajusta antes con un `ADJUSTMENT`).
3. Se registra el pago de siempre (`recordPayment`): si cubre el anticipo la
   reserva pasa a `ACTIVE`; si no, queda `HELD` con el apartado nuevo. En
   `applyCreditToReservation` el saldo que se verifica es el de **después** de
   recuperar.
4. Si cualquier paso falla después de haber revivido (el monto excede el
   saldo, el saldo ya no alcanza) la transacción entera se revierte: la
   reserva sigue `EXPIRED`, el saldo intacto, ningún pago.

**Orden de bloqueo: viaje, reserva, cliente.** Sin el gancho, el comportamiento
anterior se conserva (`HOLD_EXPIRED` / `INVALID_STATUS_TRANSITION`). El
dinero nunca queda en dos sitios: `expire-holds.spec.ts` repite 30 veces un
cobro con revivida contra `expireHolds` y comprueba, en cada una, que el
saldo más lo que cuenta la reserva viva es exactamente lo pagado.

### Lo pagado de un apartado vencido (decisión 16)

Un apartado `HELD` que ya recibió pagos (menos que el anticipo) y vence deja
su dinero en el saldo del cliente, igual que al cancelar (decisión 6).
`creditFromExpiration` lo escribe dentro de la transacción de `expireHolds`,
en la llamada que de verdad expiró la reserva, y le llega **inyectado** al
job —el worker y los dominios no se importan—. Como la reserva conserva
`paid_cents`, lo que se acredita es **lo que aún no está acreditado**:
`paid_cents` menos el neto de sus movimientos `EXPIRATION` y `REVIVAL`. Por eso
repetir la expiración no duplica nada, y una reserva revivida que vuelve a
vencer se acredita completa otra vez (el `REVIVAL` ya había devuelto el primer
crédito). El saldo `CREDIT` que se había aplicado a esa reserva también
vuelve como `EXPIRATION`: el dinero da la vuelta completa y queda donde
empezó.

`reclaimCreditForRevival` es la mitad contraria: al revivir una reserva
`EXPIRED`, escribe un `REVIVAL` negativo por ese neto, porque el dinero vuelve a
contar en la reserva (`paid_cents` nunca dejó de contarlo). Si el cliente ya
gastó o se le devolvió ese saldo →
`CREDIT_INSUFFICIENT` y no se escribe nada: revivir contaría el mismo dinero
dos veces; el personal lo arregla antes con un `ADJUSTMENT`.

**Invariante** (la que verifican las pruebas): para cada reserva, el saldo
que ella dejó en el cliente más su `paid_cents` si está `HELD`/`ACTIVE` (o 0 si
no lo está) es la suma de sus pagos `SUCCEEDED`. El mismo dinero nunca está
a la vez en el saldo y en una reserva viva. `reconcilePaidCents` no cambia por
`EXPIRATION` ni `REVIVAL`: ninguno de los dos toca `paid_cents`. Desde la
decisión D7 el `OVERPAYMENT` entra en la misma cuenta del lado del saldo, y la
conciliación lo resta (nunca llegó a `paid_cents`).

### Dinero que llega después de cancelar

Al liquidar un pago confirmado de una reserva `CANCELLED`
(`settleConfirmedPayment`), lo que cupo en la reserva se acredita como
`CANCELLATION` con su `payment_id` (idempotente por pago) y el excedente, si lo
hay, como `OVERPAYMENT`: todo el pago tardío queda como saldo a favor. Ocurre
**antes** de numerar el recibo, para respetar el orden de bloqueo (antes lo
hacía el webhook después del folio, y eso podía bloquearse contra un saldo
aplicado en el mostrador). El webhook manda el aviso
`PAYMENT_AFTER_CANCELLATION` —que ya dice que quedó como saldo a favor— y la
alerta al personal.

## Folio de recibo: el modelo (Fase 2B, Tarea 1)

`payments.receipt_number` es **único** (`payments_receipt_number_key`): dos
pagos nunca comparten folio. Es nulo mientras el pago no está `SUCCEEDED`, y
PostgreSQL deja los nulos distintos en un índice único, así que las fichas
pendientes no chocan entre sí. El contador vive en `receipt_counters`, una
fila por año con el año como llave primaria.

### Cómo se asigna (Tarea 2)

- Formato `{receipt.prefix}-{año}-{000001}`; `receipt.prefix` es configurable
  (por omisión `RM`).
- **El año es el de `paid_at` en la zona de la organización**: un pago a las
  23:30 del 31 de diciembre en Ciudad de México es del año que termina,
  aunque en UTC ya sea 1 de enero.
- Lo asigna `assignReceiptNumber` **dentro de la transacción que deja el pago
  en `SUCCEEDED`**: `recordPayment` cuando el pago nace exitoso (efectivo,
  saldo a favor, histórico) y `confirmPaymentWithin` en la transición
  `PENDING → SUCCEEDED` del webhook. Un pago `PENDING`, `FAILED` o `EXPIRED`
  no tiene folio.
- **Sin huecos y sin duplicados.** `UPDATE receipt_counters ... RETURNING`
  bloquea la fila del año hasta el `COMMIT`: el segundo pago espera en vez de
  leer el mismo número, y una transacción que se revierte se lleva su
  incremento con ella. Por eso no es una secuencia de PostgreSQL, que deja un
  hueco en cada reversión.
- En la confirmación por webhook el folio se pide **después** del `updateMany`
  condicional: la entrega que pierde la carrera no toma un número que no va a
  usar.
- **Es el último candado de su transacción**, en todos los caminos: se pide
  una vez liquidado el pago (dinero aplicado y saldo a favor escrito). Ver
  «Orden de bloqueo».
- Costo aceptado: todos los cobros exitosos del año se serializan en esa fila
  durante el resto de su transacción, que es corta (sin llamadas de red).
- En la misma escritura quedan `receipt_total_cents` y `receipt_paid_cents`:
  el precio total y lo pagado **justo después de este pago**. Es la foto que
  imprime el recibo. Con un sobrepago, `receipt_paid_cents` es lo que la
  reserva alcanzó (nunca más que el total), no la suma con el excedente.

## Recibos en PDF (Fase 2B, Tareas 4 y 5, §5.4)

**Todo pago que llega a `SUCCEEDED` tiene recibo**: efectivo, tarjeta, OXXO,
saldo a favor e históricos.

- **Qué imprime** (`@rm/receipts`, `PdfLibReceiptRenderer`): los datos de la
  agencia (`organization.name`, `address`, `phone`, `website`), el folio, la
  fecha de pago en la zona de la organización, el cliente, el viaje y sus
  fechas, el folio de la reserva, el monto y la forma de pago, y el estado de
  cuenta **de ese momento** (total, pagado y saldo pendiente tras este pago).
  En el idioma del cliente. Aclara que no es un comprobante fiscal (CFDI).
- **Los datos de la agencia se editan en el panel** (`GET`/`PUT
  /admin/settings/organization`, permiso `settings.manage`; sembrados con los
  de los carteles). Sólo los recibos que se generen después los usan: un PDF
  ya guardado conserva los datos con que se emitió. El cambio se audita
  (`settings.organization_updated`).
- **La foto del saldo no se recalcula**: sale de `receipt_total_cents` y
  `receipt_paid_cents`. Para un pago confirmado antes de que existieran esas
  columnas se reconstruye con los pagos `SUCCEEDED` hasta su `paid_at`.
- **Se genera una vez y se guarda.** `ensureReceiptPdf` lo dibuja la primera
  vez, lo guarda en `receipts/{año}/{folio}-{aleatorio}.pdf` y lo anota en
  `receipt_key` con una escritura condicional (dos generaciones simultáneas
  dejan un solo PDF); después siempre devuelve el guardado. Lo que un recibo
  dice no cambia aunque la reserva cambie.
- **Los recibos son privados.** El folio es secuencial, así que la llave
  lleva un sufijo aleatorio, y la ruta pública de archivos locales
  (`/api/v1/files/...`) rechaza el prefijo `receipts/` con el mismo 404 de un
  archivo inexistente. Sólo se descargan por rutas que verifican quién pide:
  `GET /admin/payments/{id}/receipt` (`payment.view`) y
  `GET /payments/{id}/receipt` (el dueño; otro cliente recibe
  `RESERVATION_NOT_OWNED`, 404). En S3, la política del bucket no debe hacer
  público el prefijo `receipts/`.
- **Envío: el job `SEND_RECEIPT`** (`apps/worker/src/jobs/send-receipt.ts`).
  Se encola con `enqueueReceipt` **en la misma transacción** que deja el pago
  en `SUCCEEDED` (la bandeja de salida de `notifications.md`, Regla 11): el
  webhook en toda rama (también cuando la reserva ya venció o se canceló) y
  `applyCreditToReservation`. Un segundo evento de Stripe para un intento ya
  confirmado no encola otro. La captura histórica y la importación lo omiten
  salvo que el trabajador marque el envío.
- El job asegura el PDF, lo envía **adjunto** al correo **actual** del
  cliente y sella `receipt_sent_at`. **Idempotente**: un recibo enviado no se
  reenvía. **Un fallo del proveedor** deja el PDF guardado y
  `receipt_sent_at` nulo; el job falla para que pg-boss lo reintente, y el
  reintento no vuelve a dibujar el PDF.
- **Reenviar** es una acción explícita del panel
  (`POST /admin/payments/{id}/receipt/resend`, `payment.view`): encola el job
  con `resend: true`, que envía aunque ya se hubiera enviado.

## Errores

| Código | Cuándo | HTTP |
|---|---|---|
| `VALIDATION_FAILED` | Monto que no es un entero de centavos mayor que cero | 422 |
| `NOT_FOUND` | La reserva no existe, o ningún pago lleva ese intento | 404 |
| `PAYMENT_EXCEEDS_BALANCE` | El monto supera `balance_cents` | 422 |
| `CONFLICT` | Ya existe un pago con ese `provider_intent_id` | 409 |
| `INVALID_STATUS_TRANSITION` | Confirmar un pago que no está `PENDING` | 409 |

Ningún código es nuevo: los cinco existen en el catálogo desde la Fase 1.
`PAYMENT_EXCEEDS_BALANCE` se usa aquí por primera vez.

## Qué vive dónde

| Archivo | Para qué |
|---|---|
| `libs/domain/payments/src/lib/instalment.ts` | La aritmética de la mensualidad sugerida, sin base de datos |
| `libs/domain/payments/src/lib/payment-service.ts` | Saldo, registro, confirmación, liquidación (reparto del sobrepago), listado y la mensualidad de una reserva; el **orden de bloqueo** escrito al inicio |
| `libs/domain/payments/src/lib/credit-ledger.ts` | Primitivas del saldo a favor: candado del cliente, `addCreditEntry`, `CANCELLATION` y `OVERPAYMENT` |
| `libs/domain/payments/src/lib/lock-order.spec.ts` | Las dos intercalaciones que se bloqueaban mutuamente antes del orden único |
| `libs/db/prisma/migrations/20261009000100_credit_entry_overpayment_unique/` | El índice único parcial: un `OVERPAYMENT` por pago |
| `libs/domain/payments/src/lib/payment-intent-service.ts` | Crear el Payment Intent (Tarea 14): el monto nunca viaja desde el cliente |
| `libs/db/prisma/migrations/20261004011500_payment_provider_intent_unique/` | El índice único que ancla la idempotencia |
| `apps/worker/src/jobs/reconcile-paid-cents.ts` | El job nocturno de conciliación (Tarea 8) |

`libs/domain/payments` es una hoja: no importa `@rm/domain-reservations` y
`@rm/domain-reservations` no lo importa a él.
