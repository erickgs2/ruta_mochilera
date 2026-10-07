import type { Locale } from '@rm/db';

/**
 * The closed set of events a `NotificationDelivery` row can carry.
 *
 * `NotificationDelivery.eventType` is a plain `String` column on purpose
 * (Task 2 decision: Phase 3 adds more event types without a migration), so
 * PostgreSQL cannot reject a typo the way an enum column would. This union
 * -- and the exhaustive `Record<DeliveryEventType, …>` below, which is a
 * compile error if a member is ever added here without a template for it --
 * is the domain-boundary enforcement that replaces the missing CHECK
 * constraint. Every write path in `delivery-service.ts` only ever accepts
 * a `DeliveryEventType`, never a raw string, so a value outside this list
 * can never reach the column.
 */
export type DeliveryEventType =
  | 'HOLD_EXPIRING'
  | 'HOLD_EXPIRED'
  | 'PAYMENT_CONFIRMED'
  | 'PAYMENT_FAILED'
  | 'VOUCHER_EXPIRED'
  | 'PAYMENT_AFTER_EXPIRY'
  | 'PAYMENT_AFTER_CANCELLATION'
  | 'RESERVATION_CANCELLED'
  | 'CANCELLATION_REQUESTED'
  | 'CANCELLATION_DECLINED'
  | 'ORPHAN_PAYMENT'
  | 'PAID_CENTS_MISMATCH';

/** Iterable form of the union above, for tests and for anything that needs every member at runtime. */
export const DELIVERY_EVENT_TYPES: readonly DeliveryEventType[] = [
  'HOLD_EXPIRING',
  'HOLD_EXPIRED',
  'PAYMENT_CONFIRMED',
  'PAYMENT_FAILED',
  'VOUCHER_EXPIRED',
  'PAYMENT_AFTER_EXPIRY',
  'PAYMENT_AFTER_CANCELLATION',
  'RESERVATION_CANCELLED',
  'CANCELLATION_REQUESTED',
  'CANCELLATION_DECLINED',
  'ORPHAN_PAYMENT',
  'PAID_CENTS_MISMATCH',
];

export interface RenderedNotification {
  subject: string;
  body: string;
}

type TemplateFn = (params: Record<string, string>) => RenderedNotification;
type LocaleTemplates = Record<Locale, TemplateFn>;

/** Replaces every `{{key}}` with `params[key]`. A missing key is left visible rather than throwing. */
function interpolate(text: string, params: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (match, key: string) => params[key] ?? match);
}

function template(subject: string, body: string): TemplateFn {
  return (params) => ({ subject: interpolate(subject, params), body: interpolate(body, params) });
}

/**
 * One subject/body pair per `DeliveryEventType` per `Locale`.
 *
 * Lives in the domain, not in `libs/i18n`'s Angular catalogues: these
 * strings are rendered by the server at send time and stored verbatim in
 * `rendered_title`/`rendered_body` (business rule in `notifications.md`).
 * The i18n catalogues are for text Angular renders at *display* time, which
 * is a different moment with a different audience (the live UI, not a
 * permanent record).
 *
 * Declared `Record<DeliveryEventType, LocaleTemplates>` on purpose: adding a
 * member to `DeliveryEventType` without adding its entry here fails to
 * compile, the same mechanism `STATUS_BY_CODE` uses for `DomainErrorCode`.
 */
