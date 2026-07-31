import test from "node:test";
import assert from "node:assert/strict";
import { calculateMonthlySettlement } from "../src/settlement.js";

test("整月補助足夠時不產生應繳", () => {
  assert.deepEqual(calculateMonthlySettlement(2_230, 2_240), {
    totalMealAmount: 2_230,
    totalEarnedSubsidy: 2_240,
    usedSubsidy: 2_230,
    remainingSubsidy: 10,
    overAmount: 0,
    employeePay: 0,
  });
});

test("整月餐費超額時只對月底差額打九折", () => {
  assert.deepEqual(calculateMonthlySettlement(2_400, 2_240), {
    totalMealAmount: 2_400,
    totalEarnedSubsidy: 2_240,
    usedSubsidy: 2_240,
    remainingSubsidy: 0,
    overAmount: 160,
    employeePay: 144,
  });
});

test("不會同時出現剩餘補助與應繳金額", () => {
  for (const [meal, subsidy] of [[0, 100], [100, 100], [101, 100], [500, 720]]) {
    const result = calculateMonthlySettlement(meal, subsidy);
    assert.equal(result.remainingSubsidy > 0 && result.employeePay > 0, false);
  }
});
