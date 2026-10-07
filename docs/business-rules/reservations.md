# Reservas

## Estados

`HELD` → `ACTIVE`, con dos salidas terminales. `EXPIRED` se alcanza sólo desde
`HELD` (un apartado cuyo `hold_expires_at` pasó sin que se cubriera el depósito
mínimo, lo dispara el job `expireHolds`). `CANCELLED` se alcanza desde `HELD` o
desde `ACTIVE`, y sólo por decisión de una persona con `reservation.cancel`
desde el panel (Tarea 19, ver «Cancelar una reserva»). `CANCELLED` y `EXPIRED`
son terminales. El diagrama de estados completo está en
`docs/diagrams/trip-reservation.md`.

Implementado en el modelo `Reservation` (`libs/db/prisma/schema.prisma`).
`libs/domain/reservations` ya existe y contiene el cálculo del cupo y su
bloqueo (abajo); las transiciones y las reglas de apartado, depósito y
cancelación (§5.2–§5.6 de
`docs/superpowers/specs/2026-10-03-fase-2a-reservas-y-pagos-diseno.md`)
llegan con las tareas siguientes.

## Cupo disponible

```
available_seats = total_capacity − pre_sold_seats
                − COUNT(reservas ACTIVE)
                − COUNT(reservas HELD con hold_expires_at > ahora)
```

**Nunca se almacena.** Un contador mutable es exactamente donde aparece la
sobreventa cuando dos personas reservan el último lugar en el mismo segundo:
el contador se lee, se decide y se escribe, y entre la lectura y la escritura
cabe otra reserva. Derivarlo de las filas de `reservations` en cada lectura
elimina esa ventana a cambio de una consulta.

Una reserva `CANCELLED`, una `EXPIRED` y un apartado `HELD` cuyo
`hold_expires_at` ya pasó **no ocupan lugar**: el lugar vuelve al cupo sin que
nadie tenga que tocar un contador. Por eso la expiración de un apartado no
necesita ninguna escritura para liberar el asiento; el job que marca `EXPIRED`
(§5.3 de la spec) sólo existe para cerrar el Payment Intent y dejar constancia.

Fórmula y conteos viven juntos en
`libs/domain/reservations/src/lib/capacity.ts`:

| Función | Para qué |
|---|---|
| `availableSeats(input)` | La resta pura, sin base de datos: cupo − pre-vendido − comprometido, nunca negativa. |
| `countCommittedSeats(db, tripId)` | Conteo de un viaje, en una sola consulta agrupada. |
| `countCommittedSeatsForTrips(db, tripIds)` | Lo mismo para varios viajes en **una** consulta; devuelve un mapa con ceros para los viajes sin reservas, nunca con entradas ausentes. |
| `lockTripForCapacity(tx, tripId)` | `SELECT id FROM trips WHERE id = $1 FOR UPDATE`. |

El corte del apartado se compara contra el reloj de la aplicación y no contra
el `now()` de PostgreSQL: dentro de una transacción, `now()` es la hora en que
la transacción empezó, que en una transacción interactiva larga puede ser
notablemente anterior.

### Un apartado `HELD` siempre tiene fecha de vencimiento

`hold_expires_at` es nullable porque `ACTIVE` la anula a propósito: cubierto el
anticipo mínimo, el lugar deja de ser un apartado y deja de vencer (§5.3). Pero
nada ataba la otra dirección, así que una fila `HELD` con `hold_expires_at`
nulo era representable: un apartado que no vence nunca y que el conteo de cupo
lee como **libre**, porque `hold_expires_at > ahora` no es cierto para `NULL`.
El lugar quedaría ocupado y vendible a la vez — una sobreventa silenciosa
dentro del único cálculo cuyo trabajo es evitarla.

Se resuelve haciendo imposible el estado, no contando a la defensiva:

```sql
ALTER TABLE "reservations"
  ADD CONSTRAINT "reservations_held_requires_hold_expiry"
  CHECK ("status" <> 'HELD' OR "hold_expires_at" IS NOT NULL);
```

La implicación es **de un solo sentido** (`HELD` ⇒ no nulo). `CANCELLED` y
`EXPIRED` conservan la fecha que tuvieran, que es historia que vale la pena
guardar, y `ACTIVE` no tiene ninguna.

