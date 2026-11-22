-- Close holds from the audited transition, in the same transaction as the order,
-- confirmation attempt or shipment movement. All callers already write these events.
-- This is deliberately independent of the acquisition feature flag: disabling new
-- reservations must never strand holds that were acquired earlier.
-- Custom triggers are not represented by Drizzle snapshots; preserve on rebuilds.
CREATE TRIGGER stock_reservations_close_on_order_event
AFTER INSERT ON order_events
WHEN NEW.to_status IN ('CANCELLED', 'SHIPPED')
  AND NEW.from_status IS NOT NEW.to_status
BEGIN
  UPDATE stock_reservations
  SET status = CASE WHEN NEW.to_status = 'CANCELLED' THEN 'released' ELSE 'consumed' END,
      closed_at = NEW.created_at,
      closed_by = NEW.actor,
      close_reason = COALESCE(NULLIF(trim(NEW.reason), ''),
        CASE WHEN NEW.to_status = 'CANCELLED' THEN 'order_cancelled' ELSE 'order_shipped' END)
  WHERE store_id = NEW.store_id AND order_id = NEW.order_id AND status = 'active';
END;
