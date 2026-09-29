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

## Galería de imágenes

Implementado en `libs/domain/trips/src/lib/trip-image-service.ts`
(`addTripImage`, `deleteTripImage`), no en el handler HTTP: son reglas de
negocio sobre la galería del viaje, y viven en el dominio por la misma razón
que el recálculo de precio al cambiar el cupo (ver arriba) — así una CLI o una
importación que llamen a estas funciones directamente obtienen las mismas
garantías que el endpoint.

- **La primera imagen subida** para un viaje se marca automáticamente como
  **portada** (`is_cover = true`).
- Las imágenes se numeran (`position`) en el orden en que se suben, empezando
  en 0.
- **Al eliminar la portada**, la siguiente imagen por `position` la sustituye
  automáticamente. Esa promoción ocurre en la **misma transacción** que borra
  la fila eliminada.
- El objeto almacenado se elimina **después** de que la transacción que borra
  la fila (y promueve la siguiente portada) haya confirmado, nunca antes. El
  orden inverso —borrar primero el objeto— fallaría peor: si la transacción
  después revirtiera, la fila quedaría apuntando a un objeto que ya no existe,
  y cualquiera vería una imagen rota de forma indefinida. Con el orden
  elegido, el único modo de falla es un objeto huérfano en el almacenamiento
  —bytes que ya nadie referencia— si el borrado físico falla después de que
  la base de datos ya confirmó el cambio: un problema de espacio desperdiciado
  que una tarea de limpieza periódica puede resolver, nunca una referencia
  rota visible para un cliente.

Lo que **no** vive aquí: aceptar el `multipart/form-data`, verificar los bytes
mágicos del archivo (para no confiar en el `Content-Type` que declara el
navegador) y aplicar el límite de tamaño. Eso es trabajo de transporte —
hechos sobre lo que llegó por la red, no reglas sobre la galería— y se queda
en el handler HTTP (`apps/api/.../images/route.ts`).

`libs/domain/trips` recibe el proveedor de almacenamiento inyectado como el
puerto `StorageProvider` de `@rm/storage` (la interfaz, nunca la
implementación local o S3 concreta) — la misma razón por la que recibe el
cliente Prisma inyectado en vez de construirlo él mismo.

## Cupo disponible

```
available_seats = total_capacity − pre_sold_seats − reservas ACTIVE − apartados HELD vigentes
```

**Nunca se almacena.** Un contador mutable es donde aparece la sobreventa cuando
dos personas reservan el último lugar en el mismo segundo. En la Fase 2, el
cálculo ocurre dentro de una transacción que bloquea la fila del viaje; hoy,
con `committedSeats` siempre en cero, no hay nada que ese bloqueo protegería
todavía, así que no existe (ver más abajo).

`pre_sold_seats` son los lugares vendidos fuera del sistema durante el arranque
en caliente, que la agencia no quiso capturar uno por uno.

En la Fase 1 todavía no existe el modelo `Reservation`, así que las reservas
activas y los apartados vigentes se calculan con un stub (`committedSeats` en
`trip-service.ts`) que siempre regresa cero. **Los tres puntos donde se calcula
el cupo** — el detalle de un viaje, el listado (`listTrips`) y la validación de
cupo al editar — pasan por este mismo stub, así que los tres cambian en
conjunto el día que la Fase 2 lo sustituya por las consultas reales contra
`Reservation`; ninguno calcula por su cuenta.

## Validaciones al crear y editar

| Regla | Al crear | Al editar |
|---|---|---|
| `total_capacity > 0` | `INVALID_CAPACITY` | `INVALID_CAPACITY` |
| `pre_sold_seats ≥ 0` | `INVALID_CAPACITY` | `INVALID_CAPACITY` |
| `pre_sold_seats ≤ total_capacity` | `INVALID_CAPACITY` | `CAPACITY_BELOW_COMMITTED` (ver nota) |
| `return_date ≥ departure_date` | `VALIDATION_FAILED` | `VALIDATION_FAILED` |
| `payment_deadline ≤ departure_date` | `VALIDATION_FAILED` | `VALIDATION_FAILED` |
| Existe traducción en español | `MISSING_REQUIRED_TRANSLATION` | `MISSING_REQUIRED_TRANSLATION` |

