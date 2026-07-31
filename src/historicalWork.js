export const calculateHistoricalMealWork = (meal) => {
  if (!meal || typeof meal !== "object") {
    return {
      hasWorkIn: false,
      hasWorkOut: false,
      canCalculate: false,
      workInAt: 0,
      workOutAt: 0,
      breakHours: 0,
      workHours: 0,
    };
  }

  const workInAt = Number(meal.workInAt) || 0;
  const workOutAt = Number(meal.workOutAt) || 0;
  const breakHours = Math.max(0, Number(meal.breakHours) || 0);
  const storedWorkHours = Math.max(0, Number(meal.workHours) || 0);
  const calculatedHours = workInAt && workOutAt > workInAt
    ? Math.max(0, (workOutAt - workInAt) / 1000 / 60 / 60 - breakHours)
    : 0;
  const workHours = storedWorkHours || calculatedHours;

  return {
    hasWorkIn: Boolean(workInAt),
    hasWorkOut: Boolean(workOutAt),
    canCalculate: workHours > 0,
    workInAt,
    workOutAt,
    breakHours,
    workHours,
  };
};
