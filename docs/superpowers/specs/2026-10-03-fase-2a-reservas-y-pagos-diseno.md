# Diseño: Fase 2A — Clientes, reservas y pagos

- **Fecha:** 2026-10-03
- **Estado:** Aprobado, pendiente de plan de implementación
- **Fase anterior:** `2026-09-28-agencia-viajes-diseno.md` (Fase 1, completa: 19 tareas, 42 commits)
- **Criterio de cierre:** un cliente se registra, reserva un viaje y lo paga desde su teléfono.

> Este documento está en español. **Todo el código se escribe en inglés**, sin excepción: nombres de variables, funciones, archivos, tablas, columnas, ramas, mensajes de commit y comentarios. Sólo `docs/**` va en español, junto con los catálogos de traducción `es.json` / `en.json`, que son contenido y no código.

---

## 1. Qué construye esta fase

La Fase 1 dejó a la agencia capaz de capturar sus viajes: crearlos, costearlos, fijar su precio y publicarlos. Nadie puede comprarlos todavía.

La Fase 2A cierra esa brecha por el lado del cliente final: una aplicación donde una persona descubre un viaje, se registra, aparta su lugar y paga — con tarjeta, en OXXO o por transferencia SPEI. Al terminar, la agencia tiene ingresos entrando por un canal que no requiere que nadie esté en el mostrador.

Lo que **no** entra aquí y por qué está en §13.

---

## 2. Por qué esta fase se partió en dos

La Fase 2 original de la spec de Fase 1 describía seis subsistemas: app cliente, reservas, pasarela, cobro en sucursal, recibos e importación CSV. Es más grande que la Fase 1 completa, que tomó diecinueve tareas, y nada se habría entregado hasta tenerlo todo.

Se parte en dos mitades que cierran por separado:

- **2A (este documento):** el cliente reserva y paga desde su teléfono.
- **2B:** el mostrador opera — cobro en efectivo, alta de clientes en sucursal, recibos PDF, saldo a favor, cambio de precio con notificación e importación CSV.

El corte está puesto donde está porque 2A es autosuficiente: produce ingresos sin depender de 2B. El orden inverso —mostrador primero— también funcionaría, pero la agencia ya cobra en mostrador hoy, con papel; lo que no tiene es un canal digital.

### Tres piezas que la spec de Fase 1 asignó mal

Al planear esta fase aparecieron tres dependencias que la spec original puso en la Fase 3 y que la Fase 2 necesita para funcionar:

| Pieza | Problema | Resolución |
|---|---|---|
| Expiración de apartados | Sin ella, una reserva aparta cupo y lo retiene para siempre. Un cliente que empieza y abandona bloquea un asiento de forma permanente. | Entra en 2A |
| Conciliación nocturna de `paid_cents` | La columna se desnormaliza en cuanto existan pagos, o sea en esta fase. | Entra en 2A |
| Notificación de cambio de precio | La regla §5.6 de la Fase 1 exige crear una campaña, y el modelo de campañas es Fase 3. | El cambio de precio es 2B; en 2A se entrega la infraestructura mínima de entregas que 2B usará |

La infraestructura de trabajos en segundo plano (pg-boss) se adelanta entera a 2A, porque los tres jobs de arriba la necesitan. Las **campañas** con variables, audiencias y calendarización se quedan en la Fase 3.

---

## 3. Decisiones de arquitectura