Prisma no sabe expresar un `CHECK` en `schema.prisma`, igual que no sabe
expresar el índice parcial, así que vive como SQL crudo en la migración
`20261003224500_reservation_held_requires_hold_expiry`. El modelo
`Reservation` lleva un comentario que remite aquí, y
`reservations-schema.spec.ts` comprueba que la base **rechaza** la fila mala,
no sólo que el código no la escribe.

Con esa garantía, `countCommittedSeats` no necesita una rama para el caso nulo:
sería código inalcanzable.

## Por qué el cálculo exige el bloqueo

Leer el cupo para **escribir** (tomar un lugar, o reducir `total_capacity`)
obliga a bloquear antes la fila del viaje:

```
BEGIN
SELECT id FROM trips WHERE id = $1 FOR UPDATE   -- lockTripForCapacity
  (conteo)                                      -- countCommittedSeats
  (decisión: ¿queda lugar?)
  (INSERT de la reserva)
COMMIT
```

Sin ese `FOR UPDATE`, dos transacciones simultáneas leen el mismo conteo,
las dos encuentran libre el último lugar y las dos insertan. Con él, y bajo
`READ COMMITTED` —el nivel por omisión de PostgreSQL y el que usan las
transacciones interactivas de Prisma—, la segunda transacción se queda
esperando en el `SELECT ... FOR UPDATE` hasta que la primera hace COMMIT, y el
conteo que lee después **ya incluye** la reserva de la primera. La segunda
recibe `TRIP_SOLD_OUT`.

Es un bloqueo **de fila, no de tabla**: dos reservas a viajes distintos no se
estorban. `capacity.spec.ts` lo comprueba con una prueba que completa una
reserva a otro viaje mientras la primera transacción sigue con su bloqueo
tomado.

El bloqueo debe tomarse **dentro** de una transacción. Un `FOR UPDATE` fuera
de una transacción libera el candado al terminar la sentencia, y el resultado
es código que parece protegido y no lo está.

`updateTrip` (`@rm/domain-trips`) toma el mismo bloqueo antes de comprobar
`CAPACITY_BELOW_COMMITTED`, por la misma razón: reducir el cupo es decidir
contra un conteo que otra reserva puede estar a punto de invalidar.

### Por qué la fórmula vive aquí y no en viajes

`availableSeats` estuvo hasta la Tarea 4 en `libs/domain/trips`, con el conteo
en reservas. Media fórmula en cada librería significaba que viajes importaba
`countCommittedSeats` de reservas y reservas importaba `availableSeats` de
viajes: un ciclo en el grafo de dependencias. La §5.1 de la spec coloca la
regla de cupo en reservas y el conteo ya estaba aquí, así que la resta se mudó
con sus pruebas y la única arista que queda es `trips → reservations`.

`CapacityInput` se declara como una extensión de `CommittedSeats` —cupo total
y pre-vendidos encima de los dos conteos— para que exista una sola definición
de «comprometido» y quien cuenta pueda pasar el resultado directo a la resta.

### El índice parcial no sustituye al bloqueo

El índice único parcial de la sección siguiente impide que **un mismo cliente**
tenga dos reservas vivas en un viaje. No dice nada sobre el cupo: dos clientes
**distintos** pidiendo el último lugar pasan ambos ese índice. Son dos reglas
distintas y cada una necesita su propio mecanismo.

## El listado no hace N+1

`listTrips` resuelve el cupo de toda la página con una sola llamada a
`countCommittedSeatsForTrips`, no con una por viaje. Está medido:
`trip-service.spec.ts` cuenta las consultas que emite el cliente de base de
datos y comprueba que listar cinco viajes cuesta lo mismo que listar uno
(3 consultas en ambos casos; con un conteo por viaje serían 7 para cinco).

## Una reserva viva por cliente y viaje

Una reserva es una persona, decidido en Fase 1: nadie puede tener dos
reservas **vivas** (`HELD` o `ACTIVE`) simultáneas para el mismo viaje.

Esto se aplica con un índice único **parcial** sobre
`(trip_id, customer_id)`, restringido a `status IN ('HELD', 'ACTIVE')`:

```sql
CREATE UNIQUE INDEX "reservations_live_trip_customer_key"
  ON "reservations"("trip_id", "customer_id")
  WHERE "status" IN ('HELD', 'ACTIVE');
```

