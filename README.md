# La Ruta Mochilera

Plataforma de La Ruta Mochilera, agencia de viajes en comunidad: panel
administrativo para operar viajes, presupuestos, roles y reservas; API que
expone esas operaciones; y la aplicación con la que los clientes ven las rutas,
apartan su lugar y pagan desde el teléfono.

- **Fase 1** — «Cimientos y panel administrativo»: autenticación, control de
  acceso por roles, ciclo de vida de un viaje, costeo y precio por vacante.
- **Fase 2A** — «Clientes, reservas y pagos»: registro de clientes con
  verificación por código, catálogo público, reservas con apartado y cupo
  bajo bloqueo, pagos con tarjeta y OXXO vía Stripe (SPEI en la API), avisos
  por correo y bandeja, y la atención de cancelaciones desde el panel.

La identidad visual (logo, colores, tipografía) está en `docs/brand.md`.

## Las aplicaciones

```mermaid
flowchart LR
    subgraph Navegador
        A["Panel administrativo<br/>Angular · apps/admin · /admin/"]
        C["App de clientes<br/>Angular + Capacitor · apps/client · /app/"]
    end
    A -- HTTPS/JSON --> B["API<br/>Next.js Route Handlers · apps/api"]
    C -- HTTPS/JSON --> B
    S["Stripe"] -- webhook --> B
    B --> D[(PostgreSQL)]
    B --> E[("Almacenamiento<br/>local o S3")]
    W["Worker<br/>pg-boss · apps/worker"] --> D
    W --> R["Resend<br/>correo"]
```

- **`apps/api`** — Next.js usado únicamente como backend HTTP (Route
  Handlers bajo `/api/v1/**`, sin páginas de cara al público). Contiene la
  única capa que conoce HTTP: autentica, verifica permisos, valida con Zod y
  llama a `libs/domain`.
- **`apps/admin`** — panel administrativo en Angular. Consume la API a
  través de un cliente tipado generado desde el propio contrato de la API
  (`libs/api-client`), nunca llama a Prisma ni decide permisos por su cuenta.
- **`apps/client`** — la app de los clientes, en Angular; la misma build se
  sirve en la web bajo `/app/` y se empaqueta con Capacitor para iOS y
  Android. La raíz del sitio redirige aquí (ver
  `infra/nginx/nginx.conf.template`).
- **`apps/worker`** — proceso aparte sobre pg-boss: vence apartados, avisa
  los que están por vencer, concilia `paid_cents` cada noche y envía los
  correos. Separado de la API para que un despliegue no corte un job a la
  mitad.

`libs/domain` contiene toda la lógica de negocio (viajes, costeo, RBAC,
identidad, personal, auditoría) y no importa nada de Next.js ni de Angular:
recibe un cliente de Prisma inyectado y devuelve `Result<T>`. Ver `CLAUDE.md`
para la arquitectura completa.

## Requisitos

- Node.js 24 (fijado en `.nvmrc`)
- pnpm (vía `corepack enable`)
- PostgreSQL 15 nativo para desarrollo (ver «Postgres en esta máquina» en
  `CLAUDE.md`). Los contenedores (`infra/compose/`) usan PostgreSQL 16; para
  desarrollo nativo instala 15, no 16.
- Docker, sólo para construir/ejecutar las imágenes de `infra/docker/` y para
  `compose.test.yml` si no se usa un PostgreSQL nativo

## Arranque en cinco comandos

```bash
pnpm install               # instala dependencias y genera el cliente Prisma
pnpm db:migrate             # aplica las migraciones a la base de datos de desarrollo
pnpm db:seed                # siembra el catálogo de permisos, un rol y un usuario inicial
pnpm nx dev api             # sirve la API en http://localhost:3000
pnpm nx serve admin         # sirve el panel en http://localhost:4200 (otra terminal)
pnpm nx serve client        # sirve la app de clientes en http://localhost:4201 (otra terminal)
```

