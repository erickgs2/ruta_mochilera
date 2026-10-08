# Venta en mostrador

Reglas: `docs/business-rules/customers.md` (clientes e invitación),
`docs/business-rules/reservations.md` / `payments.md` (reserva, cobro y
recibo) e `docs/business-rules/imports.md` (carga desde CSV).

## Encontrar o dar de alta al cliente

```mermaid
flowchart TD
    A["El trabajador busca por nombre,<br/>correo o teléfono"] --> B{"¿Aparece?"}
    B -- Sí --> C["Abre al cliente"]
    B -- No --> D["Alta: nombre, correo,<br/>teléfono, nacimiento"]
    D --> V{"¿Nacimiento real, no futuro<br/>y no anterior a 1900-01-01?"}
    V -- No --> W["422 VALIDATION_FAILED<br/>field: birthDate"]
    V -- Sí --> E{"¿El correo ya existe?"}
    E -- "Sí, de un cliente" --> F["409 CUSTOMER_ALREADY_EXISTS<br/>con su id: el panel lo abre"]
    F --> C
    E -- "Sí, de un trabajador" --> X["409 EMAIL_ALREADY_REGISTERED"]
    E -- No --> G[("BEGIN")]
    G --> H["User CUSTOMER verificado, sin contraseña,<br/>origin BRANCH + AuditLog customer.created"]
    H --> I{"¿Enviar invitación?"}
    I -- Sí --> J["issueInvitationToken:<br/>invalida las anteriores, guarda el hash"]
    I -- No --> K[("COMMIT")]
    J --> K
    K --> L{"¿Había invitación?"}
    L -- Sí --> M["Correo con la liga, después del COMMIT<br/>(un fallo sólo da invitationSent: false)"]
    L -- No --> C
    M --> C
```

La fecha de nacimiento se valida primero, con «hoy» en la zona de la
organización, y es la misma regla del autorregistro y la importación
(`customers.md`, «Fecha de nacimiento»). La comprobación del correo ocurre
antes del `BEGIN`. Si dos altas del mismo
correo llegan a la vez, ambas la pasan y la segunda choca con el índice único
(`users_email_key`): responde también `CUSTOMER_ALREADY_EXISTS`, con el id de
la primera.

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
    R->>DB: "¿publicado, fecha límite vigente, cliente con correo verificado,<br/>sin reserva viva, con cupo?"
    alt "algo falla"
        R-->>API: "TRIP_NOT_PUBLISHED, PAYMENT_DEADLINE_PASSED, EMAIL_NOT_VERIFIED,<br/>DUPLICATE_RESERVATION o TRIP_SOLD_OUT (ROLLBACK, sin pago)"
    else "todo bien"
        R->>DB: "INSERT reserva HELD con apartado, source BRANCH + AuditLog"
        opt "con pago inicial"
            R->>P: "record(tx, { reservationId, amountCents, actorId })"
            P->>DB: "candado de la reserva, ¿monto ≤ saldo?"
            P->>DB: "Payment CASH SUCCEEDED + folio + foto del saldo, paid_cents"
            P->>DB: "si cubre el anticipo: HELD → ACTIVE, sin apartado"
            P->>DB: "encola SEND_RECEIPT"
            P-->>R: "ok, o error (PAYMENT_EXCEEDS_BALANCE: revierte todo)"
        end
        R->>DB: "COMMIT"
        R-->>API: "201 la reserva (ACTIVE o HELD)"
    end

    T->>API: "después: POST /admin/reservations/{id}/payments { amountCents }"
    Note over API: "payment.register"
    API->>DB: "registerCashPayment: BEGIN + candado del viaje y de la reserva"
    alt "reserva CANCELLED"
        API-->>T: "409 INVALID_STATUS_TRANSITION"
    else "HELD con el apartado vencido, o EXPIRED, sin lugar"
        API-->>T: "409 TRIP_SOLD_OUT (no se escribe nada)"
    else "monto mayor al saldo, o saldo ya gastado"
        API-->>T: "422 PAYMENT_EXCEEDS_BALANCE o 409 CREDIT_INSUFFICIENT (ROLLBACK, también de la revivida)"
    else "reserva viva, o revivida porque queda lugar, y el monto cabe"
        API->>DB: "misma escritura: CASH + folio + SEND_RECEIPT, COMMIT"
        API-->>T: "201 el pago"
    end