Tiene que ser **parcial**, no un `@@unique` total sobre esas dos columnas:
una reserva `CANCELLED` o `EXPIRED` no debe impedir que el mismo cliente
reserve otra vez el mismo viaje más adelante. Un índice único total
rechazaría esa segunda reserva aunque la primera ya esté cancelada; el
índice parcial sólo mira las filas vivas.

Prisma no puede expresar un índice parcial en `schema.prisma` (no existe
sintaxis para la cláusula `WHERE` de un índice), así que este índice se
escribe a mano como SQL crudo dentro de la migración
`20261003211241_reservations_payments_notifications` en vez de declararse
con `@@unique` en el modelo. El modelo `Reservation` lleva un comentario que
remite aquí.

## Montos congelados

`total_price_cents` y `minimum_deposit_cents` se copian del viaje al crear la
reserva y ya no cambian si el viaje se edita después. Propagar un cambio de
precio a reservas existentes es una operación explícita que añade la Fase 2B,
nunca un efecto automático de editar el viaje.

`paid_cents` está desnormalizado a propósito: se actualiza en la misma
transacción que el `Payment` que lo mueve, pero la verdad siempre son los
registros `Payment`. Un job nocturno de conciliación (Fase 2A, §6 de la spec,
`reconcilePaidCents` — Tarea 8) compara `paid_cents` contra la suma real de
pagos y avisa si divergen; ver la sección dedicada en `payments.md` y la
frontera transaccional del aviso en `notifications.md`.

`credit_cents` se declara desde ahora en el esquema pero sólo lo llena la
Fase 2B (saldo a favor por pagos retroactivos).

## Los jobs de fondo: `expireHolds` y `warnExpiringHolds` (Tarea 8)

Implementados en `apps/worker/src/jobs/`, no en `libs/domain/reservations`:
son **funciones puras del cliente de base** (`async function(db, queue)`,
sin pg-boss dentro), para poder probarlas invocándolas dos veces seguidas
sin levantar un planificador. `apps/worker/src/main.ts` es lo único que sabe
que existe pg-boss; registra ambas con su cadencia y nada más.

| Job | Cadencia | Qué hace |
|---|---|---|
| `expireHolds` | cada 5 minutos | Pasa a `EXPIRED` cada `HELD` con `hold_expires_at` vencido, cancela sus Payment Intents pendientes (ver abajo) y avisa `HOLD_EXPIRED` al cliente. |
| `warnExpiringHolds` | cada hora | Avisa `HOLD_EXPIRING` a quien le quede menos de un cuarto del plazo de su apartado. |

### `expireHolds`: por qué la escritura es condicional, no por `id`

El `UPDATE` real es `updateMany({ where: { id, status: 'HELD',
holdExpiresAt: { lt: now } }, data: { status: 'EXPIRED', holdExpiresAt: null
} })` — nunca un `update` por `id` a solas. La razón es una condición de
carrera heredada de la revisión de la Tarea 5: este job lee sus candidatos
con un `findMany` sin bloqueo y después abre una transacción por fila para
escribirla, así que nada impide que un pago concurrente active esa misma
reservación en la ventana que queda entre la lectura y la escritura.
Condicionar la escritura a `status: 'HELD'` hace que, si eso ocurre, la
escritura de este job no afecte ninguna fila (encuentra `ACTIVE`, no
`HELD`) en vez de resucitar `EXPIRED` por encima de una activación legítima
que ya se confirmó. `expire-holds.spec.ts`
("does not resurrect or clobber...") fuerza exactamente esa intercalación
con un cliente que pausa la transacción de `expireHolds` justo antes de
escribir, deja correr un `recordPayment` completo en esa ventana, y
comprueba que la reservación termina `ACTIVE`, no `EXPIRED`. La misma
sección en `payments.md` documenta el refuerzo paralelo del otro lado de
esa misma fila.

**Idempotente** por la misma condición: una segunda pasada sobre una fila ya
`EXPIRED` no afecta ninguna fila (`status: 'HELD'` ya no coincide), así que
no reenvía el aviso ni vuelve a intentar cancelar los Payment Intents.

