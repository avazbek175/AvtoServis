const ExcelJS = require('exceljs');

/**
 * Excel (.xlsx) workbook builder for the debt ledger.
 *
 * Lives in its own module, away from the route, for two reasons: the route stays
 * about HTTP while this stays about spreadsheet layout, and the formula-injection
 * guard below can be asserted directly by the tests instead of only through a
 * downloaded file.
 *
 * Generation happens on the server on purpose. A browser-side writer would mean
 * shipping a spreadsheet library into the bundle of an app that only needs to
 * hand a finished file to the download shelf; here the operator's browser
 * receives ~10 KB of bytes and nothing else.
 *
 * What is NOT here, deliberately: process.env. This module has no access to
 * configuration, so a session secret, a database URL, an R2 key or the delete
 * pass key cannot reach a worksheet even by accident. Every cell comes from the
 * rows handed in, and every row is built from an explicit column list.
 */

// The ledger stores so'm as whole numbers with no cents. Excel's built-in
// accounting formats assume two decimals, which would report every figure as
// 1 500 000.00 and misstate the ledger, so a custom format is used: grouped
// thousands, no decimals, and the currency named in the header.
const MONEY_FMT = '#,##0 "so\'m"';
const PLAIN_FMT = '#,##0';
const DATE_FMT = 'yyyy-mm-dd hh:mm';

/** Header fill: a dark slate that matches the app, so the file looks native. */
const HEADER_BG = 'FF1E2A44';
const HEADER_FG = 'FFFFFFFF';
const TOTAL_BG = 'FFE8EEF9';
const TOTAL_FG = 'FF111725';

/**
 * Neutralises spreadsheet formula injection.
 *
 * A cell whose text begins with = + - @ is a FORMULA to Excel, not text, so a
 * debtor recorded as "=cmd|'/c calc'!A1" would execute on the machine of whoever
 * opens the export. Prefixing an apostrophe forces the literal interpretation in
 * Excel and Sheets, and the apostrophe is not part of the stored value.
 *
 * @ and +/- are included even though they are rarely used as formula starts,
 * because a leading "-" on an imported text column is how "=-1+1" style payloads
 * arrive, and tab/carriage return are stripped because they are the other classic
 * bypass. Numbers never reach here: only string cells are passed through it.
 */
function sanitizeCell(value) {
  let v = String(value == null ? '' : value);
  // Control characters break the XML writer and have no business in a ledger.
  v = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  return v;
}

