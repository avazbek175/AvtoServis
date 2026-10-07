/**
 * The service catalogue as the app shows it.
 *
 * Deliberately free of JSX and of React, so the places that are easy to get wrong
 * -- "is Mator a separate option from Xodovoy", "does the retired combined name
 * still appear" -- are plain data that can be asserted directly instead of being
 * read out of a rendered component.
 *
 * This module is the *bundled* half: the baseline six, their icons, and the rules
 * for a value the catalogue no longer carries. The lists the screens actually
 * offer come from the server (client/src/serviceTypes.js, backed by the `services`
 * table that /admin/services edits), because an admin who adds a service there
 * expects the work-log and debt pickers to offer it without a deploy. Both halves
 * are used together: `serviceOptions(current, names)` takes the live list and
 * falls back to the baseline below when it has not arrived yet. `DebtLedger.jsx`,
 * `WorkLogs.jsx`, `AdminLogin.jsx`, `Footer.jsx` and `WorkGallery.jsx` all draw
 * from here, so a catalogue change is one edit and cannot leave one screen behind.
 *
 * The server owns the authoritative rules (`server/src/routes/worklogs.js` for
 * work-log service types, the `services` table for the catalogue itself). This
 * module mirrors them so the browser can offer the same options, and the mirror is
 * enforced by the P20 test groups, which import these very values.
 *
 * Mator and Xodovoy used to ship as one combined entry. They are separate services
 * that happen to be done on the same lift, so they are separate options: a debt
 * for an engine job and a debt for a suspension job are not the same debt. The
 * combined name is kept here only so existing records can still be recognised and
 * rendered -- it is never offered as a choice.
 */

/** The six services, in the order they are offered. */
export const SERVICE_NAMES = [
  'Mator',
  'Xodovoy',
  'Diagnostika',
  'Programma',
  'Elektrik',
  'Moy almashtirish',
];

/** Retired combined name. Never selectable; still valid on a record that has it. */
export const LEGACY_SERVICE_NAME = 'Mator xodovoy';

/** Icons, keyed by service name. Unknown names fall back to `wrench`. */
export const SERVICE_ICONS = {
  Mator: 'engine',
  Xodovoy: 'wrench',
  Diagnostika: 'diagnostic',
  Programma: 'chip',
  Elektrik: 'bolt',
  'Moy almashtirish': 'oil',
  // Retired combined name: a work log filed before the split still deserves an icon.
  [LEGACY_SERVICE_NAME]: 'engine',
};

/** True for a name the shop currently offers. */
export function isServiceName(name) {
  return SERVICE_NAMES.includes(String(name == null ? '' : name).trim());
}

/**
 * Options for a <select> that is pre-filled with an existing record.
 *
 * The current value is appended when it is not in the catalogue, otherwise an
 * edit form would open showing a service the record does not have and saving
 * would quietly rewrite it. That is how a legacy record survives being edited:
 * its own value is offered back, labelled as legacy, and the operator has to
 * actively pick something else to change it.
 *
 * `names` is the live catalogue (client/src/serviceTypes.js), so the work-log
 * and debt pickers follow the services the admin has actually added. Left out it
 * falls back to the bundled baseline six -- the guaranteed floor while that
 * request is in flight or has failed.
 *
 * @param {string} current value already on the record
 * @param {string[]} [names] active service names, in catalogue order
 * @returns {{ value: string, label: string, legacy: boolean }[]}
 */
export function serviceOptions(current, names) {
  const cur = String(current == null ? '' : current).trim();
  const list = Array.isArray(names) ? names.map((n) => String(n)) : SERVICE_NAMES;
  const options = list.map((name) => ({ value: name, label: name, legacy: false }));
  if (cur && !list.includes(cur)) {
    options.unshift({ value: cur, label: `${cur} (eski)`, legacy: true });
  }
  return options;
}

/** Icon for a service name, falling back to the generic wrench. */
export function serviceIcon(name) {
  return SERVICE_ICONS[String(name == null ? '' : name).trim()] || 'wrench';
}
