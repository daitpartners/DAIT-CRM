import { GraphError, type DraftFields, type GraphAttachment, type GraphClient, type GraphDraft } from './client.js';

/**
 * The Graph client the e2e server uses (web-mail release 2): only with E2E_FAKE_GRAPH=1 and NODE_ENV=test (app.ts),
 * so it never stands in for Microsoft in production. Mailbox changes (read, move, flag, delete, reply, reply all,
 * forward) succeed without doing anything; attachments come from the fixtures below; every other call is refused.
 * Web-mail release 3: drafts are kept in memory (created, read, updated, given attachments, deleted); sending one is
 * refused (the e2e server runs no worker: `test/e2e-send-jobs.ts` sends).
 */

/** The smallest valid one-page PDF. */
const PDF = Buffer.from(
  '%PDF-1.4\n'
  + '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n'
  + '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n'
  + '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n'
  + 'trailer<</Root 1 0 R>>\n'
  + '%%EOF\n',
  'latin1',
);

/** An empty zip archive (end of central directory record only): the bytes of a stand-in .xlsx. */
const ZIP = Buffer.concat([Buffer.from('PK\x05\x06', 'latin1'), Buffer.alloc(18)]);

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const file = (id: string, name: string, contentType: string, bytes: Buffer) => ({
  meta: { id, name, contentType, size: bytes.length, isInline: false, kind: 'file' as const },
  bytes,
});

/** e2e seed message `e2e-2` has one PDF; parity messages (`parity-att…`) have a PDF and a spreadsheet (F14). */
function fixtures(graphId: string): { meta: GraphAttachment; bytes: Buffer }[] {
  if (graphId === 'e2e-2') return [file('e2e-att-1', 'orbit-notes.pdf', 'application/pdf', PDF)];
  if (graphId.startsWith('parity-att')) {
    return [file('parity-att-pdf', 'proposal.pdf', 'application/pdf', PDF), file('parity-att-xlsx', 'pricing.xlsx', XLSX_TYPE, ZIP)];
  }
  return [];
}

/** The seeded messages (test/e2e-seed.ts) a reply or forward draft can be made from. */
const ORIGINALS: Record<string, { conversationId: string; subject: string; fromName: string; from: string; to: string[]; text: string }> = {
  'e2e-1': {
    conversationId: 'e2e-conv-1', subject: 'Orbit proposal', fromName: 'Neha Kapoor', from: 'neha@daitpartners.com', to: ['finance@orbit.example'],
    text: 'Hi, Please find our proposal.',
  },
  'e2e-2': {
    conversationId: 'e2e-conv-1', subject: 'Re: Orbit proposal', fromName: 'Lena Vogel', from: 'finance@orbit.example', to: ['neha@daitpartners.com'],
    text: 'Thanks Neha, can we talk on Thursday?',
  },
  'e2e-3': {
    conversationId: 'e2e-conv-2', subject: 'Website enquiry', fromName: 'Sara Lind', from: 'sara@blue-river.example', to: ['neha@daitpartners.com'],
    text: 'We need a new website. Can you help?',
  },
  // web/e2e/emailActions.spec.ts adds this message for its inline Reply all (web-mail release 3).
  'e2e-act-1': {
    conversationId: 'e2e-act-thread-1', subject: 'Action check one', fromName: 'Act Client', from: 'client@act.example',
    to: ['neha.kapoor@daitpartners.com'], text: 'About item 1',
  },
  // web/e2e/emailWrite.spec.ts adds this message (linked to a lead of its own) for its inline Reply and send.
  'e2e-write-1': {
    conversationId: 'e2e-write-thread-1', subject: 'Write check', fromName: 'Wren Client', from: 'client@write.example',
    to: ['neha.kapoor@daitpartners.com'], text: 'Can we meet next week?',
  },
  'e2e-write-2': {
    conversationId: 'e2e-write-thread-2', subject: 'Write keys', fromName: 'Wren Client', from: 'client@write.example',
    to: ['neha.kapoor@daitpartners.com'], text: 'One more question.',
  },
};

/** web/e2e/parity/webMail.spec.ts: its HTML RFP message (graph id `parity-att-…`) is the one replied to in state 2. */
const PARITY_RFP = {
  conversationId: 'parity-neha-acme', subject: 'RFP-2026-118: Website & customer portal redesign', fromName: 'Maria Gómez', from: 'maria.gomez@acme-logistics.com',
  to: ['neha.kapoor@daitpartners.com'], text: 'Please find attached our formal RFP and the pricing sheet. Proposals are due 11 Dec 2026.',
};