**Cancelación de Payment Intents (§5.3).** El puerto de pagos todavía no
existe en la Tarea 8 -- la Tarea 9 lo construye. `expireHolds` recibe un
tercer parámetro opcional, `cancelPendingPaymentIntents`, sin invocarlo aquí
más que como un hueco inyectado: el mismo stub honesto que la Fase 1 dejó en
`committedSeats` en vez de inventar una dependencia que esta tarea no puede
probar de verdad.

### `warnExpiringHolds`: el umbral es relativo al apartado, no fijo

```
threshold_hours = max(trip.hold_ttl_hours / 4, 1)
avisa si 0 < (hold_expires_at − ahora) ≤ threshold_hours
```

Un umbral fijo ("faltan 18 horas") avisaría de un apartado de 6 horas en el
instante mismo de reservar. Por eso es una fracción del propio
`hold_ttl_hours` del viaje, con un piso de una hora: un apartado de 72 horas
avisa dentro de sus últimas 18; uno de 6 horas, dentro de su última hora y
media, nunca al crearse (6h > 1.5h en ese momento).
`warn-expiring-holds.spec.ts` prueba ambos viajes exactamente para
comprobar que el de 6 horas no avisa de inmediato.

No avisa si `paid_cents` ya alcanzó `minimum_deposit_cents` (debería estar
`ACTIVE` y por tanto fuera del filtro `status: 'HELD'`, pero la comprobación
es explícita de todos modos) ni si ya avisó antes de esa misma reservación.

**Idempotente por `reservationId`, no sólo por `customerId`.** Antes de
avisar, consulta `NotificationDelivery` por `(reservation_id, event_type)`.
`reservation_id` existe en esa tabla desde la Tarea 8 — ver la sección
dedicada en `notifications.md` para por qué `(customer_id, event_type)` solo
era ambiguo (un cliente puede tener más de una reservación `HELD` a la
vez) y por qué este cambio de esquema no estaba en el plan original.

`createReservation(db, { tripId, customerId })`
(`libs/domain/reservations/src/lib/reservation-service.ts`) hace **todo**
dentro de una sola transacción, y en este orden: bloquear el viaje, verificar
que esté publicado, verificar la fecha límite de pago, verificar el correo,
verificar que no haya ya una reserva viva, verificar el cupo, insertar y
auditar. El orden no es estético: contar antes de bloquear deja la ventana
que produce la sobreventa (ver «Por qué el cálculo exige el bloqueo»).

1. **El viaje debe estar `PUBLISHED`.** Un `DRAFT` todavía no existe para el
   cliente y un `CANCELLED`, `IN_PROGRESS` o `COMPLETED` ya no admite
   reservas → `TRIP_NOT_PUBLISHED`.
2. **La fecha límite de pago no puede haber pasado.** Se compara como día de
   calendario en la zona de `SystemSetting['organization.timezone']`
   (`isPastDate`), nunca contra `new Date()` crudo: `payment_deadline` es una
   columna `date`, y en una zona detrás de UTC la comparación ingenua
   convierte «hoy» en «ya pasó» durante las primeras horas de cada día →
   `PAYMENT_DEADLINE_PASSED`. La zona se lee con `organizationTimeZone`
   (`@rm/domain-settings`) — antes copiada aquí, en `trips` y en `payments`;
   sin cambio de regla.
3. **El correo del cliente debe estar verificado.** Navegar el catálogo y
   registrarse no lo exige; reservar sí → `EMAIL_NOT_VERIFIED`.
4. **Una sola reserva viva por cliente y viaje.** La comprobación previa
   reproduce el índice parcial *exactamente*, apartados vencidos incluidos:
   un `HELD` cuyo `hold_expires_at` ya pasó no ocupa lugar, pero sigue siendo
   una fila viva para el índice hasta que el job lo marca `EXPIRED`. La
   consecuencia —hasta cinco minutos en los que el cliente no puede volver a
   reservar ese viaje— es preferible a comprobar algo más estrecho que lo que
   la base impone, que sólo convertiría un error amable en una violación de
   restricción → `DUPLICATE_RESERVATION`.
5. **Debe quedar cupo.** `availableSeats ≥ 1`, calculado bajo el bloqueo de
   fila → `TRIP_SOLD_OUT`.
6. **Los montos se congelan.** `total_price_cents` se copia de
   `price_per_seat_cents` **en ese momento** y `minimum_deposit_cents` del
   viaje; cambiar el precio del viaje después no mueve ninguna reserva
   existente.
