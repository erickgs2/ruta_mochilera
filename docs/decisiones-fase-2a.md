# Decisiones de la Fase 2A

Decisiones tomadas al cerrar la Fase 2A (Tareas 19 a 21 y la identidad
visual), en el orden en que se tomaron. Las de las Tareas 1 a 18 se tomaron en
la ejecución local con el esquema de subagentes y viven en su propio registro.

**Rama:** `claude/vibrant-shannon-111mkv`, sobre `feature/phase-2a-reservations-payments` (`031d702`).

---

## Decididas por el dueño del producto

### 1. SPEI queda para después

La API y el adaptador de Stripe ya aceptan SPEI (`customer_balance` con
`mx_bank_transfer`), pero la pantalla de pago sólo ofrece tarjeta y OXXO. No
se añade en esta fase. Ver `docs/diagrams/payment-flow.md`, «Tres métodos,
tres tiempos».

### 2. Sin cobro real hasta tener las claves de Stripe

Mientras no haya claves de Stripe, el sistema usa el proveedor de pagos falso
y la app muestra «pagos en línea no disponibles» para tarjeta. Es el estado
aceptado por ahora. Pendiente cuando lleguen las claves: probar el cobro con
tarjeta de prueba de punta a punta (Stripe Elements más el webhook real) y
verificar SPEI contra la cuenta real.

### 3. Las fotos de los carteles son provisionales

Las portadas de `pnpm db:seed:demo` se recortaron de los carteles y no son
definitivas. La agencia subirá sus fotos originales, o sustituirá las
actuales, desde el panel (Viajes → Imágenes); no hace falta un cambio de
código. Ver `docs/brand.md`, «Contenido de demostración».

## Tomadas durante la ejecución

### 4. Cancelar una reserva cancela también sus Payment Intents pendientes

La Tarea 19 no lo pedía. Sin esto, una ficha de OXXO seguía cobrable para una
reserva ya cancelada. `createCancelPendingPaymentIntents` se mudó de
`apps/worker` a `@rm/domain-payments` para que la API y el worker usen la misma
implementación.

### 5. Un pago que llega sobre una reserva cancelada tiene su propio aviso

`PAYMENT_AFTER_CANCELLATION`, gemelo de `PAYMENT_AFTER_EXPIRY`. Antes, el
webhook lo trataba como un pago normal y le decía al cliente cuánto le faltaba
por pagar de una reserva que ya no existía.

### 6. El historial de pagos del panel exige `payment.view`

Es un endpoint aparte del detalle de la reserva (`reservation.view`), porque el
catálogo de permisos ya separa quién ve dinero de quién ve reservas.

### 7. Rechazar una solicitud de cancelación queda sin resolver

El panel puede cancelar, pero no marcar una solicitud como «no procede». La
solicitud sigue pendiente mientras la reserva esté viva. Hace falta una columna
o un estado de resolución que ni el plan ni el esquema contemplan; está
anotado en `docs/business-rules/reservations.md`.

### 8. El cobro con tarjeta de las pruebas de extremo a extremo se hace con OXXO más el webhook

Sin claves de Stripe la app no carga Stripe Elements. Lo que hace real un pago
es el webhook en ambos casos, y eso es lo que el recorrido prueba. Ver la
decisión 2.

### 9. Tres defectos heredados corregidos en la Tarea 20

El panel se construía con `<base href="/">` aunque se sirve en `/admin/`; las
traducciones se pedían en la ruta absoluta `/assets/i18n/`, que bajo `/app/` y
`/admin/` habría dejado las dos apps sin textos; y todas las fechas salían en
inglés porque el pipe de fechas usaba un `LOCALE_ID` que nadie configuraba.
