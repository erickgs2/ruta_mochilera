# Decisiones de la Fase 2B

Decisiones tomadas al construir y cerrar la Fase 2B (el mostrador opera),
agrupadas por quién las tomó. Las del diseño original están en la spec
(`docs/superpowers/specs/2026-10-07-fase-2b-mostrador-diseno.md`, §2 y
«Cambios respecto del diseño general»); aquí van las que se tomaron o se
confirmaron después, al implementar.

**Estado:** las Tareas 1 a 14 están en `main` (`934c971`). La Tarea 15
(extremo a extremo, documentación y cierre) se trabaja en ramas aparte.

---

## Decididas por el dueño del producto

### 1. Una bajada de precio resta lo pagado de más de la reserva

Si bajar el precio deja a un cliente pagado de más, el excedente **sale de
`paid_cents`** de la reserva cuando se vuelve saldo a favor (`PRICE_DECREASE`).
Sin esa resta, el mismo dinero existiría dos veces —en la reserva y en el
saldo— y una subida de precio posterior, o una cancelación, se lo entregaría de
nuevo al cliente.

Consecuencias:

- `paid_cents` es siempre lo que la reserva conserva, y la cancelación acredita
  exactamente eso.
- La conciliación nocturna (`reconcilePaidCents`) compara `paid_cents` contra
  los pagos `SUCCEEDED` **menos** los `PRICE_DECREASE` de la reserva. La spec
  decía que la conciliación «no cambia»; con esta decisión sí cambia, y la
  spec (§5.6, paso 3) ya recoge la corrección.
- El historial de pagos no se toca: los pagos siguen ahí, con sus recibos.

Ver `docs/business-rules/reservations.md`, «Cambio de precio», y
`docs/diagrams/customer-credit.md`, «Cómo nace el saldo».

### 2. Las importaciones CSV corren en el worker, con progreso y sin reintento automático

5,000 filas, cada una en su transacción y quizá con su invitación por correo,
tardan minutos: más de lo que una petición HTTP aguanta detrás de Nginx. Por
eso aplicar un lote lo encola (`APPLY_IMPORT`, en `apps/worker`) y el panel
consulta el lote hasta que deja de estar `APPLYING`. El worker guarda su
avance en el reporte cada 100 filas.

**Una caída a medias NO se reintenta sola.** Una fila de pago sin
`external_ref` no se distingue de una segunda copia de sí misma, así que
reintentar podría duplicar pagos. El lote se queda `APPLYING` con su reporte
parcial para que una persona decida. El job se encola con `retryLimit: 0` y
una hora de plazo. **Se recomienda llenar `external_ref` en las filas de
pago**: es lo que hace seguro volver a subir un archivo.

Ver `docs/business-rules/imports.md`, «Por qué en el worker» y «No se reintenta
solo», y `docs/diagrams/counter-sale.md`, «Importar clientes y pagos desde
CSV».

### 3. Los recibos son privados

- La ruta pública de archivos (`/api/v1/files/...`) **rechaza** el prefijo
  `receipts/` con el mismo 404 de un archivo que no existe. Un recibo sólo se
  sirve por rutas que verifican quién pregunta: la del cliente dueño del pago
  (`/payments/{id}/receipt`) o la del personal con `payment.view`
  (`/admin/payments/{id}/receipt`).
- El nombre en el almacenamiento lleva una parte aleatoria:
  `receipts/{año}/{folio}-{uuid}.pdf`. Los folios son consecutivos y por tanto
  adivinables; la parte aleatoria mantiene la llave impredecible aunque un
  bucket se expusiera más de lo debido. (El plan decía `receipts/{año}/{folio}.pdf`.)
- **Con S3, la carpeta `receipts/` no debe ser pública.** El bucket debe
  servir `receipts/` sin lectura anónima; el resto de las imágenes sí se sirven
  directo del bucket.

### 4. La descarga del recibo en la app de Capacitor queda pendiente

En el navegador, la app descarga el PDF con un `Blob` y un enlace de descarga
(`apps/client/src/app/shared/save-file.ts`). Dentro del empaquetado de
Capacitor eso probablemente no basta: guardar o compartir un archivo en el
teléfono necesita un plugin nativo. Se deja pendiente. El recibo adjunto por correo
(`SEND_RECEIPT`) no depende de esto.

### 5. Las Tareas 1 a 14 entraron directo a `main`, sin pull request

