# Clientes en mostrador

Fase 2B, regla 5.1 de la spec (`docs/superpowers/specs/2026-10-07-fase-2b-mostrador-diseno.md`).
Código: `libs/domain/customers` (búsqueda, alta, invitación) y
`libs/domain/identity/src/lib/invitation.ts` (token y aceptación).
Diagrama: `docs/diagrams/counter-sale.md`.

## Búsqueda

`searchCustomers` (`GET /admin/customers?search=&page=&pageSize=`, permiso
`customer.view`).

- Busca por **nombre**, **correo** o **teléfono**, sin distinguir mayúsculas
  ni acentos: «maria» encuentra «María», «NÚÑ» encuentra «Núñez».
- El acento se quita igual de los dos lados: la consulta con
  `normalize('NFD')` en el código y la columna con `translate()` en SQL. No
  usa la extensión `unaccent`, así que no hay nada que instalar en la base.
- El teléfono compara **sólo dígitos** (con al menos 3 en la consulta):
  «333-555» encuentra «(333) 555-1234».
- `%` y `_` de la consulta son texto, no comodines.
- Sólo usuarios `CUSTOMER`: el personal nunca aparece.
- Paginada (20 por omisión, 50 como máximo). Sin consulta, todos los
  clientes, los más recientes primero; con consulta, por nombre.

## Detalle

`getCustomerForStaff` (`GET /admin/customers/{id}`, permiso `customer.view`):
los datos del cliente (incluidos fecha de nacimiento, idioma, correo
verificado y términos aceptados) y **todas sus reservas**, las más recientes
primero, con el nombre del viaje en español (o el primero disponible). Un id que
no es UUID, que no existe o que es de un trabajador responde `NOT_FOUND`.

## Alta en mostrador

`createBranchCustomer` (`POST /admin/customers`, permiso `customer.manage`):
nombre completo, correo, teléfono, fecha de nacimiento (una fecha real, no
futura en la zona de la organización y no anterior a 1900-01-01; si no,
`VALIDATION_FAILED` con `field: birthDate`; ver «Fecha de nacimiento» más abajo)
e idioma opcional.

- **Validación de la entrada.** El esquema de `@rm/contracts` exige nombre de
  3 a 120 caracteres, correo válido, teléfono de 7 a 30 caracteres y
  `birthDate` como fecha real `YYYY-MM-DD`; el dominio rechaza además una fecha
  de nacimiento futura o anterior a 1900-01-01 con `VALIDATION_FAILED`
  (`field: birthDate`), como la importación (`imports.md`). El nombre y el
  teléfono se guardan sin espacios sobrantes.
- El **correo se recorta y se pasa a minúsculas** antes de guardarse, y la
  búsqueda de duplicados no distingue mayúsculas: «Maria@X.com» y «maria@x.com»
  son el mismo correo.
- Crea un `CUSTOMER` con el correo **ya verificado** (lo verificó el
  trabajador en persona), **sin contraseña**, `origin = BRANCH` y términos sin
  aceptar. Se audita `customer.created` con el actor. `invited_at` se llena sólo
  si el alta envía invitación.
- **Correo ya registrado**: no se duplica. Si es de un cliente,
  `CUSTOMER_ALREADY_EXISTS` (409) con `details.customerId` para que el panel
  abra a ese cliente; si es de un trabajador, `EMAIL_ALREADY_REGISTERED`. Dos
  altas simultáneas del mismo correo terminan igual: la segunda choca con el
  índice único y responde `CUSTOMER_ALREADY_EXISTS`.
- **Invitación**: se envía salvo que el trabajador la desmarque
  (`sendInvitation: false`). El correo sale **después del commit**; si el
  proveedor falla, el cliente queda dado de alta y la respuesta dice
  `invitationSent: false` para que el trabajador la reenvíe.

## Fecha de nacimiento: la misma regla en las tres altas

Un cliente nace por tres caminos —el autorregistro (`POST /auth/register`,
`registerCustomer` en `libs/domain/identity`), el mostrador y la importación
CSV— y los tres validan la fecha de nacimiento **en el servidor** con el mismo
ayudante, `isValidBirthDate` (`@rm/shared-utils`), y con «hoy» tomado de la
zona `SystemSetting.organization.timezone`, nunca de UTC ni del dispositivo.

**La regla: una fecha real `YYYY-MM-DD`, no futura y no anterior a
1900-01-01** (el 1900-01-01 y el día de hoy sí valen).

- Autorregistro y mostrador: si no se cumple, `VALIDATION_FAILED` con
  `field: birthDate`.
- Importación: la fila queda `INVALID` con `INVALID_DATE` en `birth_date`; no
  aborta el lote (`imports.md`).
