# Diseño: Plataforma de agencia de viajes

- **Fecha:** 2026-09-28
- **Estado:** Aprobado, pendiente de plan de implementación
- **Alcance de este documento:** diseño completo del sistema, dividido en tres fases. Cada fase recibe su propio plan de implementación.

> Este documento está en español. **Todo el código, comentarios, nombres de variables, archivos, tablas y columnas se escriben en inglés**, sin excepción. Sólo los documentos de planeación y diseño van en español.

---

## 1. Resumen ejecutivo

Se construye una plataforma para una agencia de viajes que hoy opera de forma manual: planea y cotiza viajes, los promociona en oficina y redes sociales, y administra reservaciones y planes de pago sin sistema.

La solución son tres aplicaciones sobre una base de datos común:

1. **Panel administrativo** (Angular) — alta y costeo de viajes, gestión de clientes y reservaciones, cobros en sucursal, notificaciones, reportes, RBAC.
2. **Aplicación de clientes** (Angular, distribuida como web responsiva y como app nativa con Capacitor) — registro, catálogo de viajes, reservación y pagos.
3. **API** (Next.js + Prisma + PostgreSQL) — contrato REST documentado con OpenAPI, consumido por ambas.

Requisito transversal crítico: la agencia **ya tiene viajes en curso**. El sistema debe permitir capturar viajes a medio vender, clientes existentes y pagos históricos sin esperar ninguna acción del cliente.

---

## 2. Decisiones de arquitectura

| Área | Decisión | Razón |
|---|---|---|
| Entrega | Tres fases, una spec y un plan por fase | Evita specs que envejecen antes de implementarse |
| Monorepo | Nx | Soporta Angular y Next.js nativamente; librerías compartidas sin publicar paquetes |
| Frontend | Dos apps Angular (`admin`, `client`) con librerías compartidas | El bundle móvil no contiene código administrativo; los componentes se comparten de verdad |
| Servidor | Ambas apps y la API en la misma instancia detrás de un solo Nginx | Requisito explícito del cliente |
| Backend | Next.js App Router, Route Handlers delgados | Requisito técnico del cliente |
| Contrato | REST con OpenAPI generado desde esquemas Zod, cliente Angular tipado generado | Un cambio de contrato rompe el build, no producción |
| ORM / BD | Prisma + PostgreSQL | Requisito técnico del cliente |
| Móvil | Capacitor con **assets empaquetados** (no `server.url` remoto) | Apple rechaza contenedores web bajo la guía 4.2; una caída del servidor dejaría la app en blanco |
| Autenticación | JWT propio: access corto + refresh rotativo | Funciona igual en web y en Capacitor, sin costo por usuario |
| Login de clientes | Correo + contraseña, más Google y Apple Sign-In | Apple exige su propio proveedor si existe login social |
| Verificación de correo | Código de 6 dígitos, una sola vez al registrarse | Requisito del cliente; el login social llega ya verificado |
| Autorización | RBAC granular por acción, con roles editables desde la UI | Requisito explícito del cliente |
| Pasarela | Stripe México: tarjeta, OXXO, SPEI | Mejor DX y webhooks; cubre los tres métodos requeridos |
| Correo | Resend | Mejor DX en Node, buena entregabilidad |
| Notificaciones | Push (FCM) + bandeja en la app + correo | Requisito del cliente |
| Trabajos en segundo plano | pg-boss sobre el mismo PostgreSQL | Cero infraestructura nueva; jobs transaccionales con los datos |
| Almacenamiento de archivos | Abstracción `StorageProvider`: filesystem local en dev, S3 en qa/prod | Dev corre en Raspberry Pi |
| Despliegue | Docker Compose + GitHub Actions, imágenes multi-arquitectura | dev en Raspberry Pi (arm64), qa y prod en EC2 (amd64) |
| Idiomas | Preferencia por usuario; alcanza UI, correos, recibos y notificaciones | Requisito del cliente |
| Facturación | Recibo PDF por correo, sin timbrado CFDI | Requisito del cliente |
| Moneda | MXN únicamente, montos en centavos (`Int`) | Sin aritmética de punto flotante; Stripe también usa centavos |
| Zona horaria | Datos en UTC; reglas de calendario en `America/Mexico_City` | Los días 01 y 28 son fechas locales de la agencia |
| Angular | Última versión estable, componentes standalone, señales y `@defer` | Estándar actual del framework; evita NgModules heredados |