const TEMPLATES: Record<DeliveryEventType, LocaleTemplates> = {
  HOLD_EXPIRING: {
    es: template(
      'Tu apartado para {{tripName}} está por expirar',
      'Tu apartado para {{tripName}} expira el {{holdExpiresAt}}. Completa tu depósito mínimo antes de esa fecha para no perder tu lugar.'
    ),
    en: template(
      'Your hold for {{tripName}} is about to expire',
      'Your hold for {{tripName}} expires on {{holdExpiresAt}}. Complete your minimum deposit before then to keep your seat.'
    ),
  },
  HOLD_EXPIRED: {
    es: template(
      'Tu apartado para {{tripName}} expiró',
      'Tu apartado para {{tripName}} expiró y tu lugar fue liberado. Si todavía quieres viajar, crea una nueva reservación.'
    ),
    en: template(
      'Your hold for {{tripName}} expired',
      'Your hold for {{tripName}} expired and your seat was released. If you still want to go, create a new reservation.'
    ),
  },
  PAYMENT_CONFIRMED: {
    es: template(
      'Recibimos tu pago para {{tripName}}',
      'Recibimos tu pago de {{amount}} para {{tripName}}. Tu saldo restante es de {{balance}}.'
    ),
    en: template(
      'We received your payment for {{tripName}}',
      'We received your payment of {{amount}} for {{tripName}}. Your remaining balance is {{balance}}.'
    ),
  },
  PAYMENT_FAILED: {
    es: template(
      'No pudimos procesar tu pago para {{tripName}}',
      'No pudimos procesar tu pago para {{tripName}}. Motivo: {{reason}}. Por favor intenta de nuevo.'
    ),
    en: template(
      "We couldn't process your payment for {{tripName}}",
      "We couldn't process your payment for {{tripName}}. Reason: {{reason}}. Please try again."
    ),
  },
  // Business rule 5.3, customer side. An OXXO slip that reached its deadline
  // unpaid is not a declined payment: nothing was refused, the time simply
  // ran out, and `PAYMENT_FAILED`'s "try again" wording would be wrong about
  // what happened. Carries no `{{reason}}`: the reason is the event.
  VOUCHER_EXPIRED: {
    es: template(
      'Tu ficha de OXXO para {{tripName}} venció',
      'Tu ficha de OXXO para {{tripName}} venció sin registrarse el pago, así que no se aplicó ningún cargo. Si todavía quieres viajar, genera una ficha nueva desde la app.'
    ),
    en: template(
      'Your OXXO voucher for {{tripName}} expired',
      'Your OXXO voucher for {{tripName}} expired with no payment recorded, so nothing was charged. If you still want to go, generate a new voucher from the app.'
    ),
  },
  // Business rule 5.3, the race the spec singles out: money arrived for a
  // reservation whose hold had already expired. Deliberately *not*
  // `PAYMENT_CONFIRMED`, which would quote a remaining balance and read as
  // "you are going" -- the seat was released and giving it back is a human
  // decision, so this says the money is recorded and someone will be in
  // touch, and quotes no balance at all.
  PAYMENT_AFTER_EXPIRY: {
    es: template(
      'Recibimos tu pago para {{tripName}}, pero tu apartado ya había vencido',
      'Recibimos tu pago de {{amount}} para {{tripName}}, pero tu apartado ya había vencido y el lugar se liberó. Tu pago está registrado y nadie lo va a perder: un asesor te contactará para resolverlo contigo.'
    ),
    en: template(
      'We received your payment for {{tripName}}, but your hold had already expired',
      'We received your payment of {{amount}} for {{tripName}}, but your hold had already expired and the seat was released. Your payment is on record and will not be lost: someone from the team will contact you to sort it out.'
    ),
  },
  // Task 19: the counterpart of `PAYMENT_AFTER_EXPIRY` for a reservation
  // staff cancelled while a voucher or card intent was still payable. Same
  // promise -- the money is recorded and a person will follow up -- and, like
  // it, no balance: there is no seat left for a balance to be owed on.
  PAYMENT_AFTER_CANCELLATION: {
    es: template(
      'Recibimos tu pago para {{tripName}}, pero tu reservación ya estaba cancelada',
      'Recibimos tu pago de {{amount}} para {{tripName}}, pero tu reservación ya estaba cancelada. Tu pago está registrado y quedó como saldo a favor en tu cuenta: puedes verlo en «Mi cuenta» y un asesor te contactará para decidir contigo cómo usarlo.'
    ),
    en: template(
      'We received your payment for {{tripName}}, but your reservation had already been cancelled',
      'We received your payment of {{amount}} for {{tripName}}, but your reservation had already been cancelled. Your payment is on record and is now account credit: you can see it under My account, and someone from the team will contact you to decide how to use it.'
    ),
  },
  RESERVATION_CANCELLED: {
    es: template(
      'Tu reservación para {{tripName}} fue cancelada',
      'Tu reservación para {{tripName}} fue cancelada. Motivo: {{reason}}.'
    ),
    en: template(
      'Your reservation for {{tripName}} was cancelled',
      'Your reservation for {{tripName}} was cancelled. Reason: {{reason}}.'
    ),
  },
  // Staff decided the reservation goes ahead (§5.6): the customer's request
  // is closed, nothing about the reservation changed, and the customer can
  // ask again from the app.
  CANCELLATION_DECLINED: {
    es: template(
      'Tu solicitud de cancelación para {{tripName}} no procedió',
      'Revisamos tu solicitud de cancelación para {{tripName}} y tu reservación sigue en pie. Motivo: {{reason}}. Si tienes dudas, escríbenos.'
    ),
    en: template(
      'Your cancellation request for {{tripName}} was declined',
      'We reviewed your cancellation request for {{tripName}} and your reservation stands. Reason: {{reason}}. If you have questions, get in touch.'
    ),
  },
  // The remaining four event types are staff-only alerts, delivered through
  // `notifyAdmins` rather than `notifyCustomer` (see delivery-service.ts).
  CANCELLATION_REQUESTED: {
    es: template(
      'Solicitud de cancelación: {{reservationCode}}',
      '{{customerName}} solicitó cancelar la reservación {{reservationCode}}. Motivo: {{reason}}. Revisa y resuelve la solicitud.'
    ),
    en: template(
      'Cancellation request: {{reservationCode}}',
      '{{customerName}} requested to cancel reservation {{reservationCode}}. Reason: {{reason}}. Please review and resolve it.'
    ),
  },
  ORPHAN_PAYMENT: {
    es: template(
      'Pago huérfano de {{provider}} sin reservación',
      'Se confirmó un pago por {{amount}} de {{provider}} (intent {{intentId}}) que no corresponde a ninguna reservación activa. Revísalo manualmente.'
    ),
    en: template(
      'Orphan {{provider}} payment with no reservation',
      'A payment of {{amount}} from {{provider}} (intent {{intentId}}) was confirmed with no matching active reservation. Please review it manually.'
    ),
  },
  PAID_CENTS_MISMATCH: {
    es: template(
      'Desviación de saldo en la reservación {{reservationCode}}',
      'La reconciliación nocturna encontró una diferencia en la reservación {{reservationCode}}: se esperaba {{expected}} y se encontró {{actual}}. Revísalo manualmente.'
    ),
    en: template(
      'Balance drift on reservation {{reservationCode}}',
      "Nightly reconciliation found a mismatch on reservation {{reservationCode}}: expected {{expected}} but found {{actual}}. Please review it manually."
    ),
  },
};

/** Renders the subject and body for one event, in one locale, with `params` interpolated. */
export function renderTemplate(
  eventType: DeliveryEventType,
  locale: Locale,
  params: Record<string, string>
): RenderedNotification {
  return TEMPLATES[eventType][locale](params);
}