/** Drafts made through the fake, by id (`e2e-draft-<n>`); attachment ids are `e2e-att-<n>`. */
const drafts = new Map<string, GraphDraft>();
let draftCount = 0;
let attachmentCount = 0;

const notFound = () => new GraphError('graph_request_failed status=404 code=ErrorItemNotFound', 404);
const lower = (list: string[]) => list.map((a) => a.trim().toLowerCase());
const copy = (d: GraphDraft): GraphDraft => structuredClone(d);

function storedDraft(id: string): GraphDraft {
  const d = drafts.get(id);
  if (!d) throw notFound();
  return d;
}

function newDraft(fields: Omit<GraphDraft, 'id' | 'lastModified' | 'attachments'>): GraphDraft {
  draftCount += 1;
  const d: GraphDraft = { id: `e2e-draft-${draftCount}`, ...fields, lastModified: new Date().toISOString(), attachments: [] };
  drafts.set(d.id, d);
  return copy(d);
}

const writeFields = (d: DraftFields) => ({ subject: d.subject, html: d.html, to: lower(d.to), cc: lower(d.cc), bcc: lower(d.bcc) });

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const fakes = new WeakSet<GraphClient>();

export function createE2eGraph(): GraphClient {
  const refuse = () => Promise.reject(new Error('not used in e2e'));
  const accept = async () => undefined;
  const graph: GraphClient = {
    sendMail: refuse, deltaPage: refuse, messageBody: refuse, searchPage: refuse, folderIds: refuse, calendarDeltaPage: refuse,
    markRead: accept, moveTo: accept, setFlag: accept, reply: accept, replyAll: accept, forward: accept,
    sendDraft: refuse,
    async deleteMessage(_account, graphId) {
      drafts.delete(graphId);
    },
    async createDraft(_account, d) {
      return newDraft({ conversationId: null, ...writeFields(d) });
    },
    async createReplyDraft(account, graphId, kind) {
      const o = ORIGINALS[graphId] ?? (graphId.startsWith('parity-att') ? PARITY_RFP : undefined);
      if (!o) throw notFound();
      const own = account.address.toLowerCase();
      const to = kind === 'forward' ? [] : kind === 'reply' ? [o.from] : [o.from, ...o.to.filter((a) => a !== own && a !== o.from)];
      // Outlook's quote header, as web mail folds it.
      const html = '<p></p><hr><div id="divRplyFwdMsg"><b>From:</b> '
        + `${escape(o.fromName)} &lt;${escape(o.from)}&gt;<br><b>Subject:</b> ${escape(o.subject)}</div><div>${escape(o.text)}</div>`;
      return newDraft({ conversationId: o.conversationId, subject: `${kind === 'forward' ? 'FW' : 'RE'}: ${o.subject}`, html, to, cc: [], bcc: [] });
    },
    async getDraft(_account, draftId) {
      return copy(storedDraft(draftId));
    },
    async updateDraft(_account, draftId, d) {
      Object.assign(storedDraft(draftId), writeFields(d), { lastModified: new Date().toISOString() });
    },
    async addAttachment(_account, draftId, a) {
      const d = storedDraft(draftId);
      attachmentCount += 1;
      const id = `e2e-att-${attachmentCount}`;
      d.attachments.push({
        id, name: a.name, contentType: a.contentType, size: Buffer.from(a.contentBase64, 'base64').length, isInline: a.isInline === true, kind: 'file',
      });
      return { id };
    },
    async removeAttachment(_account, draftId, attachmentId) {
      const d = storedDraft(draftId);
      const at = d.attachments.findIndex((a) => a.id === attachmentId);
      if (at < 0) throw notFound();
      d.attachments.splice(at, 1);
    },
    async listAttachments(_account, graphId) {
      return fixtures(graphId).map((f) => f.meta);
    },
    async attachmentContent(_account, graphId, attachmentId, maxBytes) {
      const found = fixtures(graphId).find((f) => f.meta.id === attachmentId);
      if (!found) throw new GraphError('graph_request_failed status=404', 404);
      if (found.bytes.length > maxBytes) throw new GraphError('attachment_too_large', 413);
      return Buffer.from(found.bytes);
    },
  };
  fakes.add(graph);
  return graph;
}

/** True for a client made by createE2eGraph. */
export function isE2eGraph(g: GraphClient): boolean {
  return fakes.has(g);
}
