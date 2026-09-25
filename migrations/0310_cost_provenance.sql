-- 0310_cost_provenance: where a reconciled amount came from, and whether a
-- cost row is synthetic (spec 25: report actual, estimated, reserved and
-- unknown amounts separately and never fabricate provider cost data; spec 29:
-- synthetic fixtures are clearly labeled and never mixed into live reporting).
-- Additive only: no existing column, CHECK constraint or amount is changed.

-- Basis of a reconciled reservation's actual_usd_micros, copied from the
-- reconcile source:
--   provider_reported / gateway_reported  the provider or gateway reported the charge
--   manual                                a named human entered it from the provider's billing history
--   computed_from_usage                   this application computed it from usage at list
--                                         price because the provider reported no charge. It is
--                                         NOT provider-reported, although it still counts toward
--                                         every limit (cost_status stays 'actual' for the limits).
-- NULL = not reconciled with a known amount.
ALTER TABLE budget_reservations ADD COLUMN cost_basis TEXT CHECK (cost_basis IS NULL OR cost_basis IN ('provider_reported', 'gateway_reported', 'computed_from_usage', 'manual'));

-- 1 = a fixture, sandbox or demo row: no real charge. Such rows still count
-- toward the limits (the checks stay conservative) and are labeled SYNTHETIC
-- wherever spend is shown.
ALTER TABLE budget_reservations ADD COLUMN is_synthetic INTEGER NOT NULL DEFAULT 0 CHECK (is_synthetic IN (0, 1));
ALTER TABLE cost_ledger ADD COLUMN is_synthetic INTEGER NOT NULL DEFAULT 0 CHECK (is_synthetic IN (0, 1));

-- Backfill from what was already recorded (nothing is guessed): the source of
-- the ledger entry written when the reservation was reconciled ...
UPDATE budget_reservations
   SET cost_basis = (
     SELECT cl.source FROM cost_ledger cl
      WHERE cl.reservation_id = budget_reservations.id
        AND cl.amount_status = 'actual'
        AND cl.source IN ('provider_reported', 'gateway_reported', 'computed_from_usage', 'manual')
      ORDER BY cl.recorded_at DESC, cl.id
      LIMIT 1)
 WHERE status = 'reconciled' AND actual_usd_micros IS NOT NULL;

-- ... the synthetic flag of the linked provider request, and demo sites.
UPDATE budget_reservations
   SET is_synthetic = 1
 WHERE EXISTS (SELECT 1 FROM provider_requests pr WHERE pr.id = budget_reservations.provider_request_id AND pr.is_synthetic = 1)
    OR EXISTS (SELECT 1 FROM sites s WHERE s.id = budget_reservations.site_id AND s.is_demo = 1);

UPDATE cost_ledger
   SET is_synthetic = 1
 WHERE EXISTS (SELECT 1 FROM provider_requests pr WHERE pr.id = cost_ledger.provider_request_id AND pr.is_synthetic = 1)
    OR EXISTS (SELECT 1 FROM budget_reservations r WHERE r.id = cost_ledger.reservation_id AND r.is_synthetic = 1)
    OR EXISTS (SELECT 1 FROM sites s WHERE s.id = cost_ledger.site_id AND s.is_demo = 1);
