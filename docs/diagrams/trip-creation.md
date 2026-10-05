# Flujo de creación de viaje

```mermaid
flowchart TD
    A[Administrador abre 'Nuevo viaje'] --> B[Captura fechas, cupo,<br/>anticipo mínimo y TTL de apartado]
    B --> C[Captura traducciones]
    C --> D{¿Existe traducción<br/>en español?}
    D -- No --> E[MISSING_REQUIRED_TRANSLATION]
    D -- Sí --> F{¿Cupo válido y<br/>fechas coherentes?}
    F -- No --> G[INVALID_CAPACITY<br/>o VALIDATION_FAILED]
    F -- Sí --> H{"¿is_backfilled=true, fecha pasada (según<br/>timezone de la organización), cupo<br/>pre-vendido, o estado inicial ≠ DRAFT?"}
    H -- Sí --> I{¿Tiene permiso<br/>data.backfill?}
    I -- No --> J[PERMISSION_DENIED]
    I -- Sí --> K[Marca is_backfilled = true]
    H -- No --> L[Estado inicial DRAFT]
    K --> M[Genera slug único]
    L --> M
    M --> N[(Transacción:<br/>trip + translations + audit_log)]
    N --> O[Viaje creado]
    O --> P[Carga de imágenes]
    O --> Q[Vista de costeo<br/>ver trip-costing.md]
    P --> R{"¿Tiene imagen<br/>y precio > 0?"}
    Q --> R
    R -- No --> S[TRIP_NOT_PUBLISHABLE<br/>details.missing]
    R -- Sí --> T[Publicar: PUBLISHED<br/>published_at = now]
```

## Estados

```mermaid
stateDiagram-v2
    [*] --> DRAFT
    [*] --> IN_PROGRESS: sólo con data.backfill
    DRAFT --> PUBLISHED: requiere imagen y precio
    DRAFT --> CANCELLED
    PUBLISHED --> IN_PROGRESS
    PUBLISHED --> CANCELLED
    IN_PROGRESS --> COMPLETED
    IN_PROGRESS --> CANCELLED
    COMPLETED --> [*]
    CANCELLED --> [*]
```

## Cupo en el listado de viajes

`listTrips` no recalcula el cupo disponible viaje por viaje: junta todos los
ids de la página y los resuelve en una sola llamada a
`committedSeatsForTrips`, la variante agrupada de `committedSeats` (ver
`docs/business-rules/trips.md`, sección «Cupo disponible»). El detalle de un
viaje sigue usando la variante de un solo id. Ambas delegan en
`libs/domain/reservations`, que es también de donde `trip-service.ts` importa
`availableSeats`, la resta que aparece en el último nodo del diagrama; el
conteo real se documenta en `docs/diagrams/trip-reservation.md`.

```mermaid
flowchart TD
    A[listTrips] --> B[Busca viajes de la página]
    B --> C["committedSeatsForTrips(db, ids)<br/>una sola llamada"]
    C --> D[Mapa id → comprometido]
    D --> E["Para cada viaje:<br/>availableSeats = cupo − pre-vendido − comprometido"]
```

Medido: 3 consultas para un viaje y 3 para cinco. Un conteo por viaje daría 7
para cinco.

La «timezone de la organización» del nodo H se lee con `organizationTimeZone`
(`@rm/domain-settings`) — antes copiada aquí, en `reservations` y en
`payments`; sin cambio de regla.

## Editar el cupo bloquea la fila del viaje

```mermaid
flowchart TD
    A[updateTrip] --> B[(BEGIN)]
    B --> C["lockTripForCapacity (FOR UPDATE)"]
    C --> D["committedSeats: reservas ACTIVE + apartados vigentes"]
    D --> E{"¿total_capacity nuevo ≥<br/>pre-vendido + comprometido?"}
    E -- No --> F["CAPACITY_BELOW_COMMITTED<br/>details.alreadyTaken"]
    E -- Sí --> G[Actualiza viaje y traducciones]
    G --> H{"¿Cambió total_capacity?"}
    H -- Sí --> I["repriceTrip (ver trip-costing.md)"]
    H -- No --> J[(COMMIT)]
    I --> J
```

## Catálogo público: dos DTOs distintos, no el mismo `TripDto` recortado

Ver `docs/business-rules/trips.md`, sección "El catálogo público", para la
regla completa. El diagrama es sólo la bifurcación: la misma tabla `trips`,
dos lecturas con formas de salida que nunca convergen.

```mermaid
flowchart TD
    A[(tabla trips)] --> B["getTrip / listTrips<br/>(panel, autenticado)"]
    A --> C["getPublishedTripBySlug / listPublishedTrips<br/>(público, sin autenticación)"]
    B --> D["TripDto / TripSummaryDto<br/>incluye budgetTotalCents, marginMode,<br/>marginValue, preSoldSeats, createdById"]
    C --> E{"¿status = PUBLISHED?"}
    E -- No --> F[NOT_FOUND]
    E -- Sí --> G["PublicTripDetailDto / PublicTripSummaryDto<br/>fotos, itinerario, precio, fechas,<br/>cupo disponible — nada de costeo ni autoría"]
```
