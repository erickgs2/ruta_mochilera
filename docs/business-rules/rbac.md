# RBAC

## Modelo

- `Permission` es un **catálogo sembrado en migración y no editable desde la UI**:
  sus claves son las que el código verifica, así que inventarlas en runtime
  crearía permisos sin efecto. La fuente de verdad es
  `libs/domain/rbac/src/lib/permissions.ts`, y el seed sincroniza la tabla con
  ese arreglo en cada ejecución.
- `Role` sí es editable: nombre, descripción y conjunto de permisos.
- Un rol con `is_system = true` (hoy sólo `Super Admin`) no se puede eliminar ni
  renombrar, y siempre tiene todos los permisos.
- Los clientes (`User.type = CUSTOMER`) **no tienen roles**: su tipo implica sus
  permisos, y las rutas de cliente nunca consultan la tabla de permisos.

## Verificación de permisos en `route()`

`apps/api/src/lib/http/route.ts` ofrece dos formas de exigir permiso en una
ruta, ambas evaluadas -- antes de que el handler se ejecute -- por las
funciones homónimas en `libs/domain/rbac/src/lib/access.ts`:

- `permission: 'clave'` (→ `requirePermission`) — la forma que usa casi todo
  el catálogo de endpoints: el actor debe sostener exactamente esa clave.
- `anyPermission: ['clave1', 'clave2', …]` (→ `requireAnyPermission`) — el
  actor debe sostener **al menos una** de las claves listadas. Existe para
  una ruta cuya verificación exacta no puede resolverse con un solo permiso
  porque depende de datos de la propia solicitud — por ejemplo, a qué estado
  se está transicionando un viaje. En ese caso la ruta sólo responde "¿tiene
  algún motivo legítimo para llegar aquí?"; es el servicio de dominio al que
  delega quien decide con precisión cuál de los permisos listados hacía
  falta para *esta* solicitud en particular. `PUT
  /api/v1/trips/{tripId}/status` es el primer uso —
  `anyPermission: ['trip.publish', 'trip.cancel']`, con `changeTripStatus`
  exigiendo el que corresponda según el estado destino — ver
  `docs/business-rules/trips.md`.

Los dos campos son independientes, no una unión discriminada: nada impide
declarar ambos a la vez (se exigirían los dos), aunque ningún endpoint lo
necesita hoy — se eligió así en vez de una forma única
`permission: PermissionKey | PermissionKey[]` porque un arreglo ahí sería
ambiguo entre "todos" y "cualquiera", y habría cambiado la forma del campo
para los ~20 endpoints que ya usan `permission` con una sola clave.

Ambas formas respetan la misma separación 401/403 que el resto de `route()`:
identidad primero, así que un token ausente o inválido siempre es
`401 TOKEN_INVALID`, evaluado antes que cualquiera de las dos verificaciones
de permiso; sólo un actor ya identificado que no sostiene lo requerido
recibe `403 PERMISSION_DENIED`.

Una ruta pública (`auth: 'public'`) no puede declarar ninguna de las dos: no
hay actor contra el cual verificar un permiso, y `PublicRouteOptions` no
declara ninguno de los dos campos — declararlos en una ruta pública falla en
tiempo de compilación (`route.spec.ts` tiene una prueba `@ts-expect-error`
por cada una), no en producción.

## Sesiones

`RefreshToken.session_id` agrupa toda la cadena de tokens de una misma sesión.
Al detectar el reuso de un token ya rotado, se revocan **todos** los tokens con
ese `session_id`, no sólo el presentado. Ver `docs/business-rules/` y la
implementación en `libs/domain/identity`.

## Catálogo de permisos

Fuente: `libs/domain/rbac/src/lib/permissions.ts` (29 permisos). El seed
(`pnpm db:seed`) sincroniza la tabla `permissions` con este arreglo en cada
ejecución y otorga el catálogo completo al rol `Super Admin`.