7. **El apartado vence según el viaje.** `hold_expires_at = ahora +
   trip.hold_ttl_hours`, nunca una constante del código, y **siempre** se
   escribe: el `CHECK` `reservations_held_requires_hold_expiry` rechaza un
   `HELD` sin fecha, y el conteo de cupo leería esa fila como lugar libre.
8. **El folio es legible y único.** Formato `RM-XXXX-XXXX` sobre un alfabeto
   de 30 caracteres que no contiene `0`/`O`, `1`/`I`/`L` ni `U`: el cliente
   lo dicta por teléfono al mostrador. La unicidad la garantiza el índice
   único `reservations_code_key` **más** un reintento, no el bucle de
   generación: dos creaciones simultáneas pueden leer libre el mismo folio
   antes de que ninguna inserte. Es el mismo reparto que `createTrip` usa
   para el slug. Un segundo choque seguido se reporta como `CONFLICT`, no se
   reintenta sin fin.

El origen es `APP` y `created_by` es el propio cliente. La auditoría
(`reservation.created`) se escribe **dentro** de la misma transacción, así que
no puede existir una reserva sin su registro ni al revés.

## Leer una reserva propia

`getReservationForCustomer(db, reservationId, customerId)` responde lo mismo
—`RESERVATION_NOT_OWNED`— a dos preguntas distintas: «esta reserva es de otro»
y «esta reserva no existe». Es deliberado y es la razón de que ese código
responda **404 y no 403**: un 403 confirmaría que la reserva existe, y dos
códigos distintos lo confirmarían igual aunque ambos respondieran 404. Un
cliente que prueba identificadores ajenos no debe poder distinguir los dos
casos, así que no se distinguen en ningún punto observable: mismo código,
mismo cuerpo, sin `details`.

`listReservationsForCustomer` devuelve el historial completo del cliente —las
canceladas y expiradas incluidas— de la más reciente a la más antigua.

**Cada fila nombra su viaje (Tarea 18, «Mis reservas»):** `tripName` y
`tripDepartureDate`. El cliente no puede resolver un `tripId` por su cuenta:
el listado público va por `slug` y sólo muestra viajes publicados, mientras
que el historial incluye viajes que ya terminaron o se cancelaron. El nombre
sigue la misma regla que el resumen del catálogo público: la traducción en
español y, si no existe, el `slug`, nunca un nombre inventado.
`tripDepartureDate` es una fecha de calendario (`@db.Date`) y se muestra como
ese mismo día, sin correrla por la zona horaria de quien la ve. La consulta
trae el viaje con un solo `include` sobre la misma lectura, sin N+1.

`balance_cents` nunca se almacena: es `total_price_cents − paid_cents` con
piso en cero, recalculado en cada lectura.

## Solicitud de cancelación (§5.6)

`requestCancellation(db, reservationId, customerId, reason?)` sella
`cancellation_requested_at` y `cancellation_reason`, audita
(`reservation.cancellation_requested`) y **no toca el estado**: una reserva
`HELD` sigue `HELD` y su apartado sigue corriendo, una `ACTIVE` sigue
`ACTIVE`, el lugar sigue ocupado y ningún dinero se mueve. Es una solicitud,
no una cancelación; cancelar es una decisión humana con el permiso
`reservation.cancel`.

- **Pedirlo dos veces no duplica ni falla.** Mientras está pendiente, la
  primera solicitud es la que queda, con su motivo, y es la única auditada.
  Si el personal la rechazó, pedirla otra vez abre una nueva (ver «Rechazar
  una solicitud de cancelación»). La idempotencia se consigue
  con un `UPDATE ... WHERE cancellation_requested_at IS NULL` en una sola
  sentencia, no con una lectura seguida de una escritura que otra solicitud
  podría intercalar.
- **Una reserva terminal no admite solicitud.** `CANCELLED` y `EXPIRED` ya no
  tienen nada que cancelar y sellarlas sólo pondría frente al administrador
  un aviso que únicamente puede descartar → `INVALID_STATUS_TRANSITION`.