---

## 3. Estructura del monorepo

```
ruta-mochilera/
├── apps/
│   ├── api/                  Next.js App Router — REST + OpenAPI
│   ├── admin/                Angular — panel administrativo
│   ├── client/               Angular — app de clientes (web + Capacitor)
│   └── worker/               Node — consumidores y cron de pg-boss
├── libs/
│   ├── domain/               lógica de negocio pura, sin dependencias de HTTP
│   │   ├── identity/
│   │   ├── rbac/
│   │   ├── trips/
│   │   ├── costing/
│   │   ├── reservations/
│   │   ├── payments/
│   │   ├── notifications/
│   │   ├── expenses/
│   │   └── reporting/
│   ├── db/                   esquema Prisma, migraciones, seeds, cliente
│   ├── contracts/            esquemas Zod — fuente de verdad del contrato
│   ├── api-client/           cliente Angular generado desde OpenAPI
│   ├── ui/                   componentes Angular compartidos
│   ├── auth-web/             guards, interceptores, refresh de token
│   ├── i18n/                 catálogos en/es
│   └── shared-utils/         dinero, fechas, Result
├── infra/
│   ├── docker/               Dockerfile por aplicación
│   ├── compose/              compose.dev.yml, compose.qa.yml, compose.prod.yml
│   └── nginx/
└── docs/
    ├── business-rules/
    ├── diagrams/
    └── superpowers/specs/
```

### Regla arquitectónica central

**`libs/domain` no sabe que existe HTTP.** Un Route Handler hace cuatro cosas y nada más: autenticar, verificar permiso, validar con Zod, llamar al servicio de dominio. Los workers de pg-boss y los importadores CSV llaman a los mismos servicios.

Consecuencia deliberada: registrar un pago desde el mostrador, desde un webhook de Stripe o desde una importación recorre el mismo código, que es la única forma de garantizar que los tres produzcan el mismo resultado.

`apps/worker` es un proceso separado a propósito: si los jobs viven dentro de Next.js, cada redespliegue mata trabajos a medias.

---

## 4. Modelo de datos

Nombres en inglés. `snake_case` en PostgreSQL, `PascalCase` en Prisma. Montos `Int` en centavos MXN.

### 4.1 Identidad y RBAC

```
User               id, email (único), password_hash?, email_verified_at,
                   locale (es|en), type (STAFF|CUSTOMER), status (ACTIVE|DISABLED),
                   created_at, updated_at
StaffProfile       user_id, full_name, employee_code?
CustomerProfile    user_id, full_name, phone, birth_date, photo_key?,
                   origin (SELF_SIGNUP|BRANCH|IMPORT), invited_at, activated_at
AuthIdentity       user_id, provider (PASSWORD|GOOGLE|APPLE), provider_user_id
                   único (provider, provider_user_id)
RefreshToken       user_id, token_hash, device_id, user_agent,
                   expires_at, revoked_at, replaced_by_id?
EmailVerification  user_id, code_hash, expires_at, consumed_at, attempts
PasswordReset      user_id, token_hash, expires_at, consumed_at

Permission         key ('trip.create', 'payment.register', ...), category, description
Role               name, description, is_system
RolePermission     role_id, permission_id
UserRole           user_id, role_id
```

Un solo `User` para credenciales, con el perfil separado por tipo: el login, el refresh y la verificación de correo son idénticos para staff y clientes, mientras que los campos de negocio no tienen nada en común. `AuthIdentity` aparte permite que un cliente registrado con contraseña vincule después su cuenta de Google sin duplicarse.

`Permission` es un catálogo sembrado en migración y **no editable desde la UI**: las claves son las que el código verifica, así que inventarlas en runtime crearía permisos sin efecto. Lo editable son los roles y su composición.

Los clientes no tienen roles: `type = CUSTOMER` implica sus permisos.

### 4.2 Viajes y costeo

