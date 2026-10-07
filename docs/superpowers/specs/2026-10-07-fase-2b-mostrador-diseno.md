# Diseño: Fase 2B — El mostrador opera

**Fecha:** 2026-10-07
**Antecede:** `docs/superpowers/specs/2026-09-28-agencia-viajes-diseno.md` (diseño general) y
`docs/superpowers/specs/2026-10-03-fase-2a-reservas-y-pagos-diseno.md` (Fase 2A, integrada en `main`).

---

## 1. Qué construye esta fase

La segunda mitad de la Fase 2. Al cerrarla, **un trabajador atiende en el mostrador**: busca o da de
alta al cliente, le crea una reserva, cobra en efectivo, el cliente recibe su recibo en PDF, y el
dinero que no se usa —por una cancelación o una bajada de precio— queda como saldo a favor que una
persona administra.

| Bloque | Resumen |
|---|---|
| Clientes en mostrador | Búsqueda, alta sin contraseña, invitación por correo para activar la cuenta |
| Reserva en mostrador | Con pago inicial en un solo paso, o apartada sin pago |
| Cobro en efectivo | Registrado por un trabajador, confirmado al instante |
| Recibos PDF | Folio consecutivo por año, en el idioma del cliente, por correo y descargables |
| Saldo a favor | Monedero por cliente con movimientos: nace de cancelaciones y bajadas de precio, se aplica, se devuelve o se ajusta |
| Cambio de precio | Llevar el precio vigente del viaje a las reservas existentes, con aviso obligatorio |
| Captura histórica | Reservas y pagos con fechas pasadas para el arranque, con correos silenciados |
| Importación CSV | Clientes y pagos desde una plantilla propia, con vista previa y reporte |
| Solicitud de cancelación en la app | El botón que le faltó a la 2A (§11) |

**Criterio de cierre:** un trabajador cobra en efectivo en el mostrador y el cliente recibe su recibo.

---

## 2. Decisiones del dueño del producto (2026-10-07)

| Tema | Decisión |
|---|---|
| Dinero de una reserva cancelada | **Se vuelve saldo a favor** del cliente al cancelar. Después, el personal puede aumentarlo o reducirlo a voluntad —por ejemplo al devolver dinero fuera del sistema—, siempre con motivo y registro |
| Reserva en mostrador | **Las dos formas**: reserva más primer pago en un solo paso, o apartar sin pago |
| Importación CSV | **Plantilla propia** del sistema, descargable desde el panel |
| Datos del recibo | Los de los carteles («Casa Mochilera», Mariano Jiménez 551 B, Col. Jardines del Carmen, La Piedad, Mich., WhatsApp), **editables** desde el panel |

**Interpretación registrada.** La respuesta sobre el saldo a favor dice que «el cliente» debe poder
aumentarlo o disminuirlo. Se interpreta como **la agencia** (el personal con permiso), no el viajero
desde la app: que un viajero edite su propio saldo no tiene sentido contable. El viajero **ve** su
saldo y sus movimientos; quien los cambia es el personal. Si la intención era otra, se corrige antes
del plan.

### Cambios respecto del diseño general

| Diseño general | Esta fase | Por qué |
|---|---|---|
| El saldo a favor sólo nace de una bajada de precio (§5.5) | También nace de **cancelar** una reserva con pagos, y de ajustes manuales | Decisión del dueño del producto |
| `Reservation.credit_cents` (§4.3) | El saldo vive **por cliente**, en un libro de movimientos; la columna se elimina | Un saldo que nace en una reserva cancelada se usa en otra: no pertenece a ninguna reserva |
| Folio de recibo desde una *secuencia* de PostgreSQL (§5.5) | Desde un **contador por año** en una tabla, bajo bloqueo de fila | Las secuencias no reinician por año y dejan huecos cuando una transacción se revierte; un folio de recibo no debe saltarse |
| Cambio de precio = editar el precio con aviso (§5.6) | Editar el precio sigue en el costeo y afecta sólo reservas nuevas; la operación de 2B **lleva el precio vigente a las reservas existentes** | El costeo ya separa ambas cosas (`docs/business-rules/costing.md`); no se mezclan |
| El aviso de cambio de precio es una `NotificationCampaign` (§5.6) | Un aviso de sistema por cliente con el texto que redacta el administrador | Las campañas siguen siendo Fase 3; la 2A dejó la infraestructura de avisos que basta aquí |