- La app de clientes (`auth-validators.ts`) comprueba lo mismo, pero eso es
  comodidad: la regla vive en el servidor.
- En el autorregistro la fecha se rechaza **antes** de buscar el correo, así
  que el error no revela si el correo ya tenía cuenta, y no escribe nada ni
  envía correo.

## Invitación

- Liga de un solo uso a `/app/invitation?token=…`. Reutiliza
  `password_resets` con `purpose = INVITATION`; sólo se guarda el hash
  SHA-256 del token.
- Vive `invitation.ttl_days` días (7 por omisión), más que un restablecimiento
  (60 minutos): el cliente puede no abrir su correo el mismo día.
- **Cada envío invalida la anterior** (`issueInvitationToken` marca como
  consumidas las pendientes). Reenviar: `POST /admin/customers/{id}/invitation`
  (`customer.manage`), que actualiza `invited_at` y se audita como
  `customer.invited`:
  - un cliente que ya tiene contraseña responde `CONFLICT` — no hay nada que
    activar, que use «olvidé mi contraseña»;
  - un id desconocido, que no es UUID o que es de un trabajador responde
    `NOT_FOUND`;
  - si el proveedor de correo falla responde `EMAIL_PROVIDER_ERROR` (502). El
    token nuevo **ya quedó guardado** (y el anterior invalidado), así que
    volver a intentar es seguro.
- El token en claro **no pasa por la bandeja de salida de pg-boss**, que
  guarda su contenido en la base: el correo se envía directo tras el commit,
  igual que el de restablecer contraseña.
- **Aceptar** (`POST /auth/invitation/accept`, público: el token es la
  credencial) exige una contraseña de **10 a 128 caracteres** y
  `acceptTerms: true` (aceptar la invitación es aceptar los términos). Fija la
  contraseña, sella `activated_at` y `accepted_terms_at`
  y consume el token, en una transacción, con una escritura condicional para
  que dos envíos del mismo formulario no ganen ambos.
- Un token desconocido, usado, vencido **o de restablecimiento** es
  `TOKEN_INVALID`; y un token de invitación tampoco sirve para restablecer
  contraseña. Los dos propósitos no se cruzan.
- Una invitación **nunca sobrescribe una contraseña**: si la cuenta ya tiene
  una (por ejemplo, el cliente usó «olvidé mi contraseña» después de recibir
  la invitación), aceptarla es `TOKEN_INVALID` (y el token queda consumido). La escritura es condicional a
  «sin contraseña» dentro de la transacción, así que también cubre un
  restablecimiento simultáneo. A su vez, restablecer la contraseña consume las
  invitaciones pendientes de esa cuenta. La garantía «una invitación viva
  nunca pisa la contraseña de una cuenta que ya tiene una» está cubierta por
  prueba (`customer-service.spec.ts`), incluso con la invitación vigente y sin
  consumir.
- Un token de restablecimiento se consume con una escritura condicional: dos
  usos simultáneos del mismo token no ganan ambos.
- **Aceptar la invitación y restablecer la contraseña a la vez no falla.** Las
  dos operaciones bloquean primero la fila del usuario y después los tokens
  (un solo orden de bloqueos, sin interbloqueo); si aun así la base reporta
  un conflicto de escritura (P2034), la respuesta es `TOKEN_INVALID`, nunca un
  500. Gana siempre quien tiene el token de restablecimiento: si la invitación
  corrió primero, el restablecimiento fija su contraseña encima; si corrió
  después, la invitación es `TOKEN_INVALID` y no toca nada.
- Un cliente de mostrador que fija su contraseña con «olvidé mi contraseña»
  **queda activado** (`activated_at` se sella si estaba vacío, en la misma
  transacción); no se sella `accepted_terms_at`, porque no aceptó términos.

## Clientes importados

`createImportedCustomer` es la misma alta con `origin = IMPORT`, para la
importación CSV (`imports.md`): un correo que ya es de un cliente no es error
sino `EXISTS` con su id, y la invitación sólo sale si el lote lo pide. Un correo
que es de un trabajador no se registra: la fila falla con el código del dominio
(`EMAIL_ALREADY_REGISTERED`; en la vista previa se anticipa como `EMAIL_TAKEN`).

Ojo con las diferencias de validación: la importación sólo exige un nombre no
vacío y un teléfono con **al menos 7 dígitos**, mientras que el mostrador exige
3 a 120 caracteres de nombre y 7 a 30 **caracteres** de teléfono.

## Un cliente sin activar sigue siendo cliente

Un cliente que nunca activa su cuenta sigue recibiendo recibos y avisos por
correo, y el mostrador sigue cobrándole. Activar sólo le da acceso a la app.
