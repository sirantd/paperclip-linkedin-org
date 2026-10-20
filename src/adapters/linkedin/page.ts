import type { PluginHttpClient } from "@paperclipai/plugin-sdk";
import {
  LINKEDIN_COMMENTS_URL,
  LINKEDIN_DOCUMENTS_URL,
  LINKEDIN_IMAGES_URL,
  LINKEDIN_POSTS_URL,
  LINKEDIN_REACTIONS_URL,
  restHeaders,
} from "./constants.js";
import { apiError } from "./errors.js";
import {
  postFileKind,
  requirePostable,
  uploadKind,
  type MediaKind,
  type MediaState,
  type PostFile,
  type UploadedMedia,
} from "./media.js";

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

export interface ReactResult {
  /** The URN of the created reaction, or null when LinkedIn returned none (a reaction that exists already). */
  reactionUrn: string | null;
  reactionType: ReactionType;
}

export interface CommentResult {
  /** The URN of the created comment, or null when LinkedIn returned none. */
  commentUrn: string | null;
}

/**
 * The LinkedIn calls of one Page. Each call acts as the Page with one access
 * token. A call that LinkedIn answers with an error status throws a
 * LinkedInApiError.
 */
export interface PageCalls {
  /**
   * Publish a post as the Page. A post with a file publishes only a file that
   * the Page owns and that LinkedIn has finished processing.
   */
  post(input: PostInput): Promise<PublishResult>;
  /**
   * React to any post as the Page, with LIKE when no type is given. A reaction
   * that exists already counts as done.
   */
  react(postUrn: string, reactionType?: ReactionType): Promise<ReactResult>;
  /** Comment on any post as the Page. */
  comment(postUrn: string, text: string): Promise<CommentResult>;
  /**
   * Upload a file that the Page owns: a JPG, GIF or PNG image, or a PDF, DOC,
   * DOCX, PPT or PPTX document. LinkedIn processes it after the upload.
   */
  upload(file: { contentType: string; bytes: Uint8Array<ArrayBuffer> }): Promise<UploadedMedia>;
}

/**
 * The transport that sends the file bytes of an upload. The host client sends
 * a body that is not a string as String(body), which breaks the bytes, so the
 * file PUT cannot use it.
 */
export type FileTransport = (url: string, init: RequestInit) => Promise<Response>;

/**
 * The Node fetch. The file PUT skips the host tracing and audit log. The
 * lookup of fetch is at call time, so the worker tests can replace it.
 */
const nodeFetch: FileTransport = (url, init) => fetch(url, init);

const URL_BY_KIND: Readonly<Record<MediaKind, string>> = {
  image: LINKEDIN_IMAGES_URL,
  document: LINKEDIN_DOCUMENTS_URL,
};

/**
 * The calls of the Page `organizationUrn`, with an access token that is valid
 * now. The REST calls go through `http`; the file bytes of an upload go
 * through `fileTransport`.
 */
