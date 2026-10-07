/**
 * Product-card list logic for the warehouse "add many products" form.
 *
 * Deliberately free of JSX and of React, so the rules that are easy to get wrong --
 * what happens when a card in the middle is removed, what happens at the cap, which
 * card an error belongs to -- are plain functions that can be asserted directly
 * instead of being inspected by reading a component. `Inventory.jsx` holds the
 * rendering and nothing else.
 *
 * The server owns the authoritative rules (`server/src/inventory.js`). This module
 * mirrors them so the form can say what is wrong before a round trip, and the
 * mirror is enforced by the P18 test groups, which run these very functions.
 */

/** Mirrors the server's MAX_BULK_PRODUCTS so the button greys out exactly where
 *  the request would start being refused. */
export const MAX_PRODUCTS = 20;

/** Increments per draft, so React tracks a card across a delete instead of reusing
 *  one DOM node for a different product. */
let uidSeq = 0;

/**
 * A blank product card.
 *
 * `unit` is absent on purpose: it follows from `type` (oil is litres, a filter is
 * pieces), so it is derived when the payload is built rather than stored -- which is
 * also how the server refuses a contradicting value.
 *
 * The card deliberately has no `minimum_quantity` or `initial_quantity`: the
 * operator does not collect them any more. A product is created empty and stocked
 * through "Omborga qo'shish", and the server keeps applying its own defaults
 * (minimum 0, opening stock 0) when they are absent. The columns themselves stay
 * in the database untouched.
 *
 * The two prices ARE collected: `cost_price` is what the shop paid and
 * `markup_amount` is what is added on top, and the selling price the operator
 * actually reads is their sum, which the server computes rather than stores.
 */
export function emptyDraft() {
  return {
    name: '', type: 'oil', brand: '', viscosity: '', package_size: '',
    cost_price: '', markup_amount: '',
  };
}

/** A blank card with a stable identity. */
export function newDraft() {
  uidSeq += 1;
  return { ...emptyDraft(), uid: uidSeq };
}

/** The opening state of the form: exactly one card. */
export function newDrafts() {
  return [newDraft()];
}

export function canAdd(drafts) {
  return drafts.length < MAX_PRODUCTS;
}

/** A form with zero cards has nothing to submit, so the last card is not removable. */
export function canRemove(drafts) {
  return drafts.length > 1;
}

/** Applies a patch to one card, leaving every other card alone. */
export function updateDraft(drafts, index, patch) {
  return drafts.map((draft, i) => (i === index ? { ...draft, ...patch } : draft));
}

/**
 * The patch that switching a card's type implies.
 *
 * Viscosity only exists for oil, so switching to a filter clears it. Leaving it
 * behind would produce a payload the server is bound to refuse ("Filtr uchun
 * viskozitet kiritilmaydi") on a field the operator cannot even see -- an error
 * with no visible cause.
 */
export function switchType(type) {
  return type === 'filter' ? { type, viscosity: '' } : { type };
}

/**
 * Appends a card.
 *
 * @returns `{ drafts, errors, focusIndex, added }`. `focusIndex` is the card the
 *   operator should be put on afterwards -- the new one -- or `null` when nothing
 *   was added, so the caller can leave the focus alone.
 */
export function addDraft(drafts, errors = []) {
  if (!canAdd(drafts)) return { drafts, errors, focusIndex: null, added: false };
  return {
    drafts: [...drafts, newDraft()],
    errors: [...errors, {}],
    focusIndex: drafts.length,
    added: true,
  };
}

/**
 * Removes one card.
 *
 * The remaining cards are returned in order and the caller renders each with its
 * own position, so removing the second of three leaves 1, 2 -- the numbering needs
 * no fixing up here. `focusIndex` is the card that took the removed one's place, or
 * the new last card when the tail was removed.
 *
 * @returns `{ drafts, errors, focusIndex, removed }`
 */
export function removeDraft(drafts, errors = [], index = -1) {
  if (!canRemove(drafts) || index < 0 || index >= drafts.length) {
    return { drafts, errors, focusIndex: null, removed: false };
  }
  return {
    drafts: drafts.filter((_, i) => i !== index),
    errors: errors.filter((_, i) => i !== index),
    focusIndex: Math.min(index, drafts.length - 2),
    removed: true,
  };
}

/**
 * Drops the errors for the fields in a patch, because the operator has just edited
 * them. Returns the same array when there was nothing to clear, so React skips the
 * re-render on the common case of a valid keystroke.
 */
export function clearFieldError(errors, index, keys) {
  const list = Array.isArray(keys) ? keys : [keys];
  if (!list.some((key) => errors[index] && errors[index][key])) return errors;
  const next = [...errors];
  const mine = { ...next[index] };
  for (const key of list) delete mine[key];
  next[index] = mine;
  return next;
}

