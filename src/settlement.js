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

export const resolveDailySubsidy = ({ canCalculateWork, calculatedWorkHours, meal }) => {
  if (canCalculateWork) {
    return {
      workHours: Number(calculatedWorkHours) || 0,
      subsidy: getMealSubsidy(calculatedWorkHours),
      restoredFromHistory: false,
    };
  }

  if (!meal || typeof meal !== "object") {
    return { workHours: 0, subsidy: 0, restoredFromHistory: false };
  }

  const hasSavedWorkHours = meal.workHours !== undefined && meal.workHours !== null && meal.workHours !== "";
  const savedWorkHours = hasSavedWorkHours ? Math.max(0, Number(meal.workHours) || 0) : 0;

  if (meal.calculatedSubsidyAmount !== undefined && meal.calculatedSubsidyAmount !== null) {
    return {
      workHours: savedWorkHours,
      subsidy: Math.max(0, Number(meal.calculatedSubsidyAmount) || 0),
      restoredFromHistory: true,
    };
  }

  if (hasSavedWorkHours) {
    return {
      workHours: savedWorkHours,
      subsidy: getMealSubsidy(savedWorkHours),
      restoredFromHistory: true,
    };
  }

  if (meal.subsidyAmount !== undefined && meal.subsidyAmount !== null) {
    return {
      workHours: 0,
      subsidy: Math.max(0, Number(meal.subsidyAmount) || 0),
      restoredFromHistory: true,
    };
  }

  return { workHours: 0, subsidy: 0, restoredFromHistory: false };
};
