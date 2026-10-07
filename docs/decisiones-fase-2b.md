# Decisiones de la Fase 2B

Decisiones tomadas al construir y cerrar la Fase 2B (el mostrador opera),
agrupadas por quién las tomó. Las del diseño original están en la spec
(`docs/superpowers/specs/2026-10-07-fase-2b-mostrador-diseno.md`, §2 y
«Cambios respecto del diseño general»); aquí van las que se tomaron o se
confirmaron después, al implementar.

**Estado:** las Tareas 1 a 14 están en `main` (`934c971`). La Tarea 15 (extremo
a extremo, documentación y cierre) y los arreglos que dejó la validación están
integrados en `phase-2b/integration`, pendiente de pasar a `main`. Las
decisiones 13 y 16 (revivir un apartado vencido y acreditar lo pagado al
vencer) están **implementadas**; la 17 es un caso inerte conocido. Quedan
abiertas las limitaciones de «Pendientes» y la interpretación de la decisión 7.

## Índice

| # | Decisión | Estado |
|---|---|---|
| 1 | Una bajada de precio resta lo pagado de más de la reserva | Decidida |
| 2 | Las importaciones CSV corren en el worker, con progreso y sin reintento automático | Decidida |
| 3 | Los recibos son privados | Decidida |
| 4 | La descarga del recibo en la app de Capacitor queda pendiente | Pendiente |
| 5 | Las Tareas 1 a 14 entraron directo a `main`, sin pull request | Decidida |
| 6 | El dinero de una reserva cancelada se vuelve saldo a favor | Registrada en la spec |
| 7 | Quien cambia el saldo es la agencia, no el viajero | Interpretación por confirmar |
| 8 | El saldo vive por cliente, en un libro de movimientos | Registrada en la spec |
| 9 | El folio del recibo sale de un contador por año | Registrada en la spec |
| 10 | Cambiar el precio de un viaje y llevarlo a las reservas son dos operaciones | Registrada en la spec |
| 11 | `ImportBatch` tiene un estado más: `APPLYING` | Confirmada |
| 12 | El recibo guarda la foto del saldo en el pago | Confirmada |
| 13 | Un cobro en el mostrador revive un apartado vencido si queda lugar | **Implementada** |
| 14 | La invitación no pasa por la bandeja de salida de pg-boss | Confirmada |
| 15 | El folio de un pago histórico sigue el año de `paid_at` | Confirmada |
| 16 | Un apartado que vence con pagos devuelve lo pagado como saldo a favor | **Implementada** |
| 17 | Reenviar una invitación mientras el cliente restablece su contraseña | Caso inerte conocido |

Las decisiones van agrupadas por quién las tomó, no por número: la 13 y la 16
están al final porque se tomaron y se implementaron después de las demás.

---

## Decididas por el dueño del producto

### 1. Una bajada de precio resta lo pagado de más de la reserva

Si bajar el precio deja a un cliente pagado de más, el excedente **sale de
`paid_cents`** de la reserva cuando se vuelve saldo a favor (`PRICE_DECREASE`).
Sin esa resta, el mismo dinero existiría dos veces —en la reserva y en el
saldo— y una subida de precio posterior, o una cancelación, se lo entregaría de
nuevo al cliente.

Consecuencias:

- `paid_cents` es siempre lo que la reserva conserva, y la cancelación acredita
  exactamente eso.
- La conciliación nocturna (`reconcilePaidCents`) compara `paid_cents` contra
  los pagos `SUCCEEDED` **menos** los `PRICE_DECREASE` de la reserva. La spec
  decía que la conciliación «no cambia»; con esta decisión sí cambia, y la
  spec (§5.6, paso 3) ya recoge la corrección.
- El historial de pagos no se toca: los pagos siguen ahí, con sus recibos.

Ver `docs/business-rules/reservations.md`, «Cambio de precio», y
`docs/diagrams/customer-credit.md`, «Cómo nace el saldo».

### 2. Las importaciones CSV corren en el worker, con progreso y sin reintento automático