---

## 3. Decisiones de arquitectura

| Área | Decisión | Razón |
|---|---|---|
| Módulos de dominio | `libs/domain/customers` (búsqueda, alta, invitación), `libs/domain/imports` (CSV); saldo a favor y recibos dentro de `libs/domain/payments` | Clientes e importación son responsabilidades nuevas; el saldo y el folio son dinero y viven donde vive el dinero |
| Generación de PDF | Adaptador en `libs/receipts` detrás de un puerto `ReceiptRenderer`, como `@rm/email` y `@rm/payments-stripe` | El dominio no sabe qué librería dibuja el PDF; se prueba con un renderizador falso |
| Librería de PDF | `pdf-lib` con Poppins incrustada | Sin navegador ni binarios nativos: corre igual en la Raspberry Pi (arm64) y en EC2 |
| Envío del recibo | Job `SEND_RECEIPT` en `apps/worker`, encolado en la misma transacción que confirma el pago | Mismo patrón de bandeja de salida que los avisos (Regla 11 de la 2A): un recibo nunca sale por un pago que no se registró |
| Adjuntos de correo | `EmailMessage` gana `attachments` opcionales; Resend los envía en base64 | El recibo viaja adjunto, no como enlace que caduca |
| Invitación | Token de un solo uso con hash, como `PasswordReset`, con propósito `INVITATION` | Mismo mecanismo probado; establecer la contraseña por primera vez es un caso del mismo flujo |
| Importación | Dos pasos: `validate` (sin efectos, devuelve la vista previa) y `apply` (por fila, cada una en su transacción) | Una fila inválida no detiene a las demás; la vista previa no escribe nada |

---

## 4. Modelo de datos

### 4.1 Saldo a favor

```
CustomerCreditEntry  id, customer_id, amount_cents (con signo, ≠ 0),
                     kind (CANCELLATION|PRICE_DECREASE|APPLIED|REFUND|ADJUSTMENT),
                     reservation_id?, payment_id?, reason?, created_by?, created_at
```

- **El saldo de un cliente es la suma de sus movimientos**, nunca una columna editable. Se calcula
  bajo bloqueo de la fila del cliente cuando se va a escribir, igual que el cupo de un viaje.
- Positivos: `CANCELLATION`, `PRICE_DECREASE`, `ADJUSTMENT` (aumento). Negativos: `APPLIED`,
  `REFUND`, `ADJUSTMENT` (disminución).
- **Nunca negativo**: un movimiento que dejaría la suma bajo cero se rechaza (`CREDIT_INSUFFICIENT`).
- `Reservation.credit_cents` (siempre cero desde la 2A) se elimina en la migración.

### 4.2 Pagos y recibos

- `PaymentMethod` gana **`CREDIT`**: aplicar saldo a favor a una reserva es un `Payment` con ese
  método, `provider = MANUAL`, `SUCCEEDED`, más el movimiento `APPLIED` en la misma transacción. Así
  `paid_cents` sigue siendo exactamente la suma de pagos `SUCCEEDED` y la conciliación nocturna no
  cambia.
- `Payment.receipt_number` se vuelve **único**. Formato `{receipt.prefix}-{año}-{000001}`, con el año
  de `paid_at` en la zona de la organización.

```
ReceiptCounter     year (PK), last_number, updated_at
```

- El folio se asigna **en la transacción que deja el pago en `SUCCEEDED`**, para todo método,
  incluidos los de Stripe y los históricos. `SELECT ... FOR UPDATE` sobre la fila del año: sin
  huecos y sin duplicados.
- `receipt_key` (PDF en el almacenamiento) y `receipt_sent_at` los llena el job.

### 4.3 Cambio de precio

```
ReservationPriceChange  id, reservation_id, previous_total_cents, new_total_cents,
                        notice_es, notice_en?, changed_by, changed_at
```

