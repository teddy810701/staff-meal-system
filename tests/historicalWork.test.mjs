import assert from "node:assert/strict";
import test from "node:test";

import { calculateHistoricalMealWork } from "../src/historicalWork.js";

test("uses the work values saved with a historical meal", () => {
  assert.deepEqual(calculateHistoricalMealWork({
    workInAt: 1_000,
    workOutAt: 30_601_000,
    breakHours: 0.5,
    workHours: 8,
  }), {
    hasWorkIn: true,
    hasWorkOut: true,
    canCalculate: true,
    workInAt: 1_000,
    workOutAt: 30_601_000,
    breakHours: 0.5,
    workHours: 8,
  });
});

test("reconstructs historical work hours from saved timestamps", () => {
  const result = calculateHistoricalMealWork({
    workInAt: 1_000,
    workOutAt: 30_601_000,
    breakHours: 0.5,
  });

  assert.equal(result.canCalculate, true);
  assert.equal(result.workHours, 8);
});

test("does not invent work when historical fields are absent", () => {
  assert.equal(calculateHistoricalMealWork({ mealAmount: 100 }).canCalculate, false);
});
