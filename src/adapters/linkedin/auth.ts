import type { PluginHttpClient } from "@paperclipai/plugin-sdk";
import {
  LINKEDIN_AUTHORIZE_URL,
  LINKEDIN_ORG_SCOPES,
  LINKEDIN_TOKEN_URL,
} from "./constants.js";

export interface LinkedInTokens {
  accessToken: string;
  /** Epoch ms. LinkedIn returns expires_in seconds; org tokens are typically 60 days. */
  expiresAt: number;
  refreshToken: string | null;
  refreshTokenExpiresAt: number | null;
  scope: string | null;
}

export function buildAuthorizationUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL(LINKEDIN_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  url.searchParams.set("scope", LINKEDIN_ORG_SCOPES.join(" "));
  return url.toString();
}

async function postForm(
  http: PluginHttpClient,
  body: Record<string, string>,
): Promise<LinkedInTokens> {
  const res = await http.fetch(LINKEDIN_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    // LinkedIn returns the useful detail in the body, not the status text.
    const hint = text.includes("invalid_client")
      ? " — client_id is valid if authorization succeeded, so this points at the " +
        "stored Client Secret: confirm it matches the app's current Primary Client Secret."
      : "";
    throw new Error(`LinkedIn token endpoint ${res.status}: ${text.slice(0, 500)}${hint}`);
  }
  const json = JSON.parse(text) as {
    access_token: string;
    expires_in: number;
    refresh_token?: string;
    refresh_token_expires_in?: number;
    scope?: string;
  };
  const now = Date.now();
  return {
    accessToken: json.access_token,
    expiresAt: now + json.expires_in * 1000,
    refreshToken: json.refresh_token ?? null,
    refreshTokenExpiresAt: json.refresh_token_expires_in
      ? now + json.refresh_token_expires_in * 1000
      : null,
    scope: json.scope ?? null,
  };
}

export function exchangeCode(
  http: PluginHttpClient,
  input: { code: string; clientId: string; clientSecret: string; redirectUri: string },
): Promise<LinkedInTokens> {
  return postForm(http, {
    grant_type: "authorization_code",
    code: input.code,
    client_id: input.clientId,
    client_secret: input.clientSecret,
    redirect_uri: input.redirectUri,
  });
}

export function refreshTokens(
  http: PluginHttpClient,
  input: { refreshToken: string; clientId: string; clientSecret: string },
): Promise<LinkedInTokens> {
  return postForm(http, {
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
    client_id: input.clientId,
    client_secret: input.clientSecret,
  });
}

/**
 * Verify the granted scopes actually include organization write access.
 *
 * LinkedIn silently drops scopes the app is not approved for rather than
 * failing the authorization, so a connection can look healthy right up until
 * the first publish returns 403. Checking at connect time turns that into a
 * clear error during setup.
 */
export function assertOrgScopesGranted(tokens: LinkedInTokens): void {
  if (!tokens.scope) return; // Nothing to check against; publish will surface it.
  const granted = new Set(tokens.scope.split(/[\s,]+/).filter(Boolean));
  const missing = ["w_organization_social", "w_organization_social_feed", "rw_organization_admin"].filter(
    (s) => !granted.has(s),
  );
  if (missing.length > 0) {
    throw new Error(
      `LinkedIn did not grant ${missing.join(", ")}. Confirm the app is approved ` +
        `for the Community Management API product and that the authorizing member ` +
        `is an administrator of the Page. Granted: ${tokens.scope}`,
    );
  }
}
