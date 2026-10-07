# Cupo de un viaje y bloqueo de fila

Diagramas de `libs/domain/reservations`. Las reglas en prosa están en
`docs/business-rules/reservations.md`.

## Tomar un lugar bajo bloqueo

El orden importa: **primero** el bloqueo, después el conteo, después la
decisión y al final la escritura. Contar antes de bloquear deja exactamente la
ventana que produce la sobreventa.

Los tres pasos centrales —`lockTripForCapacity`, `countCommittedSeats` y
`availableSeats`— viven todos en
`libs/domain/reservations/src/lib/capacity.ts` desde la Tarea 4 (ver
`docs/business-rules/reservations.md`, «Por qué la fórmula vive aquí y no en
viajes»).

```mermaid
flowchart TD
    A[Intento de reserva] --> B[("BEGIN (READ COMMITTED)")]
    B --> C["lockTripForCapacity:<br/>SELECT id FROM trips WHERE id = $1 FOR UPDATE"]
    C --> D["countCommittedSeats:<br/>una consulta agrupada sobre reservations"]
    D --> E["availableSeats = total_capacity − pre_sold_seats<br/>− ACTIVE − HELD vigentes"]
    E --> F{"¿availableSeats ≥ 1?"}
    F -- No --> G[TRIP_SOLD_OUT]
    F -- Sí --> H[INSERT de la reserva en HELD]
    H --> I[(COMMIT: se libera el bloqueo)]
    G --> J[(ROLLBACK)]
```

## Dos clientes y un solo lugar

Lo que el bloqueo decide. B no lee un conteo viejo: espera a que A termine y
entonces cuenta, y ya ve el lugar tomado.

```mermaid
sequenceDiagram
    participant A as "Cliente A"
    participant DB as PostgreSQL
    participant B as "Cliente B"

    A->>DB: "BEGIN, SELECT ... FOR UPDATE (viaje X)"
    DB-->>A: "bloqueo concedido"
    B->>DB: "BEGIN, SELECT ... FOR UPDATE (viaje X)"
    Note over B,DB: "B queda esperando: A tiene la fila"
    A->>DB: "conteo = 0 comprometidos, queda 1 lugar"
    A->>DB: "INSERT reserva, COMMIT"
    DB-->>B: "bloqueo concedido (A ya hizo COMMIT)"
    B->>DB: "conteo = 1 comprometido, quedan 0 lugares"
    B-->>B: "TRIP_SOLD_OUT, ROLLBACK"
```

Sin el `FOR UPDATE`, B no espera: cuenta cero al mismo tiempo que A, inserta
igual y el viaje queda sobrevendido. La prueba
`lets exactly one of two concurrent reservations take the last seat` fija ese
comportamiento; quitar el bloqueo la pone en rojo con dos éxitos.

El bloqueo es de **fila**: una reserva al viaje Y no espera por el bloqueo del
viaje X.

## Qué ocupa lugar y qué no

```mermaid
flowchart LR
    A["ACTIVE"] --> O["Ocupa lugar"]
    B["HELD con hold_expires_at > ahora"] --> O
    C["HELD vencido"] --> L["No ocupa: el lugar está libre"]
    D["CANCELLED"] --> L
    E["EXPIRED"] --> L
```

Ningún estado terminal requiere tocar un contador para devolver el lugar: el
cupo se deriva de estas filas en cada lectura y nunca se almacena.

La rama «HELD vencido» depende de que todo `HELD` **tenga** fecha de
vencimiento: con `hold_expires_at` nulo la comparación no es cierta y la fila
caería en «no ocupa» estando viva. El `CHECK`
`reservations_held_requires_hold_expiry` impide esa fila, así que el diagrama
no tiene un cuarto caso (ver `docs/business-rules/reservations.md`).

## Del botón «Reservar» a `HELD`

Las cinco bifurcaciones de rechazo, en el orden en que `createReservation` las
evalúa, todas dentro de la misma transacción y todas después del bloqueo.
`NOT_FOUND` (viaje o cliente inexistente) no aparece como bifurcación de
negocio: es la ausencia del dato sobre el que se decide.