```

Sin `initialPaymentCents` la reserva queda `HELD` con el apartado normal del
viaje y se cobra después.

## Del cobro al recibo

El job `SEND_RECEIPT` se encola en la misma transacción que deja el pago en
`SUCCEEDED`: si el pago se revierte, el job no existe. Lo corre `apps/worker`.

```mermaid
sequenceDiagram
    autonumber
    participant Q as "pg-boss (SEND_RECEIPT)"
    participant W as "worker: sendReceipt"
    participant DB as PostgreSQL
    participant S as "Almacenamiento"
    participant E as "Correo"

    Q->>W: "{ paymentId, resend? }"
    W->>DB: "lee el pago"
    alt "no existe"
        W-->>Q: "NO_RECEIPT (no se reintenta)"
    else "receipt_sent_at ya tiene fecha y no es resend"
        W-->>Q: "ALREADY_SENT"
    else "hay que enviarlo"
        W->>DB: "loadReceipt: ¿SUCCEEDED y con folio?"
        alt "no"
            W-->>Q: "NO_RECEIPT"
        else "sí"
            alt "receipt_key existe en el almacenamiento"
                W->>S: "lee el PDF guardado"
            else "primera vez"
                W->>W: "renderiza con la foto del saldo de ese momento"
                W->>S: "guarda receipts/año/folio-aleatorio.pdf"
                W->>DB: "UPDATE receipt_key (condicional: gana uno solo)"
            end
            W->>E: "send(al correo actual del cliente, PDF adjunto)"
            alt "el proveedor falla"
                W-->>Q: "error: pg-boss reintenta, el PDF ya está guardado"
            else "aceptado"
                W->>DB: "receipt_sent_at = ahora"
                W-->>Q: "SENT"
            end
        end
    end
```

El PDF se genera una vez y nunca se regenera: lo que dice el recibo no cambia
aunque la reserva cambie después. Es privado: la ruta pública de archivos
rechaza `receipts/` y sólo se sirve por rutas que verifican quién pregunta
(`/payments/{id}/receipt` del dueño, `/admin/payments/{id}/receipt` con
`payment.view`).

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
    alt "no (desconocido, usado, vencido o de restablecimiento)"
        API-->>App: "401 TOKEN_INVALID"
    else "sí"
        API->>DB: "BEGIN: bloquea la fila del usuario (FOR UPDATE)"
        API->>DB: "consume el token (condicional)"
        alt "otro envío lo consumió antes"
            API-->>App: "401 TOKEN_INVALID (COMMIT: no escribió nada)"
        else "conflicto de escritura (P2034)"
            API-->>App: "401 TOKEN_INVALID (ROLLBACK)"
        else "lo consumió éste, pero la cuenta ya tiene contraseña"
            API-->>App: "401 TOKEN_INVALID (COMMIT: el token queda consumido, la contraseña no cambia)"
        else "lo consumió éste y la cuenta no tiene contraseña"
            API->>DB: "password_hash, activated_at, accepted_terms_at"
            API->>DB: "COMMIT"
            API-->>App: "200 { email }: la app abre el inicio de sesión"
        end
    end
```

El restablecimiento de contraseña bloquea la misma fila de usuario **antes**
de tocar los tokens, igual que la aceptación: un solo orden de bloqueos, así
que ambas operaciones a la vez no se interbloquean. Si el cliente de mostrador
fija su contraseña con «olvidé mi contraseña», queda activado (`activated_at`),
sin sellar `accepted_terms_at`. Una invitación todavía vigente tampoco pisa
esa contraseña: si la cuenta ya tiene una, aceptarla es `TOKEN_INVALID` y la
contraseña queda intacta (regla en `customers.md`, cubierta por prueba).

## Importar clientes y pagos desde CSV

```mermaid
sequenceDiagram
    autonumber
    actor T as "Personal (import.manage)"
    participant API as "API"
    participant Q as "pg-boss (APPLY_IMPORT)"
    participant W as "worker: applyImport"
    participant DB as PostgreSQL

    T->>API: "POST /admin/imports { type, fileName, content, sendEmails }"
    alt "más de 5,000 filas o 5 MB"
        API-->>T: "413 IMPORT_TOO_LARGE"
    else "cabe"
        API->>DB: "valida fila por fila sin escribir nada, salvo el lote"
        API->>DB: "ImportBatch VALIDATED, o FAILED si el archivo no sirve"
        API-->>T: "vista previa: VALID, INVALID o EXISTS por fila"
    end

    T->>API: "POST /admin/imports/{id}/apply"
    API->>DB: "BEGIN: VALIDATED → APPLYING (condicional)"
    alt "ya no está VALIDATED"
        API-->>T: "409 IMPORT_ALREADY_APPLIED (o INVALID_STATUS_TRANSITION si FAILED)"
    else "lo tomó esta petición"
        API->>Q: "send APPLY_IMPORT (sin reintentos, 1 hora) en la misma transacción"
        API->>DB: "COMMIT"
        API-->>T: "200 lote APPLYING"
    end

    Q->>W: "{ batchId, actorId }"
    loop "cada fila sin resultado"
        W->>DB: "vuelve a validar con datos frescos"
        alt "inválida"
            W->>W: "FAILED, VALIDATION_FAILED"
        else "ya existe"
            W->>W: "EXISTS"
        else "válida"
            W->>DB: "cliente, o pago (reserva viva o reserva histórica) en su propia transacción"
            W->>W: "CREATED, EXISTS o FAILED con el código del dominio"
        end
        opt "cada 100 filas"
            W->>DB: "guarda el reporte parcial (sigue APPLYING)"
        end
    end
    W->>DB: "lote APPLIED + AuditLog import.applied"
    T->>API: "el panel consulta GET /admin/imports/{id} hasta que deja de ser APPLYING"
```

Si el worker se cae a medias, el lote se queda `APPLYING` con su reporte
parcial: **no se reintenta solo**, porque una fila de pago sin `external_ref` no
se distingue de una segunda copia de sí misma.
