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
