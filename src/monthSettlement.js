// Authoritative staff-meal ledger: the website and its read-only API share this file.
import { applySubsidyMultiplier, calculateMonthlySettlement, getMealSubsidy, normalizeSubsidyMultiplier, resolveDailySubsidy } from "./settlement.js";
const formatTaipeiDateKey = (ts = Date.now()) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ts));

  const year = parts.find((p) => p.type === "year")?.value || "";
  const month = parts.find((p) => p.type === "month")?.value || "";
  const day = parts.find((p) => p.type === "day")?.value || "";
  return `${year}-${month}-${day}`;
};


const normalizeEmpId = value => String(value || "").trim().toUpperCase();
const getMonthKeyFromDateKey = value => String(value || "").slice(0, 7);
const formatHours = hours => Math.round((Number(hours) || 0) * 100) / 100;
export const calculateEmployeeWork = (records = []) => {
  const sorted = [...records].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

  const firstIn = sorted.find((r) => r.type === "上班");
  const lastOut = [...sorted].reverse().find((r) => r.type === "下班");

  let breakMs = 0;
  let breakStart = null;

  sorted.forEach((record) => {
    if (record.type === "休息開始") {
      breakStart = record.createdAt || 0;
    }

    if (record.type === "休息結束" && breakStart) {
      const end = record.createdAt || 0;
      if (end > breakStart) breakMs += end - breakStart;
      breakStart = null;
    }
  });

  const hasWorkIn = Boolean(firstIn);
  const hasWorkOut = Boolean(lastOut);
  const canCalculate = hasWorkIn && hasWorkOut && (lastOut.createdAt || 0) > (firstIn.createdAt || 0);

  if (!canCalculate) {
    return {
      hasWorkIn,
      hasWorkOut,
      canCalculate: false,
      workInAt: firstIn?.createdAt || 0,
      workOutAt: lastOut?.createdAt || 0,
      breakHours: 0,
      workHours: 0,
      subsidy: 0,
    };
  }

  const totalMs = Math.max(0, (lastOut.createdAt || 0) - (firstIn.createdAt || 0) - breakMs);
  const workHours = totalMs / 1000 / 60 / 60;
  const breakHours = breakMs / 1000 / 60 / 60;

  return {
    hasWorkIn,
    hasWorkOut,
    canCalculate: true,
    workInAt: firstIn.createdAt || 0,
    workOutAt: lastOut.createdAt || 0,
    breakHours,
    workHours,
    subsidy: getMealSubsidy(workHours),
  };
};

