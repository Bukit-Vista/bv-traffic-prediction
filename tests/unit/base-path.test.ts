import { describe, expect, it } from "vitest";
import { withBasePath } from "@/lib/urls/base-path";

describe("base path URLs", () => {
  it("prefixes root-relative URLs including their query string", () => {
    expect(withBasePath("/api/v1/mobility/display-grid?limit=5000", "/asteria"))
      .toBe("/asteria/api/v1/mobility/display-grid?limit=5000");
  });

  it("does not prefix a URL twice", () => {
    expect(withBasePath("/asteria/api/v1/health", "/asteria/"))
      .toBe("/asteria/api/v1/health");
  });

  it("leaves external and protocol-relative URLs unchanged", () => {
    expect(withBasePath("https://example.com/api", "/asteria")).toBe("https://example.com/api");
    expect(withBasePath("//example.com/api", "/asteria")).toBe("//example.com/api");
  });

  it("is a no-op when no deployment path is configured", () => {
    expect(withBasePath("/api/v1/health", "")).toBe("/api/v1/health");
  });
});
