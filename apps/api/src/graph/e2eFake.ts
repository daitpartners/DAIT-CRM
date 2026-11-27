import { GraphError, type GraphAttachment, type GraphClient } from './client.js';

/**
 * The Graph client the e2e server uses (web-mail release 2): only with E2E_FAKE_GRAPH=1 and NODE_ENV=test (app.ts),
 * so it never stands in for Microsoft in production. Mailbox changes (read, move, flag, delete, reply, reply all,
 * forward) succeed without doing anything; attachments come from the fixtures below; every other call is refused.
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

const fakes = new WeakSet<GraphClient>();

export function createE2eGraph(): GraphClient {
  const refuse = () => Promise.reject(new Error('not used in e2e'));
  const accept = async () => undefined;
  const graph: GraphClient = {
    sendMail: refuse, deltaPage: refuse, messageBody: refuse, searchPage: refuse, folderIds: refuse, calendarDeltaPage: refuse,
    markRead: accept, moveTo: accept, setFlag: accept, deleteMessage: accept, reply: accept, replyAll: accept, forward: accept,
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