export function buildMonthRecords({ employees = [], records = [], mealRecords = {}, attendanceSnapshots = {}, subsidyAdjustments = {}, selectedMonth, cutoffDate = "" }) {
  const getSubsidyMultiplier = (monthKey, empKey) => normalizeSubsidyMultiplier(subsidyAdjustments?.[monthKey]?.[normalizeEmpId(empKey)]?.multiplier);
    const cleanStoreName = (storeName = "") => {
      const name = String(storeName || "").trim();
      if (name.includes("西螺")) return "西螺";
      if (name.includes("斗南")) return "斗南";
      return name || "未填店名";
    };

    const employeeMap = {};
    employees.forEach((emp) => {
      const key = emp.empId || emp.id;
      if (!key) return;
      employeeMap[normalizeEmpId(key)] = {
        empId: key,
        name: emp.name || key,
        store: cleanStoreName(emp.store || "未填店名"),
        role: emp.role || "未設定",
      };
    });

    const recordsByEmpDate = {};
    records.forEach((record) => {
      const recordDateKey = record?.dateKey || (record?.createdAt ? formatTaipeiDateKey(record.createdAt) : "");
      if (!recordDateKey || getMonthKeyFromDateKey(recordDateKey) !== selectedMonth) return;
      const empKey = normalizeEmpId(record.empId);
      if (!empKey) return;
      const rowKey = `${empKey}_${recordDateKey}`;
      if (!recordsByEmpDate[rowKey]) recordsByEmpDate[rowKey] = [];
      recordsByEmpDate[rowKey].push(record);

      if (!employeeMap[empKey]) {
        employeeMap[empKey] = {
          empId: record.empId || empKey,
          name: record.name || empKey,
          store: cleanStoreName(record.store || "未填店名"),
          role: record.role || "未設定",
        };
      }
    });

    const mealsByEmpDate = {};
    Object.entries(mealRecords || {}).forEach(([key, meal]) => {
      if (key === "payments" || !meal || typeof meal !== "object") return;
      if (!meal.dateKey || getMonthKeyFromDateKey(meal.dateKey) !== selectedMonth) return;
      const empKey = normalizeEmpId(meal.empId);
      if (!empKey) return;
      mealsByEmpDate[`${empKey}_${meal.dateKey}`] = meal;

      if (!employeeMap[empKey]) {
        employeeMap[empKey] = {
          empId: meal.empId || empKey,
          name: meal.name || empKey,
          store: cleanStoreName(meal.store || "未填店名"),
          role: meal.role || "未設定",
        };
      }
    });

    const snapshotsByEmpDate = {};
    Object.values(attendanceSnapshots || {}).forEach((snapshot) => {
      if (!snapshot || typeof snapshot !== "object" || !snapshot.dateKey) return;
      const empKey = normalizeEmpId(snapshot.empId);
      if (!empKey) return;
      snapshotsByEmpDate[`${empKey}_${snapshot.dateKey}`] = snapshot;
      if (!employeeMap[empKey]) {
        employeeMap[empKey] = {
          empId: snapshot.empId || empKey,
          name: snapshot.name || empKey,
          store: cleanStoreName(snapshot.store || "未填店名"),
          role: snapshot.role || "未設定",
        };
      }
    });

    const keysByEmp = {};
    Array.from(new Set([
      ...Object.keys(recordsByEmpDate),
      ...Object.keys(snapshotsByEmpDate),
      ...Object.keys(mealsByEmpDate),
    ])).forEach((rowKey) => {
      const [empKey] = rowKey.split("_");
      if (!keysByEmp[empKey]) keysByEmp[empKey] = [];
      keysByEmp[empKey].push(rowKey);
    });

    const rows = [];

    Object.entries(keysByEmp).forEach(([empKey, rowKeys]) => {
      let balance = 0;
      rowKeys.sort((a, b) => {
        const dateA = a.split("_")[1] || "";
        const dateB = b.split("_")[1] || "";
        return dateA.localeCompare(dateB);
      }).forEach((rowKey) => {
        const dateKey = rowKey.split("_")[1] || "";
        const emp = employeeMap[empKey] || { empId: empKey, name: empKey, store: "未填店名", role: "未設定" };
        const dayRecords = recordsByEmpDate[rowKey] || [];
        const work = calculateEmployeeWork(dayRecords);
        const snapshot = snapshotsByEmpDate[rowKey] || null;
        const meal = mealsByEmpDate[rowKey] || null;
        const hasMeal = Boolean(meal);
        const mealAmount = hasMeal ? Number(meal.mealAmount) || 0 : 0;
        const resolvedHistory = resolveDailySubsidy({
          canCalculateWork: work.canCalculate,
          calculatedWorkHours: work.workHours,
          snapshot,
          meal,
        });
        const hasAnyWork = work.hasWorkIn || work.hasWorkOut || Number(snapshot?.recordCount || 0) > 0 || resolvedHistory.restoredFromHistory;
        const workHours = formatHours(resolvedHistory.workHours);
        const breakHours = work.canCalculate ? formatHours(work.breakHours) : formatHours(resolvedHistory.breakHours);
        const baseDailySubsidy = resolvedHistory.subsidy;
        const subsidyMultiplier = getSubsidyMultiplier(selectedMonth, emp.empId || empKey);
        const dailySubsidy = applySubsidyMultiplier(baseDailySubsidy, subsidyMultiplier);
        const mealNeedsApproval = Boolean(meal?.approvalRequired);
        const approvalStatus = meal?.approvalStatus || (mealNeedsApproval ? "pending" : "approved");
        const mealApproved = !hasMeal || !mealNeedsApproval || approvalStatus === "approved";
        const earnedSubsidyAmount = (work.canCalculate || resolvedHistory.restoredFromHistory) && mealApproved ? dailySubsidy : 0;
        const balanceBeforeUse = balance + earnedSubsidyAmount;
        const usedSubsidyAmount = hasMeal && mealApproved ? Math.min(balanceBeforeUse, mealAmount) : 0;
        const unpaidBeforeDiscount = hasMeal ? Math.max(0, mealAmount - usedSubsidyAmount) : 0;
        const employeePay = Math.round(unpaidBeforeDiscount * 0.9);
        balance = Math.max(0, balanceBeforeUse - usedSubsidyAmount);

        let status = "補助累積";
        if (hasMeal && mealNeedsApproval && approvalStatus === "pending") status = "待審核";
        else if (hasMeal && mealNeedsApproval && approvalStatus === "rejected") status = "未通過";
        else if (hasMeal && employeePay > 0) status = "超額";
        else if (hasMeal) status = "已抵扣";
        if (hasMeal && !hasAnyWork) status = "無上班紀錄";
        if (hasAnyWork && !work.canCalculate) status = "工時異常";
        if (resolvedHistory.source === "snapshot" && mealApproved) status = "月結快照";
        else if (resolvedHistory.restoredFromHistory && mealApproved) status = "歷史工時已還原";

        rows.push({
          key: meal?.key || `${dateKey}_${emp.empId}`,
          dateKey,
          monthKey: selectedMonth,
          store: cleanStoreName(meal?.store || emp.store || "未填店名"),
          name: meal?.name || emp.name || emp.empId,
          empId: meal?.empId || emp.empId || empKey,
          role: meal?.role || emp.role || "未設定",
          workInAt: work.workInAt || snapshot?.workInAt || meal?.workInAt || 0,
          workOutAt: work.workOutAt || snapshot?.workOutAt || meal?.workOutAt || 0,
          workHours,
          breakHours,
          hasMeal,
          hasAnyWork,
          mealAmount,
          baseSubsidyAmount: baseDailySubsidy,
          subsidyMultiplier,
          calculatedSubsidyAmount: dailySubsidy,
          earnedSubsidyAmount,
          subsidyAmount: usedSubsidyAmount,
          usedSubsidyAmount,
          overAmount: unpaidBeforeDiscount,
          employeePay,
          balanceAfter: balance,
          approvalRequired: mealNeedsApproval,
          approvalStatus,
          status,
          note: meal?.note || "",
        });
      });
    });

    return rows
      .filter((item) => !cutoffDate || item.dateKey <= cutoffDate)
      .sort((a, b) => String(b.dateKey || "").localeCompare(String(a.dateKey || "")) || String(a.name || "").localeCompare(String(b.name || ""), "zh-Hant"));
}

