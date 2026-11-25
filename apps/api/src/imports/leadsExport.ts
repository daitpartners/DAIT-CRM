/**
 * "Download all leads" (owner, 24 Nov 2026): every lead the user can see that matches the Leads list's current filters,
 * as an .xlsx to complete by hand and upload again through Import leads (rows with a Lead ID / Company ID fill blanks
 * only: updates.ts). Columns: Lead ID, Company ID, the import fields (as the importer reads them back) and read-only
 * context columns (ignored on upload), headers in the downloader's language, a bold frozen header, and every value
 * through the formula guard. Mail content is never exported.
 */
import ExcelJS from 'exceljs';
import type { Prisma } from '@prisma/client';
import {
  EXPORT_CONTEXT_COLUMNS, IMPORT_FIELDS, LEADS_EXPORT_MAX, importColumnLabel, importSource,
  type ImportColumnKey, type ImportField, type Lang,
} from '@dait-crm/shared';
import { prisma } from '../db.js';
import { safeCell } from './cells.js';
import { firstFilled } from './updates.js';

/** The download's columns, in order. */
export const EXPORT_COLUMNS: readonly ImportColumnKey[] = ['leadId', 'companyId', ...IMPORT_FIELDS, ...EXPORT_CONTEXT_COLUMNS];

const LANGUAGE_NAME: Record<Lang, Record<string, string>> = {
  en: { en: 'English', es: 'Spanish' },
  es: { en: 'Inglés', es: 'Español' },
  fr: { en: 'Anglais', es: 'Espagnol' },
};

const exportInclude = {
  company: { select: { number: true, website: true, city: true, industry: true } },
  contact: { select: { firstName: true, lastName: true, designation: true, businessEmail: true, phone: true } },
  assignedTo: { select: { name: true } },
} satisfies Prisma.LeadInclude;
type ExportLead = Prisma.LeadGetPayload<{ include: typeof exportInclude }>;

/**
 * One lead's cells: each field is the value the CRM shows for it (the lead's own, else its company's / contact's), so a
 * re-upload compares against the same value.
 */
export function exportCells(l: ExportLead, lang: Lang): Record<ImportColumnKey, string> {
  const contactName = l.contact ? `${l.contact.firstName} ${l.contact.lastName}`.trim() : '';
  // The same "first non-blank" rule as the update check (updates.ts), so a blank shown here is blank there too.
  const fields: Record<ImportField, string> = {
    companyName: firstFilled(l.companyName),
    website: firstFilled(l.website, l.company?.website),
    country: firstFilled(l.country),
    city: firstFilled(l.city, l.company?.city),
    contactName,
    designation: firstFilled(l.contact?.designation),
    email: firstFilled(l.businessEmail, l.contact?.businessEmail),
    phone: firstFilled(l.phone, l.contact?.phone),
    industry: firstFilled(l.company?.industry),
    notes: firstFilled(l.notes),
  };
  return {
    ...fields,
    leadId: l.number,
    companyId: l.company?.number ?? '',
    status: l.status,
    assignedTo: l.assignedTo?.name ?? '',
    language: (LANGUAGE_NAME[lang] ?? LANGUAGE_NAME.en)[l.outreachLanguage] ?? l.outreachLanguage,
    leadType: l.leadType,
    source: l.importBatch ? importSource(l.importBatch) : l.leadSource,
  } as Record<ImportColumnKey, string>;
}

/** Leads read per query. */
const PAGE = 2000;

/**
 * The workbook of the leads matching `where`, in `orderBy` order; `{ tooMany }` (nothing built) when more than
 * LEADS_EXPORT_MAX match.
 */
export async function leadsWorkbook(
  where: Prisma.LeadWhereInput, orderBy: Prisma.LeadOrderByWithRelationInput[], lang: Lang,
): Promise<{ buffer: Buffer; count: number } | { tooMany: number }> {
  const total = await prisma.lead.count({ where });
  if (total > LEADS_EXPORT_MAX) return { tooMany: total };
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Leads', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = EXPORT_COLUMNS.map((key) => ({ width: key === 'notes' ? 40 : key === 'leadId' || key === 'companyId' ? 12 : 22 }));
  const header = ws.getRow(1);
  EXPORT_COLUMNS.forEach((key, c) => {
    const cell = header.getCell(c + 1);
    cell.value = safeCell(importColumnLabel(key, lang));
    cell.font = { bold: true };
  });
  let n = 0;
  for (let skip = 0; skip < total; skip += PAGE) {
    const leads = await prisma.lead.findMany({ where, orderBy, skip, take: PAGE, include: exportInclude });
    for (const l of leads) {
      const cells = exportCells(l, lang);
      const row = ws.getRow(n + 2);
      EXPORT_COLUMNS.forEach((key, c) => { row.getCell(c + 1).value = safeCell(cells[key] ?? ''); });
      n += 1;
    }
    if (leads.length < PAGE) break;
  }
  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), count: n };
}
