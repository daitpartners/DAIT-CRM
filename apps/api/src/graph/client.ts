import { ConfidentialClientApplication } from '@azure/msal-node';
import type { EmailAccount, PrismaClient } from '@prisma/client';
import { prisma } from '../db.js';
import { decrypt, encrypt } from '../crypto/tokens.js';
import { readRefreshToken, type MsEnv } from '../auth/microsoft.js';

export interface MailMessage {
  to: string[];
  cc?: string[];
  subject: string;
  html: string;
  text: string;
}

export interface GraphClient {
  sendMail(account: EmailAccount, msg: MailMessage): Promise<void>;
}

export const GRAPH_SEND_SCOPES = [
  'https://graph.microsoft.com/Mail.Send',
  'https://graph.microsoft.com/Mail.Send.Shared',
  'offline_access',
];

/** Graph sendMail endpoint for the mailbox the account sends as (its own address unless `sendAs` names a shared one). */
export function sendMailUrl(account: Pick<EmailAccount, 'address' | 'sendAs'>): string {
  return `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(account.sendAs ?? account.address)}/sendMail`;
}
export const SEND_TIMEOUT_MS = 20_000;

/** A Graph call failed; `status` is the HTTP status (401 for token problems). */
export class GraphError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'GraphError';
  }
}

/** True when the mailbox needs reconnecting (expired/revoked consent), not for throttling or outages. */
export function isAuthFailure(err: unknown): boolean {
  if (err instanceof GraphError) return err.status === 401;
  const e = err as { errorCode?: unknown; message?: unknown } | null;
  if (!e || typeof e !== 'object') return false;
  if (e.errorCode === 'invalid_grant' || e.errorCode === 'interaction_required') return true;
  return typeof e.message === 'string' && /\binvalid_grant\b/.test(e.message);
}

const recipients = (list: string[] = []) => list.map((address) => ({ emailAddress: { address } }));

export function createGraphClient(env: MsEnv = process.env, db: PrismaClient = prisma): GraphClient {
  return {
    async sendMail(account, msg) {
      const { MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET } = env;
      if (!MS_TENANT_ID || !MS_CLIENT_ID || !MS_CLIENT_SECRET) throw new Error('microsoft_not_configured');

      let refreshToken: string;
      try {
        refreshToken = decrypt(account.refreshTokenEnc);
      } catch {
        // TOKEN_ENCRYPTION_KEY changed (or the row was damaged): only reconnecting the mailbox fixes it.
        throw new GraphError('token_unreadable', 401);
      }

      // A fresh client per send keeps tokens out of any shared in-memory cache.
      const msal = new ConfidentialClientApplication({
        auth: {
          clientId: MS_CLIENT_ID,
          clientSecret: MS_CLIENT_SECRET,
          authority: `https://login.microsoftonline.com/${MS_TENANT_ID}`,
        },
      });
      const result = await msal.acquireTokenByRefreshToken({ refreshToken, scopes: GRAPH_SEND_SCOPES });
      if (!result?.accessToken) throw new GraphError('graph_token_failed', 401);

      const rotated = readRefreshToken(msal.getTokenCache().serialize());
      if (rotated && rotated !== refreshToken) {
        await db.emailAccount.update({
          where: { id: account.id },
          data: { refreshTokenEnc: encrypt(rotated), tokenExpiresAt: result.expiresOn ?? null },
        });
      }

      let res: Response;
      try {
        res = await fetch(sendMailUrl(account), {
          method: 'POST',
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
          headers: { Authorization: `Bearer ${result.accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: {
              subject: msg.subject,
              body: { contentType: 'HTML', content: msg.html },
              toRecipients: recipients(msg.to),
              ccRecipients: recipients(msg.cc),
            },
            saveToSentItems: true,
          }),
        });
      } catch (err) {
        // A hung request is treated like a 5xx: retried later, the mailbox stays connected.
        const name = (err as { name?: unknown } | null)?.name;
        if (name === 'TimeoutError' || name === 'AbortError') throw new GraphError('graph_send_failed timeout', 504);
        throw err;
      }
      if (!res.ok) {
        let code = '';
        try {
          const body = (await res.json()) as { error?: { code?: unknown } };
          if (typeof body.error?.code === 'string') code = ` code=${body.error.code.slice(0, 100)}`;
        } catch {
          // Body is not JSON; the status is enough.
        }
        const retryAfter = res.status === 429 ? ` retry-after=${res.headers.get('Retry-After') ?? 'unknown'}` : '';
        throw new GraphError(`graph_send_failed status=${res.status}${retryAfter}${code}`, res.status);
      }
    },
  };
}