5,000 filas, cada una en su transacción y quizá con su invitación por correo,
tardan minutos: más de lo que una petición HTTP aguanta detrás de Nginx. Por
eso aplicar un lote lo encola (`APPLY_IMPORT`, en `apps/worker`) y el panel
consulta el lote hasta que deja de estar `APPLYING`. El worker guarda su
avance en el reporte cada 100 filas.

**Una caída a medias NO se reintenta sola.** Una fila de pago sin
`external_ref` no se distingue de una segunda copia de sí misma, así que
reintentar podría duplicar pagos. El lote se queda `APPLYING` con su reporte
parcial para que una persona decida. El job se encola con `retryLimit: 0` y
una hora de plazo. **Se recomienda llenar `external_ref` en las filas de
pago**: es lo que hace seguro volver a subir un archivo.

Ver `docs/business-rules/imports.md`, «Por qué en el worker» y «No se reintenta
solo», y `docs/diagrams/counter-sale.md`, «Importar clientes y pagos desde
CSV».

### 3. Los recibos son privados

- La ruta pública de archivos (`/api/v1/files/...`) **rechaza** el prefijo
  `receipts/` (sin distinguir mayúsculas: `Receipts/...` tampoco se sirve, porque en un
  sistema de archivos que no distingue mayúsculas sería el mismo archivo) con el
  mismo 404 de un archivo que no existe. Un recibo sólo se
  sirve por rutas que verifican quién pregunta: la del cliente dueño del pago
  (`/payments/{id}/receipt`) o la del personal con `payment.view`
  (`/admin/payments/{id}/receipt`).
- El nombre en el almacenamiento lleva una parte aleatoria:
  `receipts/{año}/{folio}-{uuid}.pdf`. Los folios son consecutivos y por tanto
  adivinables; la parte aleatoria mantiene la llave impredecible aunque un
  bucket se expusiera más de lo debido. (El plan decía `receipts/{año}/{folio}.pdf`.)
- **Con S3, la carpeta `receipts/` no debe ser pública.** El bucket debe
  servir `receipts/` sin lectura anónima; el resto de las imágenes sí se sirven
  directo del bucket.

### 4. La descarga del recibo en la app de Capacitor queda pendiente

En el navegador, la app descarga el PDF con un `Blob` y un enlace de descarga
(`apps/client/src/app/shared/save-file.ts`). Dentro del empaquetado de
Capacitor eso probablemente no basta: guardar o compartir un archivo en el
teléfono necesita un plugin nativo. Se deja pendiente. El recibo adjunto por correo
(`SEND_RECEIPT`) no depende de esto.

### 5. Las Tareas 1 a 14 entraron directo a `main`, sin pull request