### 4.4 Invitación

`PasswordReset` gana `purpose (RESET|INVITATION)`. La invitación vive más tiempo
(`invitation.ttl_days`, 7 por omisión) que el restablecimiento (60 minutos).

### 4.5 Importación

```
ImportBatch        id, type (CUSTOMERS|PAYMENTS), file_name, status (VALIDATED|APPLIED|FAILED),
                   rows_total, rows_ok, rows_failed, report jsonb, send_emails bool,
                   created_by, created_at, applied_at?
```

### 4.6 Configuración

Claves nuevas de `SystemSetting`: `organization.name`, `organization.address`,
`organization.phone`, `organization.website` (los datos del recibo, sembrados con los de los
carteles) e `invitation.ttl_days`. `receipt.prefix` ya existe.

---

## 5. Reglas de negocio

### 5.1 Clientes en mostrador

- **Búsqueda** por nombre, correo o teléfono (`customer.view`), sin distinguir mayúsculas ni acentos,
  paginada.
- **Alta** (`customer.manage`): nombre completo, correo, teléfono y fecha de nacimiento. Se crea un
  `CUSTOMER` con el correo **ya verificado** (lo verificó el trabajador en persona), **sin
  contraseña**, `origin = BRANCH`, términos sin aceptar.
- **Correo ya registrado** → no se duplica: `CUSTOMER_ALREADY_EXISTS` con el id existente, y el
  panel abre a ese cliente.
- **Invitación**: al dar de alta se envía, salvo que el trabajador la desmarque. Liga de un solo uso a
  `/app/invitation?token=…` donde el cliente fija su contraseña y acepta los términos. Se puede
  reenviar; cada reenvío invalida la anterior. Al aceptarla se sella `activated_at`.
- Un cliente que nunca activa su cuenta sigue recibiendo recibos y avisos por correo; el mostrador
  sigue cobrándole.

### 5.2 Reserva en mostrador

`reservation.create`. Mismas reglas que la reserva de la app (§5.2 de la 2A): bloqueo de fila del
viaje, viaje publicado, fecha límite de pago vigente, una reserva viva por cliente y viaje, cupo
disponible, montos congelados. `source = BRANCH`, `created_by` = el trabajador.

Dos modos:

1. **Con pago inicial** (el modo por omisión): reserva y primer pago en efectivo en **una sola
   transacción**. Si el pago cubre el anticipo mínimo la reserva nace `ACTIVE` sin apartado; si no,
   nace `HELD` con el apartado normal. Sin pago no se crea por este camino.
2. **Apartada sin pago**: nace `HELD` con el apartado normal del viaje y se cobra después.

### 5.3 Cobro en efectivo

`payment.register`. Un pago `CASH`, `provider = MANUAL`, `SUCCEEDED` al instante, `recorded_by` = el
trabajador, `paid_at` = ahora.

- Monto `> 0` y `≤ saldo pendiente` (`PAYMENT_EXCEEDS_BALANCE`), igual que todo pago.
- Sólo sobre reservas `HELD` o `ACTIVE`. Sobre una `CANCELLED` o `EXPIRED` → `INVALID_STATUS_TRANSITION`:
  el dinero de un cliente sin reserva viva se registra como saldo a favor (`ADJUSTMENT`), no como
  pago de una reserva muerta.
- Una `HELD` que con este pago cubre el anticipo pasa a `ACTIVE`, con el mismo `updateMany`
  condicionado que usa el webhook.
- Folio y job de recibo en la misma transacción (§5.4).

### 5.4 Recibos

- **Todo pago que llega a `SUCCEEDED` recibe folio y recibo**: efectivo, tarjeta, OXXO, SPEI, saldo a
  favor e históricos.
- El PDF muestra: datos de la agencia (§4.6), folio, fecha de pago (en la zona de la organización),
  cliente, viaje y fechas, folio de la reserva, monto y método, y **la foto del saldo en ese
  momento** (total, pagado y saldo pendiente después de este pago). Lo que el recibo dice no cambia
  aunque la reserva cambie después: el PDF se genera una vez y se guarda.
