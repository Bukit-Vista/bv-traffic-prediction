import { describe, expect, it } from "vitest";
import { appendTrafficTileClientRevision, resolveTrafficTileUrlTemplate } from "@/lib/map/traffic-tile-url";

describe("traffic vector tile URL", () => {
  it("makes a same-origin API template absolute without encoding tile placeholders", () => {
    expect(resolveTrafficTileUrlTemplate(
      "/api/v1/traffic/tiles/snapshot/{z}/{x}/{y}",
      "https://mobility.example.com"
    )).toBe("https://mobility.example.com/api/v1/traffic/tiles/snapshot/{z}/{x}/{y}");
  });

  it("preserves an already absolute provider template", () => {
    const template = "https://tiles.example.com/traffic/{z}/{x}/{y}";
    expect(resolveTrafficTileUrlTemplate(template, "https://mobility.example.com")).toBe(template);
  });

  it("normalizes missing and duplicate separators", () => {
    expect(resolveTrafficTileUrlTemplate("api/tiles/{z}/{x}/{y}", "http://localhost:3000/"))
      .toBe("http://localhost:3000/api/tiles/{z}/{x}/{y}");
  });

  it("adds a client cache revision without encoding MapLibre placeholders", () => {
    expect(appendTrafficTileClientRevision(
      "https://mobility.example.com/traffic/{z}/{x}/{y}"
    )).toBe("https://mobility.example.com/traffic/{z}/{x}/{y}?client=2");
    expect(appendTrafficTileClientRevision(
      "https://mobility.example.com/traffic/{z}/{x}/{y}?token=public",
      "2-retry-1"
    )).toBe("https://mobility.example.com/traffic/{z}/{x}/{y}?token=public&client=2-retry-1");
  });
});
