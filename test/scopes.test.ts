import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REQUESTED_SCOPES, SCOPE_NEEDS, grantedScopes, missingScopes } from "../src/adapters/linkedin/scopes.js";

/** The grant of a Page connection made before connect requested the feed scopes. */
const BEFORE_FEED_SCOPES = ["r_organization_social", "w_organization_social", "rw_organization_admin"];

describe("grantedScopes", () => {
  it("parses comma- and space-separated scope text", () => {
    expect(grantedScopes(REQUESTED_SCOPES.join(","))).toEqual(REQUESTED_SCOPES);
    expect(grantedScopes(` ${REQUESTED_SCOPES.join(" ")} `)).toEqual(REQUESTED_SCOPES);
  });

  it("accepts a grant without the r_ scopes", () => {
    const writeOnly = ["w_organization_social", "w_organization_social_feed", "rw_organization_admin"];
    expect(grantedScopes(writeOnly.join(","))).toEqual(writeOnly);
  });

  it("refuses a grant that lacks a scope that a step needs", () => {
    expect(() => grantedScopes("r_organization_social")).toThrow(
      /^LinkedIn did not grant w_organization_social, w_organization_social_feed, rw_organization_admin\. /,
    );
  });

  it("refuses a grant that names no scopes", () => {
    expect(() => grantedScopes(null)).toThrow(
      "LinkedIn did not report the granted scopes, so the plugin cannot confirm " +
        "that it can act as the Page. Connect again.",
    );
  });
});

describe("missingScopes", () => {
  it("finds nothing missing in a full grant", () => {
    for (const action of ["post", "react", "comment"] as const) {
      expect(missingScopes(REQUESTED_SCOPES, action)).toEqual([]);
    }
  });

  it("lets a grant without the feed scopes post but not react or comment", () => {
    expect(missingScopes(BEFORE_FEED_SCOPES, "post")).toEqual([]);
    expect(missingScopes(BEFORE_FEED_SCOPES, "react")).toEqual(["w_organization_social_feed"]);
    expect(missingScopes(BEFORE_FEED_SCOPES, "comment")).toEqual(["w_organization_social_feed"]);
  });
});

describe("README.md", () => {
  it("shows the scope table of the module", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const section = readme.split("\n## Scopes\n")[1]!.split("\n## ")[0]!;
    const rows = [...section.matchAll(/^\| `(\w+)` \| ([^|]+) \|$/gm)].map(([, scope, needs]) => [
      scope,
      needs!.trim() === "none" ? [] : needs!.trim().split(", "),
    ]);

    expect(rows).toEqual(Object.entries(SCOPE_NEEDS));
  });
});
