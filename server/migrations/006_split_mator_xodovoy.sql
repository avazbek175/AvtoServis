-- 006_split_mator_xodovoy.sql
-- "Mator xodovoy" was published as a single service. The engine work and the
-- chassis work are different jobs with different parts, different prices and
-- different debts, so the catalogue now offers them as two services:
--
--   Mator      -- engine
--   Xodovoy    -- chassis / suspension
--
-- Durability rules for this file, same as every other migration here:
--   * no DROP, no TRUNCATE, no DELETE FROM services;
--   * the old row is deactivated, never removed, because `debts.service` and
--     `work_logs.service_type` store TEXT by value and a lookup would otherwise
--     dangle, and because the row carries the catalogue copy an admin may have
--     edited;
--   * every INSERT is guarded by WHERE NOT EXISTS, so re-running this file is a
--     no-op and cannot duplicate a service;
--   * existing sort_order values are left exactly as they are -- the two new rows
--     are appended after the highest one rather than shifting what the admin has
--     already arranged;
--   * nothing that is merely not empty is touched: work logs, debts, payments and
--     audit rows are all out of scope.

-- 1. Retire the combined entry. WHERE is_active = 1 keeps the statement
--    idempotent: a second run has nothing left to change.
UPDATE services
   SET is_active = 0
 WHERE name = 'Mator xodovoy'
   AND is_active = 1;

-- 2. Add Mator. Gated on the table not being empty rather than on the old row
--    existing: on a brand-new database the catalogue is still empty at this
--    point, seed() has not run yet, and it will insert the full six-service list
--    itself. On an existing database the gate opens even if an admin has already
--    deleted the combined row.
INSERT INTO services (name, description, benefits, image, icon, price, sort_order, is_active)
SELECT 'Mator',
       'Dvigatel ta''mirlash: kapital va joriy ta''mirlash, moy va filtrlarni almashtirish.',
       'Sifatli ehtiyot qismlar|Kafolatli ta''mirlash|Tajribali ustalar',
       '', 'engine', '',
       (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM services),
       1
 WHERE EXISTS (SELECT 1 FROM services)
   AND NOT EXISTS (SELECT 1 FROM services WHERE name = 'Mator');

-- 3. Add Xodovoy. Runs after Mator, so MAX above now includes Mator and this row
--    lands directly after it: the two stay adjacent in the catalogue.
INSERT INTO services (name, description, benefits, image, icon, price, sort_order, is_active)
SELECT 'Xodovoy',
       'Xodovoy qismlar ta''mirlash: asosiy qism, amortizator, rul va tormoz tizimlari.',
       'Kuchli suspensiya|Aniq diagnostika|Ishonchli ta''mirlash',
       '', 'wrench', '',
       (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM services),
       1
 WHERE EXISTS (SELECT 1 FROM services)
   AND NOT EXISTS (SELECT 1 FROM services WHERE name = 'Xodovoy');