| Clave | Categoría | Qué habilita |
| --- | --- | --- |
| `role.view` | rbac | View roles and the permission catalog |
| `role.manage` | rbac | Create, edit and delete roles |
| `staff.view` | staff | View administrator accounts |
| `staff.manage` | staff | Create, edit and disable administrator accounts |
| `trip.view` | trips | View trips and their details |
| `trip.create` | trips | Create trips |
| `trip.update` | trips | Edit trip details, translations and images |
| `trip.publish` | trips | Publish a trip and change its status |
| `trip.cancel` | trips | Cancel a trip |
| `trip.change_price` | trips | Change the price of a trip that already has reservations |
| `trip.budget.view` | costing | View the trip budget and computed sale price |
| `trip.budget.manage` | costing | Add, edit and delete budget items and margin settings |
| `customer.view` | customers | Search and view customer records |
| `customer.manage` | customers | Create and edit customer records, send invitations |
| `reservation.view` | reservations | View reservations and balances |
| `reservation.create` | reservations | Create reservations on behalf of a customer |
| `reservation.cancel` | reservations | Cancel a reservation and release its seat |
| `reservation.risk.view` | reservations | Receive collection-risk alerts |
| `payment.view` | payments | View payments and receipts |
| `payment.register` | payments | Register cash payments taken at the branch |
| `payment.credit.apply` | payments | Apply or write off a customer credit balance |
| `notification.view` | notifications | View notification campaigns |
| `notification.manage` | notifications | Create, schedule and cancel notification campaigns |
| `expense.view` | expenses | View recorded expenses |
| `expense.manage` | expenses | Record and edit expenses |
| `report.view` | reports | View and export financial reports |
| `data.backfill` | operations | Capture historical trips, reservations and payments with past dates |
| `import.manage` | operations | Upload and confirm CSV imports |
| `settings.manage` | operations | Change system settings |

### Permisos que además deciden a quién llega un aviso

Algunos permisos no sólo protegen una ruta: `notifyAdmins`
(`docs/business-rules/notifications.md`) los usa para elegir a los
destinatarios de los avisos del personal, al enviar y a partir de los roles
de ese momento. `reservation.cancel` recibe la solicitud de cancelación;
`payment.view` y `payment.credit.apply` (cualquiera de los dos) reciben los
avisos de dinero —pago huérfano y desviación de `paid_cents`—; y
`reservation.risk.view` está reservado a las alertas de riesgo de cobro. Quien
quite uno de estos permisos a un rol también lo saca de esa audiencia.

## Roles editables

`libs/domain/rbac/src/lib/role-service.ts` expone `listRoles`, `createRole`,
`updateRole` y `deleteRole`. Reglas:

- **Nombre único**: crear o renombrar a un nombre ya usado por otro rol
  devuelve `CONFLICT`.
- **Claves de permiso validadas contra el catálogo**: cualquier clave que no
  exista en `permissions` (por ejemplo, un typo) devuelve `VALIDATION_FAILED`
  con `details.unknownPermissions`, la lista de las claves no reconocidas. No
  se crea nada a medias.
- **El conjunto de permisos se reemplaza entero en cada `updateRole`**, nunca
  se combina con el anterior: la UI del editor de roles (Tarea 17) siempre
  envía el estado final completo, no un diff.
- **Un rol con `isSystem = true` es inmutable**: `updateRole` y `deleteRole`
  devuelven `SYSTEM_ROLE_IMMUTABLE` antes de tocar cualquier dato, sin
  excepción de orden (la comprobación de `isSystem` ocurre antes que
  cualquier otra, incluida la de usuarios asignados).
- **Un rol con usuarios asignados no se puede eliminar**: `deleteRole`
  devuelve `ROLE_IN_USE` con `details.userCount`. Hay que reasignar a esos
  usuarios a otro rol primero. Esta regla **no depende únicamente de la
  comprobación previa en `deleteRole`**: la llave foránea
  `user_roles.role_id` está declarada `ON DELETE RESTRICT` (no `CASCADE`) en
  el esquema, así que Postgres rechaza el `DELETE` aunque un `UserRole` se
  inserte justo entre la lectura del conteo y el borrado — una asignación
  concurrente ya no puede colarse y desaparecer en cascada sin dejar rastro
  de auditoría. `role_permissions` sigue en `CASCADE` a propósito: borrar un
  rol sí debe borrar sus propios vínculos de permiso.
- **Un nombre de rol duplicado también se resuelve en dos capas**: la
  comprobación previa (`findUnique`/`findFirst`) responde rápido en el caso
  normal, y el índice único `roles_name_key` es el respaldo para la carrera
  en la que dos creaciones (o ediciones) concurrentes pasan la comprobación
  antes de que cualquiera haya insertado; `createRole` y `updateRole`
  capturan esa violación y devuelven el mismo `CONFLICT` en vez de dejar
  escapar un error de Prisma sin manejar.
- **Cada mutación (creación, edición, borrado) escribe una entrada de
  auditoría** (`role.created`, `role.updated`, `role.deleted`) dentro de la
  misma transacción que la escribe: ver la sección "Auditoría" más abajo para
  el porqué.

### Endpoints