- **Avisa al personal (Tarea 14).** `requestCancellation` ahora recibe
  también una `NotificationQueue` y, sólo cuando el `UPDATE` de arriba de
  verdad selló la primera solicitud (`sealed.count === 1` — la misma guarda
  que decide si se audita), llama a `notifyAdmins` con
  `CANCELLATION_REQUESTED`: sin ese aviso nadie se entera de que hay algo
  que resolver. Pedirlo dos veces audita una sola vez y **notifica una sola
  vez**, por la misma guarda. `@rm/domain-payments`' `webhook-handler.ts` ya
  dependía de `@rm/domain-notifications` para este mismo tipo de alerta de
  sólo-personal (`ORPHAN_PAYMENT`, `PAID_CENTS_MISMATCH`); esta es la misma
  clase de dependencia, no una nueva — lo que esta nota de arquitectura
  prohíbe de verdad es que `reservations` y `payments` se importen entre sí,
  no que cualquiera de los dos dependa de `notifications`.

## El panel: la bandeja de solicitudes (Tarea 19)

`listReservationsForStaff(db, { tripId?, status?, cancellationPending? })`
devuelve las reservas de **todos** los clientes, con el nombre del viaje y
del cliente en cada fila. Los filtros se combinan con AND.

**Una solicitud está pendiente** (`cancellationPending`) cuando el cliente la
pidió (`cancellation_requested_at` no nulo), el personal **no** la rechazó
(`cancellation_declined_at` nulo) **y** la reserva sigue `HELD` o `ACTIVE`. Es un valor derivado, nunca una columna: una solicitud sobre una
reserva que ya se canceló o venció es historia, no trabajo, y deja de
contarse sola sin que nadie tenga que «cerrarla».

**El orden es la bandeja de trabajo del administrador** y lo decide el
backend, no la pantalla: primero las solicitudes pendientes, de la más antigua
a la más reciente (quien pidió primero se atiende primero); después todo lo
demás, de la reserva más reciente a la más antigua. Pedir sólo pendientes y a
la vez un estado terminal (`?cancellationPending=true&status=CANCELLED`)
responde vacío, no ignora uno de los dos filtros.

No está paginado, igual que `listTrips`: las reservas de una agencia caben en
una respuesta durante el horizonte de esta fase.

`getReservationForStaff(db, id)` devuelve cualquier reserva, con el correo y
el teléfono del cliente, el motivo de su solicitud y quién la canceló. A
diferencia del cliente, un id desconocido es `NOT_FOUND` simple: el personal
con `reservation.view` sí puede saber qué reservas existen, así que no hay
oráculo que proteger. El historial de pagos **no** viene aquí: lo sirve
`@rm/domain-payments` en un endpoint aparte con su propio permiso
(`payment.view`, ver `payments.md`).

## Cancelar una reserva (§5.6, Tarea 19)

`cancelReservation(db, queue, { reservationId, actorId, reason },
cancelPendingPaymentIntents?)` es la decisión humana que la solicitud del
cliente sólo pide. La ruta exige `reservation.cancel` y nada más (un único
permiso, así que `permission` y no `anyPermission`); un actor `CUSTOMER` no
la alcanza aunque un rol le diera ese permiso, porque `requirePermission`
rechaza a todo actor que no sea `STAFF`.

1. **Liberar el lugar no es una escritura propia.** El cupo se deriva
   (§5.1): con la fila en `CANCELLED`, `countCommittedSeats` deja de contarla
   y el lugar vuelve al catálogo. Ninguna columna del viaje cambia. Si algún
   día cancelar resta de un contador almacenado, el modelo se rompió.
2. **El dinero se queda donde está.** `paid_cents` y todas las filas
   `Payment` se conservan intactas. Aplicar ese dinero a otro viaje o
   devolverlo es Fase 2B; borrarlo aquí destruiría el registro contable.
3. **Se registra quién y cuándo.** `cancelled_at` y `cancelled_by`.
   `cancellation_requested_at` y `cancellation_reason` —lo que escribió el
   cliente— **no** se sobrescriben: el motivo del personal va al aviso del
   cliente y a la auditoría, no a la columna del cliente.
4. **Se avisa al cliente** con `RESERVATION_CANCELLED`, con el nombre del
   viaje en su idioma y el motivo del personal, dentro de la misma
   transacción (Regla 11 de `notifications.md`).
5. **Se audita** `reservation.cancelled` con el actor, el estado anterior, el
   motivo y `paid_cents` antes y después (iguales, por la regla 2).