| Área | Decisión | Razón |
|---|---|---|
| App cliente | Segunda aplicación Angular en el monorepo (`apps/client`), con librerías compartidas | Decidido en Fase 1; el panel y el cliente comparten tipos, cliente de API e i18n, no componentes |
| Distribución móvil | Capacitor con **assets empaquetados**, no `server.url` remoto | Apple rechaza contenedores de URL bajo la guía 4.2; una caída del servidor dejaría la app en blanco |
| Pasarela | Stripe México, **Payment Intents con Stripe Elements** | El formulario vive en la app; el cliente no sale a un dominio ajeno. PCI SAQ A por los iframes de Stripe |
| Métodos de pago | Tarjeta, OXXO y SPEI en 2A | OXXO y SPEI son mayoritarios en México; sin ellos 2A no sería usable en producción |
| Pagos asíncronos | El pago se muestra **pendiente** hasta que Stripe confirma; el saldo no baja antes | Un saldo que baja y vuelve a subir cuando un voucher caduca es alarmante y confuso |
| Login de clientes | Correo y contraseña, más Google y Apple Sign-In | Decidido en Fase 1. Apple es obligatorio en la App Store si existe otro login social |
| Verificación de correo | Código de 6 dígitos, una sola vez al registrarse | Decidido en Fase 1 |
| Cancelación por el cliente | **Solicitud**, no cancelación | Ningún movimiento de dinero es automático; la decisión y el destino de lo pagado son de una persona |
| Trabajos en segundo plano | pg-boss sobre el mismo PostgreSQL | Decidido en Fase 1; cero infraestructura nueva y jobs transaccionales con los datos |
| Avisos al cliente | Correo transaccional **más** bandeja mínima en la app | El correo solo deja al cliente sin historial; la bandeja mínima es la base que la Fase 3 extiende |
| Enlaces públicos | Detalle de viaje accesible por slug sin cuenta | La agencia promociona en redes; el slug ya existe y es estable por diseño |
| Moneda y zona horaria | MXN en centavos; reglas de calendario en la zona de `SystemSetting` | Heredado de Fase 1, sin cambios |

---

## 4. Modelo de datos

Se añaden seis modelos. Los nombres siguen las convenciones de Fase 1: `PascalCase` en Prisma, `snake_case` en PostgreSQL, montos `Int` en centavos MXN, fechas `timestamptz` salvo las de calendario puro.

### 4.1 Reservas

```
Reservation        id, code (folio único), trip_id, customer_id,
                   status (HELD|ACTIVE|CANCELLED|EXPIRED), hold_expires_at?,
                   total_price_cents, minimum_deposit_cents, paid_cents,
                   credit_cents, payment_deadline,
                   source (APP|BRANCH|IMPORT), created_by?,
                   cancellation_requested_at?, cancellation_reason?,
                   cancelled_at?, cancelled_by?, is_backfilled,
                   created_at, updated_at
                   único parcial (trip_id, customer_id) donde status ∈ (HELD, ACTIVE)
```

`total_price_cents` y `minimum_deposit_cents` se **congelan** al crear la reserva: editar el viaje no altera reservas existentes. Propagarlo es la operación explícita de 2B.

`paid_cents` está desnormalizado a propósito y se actualiza **en la misma transacción** que el pago. La verdad siempre son los registros `Payment`; el job de conciliación nocturna compara y alerta si divergen.

El índice único parcial impide dos reservas vivas del mismo cliente en el mismo viaje. Una reserva es una persona, decidido en Fase 1.

### 4.2 Pagos

```
Payment            id, reservation_id, amount_cents,
                   method (CARD|OXXO|SPEI|CASH|LEGACY),
                   status (PENDING|SUCCEEDED|FAILED|EXPIRED|REFUNDED),
                   paid_at?, recorded_at, provider (STRIPE|MANUAL),
                   provider_intent_id?, provider_voucher_url?,
                   voucher_expires_at?,
                   receipt_number?, receipt_key?, receipt_sent_at?,
                   recorded_by?, is_backfilled, notes,
                   created_at, updated_at

StripeEvent        stripe_event_id (único), type, payload jsonb, processed_at
```

`paid_at` separado de `recorded_at` es lo que hará funcionar la captura histórica de 2B: los reportes usan `paid_at`, así que un pago de marzo capturado en septiembre aparece en marzo.

`provider_voucher_url` y `voucher_expires_at` sólo aplican a OXXO. El voucher expira **a la vez que el apartado** (§5.3), para que el sistema nunca confirme un pago de un lugar ya liberado.

`StripeEvent` existe únicamente para idempotencia: Stripe reenvía webhooks, y sin esta tabla un reintento duplicaría un pago.