// Same shape the server's strict parsers accept. QTY_RE mirrors NUMERIC(12,3)
// (up to 3 decimals) for a quantity; MONEY_RE mirrors NUMERIC(12,2) for a price.
// Matching them here means the form can say what is wrong instead of waiting for a
// round trip to be told, and it keeps the two rules from drifting apart.
const QTY_RE = /^\d+(\.\d{1,3})?$/;
const MONEY_RE = /^\d+(\.\d{1,2})?$/;
// Mirrors the server's MAX_MONEY (NUMERIC(12,2) tops out at 9999999999.99).
const MAX_MONEY = 9999999999.99;

/**
 * Validates one card and returns `{ field: message }`.
 *
 * Every message carries the card's position ("3-mahsulot: ...") because a form
 * holding eight identically shaped cards cannot be read from the field label alone
 * -- the operator has to know which card to go and fix.
 *
 * An empty optional field is accepted and left out of the payload, so the server's
 * own default applies (package 1, price 0). `minimum_quantity` and
 * `initial_quantity` are not validated here at all: the form never collects them.
 */
export function validateDraft(draft, index) {
  const errors = {};
  const at = `${index + 1}-mahsulot`;
  const isOil = draft.type === 'oil';

  if (!String(draft.name || '').trim()) errors.name = `${at}: Mahsulot nomi kiritilishi shart.`;
  if (!String(draft.brand || '').trim()) errors.brand = `${at}: Brend kiritilishi shart.`;
  if (isOil && !String(draft.viscosity || '').trim()) {
    errors.viscosity = `${at}: Viskozitet kiritilishi shart.`;
  }

  const check = (field, raw, { mustBePositive = false } = {}) => {
    const value = String(raw == null ? '' : raw).trim();
    if (!value) return;
    if (!QTY_RE.test(value)) {
      errors[field] = `${at}: Noto'g'ri formatda (masalan 4 yoki 4.5).`;
      return;
    }
    if (mustBePositive && Number(value) <= 0) {
      errors[field] = `${at}: 0 dan katta bo'lishi kerak.`;
    }
  };

  // A price is money, not a quantity: two decimals, never negative, never past
  // the column width. `-5` is refused by the sign rather than by the format, so
  // the message says what is actually wrong with it.
  const checkMoney = (field, raw) => {
    const value = String(raw == null ? '' : raw).trim();
    if (!value) return;
    if (value.startsWith('-')) {
      errors[field] = `${at}: Narx manfiy bo'lishi mumkin emas.`;
      return;
    }
    if (!MONEY_RE.test(value)) {
      errors[field] = `${at}: Narx noto'g'ri formatda (masalan 45000 yoki 45000.50).`;
      return;
    }
    if (Number(value) > MAX_MONEY) {
      errors[field] = `${at}: Narx juda katta.`;
    }
  };

  check('package_size', draft.package_size, { mustBePositive: true });
  checkMoney('cost_price', draft.cost_price);
  checkMoney('markup_amount', draft.markup_amount);

  return errors;
}

/** Validates every card. */
export function validateDrafts(drafts) {
  return drafts.map((draft, index) => validateDraft(draft, index));
}

/** Index of the first card with an error, or -1 when the batch is clean. */
export function firstInvalidIndex(errors) {
  return errors.findIndex((e) => e && Object.keys(e).length > 0);
}

/**
 * Reads the card position back out of a server error.
 *
 * The bulk endpoint prefixes its message ("3-mahsulot: Viskozitet majburiy"), which
 * is what makes it possible to move the operator to the exact card that failed. If
 * the prefix is missing the message is still shown, just without the jump.
 */
export function focusFromServerMessage(message, cardCount) {
  const match = /^(\d+)-mahsulot/.exec(String(message || ''));
  if (!match) return null;
  const index = Number(match[1]) - 1;
  return index >= 0 && index < cardCount ? index : null;
}

/**
 * Builds one payload entry.
 *
 * Only the fields the form actually shows are sent, so the server's own defaults
 * apply to the rest. That is what keeps a newly created product at
 * `current_quantity = 0` with `minimum_quantity = 0`: the request never mentions
 * them, and the operator stocks the product afterwards through "Omborga qo'shish".
 *
 * The two prices are sent as plain numeric strings ("45000"), never as a formatted
 * string with separators or a currency suffix -- the server's parser is strict
 * precisely so that a display convenience cannot reach the database.
 */
export function draftPayload(draft) {
  const isOil = draft.type === 'oil';
  const text = (v) => String(v == null ? '' : v).trim();
  const payload = {
    name: text(draft.name),
    type: draft.type,
    brand: text(draft.brand),
    unit: isOil ? 'liter' : 'piece',
  };
  if (isOil) payload.viscosity = text(draft.viscosity);
  if (text(draft.package_size)) payload.package_size = text(draft.package_size);
  if (text(draft.cost_price)) payload.cost_price = text(draft.cost_price);
  if (text(draft.markup_amount)) payload.markup_amount = text(draft.markup_amount);
  return payload;
}