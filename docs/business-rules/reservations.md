# Reservas

## Estados

`HELD` → `ACTIVE` → `CANCELLED`. `EXPIRED` se alcanza sólo desde `HELD`
(un apartado cuyo `hold_expires_at` pasó sin que se cubriera el depósito
mínimo). `CANCELLED` y `EXPIRED` son terminales.

Implementado en el modelo `Reservation` (`libs/db/prisma/schema.prisma`). La
Tarea 3 añade `libs/domain/reservations` con las transiciones y las reglas
de apartado, depósito y cancelación (§5.2–§5.6 de
`docs/superpowers/specs/2026-10-03-fase-2a-reservas-y-pagos-diseno.md`); este
archivo documenta por ahora sólo lo que ya existe en el esquema.

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