Los campos de recibo (`receipt_number`, `receipt_key`, `receipt_sent_at`) se declaran aquí pero **sólo los llena 2B**. Se incluyen ahora para no migrar la tabla dos veces.

### 4.3 Avisos

```
NotificationDelivery  id, customer_id, event_type, channel (EMAIL|INBOX),
                      rendered_title, rendered_body,
                      status (PENDING|SENT|FAILED|READ),
                      sent_at?, read_at?, error?, created_at
                      índice (customer_id, created_at)
```

Es la bandeja mínima. Cada aviso genera **dos filas**: una `EMAIL` y una `INBOX`, de modo que el cliente ve en la app exactamente lo que se le envió por correo. La Fase 3 añadirá `campaign_id`, el canal `PUSH` y las plantillas con variables; la tabla está dimensionada para absorberlo sin migración destructiva.

`event_type` es un código estable, no prosa: `HOLD_EXPIRING`, `HOLD_EXPIRED`, `PAYMENT_CONFIRMED`, `PAYMENT_FAILED`, `RESERVATION_CANCELLED`, `CANCELLATION_REQUESTED`. El texto renderizado se guarda al enviar, en el idioma del cliente.

### 4.4 Cambios a modelos existentes

```
CustomerProfile    + accepted_terms_at    (registro)
User               sin cambios estructurales
Trip               sin cambios estructurales
```

El cupo disponible sigue siendo **derivado, nunca almacenado** (§5.1 de Fase 1). Esta fase rellena el stub `committedSeats` que la Fase 1 dejó marcado, y debe corregir en el mismo movimiento el patrón N+1 que `listTrips` introduce al llamarlo por viaje (deuda registrada en Fase 1).

### 4.5 Máquinas de estado

```
Reservation   HELD ──pago confirmado ≥ anticipo──→ ACTIVE ──cancelación del admin──→ CANCELLED
               │                                      │
               └──vence hold_expires_at──→ EXPIRED     └──(solicitud del cliente no cambia el estado)

Payment       PENDING → SUCCEEDED | FAILED | EXPIRED
              SUCCEEDED → REFUNDED
```

Una reserva liquidada **no cambia de estado**: `paid_cents >= total_price_cents` es un dato derivado, porque un cambio de precio podría revertirlo.

Una solicitud de cancelación **no es un estado**: sella `cancellation_requested_at` y notifica al administrador. El estado sólo cambia cuando una persona decide.

---

## 5. Reglas de negocio

Todas viven en `libs/domain/reservations` y `libs/domain/payments`, y se documentan en `docs/business-rules/`.

### 5.1 Cupo disponible

```
available_seats = total_capacity − pre_sold_seats
                − COUNT(reservas ACTIVE)
                − COUNT(reservas HELD con hold_expires_at > now)
```

Se calcula **dentro de una transacción con bloqueo de fila sobre el viaje** (`SELECT … FOR UPDATE`). La Fase 1 dejó el cálculo escrito y el bloqueo pendiente, con un comentario que lo decía honestamente; esta fase es cuando hace falta, porque es cuando hay contención real.

Un contador almacenado es exactamente donde aparece la sobreventa cuando dos personas reservan el último lugar en el mismo segundo.

### 5.2 Crear una reserva

1. En una transacción con bloqueo sobre el viaje: verificar `available_seats ≥ 1`, que el viaje esté `PUBLISHED`, que la fecha límite de pago no haya pasado, y que el cliente no tenga ya una reserva `HELD` o `ACTIVE` en ese viaje.
2. Crear la reserva en `HELD` con `hold_expires_at = now + trip.hold_ttl_hours`, congelando `total_price_cents` y `minimum_deposit_cents`.
3. Generar el folio (`code`), legible y único.

Errores: `TRIP_SOLD_OUT`, `TRIP_NOT_PUBLISHED`, `PAYMENT_DEADLINE_PASSED`, `DUPLICATE_RESERVATION`.

