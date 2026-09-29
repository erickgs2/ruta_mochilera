# Flujo de costeo y precio por vacante

```mermaid
flowchart TD
    A[Vista de costeo del viaje] --> B["Agrega/edita/elimina partida:<br/>concepto, proveedor,<br/>cantidad, monto unitario"]
    B --> C{"¿quantity > 0 y<br/>unit_amount_cents > 0?"}
    C -- No --> D[VALIDATION_FAILED]
    C -- Sí --> E[(Transacción:<br/>trip_budget_item + audit_log)]
    E --> F["budget_total_cents = suma de<br/>quantity × unit_amount_cents"]
    F --> G{margin_mode}
    G -- PERCENTAGE --> H["total = budget × (10000 + margin_value) / 10000<br/>margin_value en PUNTOS BASE"]
    G -- FIXED_TOTAL --> I["total = budget + margin_value<br/>margin_value en CENTAVOS"]
    G -- FIXED_PER_SEAT --> J["total = budget + margin_value × cupo<br/>margin_value en CENTAVOS por vacante"]
    H --> K{"¿total_capacity > 0?"}
    I --> K
    J --> K
    K -- No --> K1[INVALID_CAPACITY]
    K -- Sí --> L["suggested_price_per_seat_cents =<br/>redondeo hacia arriba al peso completo<br/>de total / total_capacity"]
    L --> M{price_mode}
    M -- AUTO --> N[price_per_seat_cents = suggested]
    M -- MANUAL --> O["price_per_seat_cents lo fija<br/>el administrador;<br/>suggested se sigue mostrando,<br/>nunca se descarta"]
    N --> P[(persistCosting:<br/>única escritura de<br/>budget_total_cents y<br/>price_per_seat_cents)]
    O --> P
    P --> Q{"¿El viaje ya está PUBLISHED<br/>o tiene reservas? (Fase 2)"}
    Q -- No --> R[Listo: la vista de costeo<br/>muestra el nuevo total y precio]
    Q -- Sí --> S["Reservas existentes conservan<br/>su total_price_cents congelado.<br/>Propagar el nuevo precio es la<br/>operación explícita de cambio<br/>de precio (Fase 2), con aviso<br/>a las personas afectadas"]
```

## Notas de lectura

- Los tres caminos de `margin_mode` (`H`, `I`, `J`) convergen en el mismo nodo
  `K`: la validación de cupo y el redondeo hacia arriba son idénticos sin
  importar cómo se calculó `total_with_margin`.
- El nodo `P` es deliberadamente el único punto de escritura de
  `budget_total_cents` y `price_per_seat_cents` en todo el diagrama —
  corresponde a `persistCosting` en `budget-service.ts`. Cualquier flecha
  que terminara escribiendo esas columnas por otro camino sería un defecto.
- El nodo `Q`/`S` documenta una regla que todavía no tiene código que la
  ejecute: la Fase 1 no tiene modelo `Reservation`, así que hoy esa rama nunca
  se toma con datos reales. Queda fijada aquí para que la Fase 2 la respete
  desde el primer commit que introduzca reservas.
- `persistCosting` tiene un segundo punto de entrada desde la Tarea 14:
  `repriceTrip`, que `updateTrip` (`libs/domain/trips`, ver
  `trip-creation.md`) llama dentro de su propia transacción cuando cambia
  `total_capacity`. No aparece como una rama nueva en este diagrama porque no
  agrega ninguna decisión de negocio propia — sólo un segundo llamador del
  mismo nodo `P`.