| Método | Ruta | Permiso |
| --- | --- | --- |
| `GET` | `/api/v1/rbac/permissions` | `role.view` |
| `GET` | `/api/v1/rbac/roles` | `role.view` |
| `POST` | `/api/v1/rbac/roles` | `role.manage` |
| `PUT` | `/api/v1/rbac/roles/:roleId` | `role.manage` |
| `DELETE` | `/api/v1/rbac/roles/:roleId` | `role.manage` |

## Auditoría

`recordAudit(db, input)` (`@rm/domain-audit`) inserta una fila inmutable en
`audit_logs`. Se llama **siempre dentro de la misma transacción** que la
mutación que registra, para que el rastro de auditoría nunca pueda quedar en
desacuerdo con los datos: si la transacción se revierte, la entrada de
auditoría se revierte con ella.

`actor_user_id` es una columna suelta **sin llave foránea a propósito**: un
usuario eliminado no debe borrar ni invalidar su propio rastro de auditoría.
La columna sigue siendo `UUID` (como cualquier `User.id`), así que un actor
de sistema sin usuario real (por ejemplo, un job programado) debe omitir
`actorUserId` en vez de inventar un valor no válido.

## Cómo añadir un permiso

1. Agregar la entrada a `libs/domain/rbac/src/lib/permissions.ts`.
2. Correr `pnpm db:seed` (es idempotente y sincroniza la tabla).
3. Usarlo en el Route Handler correspondiente vía `route({ permission: '…' })` — o `route({ anyPermission: ['…', '…'] })` si la ruta debe aceptar más de un permiso y es el dominio quien decide cuál hacía falta para la solicitud (ver "Verificación de permisos en `route()`" arriba).
4. Documentarlo en la tabla de arriba **en el mismo commit**.

## Reglas de sesión

- **Login**: correo insensible a mayúsculas. Usuario inexistente y contraseña
  equivocada devuelven **el mismo** código `INVALID_CREDENTIALS`; distinguirlos
  revelaría qué correos están registrados. Un correo inexistente también
  verifica contra un hash argon2 fijo antes de responder, para que ambos casos
  tarden lo mismo: sin eso, la diferencia de tiempo (un fallo de argon2 real
  tarda decenas de milisegundos; un correo inexistente respondería en menos de
  uno) sería un canal por el que un atacante podría distinguirlos igualmente,
  aunque el código de error sea idéntico.
- Una cuenta con `status = DISABLED` no inicia sesión, aunque la contraseña sea
  correcta (`ACCOUNT_DISABLED`). Tampoco puede refrescar una sesión ya
  existente: `refreshSession` vuelve a comprobar el estado de la cuenta en cada
  llamada, así que deshabilitar a alguien corta sus sesiones vivas en cuanto
  intente rotar su token, no sólo en el siguiente intento de login.
- **Access token**: 15 minutos por defecto (`ACCESS_TOKEN_TTL_SECONDS`), HS256,
  con `sid` = identificador de sesión.
- **Refresh token**: opaco, 32 bytes aleatorios. Se persiste **sólo su SHA-256**.
  Vigencia de 30 días por defecto (`REFRESH_TOKEN_TTL_DAYS`) **desde la última
  rotación, no desde el login**: cada refresh exitoso reinicia el contador. Es
  una ventana deslizante, no un límite absoluto de duración de la sesión — una
  sesión usada al menos una vez cada 30 días no expira nunca por sí sola; sólo
  termina por logout o por detección de reuso.
- **Rotación**: cada refresh revoca el token usado y emite uno nuevo con el
  mismo `session_id`, dentro de una única transacción: revocar el viejo y crear
  el nuevo no pueden quedar separados por un fallo a la mitad. La revocación es
  condicional (`revokedAt IS NULL` en el `WHERE`), no incondicional por id: dos
  solicitudes concurrentes con el mismo token sólo dejan rotar a una; la otra
  se trata como reuso, incluida la revocación de todo lo demás en esa sesión.
- **Detección de reuso**: presentar un token ya revocado revoca **todos** los
  tokens vivos de esa sesión (agrupados por `session_id`, no sólo el token
  presentado) y devuelve `TOKEN_REUSED`. El usuario tendrá que iniciar sesión
  otra vez; es el comportamiento correcto ante un token filtrado. Esto también
  cubre el caso de dos rotaciones concurrentes con el mismo token: la que pierde
  la carrera revoca toda la sesión, incluido el token recién emitido por la que
  ganó, así que ese token devuelto nunca llega a ser utilizable.
- **Logout**: revoca la sesión completa (todos los tokens vivos de su
  `session_id`) y es idempotente: cerrar una sesión ya cerrada no es un error.
