# Venta en mostrador

Reglas: `docs/business-rules/customers.md` (clientes e invitación) y
`docs/business-rules/reservations.md` / `payments.md` (reserva y cobro).

## Encontrar o dar de alta al cliente

```mermaid
flowchart TD
    A["El trabajador busca por nombre,<br/>correo o teléfono"] --> B{"¿Aparece?"}
    B -- Sí --> C["Abre al cliente"]
    B -- No --> D["Alta: nombre, correo,<br/>teléfono, nacimiento"]
    D --> E{"¿El correo ya existe?"}
    E -- "Sí, de un cliente" --> F["409 CUSTOMER_ALREADY_EXISTS<br/>con su id: el panel lo abre"]
    F --> C
    E -- No --> G[("BEGIN")]
    G --> H["User CUSTOMER verificado, sin contraseña,<br/>origin BRANCH + AuditLog"]
    H --> I{"¿Enviar invitación?"}
    I -- Sí --> J["issueInvitationToken:<br/>invalida las anteriores, guarda el hash"]
    I -- No --> K[("COMMIT")]
    J --> K
    K --> L{"¿Había invitación?"}
    L -- Sí --> M["Correo con la liga, después del COMMIT<br/>(un fallo sólo da invitationSent: false)"]
    L -- No --> C
    M --> C
```

## Reservar y cobrar en el mostrador

```mermaid
sequenceDiagram
    autonumber
    actor T as "Trabajador"
    participant API as "API"
    participant R as "reservations"
    participant P as "payments (gancho)"
    participant DB as PostgreSQL

    T->>API: "POST /admin/reservations { tripId, customerId, initialPaymentCents? }"
    Note over API: "reservation.create, y payment.register si trae pago"
    API->>R: "createBranchReservation(..., record = createInitialCashPayment(queue))"
    R->>DB: "BEGIN + candado del viaje"
    R->>DB: "¿publicado, en fecha, sin duplicado, con cupo?"
    alt "algo falla"
        R-->>API: "TRIP_SOLD_OUT, ... (ROLLBACK, sin pago)"
    else "todo bien"
        R->>DB: "INSERT reserva HELD, source BRANCH"
        opt "con pago inicial"
            R->>P: "record(tx, { reservationId, amountCents, actorId })"
            P->>DB: "Payment CASH + folio, paid_cents, ¿ACTIVE?"
            P->>DB: "encola SEND_RECEIPT"
            P-->>R: "ok o error (un error revierte todo)"
        end
        R->>DB: "COMMIT"
        R-->>API: "201 la reserva (ACTIVE o HELD)"
    end

    T->>API: "después: POST /admin/reservations/{id}/payments { amountCents }"
    Note over API: "payment.register, sólo reservas vivas"
    API->>DB: "misma escritura: CASH + folio + recibo"
```

## Activar la cuenta desde la invitación

```mermaid
sequenceDiagram
    autonumber
    actor Cl as Cliente
    participant App as "App (/invitation)"
    participant API as "API"
    participant DB as PostgreSQL

    Cl->>App: "abre la liga del correo"
    Cl->>App: "contraseña + acepto los términos"
    App->>API: "POST /auth/invitation/accept { token, password, acceptTerms }"
    API->>DB: "busca el hash: ¿INVITATION, sin usar, vigente?"
    alt "no"
        API-->>App: "401 TOKEN_INVALID"
    else "sí"
        API->>DB: "BEGIN: consume el token (condicional)"
        API->>DB: "password_hash, activated_at, accepted_terms_at"
        API->>DB: "COMMIT"
        API-->>App: "200 { email }: la app abre el inicio de sesión"
    end
```
