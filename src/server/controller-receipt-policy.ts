/** Alias o is the report_outbox row. A retired task question is history, not an unread notification. */
export const controllerReceiptPendingSql = `o.delivered_at IS NULL AND (
  o.event_kind != 'dispatch_message' OR EXISTS (
    SELECT 1 FROM dispatch_message_outbox message_delivery
    WHERE o.dispatch_id = 'message:' || message_delivery.message_id AND message_delivery.state != 'cancelled'
  )
)`
