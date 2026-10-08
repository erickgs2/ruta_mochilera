# Flujo de pago asíncrono

Diagramas de `libs/domain/payments` y del webhook
`apps/api/src/app/api/v1/webhooks/stripe`. Las reglas en prosa están en
`docs/business-rules/payments.md`. Las specs correspondientes son §5.3, §5.5 y
§7 de `docs/superpowers/specs/2026-10-03-fase-2a-reservas-y-pagos-diseno.md`
(Fase 2A) y §4.2 y §5.3 a §5.7 de
`docs/superpowers/specs/2026-10-07-fase-2b-mostrador-diseno.md` (Fase 2B:
efectivo, recibos, saldo a favor y captura histórica).

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
    W->>DB: "viaje FOR KEY SHARE, luego reserva FOR UPDATE (orden de bloqueo)"
    W->>DB: "Payment PENDING → SUCCEEDED (condicional)"
    W->>DB: "paid_cents += lo que cabe en el saldo; HELD → ACTIVE si se alcanzó el anticipo"
    W->>DB: "excedente, si lo hay → OVERPAYMENT (candado del cliente)"
    W->>DB: "folio AL FINAL: receipt_counters del año, last_number + 1"
    W->>DB: "encola SEND_RECEIPT (misma transacción)"
    W->>DB: "aviso PAYMENT_CONFIRMED o PAYMENT_EXCESS_CREDITED (misma transacción)"
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

## El envío del recibo (Fase 2B)

```mermaid
sequenceDiagram
    autonumber
    participant Q as "pg-boss (SEND_RECEIPT)"
    participant Wk as "apps/worker: sendReceipt"
    participant DB as PostgreSQL
    participant St as Almacenamiento
    participant E as "Correo (Resend)"

    Q->>Wk: "{ paymentId, resend? }"
    Wk->>DB: "¿receipt_sent_at? (y no es reenvío)"
    alt "ya enviado"
        Wk-->>Q: "ALREADY_SENT, nada más"
    else "por enviar"
        Wk->>DB: "¿receipt_key?"
        alt "sin PDF"
            Wk->>Wk: "dibuja el PDF con la foto del saldo"
            Wk->>St: "put receipts/{año}/{folio}-{aleatorio}.pdf"
            Wk->>DB: "receipt_key (escritura condicional)"
        else "con PDF"
            Wk->>St: "get (nunca se regenera)"
        end
        Wk->>E: "correo actual del cliente + PDF adjunto"
        alt "el proveedor falla"
            Wk-->>Q: "error: pg-boss reintenta, el PDF ya quedó guardado"
        else "aceptado"
            Wk->>DB: "receipt_sent_at = now()"
        end
    end
```

## Pagos históricos (Fase 2B)

```mermaid
flowchart LR
    A["Captura histórica<br/>(data.backfill)<br/>fechas YYYY-MM-DD"] --> A2["El dominio fecha cada una (resolveBackfillMoments):<br/>mediodía en la zona de la organización,<br/>sin pasar de ahora; futura = VALIDATION_FAILED"]
    A2 --> B["Ordena los pagos<br/>por paid_at"]
    B --> C["recordPayment por cada uno:<br/>LEGACY o CASH (CARD, OXXO o SPEI sólo desde la importación CSV,<br/>provider MANUAL), SUCCEEDED, is_backfilled,<br/>folio del año de paid_at"]
    C --> D{"¿sendReceipts?"}
    D -- No --> E["Sin correo: el PDF se genera<br/>al descargarlo o reenviarlo"]
    D -- Sí --> F["encola SEND_RECEIPT<br/>(misma transacción)"]
```

La importación CSV de pagos (`imports.md`) entra por este mismo camino, con
`external_ref` único para no importar dos veces el mismo pago.

Los pagos de una misma captura entran **todos o ninguno** (una sola
transacción), y sobre una reserva ya existente sólo si está viva: sobre una
`CANCELLED` o `EXPIRED` es `INVALID_STATUS_TRANSITION`. Un `paid_at` en el
futuro es `VALIDATION_FAILED`.

**El folio sigue el año de `paid_at`, no el orden de captura.** Un pago de
2025 capturado hoy toma el siguiente número del contador de 2025, que ya estaba
cerrado: queda fuera del orden de fechas de ese año. Ver
`docs/decisiones-fase-2b.md`, «por confirmar».

## Efectivo en el mostrador y saldo a favor (Fase 2B)

Son los dos caminos de pago que **no pasan por Stripe**: no hay intento, ni
ficha, ni webhook. Los confirma la propia acción del personal, que escribe el
pago ya en `SUCCEEDED` dentro de su transacción (la regla «la verdad del pago
llega por webhook» es de los pagos en línea). Los dos recorren el mismo
`recordPayment` que usa el webhook: mismo candado de la reserva, misma
validación del saldo, mismo folio, misma activación.

