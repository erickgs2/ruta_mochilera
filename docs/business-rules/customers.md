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
nombre completo, correo, teléfono, fecha de nacimiento e idioma opcional.

- **Validación de la entrada** (esquema de `@rm/contracts`): nombre de 3 a 120
  caracteres, correo válido, teléfono de 7 a 30 caracteres, `birthDate` una
  fecha real `YYYY-MM-DD` **que no es futura**. El nombre y el teléfono se
  guardan sin espacios sobrantes. *(Nota: el rechazo de una fecha futura en el
  mostrador llega con la corrección de Delta; hoy el esquema sólo exige una fecha
  válida. La importación ya la rechaza, ver `imports.md`.)*
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
- **Una invitación no pisa una contraseña existente.** Aceptar una invitación
  se rechaza (`TOKEN_INVALID`) si la cuenta ya tiene contraseña, y restablecer la
  contraseña invalida las invitaciones pendientes. *(Nota: esta regla llega con
  la corrección de Delta; hoy `resetPassword` sólo consume su propio token y
  `acceptInvitation` no revisa si la cuenta ya tiene contraseña, así que una
  invitación vigente podría sustituirla.)*

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
