import { describe, it, expect } from "vitest";
import { topicChipStyle } from "../../src/lib/topic-chip";

describe("topicChipStyle", () => {
  it("heaviest chip gets max size + full opacity", () => {
    const s = topicChipStyle(1, 1);
    expect(s.fontSize).toBe("14.0px");
    expect(s.opacity).toBeCloseTo(1, 5);
  });

  it("half-weight chip scales to mid range", () => {
    const s = topicChipStyle(0.5, 1);
    expect(s.fontSize).toBe("12.0px");
    expect(s.opacity).toBeCloseTo(0.8, 5);
  });

  it("floor clamps tiny relative weights so chips stay legible", () => {
    const s = topicChipStyle(0.001, 1);
    // rel clamped to 0.25: 10 + 0.25*4 = 11.0px, 0.6 + 0.25*0.4 = 0.7
    expect(s.fontSize).toBe("11.0px");
    expect(s.opacity).toBeCloseTo(0.7, 5);
  });

  it("handles degenerate maxWeight (0 or NaN) by treating it as 1", () => {
    const s1 = topicChipStyle(0.5, 0);
    const s2 = topicChipStyle(0.5, Number.NaN);
    // Both should fall back to max=1, so rel=0.5.
    expect(s1.fontSize).toBe("12.0px");
    expect(s2.fontSize).toBe("12.0px");
  });
});
