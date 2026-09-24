import { describe, expect, it } from "bun:test";
import type { ChoiceResult } from "../../src/index.js";
import {
  checkDistribution,
  sampleWithTemperature,
  seededRandom,
} from "./sampling.js";

const decision = (
  probabilities: Record<string, number>,
): ChoiceResult<string> => ({
  choice: "ignored",
  confidence: 0,
  probabilities,
});

describe("decision temperature", () => {
  it("defaults to the original distribution at temperature one", () => {
    const source = decision({ a: 0.8, b: 0.2 });
    const result = sampleWithTemperature(source, undefined, () => 0.85);
    expect(result.selected).toBe("b");
    expect(result.probabilities).toEqual(source.probabilities);
    expect(result.draw).toBe(0.85);
  });

  it("concentrates or flattens positive probabilities", () => {
    const source = decision({ a: 0.8, b: 0.2 });
    const cold = sampleWithTemperature(source, 0.5, () => 0.85);
    const hot = sampleWithTemperature(source, 2, () => 0.7);
    expect(cold.probabilities.a).toBeCloseTo(16 / 17);
    expect(cold.selected).toBe("a");
    expect(hot.probabilities.a).toBeCloseTo(2 / 3);
    expect(hot.selected).toBe("b");
    expect(source.probabilities).toEqual({ a: 0.8, b: 0.2 });
  });

  it("selects the argmax at zero without consulting randomness", () => {
    const result = sampleWithTemperature(
      decision({ a: 0.2, b: 0.8 }),
      0,
      () => {
        throw new Error("No random draw expected");
      },
    );
    expect(result).toEqual({
      selected: "b",
      probabilities: { a: 0, b: 1 },
      draw: null,
    });
  });

  it("breaks zero-temperature ties consistently despite response order", () => {
    expect(
      sampleWithTemperature(decision({ b: 0.5, a: 0.5 }), 0).selected,
    ).toBe("a");
    expect(
      sampleWithTemperature(decision({ a: 0.5, b: 0.5 }), 0).selected,
    ).toBe("a");
  });

  it("preserves zero-probability exclusions and handles tiny temperatures", () => {
    expect(
      sampleWithTemperature(decision({ impossible: 0, allowed: 1 }), 1, () => 0)
        .selected,
    ).toBe("allowed");
    const result = sampleWithTemperature(
      decision({ a: 0.9, b: 0.1, impossible: 0 }),
      Number.MIN_VALUE,
      () => 0.99,
    );
    expect(result.selected).toBe("a");
    expect(result.probabilities).toEqual({ a: 1, b: 0, impossible: 0 });
  });

  it.each([-1, Infinity, NaN])(
    "rejects invalid temperature %s",
    (temperature) => {
      expect(() =>
        sampleWithTemperature(decision({ a: 1 }), temperature),
      ).toThrow("temperature");
    },
  );
});

describe("decision validation", () => {
  it("accepts complete distributions with rounding-compatible totals", () => {
    expect(() =>
      checkDistribution({ probabilities: { a: 0.33, b: 0.33, c: 0.33 } }, [
        "a",
        "b",
        "c",
      ]),
    ).not.toThrow();
  });

  it("rejects missing, extraneous, negative, and unnormalized weights", () => {
    for (const probabilities of [
      { a: 1 },
      { a: 1, b: 0, c: 0 },
      { a: -0.1, b: 1.1 },
      { a: 0.1, b: 0.1 },
    ])
      expect(() => checkDistribution({ probabilities }, ["a", "b"])).toThrow();
  });

  it("reproduces the draw sequence for a fixed seed", () => {
    const a = seededRandom(42),
      b = seededRandom(42),
      c = seededRandom(43);
    const first = Array.from({ length: 12 }, a);
    expect(Array.from({ length: 12 }, b)).toEqual(first);
    expect(Array.from({ length: 12 }, c)).not.toEqual(first);
    expect(first.every((value) => value >= 0 && value < 1)).toBe(true);
  });
});