```mermaid
flowchart TD
    A["El cliente pulsa «Reservar»"] --> B[("BEGIN")]
    B --> C["lockTripForCapacity: SELECT ... FOR UPDATE"]
    C --> D{"¿El viaje está PUBLISHED?"}
    D -- No --> R1["TRIP_NOT_PUBLISHED"]
    D -- Sí --> E{"¿payment_deadline sigue vigente<br/>en la zona de la organización?"}
    E -- No --> R2["PAYMENT_DEADLINE_PASSED"]
    E -- Sí --> F{"¿El correo está verificado?"}
    F -- No --> R3["EMAIL_NOT_VERIFIED"]
    F -- Sí --> G{"¿Ya tiene una reserva HELD o ACTIVE<br/>en este viaje?"}
    G -- Sí --> R4["DUPLICATE_RESERVATION"]
    G -- No --> H["countCommittedSeats + availableSeats"]
    H --> I{"¿Queda al menos un lugar?"}
    I -- No --> R5["TRIP_SOLD_OUT"]
    I -- Sí --> J["Folio RM-XXXX-XXXX único"]
    J --> K["INSERT en HELD:<br/>precio congelado,<br/>hold_expires_at = ahora + hold_ttl_hours,<br/>source APP o BRANCH, created_by"]
    K --> L["recordAudit: reservation.created"]
    L --> P{"¿Mostrador con pago inicial?"}
    P -- No --> M[("COMMIT")]
    P -- Sí --> Q["recordInitialPayment (inyectado):<br/>CASH con folio, paid_cents,<br/>HELD → ACTIVE si cubre el anticipo"]
    Q --> Q2{"¿Pago aceptado?"}
    Q2 -- Sí --> M
    Q2 -- No --> R6["Su error (p. ej. PAYMENT_EXCEEDS_BALANCE)"]
    R6 --> X
    R1 --> X[("ROLLBACK")]
    R2 --> X
    R3 --> X
    R4 --> X
    R5 --> X
```

El folio tiene dos redes: el bucle que descarta candidatos ya tomados y el
índice único `reservations_code_key`, que es el que de verdad decide. Una
violación de ese índice reintenta la transacción completa una vez; una
violación de `reservations_live_trip_customer_key` se traduce a
`DUPLICATE_RESERVATION`, que es la carrera que la comprobación previa no
puede cerrar sola.

La captura histórica (Fase 2B, `createBackfilledReservation`) también recorre
este camino con tres diferencias: acepta viajes en cualquier estado salvo
`DRAFT` y `CANCELLED` en el nodo D, se salta los nodos E y F (fecha límite y
correo verificado), e inserta `ACTIVE` sin apartado con su `created_at`
pasado. El cupo (nodos G a I) se decide igual.

La reserva en mostrador (Fase 2B, `createBranchReservation`) recorre **el
mismo camino**, con `source = BRANCH` y `created_by` = el trabajador. Si trae
pago inicial, el pago se escribe con el gancho inyectado antes del `COMMIT`:
un pago rechazado revierte también la reserva. Ver `counter-sale.md`.

La «zona de la organización» del nodo E se lee con `organizationTimeZone`
(`@rm/domain-settings`) — antes copiada aquí, en `trips` y en `payments`; sin
cambio de regla.

## Solicitar la cancelación no cambia el estado

```mermaid
flowchart LR
    A["El cliente solicita cancelar"] --> B{"¿Es suya y sigue viva?"}
    B -- No --> C["RESERVATION_NOT_OWNED<br/>o INVALID_STATUS_TRANSITION"]
    B -- Sí --> D{"¿Ya la había solicitado?"}
    D -- Sí --> E["No escribe nada:<br/>la primera solicitud es la que queda"]
    D -- No --> F["Sella cancellation_requested_at<br/>y cancellation_reason"]
    F --> G["recordAudit:<br/>reservation.cancellation_requested"]
    G --> G2["notifyAdmins:<br/>CANCELLATION_REQUESTED (Tarea 14)"]
    G2 --> H["El estado sigue igual:<br/>HELD sigue venciendo, el lugar sigue ocupado"]
    E --> H
```

Cancelar de verdad —liberar el lugar y mover dinero— es una decisión humana
con el permiso `reservation.cancel`, no un efecto de esta solicitud. El aviso
a quien sí tiene ese permiso (nodo `G2`, Tarea 14) es lo que pone la
solicitud frente a esa persona; sin él, sellar la columna no alcanza por
nadie a menos que alguien revise la base a mano.

