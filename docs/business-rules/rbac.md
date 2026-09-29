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

## Cómo añadir un permiso

1. Agregar la entrada a `libs/domain/rbac/src/lib/permissions.ts`.
2. Correr `pnpm db:seed` (es idempotente y sincroniza la tabla).
3. Usarlo en el Route Handler correspondiente vía `route({ permission: '…' })`.
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