```
Trip               id, slug (único), status, departure_date, return_date,
                   payment_deadline, total_capacity, pre_sold_seats,
                   hold_ttl_hours, minimum_deposit_cents,
                   budget_total_cents, margin_mode, margin_value,
                   price_per_seat_cents, price_mode (AUTO|MANUAL),
                   published_at, is_backfilled, created_by, updated_at
                   status ∈ DRAFT | PUBLISHED | IN_PROGRESS | COMPLETED | CANCELLED
                   margin_mode ∈ PERCENTAGE | FIXED_TOTAL | FIXED_PER_SEAT
TripTranslation    trip_id, locale, name, description, itinerary,
                   includes, excludes        único (trip_id, locale)
TripImage          trip_id, storage_key, position, is_cover, alt_text?
TripBudgetItem     trip_id, concept, supplier?, quantity,
                   unit_amount_cents, notes, created_by
```

**El cupo disponible no se almacena.** No existe columna `available_seats`. Ver §5.1.

**El precio se calcula pero se guarda**, porque es el número que la reserva congela; recalcularlo en cada consulta haría que editar el presupuesto moviera precios ya pactados.

**Español obligatorio, inglés opcional** con respaldo al español cuando falte.

### 4.3 Reservaciones y pagos

```
Reservation        id, code (folio único), trip_id, customer_id,
                   status (HELD|ACTIVE|CANCELLED|EXPIRED), hold_expires_at?,
                   total_price_cents, minimum_deposit_cents, paid_cents,
                   credit_cents, payment_deadline,
                   source (APP|BRANCH|IMPORT), created_by?,
                   cancelled_at, cancel_reason, is_backfilled, created_at
                   único parcial (trip_id, customer_id) donde status ∈ (HELD, ACTIVE)

ReservationPriceChange  reservation_id, previous_total_cents, new_total_cents,
                        reason, campaign_id?, changed_by, changed_at

Payment            id, reservation_id, amount_cents,
                   method (CARD|OXXO|SPEI|CASH|LEGACY),
                   status (PENDING|SUCCEEDED|FAILED|EXPIRED|REFUNDED),
                   paid_at, recorded_at, provider (STRIPE|MANUAL),
                   provider_intent_id?, receipt_number (único),
                   receipt_key?, receipt_sent_at?, recorded_by?,
                   is_backfilled, notes

StripeEvent        stripe_event_id (único), type, payload, processed_at
```

`total_price_cents` y `minimum_deposit_cents` se **congelan** en la reserva al crearla: cambiar el viaje no altera reservas existentes salvo por la operación explícita de §5.6.

`paid_cents` está desnormalizado a propósito — el panel lista cientos de reservas con su saldo y sumar pagos por fila no escala. Se actualiza **en la misma transacción** que el pago, nunca después, y un job nocturno de reconciliación lo compara contra la suma real de pagos `SUCCEEDED` y alerta si hay desviación. La verdad siempre son los registros `Payment`.

`paid_at` separado de `recorded_at` es lo que hace funcionar la captura histórica: los reportes usan `paid_at`, así que un pago de marzo capturado en septiembre aparece en marzo.

`StripeEvent` existe sólo para idempotencia: Stripe reenvía webhooks, y sin esta tabla un reintento duplicaría un pago.

### 4.4 Gastos, notificaciones y soporte

```
Expense            trip_id?, category, concept, supplier?, amount_cents,
                   paid_at, payment_method, receipt_key?, created_by, notes

NotificationCampaign  id, audience (ALL|TRIP|WITH_RESERVATION|WITHOUT_RESERVATION),
                      trip_id?, channels[] (PUSH|EMAIL|INBOX),
                      scheduled_for?, status (DRAFT|SCHEDULED|SENDING|SENT|CANCELLED),
                      created_by, sent_at
NotificationCampaignTranslation  campaign_id, locale, title_template, body_template
NotificationDelivery  id, campaign_id?, system_type?, user_id, channel,
                      rendered_title, rendered_body,
                      status (PENDING|SENT|FAILED|READ), sent_at, read_at, error
DeviceToken        user_id, platform (IOS|ANDROID|WEB), token (único), last_seen_at

AuditLog           actor_user_id?, action, entity_type, entity_id,
                   before jsonb, after jsonb, ip, created_at
ImportBatch        type (CUSTOMERS|PAYMENTS), file_name, status,
                   rows_total, rows_ok, rows_failed, report jsonb, created_by
SystemSetting      key (único), value jsonb, updated_by, updated_at
```

`NotificationDelivery` sirve doble: es el registro de envío y es la bandeja de entrada de la app. Las notificaciones del sistema (recordatorio del 28, cambio de precio, recibo) usan `system_type` sin campaña asociada, de modo que el cliente ve todo su historial en un solo lugar.