**El correo del cliente debe estar verificado para reservar.** Puede navegar el catálogo y registrarse sin verificar; reservar exige `email_verified_at`. Error: `EMAIL_NOT_VERIFIED`.

### 5.3 Apartado y su expiración

El apartado dura `trip.hold_ttl_hours` (por defecto 72, configurable por viaje desde el panel).

- Al confirmarse un pago acumulado `>= minimum_deposit_cents`, la reserva pasa a `ACTIVE` y `hold_expires_at` se anula.
- Un job cada 5 minutos pasa a `EXPIRED` las reservas `HELD` vencidas, libera el lugar y **cancela en Stripe cualquier Payment Intent pendiente** de esa reserva.
- Para OXXO, la expiración del voucher se fija igual a `hold_expires_at`, de modo que el sistema nunca confirme un pago de un lugar ya liberado.

**Caso límite que debe resolverse explícitamente:** un pago OXXO confirmado por Stripe después de que el apartado expiró. El job cancela el voucher, pero una carrera es posible. La regla: si llega un `payment_intent.succeeded` para una reserva `EXPIRED`, el pago se registra como `SUCCEEDED`, la reserva **no** se reactiva automáticamente, y se genera un aviso al administrador y al cliente. El dinero existe y debe verse; devolverlo o aplicarlo a otro viaje es decisión humana. Esto es consistente con la regla de que ningún movimiento de dinero es automático.

### 5.4 Mensualidad sugerida

No existe mensualidad obligatoria. El único monto exigible es el anticipo mínimo al reservar; el compromiso es liquidar antes de `payment_deadline`.

```
months_remaining = días 01 de mes entre hoy (exclusivo) y payment_deadline (inclusivo),
                   evaluados en la zona horaria de SystemSetting

suggested_monthly_cents = redondeo hacia arriba de (balance_cents / max(months_remaining, 1))
```

Se recalcula en cada lectura y **nunca se almacena**. Es motivacional: se muestra en la app y se usa en los recordatorios. El sistema jamás rechaza un abono por ser menor.

`monthStartsBetween` ya existe en `@rm/shared-utils` desde la Fase 1, probada contra la frontera de día de Ciudad de México.

### 5.5 Pagos

- Un pago debe ser `> 0` y `<= balance_cents`. Mayor se rechaza con `PAYMENT_EXCEEDS_BALANCE`; el saldo a favor sólo nace de una bajada de precio (2B).
- `balance_cents = total_price_cents − paid_cents`, nunca negativo.
- Al confirmarse un pago, **en la misma transacción**: insertar el `Payment` en `SUCCEEDED`, incrementar `paid_cents`, y si la reserva estaba `HELD` y se alcanzó el anticipo, pasarla a `ACTIVE`.
- Los webhooks de Stripe son idempotentes por `stripe_event_id`. Un evento ya presente se descarta sin efecto.

**Un pago pendiente no reduce el saldo.** La app lo muestra como pendiente, con su ficha descargable y su plazo, y advierte que el lugar se libera si no se confirma a tiempo.

### 5.6 Solicitud de cancelación

El cliente pulsa "solicitar cancelación", escribe un motivo opcional, y el sistema sella `cancellation_requested_at`, notifica al administrador y muestra al cliente que su solicitud está en revisión. **El estado de la reserva no cambia** y el apartado sigue corriendo si estaba `HELD`.

El administrador cancela desde el panel con el permiso `reservation.cancel`, que ya existe en el catálogo desde la Fase 1 y nunca se ha usado. Al cancelar, el lugar se libera y lo pagado queda registrado; aplicarlo o devolverlo es 2B.

### 5.7 Registro y verificación

Datos: nombre completo, correo, teléfono, fecha de nacimiento, contraseña, foto de perfil opcional.

El código de verificación es de 6 dígitos y se rige por valores en `SystemSetting`, no constantes:

| Clave | Valor inicial |
|---|---|
| `otp.ttl_minutes` | 15 |
| `otp.max_attempts` | 5 |
| `otp.resend_cooldown_seconds` | 60 |
| `otp.max_resends_per_hour` | 5 |