```mermaid
flowchart TD
    A["Efectivo: POST /admin/reservations/{id}/payments<br/>(payment.register)"] --> L
    A2["Saldo: POST /admin/reservations/{id}/apply-credit<br/>(payment.credit.apply)"] --> L
    L[("BEGIN + viaje y reserva FOR UPDATE")] --> S{"¿HELD o ACTIVE?"}
    S -- No --> E1["INVALID_STATUS_TRANSITION"]
    S -- Sí --> H{"¿HELD con el apartado vencido o EXPIRED?"}
    H -- Sí --> E2["Se revive si queda lugar (decisión 13),<br/>si no TRIP_SOLD_OUT"]
    E2 --> K
    H -- No --> K{"¿Es saldo a favor?"}
    K -- Sí --> K2["Candado del cliente + SUM del saldo:<br/>monto > saldo → CREDIT_INSUFFICIENT"]
    K -- No --> B
    K2 --> B{"¿monto ≤ saldo pendiente<br/>de la reserva?"}
    B -- No --> E3["PAYMENT_EXCEEDS_BALANCE"]
    B -- Sí --> P["recordPayment: Payment SUCCEEDED, provider MANUAL,<br/>método CASH o CREDIT, recorded_by, paid_at = ahora,<br/>folio + foto del saldo, paid_cents += monto"]
    P --> A3{"¿HELD y paid_cents ≥ anticipo?"}
    A3 -- Sí --> A4["HELD → ACTIVE, sin apartado<br/>(el mismo updateMany condicionado del webhook)"]
    A3 -- No --> Q
    A4 --> Q
    Q["Saldo: además el movimiento APPLIED (−monto)"] --> R["encola SEND_RECEIPT"]
    R --> C[("COMMIT")]
    E1 --> X[("ROLLBACK, nada escrito")]
    E2 --> X
    E3 --> X
```

Un pago `CREDIT` es un **traslado**, no dinero nuevo: el dinero ya entró cuando
se pagó la reserva que se canceló. Los reportes de ingresos de la Fase 3 deben
excluirlo para no contarlo dos veces. Ver `customer-credit.md`.

## La conciliación nocturna y el cambio de precio (Fase 2B)

`paid_cents` es desnormalizado a propósito; `reconcilePaidCents` lo compara
con la verdad. Desde la 2B esa verdad descuenta lo que una bajada de precio
sacó de la reserva para volverlo saldo a favor, y desde la decisión D7 también
lo que un pago confirmado trajo por encima del saldo (`OVERPAYMENT`), que nunca
llegó a `paid_cents`.

```mermaid
flowchart LR
    A["paid_cents de la reserva"] --> D{"¿Es igual a<br/>pagos SUCCEEDED − PRICE_DECREASE − OVERPAYMENT<br/>de esa reserva?"}
    B["Σ pagos SUCCEEDED<br/>(efectivo, tarjeta, OXXO, SPEI,<br/>saldo, históricos)"] --> D
    C["Σ movimientos PRICE_DECREASE y OVERPAYMENT<br/>de esa reserva"] --> D
    D -- Sí --> OK["Sin desviación"]
    D -- No --> M["Aviso PAID_CENTS_MISMATCH<br/>al personal (no se corrige solo)"]
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
    H --> I["Sin aviso: lo provocó expireHolds,<br/>que ya mandó HOLD_EXPIRED o HOLD_EXPIRED_CREDIT"]

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
    A["payment_intent.succeeded"] --> B["Payment → SUCCEEDED,<br/>paid_cents += lo que cabe (nunca pasa del total);<br/>el excedente → OVERPAYMENT"]
    B --> S{"¿Esta entrega lo liquidó?<br/>(settledNow)"}
    S -- "No: otro evento del mismo intento" --> Z["Nada: ni recibo ni avisos"]
    S -- Sí --> C{"Estado de la reserva"}
    C -- "HELD o ACTIVE" --> D["HELD → ACTIVE si cubre el anticipo"]
    D --> E["Aviso PAYMENT_CONFIRMED al cliente,<br/>o PAYMENT_EXCESS_CREDITED si hubo excedente"]
    C -- "EXPIRED" --> F["La reserva NO se reactiva: sigue EXPIRED"]
    F --> Q{"¿Cupo algo del pago?"}
    Q -- Sí --> G["Aviso PAYMENT_AFTER_EXPIRY al cliente<br/>(nombra lo acreditado, si lo hay)"]
    Q -- Sí --> H["Aviso ORPHAN_PAYMENT al personal"]
    Q -- "No: todo es saldo a favor" --> G3["Aviso PAYMENT_EXCESS_CREDITED al cliente;<br/>nada al personal"]
    C -- "CANCELLED (Tarea 19)" --> F2["La reserva NO se reactiva: sigue CANCELLED"]
    F2 --> CR["Todo el pago a saldo a favor<br/>(CANCELLATION lo que cupo, OVERPAYMENT el excedente),<br/>antes del folio"]
    CR --> G2["Aviso PAYMENT_AFTER_CANCELLATION al cliente<br/>(«quedó como saldo a favor»); nada al personal"]
    G --> I["«Lo que cupo en la reserva vencida:<br/>devolverlo o moverlo es decisión humana»"]
    H --> I
```

