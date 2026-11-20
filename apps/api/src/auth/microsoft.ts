import { ConfidentialClientApplication, type Configuration } from '@azure/msal-node';

export interface MicrosoftIdentity {
  oid: string;
  email: string;
  name: string;
  refreshToken?: string;
  expiresOn?: Date;
}

export interface MicrosoftClient {
  getAuthUrl(args: { state: string; codeVerifier: string; codeChallenge: string }): Promise<string>;
  redeemCode(args: { code: string; codeVerifier: string }): Promise<MicrosoftIdentity>;
}

export const MS_SCOPES = ['openid', 'profile', 'email', 'offline_access', 'User.Read'];

type MsEnv = Partial<Record<'MS_TENANT_ID' | 'MS_CLIENT_ID' | 'MS_CLIENT_SECRET' | 'MS_REDIRECT_URI', string>>;

export function createMsalClient(env: MsEnv): MicrosoftClient {
  const { MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET, MS_REDIRECT_URI } = env;
  if (!MS_TENANT_ID || !MS_CLIENT_ID || !MS_CLIENT_SECRET || !MS_REDIRECT_URI) {
    throw new Error('MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET and MS_REDIRECT_URI are required');
  }
  const config: Configuration = {
    auth: {
      clientId: MS_CLIENT_ID,
      clientSecret: MS_CLIENT_SECRET,
      authority: `https://login.microsoftonline.com/${MS_TENANT_ID}`,
    },
  };
  const shared = new ConfidentialClientApplication(config);

  return {
    getAuthUrl({ state, codeChallenge }) {
      return shared.getAuthCodeUrl({
        scopes: MS_SCOPES,
        redirectUri: MS_REDIRECT_URI,
        state,
        codeChallenge,
        codeChallengeMethod: 'S256',
        prompt: 'select_account',
      });
    },
    async redeemCode({ code, codeVerifier }) {
      // A fresh client per redemption keeps one user's tokens out of another's cache.
      const msal = new ConfidentialClientApplication(config);
      const result = await msal.acquireTokenByCode({ code, codeVerifier, scopes: MS_SCOPES, redirectUri: MS_REDIRECT_URI });
      const claims = (result.idTokenClaims ?? {}) as Record<string, unknown>;
      const oid = String(claims.oid ?? result.account?.localAccountId ?? '');
      const email = String(claims.preferred_username ?? claims.email ?? result.account?.username ?? '');
      if (!oid || !email) throw new Error('Microsoft identity is missing oid or email');
      return {
        oid,
        email: email.toLowerCase(),
        name: String(claims.name ?? result.account?.name ?? email),
        refreshToken: readRefreshToken(msal.getTokenCache().serialize()),
        expiresOn: result.expiresOn ?? undefined,
      };
    },
  };
}

function readRefreshToken(serializedCache: string): string | undefined {
  try {
    const cache = JSON.parse(serializedCache) as { RefreshToken?: Record<string, { secret?: string }> };
    return Object.values(cache.RefreshToken ?? {})[0]?.secret;
  } catch {
    return undefined;
  }
}