Agotar los intentos invalida el código y obliga a pedir otro. El código se almacena **hasheado**, nunca en claro, igual que los tokens de refresco de la Fase 1.

**El login social llega con el correo ya verificado** por el proveedor y se salta el OTP. Un cliente registrado con contraseña puede vincular Google o Apple después sin duplicarse: `AuthIdentity` ya lo soporta desde la Fase 1.

**Los endpoints públicos de autenticación necesitan límite de intentos, no sólo el login.** La Fase 1 limitó `/auth/login` porque era el único expuesto; esta fase abre `/auth/register`, `/auth/verify-email`, `/auth/resend-code` y `/auth/forgot-password` a internet. Sin límite, el registro permite crear cuentas en masa, la verificación permite fuerza bruta sobre un espacio de un millón, y el reenvío convierte el sistema en un medio para bombardear el buzón de un tercero. El limitador de la Fase 1 es reutilizable y debe aplicarse a los cuatro, con sus umbrales en `SystemSetting`.

Una precisión sobre `forgot-password`: su respuesta debe ser **idéntica** exista o no la cuenta. Es la misma regla que ya protege al login de revelar qué correos están registrados, y es fácil de romper al escribir una pantalla amable que diga «no encontramos esa cuenta».

### 5.8 Catálogo público

El detalle de un viaje `PUBLISHED` es accesible por `slug` **sin cuenta**: fotos, itinerario, qué incluye, precio por vacante, fechas y lugares disponibles. El botón de reservar pide iniciar sesión.

El slug es estable por diseño desde la Fase 1 — no cambia al editar el viaje — precisamente para que un enlace compartido en redes siga funcionando.

Un viaje que deja de estar `PUBLISHED` devuelve 404 en la ruta pública, no un detalle vacío.

---

## 6. Trabajos en segundo plano

pg-boss sobre el mismo PostgreSQL, en un proceso separado (`apps/worker`). Separado a propósito: si los jobs viven dentro de Next.js, cada redespliegue mata trabajos a medias.

| Job | Frecuencia | Qué hace |
|---|---|---|
| `expire-holds` | cada 5 min | Pasa a `EXPIRED` las reservas `HELD` vencidas, libera el lugar, cancela los Payment Intents pendientes |
| `warn-expiring-holds` | cada hora | Avisa al cliente cuyo apartado está por vencer y aún no alcanza el anticipo |

El umbral de aviso es **relativo al plazo del viaje**, no una constante: se avisa cuando queda menos de un cuarto de `hold_ttl_hours`, con un mínimo de una hora. Un umbral fijo de doce horas dispararía el aviso en el instante mismo de reservar en un viaje con apartado de seis horas, y avisaría demasiado tarde en uno de una semana. El job no debe avisar dos veces por la misma reserva.
| `reconcile-paid-cents` | nocturno | Compara `paid_cents` contra la suma real de pagos `SUCCEEDED` y alerta al administrador ante cualquier desviación |

Cada job debe ser **reejecutable sin duplicar efectos**. La prueba de cada uno lo ejecuta dos veces sobre el mismo estado.

---

## 7. Integración con Stripe

- **Payment Intents** creados desde el backend, nunca desde el cliente, con el monto validado contra el saldo real de la reserva. Un cliente no puede decidir cuánto debe.
- **Stripe Elements** monta el formulario de tarjeta en iframes de Stripe dentro de la app. Los datos de tarjeta nunca tocan nuestro servidor.
- **OXXO y SPEI** se solicitan como métodos del mismo Payment Intent; Stripe devuelve la ficha o los datos de transferencia, que la app muestra y permite descargar.
- **Webhooks** en `/api/v1/webhooks/stripe`, con verificación de firma y la ruta excluida de la autenticación. Es el único endpoint público que escribe.
- **Idempotencia** por `stripe_event_id`, antes de cualquier efecto.
- **Claves**: `STRIPE_SECRET_KEY` y `STRIPE_WEBHOOK_SECRET` en el entorno, nunca en el repositorio. La clave publicable viaja al cliente y es pública por diseño.

