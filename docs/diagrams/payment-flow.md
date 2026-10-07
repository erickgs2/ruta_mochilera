# Flujo de pago asíncrono

Diagramas de `libs/domain/payments` y del webhook
`apps/api/src/app/api/v1/webhooks/stripe`. Las reglas en prosa están en
`docs/business-rules/payments.md`; la spec correspondiente es §5.3, §5.5 y §7
de `docs/superpowers/specs/2026-10-03-fase-2a-reservas-y-pagos-diseno.md`.

Todo el dinero de este flujo es `Int` en centavos MXN.

## El recorrido completo: intento, ficha y confirmación por webhook

Nada de esto es síncrono. El backend crea el Payment Intent y escribe una fila
`Payment` en `PENDING`; **esa fila no mueve el saldo**. El dinero sólo existe
cuando Stripe lo confirma, y Stripe lo confirma por un canal distinto —el
webhook— que puede llegar segundos después (tarjeta) o días después (ficha de
OXXO).

```mermaid
sequenceDiagram
    autonumber
    actor C as Cliente
    participant App as App Angular
    participant API as "API (Next.js)"
    participant S as Stripe
    participant DB as PostgreSQL
    participant W as Webhook

    C->>App: "Pagar 1,500.00"
    App->>API: "POST /reservations/{id}/payment-intents"
    Note over API: "El monto lo decide el backend<br/>desde el saldo real de la reserva"
    API->>S: "createIntent (monto, método, metadata.reservationId)"
    S-->>API: "providerIntentId, clientSecret, ficha si es OXXO"
    API->>DB: "INSERT Payment en PENDING"
    Note over DB: "paid_cents NO se mueve:<br/>una ficha pendiente no reserva nada"
    API-->>App: "ficha descargable y su fecha límite"
    App-->>C: "Te acreditamos al pagar"

    C->>S: "paga (tarjeta, OXXO o SPEI)"
    S-)W: "POST /api/v1/webhooks/stripe (cuerpo crudo + firma)"
    W->>W: "verifyWebhook sobre los bytes exactos"
    W->>DB: "BEGIN"
    W->>DB: "INSERT stripe_events (PRIMERO: es el candado)"
    W->>DB: "Payment PENDING → SUCCEEDED, paid_cents += monto"
    W->>DB: "folio: receipt_counters del año FOR UPDATE, last_number + 1"
    W->>DB: "HELD → ACTIVE si se alcanzó el anticipo"
    W->>DB: "aviso PAYMENT_CONFIRMED (misma transacción)"
    W->>DB: "COMMIT"
    W-->>S: "200"
```

## El folio del recibo (Fase 2B)

Todo pago que queda en `SUCCEEDED` recibe su folio **en la misma transacción**
que lo confirma, sin importar el método (efectivo, tarjeta, OXXO, saldo a
favor o histórico). El contador es una fila por año que se bloquea hasta el
`COMMIT`: si la transacción se revierte, el número vuelve con ella.

```mermaid
sequenceDiagram
    participant T1 as "Transacción A"
    participant T2 as "Transacción B"
    participant RC as "receipt_counters (2027)"

    T1->>RC: "INSERT ... ON CONFLICT DO NOTHING"
    T1->>RC: "UPDATE last_number + 1 RETURNING → 41"
    T2->>RC: "UPDATE last_number + 1 (espera el candado)"
    alt "A hace COMMIT"
        T1-->>RC: "COMMIT: RM-2027-000041 existe"
        RC-->>T2: "→ 42"
    else "A se revierte"
        T1-->>RC: "ROLLBACK: el 41 nunca existió"
        RC-->>T2: "→ 41, sin hueco"
    end
```

## Tres métodos, tres tiempos (Tarea 20)

Los tres métodos terminan igual —la verdad del pago llega **sólo** por el
webhook, nunca por lo que diga la app— pero tardan distinto y fallan distinto.

