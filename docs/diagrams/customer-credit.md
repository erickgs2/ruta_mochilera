# Saldo a favor

Reglas: `docs/business-rules/payments.md`, «Saldo a favor». El saldo de un
cliente es la suma de sus movimientos en `customer_credit_entries`; nunca es
una columna editable y nunca es negativo.

## De dónde sale y a dónde va

```mermaid
flowchart LR
    subgraph Entradas["Suman (+)"]
        C["CANCELLATION<br/>reserva cancelada con paid_cents > 0,<br/>o pago que llega tras cancelar"]
        P["PRICE_DECREASE<br/>bajada de precio bajo lo pagado"]
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
    Note over API: "¿del cliente? ¿viva? ¿apartado vigente?"
    API->>DB: "SELECT customer_profiles ... FOR UPDATE"
    API->>DB: "SUM(amount_cents) del cliente"
    alt "monto > saldo"
        API-->>P: "409 CREDIT_INSUFFICIENT"
    else "monto > saldo pendiente de la reserva"
        API-->>P: "422 PAYMENT_EXCEEDS_BALANCE"
    else "cabe"
        API->>DB: "INSERT Payment CREDIT SUCCEEDED + folio"
        API->>DB: "paid_cents += monto, HELD → ACTIVE si cubre el anticipo"
        API->>DB: "INSERT APPLIED (−monto, payment_id)"
        API->>DB: "AuditLog"
        API->>DB: "COMMIT"
        API-->>P: "201 el pago CREDIT"
    end
```

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
