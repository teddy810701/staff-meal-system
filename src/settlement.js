export const calculateMonthlySettlement = (mealAmount, earnedSubsidy) => {
  const totalMealAmount = Math.max(0, Number(mealAmount) || 0);
  const totalEarnedSubsidy = Math.max(0, Number(earnedSubsidy) || 0);
  const usedSubsidy = Math.min(totalMealAmount, totalEarnedSubsidy);
  const remainingSubsidy = Math.max(0, totalEarnedSubsidy - totalMealAmount);
  const overAmount = Math.max(0, totalMealAmount - totalEarnedSubsidy);

  return {
    totalMealAmount,
    totalEarnedSubsidy,
    usedSubsidy,
    remainingSubsidy,
    overAmount,
    employeePay: Math.round(overAmount * 0.9),
  };
};

export const getMealSubsidy = (workHours) => {
  const hours = Number(workHours) || 0;
  if (hours < 4) return 0;
  if (hours < 6) return 60;
  return 100;
};

export const normalizeSubsidyMultiplier = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 1;
  return Math.min(1, Math.max(0, Math.round(parsed * 1000) / 1000));
};

export const applySubsidyMultiplier = (amount, multiplier) => (
  Math.round(Math.max(0, Number(amount) || 0) * normalizeSubsidyMultiplier(multiplier))
);

export const resolveDailySubsidy = ({ canCalculateWork, calculatedWorkHours, snapshot, meal }) => {
  if (canCalculateWork) {
    return {
      workHours: Number(calculatedWorkHours) || 0,
      breakHours: 0,
      subsidy: getMealSubsidy(calculatedWorkHours),
      source: "records",
      restoredFromHistory: false,
    };
  }

  if (snapshot && typeof snapshot === "object" && Number(snapshot.recordCount || 0) > 0) {
    return {
      workHours: Math.max(0, Number(snapshot.workHours) || 0),
      breakHours: Math.max(0, Number(snapshot.breakHours) || 0),
      subsidy: snapshot.canCalculate ? Math.max(0, Number(snapshot.subsidyAmount) || 0) : 0,
      source: "snapshot",
      restoredFromHistory: true,
    };
  }

  if (!meal || typeof meal !== "object") {
    return { workHours: 0, breakHours: 0, subsidy: 0, source: "none", restoredFromHistory: false };
  }

  const hasSavedWorkHours = meal.workHours !== undefined && meal.workHours !== null && meal.workHours !== "";
  const savedWorkHours = hasSavedWorkHours ? Math.max(0, Number(meal.workHours) || 0) : 0;

  if (meal.baseSubsidyAmount !== undefined && meal.baseSubsidyAmount !== null) {
    return {
      workHours: savedWorkHours,
      breakHours: Math.max(0, Number(meal.breakHours) || 0),
      subsidy: Math.max(0, Number(meal.baseSubsidyAmount) || 0),
      source: "meal",
      restoredFromHistory: true,
    };
  }

  if (meal.calculatedSubsidyAmount !== undefined && meal.calculatedSubsidyAmount !== null) {
    return {
      workHours: savedWorkHours,
      breakHours: Math.max(0, Number(meal.breakHours) || 0),
      subsidy: Math.max(0, Number(meal.calculatedSubsidyAmount) || 0),
      source: "meal",
      restoredFromHistory: true,
    };
  }

  if (hasSavedWorkHours) {
    return {
      workHours: savedWorkHours,
      breakHours: Math.max(0, Number(meal.breakHours) || 0),
      subsidy: getMealSubsidy(savedWorkHours),
      source: "meal",
      restoredFromHistory: true,
    };
  }

  if (meal.subsidyAmount !== undefined && meal.subsidyAmount !== null) {
    return {
      workHours: 0,
      breakHours: Math.max(0, Number(meal.breakHours) || 0),
      subsidy: Math.max(0, Number(meal.subsidyAmount) || 0),
      source: "meal",
      restoredFromHistory: true,
    };
  }

  return { workHours: 0, breakHours: 0, subsidy: 0, source: "none", restoredFromHistory: false };
};
