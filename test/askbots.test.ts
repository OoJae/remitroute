import { describe, it, expect } from "vitest";
import { solveMath } from "../openclaw/skills/askbots/scripts/work.js";

describe("askbots rapid-math solver", () => {
  it("solves the documented challenge shape beyond 2^53 exactly", () => {
    // 847293 * 193847 + 582910384 needs integer math wider than a double.
    expect(solveMath("What is 847293 * 193847 + 582910384?")).toBe(
      (847293n * 193847n + 582910384n).toString(),
    );
  });
  it("applies normal operator precedence", () => {
    expect(solveMath("2 + 3 * 4")).toBe("14");
    expect(solveMath("(2 + 3) * 4")).toBe("20");
  });
  it("handles subtraction, division, and negatives", () => {
    expect(solveMath("Compute 100 - 40 / 4")).toBe("90");
    expect(solveMath("What is 5 - 12?")).toBe("-7");
  });
  it("throws on prompts with no expression rather than answering garbage", () => {
    expect(() => solveMath("no numbers here")).toThrow();
  });
});