6. **Se cancelan los Payment Intents pendientes**, con el mismo
   `createCancelPendingPaymentIntents` que usa `expireHolds` (ahora en
   `@rm/domain-payments`): una ficha de OXXO que siguiera cobrable para una
   reserva cancelada es dinero que llega por un lugar que ya no existe. Un
   fallo del proveedor se registra y no impide la cancelación. Si la ficha
   se paga de todos modos (la carrera existe), el webhook lo trata como el
   caso límite de §5.3; ver `payments.md`.

**Idempotente.** Cancelar una reserva ya `CANCELLED` responde la reserva
como está: sin segundo aviso, sin segunda entrada de auditoría y sin volver a
cancelar intents. La escritura es un `updateMany` condicionado a `status IN
('HELD', 'ACTIVE')`, así que dos personas pulsando a la vez —o un pago que
activa la reserva en medio— se resuelven en la base: exactamente una voltea
la fila y hace el resto; la otra relee, ve `CANCELLED` y responde igual.

**Una reserva `EXPIRED` no se cancela** → `INVALID_STATUS_TRANSITION`. Su
lugar ya está libre y no hay nada que decidir; reetiquetarla reescribiría lo
que pasó.

## Rechazar una solicitud de cancelación (§5.6)

La otra decisión posible del personal. `declineCancellationRequest(db, queue,
{ reservationId, actorId, reason })` cierra la solicitud **sin tocar la
reserva**: el estado, el apartado, el lugar y el dinero siguen exactamente
igual. Mismo permiso que cancelar, `reservation.cancel`: quien puede decidir
una solicitud en un sentido puede decidirla en el otro.

1. **Se registra la decisión** en tres columnas propias:
   `cancellation_declined_at`, `cancellation_declined_by` y
   `cancellation_decline_reason`. El motivo del cliente
   (`cancellation_reason`) no se sobrescribe.
2. **Se avisa al cliente** con `CANCELLATION_DECLINED` y el motivo, dentro de
   la misma transacción, y se audita `reservation.cancellation_declined`.
3. **Deja de estar pendiente**: sale de la bandeja del panel.
4. **Idempotente**, con el mismo `updateMany` condicionado que cancelar:
   rechazar dos veces responde la misma decisión, sin segundo aviso ni segunda
   auditoría, y conserva el primer motivo.
5. **Sin solicitud no hay nada que rechazar** → `NO_CANCELLATION_REQUEST`. Una
   reserva ya `CANCELLED` o `EXPIRED` → `INVALID_STATUS_TRANSITION`.

**El cliente puede volver a pedirla.** Una solicitud rechazada está cerrada,
así que `requestCancellation` sobre ella abre una nueva: sella la fecha y el
motivo nuevos, limpia el rechazo anterior, audita y avisa al personal otra
vez. Una solicitud todavía pendiente, en cambio, sigue siendo la que manda
(pedir dos veces sigue sin efecto).

Rechazar no impide cancelar después: si la situación cambia, el personal puede
cancelar la reserva aunque haya rechazado antes una solicitud.

## Errores de este módulo

| Código | Cuándo | HTTP |
|---|---|---|
| `TRIP_NOT_PUBLISHED` | El viaje no está en `PUBLISHED`. | 409 |
| `PAYMENT_DEADLINE_PASSED` | `payment_deadline` ya pasó en la zona de la organización. | 409 |
| `EMAIL_NOT_VERIFIED` | El cliente no ha confirmado su correo. | 403 |
| `DUPLICATE_RESERVATION` | El cliente ya tiene una reserva `HELD` o `ACTIVE` en ese viaje. | 409 |
| `TRIP_SOLD_OUT` | No queda cupo disponible. | 409 |
| `NOT_FOUND` | El viaje no existe, o el id de cliente no corresponde a un cliente; en el panel, la reserva no existe. | 404 |
| `RESERVATION_NOT_OWNED` | La reserva no existe **o** es de otro cliente. | 404 |
| `INVALID_STATUS_TRANSITION` | Se solicita cancelar una reserva ya `CANCELLED` o `EXPIRED`; el personal intenta cancelar una `EXPIRED`, o rechazar la solicitud de una reserva que ya no está viva. | 409 |
| `NO_CANCELLATION_REQUEST` | El personal intenta rechazar una solicitud que no existe. | 409 |
| `CONFLICT` | Dos choques seguidos de folio: generador roto, no mala suerte. | 409 |
