# Entregas de aviso (correo + bandeja)

Implementado en `libs/domain/notifications`. Corresponde a la Tarea 7 de la
Fase 2A (`docs/superpowers/plans/2026-10-03-fase-2a-reservas-y-pagos.md`,
líneas 489-532).

## Dos filas por aviso, mismo texto

Cada notificación escribe **dos** filas de `NotificationDelivery`: una con
`channel = EMAIL` y otra con `channel = INBOX`, con el mismo `renderedTitle` y
el mismo `renderedBody`. Es lo que garantiza que la bandeja en la app muestre
exactamente lo que se envió por correo, incluso si el correo nunca llegó.

`NotificationDelivery` está anclado a `user_id`, no a `customer_id` — tres
avisos de esta fase van a personal, no a clientes (ver más abajo), y el
personal son filas `User` sin `CustomerProfile`.

## El texto se renderiza y se congela al enviar

`templates.ts` mapea cada `DeliveryEventType` y locale (`es`/`en`) a un
asunto y un cuerpo, interpolando los `params` que recibe la llamada. El
resultado se guarda tal cual en `rendered_title`/`rendered_body` en el
momento del envío. Cambiar el idioma del cliente después **no** reescribe el
historial: un aviso enviado en inglés se queda en inglés aunque el cliente
cambie su locale al día siguiente.

Estas plantillas viven en el dominio, **no** en los catálogos de i18n de
Angular (`libs/i18n/src/assets/*.json`): esos catálogos traducen texto que
Angular renderiza en el momento de mostrarlo; estas plantillas renderizan
texto que el servidor guarda permanentemente en el momento de enviarlo. Son
dos momentos distintos con una audiencia distinta cada uno.

## `eventType` es un `String`, no un enum de Postgres

La columna `notification_deliveries.event_type` es un `String` liso a
propósito (decisión de la Tarea 2: la Fase 3 añade tipos sin necesitar una
migración), así que PostgreSQL no puede rechazar un valor mal escrito. La
lista cerrada se aplica en la frontera del dominio en su lugar:

- `DeliveryEventType` es una unión de ocho literales — ningún código de
  llamada puede construir un `NotificationDelivery` con un valor fuera de
  esa unión, porque `notifyCustomer`/`notifyAdmins` sólo aceptan ese tipo.
- `TEMPLATES` en `templates.ts` está declarado `Record<DeliveryEventType, …>`
  exhaustivo: añadir un miembro a la unión sin añadir su plantilla es un
  error de compilación, no uno descubierto en producción. Es el mismo
  mecanismo que `STATUS_BY_CODE` usa para `DomainErrorCode`.

## La frontera transaccional: las filas y el encolado sí, el envío no (Ruling 11, Tarea 8)