`DATABASE_URL` y el resto de variables se leen de `.env` (ver `.env.example`).
En esta máquina, PostgreSQL corre nativo en `localhost:5432`; ver la sección
«Postgres en esta máquina» de `CLAUDE.md` para el detalle y para
`infra/compose/compose.dev.yml` / `compose.test.yml` como alternativa en
Docker.

### Requisitos externos de la Fase 2A

`.env.example` y `.env.prod.example` documentan las claves de Stripe y Resend
(`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PUBLISHABLE_KEY`,
`RESEND_API_KEY`, `RESEND_FROM_ADDRESS`) y los IDs de cliente OAuth de Google y
Apple (`GOOGLE_OAUTH_CLIENT_ID`, `APPLE_OAUTH_CLIENT_ID`). Ninguna de las
cuatro cuentas externas existe todavía en este entorno: las dos primeras
bloquean cobro real y entrega de correo (ver la tabla de «Requisitos externos
que bloquean tareas» en `docs/superpowers/plans/2026-10-03-fase-2a-reservas-y-pagos.md`).
Los dos IDs de OAuth se dejan **vacíos a propósito** — vacío significa
"proveedor desactivado", que es como el login social se degrada mientras esas
cuentas no estén listas; no son un marcador `CHANGE_ME` porque un valor vacío
es un estado válido en producción, no sólo un recordatorio de desarrollo.

## Scripts

| Comando | Qué hace |
|---|---|
| `pnpm db:generate` | Regenera el cliente de Prisma (`libs/db/src/generated`, ignorado por git) |
| `pnpm db:migrate` | Aplica migraciones nuevas a la base de desarrollo (`prisma migrate dev`) |
| `pnpm db:deploy` | Aplica migraciones ya existentes sin generar una nueva (para CI/producción) |
| `pnpm db:reset` | Reinicia la base de desarrollo desde cero |
| `pnpm db:seed` | Siembra permisos, un rol y un usuario administrador inicial |
| `pnpm db:seed:demo` | Las siete rutas de los carteles de la agencia, con portada (precios ilustrativos) |
| `pnpm api:types` | Regenera `libs/api-client/src/lib/schema.d.ts` desde el contrato Zod/OpenAPI de la API — nunca se edita a mano |
| `pnpm nx dev api` | Sirve la API en modo desarrollo |
| `pnpm nx serve admin` | Sirve el panel administrativo en modo desarrollo |
| `pnpm nx serve client` | Sirve la app de clientes en modo desarrollo |
| `pnpm nx serve worker` | Corre el worker de jobs en modo desarrollo |
| `pnpm nx run-many -t typecheck lint test build` | Verifica los 25 proyectos del workspace |
| `pnpm nx test <proyecto>` | Corre las pruebas de un solo proyecto (p. ej. `shared-utils`) |
| `pnpm nx e2e client-e2e` | Pruebas de extremo a extremo de la app de clientes (Playwright) contra la API y un PostgreSQL reales; ver abajo |

## Pruebas de extremo a extremo

`apps/client-e2e` recorre la app de clientes en un navegador real contra la
API y PostgreSQL reales: registrarse y verificar con el código, reservar con
anticipo y pagar hasta quedar `ACTIVE`; un apartado que vence y devuelve su
lugar; y dos clientes peleando el último lugar.

Cada corrida es determinista: usa su propia base (`rm_e2e`, que se vacía y se
siembra al empezar), sus propios puertos (API en 3100, app en 4300, para no
chocar con los servidores de desarrollo) y el proveedor de pagos falso. Los
pagos se confirman enviando el webhook firmado que mandaría Stripe, que es el
mismo camino de un pago real. Requiere la base creada una vez:

```bash
createdb -U rm rm_e2e        # o: psql -c 'create database rm_e2e owner rm'
pnpm nx e2e client-e2e
```

En CI corre en un job aparte (`e2e` en `.github/workflows/ci.yml`), con
PostgreSQL como servicio y Chromium en caché; la corrida completa tarda
alrededor de un minuto.

## Documentación

