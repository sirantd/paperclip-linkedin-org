import { beforeEach, describe, expect, it } from "vitest";
import { linkedInPage, type PageCalls } from "../src/adapters/linkedin/page.js";
import { LINKEDIN_VERSION } from "../src/adapters/linkedin/constants.js";
import {
  COMMENTS_URL,
  DOCUMENTS_URL,
  FakeLinkedIn,
  IMAGES_URL,
  POSTS_URL,
  REACTIONS_URL,
  SHARE_STATS_URL,
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
  // The REST calls go through the host client; the file bytes go to the fake unchanged.
  page = linkedInPage(
    hostHttp(linkedin),
    { accessToken: "access-1", organizationUrn: "urn:li:organization:111" },
    linkedin.fetch,
  );
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

describe("react", () => {
  it("reacts as the Page, with LIKE when no type is given, and returns the reaction URN", async () => {
    linkedin.scriptActions();

    expect(await page.react("urn:li:share:1")).toEqual({
      reactionUrn: "urn:li:reaction:(urn:li:organization:111,urn:li:share:1)",
      reactionType: "LIKE",
    });

    const [req] = linkedin.requestsTo(REACTIONS_URL);
    expect(req!.headers.Authorization).toBe("Bearer access-1");
    expect(req!.url.searchParams.get("actor")).toBe("urn:li:organization:111");
    expect(JSON.parse(req!.body)).toEqual({ root: "urn:li:share:1", reactionType: "LIKE" });
  });

  it.each([409, 422])("counts a reaction that exists already (%i) as done, with no reaction URN", async (status) => {
    linkedin.on("POST", REACTIONS_URL, () => json({ code: "DUPLICATE_REACTION" }, status));

    expect(await page.react("urn:li:share:1", "PRAISE")).toEqual({ reactionUrn: null, reactionType: "PRAISE" });
  });

  it("returns no reaction URN when LinkedIn sends no body", async () => {
    linkedin.on("POST", REACTIONS_URL, () => new Response(null, { status: 201 }));

    expect(await page.react("urn:li:share:1")).toEqual({ reactionUrn: null, reactionType: "LIKE" });
  });
});

describe("comment", () => {
  it("comments as the Page and returns the comment URN", async () => {
    linkedin.scriptActions();

    expect(await page.comment("urn:li:share:1", "Nice")).toEqual({ commentUrn: "urn:li:comment:(urn:li:share:1,1)" });

    const [req] = linkedin.requestsTo(COMMENTS_URL);
    expect(req!.headers.Authorization).toBe("Bearer access-1");
    expect(req!.url.pathname).toBe("/rest/socialActions/urn%3Ali%3Ashare%3A1/comments");
    expect(JSON.parse(req!.body)).toEqual({
      actor: "urn:li:organization:111",
      object: "urn:li:share:1",
      message: { text: "Nice" },
    });
  });

  it("returns no comment URN when the body holds none", async () => {
    linkedin.on("POST", COMMENTS_URL, () => json({ id: "1" }, 201));

    expect(await page.comment("urn:li:share:1", "Nice")).toEqual({ commentUrn: null });
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

describe("stats", () => {
  const COUNTS = { impressionCount: 500, uniqueImpressionsCount: 320, clickCount: 12, likeCount: 7, commentCount: 2, shareCount: 1, engagement: 0.044 };

  it("reads the latest posts by the Page, then their statistics, and counts a silent post as 0", async () => {
    linkedin.scriptStats(
      [
        { id: "urn:li:share:2", createdAt: Date.UTC(2026, 9, 20), commentary: "Second post" },
        { id: "urn:li:ugcPost:1", createdAt: Date.UTC(2026, 9, 19), commentary: "First post" },
        { id: "urn:li:share:3" },
      ],
      { "urn:li:share:2": COUNTS, "urn:li:ugcPost:1": { impressionCount: 40, clickCount: 1, engagement: 0.025 } },
    );

    const rows = await page.stats({ count: 3 });

    expect(rows).toEqual([
      { postUrn: "urn:li:share:2", createdAt: "2026-10-20T00:00:00.000Z", textStart: "Second post", ...COUNTS },
      {
        postUrn: "urn:li:ugcPost:1",
        createdAt: "2026-10-19T00:00:00.000Z",
        textStart: "First post",
        impressionCount: 40,
        uniqueImpressionsCount: null,
        clickCount: 1,
        likeCount: 0,
        commentCount: 0,
        shareCount: 0,
        engagement: 0.025,
      },
      {
        postUrn: "urn:li:share:3",
        createdAt: null,
        textStart: null,
        impressionCount: 0,
        uniqueImpressionsCount: null,
        clickCount: 0,
        likeCount: 0,
        commentCount: 0,
        shareCount: 0,
        engagement: 0,
      },
    ]);
    const [finder] = linkedin.requestsTo(`${POSTS_URL}?`);
    expect(finder!.url.searchParams.get("q")).toBe("author");
    expect(finder!.url.searchParams.get("author")).toBe("urn:li:organization:111");
    expect(finder!.url.searchParams.get("count")).toBe("3");
    expect(finder!.headers).toMatchObject({ "X-RestLi-Method": "FINDER", "LinkedIn-Version": LINKEDIN_VERSION });
    const stats = linkedin.requestsTo(SHARE_STATS_URL);
    expect(stats.map((r) => [r.url.searchParams.get("shares"), r.url.searchParams.get("ugcPosts")])).toEqual([
      ["List(urn:li:share:2,urn:li:share:3)", null],
      [null, "List(urn:li:ugcPost:1)"],
    ]);
    expect(stats[0]!.url.searchParams.get("organizationalEntity")).toBe("urn:li:organization:111");
  });

  it("reads named posts without the finder", async () => {
    linkedin.scriptStats([], { "urn:li:share:9": COUNTS });

    const rows = await page.stats({ postUrns: ["urn:li:share:9", "urn:li:share:9"] });

    expect(rows).toEqual([{ postUrn: "urn:li:share:9", createdAt: null, textStart: null, ...COUNTS }]);
    expect(linkedin.requestsTo(`${POSTS_URL}?`)).toHaveLength(0);
  });

  it("refuses a URN that is not a post before any LinkedIn call", async () => {
    await expect(page.stats({ postUrns: ["urn:li:image:1"] })).rejects.toThrow(/urn:li:image:1 is not a post URN/);
    expect(linkedin.requests).toHaveLength(0);
  });

  it("asks LinkedIn for at most 50 latest posts", async () => {
    linkedin.scriptStats([], {});
    expect(await page.stats({ count: 500 })).toEqual([]);
    expect(linkedin.requestsTo(`${POSTS_URL}?`)[0]!.url.searchParams.get("count")).toBe("50");
    expect(linkedin.requestsTo(SHARE_STATS_URL)).toHaveLength(0);
  });
});
