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