```mermaid
flowchart TD
    A["POST /reservations/{id}/payment-intents<br/>intent FULL o DEPOSIT, método"] --> M{"Método"}

    M -- "CARD" --> C1["Stripe Elements confirma en la app"]
    C1 --> C2["La app muestra «procesando»:<br/>no cambia nada por su cuenta"]
    C2 --> W

    M -- "OXXO" --> O1["Ficha con vencimiento<br/>= hold_expires_at, nunca después"]
    O1 --> O2["Payment PENDING: no reduce el saldo<br/>ni detiene el apartado"]
    O2 --> O3{"¿Se pagó en tienda<br/>antes de vencer?"}
    O3 -- Sí --> W
    O3 -- No --> O4["payment_failed con<br/>payment_intent_payment_attempt_expired"]
    O4 --> O5["Payment EXPIRED, aviso VOUCHER_EXPIRED"]

    M -- "SPEI" --> S1["customer_balance con mx_bank_transfer:<br/>referencia para transferir"]
    S1 --> S2["Payment PENDING hasta que el banco liquide"]
    S2 --> W

    W["Webhook payment_intent.succeeded"] --> V["Payment SUCCEEDED, paid_cents += monto,<br/>HELD → ACTIVE si cubre el anticipo"]
    V --> N["Aviso PAYMENT_CONFIRMED,<br/>o el caso límite de §5.3 (abajo)"]
```

**SPEI está en la API y en el adaptador, pero no en la app.** `payment-intents`
acepta `SPEI` y `StripePaymentProvider` lo traduce a `customer_balance` con
`mx_bank_transfer`, sin verificar todavía contra una cuenta real de Stripe
(ver `libs/payments-stripe/README.md`). La pantalla de pago del cliente sólo
ofrece tarjeta y OXXO; añadir SPEI ahí es trabajo pendiente, no una omisión
de este diagrama.

## El candado: por qué la fila de `stripe_events` va primero

Stripe reenvía, duplica y reordena entregas. La inserción de `stripe_events`
—cuya clave primaria es el id del evento de Stripe— es lo que hace que una
entrega repetida no tenga efecto, y **va antes que cualquier efecto**.

```mermaid
flowchart TD
    A["Evento ya verificado"] --> B[("BEGIN")]
    B --> C["INSERT stripe_events (stripe_event_id = evt_...)"]
    C -- "viola stripe_events_pkey" --> D["Ya procesado: salir sin efecto"]
    D --> E[("ROLLBACK")]
    E --> F["200 a Stripe (un reenvío no es un error)"]
    C -- "insertada" --> G{"¿Tipo de evento que atendemos?"}
    G -- No --> H["No hacer nada"]
    H --> I[("COMMIT: queda la constancia del evento")]
    I --> F
    G -- "Sí" --> J["Aplicar el efecto y escribir los avisos"]
    J --> K{"¿El efecto salió bien?"}
    K -- "Sí" --> I
    K -- "No" --> L[("ROLLBACK: también se va la fila de stripe_events")]
    L --> M["Respuesta de error: el reintento de Stripe arranca limpio"]
```

Dos entregas simultáneas del mismo evento, que es lo que esta forma existe
para resolver:

```mermaid
sequenceDiagram
    autonumber
    participant E1 as "Entrega 1"
    participant PG as PostgreSQL
    participant E2 as "Entrega 2 (simultánea)"

    E1->>PG: "BEGIN"
    E2->>PG: "BEGIN"
    E1->>PG: "INSERT stripe_events (evt_X)"
    E2->>PG: "INSERT stripe_events (evt_X)"
    Note over E2,PG: "Se bloquea en el índice de la clave primaria.<br/>Nunca llega al efecto."
    E1->>PG: "aplica el pago y escribe el aviso"
    E1->>PG: "COMMIT"
    PG--)E2: "violación de stripe_events_pkey"
    E2->>PG: "ROLLBACK"
    Note over E2: "ok(null) → 200.<br/>Un pago, un aviso, un cobro."
```

## Las ramas de fallo y de expiración

