import type { PluginHttpClient } from "@paperclipai/plugin-sdk";
import { publishAsOrganization, type PostInput, type PublishResult } from "./publish.js";
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

    upload(file) {
      return uploadMedia(http, { ...page, ...file });
    },
  };
}