/** A Date for a real Excel date cell; anything unparseable becomes plain text. */
function toDate(value) {
  if (!value) return null;
  // The schema stores TEXT as 'YYYY-MM-DD HH:MM:SS', which Date parses as local
  // time. Timestamps are written in UTC by app_now(), so the "Z" is appended to
  // keep the cell showing the same wall-clock the database recorded.
  const raw = String(value).trim();
  const iso = raw.length <= 10 ? `${raw}T00:00:00Z` : `${raw.replace(' ', 'T')}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Writes a header row and returns the row number (always 1). */
function writeHeader(sheet, columns) {
  const row = sheet.getRow(1);
  row.values = columns.map((c) => c.header);
  row.font = { bold: true, color: { argb: HEADER_FG }, size: 11 };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_BG } };
  row.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  row.height = 22;
  columns.forEach((c, i) => {
    sheet.getColumn(i + 1).width = c.width;
  });
  return row;
}

/** Applies the shared look to a finished sheet. */
function finishSheet(sheet, lastRow, columnCount) {
  // Freeze the header so the labels stay put while scrolling a long ledger.
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  if (lastRow >= 1 && columnCount > 0) {
    // AutoFilter over the real data range, so the operator can narrow the export
    // in Excel without touching the file.
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: lastRow, column: columnCount },
    };
  }
}

/** Builds the three worksheets from plain row objects. */
async function buildDebtWorkbook({ debts, payments, auditLogs, totals, generatedAt }) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'AvtoServis — Qarz daftari';
  workbook.created = new Date();

  // ---------------------------------------------------------------- Qarzlar
  const debtSheet = workbook.addWorksheet('Qarzlar', { views: [{ state: 'frozen', ySplit: 1 }] });
  const debtColumns = [
    { header: 'ID', width: 8 },
    { header: "F.I.Sh.", width: 26 },
    { header: 'Telefon', width: 18 },
    { header: 'Xizmat', width: 24 },
    { header: 'Tavsif', width: 38 },
    { header: 'Qarz summasi', width: 16 },
    { header: "To'langan summa", width: 16 },
    { header: 'Qolgan summa', width: 16 },
    { header: 'Holati', width: 18 },
    { header: 'Yaratilgan sana', width: 18 },
    { header: 'Yangilangan sana', width: 18 },
  ];
  writeHeader(debtSheet, debtColumns);

  debts.forEach((d, i) => {
    const r = debtSheet.getRow(i + 2);
    r.values = [
      Number(d.id),
      sanitizeCell(d.full_name),
      sanitizeCell(d.phone),
      sanitizeCell(d.service),
      sanitizeCell(d.description),
      Number(d.debt_amount),
      Number(d.paid_amount),
      Number(d.remaining_amount),
      sanitizeCell(d.status_label || d.status),
      toDate(d.created_at),
      toDate(d.updated_at),
    ];
    r.getCell(6).numFmt = MONEY_FMT;
    r.getCell(7).numFmt = MONEY_FMT;
    r.getCell(8).numFmt = MONEY_FMT;
    r.getCell(10).numFmt = DATE_FMT;
    r.getCell(11).numFmt = DATE_FMT;
    r.alignment = { vertical: 'top', wrapText: true };
    r.getCell(9).alignment = { vertical: 'top', horizontal: 'center' };
    for (let c = 6; c <= 8; c++) r.getCell(c).alignment = { vertical: 'top', horizontal: 'right' };
  });
  finishSheet(debtSheet, debts.length + 1, debtColumns.length);

  // Summary, taken from the aggregate the route computed over the SAME filtered
  // set the rows came from. Placed two rows under the last one so it never
  // interrupts the autofilter range.
  const sumRow = debts.length + 3;
  debtSheet.getCell(sumRow, 2).value = 'Jami qarz:';
  debtSheet.getCell(sumRow, 6).value = Number(totals.total_debt);
  debtSheet.getCell(sumRow, 6).numFmt = MONEY_FMT;
  debtSheet.getCell(sumRow + 1, 2).value = "Jami to'langan:";
  debtSheet.getCell(sumRow + 1, 6).value = Number(totals.total_paid);
  debtSheet.getCell(sumRow + 1, 6).numFmt = MONEY_FMT;
  debtSheet.getCell(sumRow + 2, 2).value = 'Jami qoldiq:';
  debtSheet.getCell(sumRow + 2, 6).value = Number(totals.total_remaining);
  debtSheet.getCell(sumRow + 2, 6).numFmt = MONEY_FMT;
  for (let i = 0; i < 3; i++) {
    const r = debtSheet.getRow(sumRow + i);
    r.font = { bold: true };
    r.getCell(2).font = { bold: true, color: { argb: TOTAL_FG } };
    r.getCell(6).font = { bold: true, color: { argb: TOTAL_FG } };
    r.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TOTAL_BG } };
  }

  // --------------------------------------------------------------- To'lovlar
  const paySheet = workbook.addWorksheet("To'lovlar", { views: [{ state: 'frozen', ySplit: 1 }] });
  const payColumns = [
    { header: "To'lov ID", width: 10 },
    { header: 'Qarz ID', width: 10 },
    { header: 'F.I.Sh.', width: 26 },
    { header: 'Telefon', width: 18 },
    { header: "To'lov summasi", width: 16 },
    { header: "To'lov sanasi", width: 18 },
    { header: 'Izoh', width: 38 },
    { header: 'Admin', width: 22 },
  ];
  writeHeader(paySheet, payColumns);

  payments.forEach((p, i) => {
    const r = paySheet.getRow(i + 2);
    r.values = [
      Number(p.id),
      Number(p.debt_id),
      sanitizeCell(p.full_name),
      sanitizeCell(p.phone),
      Number(p.amount),
      toDate(p.created_at),
      sanitizeCell(p.note),
      sanitizeCell(p.created_by_name),
    ];
    r.getCell(5).numFmt = MONEY_FMT;
    r.getCell(6).numFmt = DATE_FMT;
    r.alignment = { vertical: 'top', wrapText: true };
    r.getCell(5).alignment = { vertical: 'top', horizontal: 'right' };
  });
  finishSheet(paySheet, payments.length + 1, payColumns.length);

  // ------------------------------------------------------------------ Audit
  const auditSheet = workbook.addWorksheet('Audit', { views: [{ state: 'frozen', ySplit: 1 }] });
  const auditColumns = [
    { header: 'Audit ID', width: 10 },
    { header: 'Qarz ID', width: 10 },
    { header: 'Action', width: 20 },
    { header: 'Admin', width: 22 },
    { header: 'Sana', width: 18 },
    { header: 'Izoh', width: 52 },
  ];
  writeHeader(auditSheet, auditColumns);

  // The audit `metadata` column is JSON written by every write path. It can hold
  // a debt snapshot, and older rows still carry the address that the UI no longer
  // shows, so it is reduced to a readable one-line summary instead of being
  // exported verbatim.
  auditLogs.forEach((a, i) => {
    const r = auditSheet.getRow(i + 2);
    r.values = [
      Number(a.id),
      a.debt_id == null ? '' : Number(a.debt_id),
      sanitizeCell(a.action),
      sanitizeCell(a.admin_name),
      toDate(a.created_at),
      sanitizeCell(auditSummary(a)),
    ];
    r.getCell(5).numFmt = DATE_FMT;
    r.alignment = { vertical: 'top', wrapText: true };
  });
  finishSheet(auditSheet, auditLogs.length + 1, auditColumns.length);

  const buffer = await workbook.xlsx.writeBuffer();
  return {
    buffer: Buffer.from(buffer),
    generatedAt: generatedAt || new Date().toISOString(),
    sheets: ['Qarzlar', "To'lovlar", 'Audit'],
    counts: { debts: debts.length, payments: payments.length, auditLogs: auditLogs.length },
  };
}

/**
 * Turns one audit metadata JSON blob into a short readable note.
 *
 * Never fails: an unreadable blob is reported as such rather than breaking the
 * whole export.
 */
function auditSummary(row) {
  let meta = null;
  try {
    meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata || '{}') : row.metadata;
  } catch {
    return 'metadata o\'qilmadi';
  }
  if (!meta || typeof meta !== 'object') return '';
  const parts = [];
  if (meta.amount != null) parts.push(`${meta.amount} so'm`);
  if (meta.settled_amount != null) parts.push(`yopildi: ${meta.settled_amount} so'm`);
  if (meta.note) parts.push(String(meta.note));
  if (meta.opening_quantity != null) parts.push(`boshlang'ich: ${meta.opening_quantity} so'm`);
  if (meta.remaining_amount != null) parts.push(`qoldiq: ${meta.remaining_amount} so'm`);
  if (meta.status) parts.push(`holat: ${meta.status}`);
  if (meta.reason) parts.push(String(meta.reason));
  if (meta.debt_amount != null) parts.push(`qarz: ${meta.debt_amount} so'm`);
  if (meta.paid_amount != null) parts.push(`to'langan: ${meta.paid_amount} so'm`);
  if (meta.full_name) parts.push(String(meta.full_name));
  if (meta.batch_size != null) parts.push(`partiya: ${meta.batch_position}/${meta.batch_size}`);
  return parts.join(' · ');
}

module.exports = { buildDebtWorkbook, sanitizeCell, toDate, MONEY_FMT, DATE_FMT };