## «Mis reservas»: el listado del cliente (Tarea 18)

```mermaid
flowchart LR
    A["GET /reservations"] --> B["listReservationsForCustomer:<br/>reservas del cliente, más recientes primero,<br/>canceladas y vencidas incluidas"]
    B --> C["include trip:<br/>slug, departure_date,<br/>traducción es"]
    C --> D["Fila: folio, estado, saldo,<br/>tripName = nombre es o slug,<br/>tripDepartureDate"]
```

El nombre del viaje usa la misma regla que el resumen del catálogo público.
Ver `docs/business-rules/reservations.md`, «Leer una reserva propia».

## Estados de una reserva y quién dispara cada transición

El ciclo completo a la fecha de la Fase 2B. El esquema no tiene un estado
`COMPLETED` para la reserva; el viaje sí lo tiene, la reserva no.

```mermaid
stateDiagram-v2
    [*] --> HELD: "createReservation (la app) o createBranchReservation (mostrador, sin pago o con pago menor al anticipo)"
    [*] --> ACTIVE: "mostrador con pago inicial que cubre el anticipo, o captura histórica"
    HELD --> ACTIVE: "pago que cubre el anticipo (paid_cents ≥ anticipo mínimo), por webhook, efectivo en mostrador o saldo a favor"
    HELD --> EXPIRED: "job expireHolds, con hold_expires_at vencido"
    HELD --> CANCELLED: "cancelReservation (personal con reservation.cancel)"
    ACTIVE --> CANCELLED: "cancelReservation (personal con reservation.cancel)"
    EXPIRED --> HELD: "revive el mostrador (efectivo o saldo) si queda lugar y el viaje sigue publicado, con apartado nuevo"
    HELD --> HELD: "revive el mostrador si su apartado ya venció, con apartado nuevo"
    CANCELLED --> [*]
```

Los dos jobs de `apps/worker` que tocan este ciclo: `expireHolds` (cada 5
minutos) dispara `HELD → EXPIRED`, pasa lo ya pagado al saldo del cliente
(`EXPIRATION`, en la misma transacción) y cancela los Payment Intents pendientes;
`warnExpiringHolds` (cada hora) no cambia el estado, sólo avisa
`HOLD_EXPIRING` cuando queda menos de un cuarto del plazo del apartado.
Revivir `EXPIRED` o un `HELD` vencido (decisión 13) lo hace sólo una persona en
el mostrador, bajo el candado del viaje; `CANCELLED` no revive. Si el cobro
cubre el anticipo, la reserva pasa enseguida a `ACTIVE`.
`HELD → ACTIVE` no lo dispara ningún job: llega con el webhook de Stripe (o,
en la Fase 2B, con un pago en efectivo o con saldo a favor registrado por el
personal), nunca con la respuesta de la app. Un cambio de precio no mueve el
estado: una `ACTIVE` sigue `ACTIVE` aunque ahora deba más.

La solicitud del cliente (`requestCancellation`) **no** es una transición: no
aparece en este diagrama porque no cambia el estado. Sólo pone la reserva en
la bandeja del personal (sección anterior).

## Cambio de precio a reservas existentes (Fase 2B)

```mermaid
flowchart TD
    A["GET /trips/{id}/price-change<br/>(vista previa)"] --> B{"¿Reservas HELD o ACTIVE<br/>con total distinto al precio vigente?"}
    B -- No --> R0["409 NO_PRICE_CHANGE"]
    B -- Sí --> C["El administrador escribe el aviso<br/>(español obligatorio, inglés opcional)"]
    C --> D[("BEGIN")]
    D --> E["Candado del viaje, luego de cada reserva<br/>en orden de id, y relectura"]
    E --> F["Por cada reserva: ReservationPriceChange"]
    F --> G["total_price_cents = precio vigente<br/>(estado y anticipo no cambian)"]
    G --> H{"¿paid_cents > nuevo total?"}
    H -- Sí --> I["paid_cents -= diferencia<br/>PRICE_DECREASE por la diferencia (gancho)"]
    H -- No --> J
    I --> J["AuditLog + aviso PRICE_CHANGED<br/>en el idioma del cliente"]
    J --> K[("COMMIT")]
```

