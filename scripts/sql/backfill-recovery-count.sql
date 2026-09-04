-- One-time backfill of dailysummaries.recoveryCount for rows created BEFORE the column existed.
-- The column itself is added automatically at server start (models/sql.js ensureColumn).
--
-- A recovery row is one written by an admin correction (set-count / reconcile backfill): it has
-- no timing fields (never chanted) and carries more count than the activity ledger has for that
-- day. Everything above the ledger on such a row is recovery. Real pre-2026-03-27 rows also lack
-- timing fields, but their ledger matches their dailyCount, so toMark = 0 and they are skipped.
--
-- Timestamps are stored as UTC DATETIME by the API (Sequelize sets time_zone '+00:00'), so
-- DATE(timestamp) below is the same UTC calendar day the API uses when it writes summaries.
--
-- 1) PREVIEW — run first and eyeball the rows (prod as of 2026-09-04 expects exactly two:
--    userId 70 / 2026-06-10 / toMark 99984 and userId 17 / 2026-04-01 / toMark 2080).
SELECT s.id, s.userId, s.date, s.dailyCount, s.recoveryCount AS currentMarker,
       COALESCE(l.c, 0) AS ledgerDay,
       s.dailyCount - COALESCE(l.c, 0) AS toMark
FROM dailysummaries s
LEFT JOIN (
  SELECT userId, DATE(timestamp) AS d, SUM(count) AS c
  FROM activities
  WHERE activityType = 'COUNT_INCREMENT'
  GROUP BY userId, DATE(timestamp)
) l ON l.userId = s.userId AND l.d = s.date
WHERE s.firstCountAt IS NULL AND s.lastCountAt IS NULL
  AND s.dailyCount > COALESCE(l.c, 0)
  AND s.recoveryCount = 0
ORDER BY toMark DESC;

-- 2) APPLY — same criteria; sets the marker to the non-ledger portion of each such row.
UPDATE dailysummaries s
LEFT JOIN (
  SELECT userId, DATE(timestamp) AS d, SUM(count) AS c
  FROM activities
  WHERE activityType = 'COUNT_INCREMENT'
  GROUP BY userId, DATE(timestamp)
) l ON l.userId = s.userId AND l.d = s.date
SET s.recoveryCount = s.dailyCount - COALESCE(l.c, 0)
WHERE s.firstCountAt IS NULL AND s.lastCountAt IS NULL
  AND s.dailyCount > COALESCE(l.c, 0)
  AND s.recoveryCount = 0;

-- 3) VERIFY — no row may carry a marker larger than its count.
SELECT COUNT(*) AS badRows FROM dailysummaries WHERE recoveryCount > dailyCount;
