import { describe, expect, it } from "vitest";
import {
  asNotifyLevels,
  defaultNotifyLevels,
  impactLevel,
  shouldNotify,
} from "@/lib/market/impact";

describe("impact levels", () => {
  it("maps the importance score onto the four bands", () => {
    expect(impactLevel(0)).toBe("small");
    expect(impactLevel(30)).toBe("small");
    expect(impactLevel(40)).toBe("small");
    expect(impactLevel(41)).toBe("medium");
    expect(impactLevel(60)).toBe("medium");
    expect(impactLevel(61)).toBe("large");
    expect(impactLevel(80)).toBe("large");
    expect(impactLevel(85)).toBe("extreme");
    expect(impactLevel(100)).toBe("extreme");
  });

  it("uses tighter defaults on the cheap plans", () => {
    expect(defaultNotifyLevels("free")).toEqual(["large", "extreme"]);
    expect(defaultNotifyLevels("lite")).toEqual(["medium", "large", "extreme"]);
    expect(defaultNotifyLevels("plus")).toHaveLength(4);
    expect(defaultNotifyLevels("pro_plus")).toHaveLength(4);
  });

  it("only notifies for the levels the user kept on", () => {
    const free = defaultNotifyLevels("free");
    expect(shouldNotify(91, free)).toBe(true);
    expect(shouldNotify(64, free)).toBe(true);
    expect(shouldNotify(52, free)).toBe(false);
    expect(shouldNotify(30, free)).toBe(false);
    expect(shouldNotify(91, [])).toBe(false);
  });

  it("falls back to the plan default when nothing is stored", () => {
    expect(asNotifyLevels(null, "free")).toEqual(["large", "extreme"]);
    expect(asNotifyLevels(["bogus", "extreme"], "free")).toEqual(["extreme"]);
    expect(asNotifyLevels([], "free")).toEqual([]);
  });
});