export function linkedInPage(
  http: PluginHttpClient,
  page: { accessToken: string; organizationUrn: string },
  fileTransport: FileTransport = nodeFetch,
): PageCalls {
  const { accessToken, organizationUrn } = page;

  /**
   * One versioned REST call as the Page. A status that is not ok throws a
   * LinkedInApiError that names `call`, unless `alsoDone` holds the status.
   */
  async function rest(
    call: string,
    request: { method: "GET" | "POST"; url: string; body?: unknown },
    alsoDone: readonly number[] = [],
  ): Promise<Response> {
    const res = await http.fetch(request.url, {
      method: request.method,
      headers: restHeaders(accessToken),
      ...(request.body !== undefined && { body: JSON.stringify(request.body) }),
    });
    if (!res.ok && !alsoDone.includes(res.status)) throw await apiError(res, call);
    return res;
  }

  /** The owner and the processing state of an uploaded file. */
  async function mediaState(kind: MediaKind, mediaUrn: string): Promise<MediaState> {
    const res = await rest(`LinkedIn ${kind} status`, {
      method: "GET",
      url: `${URL_BY_KIND[kind]}/${encodeURIComponent(mediaUrn)}`,
    });
    const { owner, status } = (await res.json()) as MediaState;
    return { owner, status };
  }

  return {
    async post({ text, visibility, media }) {
      // The file check comes first, so a refused file publishes nothing.
      if (media) {
        const kind = postFileKind(media);
        requirePostable(media.mediaUrn, await mediaState(kind, media.mediaUrn), organizationUrn);
      }

      // This is the endpoint of member posts too: the author URN makes it a
      // Page post, so the app needs w_organization_social.
      const res = await rest("LinkedIn publish", {
        method: "POST",
        url: LINKEDIN_POSTS_URL,
        body: {
          author: organizationUrn,
          commentary: text,
          visibility: visibility ?? "PUBLIC",
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
        },
      });

      // The created post URN comes back in a header, not the body.
      const postUrn = res.headers.get("x-restli-id") ?? res.headers.get("x-linkedin-id") ?? "";
      if (!postUrn) {
        throw new Error("LinkedIn accepted the post but returned no post URN header");
      }
      return { postUrn, permalink: permalinkFor(postUrn) };
    },

    async react(postUrn, reactionType = "LIKE") {
      // 409/422 means the reaction already exists — that is the desired end state.
      const res = await rest(
        "LinkedIn react",
        {
          method: "POST",
          url: `${LINKEDIN_REACTIONS_URL}?actor=${encodeURIComponent(organizationUrn)}`,
          body: { root: postUrn, reactionType },
        },
        [409, 422],
      );
      // The created reaction comes back in the body: `urn:li:reaction:(actor,root)`.
      return { reactionUrn: res.ok ? await urnField(res, "id") : null, reactionType };
    },

    async comment(postUrn, text) {
      const res = await rest("LinkedIn comment", {
        method: "POST",
        url: `${LINKEDIN_COMMENTS_URL}/${encodeURIComponent(postUrn)}/comments`,
        body: { actor: organizationUrn, object: postUrn, message: { text } },
      });
      // The x-restli-id header holds only the comment id; the body holds the comment URN.
      return { commentUrn: await urnField(res, "commentUrn") };
    },

    async upload({ contentType, bytes }) {
      // A content type that LinkedIn does not accept fails before any LinkedIn call.
      const kind = uploadKind(contentType);

      const start = await rest(`LinkedIn ${kind} upload start`, {
        method: "POST",
        url: `${URL_BY_KIND[kind]}?action=initializeUpload`,
        body: { initializeUploadRequest: { owner: organizationUrn } },
      });
      const { value } = (await start.json()) as { value: { uploadUrl: string } & Partial<Record<MediaKind, string>> };
      const mediaUrn = value[kind];
      if (!mediaUrn) throw new Error(`LinkedIn started the ${kind} upload but returned no ${kind} URN`);

      // The upload URL takes the OAuth token but no versioned REST headers.
      const put = await fileTransport(value.uploadUrl, {
        method: "PUT",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": contentType },
        body: bytes,
      });
      if (!put.ok) throw await apiError(put, `LinkedIn ${kind} upload`);

      // If this read fails, the uploaded file stays unused at LinkedIn. A post
      // with the file needs the same read, so retrying the upload is the fix.
      const { status } = await mediaState(kind, mediaUrn);
      return { mediaUrn, status, kind };
    },
  };
}

/**
 * The URN in the field `field` of a JSON response body, or null. A body that
 * is empty or not JSON, or a field that is not a URN, gives null.
 */
async function urnField(res: Response, field: string): Promise<string | null> {
  let body: unknown;
  try {
    body = JSON.parse(await res.text());
  } catch {
    return null;
  }
  const value = (body as Record<string, unknown> | null)?.[field];
  return typeof value === "string" && value.startsWith("urn:li:") ? value : null;
}

function permalinkFor(postUrn: string): string | null {
  const id = postUrn.split(":").pop();
  return id ? `https://www.linkedin.com/feed/update/${postUrn}/` : null;
}