## Cancelar desde el panel (Tarea 19)

```mermaid
flowchart TD
    A["El personal pulsa «Cancelar reserva»<br/>con un motivo"] --> P{"¿Tiene reservation.cancel<br/>y es STAFF?"}
    P -- No --> R0["403 PERMISSION_DENIED"]
    P -- Sí --> B[("BEGIN")]
    B --> C{"¿Existe la reserva?"}
    C -- No --> R1["NOT_FOUND"]
    C -- Sí --> D["UPDATE ... SET status = CANCELLED,<br/>cancelled_at, cancelled_by<br/>WHERE status IN (HELD, ACTIVE)"]
    D --> E{"¿Volteó la fila?"}
    E -- No --> F{"Estado actual"}
    F -- "CANCELLED" --> OK1["Responde la reserva como está:<br/>sin aviso ni auditoría (idempotente)"]
    F -- "EXPIRED" --> R2["INVALID_STATUS_TRANSITION"]
    E -- Sí --> G0["Relee paid_cents bajo el candado<br/>que tomó el UPDATE"]
    G0 --> G["recordAudit: reservation.cancelled<br/>(actor, motivo, paid_cents)"]
    G --> CR{"¿paid_cents > 0?"}
    CR -- Sí --> CF["creditFromCancellation (inyectado):<br/>movimiento CANCELLATION por paid_cents"]
    CR -- No --> H
    CF --> H["notifyCustomer: RESERVATION_CANCELLED"]
    H --> J[("COMMIT")]
    J --> I["cancelPendingPaymentIntents, después del COMMIT<br/>(un fallo del proveedor sólo se registra)"]
    I --> K["El lugar vuelve al cupo: countCommittedSeats<br/>ya no cuenta la fila. paid_cents y los pagos intactos;<br/>lo pagado ya es saldo a favor del cliente"]
```

El saldo a favor nace **en la misma transacción** que cancela (Fase 2B): la
reserva cancelada y su dinero disponible son un solo hecho. Si el gancho
falla, la cancelación entera se revierte.

Ningún contador cambia en el nodo `K`: el cupo se deriva de las filas (ver
«Qué ocupa lugar y qué no»).

## La bandeja del personal (Tarea 19)

```mermaid
flowchart LR
    A["GET /admin/reservations<br/>(reservation.view)"] --> B["listReservationsForStaff:<br/>filtros tripId, status, cancellationPending"]
    B --> C{"¿cancellation_requested_at no nulo<br/>y status HELD o ACTIVE?"}
    C -- Sí --> D["Pendiente: arriba,<br/>la solicitud más antigua primero"]
    C -- No --> E["Resto: la reserva más reciente primero"]
```

## Rechazar la solicitud: la otra decisión

```mermaid
flowchart TD
    A["El personal pulsa «Rechazar solicitud»<br/>con un motivo"] --> P{"¿Tiene reservation.cancel<br/>y es STAFF?"}
    P -- No --> R0["403 PERMISSION_DENIED"]
    P -- Sí --> B[("BEGIN")]
    B --> D["UPDATE ... SET cancellation_declined_at, _by, _reason<br/>WHERE status IN (HELD, ACTIVE)<br/>AND cancellation_requested_at IS NOT NULL<br/>AND cancellation_declined_at IS NULL"]
    D --> E{"¿Escribió la fila?"}
    E -- No --> F{"Releer"}
    F -- "ya no está viva" --> R1["INVALID_STATUS_TRANSITION"]
    F -- "sin solicitud" --> R2["NO_CANCELLATION_REQUEST"]
    F -- "ya rechazada" --> OK1["Responde la misma decisión<br/>(idempotente)"]
    E -- Sí --> G["recordAudit: reservation.cancellation_declined"]
    G --> H["notifyCustomer: CANCELLATION_DECLINED"]
    H --> I[("COMMIT")]
    I --> J["La reserva no cambia: mismo estado, apartado, lugar y dinero.<br/>Sale de la bandeja; el cliente puede volver a pedirla"]
```

Una solicitud nueva del cliente sobre una rechazada limpia el rechazo y vuelve
a ponerla en la bandeja, con el aviso `CANCELLATION_REQUESTED` al personal.

