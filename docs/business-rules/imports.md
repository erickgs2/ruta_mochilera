# Importación CSV

Fase 2B, regla 5.8 de la spec. Código: `libs/domain/imports`. Permiso:
`import.manage`. El job que aplica vive en `apps/worker` (`APPLY_IMPORT`).

## Plantillas

Dos plantillas descargables desde el panel
(`GET /admin/imports/templates/{customers|payments}`): UTF-8 con BOM (para
que Excel abra bien los acentos), separadas por comas, con una fila de
encabezados **en inglés y estable** y una fila de ejemplo que valida sin
errores. El panel traduce los encabezados; el archivo no cambia.

| Plantilla | Columnas | Opcionales |
|---|---|---|
| Clientes | `full_name, email, phone, birth_date, locale` | `locale` (`es` por omisión) |
| Pagos | `customer_email, trip_slug, paid_at, amount, method, external_ref, notes` | `method` (`LEGACY` por omisión), `external_ref`, `notes` |

- Fechas `YYYY-MM-DD`, reales y no futuras (en la zona de la organización).
- `amount` en **pesos**: «1500», «1500.10», «1,500.10» o «$1,500.10». Se lee
  como texto, nunca como número flotante: «1500.10» son exactamente
  150 010 centavos.
- `method`: `CASH`, `LEGACY`, `CARD`, `OXXO` o `SPEI`.
- Las columnas pueden venir en cualquier orden; falta una obligatoria → el
  archivo entero se guarda `FAILED` con `MISSING_COLUMN`.
- **Lectura tolerante.** Los encabezados se comparan sin distinguir mayúsculas
  y sin espacios sobrantes; las columnas que no son de la plantilla se ignoran;
  las líneas en blanco no cuentan como filas. Se aceptan campos entre comillas
  dobles (con comas o saltos de línea dentro y `""` como comilla), saltos CRLF o
  LF y el BOM UTF-8 que escribe Excel al guardar «CSV UTF-8».
- **Errores de archivo.** Además de `MISSING_COLUMN` (con la columna que falta),
  un archivo vacío es `EMPTY_FILE` y uno con encabezados pero sin filas es
  `NO_ROWS`. Los tres guardan el lote como `FAILED` y no se pueden aplicar.

## Flujo

1. **Subir y validar** (`POST /admin/imports`): se valida fila por fila **sin
   escribir nada** salvo el lote (`ImportBatch` en `VALIDATED`, o `FAILED` si
   el archivo no sirve). Tope: **5,000 filas o 5 MB** → `IMPORT_TOO_LARGE`
   (413). Cada fila queda en el reporte con su número de línea (el
   encabezado es la 1, como en la hoja de cálculo) y su estado:
   - `VALID`;
   - `INVALID`, con **cada** error: columna y código;
   - `EXISTS`: ya está en el sistema (un correo de cliente, un `external_ref`
     de pago). **No es error.**
2. **Vista previa** en el panel con esos estados.
3. **Confirmar** (`POST /admin/imports/{id}/apply`): `VALIDATED → APPLYING`
   con una escritura condicional y el job encolado en la misma transacción.
   Confirmar dos veces → `IMPORT_ALREADY_APPLIED`; un archivo `FAILED` →
   `INVALID_STATUS_TRANSITION`.
4. **Aplicar** (worker): fila por fila; **una fila que falla no detiene a las
   demás**. Antes de aplicar cada fila se vuelve a validar con datos frescos:
   un cliente creado o un pago importado desde la vista previa se ve. El
   resultado de cada fila (`CREATED`, `EXISTS` o `FAILED` con el código del
   dominio) queda en `ImportBatch.report`; el lote termina `APPLIED`.

**Por qué en el worker.** 5,000 filas, cada una con su transacción y quizá
su correo, tardan minutos: más de lo que una petición HTTP aguanta detrás de
Nginx. El panel consulta el lote hasta que deja de estar `APPLYING`. El
progreso se guarda cada 100 filas.

**No se reintenta solo.** Una fila de pago sin `external_ref` no se distingue
de una segunda copia de sí misma: si el worker se cae a medias, el lote se
queda `APPLYING` con su reporte parcial para que una persona decida, en lugar
de arriesgar pagos duplicados. Por eso se recomienda llenar `external_ref`.

### Limitaciones conocidas

Ver `docs/decisiones-fase-2b.md`, «Pendientes». Se documentan tal como son hoy:

- **Un lote caído no tiene salida.** Aplicar un lote `APPLYING` responde
  `IMPORT_ALREADY_APPLIED` y no existe una acción para reanudarlo ni
  cancelarlo: «que una persona decida» todavía no tiene con qué. El lote queda
  `APPLYING` con su reporte parcial; las filas que ya tienen resultado no se
  vuelven a aplicar si el job llegara a correr de nuevo.