Una reserva `CANCELLED` sigue el mismo camino desde la Tarea 19: el panel
cancela en el proveedor las fichas pendientes al cancelar, pero una pagada en
ese mismo minuto puede llegar igual. Desde la Fase 2B ese dinero no queda en
el limbo: se acredita como saldo a favor del cliente en la misma transacción
del webhook (ver `customer-credit.md`), mientras se liquida el pago y antes de
numerar su recibo, y por eso el personal ya no recibe `ORPHAN_PAYMENT` por él.
El de una reserva `EXPIRED` sigue siendo decisión humana en la parte que cupo;
lo que exceda su total, desde la decisión D7, es `OVERPAYMENT`.

## Sobrepago confirmado (decisión D7)

Dos fichas por el total, una ficha más una tarjeta, o un pago que llega
cuando la reserva ya se liquidó por otro camino: Stripe confirma más de lo que
se debía. El pago se registra **completo** y la reserva sólo absorbe lo que
debía.

```mermaid
flowchart TD
    A["Pago confirmado por Stripe<br/>(bajo el candado de la reserva)"] --> S["saldo = total − paid_cents"]
    S --> AP["aplicado = min(monto, saldo)<br/>excedente = monto − aplicado"]
    AP --> P["Payment.amount_cents = monto completo<br/>paid_cents += aplicado (nunca pasa del total)"]
    P --> X{"¿excedente > 0?"}
    X -- No --> N1["Aviso PAYMENT_CONFIRMED"]
    X -- Sí --> O["Candado del cliente:<br/>OVERPAYMENT (+excedente, reservation_id, payment_id)<br/>uno por pago (índice único parcial)"]
    O --> N2["Aviso PAYMENT_EXCESS_CREDITED:<br/>«tu reservación ya no debía ese monto;<br/>$Z quedaron como saldo a favor»"]
    N1 --> F["Folio al final"]
    N2 --> F
```

El efectivo, el saldo aplicado, la captura histórica y la importación **no**
pasan por aquí con excedente: el monto lo teclea una persona y se rechaza con
`PAYMENT_EXCEEDS_BALANCE` antes de escribir nada.

## Un solo orden de bloqueo

`viaje → reserva → cliente → contador de folios`, escrito una sola vez en el
código («Lock order», al inicio de `payment-service.ts`). Antes, el webhook
pedía el folio antes de bloquear la reserva y el efectivo al revés; si
coincidían sobre la misma reserva, cada uno esperaba al otro:

```mermaid
sequenceDiagram
    autonumber
    participant W as "Webhook (antes)"
    participant PG as PostgreSQL
    participant M as "Efectivo en mostrador"

    W->>PG: "folio: UPDATE receipt_counters (lo retiene)"
    M->>PG: "reserva FOR UPDATE (la retiene)"
    M->>PG: "folio: UPDATE receipt_counters"
    Note over M,PG: "Espera al webhook"
    W->>PG: "UPDATE reservations (paid_cents)"
    Note over W,PG: "Espera al mostrador"
    PG--)W: "40P01 deadlock detected: aborta uno"
```

Con el folio ya al final quedaba un segundo cruce, el que encontró la carrera
de Charlie. El cobro en mostrador revive a través del viaje
(`reviveReservationSeat`, inyectado por la ruta: viaje `FOR UPDATE`, luego
reserva) aun para un apartado vigente. El webhook bloqueaba sólo la reserva y
la actualizaba dos veces; en la segunda, PostgreSQL vuelve a verificar la llave
foránea `trip_id`, que toma `FOR KEY SHARE` sobre el viaje:

```mermaid
sequenceDiagram
    autonumber
    participant W as "Webhook (antes)"
    participant PG as PostgreSQL
    participant M as "Efectivo en mostrador"

    W->>PG: "reserva FOR UPDATE"
    W->>PG: "UPDATE reservations (paid_cents)"
    M->>PG: "viaje FOR UPDATE (revive; lo retiene)"
    M->>PG: "reserva FOR UPDATE"
    Note over M,PG: "Espera al webhook"
    W->>PG: "UPDATE reservations (HELD → ACTIVE)"
    Note over W,PG: "La llave foránea pide el viaje FOR KEY SHARE:<br/>espera al mostrador"
    PG--)W: "40P01 deadlock detected: aborta uno"
```

