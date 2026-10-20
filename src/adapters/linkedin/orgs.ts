import type { PluginHttpClient } from "@paperclipai/plugin-sdk";
import { LINKEDIN_ORGS_URL, LINKEDIN_ORG_ACLS_URL, restHeaders } from "./constants.js";
import { apiError } from "./errors.js";

export interface AdministeredPage {
  organizationUrn: string;
  organizationId: string;
  name: string | null;
  vanityName: string | null;
}

/**
 * The organization id that an organization reference names: the id itself
 * (`12345`) or the Organization URN (`urn:li:organization:12345`). Null for
 * any other text.
 */
export function organizationIdOf(organizationRef: string): string | null {
  return /^(?:urn:li:organization:)?(\d+)$/.exec(organizationRef.trim())?.[1] ?? null;
}

/**
 * List the Pages the authorizing member administers.
 *
 * This is the source of truth for which Pages this connection may act as —
 * we never let an operator type an arbitrary organization URN, because
 * LinkedIn would reject it at publish time with an opaque 403.
 */
export async function listAdministeredPages(
  http: PluginHttpClient,
  accessToken: string,
): Promise<AdministeredPage[]> {
  const url = new URL(LINKEDIN_ORG_ACLS_URL);
  url.searchParams.set("q", "roleAssignee");
  url.searchParams.set("role", "ADMINISTRATOR");
  url.searchParams.set("state", "APPROVED");

  const res = await http.fetch(url.toString(), { headers: restHeaders(accessToken) });
  if (!res.ok) throw await apiError(res, "organizationAcls");

  const body = (await res.json()) as { elements?: Array<{ organization?: string }> };
  const urns = (body.elements ?? [])
    .map((e) => e.organization)
    .filter((u): u is string => typeof u === "string");

  if (urns.length === 0) return [];

  const names = await fetchOrganizationNames(http, accessToken, urns);
  return urns.map((urn) => {
    const id = urn.split(":").pop() ?? urn;
    const meta = names.get(id);
    return {
      organizationUrn: urn,
      organizationId: id,
      name: meta?.name ?? null,
      vanityName: meta?.vanityName ?? null,
    };
  });
}

/**
 * Resolve display names for a set of organization URNs.
 *
 * Best-effort: a Page whose name we cannot read is still usable for posting,
 * so a failure here degrades to a null name rather than failing the connect.
 */
async function fetchOrganizationNames(
  http: PluginHttpClient,
  accessToken: string,
  urns: string[],
): Promise<Map<string, { name: string | null; vanityName: string | null }>> {
  const out = new Map<string, { name: string | null; vanityName: string | null }>();
  const ids = urns.map((u) => u.split(":").pop()).filter(Boolean) as string[];
  const url = `${LINKEDIN_ORGS_URL}?ids=List(${ids.join(",")})`;

  try {
    const res = await http.fetch(url, { headers: restHeaders(accessToken) });
    if (!res.ok) return out;
    const body = (await res.json()) as {
      results?: Record<string, { localizedName?: string; vanityName?: string }>;
    };
    for (const [id, org] of Object.entries(body.results ?? {})) {
      out.set(id, {
        name: org.localizedName ?? null,
        vanityName: org.vanityName ?? null,
      });
    }
  } catch {
    // Names are cosmetic; leave the map empty.
  }
  return out;
}