Claves iniciales de `SystemSetting`: `reservation.default_hold_ttl_hours` (72), `risk.balance_threshold_percent` (40), `risk.lead_days` (30), `reminder.day_of_month` (28), `reminder.hour_local` (10), `organization.timezone` (`America/Mexico_City`), `receipt.prefix` (prefijo del folio de recibo).

### 4.5 Máquinas de estado

```
Trip         DRAFT → PUBLISHED → IN_PROGRESS → COMPLETED
             CANCELLED alcanzable desde cualquier estado

Reservation  HELD ──primer pago confirmado ≥ anticipo──→ ACTIVE
              │                                            │
              └──vence hold_expires_at──→ EXPIRED           └──cancelación manual──→ CANCELLED

Payment      PENDING → SUCCEEDED | FAILED | EXPIRED
             SUCCEEDED → REFUNDED
```

Una reserva liquidada **no cambia de estado**: `paid_cents >= total_price_cents` es un dato derivado, no un estado, porque un cambio de precio podría revertirlo.

---

## 5. Reglas de negocio

Todas estas reglas viven en `libs/domain` y se documentan en `docs/business-rules/`.

### 5.1 Cupo disponible

```
available_seats = total_capacity
                − pre_sold_seats
                − COUNT(reservations con status = ACTIVE)
                − COUNT(reservations con status = HELD y hold_expires_at > now)
```

Se calcula dentro de una transacción con bloqueo de fila sobre el viaje (`SELECT ... FOR UPDATE`). Un contador mutable es exactamente donde aparece la sobreventa cuando dos personas reservan el último lugar en el mismo segundo.

`pre_sold_seats` es la pieza de arranque en caliente: lugares ya vendidos fuera del sistema que la agencia no quiere capturar uno por uno.

### 5.2 Cálculo de precio de venta

```
budget_total_cents = Σ (quantity × unit_amount_cents)

según margin_mode:
  PERCENTAGE      total_with_margin = budget_total × (1 + margin_value / 100)
  FIXED_TOTAL     total_with_margin = budget_total + margin_value
  FIXED_PER_SEAT  total_with_margin = budget_total + (margin_value × total_capacity)

price_per_seat_cents = redondeo hacia arriba al peso completo
                       de (total_with_margin / total_capacity)
```

Con `price_mode = MANUAL`, el administrador escribe `price_per_seat_cents` directamente y el cálculo sólo se muestra como referencia.

`total_capacity = 0` es inválido: no se puede publicar un viaje sin vacantes.

**Qué pasa al editar el presupuesto después de publicar.** Agregar, modificar o eliminar un `TripBudgetItem` siempre recalcula `budget_total_cents`, y si `price_mode = AUTO`, también `price_per_seat_cents` del viaje. Esto afecta únicamente a **reservas futuras**: las reservas existentes conservan su `total_price_cents` congelado. Propagar el nuevo precio a reservas ya creadas requiere ejecutar explícitamente la operación de §5.6, con su notificación obligatoria. La UI advierte al administrador cuando un cambio de presupuesto deja el precio del viaje distinto del que pagaron clientes ya reservados.

### 5.3 Mensualidad sugerida (informativa)

No existe mensualidad obligatoria. El único monto exigible es el anticipo mínimo al reservar; el compromiso real es liquidar antes de `payment_deadline`.

```
months_remaining = cantidad de días 01 de mes entre hoy (exclusivo)
                   y payment_deadline (inclusivo), en America/Mexico_City

suggested_monthly_cents = redondeo hacia arriba de
                          (balance_cents / max(months_remaining, 1))
```

Se recalcula en cada lectura y **nunca se almacena**. Si `months_remaining = 0`, la sugerencia es el saldo completo.

Su único propósito es motivacional: se muestra en la app y se usa en los recordatorios. El sistema jamás rechaza un abono por ser menor a esta cifra.

### 5.4 Reservación y apartado temporal

1. El cliente solicita reservar. En una transacción con bloqueo sobre el viaje se verifica `available_seats >= 1` y que no tenga ya una reserva `HELD` o `ACTIVE` en ese viaje.
2. Se crea la reserva en `HELD` con `hold_expires_at = now + trip.hold_ttl_hours`, congelando `total_price_cents` y `minimum_deposit_cents`.
3. El cliente elige pagar el total o el anticipo mínimo, y un método de pago.
4. Al confirmarse un pago acumulado `>= minimum_deposit_cents`, la reserva pasa a `ACTIVE` y `hold_expires_at` se anula.
5. Un job cada 5 minutos pasa a `EXPIRED` las reservas `HELD` vencidas, liberando el lugar y cancelando en Stripe cualquier voucher pendiente.