Eventos atendidos: `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.canceled`, y los de expiración de voucher OXXO.

---

## 8. Aplicación cliente

`apps/client`, Angular en su última versión estable, standalone y con señales, empaquetada con Capacitor para iOS y Android y servida también como web responsiva.

Comparte con el panel: `@rm/api-client`, `@rm/shared-utils`, `@rm/i18n` y `@rm/auth-web`. **No comparte `@rm/ui`**: el panel es denso en datos y el cliente es mobile-first; sus componentes casi no se solapan.

Pantallas: catálogo, detalle de viaje, registro con verificación, inicio de sesión, mis reservas, detalle de reserva con saldo y plan sugerido, pago, historial de pagos, bandeja de avisos, perfil.

**La sesión del cliente usa el mismo mecanismo que el panel**: access token corto y refresh en cookie `httpOnly`. En Capacitor la cookie vive en el contenedor nativo; esto debe verificarse pronto en el plan, porque es el punto donde el modelo de sesión y el empaquetado se encuentran y ninguno de los dos se diseñó pensando en el otro.

---

## 9. Contrato de API

Nuevos endpoints bajo `/api/v1`, con los esquemas Zod de `@rm/contracts` como fuente de verdad y el documento OpenAPI y el cliente tipado generados de ahí, igual que en la Fase 1.

```
/auth/register, /auth/verify-email, /auth/resend-code,
/auth/forgot-password, /auth/reset-password,
/auth/oauth/google, /auth/oauth/apple
/public/trips, /public/trips/{slug}        (sin autenticación)
/reservations                              (crear, listar las propias, detalle)
/reservations/{id}/cancellation-request
/reservations/{id}/payment-intents         (crear intento de pago)
/payments                                  (historial propio)
/notifications                             (bandeja, marcar leído)
/webhooks/stripe                           (público, firma verificada)
```

**Un cliente sólo puede ver y tocar lo suyo.** Esto no es un permiso del catálogo RBAC —que gobierna al personal— sino una comprobación de pertenencia en cada endpoint de cliente: la reserva consultada debe ser del actor autenticado. El catálogo de permisos no se usa para clientes; su `type = CUSTOMER` lo determina, como ya impone `requirePermission` desde la Fase 1.

---

## 10. Documentación viva

Esta fase crea reglas de negocio nuevas, así que la regla de `CLAUDE.md` aplica y el guardián de CI la hará cumplir:

```
docs/business-rules/reservations.md    apartado, expiración, cancelación, cupo
docs/business-rules/payments.md        métodos, idempotencia, saldos, pagos pendientes
docs/business-rules/notifications.md   eventos, canales, bandeja
docs/diagrams/trip-reservation.md      flujo de reserva (Mermaid)
docs/diagrams/payment-flow.md          flujo de pago y confirmación asíncrona (Mermaid)
```

El guardián ya mapea `libs/domain/reservations/**` a `reservations.md` y al diagrama de reserva; ese mapeo se escribió en la Fase 1 anticipando esta fase y debe verificarse que dispara.

---

## 11. Manejo de errores

Sin cambios respecto a la Fase 1: los servicios devuelven `Result` para fallos esperables y la capa HTTP traduce a `application/problem+json` con un código estable. Códigos nuevos: `TRIP_NOT_PUBLISHED`, `PAYMENT_DEADLINE_PASSED`, `OTP_EXPIRED`, `OTP_MAX_ATTEMPTS`, `OTP_RESEND_TOO_SOON`, `RESERVATION_NOT_OWNED`, `PAYMENT_PROVIDER_ERROR`.

Cada código nuevo debe añadirse al mapa exhaustivo `STATUS_BY_CODE` y a **ambos** catálogos de traducción. La Fase 1 dejó esa exhaustividad verificada en tiempo de compilación: omitir uno rompe el build, que es el sistema funcionando.

---

## 12. Estrategia de pruebas

