import type { PluginHttpClient } from "@paperclipai/plugin-sdk";
import {
  commentAsOrganization,
  publishAsOrganization,
  reactAsOrganization,
  type PostInput,
  type PublishResult,
  type ReactionType,
} from "./publish.js";
import { requirePostable, uploadMedia, type UploadedMedia } from "./media.js";

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
  /** React to any post as the Page. A reaction that exists already counts as done. */
  react(postUrn: string, reactionType?: ReactionType): Promise<void>;
  /** Comment on any post as the Page. */
  comment(postUrn: string, text: string): Promise<void>;
  /**
   * Upload a file that the Page owns: a JPG, GIF or PNG image, or a PDF, DOC,
   * DOCX, PPT or PPTX document. LinkedIn processes it after the upload.
   */
  upload(file: { contentType: string; bytes: Uint8Array<ArrayBuffer> }): Promise<UploadedMedia>;
}

/** The calls of the Page `organizationUrn`, with an access token that is valid now. */
export function linkedInPage(
  http: PluginHttpClient,
  page: { accessToken: string; organizationUrn: string },
): PageCalls {
  return {
    async post(input) {
      // The file check comes first, so a refused file publishes nothing.
      if (input.media) await requirePostable(http, { ...page, ...input.media });
      return publishAsOrganization(http, { ...page, ...input });
    },

    react(postUrn, reactionType) {
      return reactAsOrganization(http, { ...page, postUrn, reactionType });
    },

    comment(postUrn, text) {
      return commentAsOrganization(http, { ...page, postUrn, text });
    },

    upload(file) {
      return uploadMedia(http, { ...page, ...file });
    },
  };
}
