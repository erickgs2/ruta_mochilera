# Reservas

## Estados

`HELD` → `ACTIVE` → `CANCELLED`. `EXPIRED` se alcanza sólo desde `HELD`
(un apartado cuyo `hold_expires_at` pasó sin que se cubriera el depósito
mínimo). `CANCELLED` y `EXPIRED` son terminales.

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

El cálculo vive en `availableSeats` (`@rm/domain-trips`, la fórmula pura) y los
conteos en `libs/domain/reservations/src/lib/capacity.ts`:

| Función | Para qué |
|---|---|
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
registros `Payment`. Un job nocturno de conciliación (Fase 2A, §6 de la spec)
compara `paid_cents` contra la suma real de pagos y avisa si divergen —ver
`NotificationDelivery` en `payments.md` (pendiente) y `notifications.md`
(pendiente).

`credit_cents` se declara desde ahora en el esquema pero sólo lo llena la
Fase 2B (saldo a favor por pagos retroactivos).