| Capa | Enfoque |
|---|---|
| Dominio | Pruebas unitarias sin base de datos para el cálculo de saldo, la mensualidad sugerida y las transiciones. TDD. |
| Integración | Contra PostgreSQL real con el arnés por worker de la Fase 1. **Incluye concurrencia**: dos reservas simultáneas sobre el último lugar, y dos confirmaciones del mismo Payment Intent. |
| Stripe | Webhooks simulados con fixtures del Stripe CLI: reenvíos duplicados, vouchers OXXO expirados, fallos de tarjeta, y el caso límite de §5.3. |
| Jobs | Cada job ejecutado dos veces sobre el mismo estado para verificar idempotencia. |
| App cliente | Pruebas de componente para los flujos de reserva y pago; Playwright para el recorrido completo de registro, reserva y pago con tarjeta de prueba. |

---

## 13. Fuera de alcance

**Va en 2B:** cobro en efectivo en sucursal, búsqueda y alta de clientes en mostrador, invitación por correo, recibos PDF, saldo a favor y su aplicación, cambio de precio con notificación obligatoria, e importación CSV de clientes y pagos.

**Va en Fase 3:** push con FCM, campañas con variables y audiencias, calendarización, recordatorio del día 28, alerta de riesgo del 40%, módulo de gastos reales, reportes y exportación, publicación en App Store y Google Play.

**No se construye nunca en este alcance:** reservas de varios lugares por un titular, cancelación automática por falta de pago, reembolsos automáticos, y timbrado CFDI.

---

## 14. Requisitos externos

Esta fase depende de cuentas y configuración que no se pueden crear desde el código. **El plan debe empezar por verificarlas**, porque dos de ellas bloquean trabajo:

| Requisito | Bloquea | Notas |
|---|---|---|
| Cuenta de Stripe México activada | Todo el cobro | Las claves de prueba permiten avanzar; producción exige la cuenta verificada |
| Dominio verificado en Resend (DKIM/SPF) | OTP y avisos | Sin esto el correo de verificación no llega y nadie puede registrarse |
| Proyecto de Google Cloud con IDs de cliente OAuth | Login con Google | Gratuito, rápido |
| Cuenta de desarrollador de Apple | Login con Apple | 99 USD al año. Obligatoria para publicar si existe otro login social |

El login social está construido de forma que **se desactiva por configuración**: si las cuentas no llegan a tiempo, el registro con correo y contraseña funciona igual y la fase puede cerrar.

---

## 15. Deuda heredada que esta fase debe cerrar

Registrada durante la Fase 1 y marcada como bloqueante al abrir esta:

1. **`roundUpToPeso` redondea hacia cero con negativos.** Irrelevante hasta ahora; esta fase introduce saldos y la 2B introduce reembolsos. Debe corregirse antes de que un negativo pueda alcanzarlo.
2. **`listTrips` llama `committedSeats` por viaje.** Inofensivo mientras el stub devolvía ceros; se vuelve N+1 en cuanto esta fase lo rellene. Debe pasar a una consulta agrupada en el mismo movimiento.
3. **`createStaff` y el patrón de carreras.** Ya cerrado en la ola final de la Fase 1; se menciona para que el patrón —pre-chequeo más respaldo de restricción— se aplique igual en reservas y pagos.

---

## 16. Riesgos

| Riesgo | Mitigación |
|---|---|
| Sobreventa del último lugar | Cupo derivado bajo bloqueo de fila, con prueba de integración concurrente |
| Webhook duplicado de Stripe | Idempotencia por `stripe_event_id` antes de cualquier efecto |
| Pago OXXO confirmado tras liberar el lugar | Expiración del voucher igualada al apartado, más la regla explícita de §5.3 para la carrera |
| Desviación de `paid_cents` | Actualización en la misma transacción más conciliación nocturna con alerta |
| La cookie de sesión no funciona dentro de Capacitor | Verificarlo en las primeras tareas del plan, no al final |
| El correo de verificación no llega | Dominio verificado en Resend antes de empezar; sin esto nadie se registra |
| Rechazo en App Store | Assets empaquetados más plugins nativos reales; Apple Sign-In presente si hay login social |
