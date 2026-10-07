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
| `libs/domain/payments/**` | `docs/business-rules/payments.md` y `docs/diagrams/payment-flow.md` |
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

### La verdad de un pago llega por webhook

Un pago sólo existe cuando Stripe lo confirma por el webhook
(`/api/v1/webhooks/stripe`), **nunca** porque la app del cliente diga que el
cobro salió bien. La app muestra «procesando» y espera; el webhook es el único
camino que mueve `paid_cents` y activa una reserva. Lo mismo vale para OXXO y
SPEI, que además tardan horas o días. Ver `docs/diagrams/payment-flow.md`.

### `apps/worker`: los trabajos en segundo plano

`expireHolds`, `warnExpiringHolds`, `reconcilePaidCents`, el envío de correos
(la bandeja de salida de avisos) y el de recibos en PDF (`SEND_RECEIPT`) corren
en `apps/worker`, un proceso aparte de
la API sobre pg-boss. Está separado a propósito: cada despliegue de Next.js
mata los procesos en curso, y un `expireHolds` a medias es justo el trabajo que
un reinicio no debe interrumpir. Cada job es una función pura del cliente de
base (`src/jobs/*.ts`) que se prueba sin levantar pg-boss; `main.ts` sólo
agenda. En producción es su propio servicio en `infra/compose/compose.prod.yml`.

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

## Las dos apps y dónde se sirven

| App | Ruta en producción | `baseHref` |
|---|---|---|
| `apps/client` (clientes, también empaquetada con Capacitor) | `/app/` — la raíz `/` redirige aquí | `/app/` |
| `apps/admin` (panel del personal) | `/admin/` | `/admin/` |

Las dos las sirve el mismo Nginx (`infra/nginx/nginx.conf.template`,
`infra/docker/Dockerfile.web`). El `baseHref` se fija en la configuración
`production` de cada `project.json`; el build de Capacitor usa su propia
configuración y queda en `/`. Por eso **ninguna ruta de assets puede ser
absoluta** (`/assets/...`): siempre relativa, para que resuelva contra el
`base href` de cada app.

## Identidad visual

`docs/brand.md`. Colores, tipografía y radios salen de los tokens de
`libs/ui/src/styles/_brand.scss` (`--rm-*`) o de los tokens de sistema de
Material (`--mat-sys-*`); nunca un color escrito a mano en un componente.

## Comandos

```bash
pnpm nx run-many -t lint test build   # todo el workspace
pnpm nx test shared-utils             # una librería
pnpm db:migrate                       # aplicar migraciones
pnpm db:seed                          # sembrar permisos, rol y usuario inicial
pnpm db:seed:demo                     # las 7 rutas de los carteles, para desarrollo
pnpm nx e2e client-e2e                # extremo a extremo (base rm_e2e, puertos 3100/4300)
```

### Postgres en esta máquina

- Dev y pruebas corren contra un **PostgreSQL 15 nativo** en `localhost:5432`, no en Docker.
- `DATABASE_URL=postgresql://rm:rm@localhost:5432/rm_dev`
- `TEST_DATABASE_URL=postgresql://rm:rm@localhost:5432/rm_test`
- `E2E_DATABASE_URL=postgresql://rm:rm@localhost:5432/rm_e2e` (por omisión en `apps/client-e2e`)
- El rol `rm` y ambas bases ya existen en esta máquina.
- `compose.dev.yml`, `compose.test.yml` y `compose.prod.yml` (`infra/compose/`) son artefactos de despliegue para Raspberry Pi y EC2 y no se ejecutan en esta máquina.

## Spec y planes

- Diseño: `docs/superpowers/specs/2026-09-28-agencia-viajes-diseno.md`
- Planes: `docs/superpowers/plans/`