`notifyCustomer(tx, queue, input)` y `notifyAdmins(tx, queue, input)` reciben
el `DbTransactionClient` del llamador y escriben ambas filas (`EMAIL` e
`INBOX`) a través de él, exactamente como en la Tarea 7. Esto es deliberado:
un aviso de "pago confirmado" no debe sobrevivir si la transacción que
confirmó ese pago se revierte por cualquier motivo posterior. La prueba de
este comportamiento (`delivery-service.spec.ts`, "rolls back both delivery
rows and the queued send when the caller rolls back the enclosing
transaction") abre una transacción, llama a `notifyCustomer` dentro de ella,
fuerza un `throw` después, y comprueba que no sobrevive ninguna fila **ni el
trabajo encolado** (ver más abajo).

Lo que cambió en la Tarea 8 es qué pasa con el envío real. La Tarea 7 dejó
escrito, en esta misma sección, que la única garantía disponible era
disciplina del llamador — "invocar `notifyCustomer` como la última operación
de la transacción" — porque esta base de código no tenía todavía una cola de
salida (*outbox*) que desacoplara el envío de la transacción a nivel de
infraestructura. La Tarea 8 trae pg-boss para los tres jobs de fondo, y
pg-boss vive en **esta misma base de PostgreSQL**, lo que por primera vez
hace posible la solución real: en vez de llamar a `EmailProvider.send`
dentro de la transacción, `notifyCustomer`/`notifyAdmins` **encolan** un
trabajo `send-notification-email` (`@rm/jobs`) a través de `tx`, usando el
adaptador `fromPrisma` de pg-boss:

```ts
await queue.send(SEND_NOTIFICATION_EMAIL_JOB, { deliveryId: emailRow.id }, { db: fromPrisma(tx) });
```

`fromPrisma(tx)` envuelve el propio `DbTransactionClient` como el `IDatabase`
que pg-boss necesita para ejecutar su `INSERT` en la tabla `job` — **la
misma transacción, la misma conexión** que las dos filas de arriba. Si `tx`
se revierte, el `INSERT` del trabajo se revierte con ella; no sobrevive ni
la fila ni la cola. `apps/worker` es quien realmente llama a
`EmailProvider.send`, en `deliverQueuedEmail(db, email, deliveryId)`, y lo
hace **después** de que esa transacción ya cerró — nunca puede avisar de
algo que todavía podía deshacerse, sin depender de que el llamador recuerde
nada.

El parámetro se llama `queue`, no `email`: ninguna de las dos funciones
necesita ya el puerto de correo, porque ninguna de las dos envía nada. El
plan original de la Tarea 8 no anticipó este cambio de firma; se documenta
aquí porque es exactamente la clase de decisión que esta sección pide no
perder de vista.

pg-boss corre en su propio esquema de PostgreSQL (`pgboss` en producción,
separado del `public` donde vive Prisma) — nunca el mismo esquema que las
tablas de dominio, por la misma razón que cada worker de prueba tiene el
suyo (ver `libs/jobs/src/testing/test-queue.ts`).

## El envío real: `deliverQueuedEmail`, en `apps/worker`

`deliverQueuedEmail(db, email, deliveryId)` es la mitad que faltaba: lee la
fila `EMAIL` por su id, envía usando su `rendered_title`/`rendered_body` ya
congelados, y la marca `SENT` o `FAILED`. La dirección del destinatario,
en cambio, **no** se congela — se lee de `User.email` en el momento del
envío, porque sólo el *texto* es historia permanente; a qué dirección llega
un recordatorio es lo que la cuenta tenga registrado ahora.

**La parte HTML del correo va escapada.** El texto congelado interpola valores
que escribió una persona —el motivo de una solicitud de cancelación, el nombre
del cliente— y esos correos llegan a las bandejas del personal. Sin escapar,
un motivo con `<a href=…>` se convertía en un enlace real dentro del correo
(lo encontró la revisión final de la rama). La parte de texto plano no se
escapa: no es HTML.

Es **idempotente**: pg-boss entrega sus trabajos *al menos* una vez, nunca
exactamente una, así que una fila que ya está `SENT` o `FAILED` se deja
intacta en vez de reenviarse. Lo prueba `delivery-service.spec.ts` ("is a
no-op the second time it runs..."), llamando a la función dos veces seguidas
con un proveedor que cuenta sus propias invocaciones.

## El recibo de pago usa la misma frontera, pero no es un aviso (Fase 2B)

El job `SEND_RECEIPT` sigue la Regla 11 al pie de la letra —se encola en la
transacción que confirma el pago y sólo el worker llama al proveedor—, pero
**no escribe filas en `notification_deliveries`**: el recibo no es un aviso
de la bandeja, es un documento que el cliente descarga desde su historial de
pagos. Su estado vive en el propio pago (`receipt_key`, `receipt_sent_at`).
El correo lleva el PDF **adjunto** (`EmailMessage.attachments`; Resend lo
recibe en base64 y el proveedor de consola sólo registra nombre y tamaño).
A diferencia de `deliverQueuedEmail`, un fallo del proveedor hace fallar el
job para que pg-boss lo reintente. Reglas completas en `payments.md`,
«Recibos en PDF».

## `PRICE_CHANGED` (Fase 2B)

Al llevar el precio vigente a reservas existentes (`reservations.md`), cada
cliente afectado recibe `PRICE_CHANGED` dentro de la misma transacción: el
**texto que escribió el administrador** primero (en inglés si el cliente usa
inglés y hay texto en inglés; si no, en español) y después sus propios
números — folio, total anterior, total nuevo y saldo pendiente. La frase del
saldo a favor sólo aparece cuando el cambio lo creó: una línea de «$0.00 a
favor» se leería como error. Es la primera plantilla que se arma con una
función propia en lugar de `template()`, por esa frase condicional.

## `HOLD_EXPIRED_CREDIT` (Fase 2B, decisión 16)

Variante de `HOLD_EXPIRED` para un apartado que **ya había recibido dinero**:
dice lo mismo —el apartado expiró y el lugar se liberó— y añade que lo pagado
(`{{amount}}`) quedó como saldo a favor en su cuenta, que la agencia puede
aplicar a una nueva reservación o devolver. `expireHolds` la envía en lugar de
`HOLD_EXPIRED` sólo cuando acreditó algo; un apartado sin pagos sigue
recibiendo `HOLD_EXPIRED`. No es un aviso adicional: es uno u otro, dentro de
la misma transacción.

## Un fallo de envío no debe perder la copia de bandeja

Si `EmailProvider.send` falla (dirección mal formada, proveedor caído), la
fila `EMAIL` se marca `FAILED` con su error, la fila `INBOX` se queda
`SENT`, y `deliverQueuedEmail` **no lanza**. El cliente sigue viendo el
aviso en la app aunque el correo nunca haya salido. Esto es intencional: la
bandeja es la fuente de verdad para el cliente; el correo es un refuerzo que
puede fallar sin que el cliente se quede sin aviso. Esta garantía es la
misma que la Tarea 7 dejó escrita aquí; sólo cambió de función.

## Dos tipos de aviso que añadió el webhook (Tarea 10)

`DeliveryEventType` creció con dos miembros, los dos para el cliente y los dos
por la regla 5.3:

- **`VOUCHER_EXPIRED`** — la ficha de OXXO llegó a su fecha límite sin pago.
  No es `PAYMENT_FAILED`: no se rechazó nada, se acabó el tiempo, y el "vuelve
  a intentarlo" de aquella plantilla diría algo falso sobre lo que pasó.
- **`PAYMENT_AFTER_EXPIRY`** — el dinero llegó después de que el apartado
  venciera. No es `PAYMENT_CONFIRMED`: esa plantilla cita el saldo restante y
  se leería como "sí vas" para alguien cuyo lugar ya se liberó.

En los dos casos la alternativa era reutilizar una plantilla existente
pasándole un `{{reason}}` distinto, y en los dos casos se descartó por lo
mismo: `{{reason}}` es **un solo** valor interpolado en la plantilla española
y en la inglesa, así que no puede estar bien escrito en las dos. Un motivo que
tiene que leerse como prosa necesita su propia plantilla por idioma. Donde sí
viaja por `{{reason}}` es el código de fallo del proveedor en
`PAYMENT_FAILED` (`card_declined`, por ejemplo): es un identificador estable,
no prosa, y es lo que una persona buscaría en el panel de Stripe.

## Avisos de la cancelación desde el panel (Tarea 19)

- **`RESERVATION_CANCELLED`** existía desde la Tarea 7 sin que nada lo
  emitiera. Ahora lo envía `cancelReservation` al cliente, con el nombre del
  viaje en su idioma y el motivo que escribió el personal (`{{reason}}`),
  dentro de la transacción que cancela. Cancelar dos veces no lo repite.
- **`PAYMENT_AFTER_CANCELLATION`** es nuevo (`DeliveryEventType` pasa a 11
  miembros): el dinero llegó por una reserva que el personal ya había
  cancelado. Es el gemelo de `PAYMENT_AFTER_EXPIRY` —mismo compromiso, el
  pago está registrado y una persona dará seguimiento, y tampoco cita saldo—
  pero con su propia plantilla, por la misma razón que esa sección explica:
  «tu apartado venció» sería falso aquí y un `{{reason}}` no puede estar bien
  escrito en los dos idiomas a la vez. El personal recibe además
  `ORPHAN_PAYMENT`, como en el caso del apartado vencido.

  **Fase 2B:** el dinero ya no queda pendiente de decisión: el webhook lo
  acredita como saldo a favor del cliente en la misma transacción, y el texto
  de `PAYMENT_AFTER_CANCELLATION` lo dice («quedó como saldo a favor en tu
  cuenta… puedes verlo en Mi cuenta»). Sigue sin citar saldo pendiente de la
  reserva. `PAYMENT_AFTER_EXPIRY` no cambia: el dinero de un apartado vencido
  sigue siendo decisión humana.

- **`CANCELLATION_DECLINED`** (`DeliveryEventType` pasa a 12): el personal
  rechazó la solicitud de cancelación del cliente. Le dice que su reservación
  sigue en pie y por qué (`{{reason}}`, escrito por el personal), dentro de la
  transacción que registra el rechazo. Rechazar dos veces no lo repite.

## `notifyAdmins`: tres avisos sin cliente al que ir

Tres avisos de esta fase no tienen un cliente al que notificar porque son
sobre algo que el personal debe resolver, no el viajero:

- la solicitud de cancelación (regla 5.6),
- el pago huérfano de OXXO (regla 5.3),
- la desviación de `paid_cents` que encuentra la conciliación nocturna.

A partir de la Tarea 10 el pago huérfano llega por dos caminos, los dos desde
el webhook de Stripe y los dos con la misma plantilla: un
`payment_intent.succeeded` de una reserva que ya estaba `EXPIRED`, y uno de un
intento que no trae reserva a la que atarse. En los dos casos hay dinero real
y no hay nada que el sistema pueda decidir solo.

`notifyAdmins` los envía a **todo usuario de personal vivo** (`status =
ACTIVE`) que tenga el permiso `reservation.cancel` — el mismo permiso que
protege cancelar una reservación, porque son exactamente las personas que
pueden actuar sobre lo que el aviso describe. Si ningún usuario de personal
tiene ese permiso en este momento, `notifyAdmins` no escribe nada y no
lanza: ausencia de destinatarios no es un error.

## La bandeja del cliente

`listInbox(db, customerId, { limit, cursor })` lista únicamente las filas
`channel = INBOX` del cliente, más recientes primero. La fila `EMAIL` de
cada par nunca aparece aquí — es el registro de lo que salió por correo, no
algo que mostrar dos veces.

La paginación usa un cursor opaco sobre `(created_at, id)`, no sólo
`created_at`: dos avisos escritos en el mismo milisegundo rompen un cursor
basado solo en la marca de tiempo (se repite o se salta una fila entre
páginas); el `id` como segundo criterio de orden deja cada página sin huecos
ni duplicados.

**Cada página trae `unreadCount` (Tarea 18):** el total de filas `INBOX` del
cliente con `read_at` nulo, contado sobre todas sus entregas y no sobre la
página devuelta. Es lo que muestra el contador de no leídas de la app; si se
contara sólo la página, el número dependería de cuánto se ha desplazado el
cliente y mentiría en cuanto hubiera más de una página. Las filas `EMAIL` y
las de otros clientes nunca cuentan. `markRead` lo baja en uno en la
siguiente lectura.

## La bandeja del personal: enlace a la reserva y «marcar todo»

La bandeja es la misma para clientes y personal: `listInbox` filtra por
`user_id = quien llama` y `channel = INBOX`, sin permiso de por medio. Dos
cosas para el panel del personal:

- **`reservationId` en cada ítem.** `InboxItemDto` y el contrato
  `inboxItemSchema` traen `reservationId` (nullable): la reserva de la que
  trata el aviso, para que el panel enlace a ella. Los tres avisos del personal
  (`CANCELLATION_REQUESTED`, `ORPHAN_PAYMENT`, `PAID_CENTS_MISMATCH`) lo llevan;
  es `null` cuando el aviso no trata de una sola reserva o cuando la reserva
  se borró (`ON DELETE SET NULL`). Aditivo: la app de clientes lo ignora. El tipo de aviso (`eventType`) sigue bastando
  para elegir la acción.
- **`markAllRead(db, userId)`** (`POST /notifications/read-all`, 204, sin
  permiso: sólo toca las filas de quien llama). Marca como leída
  (`status = READ`, `read_at = ahora`) cada fila `INBOX` suya con `read_at`
  nulo. **Nunca** toca las filas `EMAIL` —registran el envío, no la lectura—
  ni las de otra persona, y una fila ya leída conserva su `read_at` original.
  No tener nada sin leer no es un error, y repetirla tampoco. Después
  `unreadCount` es 0.

**Quién recibe las alertas del personal no cambia aquí:** `notifyAdmins` sigue
yendo a quien tiene `reservation.cancel` (ver arriba); ampliar los
destinatarios es una decisión aparte.

## `markRead` y `DELIVERY_NOT_OWNED`

`markRead(db, deliveryId, customerId)` marca una entrega de bandeja propia
como leída. Una entrega que no existe y una entrega que existe pero es de
otra persona devuelven el **mismo** código, `DELIVERY_NOT_OWNED` (HTTP 404) —
la misma razón que `RESERVATION_NOT_OWNED`: un 403 distinto confirmaría que
la entrega existe, y eso le permitiría a un cliente que recorre ids a mano
distinguir "no es tuya" de "no existe". `DELIVERY_NOT_OWNED` es un código
propio (no se reutiliza `RESERVATION_NOT_OWNED`) porque describe un recurso
distinto; está en las tres ubicaciones que exige el catálogo de errores:
`DomainErrorCode`, `STATUS_BY_CODE`, y ambos catálogos de i18n.

`markRead` sólo actúa sobre filas `channel = INBOX`: pedir que se marque
como leída la fila `EMAIL` de un par no tiene sentido en la interfaz, así
que esa fila también responde `DELIVERY_NOT_OWNED` aunque le pertenezca al
mismo cliente.

## `reservationId`: columna que la Tarea 8 añadió sin que el plan la anticipara

`NotificationDelivery.reservation_id` (nullable, `ON DELETE SET NULL`,
migración `notification_delivery_reservation_id`) no estaba en el plan
original. Apareció al construir `warnExpiringHolds` (Tarea 8,
`apps/worker`): ese job necesita saber "¿ya avisé de **esta** reservación
en particular?", y `(customer_id, event_type)` por sí solo es ambiguo en
cuanto un cliente tiene más de una reservación `HELD` a la vez — dos
apartados distintos del mismo cliente comparten `customer_id` y
`event_type`, y una consulta por esos dos campos no puede distinguir "ya
avisé de la reservación A" de "ya avisé de la reservación B". `(customer_id,
reservation_id, event_type)` sí es inequívoco, y el índice
`notification_deliveries_reservation_id_event_type_idx` es exactamente esa
consulta.

Nullable porque no todo aviso tiene una sola reservación de la que colgar:
`ORPHAN_PAYMENT`, por definición, no corresponde a ninguna reservación
activa. `SetNull` en vez de `Cascade` al borrar una reservación: el
historial de avisos de un cliente no debe desaparecer sólo porque la
reservación que lo originó sí lo hizo (un caso que hoy no ocurre en
producción -- nada borra una `Reservation` -- pero que `schema.spec.ts`
comprueba directamente contra la base, no sólo contra el código).
