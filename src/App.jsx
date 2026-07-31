import { useEffect, useMemo, useState } from "react";
import { ref, onValue, set, update, remove } from "firebase/database";
import { signInAnonymously, onAuthStateChanged } from "firebase/auth";
import { db, auth } from "./firebase";
import { calculateMonthlySettlement } from "./settlement";
import { exportMealWorkbook } from "./exportMealWorkbook";
import "./App.css";

const ADMIN_PASSWORD = "8888";
const ADMIN_DELETE_PIN = "1688";

const MANAGER_PASSWORDS = {
  "西螺": "a8888",
  "斗南": "b8888",
};

const APPROVAL_STATUS_TEXT = {
  pending: "待店長審核",
  approved: "已通過",
  rejected: "未通過",
};

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

const getMonthValue = (ts = Date.now()) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

const getMonthKeyFromDateKey = (dateKey = "") => String(dateKey || "").slice(0, 7);

const normalizeEmpId = (value) => String(value || "").trim().toUpperCase();

const formatStoreDisplayName = (value) => {
  const name = String(value || "").trim();
  if (name.includes("斗南")) return "斗南站前店";
  if (name.includes("西螺")) return "西螺文昌店";
  return name || "未填店名";
};

const formatTime = (timestamp) => {
  if (!timestamp) return "—";
  return new Date(timestamp).toLocaleTimeString("zh-TW", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
};

const formatHours = (hours) => {
  const value = Number(hours) || 0;
  return Math.round(value * 100) / 100;
};

const getMealSubsidy = (workHours) => {
  const hours = Number(workHours) || 0;
  if (hours < 4) return 0;
  if (hours < 6) return 60;
  return 100;
};


const escapeHtml = (value) => String(value ?? "")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

const buildExcelCell = (value, className = "") => `<td class="${className}">${escapeHtml(value)}</td>`;
const buildExcelNumberCell = (value, className = "") => `<td class="number ${className}">${Number(value) || 0}</td>`;

const calculateEmployeeWork = (records = []) => {
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

export default function App() {
  const [authReady, setAuthReady] = useState(false);
  const [authError, setAuthError] = useState("");

  const [employees, setEmployees] = useState([]);
  const [records, setRecords] = useState([]);
  const [mealRecords, setMealRecords] = useState({});
  const [dataReady, setDataReady] = useState({ employees: false, records: false, meals: false });
  const [dataError, setDataError] = useState("");
  const [isConnected, setIsConnected] = useState(true);

  const [empId, setEmpId] = useState("");
  const [mealDate, setMealDate] = useState(formatTaipeiDateKey());
  const [mealAmount, setMealAmount] = useState("");
  const [message, setMessage] = useState("");

  const [isAdmin, setIsAdmin] = useState(false);
  const [password, setPassword] = useState("");
  const [isManager, setIsManager] = useState(false);
  const [managerStore, setManagerStore] = useState("西螺");
  const [managerLoginStore, setManagerLoginStore] = useState("西螺");
  const [managerPassword, setManagerPassword] = useState("");
  const [selectedMonth, setSelectedMonth] = useState(getMonthValue());
  const [adminStoreFilter, setAdminStoreFilter] = useState("全部");
  const [editingMeal, setEditingMeal] = useState(null);
  const [editMealAmount, setEditMealAmount] = useState("");
  const [editNote, setEditNote] = useState("");

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (user) {
        setAuthError("");
        setAuthReady(true);
        return;
      }

      try {
        await signInAnonymously(auth);
      } catch (error) {
        setAuthError(`${error?.code || "auth/error"}｜${error?.message || "Firebase 登入失敗"}`);
        setAuthReady(false);
      }
    });

    return unsub;
  }, []);

  useEffect(() => {
    if (!authReady) return;

    const employeesRef = ref(db, "employees");
    return onValue(employeesRef, (snap) => {
      const data = snap.val() || {};
      const list = Object.keys(data)
        .map((key) => ({
          id: key,
          ...data[key],
        }))
        .filter((emp) => !emp.archived);

      list.sort((a, b) => String(a.empId || a.id).localeCompare(String(b.empId || b.id)));
      setEmployees(list);
      setDataReady((current) => ({ ...current, employees: true }));
      setDataError((current) => current.startsWith("員工資料") ? "" : current);
    }, (error) => {
      setDataError(`員工資料同步失敗：${error?.message || "請檢查網路後重試"}`);
    });
  }, [authReady]);

  useEffect(() => {
    if (!authReady) return;

    const recordsRef = ref(db, "records");
    return onValue(recordsRef, (snap) => {
      const data = snap.val() || {};
      const list = Object.keys(data).map((key) => ({
        id: key,
        ...data[key],
      }));

      list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      setRecords(list);
      setDataReady((current) => ({ ...current, records: true }));
      setDataError((current) => current.startsWith("打卡資料") ? "" : current);
    }, (error) => {
      setDataError(`打卡資料同步失敗：${error?.message || "請檢查網路後重試"}`);
    });
  }, [authReady]);

  useEffect(() => {
    if (!authReady) return;

    const mealRef = ref(db, "meal_records");
    return onValue(mealRef, (snap) => {
      setMealRecords(snap.val() || {});
      setDataReady((current) => ({ ...current, meals: true }));
      setDataError((current) => current.startsWith("員工餐資料") ? "" : current);
    }, (error) => {
      setDataError(`員工餐資料同步失敗：${error?.message || "請檢查網路後重試"}`);
    });
  }, [authReady]);

  useEffect(() => {
    const connectedRef = ref(db, ".info/connected");
    const handleOnline = () => setIsConnected(true);
    const handleOffline = () => setIsConnected(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    const unsubscribe = onValue(connectedRef, (snap) => setIsConnected(snap.val() === true));

    return () => {
      unsubscribe();
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  const matchedEmployee = useMemo(() => {
    const input = normalizeEmpId(empId);
    if (!input) return null;

    return employees.find((emp) => {
      const candidates = [emp.empId, emp.id, emp.employeeId, emp.checkinId, emp.birthdayId];
      return candidates.some((item) => normalizeEmpId(item) === input);
    });
  }, [empId, employees]);

  const selectedEmpKey = matchedEmployee ? matchedEmployee.empId || matchedEmployee.id : "";
  const selectedMealKey = selectedEmpKey ? `${mealDate}_${selectedEmpKey}` : "";
  const existingMealRecord = selectedMealKey ? mealRecords[selectedMealKey] : null;

  const selectedDayRecords = useMemo(() => {
    if (!selectedEmpKey) return [];

    return records.filter((record) => {
      const recordEmpId = normalizeEmpId(record.empId);
      const recordDateKey = record.dateKey || (record.createdAt ? formatTaipeiDateKey(record.createdAt) : "");
      return recordEmpId === normalizeEmpId(selectedEmpKey) && recordDateKey === mealDate;
    });
  }, [records, selectedEmpKey, mealDate]);

  const workInfo = useMemo(() => {
    return calculateEmployeeWork(selectedDayRecords);
  }, [selectedDayRecords]);


  const getEmployeeMonthBalanceBeforeDate = (empKey, monthKey, beforeDateKey) => {
    if (!empKey || !monthKey) return 0;
    const targetEmpKey = normalizeEmpId(empKey);

    const recordsByDate = {};
    records.forEach((record) => {
      const recordDateKey = record?.dateKey || (record?.createdAt ? formatTaipeiDateKey(record.createdAt) : "");
      if (!recordDateKey || getMonthKeyFromDateKey(recordDateKey) !== monthKey) return;
      if (recordDateKey >= beforeDateKey) return;
      if (normalizeEmpId(record.empId) !== targetEmpKey) return;
      if (!recordsByDate[recordDateKey]) recordsByDate[recordDateKey] = [];
      recordsByDate[recordDateKey].push(record);
    });

    const mealsByDate = {};
    Object.entries(mealRecords || {}).forEach(([key, item]) => {
      if (key === "payments" || !item || typeof item !== "object") return;
      if (!item.dateKey || getMonthKeyFromDateKey(item.dateKey) !== monthKey) return;
      if (item.dateKey >= beforeDateKey) return;
      if (normalizeEmpId(item.empId) !== targetEmpKey) return;
      mealsByDate[item.dateKey] = item;
    });

    const dates = Array.from(new Set([...Object.keys(recordsByDate), ...Object.keys(mealsByDate)])).sort();
    let balance = 0;

    dates.forEach((dateKey) => {
      const dayRecords = recordsByDate[dateKey] || [];
      const work = calculateEmployeeWork(dayRecords);
      const meal = mealsByDate[dateKey] || null;
      const mealAmountValue = Number(meal?.mealAmount) || 0;
      const mealNeedsApproval = Boolean(meal?.approvalRequired);
      const mealApproved = !meal || !mealNeedsApproval || (meal.approvalStatus || "approved") === "approved";
      const earnedSubsidy = work.canCalculate && mealApproved ? getMealSubsidy(work.workHours) : 0;
      balance += earnedSubsidy;

      if (meal && mealApproved) {
        const usedSubsidy = Math.min(balance, mealAmountValue);
        balance -= usedSubsidy;
      }
    });

    return Math.max(0, Math.round(balance));
  };

  const mealCalc = useMemo(() => {
    const actualMealAmount = Number(mealAmount) || 0;
    const calculatedSubsidy = workInfo.subsidy || 0;
    const needApproval = Boolean(matchedEmployee?.mealApprovalRequired);
    const monthKey = getMonthKeyFromDateKey(mealDate);
    const previousBalance = getEmployeeMonthBalanceBeforeDate(selectedEmpKey, monthKey, mealDate);
    const availableSubsidy = needApproval ? 0 : previousBalance + calculatedSubsidy;
    const subsidy = Math.min(availableSubsidy, actualMealAmount);
    const overAmount = Math.max(0, actualMealAmount - subsidy);
    const employeePay = Math.round(overAmount * 0.9);

    return {
      actualMealAmount,
      calculatedSubsidy,
      previousBalance,
      availableSubsidy,
      subsidy,
      overAmount,
      employeePay,
      needApproval,
    };
  }, [mealAmount, workInfo.subsidy, matchedEmployee, selectedEmpKey, mealDate, records, mealRecords]);

  const todayMealStatusList = useMemo(() => {
    const employeeById = {};
    employees.forEach((employee) => {
      const key = normalizeEmpId(employee.empId || employee.id);
      if (key) employeeById[key] = employee;
    });

    const recordsByEmployee = {};
    records.forEach((record) => {
      const dateKey = record.dateKey || (record.createdAt ? formatTaipeiDateKey(record.createdAt) : "");
      if (dateKey !== mealDate) return;
      const key = normalizeEmpId(record.empId);
      if (!key) return;
      if (!recordsByEmployee[key]) recordsByEmployee[key] = [];
      recordsByEmployee[key].push(record);
    });

    const mealsByEmployee = {};
    Object.values(mealRecords || {}).forEach((meal) => {
      if (!meal || meal.dateKey !== mealDate) return;
      const key = normalizeEmpId(meal.empId);
      if (key) mealsByEmployee[key] = meal;
    });

    return [...new Set([...Object.keys(recordsByEmployee), ...Object.keys(mealsByEmployee)])]
      .map((key) => {
        const employee = employeeById[key] || {};
        const dayRecords = recordsByEmployee[key] || [];
        const work = calculateEmployeeWork(dayRecords);
        const meal = mealsByEmployee[key] || null;
        const firstRecord = dayRecords[0] || {};
        return {
          key: `${mealDate}_${key}`,
          empId: employee.empId || employee.id || meal?.empId || firstRecord.empId || key,
          name: employee.name || meal?.name || firstRecord.name || key,
          store: formatStoreDisplayName(employee.store || meal?.store || firstRecord.store),
          hasWorkIn: work.hasWorkIn,
          hasWorkOut: work.hasWorkOut,
          workInAt: work.workInAt,
          workOutAt: work.workOutAt,
          workHours: work.canCalculate ? formatHours(work.workHours) : 0,
          calculatedSubsidyAmount: work.canCalculate ? getMealSubsidy(work.workHours) : 0,
          hasMeal: Boolean(meal),
          mealAmount: Number(meal?.mealAmount) || 0,
          approvalRequired: Boolean(meal?.approvalRequired),
          approvalStatus: meal?.approvalStatus || (meal?.approvalRequired ? "pending" : "approved"),
          meal,
        };
      })
      .filter((item) => item.hasWorkIn || item.hasMeal)
      .sort((a, b) => a.store.localeCompare(b.store, "zh-Hant") || a.name.localeCompare(b.name, "zh-Hant"));
  }, [employees, records, mealRecords, mealDate]);

  const todayMealStatusGroups = useMemo(() => {
    const storeOrder = ["斗南站前店", "西螺文昌店"];
    const groups = {};
    todayMealStatusList.forEach((item) => {
      if (!groups[item.store]) groups[item.store] = [];
      groups[item.store].push(item);
    });
    return Object.entries(groups).sort(([storeA], [storeB]) => {
      const indexA = storeOrder.indexOf(storeA);
      const indexB = storeOrder.indexOf(storeB);
      if (indexA >= 0 || indexB >= 0) return (indexA < 0 ? 99 : indexA) - (indexB < 0 ? 99 : indexB);
      return storeA.localeCompare(storeB, "zh-Hant");
    });
  }, [todayMealStatusList]);

  const storeOptions = useMemo(() => {
    const stores = employees
      .map((emp) => emp.store || "未填店名")
      .filter(Boolean);
    Object.values(mealRecords || {}).forEach((item) => {
      if (item.store) stores.push(item.store);
    });
    return ["全部", ...Array.from(new Set(stores))];
  }, [employees, mealRecords]);

  const adminMonthRecords = useMemo(() => {
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

    const keysByEmp = {};
    Array.from(new Set([...Object.keys(recordsByEmpDate), ...Object.keys(mealsByEmpDate)])).forEach((rowKey) => {
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
        const meal = mealsByEmpDate[rowKey] || null;
        const hasMeal = Boolean(meal);
        const hasAnyWork = work.hasWorkIn || work.hasWorkOut;
        const workHours = work.canCalculate ? formatHours(work.workHours) : 0;
        const breakHours = work.canCalculate ? formatHours(work.breakHours) : 0;
        const dailySubsidy = work.canCalculate ? getMealSubsidy(work.workHours) : 0;
        const mealAmount = hasMeal ? Number(meal.mealAmount) || 0 : 0;
        const mealNeedsApproval = Boolean(meal?.approvalRequired);
        const approvalStatus = meal?.approvalStatus || (mealNeedsApproval ? "pending" : "approved");
        const mealApproved = !hasMeal || !mealNeedsApproval || approvalStatus === "approved";
        const earnedSubsidyAmount = work.canCalculate && mealApproved ? dailySubsidy : 0;
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

        rows.push({
          key: meal?.key || `${dateKey}_${emp.empId}`,
          dateKey,
          monthKey: selectedMonth,
          store: cleanStoreName(meal?.store || emp.store || "未填店名"),
          name: meal?.name || emp.name || emp.empId,
          empId: meal?.empId || emp.empId || empKey,
          role: meal?.role || emp.role || "未設定",
          workInAt: work.workInAt || meal?.workInAt || 0,
          workOutAt: work.workOutAt || meal?.workOutAt || 0,
          workHours,
          breakHours,
          hasMeal,
          hasAnyWork,
          mealAmount,
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
      .filter((item) => adminStoreFilter === "全部" || (item.store || "未填店名") === adminStoreFilter)
      .sort((a, b) => String(b.dateKey || "").localeCompare(String(a.dateKey || "")) || String(a.name || "").localeCompare(String(b.name || ""), "zh-Hant"));
  }, [employees, records, mealRecords, selectedMonth, adminStoreFilter]);

  const adminTodayRecords = useMemo(() => {
    return Object.values(mealRecords || {})
      .filter((item) => item && item.dateKey === mealDate)
      .filter((item) => adminStoreFilter === "全部" || (item.store || "未填店名") === adminStoreFilter);
  }, [mealRecords, mealDate, adminStoreFilter]);

  const workingWithoutMeal = useMemo(() => {
    return todayMealStatusList
      .filter((item) => item.hasWorkIn && !item.hasMeal)
      .filter((item) => adminStoreFilter === "全部" || String(item.store || "").includes(adminStoreFilter))
      .sort((a, b) => String(a.store).localeCompare(String(b.store), "zh-Hant") || String(a.name).localeCompare(String(b.name), "zh-Hant"));
  }, [todayMealStatusList, adminStoreFilter]);

  const adminDashboard = useMemo(() => {
    const sum = (list, key) => list.reduce((total, item) => total + (Number(item[key]) || 0), 0);
    const todayTop = [...adminTodayRecords].sort((a, b) => (Number(b.mealAmount) || 0) - (Number(a.mealAmount) || 0))[0];
    const employeeTotals = {};

    adminMonthRecords.forEach((item) => {
      const key = item.empId || item.name || "UNKNOWN";
      if (!employeeTotals[key]) {
        employeeTotals[key] = {
          empId: key,
          name: item.name || key,
          totalMealAmount: 0,
          totalEarnedSubsidy: 0,
        };
      }
      employeeTotals[key].totalMealAmount += Number(item.mealAmount) || 0;
      employeeTotals[key].totalEarnedSubsidy += Number(item.earnedSubsidyAmount) || 0;
    });

    const employeeSettlements = Object.values(employeeTotals).map((item) => ({
      ...item,
      ...calculateMonthlySettlement(item.totalMealAmount, item.totalEarnedSubsidy),
    }));
    const monthTop = [...employeeSettlements].sort((a, b) => b.employeePay - a.employeePay)[0];

    return {
      todayCount: adminTodayRecords.length,
      todayMealAmount: sum(adminTodayRecords, "mealAmount"),
      monthCount: adminMonthRecords.filter((item) => item.hasMeal).length,
      monthWorkDays: adminMonthRecords.filter((item) => item.hasAnyWork).length,
      monthMealAmount: sum(adminMonthRecords, "mealAmount"),
      monthEarnedSubsidy: sum(adminMonthRecords, "earnedSubsidyAmount"),
      monthUsedSubsidy: employeeSettlements.reduce((total, item) => total + item.usedSubsidy, 0),
      monthEmployeePay: employeeSettlements.reduce((total, item) => total + item.employeePay, 0),
      todayTop,
      monthTop,
    };
  }, [adminTodayRecords, adminMonthRecords]);

  const normalizeStoreName = (storeName = "") => {
    const name = String(storeName || "").trim();
    if (name.includes("西螺")) return "西螺";
    if (name.includes("斗南")) return "斗南";
    return name;
  };

  const managerPendingRecords = useMemo(() => {
    if (!isManager) return [];

    const currentManagerStore = normalizeStoreName(managerStore);

    return Object.values(mealRecords || {})
      .filter((item) => item && item.approvalRequired)
      .filter((item) => normalizeStoreName(item.approvalStore || item.store || "") === currentManagerStore)
      .filter((item) => (item.approvalStatus || "approved") === "pending")
      .sort((a, b) => String(b.dateKey || "").localeCompare(String(a.dateKey || "")) || String(a.name || "").localeCompare(String(b.name || "")));
  }, [mealRecords, isManager, managerStore]);


  const selectedEmployeeMonthRecords = useMemo(() => {
    if (!selectedEmpKey) return [];
    const monthKey = getMonthKeyFromDateKey(mealDate);
    return adminMonthRecords
      .filter((item) => item.monthKey === monthKey && normalizeEmpId(item.empId) === normalizeEmpId(selectedEmpKey))
      .sort((a, b) => String(b.dateKey || "").localeCompare(String(a.dateKey || "")));
  }, [adminMonthRecords, selectedEmpKey, mealDate]);

  const selectedEmployeePaymentKey = selectedEmpKey ? `${getMonthKeyFromDateKey(mealDate)}_${selectedEmpKey}` : "";
  const paymentRecords = mealRecords?.payments || {};

  const employeeMonthSummary = useMemo(() => {
    const totalMealAmount = selectedEmployeeMonthRecords.reduce((sum, item) => sum + (Number(item.mealAmount) || 0), 0);
    const totalEarnedSubsidy = selectedEmployeeMonthRecords.reduce((sum, item) => sum + (Number(item.earnedSubsidyAmount) || 0), 0);
    const settlement = calculateMonthlySettlement(totalMealAmount, totalEarnedSubsidy);
    const paidRecord = selectedEmployeePaymentKey ? paymentRecords[selectedEmployeePaymentKey] : null;

    return {
      monthKey: getMonthKeyFromDateKey(mealDate),
      days: selectedEmployeeMonthRecords.filter((item) => item.hasAnyWork).length,
      mealDays: selectedEmployeeMonthRecords.filter((item) => item.hasMeal).length,
      totalMealAmount,
      totalEarnedSubsidy,
      totalUsedSubsidy: settlement.usedSubsidy,
      totalSubsidy: settlement.usedSubsidy,
      endingBalance: settlement.remainingSubsidy,
      overAmount: settlement.overAmount,
      totalEmployeePay: settlement.employeePay,
      isPaid: Boolean(paidRecord?.paid),
    };
  }, [selectedEmployeeMonthRecords, selectedEmployeePaymentKey, paymentRecords, mealDate]);

  const filteredMonthlySummary = useMemo(() => {
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
  }, [adminMonthRecords]);

  const filteredMonthlySummaryWithPaid = useMemo(() => {
    return filteredMonthlySummary.map((item) => {
      const key = `${selectedMonth}_${item.empId}`;
      const payment = paymentRecords[key] || {};
      return { ...item, paid: Boolean(payment.paid), paidAmount: payment.amount || 0, paidAt: payment.paidAt || 0 };
    });
  }, [filteredMonthlySummary, paymentRecords, selectedMonth]);

  const storeSettlementSummary = useMemo(() => {
    const map = {};
    filteredMonthlySummary.forEach((item) => {
      const store = item.store || "未填店名";
      if (!map[store]) {
        map[store] = { store, days: 0, mealDays: 0, totalMealAmount: 0, totalEarnedSubsidy: 0, totalUsedSubsidy: 0, totalSubsidy: 0, totalEmployeePay: 0, endingBalance: 0 };
      }
      map[store].days += Number(item.days) || 0;
      map[store].mealDays += Number(item.mealDays) || 0;
      map[store].totalMealAmount += Number(item.totalMealAmount) || 0;
      map[store].totalEarnedSubsidy += Number(item.totalEarnedSubsidy) || 0;
      map[store].totalUsedSubsidy += Number(item.totalUsedSubsidy) || 0;
      map[store].totalSubsidy = map[store].totalUsedSubsidy;
      map[store].totalEmployeePay += Number(item.totalEmployeePay) || 0;
      map[store].endingBalance += Number(item.endingBalance) || 0;
    });
    return Object.values(map).sort((a, b) => b.totalEmployeePay - a.totalEmployeePay);
  }, [filteredMonthlySummary]);

  const markPaid = async (item) => {
    const pin = window.prompt(`請輸入管理員 PIN，確認 ${item.name} ${selectedMonth} 已收款`);
    if (pin !== ADMIN_DELETE_PIN) {
      alert("PIN 錯誤，未執行收款");
      return;
    }
    await set(ref(db, `meal_records/payments/${selectedMonth}_${item.empId}`), {
      empId: item.empId,
      name: item.name,
      store: item.store || "",
      monthKey: selectedMonth,
      amount: Number(item.totalEmployeePay) || 0,
      paid: true,
      paidAt: Date.now(),
      paidBy: "admin",
    });
    alert(`${item.name} 已標記收款`);
  };

  const unmarkPaid = async (item) => {
    const pin = window.prompt(`請輸入管理員 PIN，取消 ${item.name} ${selectedMonth} 已收款`);
    if (pin !== ADMIN_DELETE_PIN) {
      alert("PIN 錯誤，未取消收款");
      return;
    }
    await remove(ref(db, `meal_records/payments/${selectedMonth}_${item.empId}`));
    alert(`${item.name} 已取消收款`);
  };

  const openEditMeal = (item) => {
    setEditingMeal(item);
    setEditMealAmount(String(item.mealAmount || ""));
    setEditNote(item.note || "");
  };

  const saveEditMeal = async () => {
    if (!editingMeal) return;

    const pin = window.prompt("請輸入管理員 PIN 才能修改紀錄");
    if (pin !== ADMIN_DELETE_PIN) {
      alert("PIN 錯誤，不能修改");
      return;
    }

    const amount = Number(editMealAmount);
    if (!amount || amount < 0) {
      alert("請輸入正確的餐費金額");
      return;
    }

    const calculatedSubsidy = Number(editingMeal.calculatedSubsidyAmount ?? editingMeal.subsidyAmount) || 0;
    const status = editingMeal.approvalStatus || "approved";
    const subsidyAmount = editingMeal.approvalRequired && status !== "approved" ? 0 : calculatedSubsidy;
    const overAmount = Math.max(0, amount - subsidyAmount);
    const employeePay = Math.round(overAmount * 0.9);

    await update(ref(db, `meal_records/${editingMeal.dateKey}_${editingMeal.empId}`), {
      mealAmount: amount,
      calculatedSubsidyAmount: calculatedSubsidy,
      subsidyAmount,
      overAmount,
      employeePay,
      note: editNote.trim(),
      updatedAt: Date.now(),
      editedAt: Date.now(),
    });

    setEditingMeal(null);
    setEditMealAmount("");
    setEditNote("");
    alert("員工餐紀錄已修改");
  };

  const downloadExcelHtml = (filename, html) => {
    const excelFile = `
      <html xmlns:o="urn:schemas-microsoft-com:office:office"
            xmlns:x="urn:schemas-microsoft-com:office:excel"
            xmlns="http://www.w3.org/TR/REC-html40">
        <head>
          <meta charset="UTF-8" />
          <style>
            body { font-family: Arial, 'Microsoft JhengHei', sans-serif; }
            table { border-collapse: collapse; font-size: 11pt; }
            th, td { border: 1px solid #999; padding: 6px 8px; text-align: center; white-space: nowrap; mso-number-format:'\@'; }
            th { background: #d9ead3; font-weight: bold; }
            .title { font-size: 18pt; font-weight: bold; background: #1f4e79; color: #fff; text-align: left; }
            .summaryLabel { background: #eef2ff; font-weight: bold; text-align: left; }
            .summaryValue { background: #fff; font-weight: bold; color: #0f172a; }
            .number { mso-number-format:'0'; }
            .hours { mso-number-format:'0.00'; }
            .ok { color: #166534; }
            .over { color: #b91c1c; font-weight: bold; }
            .pending { background: #fff7ed; color: #92400e; font-weight: bold; }
            .rejected { background: #fee2e2; color: #b91c1c; font-weight: bold; }
            .subtotal { background: #fff2cc; font-weight: bold; }
            .sectionTitle { font-size: 15pt; font-weight: bold; background: #dbeafe; color: #1e3a8a; text-align: left; }
            .receiptGrid { margin-top: 28px; page-break-before: always; }
            .receiptGrid > tbody > tr > td { border: 0; padding: 8px; vertical-align: top; }
            .receiptCard { width: 100%; border: 1px solid #94a3b8; }
            .receiptCard td { height: 26px; padding: 4px 6px; text-align: left; }
            .receiptTitle { background: #173653; color: #fff; font-size: 14pt; font-weight: bold; text-align: center !important; }
            .receiptLabel { width: 18%; background: #dbe8f5; color: #334155; }
            .receiptValue { width: 32%; text-align: right !important; }
            .receiptSign { background: #fff2cc; text-align: left !important; }
            .receiptNote { height: 38px !important; color: #64748b; font-size: 9pt; white-space: normal; }
            .employeeSection { page-break-before: always; margin-top: 28px; }
          </style>
        </head>
        <body>${html}</body>
      </html>`;

    const blob = new Blob(["\uFEFF" + excelFile], {
      type: "application/vnd.ms-excel;charset=utf-8;",
    });

    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const exportMonthlyCsv = async () => {
    if (!adminMonthRecords.length) {
      alert(`${selectedMonth} 沒有資料可匯出`);
      return;
    }

    try {
      await exportMealWorkbook({
        month: selectedMonth,
        storeFilter: adminStoreFilter,
        summaries: filteredMonthlySummaryWithPaid,
        detailRows: adminMonthRecords,
      });
    } catch (error) {
      console.error("Excel 匯出失敗", error);
      alert("Excel 匯出失敗，請重新整理後再試一次");
    }
  };

  const exportMonthlyCsvLegacy = () => {
    if (!adminMonthRecords.length) {
      alert(`${selectedMonth} 沒有資料可匯出`);
      return;
    }

    const totals = adminMonthRecords.reduce((acc, item) => {
      acc.workDays += item.hasAnyWork ? 1 : 0;
      acc.mealDays += item.hasMeal ? 1 : 0;
      acc.mealAmount += Number(item.mealAmount) || 0;
      acc.earnedSubsidy += Number(item.earnedSubsidyAmount) || 0;
      acc.pendingCount += item.status === "待審核" ? 1 : 0;
      return acc;
    }, { workDays: 0, mealDays: 0, mealAmount: 0, earnedSubsidy: 0, usedSubsidy: 0, balance: 0, employeePay: 0, pendingCount: 0 });

    filteredMonthlySummaryWithPaid.forEach((item) => {
      totals.usedSubsidy += Number(item.totalUsedSubsidy) || 0;
      totals.balance += Number(item.endingBalance) || 0;
      totals.employeePay += Number(item.totalEmployeePay) || 0;
    });

    const collectedAmount = filteredMonthlySummaryWithPaid
      .filter((item) => item.paid)
      .reduce((sum, item) => sum + (Number(item.totalEmployeePay) || 0), 0);
    const outstandingAmount = filteredMonthlySummaryWithPaid
      .filter((item) => !item.paid)
      .reduce((sum, item) => sum + (Number(item.totalEmployeePay) || 0), 0);

    const summaryRows = [
      ["月份", selectedMonth, "店別", adminStoreFilter],
      ["上班天數", totals.workDays, "用餐筆數", totals.mealDays],
      ["本月累積補助", totals.earnedSubsidy, "已使用補助", totals.usedSubsidy],
      ["月底剩餘補助", Math.max(0, totals.balance), "本月應收總額", totals.employeePay],
      ["已收款", collectedAmount, "尚待收款", outstandingAmount],
      ["待審核筆數", totals.pendingCount, "產生時間", new Date().toLocaleString("zh-TW", { hour12: false })],
    ].map((row) => `
      <tr>
        ${buildExcelCell(row[0], "summaryLabel")}
        ${buildExcelCell(row[1], "summaryValue")}
        ${buildExcelCell(row[2], "summaryLabel")}
        ${buildExcelCell(row[3], "summaryValue")}
        <td colspan="13"></td>
      </tr>
    `).join("");

    const header = `
      <tr>
        <th>月份</th><th>日期</th><th>店別</th><th>員工</th><th>工號</th><th>身分</th>
        <th>上班</th><th>下班</th><th>工時</th><th>休息</th><th>吃的金額</th>
        <th>當日新增補助</th><th>本次使用補助</th><th>餐後補助餘額</th><th>應繳計算</th><th>狀態</th><th>備註</th>
      </tr>
    `;

    const rows = adminMonthRecords.map((item) => {
      const statusClass = item.status === "待審核" ? "pending" : item.status === "未通過" ? "rejected" : item.employeePay > 0 ? "over" : "ok";
      return `
        <tr>
          ${buildExcelCell(selectedMonth)}
          ${buildExcelCell(item.dateKey || "")}
          ${buildExcelCell(item.store || "")}
          ${buildExcelCell(item.name || "")}
          ${buildExcelCell(item.empId || "")}
          ${buildExcelCell(item.role || "")}
          ${buildExcelCell(formatTime(item.workInAt))}
          ${buildExcelCell(formatTime(item.workOutAt))}
          ${buildExcelNumberCell(item.workHours || 0, "hours")}
          ${buildExcelNumberCell(item.breakHours || 0, "hours")}
          ${buildExcelNumberCell(item.mealAmount || 0)}
          ${buildExcelNumberCell(item.earnedSubsidyAmount || 0)}
          ${buildExcelNumberCell(item.usedSubsidyAmount || 0)}
          ${buildExcelNumberCell(item.balanceAfter || 0)}
          ${buildExcelCell("月底統一統計")}
          ${buildExcelCell(item.status || "", statusClass)}
          ${buildExcelCell(item.note || "")}
        </tr>
      `;
    }).join("");

    const totalRow = `
      <tr class="subtotal">
        <td colspan="8">合計</td>
        ${buildExcelNumberCell("")}
        ${buildExcelNumberCell("")}
        ${buildExcelNumberCell(totals.mealAmount)}
        ${buildExcelNumberCell(totals.earnedSubsidy)}
        ${buildExcelNumberCell(totals.usedSubsidy)}
        ${buildExcelNumberCell(Math.max(0, totals.balance))}
        ${buildExcelNumberCell(totals.employeePay, totals.employeePay > 0 ? "over" : "")}
        <td colspan="2">待審核 ${totals.pendingCount} 筆｜月底剩餘補助歸零</td>
      </tr>
    `;

    const collectionHeader = `
      <tr>
        <th>店別</th><th>員工</th><th>工號</th><th>上班天數</th><th>用餐筆數</th>
        <th>餐費總額</th><th>累積補助</th><th>剩餘補助</th><th>整月超額</th>
        <th>九折後應繳</th><th>收款狀態</th><th>收款日期</th><th>員工簽名</th>
      </tr>
    `;

    const collectionRows = filteredMonthlySummaryWithPaid.map((item) => `
      <tr>
        ${buildExcelCell(item.store)}
        ${buildExcelCell(item.name)}
        ${buildExcelCell(item.empId)}
        ${buildExcelNumberCell(item.days)}
        ${buildExcelNumberCell(item.mealDays)}
        ${buildExcelNumberCell(item.totalMealAmount)}
        ${buildExcelNumberCell(item.totalEarnedSubsidy)}
        ${buildExcelNumberCell(item.endingBalance)}
        ${buildExcelNumberCell(item.totalOverAmount, item.totalOverAmount > 0 ? "over" : "")}
        ${buildExcelNumberCell(item.totalEmployeePay, item.totalEmployeePay > 0 ? "over" : "")}
        ${buildExcelCell(item.paid ? "已收款" : "未收款", item.paid ? "ok" : "pending")}
        ${buildExcelCell(item.paidAt ? new Date(item.paidAt).toLocaleDateString("zh-TW") : "")}
        ${buildExcelCell("")}
      </tr>
    `).join("");

    const employeeSections = filteredMonthlySummaryWithPaid.map((employeeSummary) => {
      const employeeRows = adminMonthRecords
        .filter((item) => normalizeEmpId(item.empId) === normalizeEmpId(employeeSummary.empId))
        .sort((a, b) => String(a.dateKey || "").localeCompare(String(b.dateKey || "")));
      let accumulatedMeal = 0;
      let accumulatedSubsidy = 0;
      const detailRows = employeeRows.map((item) => {
        accumulatedMeal += Number(item.mealAmount) || 0;
        accumulatedSubsidy += Number(item.earnedSubsidyAmount) || 0;
        const settlement = calculateMonthlySettlement(accumulatedMeal, accumulatedSubsidy);
        const approvalText = item.status === "待審核" ? "待審核" : item.status === "未通過" ? "未通過" : "已列入月結";
        return `<tr>
          ${buildExcelCell(item.dateKey || "")}
          ${buildExcelNumberCell(item.workHours || 0, "hours")}
          ${buildExcelNumberCell(item.earnedSubsidyAmount || 0)}
          ${buildExcelNumberCell(item.mealAmount || 0)}
          ${buildExcelNumberCell(accumulatedSubsidy)}
          ${buildExcelNumberCell(accumulatedMeal)}
          ${buildExcelNumberCell(settlement.remainingSubsidy)}
          ${buildExcelNumberCell(settlement.overAmount, settlement.overAmount > 0 ? "over" : "")}
          ${buildExcelCell(approvalText)}
          ${buildExcelCell(item.note || "")}
        </tr>`;
      }).join("");
      const paymentStatus = employeeSummary.paid ? "已收款" : "未收款";
      return `
        <div class="employeeSection">
          <table>
            <tr><td class="sectionTitle" colspan="10">${escapeHtml(employeeSummary.name)}｜${escapeHtml(selectedMonth)} 收款核對明細</td></tr>
            <tr>
              ${buildExcelCell("工號", "summaryLabel")}${buildExcelCell(employeeSummary.empId, "summaryValue")}
              ${buildExcelCell("店別", "summaryLabel")}${buildExcelCell(employeeSummary.store, "summaryValue")}
              ${buildExcelCell("餐費總額", "summaryLabel")}${buildExcelNumberCell(employeeSummary.totalMealAmount, "summaryValue")}
              ${buildExcelCell("累積補助", "summaryLabel")}${buildExcelNumberCell(employeeSummary.totalEarnedSubsidy, "summaryValue")}
              ${buildExcelCell("收款狀態", "summaryLabel")}${buildExcelCell(paymentStatus, "summaryValue")}
            </tr>
            <tr>
              <th>日期</th><th>工時</th><th>當日新增補助</th><th>當日餐費</th><th>累積補助</th>
              <th>累積餐費</th><th>剩餘補助</th><th>整月超額</th><th>審核狀態</th><th>備註</th>
            </tr>
            ${detailRows}
            <tr class="subtotal">
              <td colspan="2">月底統一結算</td>
              ${buildExcelNumberCell(employeeSummary.totalEarnedSubsidy)}
              ${buildExcelNumberCell(employeeSummary.totalMealAmount)}
              <td colspan="2">超額部分 × 0.9</td>
              ${buildExcelNumberCell(employeeSummary.endingBalance)}
              ${buildExcelNumberCell(employeeSummary.totalOverAmount, employeeSummary.totalOverAmount > 0 ? "over" : "")}
              ${buildExcelCell(`應繳 ${employeeSummary.totalEmployeePay} 元`, employeeSummary.totalEmployeePay > 0 ? "over" : "")}
              ${buildExcelCell(paymentStatus)}
            </tr>
          </table>
        </div>
      `;
    }).join("");

    const receiptCard = (employeeSummary) => {
      const paymentStatus = employeeSummary.paid ? "已收款" : "未收款";
      const paidTime = employeeSummary.paidAt
        ? new Date(employeeSummary.paidAt).toLocaleString("zh-TW", { hour12: false })
        : "";
      return `
        <table class="receiptCard">
          <tr><td class="receiptTitle" colspan="4">員工餐月結收款單</td></tr>
          <tr>
            <td class="receiptLabel">月份</td><td>${escapeHtml(selectedMonth)}</td>
            <td class="receiptLabel">店別</td><td>${escapeHtml(employeeSummary.store)}</td>
          </tr>
          <tr>
            <td class="receiptLabel">員工</td><td>${escapeHtml(employeeSummary.name)}</td>
            <td class="receiptLabel">工號</td><td>${escapeHtml(employeeSummary.empId)}</td>
          </tr>
          <tr>
            <td class="receiptLabel">餐費總額</td><td class="receiptValue">${Number(employeeSummary.totalMealAmount) || 0} 元</td>
            <td class="receiptLabel">累積補助</td><td class="receiptValue">${Number(employeeSummary.totalEarnedSubsidy) || 0} 元</td>
          </tr>
          <tr>
            <td class="receiptLabel">使用補助</td><td class="receiptValue">${Number(employeeSummary.totalUsedSubsidy) || 0} 元</td>
            <td class="receiptLabel">剩餘補助</td><td class="receiptValue">${Number(employeeSummary.endingBalance) || 0} 元</td>
          </tr>
          <tr>
            <td class="receiptLabel">整月超額</td><td class="receiptValue">${Number(employeeSummary.totalOverAmount) || 0} 元</td>
            <td class="receiptLabel">九折應繳</td><td class="receiptValue over">${Number(employeeSummary.totalEmployeePay) || 0} 元</td>
          </tr>
          <tr>
            <td class="receiptLabel">收款狀態</td><td>${paymentStatus}</td>
            <td class="receiptLabel">收款時間</td><td>${escapeHtml(paidTime)}</td>
          </tr>
          <tr><td class="receiptSign" colspan="4">員工簽收：____________________　日期：____________</td></tr>
          <tr><td class="receiptNote" colspan="4">說明：補助於當月內累計使用；整月餐費超過累積補助的差額打九折後收款，月底剩餘補助歸零。</td></tr>
        </table>
      `;
    };

    const receiptRows = [];
    for (let index = 0; index < filteredMonthlySummaryWithPaid.length; index += 2) {
      const left = filteredMonthlySummaryWithPaid[index];
      const right = filteredMonthlySummaryWithPaid[index + 1];
      receiptRows.push(`
        <tr>
          <td>${receiptCard(left)}</td>
          <td style="width:18px"></td>
          <td>${right ? receiptCard(right) : ""}</td>
        </tr>
      `);
    }

    const receiptsHtml = `
      <table class="receiptGrid">
        <tr><td class="sectionTitle" colspan="3">${escapeHtml(selectedMonth)} 個人收款單（兩張並排列印）</td></tr>
        ${receiptRows.join("")}
      </table>
    `;

    const html = `
      <table>
        <tr><td class="title" colspan="17">${escapeHtml(selectedMonth)} 員工餐收款核對簿（補助月內累計，月底歸零）</td></tr>
        ${summaryRows}
        <tr><td colspan="17"></td></tr>
        <tr><td class="sectionTitle" colspan="17">員工收款總表</td></tr>
        ${collectionHeader}
        ${collectionRows}
        <tr><td colspan="17"></td></tr>
        <tr><td class="sectionTitle" colspan="17">全月逐日原始明細</td></tr>
        ${header}
        ${rows}
        ${totalRow}
      </table>
      ${employeeSections}
      ${receiptsHtml}
    `;

    const storeText = adminStoreFilter === "全部" ? "全部店別" : adminStoreFilter;
    downloadExcelHtml(`員工餐收款核對簿-${selectedMonth}-${storeText}.xls`, html);
  };

  const exportEmployeeMonthlyDetail = (employeeSummary) => {
    const employeeRows = adminMonthRecords
      .filter((item) => normalizeEmpId(item.empId) === normalizeEmpId(employeeSummary.empId))
      .sort((a, b) => String(a.dateKey || "").localeCompare(String(b.dateKey || "")));

    if (!employeeRows.length) {
      alert(`${employeeSummary.name} ${selectedMonth} 沒有明細可匯出`);
      return;
    }

    let accumulatedMeal = 0;
    let accumulatedSubsidy = 0;

    const detailRows = employeeRows.map((item) => {
      accumulatedMeal += Number(item.mealAmount) || 0;
      accumulatedSubsidy += Number(item.earnedSubsidyAmount) || 0;
      const settlement = calculateMonthlySettlement(accumulatedMeal, accumulatedSubsidy);
      const approvalText = item.status === "待審核"
        ? "待審核"
        : item.status === "未通過"
          ? "未通過"
          : "已列入月結";

      return `
        <tr>
          ${buildExcelCell(item.dateKey || "")}
          ${buildExcelCell(formatTime(item.workInAt))}
          ${buildExcelCell(formatTime(item.workOutAt))}
          ${buildExcelNumberCell(item.workHours || 0, "hours")}
          ${buildExcelNumberCell(item.breakHours || 0, "hours")}
          ${buildExcelNumberCell(item.earnedSubsidyAmount || 0)}
          ${buildExcelNumberCell(item.mealAmount || 0)}
          ${buildExcelNumberCell(accumulatedSubsidy)}
          ${buildExcelNumberCell(accumulatedMeal)}
          ${buildExcelNumberCell(settlement.remainingSubsidy)}
          ${buildExcelNumberCell(settlement.overAmount, settlement.overAmount > 0 ? "over" : "")}
          ${buildExcelCell(approvalText)}
          ${buildExcelCell(item.note || "")}
        </tr>
      `;
    }).join("");

    const paymentStatus = employeeSummary.paid ? "已收款" : "未收款";
    const html = `
      <table>
        <tr><td class="title" colspan="13">${escapeHtml(employeeSummary.name)}｜${escapeHtml(selectedMonth)} 員工餐個人明細</td></tr>
        <tr>
          ${buildExcelCell("員工", "summaryLabel")}
          ${buildExcelCell(employeeSummary.name, "summaryValue")}
          ${buildExcelCell("工號", "summaryLabel")}
          ${buildExcelCell(employeeSummary.empId, "summaryValue")}
          ${buildExcelCell("店別", "summaryLabel")}
          ${buildExcelCell(employeeSummary.store, "summaryValue")}
          ${buildExcelCell("收款狀態", "summaryLabel")}
          ${buildExcelCell(paymentStatus, "summaryValue")}
          <td colspan="5"></td>
        </tr>
        <tr>
          ${buildExcelCell("本月餐費", "summaryLabel")}
          ${buildExcelNumberCell(employeeSummary.totalMealAmount, "summaryValue")}
          ${buildExcelCell("本月補助", "summaryLabel")}
          ${buildExcelNumberCell(employeeSummary.totalEarnedSubsidy, "summaryValue")}
          ${buildExcelCell("剩餘補助", "summaryLabel")}
          ${buildExcelNumberCell(employeeSummary.endingBalance, "summaryValue")}
          ${buildExcelCell("整月超額", "summaryLabel")}
          ${buildExcelNumberCell(employeeSummary.totalOverAmount, "summaryValue")}
          ${buildExcelCell("應繳金額", "summaryLabel")}
          ${buildExcelNumberCell(employeeSummary.paid ? 0 : employeeSummary.totalEmployeePay, employeeSummary.totalEmployeePay > 0 ? "over" : "summaryValue")}
          <td colspan="3"></td>
        </tr>
        <tr><td colspan="13"></td></tr>
        <tr>
          <th>日期</th><th>上班</th><th>下班</th><th>工時</th><th>休息</th>
          <th>當日新增補助</th><th>當日餐費</th><th>累積補助</th><th>累積餐費</th>
          <th>當月剩餘補助</th><th>當月超額</th><th>狀態</th><th>備註</th>
        </tr>
        ${detailRows}
        <tr class="subtotal">
          <td colspan="5">月底統一結算</td>
          ${buildExcelNumberCell(employeeSummary.totalEarnedSubsidy)}
          ${buildExcelNumberCell(employeeSummary.totalMealAmount)}
          ${buildExcelNumberCell(employeeSummary.totalEarnedSubsidy)}
          ${buildExcelNumberCell(employeeSummary.totalMealAmount)}
          ${buildExcelNumberCell(employeeSummary.endingBalance)}
          ${buildExcelNumberCell(employeeSummary.totalOverAmount, employeeSummary.totalOverAmount > 0 ? "over" : "")}
          ${buildExcelCell(`應繳 ${employeeSummary.paid ? 0 : employeeSummary.totalEmployeePay} 元`)}
          ${buildExcelCell(paymentStatus)}
        </tr>
      </table>
    `;

    downloadExcelHtml(`員工餐個人明細-${selectedMonth}-${employeeSummary.name}-${employeeSummary.empId}.xls`, html);
  };

  const submitMeal = async () => {
    setMessage("");

    if (!matchedEmployee) {
      setMessage("找不到員工，請確認工號");
      return;
    }

    if (!workInfo.hasWorkIn) {
      setMessage("今天尚未上班打卡，不能登記員工餐");
      return;
    }

    if (!workInfo.hasWorkOut) {
      setMessage("尚未下班打卡，請下班後再登記員工餐");
      return;
    }

    if (!workInfo.canCalculate) {
      setMessage("打卡時間異常，無法計算工時");
      return;
    }

    const amount = Number(mealAmount);
    if (!amount || amount < 0) {
      setMessage("請輸入今天實際吃的金額");
      return;
    }

    const empKey = matchedEmployee.empId || matchedEmployee.id;
    const mealKey = `${mealDate}_${empKey}`;
    const monthKey = getMonthKeyFromDateKey(mealDate);
    const now = Date.now();

    const approvalRequired = Boolean(matchedEmployee.mealApprovalRequired);
    const approvalStore = normalizeStoreName(matchedEmployee.approvalStore || matchedEmployee.store || "西螺");
    const approvalStatus = approvalRequired ? "pending" : "approved";

    await set(ref(db, `meal_records/${mealKey}`), {
      empId: empKey,
      name: matchedEmployee.name || "",
      store: matchedEmployee.store || "",
      role: matchedEmployee.role || "",
      dateKey: mealDate,
      monthKey,

      workInAt: workInfo.workInAt,
      workOutAt: workInfo.workOutAt,
      workHours: formatHours(workInfo.workHours),
      breakHours: formatHours(workInfo.breakHours),

      mealAmount: amount,
      calculatedSubsidyAmount: mealCalc.calculatedSubsidy,
      subsidyAmount: mealCalc.subsidy,
      overAmount: mealCalc.overAmount,
      discountRate: 0.9,
      employeePay: mealCalc.employeePay,

      approvalRequired,
      approvalStore,
      approvalStatus,

      rule: "未滿4小時0元；滿4小時未滿6小時60元；滿6小時以上100元；補助可於當月內累計使用；月底剩餘補助歸零；餘額不足部分打9折；需審核員工須店長通過後才計入補助",
      createdAt: existingMealRecord?.createdAt || now,
      updatedAt: now,
    });

    setMessage(approvalRequired
      ? `已儲存：${matchedEmployee.name}｜此員工需 ${approvalStore} 店長審核，通過後才會給補貼 ${mealCalc.calculatedSubsidy} 元｜目前員工自付 ${mealCalc.employeePay} 元`
      : `已儲存：${matchedEmployee.name}｜工時 ${formatHours(workInfo.workHours)} 小時｜今日新增補助 ${mealCalc.calculatedSubsidy} 元｜月底將依整月總餐費與總補助統一結算`
    );
    setMealAmount("");
  };

  const deleteMealRecord = async (item) => {
    const pin = window.prompt("請輸入管理員 PIN 才能刪除紀錄");
    if (pin !== ADMIN_DELETE_PIN) {
      alert("PIN 錯誤，不能刪除");
      return;
    }
    const ok = window.confirm(`確定刪除 ${item.name} ${item.dateKey} 的員工餐紀錄嗎？`);
    if (!ok) return;
    await remove(ref(db, `meal_records/${item.dateKey}_${item.empId}`));
  };

  const updateEmployeeApprovalSetting = async (employee, field, value) => {
    const empKey = employee.empId || employee.id;
    const cleanValue = field === "approvalStore" ? normalizeStoreName(value) : value;

    await update(ref(db, `employees/${employee.id}`), {
      [field]: cleanValue,
    });

    // 讓「審核店別」設定立即生效：
    // 已經產生但尚未審核的員工餐，也會同步改到新的審核店別。
    const pendingUpdates = {};
    Object.entries(mealRecords || {}).forEach(([key, item]) => {
      if (!item || typeof item !== "object") return;
      if (normalizeEmpId(item.empId) !== normalizeEmpId(empKey)) return;
      if ((item.approvalStatus || "approved") !== "pending") return;

      if (field === "approvalStore") {
        pendingUpdates[`meal_records/${key}/approvalStore`] = cleanValue;
        pendingUpdates[`meal_records/${key}/updatedAt`] = Date.now();
      }

      if (field === "mealApprovalRequired" && value === false) {
        const calculatedSubsidy = Number(item.calculatedSubsidyAmount ?? getMealSubsidy(item.workHours)) || 0;
        const mealAmountValue = Number(item.mealAmount) || 0;
        const overAmount = Math.max(0, mealAmountValue - calculatedSubsidy);
        const employeePay = Math.round(overAmount * 0.9);

        pendingUpdates[`meal_records/${key}/approvalRequired`] = false;
        pendingUpdates[`meal_records/${key}/approvalStatus`] = "approved";
        pendingUpdates[`meal_records/${key}/subsidyAmount`] = calculatedSubsidy;
        pendingUpdates[`meal_records/${key}/overAmount`] = overAmount;
        pendingUpdates[`meal_records/${key}/employeePay`] = employeePay;
        pendingUpdates[`meal_records/${key}/updatedAt`] = Date.now();
      }
    });

    if (Object.keys(pendingUpdates).length > 0) {
      await update(ref(db), pendingUpdates);
    }
  };

  const approveMealRecord = async (item) => {
    const calculatedSubsidy = Number(item.calculatedSubsidyAmount ?? getMealSubsidy(item.workHours)) || 0;
    const mealAmountValue = Number(item.mealAmount) || 0;
    const overAmount = Math.max(0, mealAmountValue - calculatedSubsidy);
    const employeePay = Math.round(overAmount * 0.9);

    await update(ref(db, `meal_records/${item.dateKey}_${item.empId}`), {
      approvalStatus: "approved",
      subsidyAmount: calculatedSubsidy,
      overAmount,
      employeePay,
      updatedAt: Date.now(),
    });
  };

  const rejectMealRecord = async (item) => {
    const mealAmountValue = Number(item.mealAmount) || 0;
    const overAmount = Math.max(0, mealAmountValue);
    const employeePay = Math.round(overAmount * 0.9);

    await update(ref(db, `meal_records/${item.dateKey}_${item.empId}`), {
      approvalStatus: "rejected",
      subsidyAmount: 0,
      overAmount,
      employeePay,
      updatedAt: Date.now(),
    });
  };

  const managerLogin = () => {
    if (MANAGER_PASSWORDS[managerLoginStore] === managerPassword) {
      setIsManager(true);
      setManagerStore(managerLoginStore);
      setManagerPassword("");
      return;
    }

    alert("店長密碼錯誤");
  };

  const managerLogout = () => {
    setIsManager(false);
    setManagerPassword("");
  };

  const login = () => {
    if (password === ADMIN_PASSWORD) {
      setIsAdmin(true);
      setPassword("");
      return;
    }

    alert("密碼錯誤");
  };

  const logout = () => {
    setIsAdmin(false);
    setPassword("");
  };

  const allDataReady = dataReady.employees && dataReady.records && dataReady.meals;

  if (!authReady || !allDataReady) {
    return (
      <div className="loading-page" style={styles.loadingPage}>
        <div className="loading-card" style={styles.loadingCard}>
          <div style={styles.loadingTitle}>員工餐系統</div>
          <div className="loading-dots" aria-hidden="true"><span /><span /><span /></div>
          <div style={styles.loadingText}>{isConnected ? "正在同步最新資料…" : "目前離線，等待網路恢復…"}</div>
          {authError || dataError ? <div style={styles.errorText}>{authError || dataError}</div> : null}
          {authError || dataError ? (
            <button style={styles.retryBtn} onClick={() => window.location.reload()}>
              重新整理
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="meal-app-page" style={styles.page}>
      {!isConnected || dataError ? (
        <div className={dataError ? "sync-banner sync-banner--error" : "sync-banner"}>
          <span>{dataError ? "資料同步暫時失敗，目前保留畫面上的既有資料。" : "目前離線，畫面保留最後已載入資料；恢復網路後會自動同步。"}</span>
          <button onClick={() => window.location.reload()}>重新連線</button>
        </div>
      ) : null}
      {editingMeal ? (
        <div style={styles.modalOverlay}>
          <div style={styles.editModalCard}>
            <div style={styles.modalTitle}>修改員工餐紀錄</div>
            <div style={styles.editModalInfo}>
              {editingMeal.dateKey}｜{editingMeal.name}｜補貼 {editingMeal.subsidyAmount || 0} 元
            </div>

            <div style={styles.label}>實際吃的金額</div>
            <input
              style={styles.bigInput}
              type="number"
              inputMode="decimal"
              value={editMealAmount}
              onChange={(e) => setEditMealAmount(e.target.value)}
            />

            <div style={styles.label}>備註</div>
            <input
              style={styles.bigInput}
              value={editNote}
              onChange={(e) => setEditNote(e.target.value)}
              placeholder="例如：補登、金額輸錯修正"
            />

            <div style={styles.modalActions}>
              <button
                style={styles.modalCancelBtn}
                onClick={() => {
                  setEditingMeal(null);
                  setEditMealAmount("");
                  setEditNote("");
                }}
              >
                取消
              </button>
              <button style={styles.modalSaveBtn} onClick={saveEditMeal}>
                儲存修改
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="meal-app-shell" style={styles.appShell}>
        <header className="meal-top-header" style={styles.topHeader}>
          <div className="meal-header-left" style={styles.headerLeft}>
            <div style={styles.appIcon}>🍴</div>
            <div>
              <div style={styles.appTitle}>員工餐記錄系統</div>
              <div style={styles.appSubTitle}>Staff Meal Record</div>
            </div>
          </div>

          <div className="meal-header-actions" style={styles.headerRight}>
            <input
              className="meal-date-input"
              type="date"
              style={styles.headerDateInput}
              value={mealDate}
              onChange={(e) => setMealDate(e.target.value)}
            />

            {isAdmin ? <button className="access-button" style={styles.adminBlueBtn} onClick={logout}>離開管理模式</button> : null}
            {isManager ? <button className="access-button" style={styles.managerLogoutBtn} onClick={managerLogout}>{managerStore}店長登出</button> : null}
            {!isAdmin && !isManager ? (
              <details className="access-menu">
                <summary>管理／店長登入</summary>
                <div className="access-menu__panel">
                  <div className="access-menu__group">
                    <div className="access-menu__label">系統管理</div>
                    <input
                      className="access-input"
                      style={styles.passwordInput}
                      type="password"
                      placeholder="管理密碼"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") login(); }}
                    />
                    <button className="access-button" style={styles.adminBlueBtn} onClick={login}>進入管理模式</button>
                  </div>
                  <div className="access-menu__group">
                    <div className="access-menu__label">店長審核</div>
                    <select
                      className="access-input"
                      style={styles.managerStoreSelect}
                      value={managerLoginStore}
                      onChange={(e) => setManagerLoginStore(e.target.value)}
                    >
                      <option value="西螺">西螺店長</option>
                      <option value="斗南">斗南店長</option>
                    </select>
                    <input
                      className="access-input"
                      style={styles.passwordInput}
                      type="password"
                      placeholder="店長密碼"
                      value={managerPassword}
                      onChange={(e) => setManagerPassword(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") managerLogin(); }}
                    />
                    <button className="access-button access-button--manager" style={styles.managerBtn} onClick={managerLogin}>進入店長審核</button>
                  </div>
                </div>
              </details>
            ) : null}
          </div>
        </header>

        <main className="meal-content" style={styles.contentArea}>
          {isAdmin ? (
            <section className="admin-dashboard-priority" style={styles.adminCard}>
              <div className="card-title-row" style={styles.cardTitleRow}>
                <div>
                  <div style={styles.cardTitle}>管理總覽</div>
                  <div style={styles.cardSubTitle}>今日登記狀況與本月收費統計</div>
                </div>
                <div className="admin-controls" style={styles.adminControlBar}>
                  <select
                    style={styles.adminSelect}
                    value={adminStoreFilter}
                    onChange={(e) => setAdminStoreFilter(e.target.value)}
                  >
                    {storeOptions.map((storeName) => (
                      <option key={storeName} value={storeName}>{storeName}</option>
                    ))}
                  </select>
                  <input
                    type="month"
                    style={styles.monthInput}
                    value={selectedMonth}
                    onChange={(e) => setSelectedMonth(e.target.value)}
                  />
                  <button className="admin-export-button" style={styles.outlineBtn} onClick={exportMonthlyCsv}>
                    匯出 {selectedMonth} 收款核對簿
                  </button>
                </div>
              </div>

              <div className="dashboard-grid" style={styles.dashboardGrid}>
                <DashBox title="今日登記" value={`${adminDashboard.todayCount} 筆`} sub={`餐費 ${adminDashboard.todayMealAmount} 元`} />
                <DashBox title="今日未登記" value={`${workingWithoutMeal.length} 人`} sub="有上班、尚未登記員工餐" highlight={workingWithoutMeal.length > 0} />
                <DashBox title="今日用餐最高" value={adminDashboard.todayTop ? `${adminDashboard.todayTop.mealAmount} 元` : "0 元"} sub={adminDashboard.todayTop ? `${adminDashboard.todayTop.name}` : "尚無紀錄"} />
                <DashBox title="本月累積補助" value={`${adminDashboard.monthEarnedSubsidy} 元`} sub={`上班 ${adminDashboard.monthWorkDays} 天｜已使用 ${adminDashboard.monthUsedSubsidy}`} />
                <DashBox title="本月應收費" value={`${adminDashboard.monthEmployeePay} 元`} sub={adminDashboard.monthTop ? `應收最多：${adminDashboard.monthTop.name} ${adminDashboard.monthTop.employeePay}元` : "尚無紀錄"} highlight />
              </div>
            </section>
          ) : null}

          {!isAdmin ? (
            <>
          <section className="employee-hero" style={styles.employeeHero}>
            <div className="employee-block" style={styles.employeeBlock}>
              <div style={styles.avatarCircle}>👤</div>
              <div>
                <div style={styles.label}>員工工號</div>
                <input
                  className="employee-id-input"
                  style={styles.empInput}
                  value={empId}
                  onChange={(e) => setEmpId(e.target.value)}
                  placeholder="輸入工號"
                />
                {matchedEmployee ? (
                  <>
                    <div style={styles.employeeFound}>
                      {matchedEmployee.name}｜{matchedEmployee.store || "未填店名"}
                    </div>
                    {matchedEmployee.mealApprovalRequired ? (
                      <div style={styles.approvalHint}>此員工需 {matchedEmployee.approvalStore || matchedEmployee.store || "店長"} 審核後才給補助</div>
                    ) : null}
                  </>
                ) : empId.trim() ? (
                  <div style={styles.employeeNotFound}>找不到員工</div>
                ) : null}
              </div>
            </div>

            <div style={styles.heroNotice}>※ 餐費紀錄請在下班後填寫</div>
          </section>

          <section className="meal-card overview-card" style={styles.overviewCard}>
            <div className="metric-grid" style={styles.metricGrid}>
              <MetricBox icon="🕘" title="今日工時" value={`${formatHours(workInfo.workHours)} hr`} sub={`${formatTime(workInfo.workInAt)} - ${formatTime(workInfo.workOutAt)}｜休息 ${formatHours(workInfo.breakHours)}hr`} color="#2563eb" />
              <MetricBox icon="💵" title="今日新增補助" value={`${mealCalc.calculatedSubsidy} 元`} sub={mealCalc.needApproval ? "需店長審核，通過後才列入本月補助" : workInfo.workHours >= 6 ? "滿 6 小時以上" : workInfo.workHours >= 4 ? "滿 4 未滿 6 小時" : "未達補貼標準"} color="#16a34a" />
              <MetricBox icon="🍽️" title="今日餐費" value={`${mealCalc.actualMealAmount} 元`} sub="員工實際用餐金額" color="#ea580c" />
              <MetricBox icon="👛" title="本月應繳（已打九折）" value={`${employeeMonthSummary.isPaid ? 0 : employeeMonthSummary.totalEmployeePay} 元`} sub="整月超額九折後的應繳金額" color="#dc2626" />
            </div>
          </section>

          {matchedEmployee ? (
            <section className="meal-card" style={styles.employeeMonthCard}>
              <div className="card-title-row" style={styles.cardTitleRow}>
                <div>
                  <div style={styles.cardTitle}>員工個人月結</div>
                  <div style={styles.cardSubTitle}>{employeeMonthSummary.monthKey}｜{matchedEmployee.name} 的個人員工餐紀錄</div>
                </div>
                <div style={employeeMonthSummary.isPaid ? styles.paidBadge : styles.unpaidBadge}>
                  {employeeMonthSummary.isPaid ? "已收款" : "未收款"}
                </div>
              </div>

              <div className="summary-grid" style={styles.personalSummaryGrid}>
                <MetricSmall title="本月上班天數" value={`${employeeMonthSummary.days} 天`} />
                <MetricSmall title="本月累積補助" value={`${employeeMonthSummary.totalEarnedSubsidy} 元`} />
                <MetricSmall title="剩餘補助" value={`${employeeMonthSummary.endingBalance} 元`} />
                <MetricSmall title="本月應繳（已打九折）" value={`${employeeMonthSummary.isPaid ? 0 : employeeMonthSummary.totalEmployeePay} 元`} danger />
              </div>

            </section>
          ) : null}

          <section className="meal-card meal-entry-card" style={styles.entryCard}>
            <div className="card-title-row" style={styles.cardTitleRow}>
              <div>
                <div style={styles.cardTitle}>今日實際用餐金額</div>
                <div style={styles.cardSubTitle}>系統會自動讀取打卡紀錄與工時</div>
              </div>
              <div style={styles.subsidyBadge}>
                {employeeMonthSummary.overAmount > 0
                  ? `目前整月超額：${employeeMonthSummary.overAmount} 元`
                  : `目前整月剩餘補助：${employeeMonthSummary.endingBalance} 元`}
              </div>
            </div>

            <div className="meal-entry-row" style={styles.entryRow}>
              <input
                className="meal-amount-input"
                style={styles.mealInput}
                type="number"
                inputMode="decimal"
                value={mealAmount}
                onChange={(e) => setMealAmount(e.target.value)}
                placeholder="請輸入金額，例如 150"
              />
              <div style={styles.currencyText}>元</div>
              <button className="meal-save-button" style={styles.saveButton} onClick={submitMeal}>儲存今日餐費</button>
            </div>

            <div style={styles.formulaBox}>
              <b>整月結算方式：</b>月底以本月總餐費扣除本月總補助；只有整月超額的部分 × 0.9 計入應繳。
              <span> 剩餘補助月底歸零，不跨月累積。</span>
            </div>

            {!matchedEmployee && empId.trim() ? (
              <div style={styles.warningBox}>找不到員工，請確認工號是否正確。</div>
            ) : null}
            {matchedEmployee && !workInfo.hasWorkIn ? (
              <div style={styles.warningBox}>尚未上班打卡，不能登記員工餐。</div>
            ) : null}
            {matchedEmployee && workInfo.hasWorkIn && !workInfo.hasWorkOut ? (
              <div style={styles.warningBox}>尚未下班打卡，下班後才能登記員工餐。</div>
            ) : null}
            {existingMealRecord ? (
              <div style={styles.noticeBox}>此員工 {mealDate} 已有紀錄，再按儲存會覆蓋更新。</div>
            ) : null}
            {message ? <div style={message.includes("已儲存") ? styles.successBox : styles.warningBox}>{message}</div> : null}
          </section>
            </>
          ) : null}

          <section className="meal-card" style={styles.recordsCard}>
            <div className="card-title-row" style={styles.cardTitleRow}>
              <div>
                <div style={styles.cardTitle}>本日員工餐輸入狀況</div>
                <div style={styles.cardSubTitle}>{mealDate}｜依店別顯示所有上班與已輸入人員</div>
              </div>
            </div>

            {todayMealStatusGroups.length === 0 ? (
              <div style={styles.emptyText}>本日尚無上班或員工餐資料</div>
            ) : (
              todayMealStatusGroups.map(([storeName, items]) => (
                <div className="store-meal-status-group" key={storeName}>
                  <div className="store-meal-status-heading">
                    <span>{storeName}</span>
                    <span>{items.filter((item) => item.hasMeal).length}/{items.length} 人已輸入</span>
                  </div>
                  <div className="responsive-table" style={styles.tableWrap}>
                    <table className="meal-table" style={styles.cleanTable}>
                      <thead>
                        <tr>
                          <th>日期</th>
                          <th>員工</th>
                          <th>工時</th>
                          <th>當日新增補助</th>
                          <th>餐費</th>
                          <th>本日是否輸入員工餐</th>
                          {isAdmin ? <th>操作</th> : null}
                        </tr>
                      </thead>
                      <tbody>
                        {items.map((item) => {
                          const statusText = !item.hasMeal
                            ? "未輸入"
                            : item.approvalStatus === "pending"
                              ? "已輸入・待審核"
                              : item.approvalStatus === "rejected"
                                ? "已輸入・未通過"
                                : "已輸入";
                          const statusStyle = !item.hasMeal || item.approvalStatus === "rejected"
                            ? styles.rejectedPill
                            : item.approvalStatus === "pending"
                              ? styles.pendingPill
                              : styles.savedPill;
                          return (
                            <tr key={item.key}>
                              <td>{mealDate}</td>
                              <td>{item.name}<br /><span>{item.empId}</span></td>
                              <td style={styles.blueText}>{item.hasWorkOut ? `${item.workHours} hr` : "—"}</td>
                              <td style={styles.greenText}>{item.calculatedSubsidyAmount} 元</td>
                              <td style={styles.orangeText}>{item.hasMeal ? `${item.mealAmount} 元` : "—"}</td>
                              <td><span style={statusStyle}>{statusText}</span></td>
                              {isAdmin ? (
                                <td>
                                  {item.hasMeal ? (
                                    <>
                                      <button style={styles.tableEditBtn} onClick={() => openEditMeal(item.meal)}>修改</button>
                                      <button style={styles.tableDeleteBtn} onClick={() => deleteMealRecord(item.meal)}>刪除</button>
                                    </>
                                  ) : "—"}
                                </td>
                              ) : null}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))
            )}
          </section>

          {isManager ? (
            <section className="meal-card" style={styles.recordsCard}>
              <div className="card-title-row" style={styles.cardTitleRow}>
                <div>
                  <div style={styles.cardTitle}>{managerStore}店長審核</div>
                  <div style={styles.cardSubTitle}>只顯示需要 {managerStore} 店長通過的員工餐資料</div>
                </div>
              </div>

              {managerPendingRecords.length === 0 ? (
                <div style={styles.emptyText}>目前沒有待審核資料</div>
              ) : (
                <div className="responsive-table" style={styles.tableWrap}>
                  <table className="meal-table" style={styles.cleanTable}>
                    <thead>
                      <tr>
                        <th>日期</th>
                        <th>員工</th>
                        <th>店別</th>
                        <th>工時</th>
                        <th>餐費</th>
                        <th>通過後補貼</th>
                        <th>目前自付</th>
                        <th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {managerPendingRecords.map((item) => (
                        <tr key={`${item.dateKey}_${item.empId}`}>
                          <td>{item.dateKey}</td>
                          <td>{item.name}<br /><span>{item.empId}</span></td>
                          <td>{item.store || "未填店名"}</td>
                          <td style={styles.blueText}>{item.workHours || 0} hr</td>
                          <td style={styles.orangeText}>{item.mealAmount || 0} 元</td>
                          <td style={styles.greenText}>{item.calculatedSubsidyAmount ?? item.subsidyAmount ?? 0} 元</td>
                          <td style={styles.redText}>{item.employeePay || 0} 元</td>
                          <td>
                            <button style={styles.approveBtn} onClick={() => approveMealRecord(item)}>通過</button>
                            <button style={styles.rejectBtn} onClick={() => rejectMealRecord(item)}>不通過</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          ) : null}

          {!isAdmin ? <section style={styles.settleNote}>
            <div style={styles.noteIcon}>🪙</div>
            <div>
              <div style={styles.noteTitle}>月底結算說明</div>
              <div style={styles.noteText}>每月 1 號～月底為一個結算週期，員工餐補助可於當月內累計使用；月底剩餘補助歸零，不跨月。</div>
            </div>
          </section> : null}

          {isAdmin ? (
            <>
              <details className="meal-card approval-settings" style={styles.recordsCard}>
                <summary className="approval-settings__summary">
                  <div>
                    <div style={styles.cardTitle}>員工餐審核設定</div>
                    <div style={styles.cardSubTitle}>較少使用，點此展開設定</div>
                  </div>
                  <span className="approval-settings__toggle" aria-hidden="true">展開</span>
                </summary>

                <div className="approval-settings__content">
                  <div style={styles.cardSubTitle}>漏 key 過的員工可改成需店長審核，之後補助須通過才會計入</div>
                  {employees.length === 0 ? (
                    <div style={styles.emptyText}>目前沒有員工資料</div>
                  ) : (
                    <div className="responsive-table" style={styles.tableWrap}>
                      <table className="meal-table" style={styles.cleanTable}>
                        <thead>
                          <tr>
                            <th>員工</th>
                            <th>店別</th>
                            <th>需店長審核</th>
                            <th>審核店別</th>
                          </tr>
                        </thead>
                        <tbody>
                          {employees.map((emp) => (
                            <tr key={emp.id}>
                              <td>{emp.name || "未填姓名"}<br /><span>{emp.empId || emp.id}</span></td>
                              <td>{emp.store || "未填店名"}</td>
                              <td>
                                <select
                                  style={styles.inlineSelect}
                                  value={emp.mealApprovalRequired ? "是" : "否"}
                                  onChange={(e) => updateEmployeeApprovalSetting(emp, "mealApprovalRequired", e.target.value === "是")}
                                >
                                  <option value="否">否</option>
                                  <option value="是">是</option>
                                </select>
                              </td>
                              <td>
                                <select
                                  style={styles.inlineSelect}
                                  value={normalizeStoreName(emp.approvalStore || emp.store || "西螺")}
                                  onChange={(e) => updateEmployeeApprovalSetting(emp, "approvalStore", e.target.value)}
                                >
                                  <option value="西螺">西螺</option>
                                  <option value="斗南">斗南</option>
                                </select>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </details>

              <section className="meal-card" style={styles.recordsCard}>
                <div className="card-title-row" style={styles.cardTitleRow}>
                  <div>
                    <div style={styles.cardTitle}>有上班但尚未登記員工餐</div>
                    <div style={styles.cardSubTitle}>{mealDate}｜{adminStoreFilter}｜依原始上班打卡即時比對</div>
                  </div>
                  <div style={workingWithoutMeal.length > 0 ? styles.unpaidBadge : styles.paidBadge}>
                    {workingWithoutMeal.length > 0 ? `${workingWithoutMeal.length} 人待確認` : "皆已確認"}
                  </div>
                </div>

                {workingWithoutMeal.length === 0 ? (
                  <div style={styles.emptyText}>目前沒有「有上班但未登記員工餐」的人員。</div>
                ) : (
                  <div className="responsive-table" style={styles.tableWrap}>
                    <table className="meal-table" style={styles.cleanTable}>
                      <thead>
                        <tr>
                          <th>員工</th>
                          <th>店別</th>
                          <th>上班時間</th>
                          <th>下班時間</th>
                          <th>目前狀態</th>
                        </tr>
                      </thead>
                      <tbody>
                        {workingWithoutMeal.map((item) => (
                          <tr key={`${mealDate}_${item.empId}`}>
                            <td>{item.name}<br /><span>{item.empId}</span></td>
                            <td>{item.store}</td>
                            <td style={styles.blueText}>{formatTime(item.workInAt)}</td>
                            <td>{item.hasWorkOut ? formatTime(item.workOutAt) : "—"}</td>
                            <td><span style={item.hasWorkOut ? styles.pendingPill : styles.savedPill}>{item.hasWorkOut ? "已下班，待確認餐費" : "仍在上班"}</span></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              <section className="meal-card" style={styles.recordsCard}>
                <div className="card-title-row" style={styles.cardTitleRow}>
                  <div>
                    <div style={styles.cardTitle}>店別分帳</div>
                    <div style={styles.cardSubTitle}>{selectedMonth}｜各店員工餐補貼與應收款</div>
                  </div>
                </div>

                {storeSettlementSummary.length === 0 ? (
                  <div style={styles.emptyText}>目前尚無店別分帳資料</div>
                ) : (
                  <div className="summary-grid" style={styles.personalSummaryGrid}>
                    {storeSettlementSummary.map((store) => (
                      <div key={store.store} style={styles.storeSplitCard}>
                        <div style={styles.storeName}>{store.store}</div>
                        <div style={styles.storeLine}>上班天數：{store.days}</div>
                        <div style={styles.storeLine}>用餐筆數：{store.mealDays}</div>
                        <div style={styles.storeLine}>餐費總額：{store.totalMealAmount} 元</div>
                        <div style={styles.storeLine}>累積補助：{store.totalEarnedSubsidy} 元</div>
                        <div style={styles.storeLine}>已使用補助：{store.totalUsedSubsidy} 元</div>
                        <div style={styles.storePay}>應向員工收：{store.totalEmployeePay} 元</div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section className="meal-card" style={styles.recordsCard}>
                <div className="card-title-row" style={styles.cardTitleRow}>
                  <div>
                    <div style={styles.cardTitle}>月底結算</div>
                    <div style={styles.cardSubTitle}>{selectedMonth}｜{adminStoreFilter}｜用於月底向員工收費統計</div>
                  </div>
                </div>

                {filteredMonthlySummary.length === 0 ? (
                  <div style={styles.emptyText}>{selectedMonth} 尚無結算資料</div>
                ) : (
                  <div className="responsive-table" style={styles.tableWrap}>
                    <table className="meal-table" style={styles.cleanTable}>
                      <thead>
                        <tr>
                          <th>員工</th>
                          <th>店別</th>
                          <th>上班天數</th>
                          <th>用餐筆數</th>
                          <th>吃的金額</th>
                          <th>累積補助</th>
                          <th>已使用補助</th>
                          <th>剩餘補助</th>
                          <th>員工自付</th>
                          <th>待審核</th>
                          <th>個人明細</th>
                          <th>收款狀態</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredMonthlySummaryWithPaid.map((item) => (
                          <tr key={item.empId}>
                            <td>{item.name}<br /><span>{item.empId}</span></td>
                            <td>{item.store}</td>
                            <td>{item.days}</td>
                            <td>{item.mealDays}</td>
                            <td>{item.totalMealAmount}</td>
                            <td>{item.totalEarnedSubsidy}</td>
                            <td>{item.totalUsedSubsidy}</td>
                            <td>{item.endingBalance}</td>
                            <td style={styles.redText}><b>{item.paid ? 0 : item.totalEmployeePay}</b></td>
                            <td>{item.pendingCount || 0}</td>
                            <td>
                              <button style={styles.tableEditBtn} onClick={() => exportEmployeeMonthlyDetail(item)}>匯出明細</button>
                            </td>
                            <td>
                              <span style={item.paid ? styles.paidPill : styles.unpaidPill}>
                                {item.paid ? "已收款" : "未收款"}
                              </span>
                              <br />
                              {item.paid ? (
                                <button style={styles.tableEditBtn} onClick={() => unmarkPaid(item)}>取消</button>
                              ) : (
                                <button style={styles.tableEditBtn} onClick={() => markPaid(item)}>已收款</button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </>
          ) : null}
        </main>
      </div>
    </div>
  );
}

function DashBox({ title, value, sub, highlight = false }) {
  return (
    <div style={highlight ? styles.dashBoxHighlight : styles.dashBox}>
      <div style={styles.dashTitle}>{title}</div>
      <div style={styles.dashValue}>{value}</div>
      <div style={styles.dashSub}>{sub}</div>
    </div>
  );
}

function MetricBox({ icon, title, value, sub, color }) {
  return (
    <div style={styles.metricBox}>
      <div style={{ ...styles.metricIcon, background: color }}>{icon}</div>
      <div style={styles.metricTitle}>{title}</div>
      <div style={{ ...styles.metricValue, color }}>{value}</div>
      <div style={styles.metricSub}>{sub}</div>
    </div>
  );
}

function MetricSmall({ title, value, danger = false }) {
  return (
    <div style={danger ? styles.metricSmallDanger : styles.metricSmall}>
      <div style={styles.metricSmallTitle}>{title}</div>
      <div style={styles.metricSmallValue}>{value}</div>
    </div>
  );
}

const styles = {
  page: {
    minHeight: "100vh",
    background: "#eef4fb",
    color: "#111827",
    padding: 12,
    boxSizing: "border-box",
    fontFamily: "'Noto Sans TC', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  },
  appShell: {
    maxWidth: 1180,
    margin: "0 auto",
    background: "#ffffff",
    border: "1px solid #dbe3ef",
    borderRadius: 18,
    overflow: "hidden",
    boxShadow: "0 18px 50px rgba(15,23,42,.10)",
  },
  topHeader: {
    minHeight: 104,
    padding: "18px 28px",
    borderBottom: "1px solid #dbe3ef",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 18,
    background: "#ffffff",
  },
  headerLeft: {
    display: "flex",
    alignItems: "center",
    gap: 18,
  },
  appIcon: {
    width: 58,
    height: 58,
    borderRadius: 16,
    display: "grid",
    placeItems: "center",
    background: "linear-gradient(135deg, #2563eb, #1d4ed8)",
    color: "#fff",
    fontSize: 30,
    boxShadow: "0 10px 22px rgba(37,99,235,.22)",
  },
  appTitle: {
    fontSize: 32,
    fontWeight: 950,
    letterSpacing: 1,
  },
  appSubTitle: {
    color: "#64748b",
    fontSize: 14,
    fontWeight: 800,
    marginTop: 2,
  },
  headerRight: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    flexWrap: "wrap",
    justifyContent: "flex-end",
  },
  headerDateInput: {
    width: 260,
    minHeight: 64,
    borderRadius: 14,
    border: "1px solid #cbd5e1",
    background: "#ffffff",
    color: "#111827",
    WebkitTextFillColor: "#111827",
    fontSize: 24,
    fontWeight: 950,
    padding: "0 18px",
    boxShadow: "0 8px 20px rgba(15,23,42,.06)",
  },
  passwordInput: {
    width: 132,
    minHeight: 58,
    borderRadius: 14,
    border: "1px solid #cbd5e1",
    background: "#ffffff",
    color: "#111827",
    WebkitTextFillColor: "#111827",
    fontSize: 18,
    fontWeight: 900,
    padding: "0 14px",
  },
  adminBlueBtn: {
    minHeight: 62,
    border: "none",
    borderRadius: 14,
    background: "linear-gradient(135deg, #2563eb, #1d4ed8)",
    color: "#fff",
    fontSize: 20,
    fontWeight: 950,
    padding: "0 24px",
    cursor: "pointer",
    boxShadow: "0 10px 22px rgba(37,99,235,.20)",
  },
  contentArea: {
    padding: 26,
  },
  managerBtn: {
    minHeight: 62,
    border: "none",
    borderRadius: 14,
    background: "linear-gradient(135deg, #16a34a, #15803d)",
    color: "#fff",
    fontSize: 20,
    fontWeight: 950,
    padding: "0 24px",
    cursor: "pointer",
    boxShadow: "0 10px 22px rgba(22,163,74,.18)",
  },
  managerLogoutBtn: {
    minHeight: 62,
    border: "none",
    borderRadius: 14,
    background: "linear-gradient(135deg, #16a34a, #15803d)",
    color: "#fff",
    fontSize: 20,
    fontWeight: 950,
    padding: "0 24px",
    cursor: "pointer",
  },
  managerStoreSelect: {
    minHeight: 58,
    borderRadius: 14,
    border: "1px solid #cbd5e1",
    background: "#ffffff",
    color: "#111827",
    fontSize: 18,
    fontWeight: 950,
    padding: "0 14px",
  },

  employeeHero: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 20,
    marginBottom: 20,
  },
  employeeBlock: {
    display: "flex",
    alignItems: "center",
    gap: 18,
  },
  avatarCircle: {
    width: 104,
    height: 104,
    borderRadius: 999,
    background: "#eaf2ff",
    display: "grid",
    placeItems: "center",
    fontSize: 54,
  },
  empInput: {
    width: 240,
    minHeight: 58,
    borderRadius: 12,
    border: "1px solid #cbd5e1",
    background: "#ffffff",
    color: "#111827",
    WebkitTextFillColor: "#111827",
    fontSize: 24,
    fontWeight: 950,
    padding: "0 14px",
  },
  employeeFound: {
    marginTop: 8,
    display: "inline-block",
    border: "1px solid #93c5fd",
    color: "#1d4ed8",
    borderRadius: 10,
    padding: "6px 10px",
    fontWeight: 950,
    background: "#eff6ff",
  },
  employeeNotFound: {
    marginTop: 8,
    color: "#dc2626",
    fontWeight: 950,
  },
  approvalHint: {
    marginTop: 8,
    display: "inline-block",
    border: "1px solid #fdba74",
    color: "#c2410c",
    borderRadius: 10,
    padding: "6px 10px",
    fontWeight: 950,
    background: "#fff7ed",
  },
  heroNotice: {
    color: "#2563eb",
    fontSize: 20,
    fontWeight: 950,
  },
  overviewCard: {
    background: "#ffffff",
    border: "1px solid #dbe3ef",
    borderRadius: 16,
    padding: 18,
    marginBottom: 20,
  },
  metricGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
    gap: 0,
  },
  metricBox: {
    padding: "16px 22px",
    borderRight: "1px solid #dbe3ef",
    textAlign: "center",
  },
  metricIcon: {
    width: 56,
    height: 56,
    borderRadius: 999,
    display: "grid",
    placeItems: "center",
    color: "#fff",
    fontSize: 28,
    margin: "0 auto 8px",
  },
  metricTitle: {
    fontSize: 17,
    fontWeight: 950,
    marginBottom: 10,
  },
  metricValue: {
    fontSize: 36,
    fontWeight: 950,
    lineHeight: 1,
  },
  metricSub: {
    color: "#475569",
    marginTop: 12,
    fontSize: 16,
    fontWeight: 800,
    lineHeight: 1.45,
  },
  entryCard: {
    border: "1px solid #bfdbfe",
    borderRadius: 18,
    background: "#f8fbff",
    padding: 20,
    marginBottom: 20,
  },
  cardTitleRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 16,
    marginBottom: 16,
  },
  cardTitle: {
    fontSize: 24,
    fontWeight: 950,
  },
  cardSubTitle: {
    color: "#64748b",
    fontSize: 15,
    fontWeight: 800,
    marginTop: 4,
  },
  subsidyBadge: {
    border: "1px solid #93c5fd",
    background: "#eff6ff",
    color: "#1d4ed8",
    borderRadius: 12,
    padding: "10px 14px",
    fontSize: 18,
    fontWeight: 950,
  },
  entryRow: {
    display: "grid",
    gridTemplateColumns: "1fr 40px 240px",
    gap: 14,
    alignItems: "center",
  },
  mealInput: {
    minHeight: 66,
    borderRadius: 12,
    border: "1px solid #cbd5e1",
    background: "#fff",
    color: "#111827",
    WebkitTextFillColor: "#111827",
    fontSize: 24,
    fontWeight: 950,
    padding: "0 20px",
  },
  currencyText: {
    fontSize: 24,
    fontWeight: 950,
  },
  saveButton: {
    minHeight: 66,
    border: "none",
    borderRadius: 14,
    background: "linear-gradient(135deg, #2563eb, #1d4ed8)",
    color: "#fff",
    fontSize: 22,
    fontWeight: 950,
    cursor: "pointer",
  },
  formulaBox: {
    marginTop: 18,
    border: "1px solid #dbe3ef",
    background: "#ffffff",
    borderRadius: 14,
    padding: "16px 20px",
    fontSize: 16,
    fontWeight: 800,
    color: "#334155",
    lineHeight: 1.6,
  },
  recordsCard: {
    background: "#fff",
    border: "1px solid #dbe3ef",
    borderRadius: 18,
    padding: 20,
    marginBottom: 20,
  },
  tableWrap: {
    overflowX: "auto",
    border: "1px solid #dbe3ef",
    borderRadius: 14,
  },
  cleanTable: {
    width: "100%",
    borderCollapse: "collapse",
    fontSize: 17,
  },
  blueText: { color: "#2563eb", fontWeight: 950 },
  greenText: { color: "#16a34a", fontWeight: 950 },
  orangeText: { color: "#ea580c", fontWeight: 950 },
  redText: { color: "#dc2626", fontWeight: 950 },
  savedPill: {
    display: "inline-block",
    background: "#dcfce7",
    color: "#15803d",
    padding: "6px 14px",
    borderRadius: 999,
    fontWeight: 950,
  },
  pendingPill: {
    display: "inline-block",
    background: "#fff7ed",
    color: "#c2410c",
    padding: "6px 14px",
    borderRadius: 999,
    fontWeight: 950,
  },
  rejectedPill: {
    display: "inline-block",
    background: "#fee2e2",
    color: "#b91c1c",
    padding: "6px 14px",
    borderRadius: 999,
    fontWeight: 950,
  },
  approveBtn: {
    border: "none",
    color: "#fff",
    background: "#16a34a",
    borderRadius: 10,
    padding: "8px 12px",
    marginRight: 6,
    fontWeight: 950,
    cursor: "pointer",
  },
  rejectBtn: {
    border: "none",
    color: "#fff",
    background: "#dc2626",
    borderRadius: 10,
    padding: "8px 12px",
    fontWeight: 950,
    cursor: "pointer",
  },
  tableEditBtn: {
    border: "1px solid #93c5fd",
    color: "#1d4ed8",
    background: "#eff6ff",
    borderRadius: 10,
    padding: "8px 10px",
    marginRight: 6,
    fontWeight: 950,
    cursor: "pointer",
  },
  tableDeleteBtn: {
    border: "1px solid #fecaca",
    color: "#dc2626",
    background: "#fff",
    borderRadius: 10,
    padding: "8px 10px",
    fontWeight: 950,
    cursor: "pointer",
  },
  outlineBtn: {
    border: "1px solid #93c5fd",
    background: "#ffffff",
    color: "#2563eb",
    borderRadius: 12,
    padding: "12px 18px",
    fontSize: 18,
    fontWeight: 950,
    cursor: "pointer",
  },
  settleNote: {
    display: "flex",
    alignItems: "center",
    gap: 18,
    border: "1px solid #facc15",
    background: "#fffbeb",
    borderRadius: 16,
    padding: 18,
    marginBottom: 20,
  },
  noteIcon: {
    fontSize: 42,
  },
  noteTitle: {
    fontSize: 22,
    fontWeight: 950,
  },
  noteText: {
    marginTop: 4,
    fontSize: 17,
    fontWeight: 850,
    color: "#713f12",
  },
  adminCard: {
    background: "#ffffff",
    border: "1px solid #dbe3ef",
    borderRadius: 18,
    padding: 20,
    marginBottom: 20,
  },
  adminControlBar: {
    display: "flex",
    gap: 12,
    alignItems: "center",
  },
  inlineSelect: {
    minHeight: 44,
    borderRadius: 10,
    border: "1px solid #cbd5e1",
    background: "#fff",
    color: "#111827",
    fontSize: 16,
    fontWeight: 950,
    padding: "0 12px",
  },
  adminSelect: {
    minHeight: 56,
    borderRadius: 12,
    border: "1px solid #cbd5e1",
    background: "#fff",
    color: "#111827",
    fontSize: 18,
    fontWeight: 950,
    padding: "0 14px",
  },
  monthInput: {
    minHeight: 56,
    borderRadius: 12,
    border: "1px solid #cbd5e1",
    background: "#ffffff",
    color: "#111827",
    WebkitTextFillColor: "#111827",
    fontSize: 18,
    fontWeight: 950,
    padding: "0 14px",
  },
  dashboardGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
    gap: 14,
  },
  dashBox: {
    background: "#f8fafc",
    border: "1px solid #e2e8f0",
    borderRadius: 16,
    padding: 18,
  },
  dashBoxHighlight: {
    background: "#eff6ff",
    border: "1px solid #93c5fd",
    borderRadius: 16,
    padding: 18,
  },
  dashTitle: {
    color: "#64748b",
    fontSize: 15,
    fontWeight: 950,
  },
  dashValue: {
    marginTop: 8,
    fontSize: 28,
    fontWeight: 950,
    color: "#111827",
  },
  dashSub: {
    marginTop: 8,
    color: "#64748b",
    fontSize: 13,
    fontWeight: 800,
    lineHeight: 1.4,
  },
  emptyText: {
    padding: 20,
    borderRadius: 14,
    background: "#f8fafc",
    color: "#64748b",
    textAlign: "center",
    fontSize: 18,
    fontWeight: 900,
  },
  warningBox: {
    marginTop: 14,
    padding: 14,
    borderRadius: 14,
    background: "#fff7ed",
    border: "1px solid #fdba74",
    color: "#9a3412",
    fontWeight: 950,
  },
  successBox: {
    marginTop: 14,
    padding: 14,
    borderRadius: 14,
    background: "#ecfdf5",
    border: "1px solid #86efac",
    color: "#166534",
    fontWeight: 950,
  },
  noticeBox: {
    marginTop: 14,
    padding: 14,
    borderRadius: 14,
    background: "#eff6ff",
    border: "1px solid #93c5fd",
    color: "#1d4ed8",
    fontWeight: 950,
  },
  label: {
    fontSize: 16,
    color: "#475569",
    fontWeight: 950,
    marginBottom: 8,
  },
  bigInput: {
    width: "100%",
    minHeight: 66,
    padding: "0 18px",
    fontSize: 24,
    borderRadius: 14,
    border: "1px solid #cbd5e1",
    background: "#ffffff",
    color: "#111827",
    WebkitTextFillColor: "#111827",
    fontWeight: 950,
    boxSizing: "border-box",
  },
  modalOverlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(15,23,42,.58)",
    zIndex: 10,
    display: "grid",
    placeItems: "center",
    padding: 20,
  },
  editModalCard: {
    width: "100%",
    maxWidth: 620,
    background: "#fff",
    borderRadius: 24,
    padding: 26,
    boxShadow: "0 24px 80px rgba(0,0,0,.28)",
  },
  modalTitle: {
    fontSize: 28,
    fontWeight: 950,
    marginBottom: 10,
  },
  editModalInfo: {
    color: "#64748b",
    fontWeight: 900,
    marginBottom: 18,
  },
  modalActions: {
    display: "flex",
    gap: 12,
    marginTop: 18,
  },
  modalCancelBtn: {
    flex: 1,
    border: "none",
    background: "#e2e8f0",
    color: "#334155",
    borderRadius: 16,
    padding: "18px",
    fontSize: 20,
    fontWeight: 950,
    cursor: "pointer",
  },
  modalSaveBtn: {
    flex: 1,
    border: "none",
    background: "linear-gradient(135deg, #2563eb, #1d4ed8)",
    color: "#fff",
    borderRadius: 16,
    padding: "18px",
    fontSize: 20,
    fontWeight: 950,
    cursor: "pointer",
  },

  employeeMonthCard: {
    border: "1px solid #dbe3ef",
    borderRadius: 18,
    background: "#ffffff",
    padding: 20,
    marginBottom: 20,
  },
  personalSummaryGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
    gap: 14,
  },
  metricSmall: {
    background: "#f8fafc",
    border: "1px solid #e2e8f0",
    borderRadius: 16,
    padding: 16,
  },
  metricSmallDanger: {
    background: "#fff1f2",
    border: "1px solid #fecdd3",
    borderRadius: 16,
    padding: 16,
  },
  metricSmallTitle: {
    color: "#64748b",
    fontSize: 15,
    fontWeight: 950,
  },
  metricSmallValue: {
    marginTop: 8,
    fontSize: 26,
    fontWeight: 950,
    color: "#111827",
  },
  paidBadge: {
    background: "#dcfce7",
    color: "#15803d",
    border: "1px solid #86efac",
    borderRadius: 999,
    padding: "10px 16px",
    fontSize: 18,
    fontWeight: 950,
  },
  unpaidBadge: {
    background: "#fff7ed",
    color: "#c2410c",
    border: "1px solid #fdba74",
    borderRadius: 999,
    padding: "10px 16px",
    fontSize: 18,
    fontWeight: 950,
  },
  paidPill: {
    display: "inline-block",
    background: "#dcfce7",
    color: "#15803d",
    borderRadius: 999,
    padding: "6px 12px",
    fontWeight: 950,
  },
  unpaidPill: {
    display: "inline-block",
    background: "#fff7ed",
    color: "#c2410c",
    borderRadius: 999,
    padding: "6px 12px",
    fontWeight: 950,
  },
  storeSplitCard: {
    background: "#f8fafc",
    border: "1px solid #e2e8f0",
    borderRadius: 16,
    padding: 16,
  },
  storeName: {
    fontSize: 22,
    fontWeight: 950,
    marginBottom: 10,
  },
  storeLine: {
    color: "#475569",
    fontSize: 16,
    fontWeight: 850,
    marginTop: 6,
  },
  storePay: {
    marginTop: 10,
    color: "#dc2626",
    fontSize: 20,
    fontWeight: 950,
  },
  loadingPage: {
    minHeight: "100vh",
    display: "grid",
    placeItems: "center",
    background: "#eef4fb",
    color: "#111827",
    padding: 20,
  },
  loadingCard: {
    width: "100%",
    maxWidth: 420,
    background: "#ffffff",
    border: "1px solid #dbe3ef",
    borderRadius: 22,
    padding: 24,
    textAlign: "center",
  },
  loadingTitle: {
    fontSize: 28,
    fontWeight: 950,
  },
  loadingText: {
    marginTop: 10,
    color: "#64748b",
  },
  errorText: {
    marginTop: 12,
    color: "#dc2626",
    lineHeight: 1.5,
  },
  retryBtn: {
    marginTop: 14,
    border: "none",
    borderRadius: 999,
    padding: "10px 16px",
    fontWeight: 900,
    cursor: "pointer",
  },
};

const styleTag = document.createElement("style");
styleTag.textContent = `
  table th {
    text-align: center;
    background: #f8fafc;
    color: #334155;
    padding: 14px 12px;
    white-space: nowrap;
    font-weight: 950;
    border-bottom: 1px solid #dbe3ef;
  }
  table td {
    border-top: 1px solid #e2e8f0;
    padding: 14px 12px;
    white-space: nowrap;
    text-align: center;
    font-weight: 850;
  }
  table td span {
    color: #64748b;
    font-size: 13px;
  }
  input,
  input[type="number"],
  input[type="date"],
  input[type="month"],
  input[type="password"],
  select {
    color: #111827 !important;
    -webkit-text-fill-color: #111827 !important;
    caret-color: #2563eb !important;
    background-color: #ffffff !important;
    opacity: 1 !important;
  }
  input::placeholder {
    color: #94a3b8 !important;
    -webkit-text-fill-color: #94a3b8 !important;
    opacity: 1 !important;
  }
  button, input {
    -webkit-tap-highlight-color: transparent;
    touch-action: manipulation;
  }
  @media (max-width: 900px) {
    table th, table td { padding: 12px 8px; font-size: 14px; }
  }
`;
if (!document.getElementById("staff-meal-style")) {
  styleTag.id = "staff-meal-style";
  document.head.appendChild(styleTag);
}
