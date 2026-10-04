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

## La frontera transaccional: las filas sí, el envío no

`notifyCustomer(tx, email, input)` y `notifyAdmins(tx, email, input)` reciben
el `DbTransactionClient` del llamador y escriben ambas filas (`EMAIL` e
`INBOX`) a través de él. Esto es deliberado: un aviso de "pago confirmado"
no debe sobrevivir si la transacción que confirmó ese pago se revierte por
cualquier motivo posterior. La prueba de este comportamiento
(`delivery-service.spec.ts`, "rolls back both delivery rows when the caller
rolls back the enclosing transaction") abre una transacción, llama a
`notifyCustomer` dentro de ella, fuerza un `throw` después, y comprueba que
no sobrevive ninguna fila.

El envío real por correo (`EmailProvider.send`), en cambio, es un efecto
externo irreversible: una vez que sale, ninguna reversión de Postgres lo
deshace. Por eso la recomendación de la Fase 2A es enviar **después de
confirmar** el hecho que origina el aviso, nunca antes — enviar dentro de
una transacción que todavía puede deshacerse significa poder avisar de algo
que nunca llegó a ser cierto.

**Contrato para quien llame a `notifyCustomer`/`notifyAdmins`:** la función
hace las dos cosas (escribir las filas y disparar el envío) en una sola
llamada, porque la firma de la Tarea 7 así lo pide y porque el fallo del
envío debe quedar grabado en la misma fila que lo intentó. La disciplina que
le corresponde al llamador es **invocarla como la última operación de su
transacción** — después de que todo lo demás que podría fallar ya se
escribió sin error. Hecho así, para el momento en que el correo sale, nada
que quede en esa transacción puede todavía forzar una reversión. Esta base
de código no tiene (todavía) una cola de salida (*outbox*) que desacople el
envío de la transacción a nivel de infraestructura; esa disciplina de
llamador es la garantía real disponible hoy, y queda documentada aquí para
que la Fase 2B no la pierda de vista si se añade ese tipo de cola más
adelante.

## Un fallo de envío no debe perder la copia de bandeja

Si `EmailProvider.send` falla (dirección mal formada, proveedor caído), la
fila `EMAIL` se marca `FAILED` con su error, la fila `INBOX` se queda
`SENT`, y la función **no lanza**. El cliente sigue viendo el aviso en la
app aunque el correo nunca haya salido. Esto es intencional: la bandeja es
la fuente de verdad para el cliente; el correo es un refuerzo que puede
fallar sin que el cliente se quede sin aviso.

## `notifyAdmins`: tres avisos sin cliente al que ir

Tres avisos de esta fase no tienen un cliente al que notificar porque son
sobre algo que el personal debe resolver, no el viajero:

- la solicitud de cancelación (regla 5.6),
- el pago huérfano de OXXO (regla 5.3),
- la desviación de `paid_cents` que encuentra la conciliación nocturna.

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