Las tres salidas que no son "el dinero llegó". Ninguna toca el saldo: un pago
`PENDING` nunca contó, así que no hay nada que restar.

```mermaid
flowchart TD
    A["payment_intent.payment_failed"] --> B{"last_payment_error.code"}
    B -- "payment_intent_payment_attempt_expired" --> C["Payment → EXPIRED"]
    C --> D["Aviso VOUCHER_EXPIRED: «tu ficha venció»"]
    B -- "cualquier otro (card_declined, …)" --> E["Payment → FAILED"]
    E --> F["Aviso PAYMENT_FAILED con el código del proveedor"]

    G["payment_intent.canceled"] --> H["Payment → EXPIRED"]
    H --> I["Sin aviso: lo provocó expireHolds,<br/>que ya mandó HOLD_EXPIRED"]

    J["Cualquier otro tipo de evento"] --> K["Nada, y 200"]

    C --> L["paid_cents intacto"]
    E --> L
    H --> L
```

## El caso límite de §5.3: el dinero llegó tarde

Una ficha de OXXO pagada después de que el apartado venciera. El job cancela
el voucher, pero la carrera existe. Las tres consecuencias son independientes
y se prueban por separado.

```mermaid
flowchart TD
    A["payment_intent.succeeded"] --> B["Payment → SUCCEEDED, paid_cents += monto"]
    B --> C{"Estado de la reserva"}
    C -- "HELD o ACTIVE" --> D["HELD → ACTIVE si cubre el anticipo"]
    D --> E["Aviso PAYMENT_CONFIRMED al cliente"]
    C -- "EXPIRED" --> F["La reserva NO se reactiva: sigue EXPIRED"]
    F --> G["Aviso PAYMENT_AFTER_EXPIRY al cliente"]
    F --> H["Aviso ORPHAN_PAYMENT al personal"]
    C -- "CANCELLED (Tarea 19)" --> F2["La reserva NO se reactiva: sigue CANCELLED"]
    F2 --> CR["Fase 2B: el monto se vuelve saldo a favor<br/>(CANCELLATION con payment_id, una vez por pago)"]
    CR --> G2["Aviso PAYMENT_AFTER_CANCELLATION al cliente<br/>(«quedó como saldo a favor»)"]
    F2 --> H
    G --> I["«El dinero existe y debe verse;<br/>devolverlo o moverlo es decisión humana»"]
    G2 --> I
    H --> I
```

Una reserva `CANCELLED` sigue el mismo camino desde la Tarea 19: el panel
cancela en el proveedor las fichas pendientes al cancelar, pero una pagada en
ese mismo minuto puede llegar igual. Desde la Fase 2B ese dinero no queda en
el limbo: se acredita como saldo a favor del cliente en la misma transacción
del webhook (ver `customer-credit.md`). El de una reserva `EXPIRED` sigue
siendo decisión humana.

Y el caso en que no hay siquiera reserva a la que atar el dinero —un intento
creado fuera de la app, sin `metadata.reservationId` o con uno que ni siquiera
es un UUID—: no se puede escribir un `Payment` sin reserva, así que se avisa a
una persona y se responde 200, porque un error sólo haría que Stripe
reenviara para siempre algo que nadie puede aplicar automáticamente.

```mermaid
flowchart LR
    A["El pago no se puede aplicar solo"] --> B{"¿A qué reserva pertenece?"}
    B -- "su fila Payment la nombra" --> L["ORPHAN_PAYMENT enlazado a esa reserva"]
    B -- "el intento nombra una reserva que existe" --> L
    B -- "ninguna, o un id que no es UUID" --> U["ORPHAN_PAYMENT sin reserva"]
    L --> R["200 a Stripe"]
    U --> R
```

El aviso al personal va **enlazado a la reserva** siempre que se sabe cuál es
(un segundo pago que excede el saldo, un pago que llegó sobre uno ya dado por
perdido): es justo cuando alguien tiene que actuar a mano. Antes el aviso
salía sin enlace aunque el intento la nombrara.