Para OXXO, la fecha de expiración del voucher se fija igual a `hold_expires_at`, de modo que el sistema nunca confirme un pago de un lugar ya liberado.

### 5.5 Pagos

- Un pago debe ser `> 0` y `<= balance_cents`. Un monto mayor se rechaza con `PAYMENT_EXCEEDS_BALANCE`; el saldo a favor sólo nace de una bajada de precio.
- `balance_cents = total_price_cents − paid_cents` (nunca negativo).
- Al confirmarse un pago, en la **misma transacción**: se inserta el `Payment` con `SUCCEEDED`, se incrementa `paid_cents`, se asigna `receipt_number` desde una secuencia de PostgreSQL con formato `{receipt.prefix}-{año}-{consecutivo de 6 dígitos}`, y se encola el job de recibo.
- El recibo PDF se genera en el idioma del cliente y se envía por correo, salvo captura retroactiva silenciada (§5.8).
- Métodos: `CARD`, `OXXO` y `SPEI` vía Stripe; `CASH` registrado por un trabajador en sucursal; `LEGACY` para pagos anteriores al sistema.
- Los webhooks de Stripe son idempotentes por `stripe_event_id`. Un evento ya presente en `StripeEvent` se descarta sin efecto.

### 5.6 Cambio de precio de un viaje con reservas

Cambiar `price_per_seat_cents` de un viaje que tiene reservas `HELD` o `ACTIVE` es una operación explícita, protegida por el permiso `trip.change_price`, y **exige** que el administrador redacte la notificación a los afectados. Si no hay reservas activas, no se pide notificación.

En una sola transacción, por cada reserva afectada:

1. Se registra un `ReservationPriceChange` con el total anterior y el nuevo.
2. `total_price_cents` toma el nuevo valor.
3. Si `paid_cents > total_price_cents`, la diferencia pasa a `credit_cents` y el saldo queda en cero.
4. Se crea la `NotificationCampaign` con audiencia `TRIP`, vinculada al cambio.

El saldo a favor **nunca dispara un movimiento de dinero automático**. Queda visible para cliente y administrador; aplicarlo a otro viaje o marcarlo como reembolsado es una acción humana con permiso propio y registro en `AuditLog`.

### 5.7 Notificaciones con variables

El administrador escribe una plantilla y cada destinatario recibe su versión personalizada:

> «Hola {{customer.firstName}}, te faltan {{reservation.balance}} para completar tu viaje a {{trip.name}}. Tienes hasta el {{reservation.paymentDeadline}}.»

- **Catálogo de variables definido en código**, no en base de datos — cada variable es una función que extrae un dato real. Se expone por API para que el editor muestre un selector con descripción y ejemplo.
- Cada variable declara un **ámbito**: `USER`, `TRIP` o `RESERVATION`.
- **El ámbito disponible depende de la audiencia.** Con audiencia `ALL` o `WITHOUT_RESERVATION`, las variables de reserva no se ofrecen y su uso es un error de validación al guardar, no al enviar. Una campaña con una variable imposible falla al guardarse, no a mitad de un envío a 300 destinatarios.
- **Vista previa obligatoria** antes de programar: el administrador elige un destinatario real de la audiencia y ve el texto final, en los dos idiomas si capturó ambos.
- **El renderizado ocurre por destinatario en el momento del envío**, y el texto resuelto se guarda en `NotificationDelivery.rendered_title` / `rendered_body`. La bandeja del cliente muestra exactamente lo que se le envió, aunque su saldo cambie después.
- Los valores se formatean según idioma y zona del destinatario: `$12,500.00 MXN` y `15 de marzo de 2026` en español; `March 15, 2026` en inglés.
- **Idioma del envío:** se usa la traducción que coincide con `user.locale`. El español es obligatorio en toda campaña y el inglés es opcional; si un destinatario tiene `locale = en` y la campaña no tiene versión en inglés, recibe la española. Mismo criterio de respaldo que el contenido de viajes.
- Variable inexistente en el catálogo → error al guardar. Variable válida sin dato para ese destinatario → respaldo declarado por la propia variable; nunca un `{{}}` crudo ni un hueco vacío.