Hoy todo camino de dinero toma el viaje `FOR KEY SHARE` y luego la reserva
(`lockReservationForMoney`), y numera al final, así que el mostrador
simplemente espera a que el webhook termine (o el webhook espera al mostrador,
si éste llegó primero al viaje):

```mermaid
sequenceDiagram
    autonumber
    participant W as Webhook
    participant PG as PostgreSQL
    participant M as "Efectivo en mostrador"

    W->>PG: "viaje FOR KEY SHARE, luego reserva FOR UPDATE"
    M->>PG: "viaje FOR UPDATE (revive)"
    Note over M,PG: "Espera: el webhook ya tiene el viaje"
    W->>PG: "Payment → SUCCEEDED, paid_cents, HELD → ACTIVE, (saldo a favor)"
    W->>PG: "folio al final"
    W->>PG: "COMMIT"
    PG-->>M: "viaje"
    M->>PG: "reserva, Payment CASH, paid_cents, folio al final"
    M->>PG: "COMMIT"
```

Lo mismo con un saldo aplicado en el mostrador frente al webhook, y frente a un
pago tardío de otra reserva, ya cancelada, del mismo cliente: el webhook
acredita el `CANCELLATION` (candado del cliente) antes del folio, no después.
`lock-order.spec.ts` fuerza cada uno de los tres cruces;
`cash-vs-webhook.race.integration.spec.ts` (apps/api) los corre por las rutas
reales, 40 rondas por cada camino del mostrador.

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
(un pago que llegó sobre uno ya dado por perdido): es justo cuando alguien
tiene que actuar a mano. Un segundo pago que excede el saldo ya no escala: se
registra y su excedente se acredita (decisión D7, arriba). Antes el aviso
salía sin enlace aunque el intento la nombrara.

## Cobro en el mostrador sobre un apartado vencido (decisión 13)

```mermaid
flowchart TD
    A["Cobro en efectivo o saldo<br/>sobre una reserva"] --> B{"Estado"}
    B -- "ACTIVE o HELD vigente" --> P["recordPayment (como siempre)"]
    B -- "CANCELLED" --> X["INVALID_STATUS_TRANSITION"]
    B -- "HELD vencida o EXPIRED" --> C["Candado del viaje, luego de la reserva"]
    C --> D{"¿Viaje publicado, sin otra reserva viva del cliente<br/>y con lugar?"}
    D -- No --> Y["TRIP_NOT_PUBLISHED, DUPLICATE_RESERVATION o TRIP_SOLD_OUT<br/>(no se escribe nada)"]
    D -- Sí --> E["Reserva → HELD con apartado nuevo"]
    E --> F{"¿Era EXPIRED?"}
    F -- Sí --> G["REVIVAL: el saldo que dejó el vencimiento<br/>vuelve a la reserva (CREDIT_INSUFFICIENT si ya se gastó)"]
    F -- No --> P
    G --> P
    P --> H{"¿Cubre el anticipo?"}
    H -- Sí --> I["ACTIVE"]
    H -- No --> J["HELD con el apartado nuevo"]
```

Si cualquier paso falla después de revivir, la transacción entera se revierte.

## El dinero de un apartado que vence (decisión 16)

```mermaid
flowchart LR
    A["expireHolds:<br/>HELD vencido → EXPIRED<br/>(UPDATE condicional)"] --> B{"¿paid_cents > 0?"}
    B -- No --> C["Sólo el aviso HOLD_EXPIRED"]
    B -- Sí --> D["EXPIRATION al saldo del cliente<br/>por lo que aún no está acreditado<br/>(misma transacción)"]
    D --> E["La reserva conserva paid_cents y sus pagos;<br/>revivirla en el mostrador toma el saldo de vuelta<br/>con un REVIVAL (ver customer-credit.md)"]
```

## Fichas por cobrar en el mostrador

```mermaid
flowchart TD
    A["GET /admin/payments?status=PENDING<br/>(payment.view)"] --> B{"¿Permiso y consulta válidos?"}
    B -- No --> X["403 PERMISSION_DENIED o<br/>422 VALIDATION_FAILED"]
    B -- Sí --> C["listPendingVouchers"]
    C --> D["Pagos PENDING con método OXXO o SPEI<br/>(nunca tarjeta, efectivo ni liquidados)"]
    D --> E["Orden: vencimiento de la ficha ↑,<br/>sin vencimiento al final, luego recorded_at e id"]
    E --> F["Página + nextCursor (claves, opaco)"]
    F --> G["El mostrador persigue el cobro;<br/>el pago sólo existe cuando llega el webhook"]
```

La lista no confirma nada: es dinero que se espera. Sólo el webhook de Stripe
mueve `paid_cents` y activa la reserva.
