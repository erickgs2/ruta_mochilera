# Reglas de negocio

Cada archivo describe las reglas de un módulo del dominio en prosa, con los
valores y fórmulas exactos que implementa `libs/domain`.

| Archivo | Módulo | Código fuente |
|---|---|---|
| `trips.md` | Viajes: estados, cupo, publicación | `libs/domain/trips` |
| `costing.md` | Presupuesto, margen, precio por vacante | `libs/domain/costing` |
| `reservations.md` | Apartado, expiración, cambio de precio | `libs/domain/reservations` |
| `payments.md` | Métodos, recibos, saldo a favor, retroactivos | `libs/domain/payments` |
| `notifications.md` | Audiencias, variables, calendarización | `libs/domain/notifications` |
| `rbac.md` | Catálogo de permisos y roles | `libs/domain/rbac` |

## Convenciones

- Toda fórmula se escribe con los nombres de campo reales de la base de datos.
- Todo umbral configurable indica su clave en `SystemSetting`.
- Cuando una regla cambia, este archivo y su diagrama se actualizan **en el mismo
  commit** que el código. Ver `CLAUDE.md`.
