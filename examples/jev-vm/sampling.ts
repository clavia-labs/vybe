import {
  sample,
  type ChoiceResult,
  type NativeAnswer,
  type Random,
} from "../../src/index.js";

export function checkTemperature(temperature: number) {
  if (!Number.isFinite(temperature) || temperature < 0)
    throw new RangeError("temperature must be a finite non-negative number");
}

/** Apply temperature to the finite decision distribution, without changing it. */
export function sampleWithTemperature(
  decision: ChoiceResult<string>,
  temperature = 1,
  rng: Random = Math.random,
) {
  checkTemperature(temperature);
  const entries = Object.entries(decision.probabilities);
  if (
    !entries.length ||
    entries.some(
      ([, value]) => !Number.isFinite(value) || value < 0 || value > 1,
    )
  )
    throw new Error("Invalid decision probabilities");
  const maximum = Math.max(...entries.map(([, value]) => value));
  if (maximum <= 0)
    throw new Error("Decision probabilities must have positive mass");
  if (temperature === 0) {
    // Tie-breaking uses key order, independent of response object order or seed.
    const selected = entries
      .filter(([, value]) => value === maximum)
      .map(([key]) => key)
      .sort()[0]!;
    return {
      selected,
      probabilities: Object.fromEntries(
        entries.map(([key]) => [key, key === selected ? 1 : 0]),
      ),
      draw: null,
    };
  }
  const weights = entries.map(
    ([key, value]) =>
      [
        key,
        value === 0
          ? 0
          : temperature === 1
            ? value
            : Math.exp((Math.log(value) - Math.log(maximum)) / temperature),
      ] as const,
  );
  const total = weights.reduce((sum, [, value]) => sum + value, 0);
  const probabilities = Object.fromEntries(
    weights.map(([key, value]) => [key, value / total]),
  );
  const draw = rng();
  if (!Number.isFinite(draw) || draw < 0 || draw >= 1)
    throw new RangeError("rng must return a finite number in [0, 1)");
  // Exclude zero weights from sampling, including when the random draw is zero.
  const supported = Object.fromEntries(
    Object.entries(probabilities).filter(([, value]) => value > 0),
  );
  return {
    selected: sample({ ...decision, probabilities: supported }, () => draw),
    probabilities,
    draw,
  };
}

export function checkDistribution(native: NativeAnswer, options: string[]) {
  const probabilities = native.probabilities;
  const values = options.map((key) => probabilities?.[key]);
  const total = values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  // Jev 1.13 returns probabilities rounded to hundredths; observed totals can
  // be 0.99. Accept totals compatible with that rounding, then let sample()
  // normalize the weights. Preserve the raw distribution in the trace.
  const rounded = values.every(
    (value) =>
      typeof value === "number" &&
      Math.abs(value * 100 - Math.round(value * 100)) < 1e-8,
  );
  const lower = values.reduce<number>(
    (sum, value) => sum + Math.max(0, (value ?? 0) - 0.005),
    0,
  );
  const upper = values.reduce<number>(
    (sum, value) => sum + Math.min(1, (value ?? 0) + 0.005),
    0,
  );
  const validTotal =
    Math.abs(total - 1) <= 0.001 ||
    (rounded && lower <= 1 + 1e-10 && upper >= 1 - 1e-10);
  if (
    !probabilities ||
    Object.keys(probabilities).length !== options.length ||
    options.some((key) => !Object.hasOwn(probabilities, key)) ||
    values.some(
      (value) =>
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < 0 ||
        value > 1,
    ) ||
    !Number.isFinite(total) ||
    total <= 0 ||
    !validTotal
  )
    throw new Error(
      `Invalid probability distribution: total=${total}, options=${options.length}, returned=${Object.keys(probabilities ?? {}).length}, missing=${options.filter((key) => !Object.hasOwn(probabilities ?? {}, key)).join(",")}`,
    );
}

export function seededRandom(seed: number) {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(value ^ (value >>> 15), value | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}
