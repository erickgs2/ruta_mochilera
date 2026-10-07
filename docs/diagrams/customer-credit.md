# Saldo a favor

Reglas: `docs/business-rules/payments.md`, «Saldo a favor». El saldo de un
cliente es la suma de sus movimientos en `customer_credit_entries`; nunca es
una columna editable y nunca es negativo.

## De dónde sale y a dónde va

```mermaid
flowchart LR
    subgraph Entradas["Suman (+)"]
        C["CANCELLATION<br/>reserva cancelada con paid_cents > 0,<br/>o pago que llega tras cancelar"]
        P["PRICE_DECREASE<br/>bajada de precio bajo lo pagado:<br/>la diferencia sale de paid_cents"]
        AP["ADJUSTMENT +<br/>corrección o cortesía, con motivo"]
    end
    subgraph Saldo["Saldo del cliente"]
        S[("Σ customer_credit_entries")]
    end
    subgraph Salidas["Restan (−)"]
        A["APPLIED<br/>pago CREDIT a una reserva viva"]
        R["REFUND<br/>devuelto fuera del sistema, con motivo"]
        AN["ADJUSTMENT −<br/>corrección, con motivo"]
    end
    C --> S
    P --> S
    AP --> S
    S --> A
    S --> R
    S --> AN
```

Las dos entradas automáticas (`CANCELLATION` y `PRICE_DECREASE`) las escriben
funciones de `@rm/domain-payments` que las operaciones de reservas reciben
**inyectadas**, dentro de su propia transacción: los dos dominios no se
importan entre sí. `REFUND`, `ADJUSTMENT` y `APPLIED` los dispara siempre una
persona con `payment.credit.apply`.

## Cómo nace el saldo

```mermaid
sequenceDiagram
    autonumber
    participant Op as "Cancelar / webhook / cambio de precio"
    participant DB as PostgreSQL

    Note over Op,DB: "Orden de bloqueo en toda operación: reserva primero, cliente después"

    rect rgb(240, 240, 240)
        Note over Op,DB: "Cancelar una reserva"
        Op->>DB: "UPDATE condicional a CANCELLED (sólo una llamada gana)"
        Op->>DB: "paid_cents > 0 ? CANCELLATION (+paid_cents)"
        Note over DB: "la reserva conserva paid_cents y sus pagos"
    end

    rect rgb(240, 240, 240)
        Note over Op,DB: "Llega dinero para una reserva ya cancelada (webhook)"
        Op->>DB: "¿ya hay CANCELLATION de ese payment_id? Si sí, no hace nada"
        Op->>DB: "CANCELLATION (+monto, payment_id)"
    end

    rect rgb(240, 240, 240)
        Note over Op,DB: "Bajar el precio de una reserva pagada de más"
        Op->>DB: "paid_cents -= diferencia, total = precio vigente"
        Op->>DB: "PRICE_DECREASE (+diferencia)"
        Note over DB: "la conciliación nocturna resta estos PRICE_DECREASE de los pagos"
    end
```

## Aplicar saldo a una reserva

```mermaid
sequenceDiagram
    autonumber
    actor P as Personal (payment.credit.apply)
    participant API as "API"
    participant DB as PostgreSQL

    P->>API: "POST /admin/reservations/{id}/apply-credit { amountCents }"
    API->>DB: "BEGIN"
    API->>DB: "SELECT reservations ... FOR UPDATE"
    alt "reserva CANCELLED o EXPIRED"
        API-->>P: "409 INVALID_STATUS_TRANSITION"
    else "HELD con el apartado vencido"
        API-->>P: "409 HOLD_EXPIRED"
    else "reserva viva"
        API->>DB: "SELECT customer_profiles (el dueño de la reserva) ... FOR UPDATE"
        API->>DB: "SUM(amount_cents) del cliente"
        alt "monto > saldo"
            API-->>P: "409 CREDIT_INSUFFICIENT"
        else "monto > saldo pendiente de la reserva"
            API-->>P: "422 PAYMENT_EXCEEDS_BALANCE"
        else "cabe"
            API->>DB: "INSERT Payment CREDIT SUCCEEDED + folio + foto del saldo"
            API->>DB: "paid_cents += monto, HELD → ACTIVE si cubre el anticipo"
            API->>DB: "INSERT APPLIED (−monto, payment_id) + AuditLog"
            API->>DB: "encola SEND_RECEIPT"
            API->>DB: "COMMIT"
            API-->>P: "201 el pago CREDIT"
        end
    end
```

El saldo que se gasta es siempre el del dueño de la reserva: la ruta del
panel no recibe un cliente aparte. Un rechazo de `recordPayment` ocurre antes
de que escriba nada, así que no queda nada que revertir.

## Devolver o ajustar

```mermaid
sequenceDiagram
    autonumber
    actor P as Personal (payment.credit.apply)
    participant API as "API"
    participant DB as PostgreSQL

    P->>API: "POST /admin/customers/{id}/credit/refund | adjust { amountCents, reason }"
    alt "sin motivo"
        API-->>P: "422 VALIDATION_FAILED (reason)"
    else "refund con monto ≤ 0"
        API-->>P: "422 VALIDATION_FAILED (amountCents)"
    else "con motivo"
        API->>DB: "BEGIN + customer_profiles ... FOR UPDATE + SUM"
        alt "el movimiento dejaría el saldo bajo cero"
            API-->>P: "409 CREDIT_INSUFFICIENT"
        else "cabe"
            API->>DB: "INSERT REFUND (−monto) o ADJUSTMENT (±monto) + AuditLog"
            API->>DB: "COMMIT"
            API-->>P: "201 el movimiento"
        end
    end
```

`REFUND` no mueve dinero: sólo registra que la agencia ya devolvió el dinero
**fuera del sistema** (efectivo, transferencia). El motivo es lo único que
dice a dónde fue.

## Dos aplicaciones a la vez

El bloqueo de la fila del cliente ordena a los dos escritores: el segundo
lee el saldo que dejó el primero.

```mermaid
sequenceDiagram
    participant A as "Aplicar $1,000 (reserva 1)"
    participant B as "Aplicar $1,000 (reserva 2)"
    participant C as "customer_profiles (saldo $1,500)"

    A->>C: "FOR UPDATE ✓"
    B->>C: "FOR UPDATE (espera)"
    A->>A: "saldo 1,500 ≥ 1,000: pago + APPLIED"
    A-->>C: "COMMIT (saldo 500)"
    C-->>B: "candado concedido"
    B->>B: "saldo 500 < 1,000"
    B-->>B: "CREDIT_INSUFFICIENT, ROLLBACK"
```
