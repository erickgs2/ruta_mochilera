# Pagos

Implementado en `libs/domain/payments`. Corresponde a §5.4 y §5.5 de
`docs/superpowers/specs/2026-10-03-fase-2a-reservas-y-pagos-diseno.md`.

Todo el dinero es `Int` en centavos MXN. No hay un solo `Float` en el camino,
y la única división en coma flotante del módulo —la de la mensualidad
sugerida— produce un valor que se recalcula en cada lectura y **nunca llega a
una columna**.

## Saldo

```
balance_cents = total_price_cents − paid_cents        (nunca negativo)
```

`paid_cents` está desnormalizado a propósito y lo mueve **la misma
transacción** que escribe el `Payment` que lo causa. La verdad son siempre las
filas de `payments`; la conciliación nocturna (`reconcilePaidCents`, ver más
abajo) compara la suma de los pagos `SUCCEEDED` contra `paid_cents` y avisa si
se desvían. Un pago registrado sin mover `paid_cents`, o al revés, es
desviación permanente.

`credit_cents` (saldo a favor) se declara desde la Fase 2A pero sólo nace de
una bajada de precio, que es Fase 2B. Aquí siempre vale 0.

## Un pago pendiente no reduce el saldo

Un `Payment` en `PENDING` —la ficha de OXXO es el caso de siempre— se registra
y **no toca `paid_cents`**. La app lo muestra como pendiente, con su ficha
descargable y su plazo, y advierte que el lugar se libera si no se confirma a
tiempo.

Es la regla que sostiene toda la experiencia de OXXO: el dinero no existe
hasta que el proveedor lo confirma, y el cupo tampoco se compromete por una
ficha impresa.

Consecuencia aceptada: como las fichas pendientes no reducen el saldo, pueden
emitirse dos por el total y confirmarse las dos. Eso genera un sobrepago, que
la Fase 2B convierte en saldo a favor. Registrarlo igual es lo correcto —
dinero que se movió tiene que verse—; rechazar la segunda confirmación dejaría
un cobro real sin asiento contable.

## Registro de un pago

`recordPayment(tx, …)` recibe la transacción de quien lo llama (el webhook de
Stripe hoy, el cobro en sucursal y la importación CSV en la 2B) y nunca abre
la suya. Dentro de esa transacción:

1. El monto debe ser un entero de centavos **mayor que cero**.
2. Si trae `provider_intent_id`, no puede existir ya otro pago con ese intento
   → `CONFLICT`. Se comprueba **antes** que el saldo: un reenvío es un
   duplicado diga lo que diga el saldo, y el orden contrario respondería
   `PAYMENT_EXCEEDS_BALANCE` a la segunda entrega de un pago que ya liquidó la
   reserva — "este pago está mal" cuando la verdad es "este pago ya está".
3. Se bloquea la fila de la reserva (`SELECT … FOR UPDATE`) y sólo después se
   lee el saldo. Sin el bloqueo, dos pagos simultáneos leen el mismo saldo,
   los dos caben y la reserva queda pagada de más.
4. El monto no puede superar `balance_cents` → `PAYMENT_EXCEEDS_BALANCE`.
5. Se inserta el `Payment`. `paid_at` es la fecha en que el dinero se movió —
   se rellena con "ahora" para un pago que nace `SUCCEEDED` y queda nulo
   mientras esté `PENDING`—, separada de `recorded_at`, que es cuándo se
   capturó. Los reportes leen `paid_at`, así que un pago de marzo capturado en
   septiembre aparece en marzo.
6. Si el pago nace `SUCCEEDED`, se aplica al saldo (abajo).
7. Se escribe la entrada de auditoría `payment.recorded`.

**El estado de la reserva no se comprueba.** Un pago de una reserva
`CANCELLED` o `EXPIRED` se registra igual; lo que no hace es cambiarle el
estado (ver el caso límite más abajo).

## Umbral del anticipo: de `HELD` a `ACTIVE`

Al aplicarse un pago confirmado:

```
paid_cents += amount_cents

si reserva.status = 'HELD' y paid_cents >= minimum_deposit_cents:
    status := 'ACTIVE'  y  hold_expires_at := NULL     (en el mismo UPDATE)
```

El umbral es acumulado, no por pago: dos abonos de 400.00 y 600.00 cubren un
anticipo de 1,000.00 igual que uno solo.

Anular `hold_expires_at` **en la misma sentencia** no es cosmético. La
restricción `reservations_held_requires_hold_expiry` sólo obliga en una
dirección (`HELD` ⇒ expiración no nula), así que una reserva `ACTIVE` que
conservara su expiración es un estado que la base acepta y que el dominio
considera un sinsentido: un lugar tomado que sigue contando hacia atrás.

Un pago que no alcanza el anticipo deja la reserva en `HELD` con su apartado
corriendo. No hay anticipo "parcial" que cambie nada.

### Tarea 8: la activación es `updateMany`, no `update` por `id`

