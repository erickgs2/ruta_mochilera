# Costeo, margen y precio por vacante

Implementado en `libs/domain/costing/src/lib/pricing.ts` (cálculo puro) y
`libs/domain/costing/src/lib/budget-service.ts` (persistencia y auditoría).

## Partidas de presupuesto

Cada `TripBudgetItem` es una línea de gasto con concepto, proveedor opcional,
cantidad y monto unitario en centavos. Su total es
`quantity × unit_amount_cents`.

Validación: `quantity > 0` y `unit_amount_cents > 0`. Una partida gratuita o de
cantidad cero no es una partida — se rechaza con `VALIDATION_FAILED`.

## La fórmula

```
budget_total_cents = Σ (quantity × unit_amount_cents)

PERCENTAGE       total_with_margin = round(budget_total × (10000 + margin_value) / 10000)
FIXED_TOTAL      total_with_margin = budget_total + margin_value
FIXED_PER_SEAT   total_with_margin = budget_total + (margin_value × total_capacity)

suggested_price_per_seat_cents = redondeo HACIA ARRIBA al peso completo
                                  de (total_with_margin / total_capacity)
```

El redondeo es **siempre hacia arriba** (`roundUpToPeso`, en
`@rm/shared-utils`): la agencia jamás debe vender una vacante por debajo de su
propio costo a causa de un remanente de redondeo. Ejemplo: repartir
$1,000.00 entre 3 vacantes da $333.3333... por vacante, que se cobra como
$334.00, no $333.00.

`total_capacity = 0` se rechaza como `INVALID_CAPACITY` antes de llegar a la
división — nunca se divide entre cero, y un viaje sin vacantes no tiene precio
que calcular.

## ⚠️ La unidad de `margin_value` cambia según `margin_mode`

Esta es la trampa más peligrosa de todo el módulo. `margin_value` es **siempre
un entero** — el dinero nunca toca punto flotante — pero el mismo número
entero significa tres cosas completamente distintas según el modo. Un `2000`
es una entrada legítima en los tres modos y produce tres precios de venta
totalmente diferentes.

| `margin_mode` | Unidad de `margin_value` | Ejemplo | Significado |
|---|---|---|---|
| `PERCENTAGE` | **puntos base** (1/100 de 1 %) | `1500` | 15.00 % sobre el presupuesto |
| `FIXED_TOTAL` | **centavos** | `600000` | $6,000.00 MXN sumados al total del presupuesto |
| `FIXED_PER_SEAT` | **centavos** | `30000` | $300.00 MXN sumados por cada vacante del cupo |

Nunca se debe mover un `margin_value` crudo de un modo a otro sin convertirlo
primero: el mismo entero interpretado bajo un modo distinto no es un error de
redondeo, es un precio de venta equivocado.

## Precio automático contra precio manual (`price_mode`)

- **`AUTO`**: `price_per_seat_cents` se recalcula con la fórmula anterior cada
  vez que cambia una partida del presupuesto, el margen o el cupo total.
- **`MANUAL`**: el administrador captura el precio a mano y ese es el que se
  cobra. El cálculo automático **no desaparece**: se sigue calculando y se
  reporta como `suggested_price_per_seat_cents` junto con el precio manual, para
  que el administrador siempre vea qué tan lejos está su precio del que sugiere
  el presupuesto. Guardar `MANUAL` sin capturar un precio (o con un precio
  cero o negativo) es `VALIDATION_FAILED`.
- Cambiar de `MANUAL` de vuelta a `AUTO` recalcula el precio de inmediato a
  partir del presupuesto vigente; el precio manual anterior se descarta.

## Una sola fuente de verdad: `persistCosting`

`budget-service.ts` tiene una única función, `persistCosting`, que
escribe las columnas `budget_total_cents` y `price_per_seat_cents` del viaje.
Agregar, editar o eliminar una partida, y cambiar la política de margen o de
precio, terminan **siempre** llamándola. Ninguna otra ruta del código escribe
esas dos columnas directamente — así es como se garantiza que nunca queden
desincronizadas de las partidas que las produjeron.

Desde la Tarea 14, `persistCosting` tiene un segundo punto de entrada:
`repriceTrip`, exportado para que `libs/domain/trips`'s `updateTrip` pueda
volver a calcular el precio cuando cambia `total_capacity` — un divisor de la
fórmula que vive fuera de este paquete. Ver
`docs/business-rules/trips.md#cambiar-el-cupo-recalcula-el-precio-del-viaje`.
`repriceTrip` no agrega ninguna entrada nueva a `audit_logs`: el recálculo es
consecuencia determinista de la escritura de `total_capacity`, que
`updateTrip` ya audita por su cuenta.

## Editar el presupuesto de un viaje ya publicado

Volver a calcular el presupuesto de un viaje `PUBLISHED` recalcula
`budget_total_cents` y, en modo `AUTO`, también `price_per_seat_cents` del
viaje. **Esto no afecta ninguna reserva existente.**

La Fase 1 todavía no tiene el modelo `Reservation`: no hay nada que este
código pudiera tocar por accidente hoy. Pero la regla que gobierna a la Fase 2
ya queda fijada aquí para cuando ese modelo exista: cada reserva congela su
propio `total_price_cents` en el momento en que se crea, y recalcular el
presupuesto o el margen del viaje **nunca** debe modificar ese total ya
congelado. Propagar un precio nuevo a reservas ya existentes es una operación
explícita y distinta (Fase 2), que además exige notificar a las personas
afectadas — no un efecto secundario silencioso de editar una partida de gasto.

## Auditoría

Cada mutación queda registrada en `audit_logs` dentro de la misma transacción
que el cambio: `trip.budget_item_added`, `trip.budget_item_updated`,
`trip.budget_item_deleted` y `trip.pricing_policy_changed`.
