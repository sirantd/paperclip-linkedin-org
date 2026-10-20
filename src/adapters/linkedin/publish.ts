import type { PluginHttpClient } from "@paperclipai/plugin-sdk";
import {
  LINKEDIN_COMMENTS_URL,
  LINKEDIN_POSTS_URL,
  LINKEDIN_REACTIONS_URL,
  organizationUrn,
  restHeaders,
} from "./constants.js";
import { apiError } from "./errors.js";
import type { PostFile } from "./media.js";

export type ReactionType = "LIKE" | "PRAISE" | "EMPATHY" | "INTEREST" | "APPRECIATION";

/** The text of a post, and the file it shows. */
export interface PostInput {
  text: string;
  visibility?: "PUBLIC" | "LOGGED_IN";
  /** An uploaded image or document. LinkedIn requires `title` for a document. */
  media?: PostFile;
}

export interface PublishResult {
  postUrn: string;
  permalink: string | null;
}

/**
 * Publish a post authored by the Page itself.
 *
 * This is the same /rest/posts endpoint used for member posts — the author URN
 * is what makes it a Page post, which is why the app needs w_organization_social.
 */
export async function publishAsOrganization(
  http: PluginHttpClient,
  input: PostInput & { accessToken: string; organizationUrn: string },
): Promise<PublishResult> {
  const { media } = input;
  const body = {
    author: input.organizationUrn,
    commentary: input.text,
    visibility: input.visibility ?? "PUBLIC",
    distribution: {
      feedDistribution: "MAIN_FEED",
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    },
    ...(media && {
      content: {
        media: {
          id: media.mediaUrn,
          ...(media.title && { title: media.title }),
          ...(media.altText && { altText: media.altText }),
        },
      },
    }),
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false,
  };

  const res = await http.fetch(LINKEDIN_POSTS_URL, {
    method: "POST",
    headers: restHeaders(input.accessToken),
    body: JSON.stringify(body),
  });

  if (!res.ok) throw await apiError(res, "LinkedIn publish");

  // The created post URN comes back in a header, not the body.
  const postUrn =
    res.headers.get("x-restli-id") ?? res.headers.get("x-linkedin-id") ?? "";
  if (!postUrn) {
    throw new Error("LinkedIn accepted the post but returned no post URN header");
  }

  return { postUrn, permalink: permalinkFor(postUrn) };
}

/** React to any post as the Page. */
export async function reactAsOrganization(
  http: PluginHttpClient,
  input: {
    accessToken: string;
    organizationId: string;
    postUrn: string;
    reactionType?: ReactionType;
  },
): Promise<void> {
  const actor = organizationUrn(input.organizationId);
  const url = `${LINKEDIN_REACTIONS_URL}?actor=${encodeURIComponent(actor)}`;
  const res = await http.fetch(url, {
    method: "POST",
    headers: restHeaders(input.accessToken),
    body: JSON.stringify({ root: input.postUrn, reactionType: input.reactionType ?? "LIKE" }),
  });

  // 409/422 means the reaction already exists — that is the desired end state.
  if (res.ok || res.status === 409 || res.status === 422) return;
  throw await apiError(res, "LinkedIn react");
}

/** Comment on a post as the Page. */
export async function commentAsOrganization(
  http: PluginHttpClient,
  input: {
    accessToken: string;
    organizationId: string;
    postUrn: string;
    text: string;
  },
): Promise<void> {
  const actor = organizationUrn(input.organizationId);
  const url = `${LINKEDIN_COMMENTS_URL}/${encodeURIComponent(input.postUrn)}/comments`;
  const res = await http.fetch(url, {
    method: "POST",
    headers: restHeaders(input.accessToken),
    body: JSON.stringify({ actor, object: input.postUrn, message: { text: input.text } }),
  });
  if (!res.ok) throw await apiError(res, "LinkedIn comment");
}

function permalinkFor(postUrn: string): string | null {
  const id = postUrn.split(":").pop();
  return id ? `https://www.linkedin.com/feed/update/${postUrn}/` : null;
}