Envíos automáticos del sistema:

| Disparador | Momento | Destinatario |
|---|---|---|
| Recordatorio de abono | Día 28 de cada mes, hora configurable | Clientes con reserva `ACTIVE` y saldo > 0 cuya fecha límite no ha pasado |
| Alerta de riesgo de cobranza | Diario; reservas de viajes que salen en ≤ 30 días con saldo ≥ 40% del total | **Administradores** con permiso `reservation.risk.view`, no el cliente |
| Recibo de pago | Al confirmarse un pago | Cliente titular |
| Cambio de precio | Al ejecutarse §5.6 | Clientes con reserva en ese viaje |

Los umbrales de la alerta de riesgo (`40%`, `30 días`) son `SystemSetting`, no constantes. **No existe cancelación automática de reservas por falta de pago**, en ninguna circunstancia.

### 5.8 Arranque en caliente y captura histórica

Protegido por el permiso `data.backfill`. Habilita:

- Crear viajes con fechas pasadas y en estado `IN_PROGRESS`.
- Definir `pre_sold_seats > 0` para lugares vendidos fuera del sistema.
- Crear reservas con `created_at` retroactivo, saltando la validación de anticipo mínimo.
- Registrar pagos con `paid_at` en el pasado y método `LEGACY`.
- Dos caminos por reserva, a elección del capturista: un **abono inicial único** con el total ya pagado, o el **desglose pago por pago** cuando existan los datos.

**Los correos salen silenciados por defecto.** Ni recibos ni invitaciones se envían en captura retroactiva salvo que el trabajador marque explícitamente la casilla. Evita bombardear a decenas de clientes con recibos viejos el día del arranque.

Todo registro creado así lleva `is_backfilled = true` y queda en `AuditLog` con el actor.

### 5.9 Alta de clientes en sucursal

El trabajador busca por nombre, correo o teléfono. Si el cliente no existe, captura nombre completo, correo, teléfono y fecha de nacimiento.

Se crea un `User` de tipo `CUSTOMER` con el correo **ya marcado como verificado** (lo verificó el trabajador en persona), sin contraseña, y con `origin = BRANCH`. Se le envía una invitación con liga de un solo uso para establecer contraseña y entrar a la app. Si nunca la activa, sigue recibiendo sus recibos por correo y el trabajador sigue registrando sus pagos.

### 5.10 Importación CSV

Dos importadores: clientes y pagos. El flujo es idéntico en ambos: subir archivo → validar fila por fila → **vista previa con los errores señalados** → confirmar → aplicar. El resultado completo queda en `ImportBatch.report`. Una fila inválida no impide procesar las demás; el reporte lista exactamente cuáles fallaron y por qué.

---

## 6. Contrato de API

REST bajo `/api/v1`. Los esquemas Zod en `libs/contracts` son la fuente de verdad: de ellos se genera el documento OpenAPI y de éste el cliente Angular tipado de `libs/api-client`. Regenerar el cliente es un paso de CI; un contrato desactualizado rompe el build.

Agrupación por módulo:

```
/auth        login, refresh, logout, register, verify-email,
             resend-code, forgot-password, reset-password, oauth/{google|apple}
/me          perfil, cambio de idioma, cambio de contraseña, foto
/rbac        permissions, roles (CRUD), asignación de roles
/staff       usuarios administradores (CRUD)
/customers   búsqueda, detalle, alta en sucursal, invitación, historial
/trips       CRUD, traducciones, imágenes, publicación, cambio de precio,
             disponibilidad, catálogo público
/trips/{id}/budget-items   CRUD de costos y recálculo de precio
/reservations              crear, detalle, listar por viaje o cliente, cancelar
/payments    registrar en efectivo, iniciar pago Stripe, historial, recibo
/webhooks/stripe           entrada de eventos, verificación de firma
/notifications             campañas (CRUD), variables disponibles,
                           vista previa, programar, cancelar, bandeja del cliente
/devices     registro y baja de tokens de push
/expenses    CRUD de gastos reales
/reports     ingresos y gastos por periodo, rentabilidad por viaje, exportación
/imports     carga, validación y confirmación de CSV
```

Rutas públicas sin autenticar: catálogo de viajes publicados, detalle de viaje, registro, login y recuperación. Todo lo demás exige token y verificación de permiso en el servidor.

