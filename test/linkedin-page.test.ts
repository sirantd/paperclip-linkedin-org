import { beforeEach, describe, expect, it, vi } from "vitest";
import { linkedInPage, type PageCalls } from "../src/adapters/linkedin/page.js";
import { LINKEDIN_VERSION } from "../src/adapters/linkedin/constants.js";
import {
  DOCUMENTS_URL,
  FakeLinkedIn,
  IMAGES_URL,
  POSTS_URL,
  UPLOAD_URL,
  hostHttp,
  json,
} from "./world.js";

// The LinkedIn calls of one Page, against the LinkedIn fake only: no Page
// connection and no database.

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const PDF = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55]);

let linkedin: FakeLinkedIn;
let page: PageCalls;

beforeEach(() => {
  linkedin = new FakeLinkedIn();
  // File uploads use the Node fetch; vitest.config.ts restores it after each test.
  vi.stubGlobal("fetch", linkedin.fetch);
  page = linkedInPage(hostHttp(linkedin), { accessToken: "access-1", organizationUrn: "urn:li:organization:111" });
});

describe("post", () => {
  it("publishes as the Page and returns the post URN and its permalink", async () => {
    linkedin.scriptActions("urn:li:share:9");

    expect(await page.post({ text: "Hello" })).toEqual({
      postUrn: "urn:li:share:9",
      permalink: "https://www.linkedin.com/feed/update/urn:li:share:9/",
    });
    const [post] = linkedin.requestsTo(POSTS_URL);
    expect(post!.headers).toMatchObject({ Authorization: "Bearer access-1", "LinkedIn-Version": LINKEDIN_VERSION });
    expect(JSON.parse(post!.body)).toMatchObject({
      author: "urn:li:organization:111",
      commentary: "Hello",
      visibility: "PUBLIC",
      lifecycleState: "PUBLISHED",
    });
  });

  it("reads the status of an image, then posts it with its alternative text", async () => {
    linkedin.scriptMedia();
    linkedin.scriptActions();

    await page.post({ text: "Q3", media: { mediaUrn: "urn:li:image:1", altText: "A chart" } });

    expect(linkedin.requests.map((r) => `${r.method} ${r.url.pathname}`)).toEqual([
      "GET /rest/images/urn%3Ali%3Aimage%3A1",
      "POST /rest/posts",
    ]);
    const [post] = linkedin.requestsTo(POSTS_URL);
    expect(JSON.parse(post!.body).content).toEqual({ media: { id: "urn:li:image:1", altText: "A chart" } });
  });

  it("posts a document with its title", async () => {
    linkedin.scriptMedia();
    linkedin.scriptActions();

    await page.post({ text: "Report", media: { mediaUrn: "urn:li:document:1", title: "Q3 report" } });

    expect(linkedin.requestsTo(`${DOCUMENTS_URL}/`)).toHaveLength(1);
    const [post] = linkedin.requestsTo(POSTS_URL);
    expect(JSON.parse(post!.body).content).toEqual({ media: { id: "urn:li:document:1", title: "Q3 report" } });
  });

  it("refuses a document without a title before any LinkedIn call", async () => {
    await expect(page.post({ text: "Report", media: { mediaUrn: "urn:li:document:1" } })).rejects.toThrow(
      "A post with a document needs a title.",
    );
    expect(linkedin.requests).toHaveLength(0);
  });

  it("refuses a URN that is not an image or a document before any LinkedIn call", async () => {
    await expect(page.post({ text: "Hi", media: { mediaUrn: "urn:li:share:1" } })).rejects.toThrow(
      "urn:li:share:1 is not an image or a document. Pass the mediaUrn that linkedin-page-upload returned.",
    );
    expect(linkedin.requests).toHaveLength(0);
  });

  it("publishes nothing while LinkedIn processes the file", async () => {
    linkedin.scriptMedia("PROCESSING");
    linkedin.scriptActions();

    await expect(page.post({ text: "Q3", media: { mediaUrn: "urn:li:image:1" } })).rejects.toThrow(
      "LinkedIn is still processing urn:li:image:1 (PROCESSING). Call linkedin-page-post again later.",
    );
    expect(linkedin.requestsTo(POSTS_URL)).toHaveLength(0);
  });

  it("refuses a file that LinkedIn could not process", async () => {
    linkedin.scriptMedia("PROCESSING_FAILED");
    linkedin.scriptActions();

    await expect(page.post({ text: "Q3", media: { mediaUrn: "urn:li:image:1" } })).rejects.toThrow(
      "LinkedIn could not process urn:li:image:1. The file can be too large or damaged, or LinkedIn failed. " +
        "Upload a different file.",
    );
    expect(linkedin.requestsTo(POSTS_URL)).toHaveLength(0);
  });

  it("refuses a file that another Page uploaded", async () => {
    linkedin.scriptMedia("AVAILABLE", "urn:li:organization:222");
    linkedin.scriptActions();

    await expect(page.post({ text: "Q3", media: { mediaUrn: "urn:li:image:1" } })).rejects.toThrow(
      "urn:li:image:1 belongs to urn:li:organization:222, not to urn:li:organization:111. " +
        "Upload the file again with the organizationId of the post.",
    );
    expect(linkedin.requestsTo(POSTS_URL)).toHaveLength(0);
  });
});

