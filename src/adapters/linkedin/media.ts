/** The media rules of LinkedIn. The Page calls in page.ts apply them; this file makes no LinkedIn call. */

/** The LinkedIn API that takes a file: the Images API or the Documents API. */
export type MediaKind = "image" | "document";

/**
 * The processing state of an uploaded file. A file that is too large or has a
 * format LinkedIn cannot read becomes PROCESSING_FAILED; the upload itself
 * does not fail.
 */
export type MediaStatus = "WAITING_UPLOAD" | "PROCESSING" | "AVAILABLE" | "PROCESSING_FAILED";

/** A file in a post: the media URN that an upload of the Page returned. */
export interface PostFile {
  mediaUrn: string;
  /** LinkedIn requires a title for a document. */
  title?: string;
  altText?: string;
}

/** A file that LinkedIn took for the Page. LinkedIn processes it after the upload. */
export interface UploadedMedia {
  mediaUrn: string;
  status: MediaStatus;
  kind: MediaKind;
}

/** The owner and the processing state of an uploaded file, as the status read returns them. */
export interface MediaState {
  owner: string;
  status: MediaStatus;
}

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

export const ACCEPTED_FILES = "a JPG, GIF or PNG image, or a PDF, DOC, DOCX, PPT or PPTX document";

/** The LinkedIn API for an upload of `contentType`. A type that LinkedIn does not accept fails. */
export function uploadKind(contentType: string): MediaKind {
  const kind = KIND_BY_CONTENT_TYPE[contentType.split(";")[0]!.trim().toLowerCase()];
  if (!kind) throw new Error(`LinkedIn does not accept ${contentType}. Attach ${ACCEPTED_FILES}.`);
  return kind;
}

/**
 * The kind of a file for a post. A URN that is not an image or a document
 * fails, and so does a document without a title.
 */
export function postFileKind(file: PostFile): MediaKind {
  const kind = mediaKindOfUrn(file.mediaUrn);
  if (!kind) {
    throw new Error(
      `${file.mediaUrn} is not an image or a document. Pass the mediaUrn that linkedin-page-upload returned.`,
    );
  }
  if (kind === "document" && !file.title) throw new Error("A post with a document needs a title.");
  return kind;
}

/**
 * Refuse a file that cannot go in a post as the Page `organizationUrn` now: a
 * file of another Page, or a file that LinkedIn has not finished or could not
 * process.
 */
export function requirePostable(mediaUrn: string, state: MediaState, organizationUrn: string): void {
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

/** The kind of a media URN, or null for a URN that is not an image or a document. */
function mediaKindOfUrn(mediaUrn: string): MediaKind | null {
  if (mediaUrn.startsWith("urn:li:image:")) return "image";
  if (mediaUrn.startsWith("urn:li:document:")) return "document";
  return null;
}
