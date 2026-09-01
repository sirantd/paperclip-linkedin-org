-- migrations/0001_pages.sql
-- Plugin namespace: plugin_linkedin_org_670c26f221
-- Derived as plugin_{namespaceSlug}_{sha256(pluginKey)[0:10]} from
-- pluginKey=sirantd.linkedin-org and namespaceSlug=linkedin_org.
-- If the plugin id in the manifest ever changes, this schema name changes
-- with it and every statement below must be updated to match.
--
-- Keep this header apostrophe-free. The host normaliser strips single-quoted
-- strings before line comments, so a lone apostrophe in a comment can pair
-- with a real string literal and mangle the normalised statement.

create table if not exists plugin_linkedin_org_670c26f221.page_connections (
  id                        uuid primary key default gen_random_uuid(),
  company_id                uuid not null references public.companies(id) on delete cascade,

  organization_urn          text not null,
  organization_id           text not null,
  page_name                 text,
  vanity_name               text,

  -- Member who authorized. Plain text, not a uuid FK: in local_trusted mode
  -- the connecting principal can be a non-uuid id such as local-board.
  authorized_by             text not null,
  authorized_member_urn     text,

  scopes                    text[] not null,
  status                    text not null check (status in ('active','expired','revoked')),

  access_token_sealed       text not null,
  refresh_token_sealed      text,
  expires_at                timestamptz not null,
  refresh_expires_at        timestamptz,
  last_refreshed_at         timestamptz,

  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

-- One live connection per Page per company. Reconnecting updates in place
-- rather than accumulating stale rows holding unusable tokens.
create unique index if not exists page_connections_company_org_idx
  on plugin_linkedin_org_670c26f221.page_connections (company_id, organization_id);

create index if not exists page_connections_status_idx
  on plugin_linkedin_org_670c26f221.page_connections (company_id, status);