describe("upload", () => {
  it("uploads an image through the Images API and reports its status", async () => {
    linkedin.scriptMedia("PROCESSING");

    expect(await page.upload({ contentType: "image/png", bytes: PNG })).toEqual({
      mediaUrn: "urn:li:image:1",
      status: "PROCESSING",
      kind: "image",
    });
    const [start] = linkedin.requestsTo(`${IMAGES_URL}?action=initializeUpload`);
    expect(JSON.parse(start!.body)).toEqual({ initializeUploadRequest: { owner: "urn:li:organization:111" } });
    const [put] = linkedin.requestsTo(UPLOAD_URL);
    expect(put!.method).toBe("PUT");
    expect(put!.url.toString()).toBe(`${UPLOAD_URL}image-1`);
    expect(put!.headers).toEqual({ Authorization: "Bearer access-1", "Content-Type": "image/png" });
    expect(put!.bytes).toEqual(PNG);
    const [status] = linkedin.requestsTo(`${IMAGES_URL}/`);
    expect(status!.url.pathname).toBe("/rest/images/urn%3Ali%3Aimage%3A1");
  });

  it("uploads a PDF through the Documents API", async () => {
    linkedin.scriptMedia();

    expect(await page.upload({ contentType: "application/pdf", bytes: PDF })).toEqual({
      mediaUrn: "urn:li:document:1",
      status: "AVAILABLE",
      kind: "document",
    });
    expect(linkedin.requestsTo(`${DOCUMENTS_URL}?action=initializeUpload`)).toHaveLength(1);
    expect(linkedin.requestsTo(IMAGES_URL)).toHaveLength(0);
    expect(linkedin.requestsTo(UPLOAD_URL)[0]!.bytes).toEqual(PDF);
  });

  it("refuses a file type that LinkedIn does not accept before any LinkedIn call", async () => {
    await expect(page.upload({ contentType: "image/webp", bytes: PNG })).rejects.toThrow(
      "LinkedIn does not accept image/webp. " +
        "Attach a JPG, GIF or PNG image, or a PDF, DOC, DOCX, PPT or PPTX document.",
    );
    expect(linkedin.requests).toHaveLength(0);
  });

  it("throws the status read error after a good upload", async () => {
    linkedin.scriptMedia();
    linkedin.on("GET", `${IMAGES_URL}/`, () => json({ message: "Service Unavailable" }, 503));

    await expect(page.upload({ contentType: "image/png", bytes: PNG })).rejects.toThrow(
      'LinkedIn image status 503: {"message":"Service Unavailable"}',
    );
    expect(linkedin.requestsTo(UPLOAD_URL)).toHaveLength(1);
  });
});
