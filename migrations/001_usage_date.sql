-- One-time upgrade for an existing table without usage_date (MySQL 8.0+).
-- Back up the database and deactivate all tracker workflows before running.
-- After this script, reapply schema.sql to replace the insert procedure, then reactivate.
-- DDL commits implicitly; do not use mysql --force if a statement fails.
SET SESSION time_zone = '+08:00';

ALTER TABLE strata_token_usage ADD COLUMN usage_date DATE NULL AFTER recorded_at;

-- Partition by instance and order by id, exactly as the workflow chooses its baseline.
-- Materialize first so UPDATE does not read its own target through a subquery.
CREATE TEMPORARY TABLE strata_usage_date_backfill AS
SELECT id,
       DATE(COALESCE(LAG(recorded_at) OVER (PARTITION BY instance_id ORDER BY id),
                     recorded_at)) AS usage_date
FROM strata_token_usage;

UPDATE strata_token_usage AS snapshots
JOIN strata_usage_date_backfill AS backfill ON backfill.id = snapshots.id
SET snapshots.usage_date = backfill.usage_date;

DROP TEMPORARY TABLE strata_usage_date_backfill;
ALTER TABLE strata_token_usage
    MODIFY COLUMN usage_date DATE NOT NULL,
    ADD INDEX idx_instance_usage_date (instance_id, usage_date);
