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

`credit_cents` (saldo a favor) se declara desde la Fase 2A pero sólo nace de
una bajada de precio, que es Fase 2B. Aquí siempre vale 0.

## Un pago pendiente no reduce el saldo

Un `Payment` en `PENDING` —la ficha de OXXO es el caso de siempre— se registra
y **no toca `paid_cents`**. La app lo muestra como pendiente, con su ficha
descargable y su plazo, y advierte que el lugar se libera si no se confirma a
tiempo.

Es la regla que sostiene toda la experiencia de OXXO: el dinero no existe
hasta que el proveedor lo confirma, y el cupo tampoco se compromete por una
ficha impresa.

Consecuencia aceptada: como las fichas pendientes no reducen el saldo, pueden
emitirse dos por el total y confirmarse las dos. Eso genera un sobrepago, que
la Fase 2B convierte en saldo a favor. Registrarlo igual es lo correcto —
dinero que se movió tiene que verse—; rechazar la segunda confirmación dejaría
un cobro real sin asiento contable.

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
5. Se inserta el `Payment`. `paid_at` es la fecha en que el dinero se movió —
   se rellena con "ahora" para un pago que nace `SUCCEEDED` y queda nulo
   mientras esté `PENDING`—, separada de `recorded_at`, que es cuándo se
   capturó. Los reportes leen `paid_at`, así que un pago de marzo capturado en
   septiembre aparece en marzo.
6. Si el pago nace `SUCCEEDED`, se aplica al saldo (abajo).
7. Se escribe la entrada de auditoría `payment.recorded`.

**El estado de la reserva no se comprueba.** Un pago de una reserva
`CANCELLED` o `EXPIRED` se registra igual; lo que no hace es cambiarle el
estado (ver el caso límite más abajo).

## Umbral del anticipo: de `HELD` a `ACTIVE`

Al aplicarse un pago confirmado:

```
paid_cents += amount_cents

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

## Caso límite: pago confirmado de una reserva ya expirada

Spec §5.3. Si llega la confirmación de una ficha de OXXO después de que el
apartado expiró:

- El pago se registra como `SUCCEEDED` y `paid_cents` sube.
- La reserva **no** se reactiva: sigue `EXPIRED`.
- Se avisa al cliente con `PAYMENT_AFTER_EXPIRY` y al administrador con
  `ORPHAN_PAYMENT`, en la misma transacción.

El dinero existe y debe verse; devolverlo o aplicarlo a otro viaje es decisión
humana. Ningún movimiento de dinero es automático.

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
| `payment_intent.succeeded` sobre una reserva `EXPIRED` | Pago `SUCCEEDED`, reserva intacta (§5.3 arriba) | `PAYMENT_AFTER_EXPIRY` al cliente y `ORPHAN_PAYMENT` al personal |
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
Por eso no genera aviso: el cliente ya recibió su `HOLD_EXPIRED` del job que
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
de la reserva — nunca una fecha inventada aquí. Cuando queda menos de un día,
`StripePaymentProvider` se niega a crear el intento en vez de redondear la
ventana hacia arriba (ver `oxxoExpiresAfterDays` en `@rm/payments-stripe` y
"Cancelar el Payment Intent al expirar el apartado" más abajo): esa negativa
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
| `libs/domain/payments/src/lib/payment-service.ts` | Saldo, registro, confirmación, listado y la mensualidad de una reserva |
| `libs/domain/payments/src/lib/payment-intent-service.ts` | Crear el Payment Intent (Tarea 14): el monto nunca viaja desde el cliente |
| `libs/db/prisma/migrations/20261004011500_payment_provider_intent_unique/` | El índice único que ancla la idempotencia |
| `apps/worker/src/jobs/reconcile-paid-cents.ts` | El job nocturno de conciliación (Tarea 8) |

`libs/domain/payments` es una hoja: no importa `@rm/domain-reservations` y
`@rm/domain-reservations` no lo importa a él.