La segunda escritura (`HELD` → `ACTIVE`) se hizo `updateMany({ where: { id,
status: 'HELD' }, ... })` a partir de la Tarea 8, en vez del `update` por
`id` a solas que tenía desde la Tarea 5. Es un refuerzo, no la corrección de
un error demostrable: la primera escritura de `applyConfirmedPayment` ya
relee la fila bajo el bloqueo que esta misma función (o `recordPayment`,
según el camino) sostiene durante toda la transacción, y el `if` que guarda
la segunda escritura ya se niega a dispararse salvo que esa lectura fresca
diga `HELD` — ninguna secuencia de eventos, concurrente o no, logró que el
`update` sin condición se comportara distinto del `updateMany` condicional
(la prueba "does not resurrect..." en `payment-service.spec.ts` pasa contra
el código viejo también). Se escribe así de todos modos porque `expireHolds`
(`apps/worker`, Tarea 8) es el primer otro escritor que compite de verdad por
esta misma fila, y esta forma es correcta **por su propia cláusula `WHERE`**
en vez de serlo sólo porque alguna otra función sostiene un bloqueo durante
un tiempo determinado — el mismo criterio que ya usa la transición
`PENDING` → `SUCCEEDED` de `confirmPayment`, dos párrafos más abajo.

La mitad complementaria de esta misma garantía — que `expireHolds` tampoco
pueda resucitar ni atropellar una reservación que un pago concurrente ya
activó — vive del otro lado, en `expireHolds` mismo
(`docs/business-rules/reservations.md`, "Los jobs de fondo"), con su propia
prueba de concurrencia forzada.

## Confirmación e idempotencia

`confirmPayment(db, { providerIntentId, paidAt })` abre su propia transacción,
busca el `Payment` de ese intento y lo pasa de `PENDING` a `SUCCEEDED`,
aplicando el dinero con el mismo código que usa `recordPayment`.

Stripe reenvía webhooks, y dos entregas del mismo `payment_intent.succeeded`
pueden estar en vuelo a la vez. Dos mecanismos, y el segundo es el que
importa:

1. **Un intento, un pago.** El índice único `payments_provider_intent_id_key`
   sobre `provider_intent_id` lo garantiza pase lo que pase. La columna es
   nula para el efectivo en mostrador y para el histórico retroactivo, y
   PostgreSQL mantiene los nulos distintos en un índice único, así que esas
   filas nunca chocan entre sí. `recordPayment` además consulta antes de
   insertar, para responder `CONFLICT` en vez de abortar la transacción de
   quien llama; esa consulta es el camino normal y el índice es la red, porque
   una comprobación previa no puede ver la fila que otra transacción todavía
   no ha confirmado.
2. **La transición es condicional.** El `UPDATE` lleva `status = 'PENDING'` en
   su `WHERE`. Bajo READ COMMITTED la segunda confirmación espera el bloqueo
   de fila, reevalúa esa condición contra la fila ya confirmada y no encuentra
   nada que actualizar, así que no aplica dinero. Leer el estado y después
   escribir sin condición dejaría que dos entregas que leyeron `PENDING` las
   dos pagaran las dos.

La segunda confirmación **no es un error**: devuelve el pago tal como quedó,
para que el webhook pueda responder 200 y Stripe deje de reintentar. Vale la
primera, con su `paid_at` y su única entrada de auditoría
`payment.confirmed`.

Un pago `FAILED`, `EXPIRED` o `REFUNDED` no se puede confirmar →
`INVALID_STATUS_TRANSITION`. Esos estados los decide otro camino y un evento
`succeeded` no los deshace en silencio.

## Caso límite: pago confirmado de una reserva ya expirada

Spec §5.3. Si llega la confirmación de una ficha de OXXO después de que el
apartado expiró:

- El pago se registra como `SUCCEEDED` y `paid_cents` sube.
- La reserva **no** se reactiva: sigue `EXPIRED`.
- El aviso al cliente y al administrador lo genera el manejador del webhook
  (Tarea 10).

El dinero existe y debe verse; devolverlo o aplicarlo a otro viaje es decisión
humana. Ningún movimiento de dinero es automático.

## `reconcilePaidCents`: la conciliación nocturna (Tarea 8, §6 de la spec)

Implementado en `apps/worker/src/jobs/reconcile-paid-cents.ts` como función
pura del cliente de base (`reconcilePaidCents(db, queue)`, sin pg-boss
dentro), con cadencia **nocturna** registrada por `apps/worker/src/main.ts`
en la zona horaria de `SystemSetting['organization.timezone']` — nunca
hardcodeada, la misma regla que toda fecha de calendario de esta fase.

Para cada reservación, compara `paid_cents` contra `SUM(amount_cents)` de sus
pagos `SUCCEEDED` (`PENDING`, `FAILED`, `EXPIRED` y `REFUNDED` no cuentan: ver
"Un pago pendiente no reduce el saldo" arriba, por lo que tampoco deben
contar aquí). Si coinciden, no hace nada. Si no coinciden, llama a
`notifyAdmins` con `PAID_CENTS_MISMATCH` y los dos números, y nada más.