- En el **idioma del cliente**.
- El job `SEND_RECEIPT` genera el PDF, lo guarda (`receipt_key`), lo envía adjunto y sella
  `receipt_sent_at`. Idempotente: un recibo ya enviado no se reenvía; un PDF ya guardado no se
  regenera.
- **Silenciado** en captura histórica e importación salvo que el trabajador marque el envío (§5.7): se
  asigna el folio y se genera el PDF al pedirlo, pero no se envía.
- El cliente descarga sus recibos desde el historial de pagos de la app; el personal, desde el panel
  (`payment.view`). Reenviar un recibo es una acción explícita del panel.

### 5.5 Saldo a favor

**Nunca mueve dinero solo.** Lo ve el cliente (en «Mi cuenta», sólo lectura, con sus movimientos) y
el personal; lo cambia sólo el personal con `payment.credit.apply`, con motivo, en `AuditLog`.

| Movimiento | Signo | Quién | Cuándo |
|---|---|---|---|
| `CANCELLATION` | + | Automático | Al cancelar una reserva con `paid_cents > 0`, por ese monto |
| `PRICE_DECREASE` | + | Automático | Al bajar el precio de una reserva por debajo de lo ya pagado (§5.6) |
| `APPLIED` | − | Personal | Aplicarlo a una reserva viva del mismo cliente: crea el pago `CREDIT` |
| `REFUND` | − | Personal | Se devolvió el dinero **fuera del sistema** (efectivo, transferencia); motivo obligatorio |
| `ADJUSTMENT` | ± | Personal | Corrección o cortesía, en cualquier sentido; motivo obligatorio |

- Aplicar saldo: monto `≤ saldo del cliente` y `≤ saldo pendiente de la reserva`. Da folio y recibo.
- La reserva cancelada **conserva** su `paid_cents` y sus pagos: el registro contable no se borra.
  El movimiento `CANCELLATION` sólo refleja que ese dinero ya está disponible para el cliente.
- Para la Fase 3: un pago `CREDIT` es un traslado, no un ingreso nuevo. Los reportes de ingresos
  deben excluirlo para no contar dos veces el mismo dinero.

### 5.6 Cambio de precio a reservas existentes

`trip.change_price`. Editar el precio del viaje sigue en el costeo y sólo afecta reservas nuevas. Esta
operación lleva **el precio vigente del viaje** a sus reservas `HELD` y `ACTIVE` cuyo total
congelado es distinto.

- **Exige el aviso** a los afectados: texto en español obligatorio, inglés opcional. Sin reservas
  afectadas no hay nada que hacer y no se pide aviso.
- **Vista previa** antes de confirmar: cuántas reservas cambian y, por cada una, total anterior,
  total nuevo, pagado y efecto (saldo nuevo o saldo a favor que nace).
- En **una transacción**, bajo el bloqueo del viaje, por cada reserva afectada:
  1. `ReservationPriceChange` con el total anterior, el nuevo y el aviso.
  2. `total_price_cents` toma el precio vigente.
  3. Si `paid_cents > nuevo total`, la diferencia es saldo a favor (`PRICE_DECREASE`) y el saldo
     pendiente queda en cero.
  4. Aviso `PRICE_CHANGED` al cliente: el texto del administrador más los datos de su reserva (total
     anterior, total nuevo, saldo nuevo y saldo a favor si nació).
- El estado de la reserva no cambia: una `ACTIVE` sigue `ACTIVE` aunque ahora deba más. El anticipo
  mínimo congelado tampoco cambia.

### 5.7 Captura histórica

`data.backfill`. Para el arranque: cargar en el sistema lo que hoy vive en papel.

- **Reserva histórica**: sobre viajes en cualquier estado salvo `DRAFT` y `CANCELLED` (incluye
  `IN_PROGRESS` y `COMPLETED`), con `created_at` retroactivo, sin apartado ni validación de anticipo,
  `source = BRANCH`, `is_backfilled`. **Cuenta para el cupo** igual que cualquier otra; se toma el
  mismo bloqueo.