- Diseño de la Fase 1: `docs/superpowers/specs/2026-09-28-agencia-viajes-diseno.md`
- Diseño de la Fase 2A: `docs/superpowers/specs/2026-10-03-fase-2a-reservas-y-pagos-diseno.md`
- Planes de implementación: `docs/superpowers/plans/`
- Identidad visual: `docs/brand.md`
- Reglas de negocio: `docs/business-rules/`
- Diagramas de flujo: `docs/diagrams/`

## Reglas de negocio: documentación obligatoria

Toda tarea que añada o modifique una regla de negocio en el backend queda
**incompleta** hasta que el archivo correspondiente de
[`docs/business-rules/`](docs/business-rules/) esté actualizado **en el mismo
commit** — y, para viajes, costeo, reservas y pagos, también su diagrama en
[`docs/diagrams/`](docs/diagrams/). La tabla completa de qué módulo mapea a
qué archivo vive en `CLAUDE.md`. `.github/workflows/docs-guard.yml` hace
cumplir esta regla en cada pull request y señala exactamente qué archivo
falta.

## Despliegue

`infra/docker/Dockerfile.api`, `Dockerfile.worker` e `infra/docker/Dockerfile.web`
construyen, respectivamente, la API, el worker y las dos apps Angular servidas
por Nginx (el panel en `/admin/`, la app de clientes en `/app/`, y `/`
redirigiendo a `/app/`); `infra/compose/compose.prod.yml` levanta todo junto
con PostgreSQL para qa y producción (EC2, `amd64`). El desarrollo corre en una Raspberry Pi (`arm64`);
ambas imágenes se construyen multi-arquitectura desde el mismo Dockerfile.

`compose.prod.yml` lee su configuración de `.env.prod` (ver
`.env.prod.example`), nunca del `.env` del desarrollador — no comparten
secretos ni `NODE_ENV`. Se levanta con:

```bash
docker compose -f infra/compose/compose.prod.yml --env-file .env.prod up -d --build
```

### TLS

**La terminación TLS ocurre en este mismo Nginx, no en un balanceador por
delante.** La decisión viene del propio diseño (§11 de la spec): un solo
Nginx al frente, en la misma máquina, sin ALB/ELB ni ningún otro componente
de borde mencionado en ningún ambiente. Introducir un balanceador sólo para
sostener un certificado sería infraestructura nueva que el diseño nunca pidió
-- y qa/producción son hoy una sola instancia EC2, no un grupo de instancias
que un balanceador tendría razón de repartir.

El certificado lo emite y renueva **Let's Encrypt**, vía un contenedor
`certbot` que acompaña a `nginx` en `compose.prod.yml` (desafío HTTP-01,
servido desde `/.well-known/acme-challenge/`). `infra/nginx/nginx.conf.template`
es una plantilla: la imagen oficial de Nginx sustituye `${DOMAIN_NAME}` al
arrancar el contenedor (variable `DOMAIN_NAME` en `.env.prod`), y expone dos
`server`: el puerto 80 sólo responde el reto ACME y redirige todo lo demás a
HTTPS; el 443 sirve `/api/`, `/admin/` y `/app/` con el certificado real. Sin esto, la
cookie `Secure` del refresh token (ver
`apps/api/src/lib/http/refresh-cookie.ts`) viajaría en claro -- o, peor, el
navegador simplemente nunca la enviaría.

El certificado inicial no existe en un host nuevo: con `nginx` arriba y el
DNS de `DOMAIN_NAME` ya apuntando a este host, se pide una sola vez (el
comentario de servicio `certbot` en `compose.prod.yml` tiene el comando
exacto) y luego se reinicia `nginx` para que lo recoja. De ahí en adelante,
el propio contenedor `certbot` lo renueva solo cada 12 horas (Let's Encrypt
expira a los 90 días; `certbot renew` es un no-op hasta que falten ~30).

Dev (Raspberry Pi) no levanta este Nginx en absoluto -- `compose.dev.yml`
sólo trae Postgres, igual que `compose.test.yml` -- así que no necesita
`DOMAIN_NAME` ni certificado alguno.