A diferencia de la Fase 2A (que se integró con el PR #1), las Tareas 1 a 14 de
la 2B aterrizaron directamente en `main`. Por eso **CI y `docs-guard` no
corrieron como pull request** sobre ese trabajo: la regla de «documentación
obligatoria en el mismo commit» no tuvo guardián automático en esas tareas.

---

## Registradas en la spec y el plan

Estas ya constan en la spec (§2); se repiten aquí para que el registro de
decisiones esté en un solo lugar.

### 6. El dinero de una reserva cancelada se vuelve saldo a favor

Decisión del dueño (2026-10-07). El diseño general sólo hacía nacer saldo de
una bajada de precio. Ahora también nace de **cancelar** una reserva con
`paid_cents > 0` y de los ajustes manuales. La reserva cancelada **conserva** su
`paid_cents` y sus pagos: el registro contable no se borra, y el movimiento
`CANCELLATION` sólo refleja que ese dinero ya está disponible.

### 7. Quien cambia el saldo es la agencia, no el viajero

La respuesta del dueño dice que «el cliente» puede aumentar o disminuir su
saldo. Se interpretó como **la agencia** (el personal con
`payment.credit.apply`), siempre con motivo y en `AuditLog`: que un viajero
edite su propio saldo no tiene sentido contable. El viajero lo ve en «Mi
cuenta», sólo lectura. **Interpretación pendiente de confirmar por el dueño.**

### 8. El saldo vive por cliente, en un libro de movimientos

`Reservation.credit_cents` (diseño general §4.3) se eliminó. Un saldo que nace
en una reserva cancelada se usa en otra: no pertenece a ninguna reserva. El
saldo es la suma de `customer_credit_entries`, nunca una columna editable.

### 9. El folio del recibo sale de un contador por año, no de una secuencia

El diseño general decía una secuencia de PostgreSQL. Las secuencias no
reinician por año y dejan un hueco cada vez que una transacción se revierte; un
folio de recibo no debe saltarse. Se usa una fila por año en `receipt_counters`
bajo bloqueo, dentro de la transacción que deja el pago en `SUCCEEDED`.

### 10. Cambiar el precio de un viaje y llevarlo a las reservas son dos operaciones

Editar el precio en el costeo sigue afectando sólo reservas nuevas. La
operación explícita `trip.change_price` lleva el precio vigente a las reservas
`HELD` y `ACTIVE`, con aviso obligatorio y vista previa. El aviso es un aviso de
sistema por cliente (`PRICE_CHANGED`), no una `NotificationCampaign`: las
campañas siguen siendo de la Fase 3.

---

## Observadas en el código; por confirmar

El plan dice «donde este plan y el código difieran, manda el código». Estas
diferencias existen hoy entre la spec y el código, y ninguna está registrada
como decisión. Se anotan para que el dueño las confirme o las corrija; **no**
se tratan como decididas.

### 11. `ImportBatch` tiene un estado más: `APPLYING`

La spec (§4.5) lista `VALIDATED | APPLIED | FAILED`. El código añade
`APPLYING`: el lote que alguien confirmó y el worker está procesando (o que se
quedó a medias, decisión 2). Es lo que impide confirmar dos veces el mismo lote
y lo que el panel consulta para mostrar el progreso.

### 12. El recibo guarda la foto del saldo en el pago

La spec (§4.2) sólo menciona `receipt_key` y `receipt_sent_at`. El código
añade `receipt_total_cents` y `receipt_paid_cents`, escritos con el folio, para
que el recibo diga siempre el saldo de ese momento. Para un pago sin esas
columnas llenas, el saldo se reconstruye con los pagos hasta ese.

### 13. Una reserva `HELD` con el apartado vencido no recibe cobro

La spec (§5.3) sólo exige que la reserva esté `HELD` o `ACTIVE`. El código
responde `HOLD_EXPIRED` al cobrar en efectivo o al aplicar saldo sobre una
`HELD` cuyo apartado ya venció, aunque el job `expireHolds` aún no la haya
pasado a `EXPIRED`: su lugar ya no está garantizado y activarla podría tomar
un asiento que el mostrador devolvió.

### 14. La invitación no pasa por la bandeja de salida de pg-boss

La spec (§3) dice que el envío de recibos y avisos usa la bandeja de salida.
Las invitaciones, no: la bandeja guarda su contenido en la base y el token en
claro no debe quedar ahí. El correo sale directo tras el commit, igual que el
de restablecer contraseña; si falla, la respuesta dice `invitationSent: false`
y el personal reenvía.
