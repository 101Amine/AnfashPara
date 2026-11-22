-- Read-only staging readiness counts. Never emit customer data or individual orders.
WITH items AS (
  SELECT store_id,order_id,sku,SUM(quantity) AS quantity
  FROM order_items GROUP BY store_id,order_id,sku
), open_items AS (
  SELECT i.* FROM items i JOIN orders o ON o.store_id=i.store_id AND o.id=i.order_id
  WHERE o.store_id='para-main' AND o.status IN ('CONFIRMING','NO_ANSWER','CONFIRMED','PACKED')
), balances AS (
  SELECT p.sku,
    (SELECT COALESCE(SUM(quantity),0) FROM inventory_movements m WHERE m.store_id=p.store_id AND m.sku=p.sku) AS physical,
    (SELECT COALESCE(SUM(quantity),0) FROM stock_reservations r WHERE r.store_id=p.store_id AND r.sku=p.sku AND r.status='active') AS reserved,
    (SELECT COALESCE(SUM(MAX(0,i.quantity-COALESCE((SELECT SUM(r.quantity) FROM stock_reservations r
      WHERE r.store_id=i.store_id AND r.order_id=i.order_id AND r.sku=i.sku AND r.status='active'),0))),0)
      FROM open_items i WHERE i.sku=p.sku AND i.store_id=p.store_id) AS unreserved
  FROM products p WHERE p.store_id='para-main'
)
SELECT
  (SELECT COUNT(*) FROM orders WHERE store_id='para-main' AND status IN ('CONFIRMING','NO_ANSWER','CONFIRMED','PACKED')) AS open_orders,
  (SELECT COUNT(DISTINCT i.order_id) FROM open_items i WHERE NOT EXISTS
    (SELECT 1 FROM stock_reservations r WHERE r.store_id=i.store_id AND r.order_id=i.order_id AND r.sku=i.sku AND r.status='active' AND r.quantity=i.quantity)) AS orders_needing_review,
  (SELECT COUNT(*) FROM orders o WHERE o.store_id='para-main' AND o.status IN ('CONFIRMING','NO_ANSWER','CONFIRMED','PACKED')
    AND NOT EXISTS(SELECT 1 FROM items i WHERE i.store_id=o.store_id AND i.order_id=o.id)) AS open_orders_without_items,
  (SELECT COUNT(*) FROM balances WHERE physical-reserved<0) AS current_shortfall_skus,
  (SELECT COUNT(*) FROM balances WHERE physical-reserved-unreserved<0) AS projected_shortfall_skus,
  (SELECT COUNT(*) FROM stock_reservations r JOIN orders o ON o.id=r.order_id AND o.store_id=r.store_id
    WHERE r.store_id='para-main' AND r.status='active' AND o.status NOT IN ('CONFIRMING','NO_ANSWER','CONFIRMED','PACKED')) AS stranded_active_holds,
  (SELECT COUNT(*) FROM stock_reservations r WHERE r.store_id='para-main' AND r.status='active'
    AND NOT EXISTS(SELECT 1 FROM items i WHERE i.store_id=r.store_id AND i.order_id=r.order_id AND i.sku=r.sku AND i.quantity=r.quantity)) AS mismatched_active_holds,
  (SELECT COUNT(*) FROM orders WHERE store_id='para-main' AND status IN ('CONFIRMING','NO_ANSWER','CONFIRMED','PACKED')
    AND utm_source='staging-test' AND note IN ('STAGING_LIFECYCLE','STAGING_LIFECYCLE_ARCHIVED')) AS open_synthetic_marked_orders;
