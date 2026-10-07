-- 007_inventory_markup_amount.sql
--
-- The warehouse has always known what a product *cost* (`cost_price`) but the
-- selling price only ever existed in the operator's head. Splitting it into an
-- explicit markup makes the sale price a stored, auditable fact instead of a
-- number everybody has to recompute, and lets the same product be marked up by
-- different amounts without editing its cost.
--
--   sale_price = cost_price + markup_amount
--
-- `sale_price` is deliberately NOT a column: a stored sum can drift away from
-- its two parts the moment either one is updated by hand, and the API already
-- selects the pair together. The sum is computed in every read instead (see
-- PRODUCT_FIELDS in server/src/inventory.js), so it can never disagree with the
-- numbers it is made of.
--
-- Durability rules for this file, same as every other migration here:
--   * no DROP, no TRUNCATE, no DELETE;
--   * `ADD COLUMN IF NOT EXISTS` so re-running this file is a no-op -- a second
--     run cannot fail and cannot duplicate anything;
--   * NOT NULL DEFAULT 0 gives every existing product a zero markup, which is
--     exactly true: until now nobody recorded one. The stored selling price of
--     every pre-existing row is therefore unchanged (`cost + 0`);
--   * CHECK (markup_amount >= 0) mirrors cost_price: a discount is a different
--     concept and belongs in the sale, not in the catalogue;
--   * the column is filled by the default in one statement, so a table with
--     millions of rows is not rewritten row by row (PostgreSQL 11+ stores a
--     missing value instead).
ALTER TABLE inventory_products
  ADD COLUMN IF NOT EXISTS markup_amount NUMERIC(12, 2)
  NOT NULL
  DEFAULT 0
  CHECK (markup_amount >= 0);