- **Pagos históricos**: método `LEGACY` (o `CASH` si se sabe), `paid_at` en el pasado, `is_backfilled`.
  Dos caminos: un abono inicial único con el total ya pagado, o el desglose pago por pago.
- **Correos silenciados por omisión**: ni recibo ni invitación salen salvo que se marque la casilla.
- Todo queda en `AuditLog` con el actor.

### 5.8 Importación CSV

`import.manage`. Dos plantillas descargables desde el panel, UTF-8, separadas por comas, con fila de
encabezados en inglés estable y una fila de ejemplo.

**Clientes** — `full_name, email, phone, birth_date (YYYY-MM-DD), locale (es|en, opcional)`.
Crea clientes `origin = IMPORT`, correo verificado, sin contraseña. Un correo que ya existe no se
duplica: la fila se reporta como `EXISTS` (no es error).

**Pagos** — `customer_email, trip_slug, paid_at (YYYY-MM-DD), amount (pesos, p. ej. 1500.00),
method (CASH|LEGACY|CARD|OXXO|SPEI), external_ref (opcional), notes (opcional)`.
Busca la reserva viva de ese cliente en ese viaje; si no hay, crea una reserva histórica (§5.7). El
pago entra como histórico. `external_ref` evita importar dos veces el mismo pago.

**Flujo**: subir → validar fila por fila sin escribir nada → **vista previa** con cada error en su
fila y columna → confirmar → aplicar fila por fila (una inválida no detiene a las demás) → reporte
completo en `ImportBatch.report`. Tope de 5,000 filas y 5 MB. Correos silenciados por omisión.

### 5.9 Solicitud de cancelación desde la app

El endpoint existe desde la 2A pero la app no tiene el botón. En el detalle de una reserva viva: «Solicitar
cancelación», con motivo opcional y confirmación; después muestra que la solicitud está en revisión,
y si el personal la rechazó, el motivo y la opción de pedirla otra vez.

---

## 6. Trabajos en segundo plano

| Job | Disparador | Qué hace |
|---|---|---|
| `SEND_RECEIPT` | Encolado al confirmar un pago (salvo silenciado) | Genera el PDF si falta, lo guarda, lo envía adjunto, sella `receipt_sent_at` |

Los demás jobs de la 2A no cambian. La conciliación nocturna no cambia: los pagos `CREDIT` son
pagos `SUCCEEDED` como cualquier otro.

---

## 7. Panel administrativo

- **Clientes**: búsqueda, alta, detalle (datos, reservas, pagos, saldo a favor con movimientos y
  acciones), reenviar invitación.
- **Desde el cliente**: nueva reserva en mostrador (con o sin pago), aplicar saldo, devolución,
  ajuste.
- **Desde la reserva** (detalle de la 2A): registrar pago en efectivo, descargar y reenviar recibos.
- **Desde el viaje**: «Actualizar reservas al precio vigente», con vista previa y aviso.
- **Captura histórica**: reserva y pagos con fechas pasadas, desde el cliente.
- **Importaciones**: subir, vista previa, confirmar, historial de lotes con su reporte.
- **Configuración de la agencia**: los datos del recibo (`settings.manage`).

## 8. Aplicación cliente

- **Invitación**: pantalla para fijar contraseña y aceptar términos desde la liga.
- **Mi cuenta**: saldo a favor y sus movimientos, sólo lectura.
- **Historial de pagos**: descarga del recibo de cada pago confirmado.
- **Detalle de reserva**: solicitar cancelación (§5.9).

---

## 9. Contrato de API