A diferencia de la Fase 2A (que se integró con el PR #1), las Tareas 1 a 14 de
la 2B aterrizaron directamente en `main`. Por eso **CI y `docs-guard` no
corrieron como pull request** sobre ese trabajo: la regla de «documentación
obligatoria en el mismo commit» no tuvo guardián automático en esas tareas.

Revisado commit por commit contra la tabla de `CLAUDE.md`, **6 commits rompieron
la regla de «en el mismo commit»** (cambiaron `libs/domain/<módulo>/src/**` sin tocar
uno de los archivos que la tabla exige en ese mismo commit):

| Commit | Módulo | Faltaba |
|---|---|---|
| `d0c4938` | reservations | `docs/diagrams/trip-reservation.md` |
| `5795720` | notifications | `docs/business-rules/notifications.md` |
| `9fc233e` | payments | `docs/diagrams/payment-flow.md` |
| `47b54f2` | payments | `docs/diagrams/payment-flow.md` |
| `143e7de` | customers | `docs/diagrams/counter-sale.md` |
| `934c971` | reservations | `docs/diagrams/trip-reservation.md` |

Corriendo `docs-guard` sobre todo el rango como si fuera un pull request, **pasa**:
la regla se cumple sobre el conjunto, así que el daño es sólo de historia (un
`git log` de esos commits no cuenta la regla completa). Los commits de la
Tarea 15 completan los diagramas que faltaban (`counter-sale.md`,
`customer-credit.md`, `payment-flow.md` y `trip-reservation.md`).

---

## Registradas en la spec y el plan

Estas ya constan en la spec (§2); se repiten aquí para que el registro de
decisiones esté en un solo lugar.

### 6. El dinero de una reserva cancelada se vuelve saldo a favor

Decisión del dueño (2026-10-07). El diseño general sólo hacía nacer saldo de
una bajada de precio. Ahora también nace de **cancelar** una reserva con
`paid_cents > 0` y de los ajustes manuales. La reserva cancelada **conserva** su
`paid_cents` y sus pagos: el registro contable no se borra, y el movimiento
`CANCELLATION` sólo refleja que ese dinero ya está disponible.

### 7. Quien cambia el saldo es la agencia, no el viajero

La respuesta del dueño dice que «el cliente» puede aumentar o disminuir su
saldo. Se interpretó como **la agencia** (el personal con
`payment.credit.apply`), siempre con motivo y en `AuditLog`: que un viajero
edite su propio saldo no tiene sentido contable. El viajero lo ve en «Mi
cuenta», sólo lectura. **Interpretación pendiente de confirmar por el dueño.**

### 8. El saldo vive por cliente, en un libro de movimientos

`Reservation.credit_cents` (diseño general §4.3) se eliminó. Un saldo que nace
en una reserva cancelada se usa en otra: no pertenece a ninguna reserva. El
saldo es la suma de `customer_credit_entries`, nunca una columna editable.

### 9. El folio del recibo sale de un contador por año, no de una secuencia

El diseño general decía una secuencia de PostgreSQL. Las secuencias no
reinician por año y dejan un hueco cada vez que una transacción se revierte; un
folio de recibo no debe saltarse. Se usa una fila por año en `receipt_counters`
bajo bloqueo, dentro de la transacción que deja el pago en `SUCCEEDED`.

### 10. Cambiar el precio de un viaje y llevarlo a las reservas son dos operaciones

Editar el precio en el costeo sigue afectando sólo reservas nuevas. La
operación explícita `trip.change_price` lleva el precio vigente a las reservas
`HELD` y `ACTIVE`, con aviso obligatorio y vista previa. El aviso es un aviso de
sistema por cliente (`PRICE_CHANGED`), no una `NotificationCampaign`: las
campañas siguen siendo de la Fase 3.

---

## Pendientes

Limitaciones conocidas que se documentan tal como son hoy
(`docs/business-rules/imports.md`, «Limitaciones conocidas») hasta que se
diseñe la solución.

- **Pendiente: un lote de importación caído no tiene salida.** Si el worker se
  cae a medias, el lote queda `APPLYING` y no hay forma de reanudarlo ni de
  cancelarlo desde el panel ni la API (`IMPORT_ALREADY_APPLIED`). Relacionada con
  la decisión 2: el reintento automático se descartó a propósito, pero no se
  construyó la acción manual que la reemplaza.
- **Pendiente: el job `APPLY_IMPORT` vence a la hora** (`expireInSeconds: 3600`).
  Un lote muy grande puede quedar `APPLYING` por esa causa y caer en el mismo
  problema.
- **Pendiente: un error inesperado en una fila aborta el lote.** Un fallo que no
  es un resultado de dominio (una excepción, no un `Result` fallido) detiene
  `applyImport` y el lote queda `APPLYING`. Las filas aplicadas desde el último
  punto de control (cada 100) **conservan sus pagos y sus clientes**, pero su
  resultado no llegó al reporte: se ven sin `outcome`. Es el mismo callejón sin
  salida de los dos puntos anteriores, y como `external_ref` es lo único que
  evita duplicados, volver a subir el archivo duplicaría los pagos que no lo traen.
- **Limitación conocida: los recibos con caracteres fuera de Poppins.** El PDF
  embebe Poppins; un nombre con caracteres que la fuente no tiene (chino,
  japonés, coreano, emoji) no se dibuja bien y queda en blanco en ese lugar. El
  PDF se genera y se envía igual, con el resto del recibo intacto.

---

## Confirmadas por el dueño tras revisarlas en el código

El plan dice «donde este plan y el código difieran, manda el código». Estas
diferencias existían entre la spec y el código, sin estar registradas como
decisión. El dueño las revisó y **las confirmó**.

### 11. `ImportBatch` tiene un estado más: `APPLYING`

La spec (§4.5) lista `VALIDATED | APPLIED | FAILED`. El código añade
`APPLYING`: el lote que alguien confirmó y el worker está procesando (o que se
quedó a medias, decisión 2). Es lo que impide confirmar dos veces el mismo lote
y lo que el panel consulta para mostrar el progreso.

### 12. El recibo guarda la foto del saldo en el pago

La spec (§4.2) sólo menciona `receipt_key` y `receipt_sent_at`. El código
añade `receipt_total_cents` y `receipt_paid_cents`, escritos con el folio, para
que el recibo diga siempre el saldo de ese momento. Para un pago sin esas
columnas llenas, el saldo se reconstruye con los pagos hasta ese.

### 14. La invitación no pasa por la bandeja de salida de pg-boss

La spec (§3) dice que el envío de recibos y avisos usa la bandeja de salida.
Las invitaciones, no: la bandeja guarda su contenido en la base y el token en
claro no debe quedar ahí. El correo sale directo tras el commit, igual que el
de restablecer contraseña; si falla, la respuesta dice `invitationSent: false`
y el personal reenvía.

### 15. El folio de un pago histórico sigue el año de `paid_at`

Un pago capturado o importado hoy con `paid_at` de un año anterior recibe su
folio del contador de **ese** año (`RM-2025-…`): toma el siguiente número de una
serie que ya estaba cerrada, así que los folios de 2025 dejan de seguir el
orden de las fechas de pago (un pago de marzo puede llevar un folio mayor que
uno de diciembre). Tampoco quedan huecos ni duplicados: sólo se pierde el orden
cronológico. Es consecuencia de la decisión 9 y de que el folio use el año de `paid_at` en la
zona de la organización (`assignReceiptNumber`). **Aceptado:** se pierde el orden
cronológico dentro de un año ya cerrado y no se busca otra serie ni prefijo para
los históricos. Ver `docs/diagrams/payment-flow.md`, «Pagos históricos».

---

## Decididas por el dueño, implementadas

### 13. Un cobro en el mostrador revive un apartado vencido si queda lugar

Antes el cobro en efectivo o la aplicación de saldo sobre una reserva con el
apartado vencido respondía `HOLD_EXPIRED`. **El dueño decidió que ya no
bloquea**: el personal puede cobrar en efectivo o aplicar saldo a una reserva
vencida, sea una `HELD` pasada de su hora o una `EXPIRED`, **si queda un lugar
bajo el candado del viaje**.

- Si el pago cubre el anticipo, la reserva **revive como `ACTIVE`**.
- Si no lo cubre, revive como `HELD` con un apartado nuevo (`hold_ttl_hours`
  del viaje desde ahora).
- Si ya no queda lugar, `TRIP_SOLD_OUT` y no se escribe nada.
- Una reserva `CANCELLED` **no revive**: sigue siendo `INVALID_STATUS_TRANSITION`,
  y el dinero de un cliente sin reserva viva se registra como saldo a favor.
- El viaje debe seguir `PUBLISHED` (`TRIP_NOT_PUBLISHED`); el plazo de pago
  **no** se exige. Si el cliente ya reservó de nuevo ese viaje,
  `DUPLICATE_RESERVATION`.
- Los pagos por webhook **no** reviven nada: un pago tardío sobre una `EXPIRED`
  se registra como siempre (fuera de alcance).
- No hay aviso extra de reactivación: el cliente recibe el recibo del cobro.

**Implementación.** `reviveReservationSeat` (`@rm/domain-reservations`) decide
el lugar y `registerCashPayment`/`applyCreditToReservation` (`@rm/domain-payments`)
lo reciben inyectado y registran el dinero, todo en una transacción que se
revierte completa si falla cualquier paso. **Orden de bloqueo en toda
operación: viaje, reserva, cliente.** Reglas en `reservations.md` («Revivir una
reserva vencida») y `payments.md` («Revivir con un cobro»); diagramas en
`trip-reservation.md`, `payment-flow.md` y `customer-credit.md`.

### 16. Un apartado que vence con pagos devuelve lo pagado como saldo a favor

Cuando una reserva `HELD` que ya recibió un pago (menor al anticipo) vence y
`expireHolds` la pasa a `EXPIRED`, **lo pagado se vuelve saldo a favor del
cliente**, igual que al cancelar (decisión 6). Antes el dinero se quedaba en una
reserva muerta, sin movimiento que lo hiciera disponible.

- La reserva `EXPIRED` **conserva** `paid_cents` y sus pagos (como una
  cancelada); el saldo se escribe como `EXPIRATION`, en la transacción de
  `expireHolds`, y es idempotente.
- Un saldo que se había aplicado a esa reserva (método `CREDIT`) también
  vuelve como `EXPIRATION`: el dinero da la vuelta completa.
- El aviso es `HOLD_EXPIRED_CREDIT`, una variante de `HOLD_EXPIRED` que dice
  dónde quedó el dinero; no es un aviso adicional.
- **Revivir toma el saldo de vuelta** (`REVIVAL`), para no devolver el mismo
  dinero dos veces; si el cliente ya lo gastó o se le devolvió →
  `CREDIT_INSUFFICIENT` y el personal ajusta con un `ADJUSTMENT`.
- Un pago tardío por webhook sobre una `EXPIRED` queda como estaba: sin saldo
  automático (fuera de alcance). **Cuidado operativo:** si se va a revivir la reserva, no se ajusta el
  saldo (el dinero contaría doble); se cobra o se revive sobre ella. Si no se
  va a revivir y hay que devolver el dinero, la secuencia es un `ADJUSTMENT`
  positivo por el monto del pago tardío y luego un `REFUND` por el mismo monto
  (un `REFUND` directo da `CREDIT_INSUFFICIENT` porque ese pago nunca llegó al
  saldo), y la reserva ya no se revive. Ver la advertencia en `payments.md`,
  «Caso límite: pago confirmado de una reserva ya expirada».

La invariante que comprueban las pruebas: para cada reserva, el saldo que dejó
en el cliente más su `paid_cents` si está viva es exactamente lo pagado.
Reglas en `payments.md` («Lo pagado de un apartado vencido») y
`reservations.md`; diagramas en `customer-credit.md` y `payment-flow.md`.

---

## Casos inertes conocidos

### 17. Reenviar una invitación mientras el cliente restablece su contraseña

`issueInvitationToken` (reenvío de la invitación) **no toma el bloqueo del
usuario** que sí toman `acceptInvitation` y `resetPassword`. No hay
interbloqueo posible: `password_resets.user_id` no tiene llave foránea, así que
insertar el token nuevo no necesita bloquear la fila del usuario.

Lo que sí puede pasar: si el reenvío corre justo después de que el
restablecimiento consumió las invitaciones pendientes, queda una invitación
viva en una cuenta que ya tiene contraseña. **Es inerte**: `acceptInvitation`
la rechaza con `TOKEN_INVALID` porque la escritura es condicional a «sin
contraseña» (`customers.md`, sección Invitación). Sólo deja una fila sin
consumir hasta que venza.

Se decidió no cerrarlo ahora. Si algún día estorba (por ejemplo, un reporte de
invitaciones pendientes), basta con que `sendCustomerInvitation` bloquee al
usuario y vuelva a comprobar que sigue sin contraseña dentro de su transacción.