---

## 7. Documentación viva

```
docs/
├── business-rules/
│   ├── README.md          índice y convenciones
│   ├── trips.md           estados, cupo, publicación
│   ├── costing.md         presupuesto, margen, precio por vacante
│   ├── reservations.md    apartado, expiración, cambio de precio
│   ├── payments.md        métodos, recibos, saldo a favor, retroactivos
│   ├── notifications.md   audiencias, variables, calendarización
│   └── rbac.md            catálogo de permisos
└── diagrams/
    ├── trip-creation.md      flujo de creación de viaje
    ├── trip-costing.md       flujo de cotización y costos
    └── trip-reservation.md   flujo de reserva
```

Los diagramas se escriben en **Mermaid dentro de archivos Markdown**: se versionan como texto, un diff muestra qué cambió en la regla, y GitHub los renderiza sin herramientas adicionales.

### Regla obligatoria (va a `CLAUDE.md`)

> Toda tarea que añada o modifique una regla de negocio en el backend queda **incompleta** hasta que el archivo correspondiente de `docs/business-rules/` esté actualizado **en el mismo commit**. Si la regla toca creación de viaje, costeo o reserva, también debe actualizarse su diagrama en `docs/diagrams/`.

Se refuerza con dos mecanismos: un ítem obligatorio en la plantilla de pull request, y una verificación en CI que marca el PR cuando modifica `libs/domain/**` sin tocar `docs/business-rules/**`.

---

## 8. Manejo de errores

Los servicios de dominio devuelven un `Result` explícito en vez de lanzar excepciones para los fallos esperables — cupo agotado, apartado vencido, monto mayor al saldo, permiso faltante — porque son casos de negocio que el llamador debe manejar, no accidentes. Las excepciones quedan para lo genuinamente inesperado.

La capa HTTP traduce a `application/problem+json` con un **código de error estable**: `TRIP_SOLD_OUT`, `HOLD_EXPIRED`, `PAYMENT_EXCEEDS_BALANCE`, `DUPLICATE_RESERVATION`, `EMAIL_NOT_VERIFIED`, `PERMISSION_DENIED`. Ese código es lo que Angular traduce al idioma del usuario: **el backend nunca envía texto destinado a mostrarse a una persona**.

Todo lo que mueve dinero o cupo corre en una transacción de Prisma con bloqueo sobre el viaje o la reserva. Los jobs de pg-boss se diseñan para ser reejecutables sin duplicar efectos.

---

## 9. Estrategia de pruebas

| Capa | Enfoque |
|---|---|
| `libs/domain` | Pruebas unitarias sin base de datos, escritas antes del código (TDD). Aquí viven el cálculo de precio, la mensualidad sugerida, el saldo, el renderizado de variables y las transiciones de estado — donde más barato sale encontrar un error de dinero. |
| `apps/api` | Pruebas de integración contra un PostgreSQL real en Docker: permisos por endpoint, validación de entrada, y concurrencia sobre el último lugar disponible. |
| Angular | Pruebas de componente para `libs/ui`; Playwright para los recorridos críticos: crear y publicar un viaje, reservar y pagar, registrar un pago en sucursal. |
| Stripe | Webhooks simulados con fixtures del Stripe CLI, incluyendo reenvíos duplicados, pagos OXXO expirados y fallos de tarjeta. |
| Jobs | Cada job se prueba ejecutándolo dos veces sobre el mismo estado para verificar idempotencia. |

---

## 10. Seguridad

- Contraseñas con **Argon2id**.
- Límite de intentos en login, verificación OTP y recuperación de contraseña.
- **Rotación de refresh tokens con detección de reuso**: presentar un token ya rotado revoca toda la cadena de esa sesión.
- Refresh token en Secure Storage nativo en móvil; cookie `httpOnly`, `Secure`, `SameSite=Strict` en web.
- URLs firmadas y de vida corta para imágenes privadas; las fotos de viajes publicados se sirven por CDN.
- Verificación de firma en los webhooks de Stripe; el endpoint es el único que no exige token.
- **Toda verificación de permiso ocurre en la API.** Ocultar un botón en Angular es comodidad visual, nunca seguridad.
- `AuditLog` obligatorio en: cambios de precio, pagos manuales, cancelaciones, aplicación de saldo a favor, captura retroactiva, importaciones y cambios de roles o permisos.

