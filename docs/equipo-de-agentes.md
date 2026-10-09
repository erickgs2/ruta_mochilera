# Equipo de agentes: cómo retomar en otra computadora

El proyecto se desarrolla con un equipo de sesiones de Claude Code coordinadas por
Alpha. Las definiciones de cada rol viven en `.claude/agents/<rol>.md` (modelo, effort e
instrucciones) y se versionan aquí para poder cargar el equipo en cualquier máquina.

## Roles

| Rol | Cómo corre | Modelo / effort | Qué hace |
|---|---|---|---|
| Alpha | Sesión propia | opus / medium | Líder: analiza, reparte, integra a `main` |
| Bravo | Sesión propia | sonnet / medium | Tareas sencillas o medianas |
| Echo | Sesión propia | opus / high | Tareas complejas: dinero, concurrencia, varios módulos |
| Charlie | Sesión propia | sonnet / high | Valida todo y corrige los hallazgos simples (absorbió a Delta el 2026-10-08) |
| echo-max | Subagente de Alpha | opus / max | Sólo tareas críticas o cuando un intento de Echo falló |
| delta-lite | Subagente de Alpha | haiku / low | Sólo arreglos triviales (typos, lint, formato) |

`delta.md` queda inactivo: el rol lo absorbió Charlie para liberar CPU.

## Para arrancar en otra computadora

1. Clona el repo y sigue `CLAUDE.md` (Postgres local, `.env`, `pnpm install`, `pnpm db:migrate`).
2. Abre cuatro terminales y, en cada una, inicia Claude Code con su rol: «Tu nombre es Alpha»,
   «Tu nombre es Bravo», «Tu nombre es Charlie», «Tu nombre es Echo». Fija el modelo y el effort
   de la tabla con `/model` y `/effort`.
3. Alpha manda a cada sesión su tarea por `SendMessage`. Los nombres de sesión
   (`ruta-mochilera-<hex>`) cambian cada vez, así que cada sesión confirma su rol al empezar.
4. El estado de cada rama en curso está en la sección «Estado al último corte».

## Reglas de trabajo

- Flujo: Bravo o Echo desarrollan → Alpha → Charlie valida → Alpha integra a `main`. Nadie se
  aprueba solo; cuando Charlie corrige, Alpha revisa su diff y la evidencia (prueba que falla
  antes y pasa después, más el mutante).
- Cada rama vive en su worktree (`.worktrees/<rama>`), nunca en el checkout principal.
- Carga de la máquina: `NX_DAEMON=false`, sólo las pruebas de lo que se toca, `--maxWorkers=1`,
  `--hookTimeout=90000`. Sólo Charlie corre proyectos completos. Al integrar una rama se borra su
  worktree.

## Estado al último corte

Lo actualiza Alpha en cada corte. Las ramas en curso se suben al remoto además de `main`.

- `main` integra: correcciones de pagos y bloqueos, fechas, regreso tras login, fecha de
  nacimiento, fichas OXXO/SPEI por cobrar, alertas según permiso, filtro de no leídos, idioma
  guardado por persona, reserva cancelada sin vencimiento de apartado, y las tareas A1–A4, A6 y
  A7 del plan `docs/superpowers/plans/2026-10-08-abono-libre-y-dinero-tardio.md`.
- En validación con Charlie (en orden): `feat/public-trip-deposit-terms`, R6 sobre
  `redesign/component-polish`, `redesign/foundation`, `feat/admin-work-queue-api`,
  `feat/admin-reservation-search-and-detail`, y sus propias correcciones de pruebas.
- En desarrollo: Echo, `feat/late-payment-cases` (L1–L3), luego A5, A8 y A9 del plan; Bravo,
  `redesign/client-catalogue` (catálogo y detalle del rediseño).
