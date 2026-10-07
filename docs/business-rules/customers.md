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

## Alta en mostrador

`createBranchCustomer` (`POST /admin/customers`, permiso `customer.manage`):
nombre completo, correo, teléfono, fecha de nacimiento (una fecha real que
no sea posterior a hoy en la zona de la organización; si lo es,
`VALIDATION_FAILED` con `field: birthDate`, la misma regla de la importación)
e idioma opcional.

- Crea un `CUSTOMER` con el correo **ya verificado** (lo verificó el
  trabajador en persona), **sin contraseña**, `origin = BRANCH` y términos sin
  aceptar. Se audita `customer.created` con el actor.
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
  (`customer.manage`); un cliente que ya tiene contraseña responde `CONFLICT`
  — no hay nada que activar, que use «olvidé mi contraseña».
- El token en claro **no pasa por la bandeja de salida de pg-boss**, que
  guarda su contenido en la base: el correo se envía directo tras el commit,
  igual que el de restablecer contraseña.
- **Aceptar** (`POST /auth/invitation/accept`, público: el token es la
  credencial): fija la contraseña, sella `activated_at` y `accepted_terms_at`
  y consume el token, en una transacción, con una escritura condicional para
  que dos envíos del mismo formulario no ganen ambos.
- Un token desconocido, usado, vencido **o de restablecimiento** es
  `TOKEN_INVALID`; y un token de invitación tampoco sirve para restablecer
  contraseña. Los dos propósitos no se cruzan.
- Una invitación **nunca sobrescribe una contraseña**: si la cuenta ya tiene
  una (por ejemplo, el cliente usó «olvidé mi contraseña» después de recibir
  la invitación), aceptarla es `TOKEN_INVALID`. La escritura es condicional a
  «sin contraseña» dentro de la transacción, así que también cubre un
  restablecimiento simultáneo. A su vez, restablecer la contraseña consume las
  invitaciones pendientes de esa cuenta.
- Un token de restablecimiento se consume con una escritura condicional: dos
  usos simultáneos del mismo token no ganan ambos.

## Clientes importados

`createImportedCustomer` es la misma alta con `origin = IMPORT`, para la
importación CSV (`imports.md`): un correo que ya es de un cliente no es error
sino `EXISTS` con su id, y la invitación sólo sale si el lote lo pide.

## Un cliente sin activar sigue siendo cliente

Un cliente que nunca activa su cuenta sigue recibiendo recibos y avisos por
correo, y el mostrador sigue cobrándole. Activar sólo le da acceso a la app.
