import type { PluginHttpClient } from "@paperclipai/plugin-sdk";
import {
  LINKEDIN_DOCUMENTS_URL,
  LINKEDIN_IMAGES_URL,
  organizationUrn as toOrganizationUrn,
  restHeaders,
} from "./constants.js";
import { apiError } from "./errors.js";

/** The LinkedIn API that takes a file: the Images API or the Documents API. */
export type MediaKind = "image" | "document";

/**
 * The processing state of an uploaded file. A file that is too large or has a
 * format LinkedIn cannot read becomes PROCESSING_FAILED; the upload itself
 * does not fail.
 */
export type MediaStatus = "WAITING_UPLOAD" | "PROCESSING" | "AVAILABLE" | "PROCESSING_FAILED";

/**
 * The largest attachment that the plugin uploads: 10 MiB, the default
 * Paperclip attachment limit. The worker holds the base64 text and the bytes
 * in memory, and the host gives a tool call 30 s for the read and the upload.
 */
export const MAX_MEDIA_BYTES = 10 * 1024 * 1024;

/**
 * The attachment content types that LinkedIn accepts. The Images API takes
 * JPG, GIF and PNG; the Documents API takes PDF, DOC, DOCX, PPT and PPTX.
 */
const KIND_BY_CONTENT_TYPE: Readonly<Record<string, MediaKind>> = {
  "image/png": "image",
  "image/jpeg": "image",
  "image/jpg": "image",
  "image/gif": "image",
  "application/pdf": "document",
  "application/msword": "document",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "document",
  "application/vnd.ms-powerpoint": "document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "document",
};

export const ACCEPTED_FILES =
  "a JPG, GIF or PNG image, or a PDF, DOC, DOCX, PPT or PPTX document";

const URL_BY_KIND: Readonly<Record<MediaKind, string>> = {
  image: LINKEDIN_IMAGES_URL,
  document: LINKEDIN_DOCUMENTS_URL,
};

/** The LinkedIn API for a content type, or null when LinkedIn does not accept the type. */
export function mediaKindForContentType(contentType: string): MediaKind | null {
  return KIND_BY_CONTENT_TYPE[contentType.split(";")[0]!.trim().toLowerCase()] ?? null;
}

/** The kind of a media URN, or null for a URN that is not an image or a document. */
export function mediaKindOfUrn(mediaUrn: string): MediaKind | null {
  if (mediaUrn.startsWith("urn:li:image:")) return "image";
  if (mediaUrn.startsWith("urn:li:document:")) return "document";
  return null;
}

/**
 * Upload a file that the Page owns and return its media URN.
 *
 * `http` carries the JSON call. `upload` carries the file bytes: the host
 * client sends a body that is not a string as String(body), which breaks them.
 */
export async function uploadMedia(
  http: PluginHttpClient,
  upload: PluginHttpClient,
  input: {
    accessToken: string;
    organizationId: string;
    kind: MediaKind;
    contentType: string;
    bytes: Uint8Array<ArrayBuffer>;
  },
): Promise<string> {
  const res = await http.fetch(`${URL_BY_KIND[input.kind]}?action=initializeUpload`, {
    method: "POST",
    headers: restHeaders(input.accessToken),
    body: JSON.stringify({ initializeUploadRequest: { owner: toOrganizationUrn(input.organizationId) } }),
  });
  if (!res.ok) throw await apiError(res, `LinkedIn ${input.kind} upload start`);
  const { value } = (await res.json()) as { value: { uploadUrl: string } & Partial<Record<MediaKind, string>> };
  const mediaUrn = value[input.kind];
  if (!mediaUrn) throw new Error(`LinkedIn started the ${input.kind} upload but returned no ${input.kind} URN`);

  // The upload URL takes the OAuth token but no versioned REST headers.
  const put = await upload.fetch(value.uploadUrl, {
    method: "PUT",
    headers: { Authorization: `Bearer ${input.accessToken}`, "Content-Type": input.contentType },
    body: input.bytes,
  });
  if (!put.ok) throw await apiError(put, `LinkedIn ${input.kind} upload`);
  return mediaUrn;
}

/** The owner and the processing state of an uploaded file. */
export async function mediaState(
  http: PluginHttpClient,
  input: { accessToken: string; mediaUrn: string; kind: MediaKind },
): Promise<{ owner: string; status: MediaStatus }> {
  const res = await http.fetch(`${URL_BY_KIND[input.kind]}/${encodeURIComponent(input.mediaUrn)}`, {
    headers: restHeaders(input.accessToken),
  });
  if (!res.ok) throw await apiError(res, `LinkedIn ${input.kind} status`);
  const { owner, status } = (await res.json()) as { owner: string; status: MediaStatus };
  return { owner, status };
}

/**
 * Refuse a file that cannot go in a post as the Page now: a file of another
 * Page, or a file that LinkedIn has not finished or could not process.
 */
export function requirePostable(
  state: { owner: string; status: MediaStatus },
  mediaUrn: string,
  organizationUrn: string,
): void {
  if (state.owner !== organizationUrn) {
    throw new Error(
      `${mediaUrn} belongs to ${state.owner}, not to ${organizationUrn}. ` +
        "Upload the file again with the organizationId of the post.",
    );
  }
  switch (state.status) {
    case "AVAILABLE":
      return;
    case "WAITING_UPLOAD":
    case "PROCESSING":
      throw new Error(
        `LinkedIn is still processing ${mediaUrn} (${state.status}). Call linkedin-page-post again later.`,
      );
    case "PROCESSING_FAILED":
      throw new Error(
        `LinkedIn could not process ${mediaUrn}. The file can be too large or damaged, or LinkedIn failed. ` +
          "Upload a different file.",
      );
    default:
      throw new Error(`LinkedIn reported the unknown status ${String(state.status)} for ${mediaUrn}.`);
  }
}