Nota: al crear, un viaje nuevo no tiene nada "ya comprometido" todavía, así que
exceder el cupo con `pre_sold_seats` es sencillamente un dato inválido
(`INVALID_CAPACITY`). Al editar, esa misma condición se evalúa como parte de
"¿el cupo nuevo alcanza para lo que ya está comprometido?" (`pre_sold_seats`
que se va a persistir, más reservas activas y apartados vigentes — hoy
siempre cero), así que produce el código más específico
`CAPACITY_BELOW_COMMITTED` en su lugar. Esta verificación se calcula **con el
valor de `pre_sold_seats` que se va a guardar**, no con el valor anterior: son
datos que el propio formulario de edición está sobrescribiendo, así que el
piso que protege esta regla tiene que ser el número que será cierto en cuanto
la edición se guarde.

El inglés es **opcional**: cuando falta, la app muestra el español.

## Cambiar el cupo recalcula el precio del viaje

`total_capacity` es un divisor de la fórmula de precio por vacante (ver
`docs/business-rules/costing.md`). Por eso `updateTrip`, cuando el cupo
cambia, llama a `repriceTrip` (`libs/domain/costing`) **dentro de la misma
transacción** que escribe el nuevo `total_capacity` — nunca desde el
controlador HTTP, para que una CLI o una importación que llamen a `updateTrip`
directamente obtengan la misma garantía.

Antes de la Tarea 14 esto no pasaba: `updateTrip` vive en
`libs/domain/trips` y el costeo en `libs/domain/costing`, y nada los conectaba.
El síntoma quedaba oculto porque la ruta de lectura del costeo recalculaba y
guardaba el precio en cada vista, así que un precio obsolete se autocorregía
la próxima vez que alguien abría la pantalla. Esa escritura se quitó
correctamente de la ruta de lectura (una lectura no debe escribir), así que el
precio obsoleto ahora es permanente hasta que este código lo corrige.

Si el cupo no cambia, `updateTrip` no llama a `repriceTrip`: no hay nada que
recalcular.

## Slug

Se genera del nombre en español más el año de salida (`oaxaca-magica-2026`) y se
desambigua con un contador si ya existe. **Nunca cambia al editar**: puede estar
compartido en redes sociales.

Dos creaciones concurrentes con el mismo nombre pueden pasar la verificación
previa antes de que cualquiera haya insertado, y chocar contra el índice único
de la base de datos. Ese choque no se propaga como error interno: se recalcula
el siguiente slug disponible contra el estado actual de la tabla y se
reintenta la inserción una vez (el slug es generado por el sistema, no elegido
por quien llama, así que la respuesta correcta es que ambas creaciones
terminen existiendo con slugs distintos, no que la segunda reciba un
conflicto que tenga que resolver a mano). Un segundo choque seguido — una
carrera mucho mayor que dos solicitudes concurrentes normales — sí se reporta
como `CONFLICT`.

## Arranque en caliente

Crear un viaje exige el permiso `data.backfill` en cuanto se cumple
**cualquiera** de estas cuatro condiciones — no hace falta que se cumplan
todas:

1. El llamador pide explícitamente `is_backfilled = true`.
2. La fecha de salida ya pasó.
3. `pre_sold_seats > 0`.
4. El estado inicial es distinto de `DRAFT`.

Es una condición `OR`, nunca `AND`: de lo contrario alguien podría crear un
viaje con fecha pasada sin el permiso con sólo dejar `pre_sold_seats` en cero,
o marcar un viaje corriente como backfilled (ensuciando la bitácora de
auditoría) sin sostener el permiso que ese rótulo implica. El viaje queda
marcado con `is_backfilled = true` y la creación se registra en `audit_logs`.

La fecha de salida es una columna `DATE` sin zona horaria: "¿ya pasó?" se
evalúa comparando el día calendario de `departure_date` contra el día
calendario de "hoy" en `SystemSetting.organization.timezone` (por defecto
`America/Mexico_City`, UTC−6) — nunca comparando instantes UTC en crudo. Esa
comparación ingenua clasificaría mal un viaje que sale "hoy" durante las
primeras horas del día en UTC, seis horas antes de que empiece el día en
Ciudad de México. Implementado en `isPastDate` (`@rm/shared-utils/calendar.ts`).