**No corrige el dato por su cuenta.** Alerta y para ahí. Una corrección
automática escondería el bug que causó la desviación en primer lugar —
exactamente el mismo motivo por el que ningún camino de pago mueve dinero
sin una fila `Payment` detrás (ver el caso límite de arriba). La prueba
`reconcile-paid-cents.spec.ts` ("does not correct paid_cents itself") deja
una reservación desviada, corre el job, y comprueba que `paid_cents` sigue
exactamente igual de mal que antes.

**No es idempotente, a propósito**, al contrario que `expireHolds` y
`warnExpiringHolds` (`docs/business-rules/reservations.md`, "Los jobs de
fondo"): mientras la desviación no se corrija a mano, cada corrida nocturna
vuelve a alertar. El silencio después del primer aviso se leería como "ya se
arregló", que es justo lo que no se puede asumir de un bug que nadie ha
tocado todavía.

## Mensualidad sugerida

No existe mensualidad obligatoria. El único monto exigible es el anticipo
mínimo al reservar; el compromiso es liquidar antes de `payment_deadline`.

```
months_remaining = días 01 de mes entre hoy (exclusivo) y payment_deadline
                   (inclusivo), evaluados en la zona horaria de
                   SystemSetting['organization.timezone']

suggested_monthly_cents = min(balance_cents,
                              redondeo_hacia_arriba(balance_cents /
                                                    max(months_remaining, 1)))
```

La zona horaria se lee con `organizationTimeZone` (`@rm/domain-settings`) —
antes copiada aquí, en `trips` y en `reservations`; sin cambio de regla.

**Se recalcula en cada lectura y nunca se almacena.** No hay columna para
ella, y una prueba lo comprueba contra `information_schema`: una copia
guardada quedaría obsoleta en cuanto entrara un abono.

Tres decisiones dentro de esa fórmula:

- **Redondea hacia arriba, nunca hacia abajo.** 100.00 entre tres meses son
  33.333…; sugerir 33.00 deja al cliente corto un peso cada mes y la suma de
  las mensualidades no cubre el total. Sugerir 34.00 sí lo cubre, y el último
  abono es más pequeño.
- **Nunca supera el saldo.** Redondear hacia arriba puede pasarse cuando el
  saldo es pequeño o tiene centavos (100.50 en un mes redondea a 101.00), y
  `recordPayment` rechazaría ese monto con `PAYMENT_EXCEEDS_BALANCE`. Sugerir
  una cantidad que la propia API rechaza es peor que sugerir una rara. El tope
  es además lo que hace que el último abono liquide exacto.
- **`months_remaining = 0` significa "todo".** Pasado el último día 01 no
  queda mes sobre el que repartir; la fecha límite es la fecha límite.

`payment_deadline` es una **fecha de calendario** (`@db.Date`), no un
instante: Prisma la devuelve como medianoche UTC de ese día. Leída como
instante en una zona detrás de UTC cae en el mes anterior y el cliente pierde
silenciosamente su última oportunidad de pago, así que antes de contar los
días 01 se reancla en el día de calendario de la zona de la organización. Es
el mismo cuidado que `isPastDate` aplica en `@rm/shared-utils`. El reanclaje
en sí es `endOfCalendarDay`, que vivía en este módulo y ahora está junto a
`isPastDate` y `monthStartsBetween` en `@rm/shared-utils/calendar.ts`; sin
cambio de regla.

El sistema jamás rechaza un abono por ser menor que la mensualidad sugerida.
Es motivacional: se muestra en la app y se usa en los recordatorios.

## Errores

| Código | Cuándo | HTTP |
|---|---|---|
| `VALIDATION_FAILED` | Monto que no es un entero de centavos mayor que cero | 422 |
| `NOT_FOUND` | La reserva no existe, o ningún pago lleva ese intento | 404 |
| `PAYMENT_EXCEEDS_BALANCE` | El monto supera `balance_cents` | 422 |
| `CONFLICT` | Ya existe un pago con ese `provider_intent_id` | 409 |
| `INVALID_STATUS_TRANSITION` | Confirmar un pago que no está `PENDING` | 409 |

Ningún código es nuevo: los cinco existen en el catálogo desde la Fase 1.
`PAYMENT_EXCEEDS_BALANCE` se usa aquí por primera vez.

## Qué vive dónde

| Archivo | Para qué |
|---|---|
| `libs/domain/payments/src/lib/instalment.ts` | La aritmética de la mensualidad sugerida, sin base de datos |
| `libs/domain/payments/src/lib/payment-service.ts` | Saldo, registro, confirmación, listado y la mensualidad de una reserva |
| `libs/db/prisma/migrations/20261004011500_payment_provider_intent_unique/` | El índice único que ancla la idempotencia |
| `apps/worker/src/jobs/reconcile-paid-cents.ts` | El job nocturno de conciliación (Tarea 8) |

`libs/domain/payments` es una hoja: no importa `@rm/domain-reservations` y
`@rm/domain-reservations` no lo importa a él.
