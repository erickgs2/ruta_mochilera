# Viajes

## Estados

DRAFT → PUBLISHED → IN_PROGRESS → COMPLETED. `CANCELLED` es alcanzable desde
DRAFT, PUBLISHED e IN_PROGRESS. `COMPLETED` y `CANCELLED` son terminales: de
ellos no sale ninguna transición, ni siquiera a `CANCELLED`.

Implementado en `libs/domain/trips/src/lib/trip-status.ts`.

## Requisitos para publicar

Un viaje sólo pasa a `PUBLISHED` si tiene **al menos una imagen** y un
`price_per_seat_cents` mayor que cero. El error `TRIP_NOT_PUBLISHABLE` incluye
en `details.missing` la lista de lo que falta.

## Cupo disponible

```
available_seats = total_capacity − pre_sold_seats − reservas ACTIVE − apartados HELD vigentes
```

**Nunca se almacena.** Un contador mutable es donde aparece la sobreventa cuando
dos personas reservan el último lugar en el mismo segundo. En la Fase 2, el
cálculo ocurre dentro de una transacción que bloquea la fila del viaje.

`pre_sold_seats` son los lugares vendidos fuera del sistema durante el arranque
en caliente, que la agencia no quiso capturar uno por uno.

En la Fase 1 todavía no existe el modelo `Reservation`, así que las reservas
activas y los apartados vigentes se calculan con un stub
(`committedSeats` en `trip-service.ts`) que siempre regresa cero. La Fase 2
sustituye ese stub por las consultas reales contra `Reservation`.

## Validaciones al crear y editar

| Regla | Error |
|---|---|
| `total_capacity > 0` | `INVALID_CAPACITY` |
| `0 ≤ pre_sold_seats ≤ total_capacity` | `INVALID_CAPACITY` |
| `return_date ≥ departure_date` | `VALIDATION_FAILED` |
| `payment_deadline ≤ departure_date` | `VALIDATION_FAILED` |
| Existe traducción en español | `MISSING_REQUIRED_TRANSLATION` |
| Al editar, `total_capacity` no baja de lo ya comprometido | `CAPACITY_BELOW_COMMITTED` |

El inglés es **opcional**: cuando falta, la app muestra el español.

## Slug

Se genera del nombre en español más el año de salida (`oaxaca-magica-2026`) y se
desambigua con un contador si ya existe. **Nunca cambia al editar**: puede estar
compartido en redes sociales.

## Arranque en caliente

Crear un viaje con fecha de salida pasada, con `pre_sold_seats > 0` **o** con un
estado inicial distinto de `DRAFT` exige el permiso `data.backfill`. Basta con
que se cumpla **cualquiera** de las tres condiciones — no hace falta que se
cumplan todas — porque de lo contrario alguien podría crear un viaje con fecha
pasada sin el permiso con sólo dejar `pre_sold_seats` en cero. El viaje queda
marcado con `is_backfilled = true` y la creación se registra en `audit_logs`.
