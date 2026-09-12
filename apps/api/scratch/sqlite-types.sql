DROP TABLE IF EXISTS scratch_types;

CREATE TABLE scratch_types (
  integer_value INTEGER,
  real_value REAL,
  text_value TEXT,
  blob_value BLOB,
  null_value TEXT
);

INSERT INTO scratch_types VALUES (8900, 89.5, 'MAD', X'CAFE', NULL);

SELECT
  typeof(integer_value) AS integer_type,
  typeof(real_value) AS real_type,
  typeof(text_value) AS text_type,
  typeof(blob_value) AS blob_type,
  typeof(null_value) AS null_type
FROM scratch_types;

DROP TABLE scratch_types;
