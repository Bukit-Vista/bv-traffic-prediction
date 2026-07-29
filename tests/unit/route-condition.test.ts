import { describe, expect, it } from "vitest";
import { routeConditionStyle } from "@/lib/map/route-condition";

describe("route condition styling", () => {
  it("renders faster-than-typical routes in green", () => {
    const style = routeConditionStyle(.97);
    expect(style.tone).toBe("faster");
    expect(style.color).toBe("#25845e");
    expect(style.label).toContain("faster than typical");
  });

  it("makes increasingly slow routes progressively thicker and red", () => {
    const mild = routeConditionStyle(1.05);
    const severe = routeConditionStyle(1.4);
    expect(mild.tone).toBe("slower");
    expect(severe.tone).toBe("slower");
    expect(severe.width).toBeGreaterThan(mild.width);
    expect(severe.width).toBeLessThanOrEqual(12);
  });

  it("uses a neutral line at exactly typical travel time", () => {
    expect(routeConditionStyle(1)).toMatchObject({ tone: "typical", width: 4 });
  });
});