- **El job vence a la hora.** Se encola con `retryLimit: 0` y
  `expireInSeconds: 3600`. Un lote que tarde más de una hora (5,000 filas con
  invitaciones) puede ser dado por vencido por pg-boss y quedar también
  `APPLYING`, con el mismo problema.
- **Un pago fechado hoy, antes del mediodía, falla.** La validación acepta
  `paid_at` de hoy, pero el pago se fecha a mediodía de ese día; mientras ese
  mediodía no llega, `recordBackfilledPayments` lo rechaza por estar en el
  futuro y la fila queda `FAILED` con `VALIDATION_FAILED`. Una fecha de ayer o
  anterior no tiene el problema.

## Códigos por fila

| Código | Significado |
|---|---|
| `REQUIRED` | Falta un valor obligatorio |
| `INVALID_EMAIL` | No es un correo |
| `INVALID_DATE` | No es una fecha `YYYY-MM-DD` real, o es futura |
| `INVALID_AMOUNT` | No es un monto en pesos mayor a cero |
| `INVALID_PHONE` | Menos de 7 dígitos |
| `INVALID_LOCALE` | No es `es` ni `en` |
| `EMAIL_TAKEN` | El correo es de un trabajador |
| `UNKNOWN_CUSTOMER` | No hay cliente con ese correo (importa primero los clientes) |
| `UNKNOWN_TRIP` | No hay viaje con ese `trip_slug` |
| `TRIP_NOT_ALLOWED` | El viaje está en `DRAFT` o `CANCELLED` |
| `UNKNOWN_METHOD` | Método de pago desconocido |
| `DUPLICATE_IN_FILE` | El mismo correo o `external_ref` aparece antes en el archivo |

`DUPLICATE_IN_FILE` compara el correo **sin distinguir mayúsculas** y el
`external_ref` **distinguiéndolas** («A-1» y «a-1» son referencias distintas).
Se marca en cada aparición posterior a la primera, aunque la primera tenga
errores. Una fila de pago **sin** `external_ref` nunca se considera duplicada:
dos filas iguales sin referencia se importan las dos.

El panel traduce los códigos; el backend nunca envía texto para personas.

## Auditoría

Quedan en `AuditLog`: `import.validated` (al subir y validar; incluye el tipo,
el archivo, las filas y el estado), `import.apply_requested` (al confirmar) e
`import.applied` (al terminar, con las cuentas de filas buenas y fallidas). El
actor es quien subió o confirmó; el trabajo en el worker usa el actor que
confirmó.

## Clientes

Crea clientes `origin = IMPORT`, **correo verificado** y **sin contraseña**
(la misma alta que el mostrador, `customers.md`). Un correo que ya es de un
cliente no se duplica: la fila es `EXISTS` con el id de ese cliente.

Valida lo mismo que el mostrador en lo que importa: la fecha de nacimiento debe
ser real y **no futura** (`INVALID_DATE`, en la zona de la organización). *(El
mostrador adopta el mismo rechazo con la corrección de Delta; ver
`customers.md`.)* El teléfono pide al menos 7 **dígitos** y el nombre sólo que
no esté vacío.

**Una invitación que no se pudo enviar no hace fallar la fila.** Con
`sendEmails`, el cliente queda creado (`CREATED`) aunque el proveedor de correo
falle; el reporte no registra ese fallo, y el personal puede reenviar la
invitación desde el cliente.

## Pagos

Busca la reserva viva (`HELD` o `ACTIVE`) de ese cliente en ese viaje:

- si existe, el pago entra como **pago histórico** sobre ella
  (`payments.md`, «Pagos históricos»);
- si no, crea la **reserva histórica** (`reservations.md`, «Captura
  histórica») con el pago, fechada el día del pago (a mediodía; si esa hora
  aún no ha llegado hoy, con la hora actual para no quedar en el futuro). Su
  **total es el precio vigente del viaje**: la importación no puede fijar otro.
  Una reserva `CANCELLED` o `EXPIRED` del cliente en ese viaje no cuenta como
  viva, así que se crea una nueva.

El pago se fecha a mediodía de `paid_at` en la zona de la organización, para
que nunca caiga en el día (o el año) de al lado. **`external_ref` evita
importarlo dos veces**: es una columna única de `payments`; repetida en el
archivo es `DUPLICATE_IN_FILE`, ya importada es `EXISTS`, y si dos lotes
compiten, la base decide y la fila perdedora queda `EXISTS`. Un pago que
excede el saldo de su reserva falla con `PAYMENT_EXCEEDS_BALANCE`.

## Correos silenciados por omisión

Sin la casilla «enviar correos» (`sendEmails`), ni invitaciones a los
clientes nuevos ni recibos de los pagos. Con ella, los dos.
