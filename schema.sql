-- Target: MySQL 8.0+ / InnoDB. Run in the selected application database.
-- All recorded_at values are Hong Kong wall time; lease times are UTC.
SET SESSION time_zone = '+08:00';

CREATE TABLE IF NOT EXISTS strata_token_usage (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    recorded_at DATETIME(3) NOT NULL,
    usage_date DATE NOT NULL,
    instance_id VARCHAR(100) COLLATE utf8mb4_bin NOT NULL,
    server_started_at BIGINT UNSIGNED NOT NULL,
    input_total BIGINT UNSIGNED NOT NULL,
    output_total BIGINT UNSIGNED NOT NULL,
    input_delta BIGINT UNSIGNED NOT NULL,
    output_delta BIGINT UNSIGNED NOT NULL,
    total_delta BIGINT UNSIGNED
        GENERATED ALWAYS AS (input_delta + output_delta) STORED,
    INDEX idx_instance_latest (instance_id, id),
    INDEX idx_recorded_at (recorded_at),
    INDEX idx_instance_usage_date (instance_id, usage_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- One durable lease per instance; independent of n8n's connection pool.
CREATE TABLE IF NOT EXISTS strata_tracker_leases (
    instance_id VARCHAR(100) COLLATE utf8mb4_bin PRIMARY KEY,
    lease_owner CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    expires_at DATETIME(3) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- Reapplying these definitions should be done while the workflow is inactive.
DROP PROCEDURE IF EXISTS strata_tracker_acquire;
DROP PROCEDURE IF EXISTS strata_tracker_insert;
DELIMITER $$
CREATE PROCEDURE strata_tracker_acquire(
    IN p_instance VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin,
    OUT p_acquired TINYINT,
    OUT p_owner CHAR(36)
)
SQL SECURITY DEFINER
BEGIN
    DECLARE v_expires DATETIME(3);
    -- Lock contention is a skipped cycle; other database errors remain failures.
    DECLARE EXIT HANDLER FOR 1205, 1213
    BEGIN
        ROLLBACK;
        SET p_acquired = 0;
        SET p_owner = NULL;
    END;
    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        ROLLBACK;
        RESIGNAL;
    END;
    SET p_acquired = 0;
    SET p_owner = NULL;
    START TRANSACTION;
    INSERT INTO strata_tracker_leases (instance_id, lease_owner, expires_at)
    VALUES (p_instance, NULL, '1970-01-01 00:00:00.000')
    ON DUPLICATE KEY UPDATE instance_id = p_instance;
    SELECT expires_at INTO v_expires FROM strata_tracker_leases
    WHERE instance_id = p_instance FOR UPDATE;
    IF v_expires <= UTC_TIMESTAMP(3) THEN
        SET p_owner = UUID();
        UPDATE strata_tracker_leases
        SET lease_owner = p_owner, expires_at = UTC_TIMESTAMP(3) + INTERVAL 120 SECOND
        WHERE instance_id = p_instance;
        SET p_acquired = 1;
    END IF;
    COMMIT;
END$$

CREATE PROCEDURE strata_tracker_insert(
    IN p_instance VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin,
    IN p_owner CHAR(36),
    IN p_recorded DATETIME(3),
    IN p_started BIGINT UNSIGNED,
    IN p_input BIGINT UNSIGNED,
    IN p_output BIGINT UNSIGNED,
    IN p_input_delta BIGINT UNSIGNED,
    IN p_output_delta BIGINT UNSIGNED,
    IN p_previous_id BIGINT UNSIGNED
)
SQL SECURITY DEFINER
BEGIN
    DECLARE v_owner CHAR(36) DEFAULT NULL;
    DECLARE v_expires DATETIME(3) DEFAULT NULL;
    DECLARE v_latest BIGINT UNSIGNED DEFAULT 0;
    DECLARE v_usage_date DATE;
    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        ROLLBACK;
        RESIGNAL;
    END;
    START TRANSACTION;
    SELECT lease_owner, expires_at INTO v_owner, v_expires
    FROM strata_tracker_leases WHERE instance_id = p_instance FOR UPDATE;
    IF v_owner IS NULL OR p_owner IS NULL OR BINARY v_owner <> BINARY p_owner
       OR v_expires <= UTC_TIMESTAMP(3) THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Strata lease lost or expired; snapshot rejected';
    END IF;
    -- Defensive compare-and-swap: reject any observation based on a stale baseline.
    SELECT COALESCE(MAX(id), 0) INTO v_latest
    FROM strata_token_usage WHERE instance_id = p_instance;
    IF v_latest <> p_previous_id THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Strata previous snapshot changed; snapshot rejected';
    END IF;
    -- Attribute the interval to its starting snapshot, retaining the observation time.
    -- The initial baseline has zero deltas and uses its own date.
    SELECT COALESCE(MAX(DATE(recorded_at)), DATE(p_recorded)) INTO v_usage_date
    FROM strata_token_usage WHERE instance_id = p_instance AND id = p_previous_id;
    INSERT INTO strata_token_usage
        (recorded_at, usage_date, instance_id, server_started_at, input_total, output_total,
         input_delta, output_delta)
    VALUES (p_recorded, v_usage_date, p_instance, p_started, p_input, p_output,
            p_input_delta, p_output_delta);
    -- Insert and release commit together. Errors leave the lease to expire.
    UPDATE strata_tracker_leases
    SET lease_owner = NULL, expires_at = '1970-01-01 00:00:00.000'
    WHERE instance_id = p_instance;
    COMMIT;
END$$
DELIMITER ;

-- Run this SET in EVERY reporting session, including dashboard connections.
-- Fixed offset works without installing MySQL timezone tables (Hong Kong = UTC+8).
SET SESSION time_zone = '+08:00';

-- Daily consumption (the complete interval belongs to the starting snapshot date).
SELECT
    usage_date,
    SUM(input_delta) AS input_tokens,
    SUM(output_delta) AS output_tokens,
    SUM(total_delta) AS total_tokens
FROM strata_token_usage
WHERE instance_id = 'strata-p40'
GROUP BY usage_date
ORDER BY usage_date DESC;

-- Today's consumption in Hong Kong.
SELECT
    COALESCE(SUM(input_delta), 0) AS input_tokens,
    COALESCE(SUM(output_delta), 0) AS output_tokens,
    COALESCE(SUM(total_delta), 0) AS total_tokens
FROM strata_token_usage
WHERE instance_id = 'strata-p40'
  AND usage_date = CURRENT_DATE();
