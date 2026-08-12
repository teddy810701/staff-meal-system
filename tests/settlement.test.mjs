import test from "node:test";
import assert from "node:assert/strict";
import { calculateMonthlySettlement, resolveDailySubsidy } from "../src/settlement.js";

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

test("有完整打卡時優先依實際工時計算補助", () => {
  assert.deepEqual(resolveDailySubsidy({
    canCalculateWork: true,
    calculatedWorkHours: 5.5,
    meal: { workHours: 7, subsidyAmount: 100 },
  }), {
    workHours: 5.5,
    breakHours: 0,
    subsidy: 60,
    source: "records",
    restoredFromHistory: false,
  });
});

test("打卡已刪除時可由歷史工時還原補助", () => {
  assert.deepEqual(resolveDailySubsidy({
    canCalculateWork: false,
    calculatedWorkHours: 0,
    meal: { workHours: 4.28, subsidyAmount: 60 },
  }), {
    workHours: 4.28,
    breakHours: 0,
    subsidy: 60,
    source: "meal",
    restoredFromHistory: true,
  });
});

test("新版歷史紀錄優先採用已封存的計算補助", () => {
  assert.deepEqual(resolveDailySubsidy({
    canCalculateWork: false,
    calculatedWorkHours: 0,
    meal: { workHours: 3.5, calculatedSubsidyAmount: 100, subsidyAmount: 0 },
  }), {
    workHours: 3.5,
    breakHours: 0,
    subsidy: 100,
    source: "meal",
    restoredFromHistory: true,
  });
});

test("最舊紀錄沒有工時時仍可採用已保存補助", () => {
  assert.deepEqual(resolveDailySubsidy({
    canCalculateWork: false,
    calculatedWorkHours: 0,
    meal: { subsidyAmount: 100 },
  }), {
    workHours: 0,
    breakHours: 0,
    subsidy: 100,
    source: "meal",
    restoredFromHistory: true,
  });
});

test("原始打卡刪除後優先使用月結快照", () => {
  assert.deepEqual(resolveDailySubsidy({
    canCalculateWork: false,
    calculatedWorkHours: 0,
    snapshot: { recordCount: 4, canCalculate: true, workHours: 7.5, breakHours: 0.5, subsidyAmount: 100 },
    meal: { workHours: 3, subsidyAmount: 0 },
  }), {
    workHours: 7.5,
    breakHours: 0.5,
    subsidy: 100,
    source: "snapshot",
    restoredFromHistory: true,
  });
});
