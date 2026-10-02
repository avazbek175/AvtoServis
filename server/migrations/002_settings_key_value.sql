-- 002_settings_key_value.sql
--
-- Why this migration exists
-- ------------------------
-- The application stores settings as key/value JSON documents:
--
--     settings(key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '{}')
--
-- A database created before that design (here: the Supabase project migrated
-- from the older SQLite deployment) already has a `settings` table with a
-- different shape -- a wide single-row table with columns such as
-- id, name, description, phone, telegram, address, logo, favicon, social.
--
-- 001_init.sql could not fix that, because `CREATE TABLE IF NOT EXISTS`
-- silently skips a table that already exists no matter which columns it has.
-- The migration therefore reported success, and startup only failed later with
-- `column "key" of relation "settings" does not exist` when the seeder tried to
-- insert the default settings.
--
-- What this migration does
-- ------------------------
--   * If `settings` already has a `key` column, it does nothing.
--   * Otherwise it converts the legacy table into the key/value shape,
--     preserving every column and every row.
--
-- The old table is RENAMED, never dropped, so the data stays recoverable and
-- this migration can be re-run safely.

DO $$
DECLARE
  has_key            boolean;
  legacy             text := 'settings_legacy';
  suffix             text := '';
  legacy_exists      boolean;
  rowcount           bigint;
  -- name_try drives the backup-name search; row_no counts legacy rows. They
  -- must stay separate or a second run would store the first row under
  -- "legacy_1" instead of "site".
  name_try           int := 0;
  row_no             int := 0;
  legacy_rec         record;
  payload            jsonb;
BEGIN
  -- Current shape already in place: nothing to do. This is what makes the
  -- migration idempotent on a fresh install and on re-runs.
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'settings' AND column_name = 'key'
  ) INTO has_key;

  IF has_key THEN
    RAISE NOTICE '[002] settings already uses the key/value shape, nothing to do';
    RETURN;
  END IF;

  IF to_regclass(format('%I.%I', current_schema(), 'settings')) IS NULL THEN
    -- Nothing to convert. 001_init.sql created this table with the right shape,
    -- but if it is missing here then 001 is recorded as applied while the table
    -- is not, so 001 will never run again and the seeder would fail forever.
    -- Creating the table here is safe because there is no data to preserve.
    RAISE NOTICE '[002] no legacy settings table found, creating the key/value table';
    EXECUTE format(
      'CREATE TABLE %I.settings ('
      ' key   TEXT PRIMARY KEY,'
      ' value TEXT NOT NULL DEFAULT ''{}'''
      ')',
      current_schema()
    );
    RETURN;
  END IF;

  -- Pick a free backup name. Re-running after a partial failure must not fail
  -- on an existing name.
  legacy_exists := to_regclass(format('%I.%I', current_schema(), legacy)) IS NOT NULL;
  WHILE legacy_exists LOOP
    name_try     := name_try + 1;
    suffix       := '_' || name_try;
    legacy       := 'settings_legacy' || suffix;
    legacy_exists := to_regclass(format('%I.%I', current_schema(), legacy)) IS NOT NULL;
  END LOOP;

  EXECUTE format('ALTER TABLE %I.settings RENAME TO %I', current_schema(), legacy);
  RAISE NOTICE '[002] legacy settings table preserved as %', legacy;

  EXECUTE format(
    'CREATE TABLE %I.settings ('
    ' key   TEXT PRIMARY KEY,'
    ' value TEXT NOT NULL DEFAULT ''{}'''
    ')',
    current_schema()
  );

  -- Preserve the data.
  --
  -- The legacy table is a single-row configuration table, so its columns map
  -- onto the `site` settings document. to_jsonb() captures every column
  -- generically: any column this script has never heard of (for example
  -- `social`) is carried over untouched, which is what makes this safe for a
  -- schema that predates the current code.
  EXECUTE format('SELECT count(*) FROM %I.%I', current_schema(), legacy) INTO rowcount;

  IF rowcount > 0 THEN
    FOR legacy_rec IN
      EXECUTE format('SELECT * FROM %I.%I ORDER BY 1', current_schema(), legacy)
    LOOP
      payload := to_jsonb(legacy_rec);

      IF row_no = 0 THEN
        -- Primary document: the site-wide configuration.
        EXECUTE format(
          'INSERT INTO %I.settings (key, value) VALUES ($1, $2)'
          ' ON CONFLICT (key) DO NOTHING',
          current_schema()
        ) USING 'site', payload::text;

        RAISE NOTICE '[002] legacy row 1 stored under settings key ''site''';
      ELSE
        -- Any further rows are preserved under their own key rather than being
        -- merged or dropped.
        EXECUTE format(
          'INSERT INTO %I.settings (key, value) VALUES ($1, $2)'
          ' ON CONFLICT (key) DO NOTHING',
          current_schema()
        ) USING 'legacy_' || row_no, payload::text;

        RAISE NOTICE '[002] legacy row % stored under settings key ''legacy_%''', row_no, row_no;
      END IF;

      row_no := row_no + 1;
    END LOOP;
  ELSE
    RAISE NOTICE '[002] legacy settings table was empty, created an empty key/value table';
  END IF;

  RAISE NOTICE '[002] settings converted to key/value, legacy data preserved in %', legacy;
END
$$;