| Método | Ruta | Permiso |
|---|---|---|
| GET | `/admin/customers?search=` | `customer.view` |
| POST | `/admin/customers` | `customer.manage` |
| GET | `/admin/customers/{id}` | `customer.view` |
| POST | `/admin/customers/{id}/invitation` | `customer.manage` |
| GET | `/admin/customers/{id}/credit` | `payment.view` |
| POST | `/admin/customers/{id}/credit/refund` · `/adjust` | `payment.credit.apply` |
| POST | `/admin/reservations` (mostrador, con o sin pago) | `reservation.create` (+ `payment.register` si trae pago) |
| POST | `/admin/reservations/{id}/payments` (efectivo) | `payment.register` |
| POST | `/admin/reservations/{id}/apply-credit` | `payment.credit.apply` |
| POST | `/admin/backfill/reservations` · `/admin/backfill/payments` | `data.backfill` |
| GET | `/admin/payments/{id}/receipt` · POST `.../receipt/resend` | `payment.view` |
| GET · POST | `/admin/trips/{id}/price-change` (vista previa · aplicar) | `trip.change_price` |
| GET | `/admin/imports/templates/{type}` | `import.manage` |
| POST | `/admin/imports/{type}` (validar) · `/admin/imports/{id}/apply` | `import.manage` |
| GET | `/admin/imports` · `/admin/imports/{id}` | `import.manage` |
| GET · PUT | `/admin/settings/organization` | `settings.manage` |
| POST | `/auth/invitation/accept` | público, con token |
| GET | `/me/credit` | propio |
| GET | `/payments/{id}/receipt` | propio |

## 10. Documentación viva

Archivos nuevos: `docs/business-rules/customers.md`, `docs/business-rules/imports.md`,
`docs/diagrams/counter-sale.md` (mostrador: alta, reserva y cobro) y `docs/diagrams/customer-credit.md`
(movimientos del saldo a favor). Se añaden a la tabla de `CLAUDE.md` y al guardián de CI. Se
actualizan `reservations.md`, `payments.md`, `notifications.md`, `payment-flow.md` y
`trip-reservation.md`.

## 11. Manejo de errores

Códigos nuevos: `CUSTOMER_ALREADY_EXISTS` (409, con el id existente), `CREDIT_INSUFFICIENT` (409),
`NO_PRICE_CHANGE` (409, nada que actualizar), `IMPORT_TOO_LARGE` (413), `IMPORT_ALREADY_APPLIED` (409).
Los errores por fila de una importación viajan en el reporte, como códigos estables por columna, y el
panel los traduce.

## 12. Estrategia de pruebas

La misma de la 2A: pruebas que se ven fallar antes de implementar, integración contra PostgreSQL
real, y mutación deliberada en lo crítico. Concurrencia probada en: folio de recibo (dos pagos a la
vez nunca comparten folio ni dejan hueco), saldo a favor (dos aplicaciones a la vez nunca lo dejan
negativo), y cambio de precio frente a un pago simultáneo. E2E nuevo: alta en mostrador → reserva con
pago en efectivo → recibo encolado; y aceptar la invitación.

## 13. Fuera de alcance

- Todo lo de la Fase 3 (push, campañas, recordatorio del 28, alerta del 40 %, gastos, reportes,
  tiendas).
- Reembolsos por Stripe: la devolución de dinero ocurre **fuera del sistema** y aquí sólo se registra.
- SPEI en la app y el cobro real con tarjeta: esperan las claves de Stripe
  (`docs/decisiones-fase-2a.md`).
- Timbrado CFDI y datos fiscales en el recibo.

## 14. Requisitos externos

| Requisito | Bloquea | Sin él |
|---|---|---|
| Dominio verificado en Resend | Envío de invitaciones y recibos | Los PDF se generan y se descargan; no salen por correo |

## 15. Riesgos

| Riesgo | Mitigación |
|---|---|
| Folio de recibo duplicado o con huecos | Contador por año bajo bloqueo de fila, en la transacción del pago, con prueba concurrente |
| Saldo a favor negativo por dos aplicaciones simultáneas | Bloqueo de la fila del cliente y suma bajo ese bloqueo, con prueba concurrente |
| Doble conteo de ingresos al aplicar saldo | Método `CREDIT` explícito; los reportes de Fase 3 lo excluyen |
| Importación aplicada dos veces | `external_ref` y `ImportBatch` con estado; aplicar dos veces el mismo lote es `IMPORT_ALREADY_APPLIED` |
| Bombardeo de correos en el arranque | Correos silenciados por omisión en captura histórica e importación |
| PDF que no se genera en arm64 | `pdf-lib` es JavaScript puro, sin binarios nativos; se prueba en CI |