export function summarizeMonthlyRows(adminMonthRecords) {
    const map = {};
    const orderedRows = [...adminMonthRecords].sort((a, b) => String(a.dateKey || "").localeCompare(String(b.dateKey || "")));

    orderedRows.forEach((item) => {
      const key = item.empId || item.name || "UNKNOWN";
      if (!map[key]) {
        map[key] = {
          empId: key,
          name: item.name || "",
          store: item.store || "",
          days: 0,
          mealDays: 0,
          totalMealAmount: 0,
          totalEarnedSubsidy: 0,
          totalUsedSubsidy: 0,
          totalSubsidy: 0,
          totalOverAmount: 0,
          totalEmployeePay: 0,
          endingBalance: 0,
          pendingCount: 0,
        };
      }

      if (item.hasAnyWork) map[key].days += 1;
      if (item.hasMeal) map[key].mealDays += 1;
      map[key].totalMealAmount += Number(item.mealAmount) || 0;
      map[key].totalEarnedSubsidy += Number(item.earnedSubsidyAmount) || 0;
      if (item.status === "待審核") map[key].pendingCount += 1;
    });

    return Object.values(map)
      .map((item) => {
        const settlement = calculateMonthlySettlement(item.totalMealAmount, item.totalEarnedSubsidy);
        return {
          ...item,
          totalUsedSubsidy: settlement.usedSubsidy,
          totalSubsidy: settlement.usedSubsidy,
          totalOverAmount: settlement.overAmount,
          totalEmployeePay: settlement.employeePay,
          endingBalance: settlement.remainingSubsidy,
        };
      })
      .sort((a, b) => b.totalEmployeePay - a.totalEmployeePay);
}


export function attachMonthlyPayment(summary, monthKey, payments = {}) {
  const payment = payments[`${monthKey}_${summary.empId}`] || {};
  return { ...summary, monthKey, paid: Boolean(payment.paid), paidAmount: Number(payment.amount || 0), paidAt: Number(payment.paidAt || 0), amountDue: payment.paid ? 0 : summary.totalEmployeePay };
}