---

## 11. Despliegue y ambientes

| Ambiente | Infraestructura | Arquitectura | Almacenamiento |
|---|---|---|---|
| dev | Raspberry Pi | arm64 | Filesystem local |
| qa | EC2 | amd64 | S3 |
| prod | EC2 | amd64 | S3 |

Un solo Nginx al frente, en la misma máquina:

| Ruta | Destino |
|---|---|
| `/api/*` | contenedor Next.js |
| `/admin/*` | estáticos de Angular admin |
| `/*` | estáticos de Angular cliente |

Contenedores: `nginx`, `api`, `worker`, `postgres`. GitHub Actions construye con `buildx` para ambas arquitecturas desde el mismo Dockerfile, publica las imágenes y despliega por SSH. El mismo artefacto corre en los tres ambientes; sólo cambian las variables de entorno.

La app móvil empaqueta los assets compilados de `apps/client` (`nx build client` → `cap sync`), con plugins nativos para push (FCM), cámara y almacenamiento seguro.

---

## 12. Fases de entrega

### Fase 1 — Cimientos y panel administrativo

Monorepo Nx con Docker y CI · `CLAUDE.md` y `docs/business-rules/` · esquema Prisma y semillas · autenticación JWT para staff · RBAC granular con pantalla de roles · alta de usuarios administradores · CRUD de viajes con traducciones, imágenes y estados · vista de costeo con margen y precio por vacante · arranque en caliente · i18n del panel.

**Criterio de cierre:** la agencia puede capturar sus viajes reales, incluidos los que ya van a medio vender. Diagramas entregados: creación de viaje y cotización.

### Fase 2 — Clientes, reservas y cobros

App cliente Angular con cascarón Capacitor · registro con OTP, login con contraseña y Google/Apple · catálogo público y detalle de viaje · reserva con apartado temporal y anticipo mínimo · Stripe (tarjeta, OXXO, SPEI) con webhooks idempotentes · cobro en sucursal con búsqueda y alta de cliente e invitación · recibos PDF por Resend · saldos, historial y saldo a favor · cambio de precio con notificación obligatoria · importación CSV.

**Criterio de cierre:** un cliente reserva y paga desde su teléfono, y un trabajador cobra en efectivo en mostrador. Diagrama entregado: reserva de viaje.

### Fase 3 — Notificaciones, gastos y reportes

Push con FCM y bandeja en la app · campañas con variables, audiencias y calendarización sobre pg-boss · recordatorio del día 28, alerta del 40%, expiración de apartados, reconciliación nocturna · módulo de gastos reales · reportes de ingresos y gastos por mes y año, rentabilidad por viaje, exportación CSV y PDF · publicación en App Store y Google Play.

**Criterio de cierre:** el sistema opera solo y la dirección toma decisiones con sus reportes.

---

## 13. Fuera de alcance

- Timbrado de facturas CFDI ante el SAT.
- Reservas de varios lugares por un mismo titular: **una reserva es una persona**. Un acompañante necesita su propia cuenta y su propia reserva.
- Cancelación automática de reservas por falta de pago.
- Reembolsos automáticos: el saldo a favor se registra, y moverlo es una decisión humana.
- Múltiples monedas, múltiples agencias o sucursales como entidad del modelo.
- Reporte dedicado de cartera y riesgo de cobranza: lo liquidado por cliente se consulta desde el viaje y desde la reserva, y el riesgo llega como notificación al administrador.

---

## 14. Riesgos

| Riesgo | Mitigación |
|---|---|
| Rechazo de la app en App Store | Assets empaquetados más plugins nativos reales (push, cámara, almacenamiento seguro), no un contenedor de URL |
| Sobreventa del último lugar | Cupo calculado bajo bloqueo de fila, con prueba de integración concurrente |
| Desviación de `paid_cents` | Actualización en la misma transacción más job nocturno de reconciliación con alerta |
| Pagos OXXO confirmados tras liberar el lugar | Expiración del voucher igualada a `hold_expires_at` |
| Webhooks duplicados de Stripe | Idempotencia por `stripe_event_id` |
| Builds lentos o caídos en Raspberry Pi | Nunca se compila en el dispositivo: se construyen imágenes arm64 en CI |
| Documentación de reglas que se queda atrás | Verificación en CI sobre `libs/domain/**` contra `docs/business-rules/**` |
