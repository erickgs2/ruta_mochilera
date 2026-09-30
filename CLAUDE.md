# Ruta Mochilera — Guía para agentes

## Idioma

**Todo el código se escribe en inglés**, sin excepción: nombres de variables,
funciones, clases, archivos, tablas, columnas, ramas, mensajes de commit y
comentarios. Únicamente `docs/**` se escribe en español.

## Reglas de negocio: documentación obligatoria

Toda tarea que **añada o modifique una regla de negocio en el backend** queda
**incompleta** hasta que el archivo correspondiente de `docs/business-rules/`
esté actualizado **en el mismo commit**.

| Si tocas… | Actualiza… |
|---|---|
| `libs/domain/trips/**` | `docs/business-rules/trips.md` y `docs/diagrams/trip-creation.md` |
| `libs/domain/costing/**` | `docs/business-rules/costing.md` y `docs/diagrams/trip-costing.md` |
| `libs/domain/reservations/**` | `docs/business-rules/reservations.md` y `docs/diagrams/trip-reservation.md` |
| `libs/domain/payments/**` | `docs/business-rules/payments.md` |
| `libs/domain/notifications/**` | `docs/business-rules/notifications.md` |
| `libs/domain/rbac/**` | `docs/business-rules/rbac.md` |

Los diagramas se escriben en **Mermaid dentro de archivos Markdown**, nunca como
imágenes: se versionan como texto y un diff muestra qué cambió en la regla.

`.github/workflows/docs-guard.yml` hace cumplir esta tabla en cada pull
request. Por diseño comprueba `libs/domain/<módulo>/src/**`, no
`libs/domain/<módulo>/**` como dice la tabla literalmente: se probó contra
las 40 commits de la Fase 1 y una comprobación sobre el directorio completo
daba un falso positivo en un commit que sólo tocaba `project.json`/
`tsconfig.typecheck.json` de varias librerías de dominio, sin lógica de
negocio. Si añades un archivo con reglas fuera de `src/` en algún módulo,
ten presente que el guard no lo ve.

## Arquitectura: la regla que no se rompe

`libs/domain` **no sabe que existe HTTP**. No importa nada de `next/*`, de
Angular ni de `@nx/*`. Recibe un cliente Prisma inyectado y devuelve `Result<T>`.

Un Route Handler hace cuatro cosas y nada más:
1. Autenticar
2. Verificar permiso
3. Validar la entrada con Zod
4. Llamar al servicio de dominio

Consecuencia buscada: registrar un pago desde el mostrador, desde un webhook de
Stripe o desde una importación CSV recorre el mismo código.

## Convenciones

- Dinero: `Int` en centavos MXN. Nunca `Float`.
- Fechas: `timestamptz` en UTC. Las reglas de calendario se evalúan en la zona
  horaria de `SystemSetting.organization.timezone`, nunca hardcodeada.
- Prisma: modelos en `PascalCase`, tablas y columnas en `snake_case` vía `@@map` / `@map`.
- Errores: el backend devuelve códigos estables (`TRIP_SOLD_OUT`, …).
  **Nunca** texto para mostrar a una persona; Angular lo traduce.
- Permisos: se verifican **siempre** en la API. Ocultar un botón en Angular es
  comodidad visual, nunca seguridad.

## Cliente API generado (Angular)

`apps/api/src/lib/openapi/registry.ts` deriva un documento OpenAPI de los
esquemas Zod de `@rm/contracts` (y de las formas de respuesta de dominio que
`@rm/contracts` aún no cubre). `libs/api-client/src/lib/schema.d.ts` se genera
a partir de ese documento con `pnpm api:types` y **nunca se edita a mano** — el
propio archivo lleva una cabecera que lo dice y `pnpm api:types` lo sobreescribe
por completo en cada corrida. Para cambiar esos tipos: cambia el esquema Zod (o
la forma modelada en `registry.ts`) y vuelve a correr `pnpm api:types`.
`libs/api-client/src/lib/api-client.ts` y `endpoints.ts` son el envoltorio
tipado sobre `HttpClient` que sí se edita a mano; no se genera un cliente
`fetch` completo porque eso saltaría los interceptores de Angular (refresh de
token, manejo central de errores).

## Comandos

```bash
pnpm nx run-many -t lint test build   # todo el workspace
pnpm nx test shared-utils             # una librería
pnpm db:migrate                       # aplicar migraciones
pnpm db:seed                          # sembrar permisos, rol y usuario inicial
```

### Postgres en esta máquina

- Dev y pruebas corren contra un **PostgreSQL 15 nativo** en `localhost:5432`, no en Docker.
- `DATABASE_URL=postgresql://rm:rm@localhost:5432/rm_dev`
- `TEST_DATABASE_URL=postgresql://rm:rm@localhost:5432/rm_test`
- El rol `rm` y ambas bases ya existen en esta máquina.
- `compose.dev.yml` y `compose.test.yml` ya existen como artefactos de despliegue para Raspberry Pi y EC2 y no se ejecutan en esta máquina; la Tarea 19 añade `compose.prod.yml` y los Dockerfiles.

## Spec y planes

- Diseño: `docs/superpowers/specs/2026-09-28-agencia-viajes-diseno.md`
- Planes: `docs/superpowers/plans/`
