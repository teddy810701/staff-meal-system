import { useEffect, useMemo, useState } from "react";
import { ref, onValue, set, update, remove } from "firebase/database";
import { signInAnonymously, onAuthStateChanged } from "firebase/auth";
import { db, auth } from "./firebase";

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
    });
  }, [authReady]);

  useEffect(() => {
    if (!authReady) return;

    const mealRef = ref(db, "meal_records");
    return onValue(mealRef, (snap) => {
      setMealRecords(snap.val() || {});
    });
  }, [authReady]);

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

  const mealCalc = useMemo(() => {
    const actualMealAmount = Number(mealAmount) || 0;
    const calculatedSubsidy = workInfo.subsidy || 0;
    const needApproval = Boolean(matchedEmployee?.mealApprovalRequired);
    const subsidy = needApproval ? 0 : calculatedSubsidy;
    const overAmount = Math.max(0, actualMealAmount - subsidy);
    const employeePay = Math.round(overAmount * 0.9);

    return {
      actualMealAmount,
      calculatedSubsidy,
      subsidy,
      overAmount,
      employeePay,
      needApproval,
    };
  }, [mealAmount, workInfo.subsidy, matchedEmployee]);

  const todayMealList = useMemo(() => {
    return Object.values(mealRecords || {})
      .filter((item) => item && item.dateKey === mealDate)
      .sort((a, b) => String(a.store || "").localeCompare(String(b.store || "")) || String(a.name || "").localeCompare(String(b.name || "")))
      .slice(0, 10);
  }, [mealRecords, mealDate]);

  const monthlySummary = useMemo(() => {
    const map = {};

    Object.values(mealRecords || {})
      .filter((item) => item && item.monthKey === selectedMonth)
      .forEach((item) => {
        const key = item.empId || item.name || "UNKNOWN";
        if (!map[key]) {
          map[key] = {
            empId: key,
            name: item.name || "",
            store: item.store || "",
            days: 0,
            totalMealAmount: 0,
            totalSubsidy: 0,
            totalOverAmount: 0,
            totalEmployeePay: 0,
          };
        }

        map[key].days += 1;
        map[key].totalMealAmount += Number(item.mealAmount) || 0;
        map[key].totalSubsidy += Number(item.subsidyAmount) || 0;
        map[key].totalOverAmount += Number(item.overAmount) || 0;
        map[key].totalEmployeePay += Number(item.employeePay) || 0;
      });

    return Object.values(map).sort((a, b) => b.totalEmployeePay - a.totalEmployeePay);
  }, [mealRecords, selectedMonth]);

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
    return Object.values(mealRecords || {})
      .filter((item) => item && item.monthKey === selectedMonth)
      .filter((item) => adminStoreFilter === "全部" || (item.store || "未填店名") === adminStoreFilter)
      .sort((a, b) => String(b.dateKey || "").localeCompare(String(a.dateKey || "")) || String(a.name || "").localeCompare(String(b.name || "")));
  }, [mealRecords, selectedMonth, adminStoreFilter]);

  const adminTodayRecords = useMemo(() => {
    return Object.values(mealRecords || {})
      .filter((item) => item && item.dateKey === mealDate)
      .filter((item) => adminStoreFilter === "全部" || (item.store || "未填店名") === adminStoreFilter);
  }, [mealRecords, mealDate, adminStoreFilter]);

  const adminDashboard = useMemo(() => {
    const sum = (list, key) => list.reduce((total, item) => total + (Number(item[key]) || 0), 0);
    const todayTop = [...adminTodayRecords].sort((a, b) => (Number(b.mealAmount) || 0) - (Number(a.mealAmount) || 0))[0];
    const monthTop = [...adminMonthRecords].sort((a, b) => (Number(b.employeePay) || 0) - (Number(a.employeePay) || 0))[0];

    return {
      todayCount: adminTodayRecords.length,
      todayMealAmount: sum(adminTodayRecords, "mealAmount"),
      todaySubsidy: sum(adminTodayRecords, "subsidyAmount"),
      todayEmployeePay: sum(adminTodayRecords, "employeePay"),
      monthCount: adminMonthRecords.length,
      monthMealAmount: sum(adminMonthRecords, "mealAmount"),
      monthSubsidy: sum(adminMonthRecords, "subsidyAmount"),
      monthEmployeePay: sum(adminMonthRecords, "employeePay"),
      todayTop,
      monthTop,
    };
  }, [adminTodayRecords, adminMonthRecords]);

  const managerPendingRecords = useMemo(() => {
    if (!isManager) return [];
    return Object.values(mealRecords || {})
      .filter((item) => item && item.approvalRequired)
      .filter((item) => (item.approvalStore || item.store || "") === managerStore)
      .filter((item) => (item.approvalStatus || "approved") === "pending")
      .sort((a, b) => String(b.dateKey || "").localeCompare(String(a.dateKey || "")) || String(a.name || "").localeCompare(String(b.name || "")));
  }, [mealRecords, isManager, managerStore]);


  const selectedEmployeeMonthRecords = useMemo(() => {
    if (!selectedEmpKey) return [];
    const monthKey = getMonthKeyFromDateKey(mealDate);
    return Object.values(mealRecords || {})
      .filter((item) => item && item.dateKey && normalizeEmpId(item.empId) === normalizeEmpId(selectedEmpKey))
      .filter((item) => item.monthKey === monthKey)
      .sort((a, b) => String(b.dateKey || "").localeCompare(String(a.dateKey || "")));
  }, [mealRecords, selectedEmpKey, mealDate]);

  const selectedEmployeePaymentKey = selectedEmpKey ? `${getMonthKeyFromDateKey(mealDate)}_${selectedEmpKey}` : "";
  const paymentRecords = mealRecords?.payments || {};

  const employeeMonthSummary = useMemo(() => {
    const totalMealAmount = selectedEmployeeMonthRecords.reduce((sum, item) => sum + (Number(item.mealAmount) || 0), 0);
    const totalSubsidy = selectedEmployeeMonthRecords.reduce((sum, item) => sum + (Number(item.subsidyAmount) || 0), 0);
    const totalEmployeePay = selectedEmployeeMonthRecords.reduce((sum, item) => sum + (Number(item.employeePay) || 0), 0);
    const paidRecord = selectedEmployeePaymentKey ? paymentRecords[selectedEmployeePaymentKey] : null;

    return {
      monthKey: getMonthKeyFromDateKey(mealDate),
      days: selectedEmployeeMonthRecords.length,
      totalMealAmount,
      totalSubsidy,
      totalEmployeePay,
      isPaid: Boolean(paidRecord?.paid),
    };
  }, [selectedEmployeeMonthRecords, selectedEmployeePaymentKey, paymentRecords, mealDate]);

  const filteredMonthlySummary = useMemo(() => {
    const map = {};
    adminMonthRecords.forEach((item) => {
      const key = item.empId || item.name || "UNKNOWN";
      if (!map[key]) {
        map[key] = {
          empId: key,
          name: item.name || "",
          store: item.store || "",
          days: 0,
          totalMealAmount: 0,
          totalSubsidy: 0,
          totalOverAmount: 0,
          totalEmployeePay: 0,
        };
      }

      map[key].days += 1;
      map[key].totalMealAmount += Number(item.mealAmount) || 0;
      map[key].totalSubsidy += Number(item.subsidyAmount) || 0;
      map[key].totalOverAmount += Number(item.overAmount) || 0;
      map[key].totalEmployeePay += Number(item.employeePay) || 0;
    });

    return Object.values(map).sort((a, b) => b.totalEmployeePay - a.totalEmployeePay);
  }, [adminMonthRecords]);

  const filteredMonthlySummaryWithPaid = useMemo(() => {
    return filteredMonthlySummary.map((item) => {
      const key = `${selectedMonth}_${item.empId}`;
      const payment = paymentRecords[key] || {};
      return { ...item, paid: Boolean(payment.paid), paidAmount: payment.amount || 0 };
    });
  }, [filteredMonthlySummary, paymentRecords, selectedMonth]);

  const storeSettlementSummary = useMemo(() => {
    const map = {};
    adminMonthRecords.forEach((item) => {
      const store = item.store || "未填店名";
      if (!map[store]) {
        map[store] = { store, days: 0, totalMealAmount: 0, totalSubsidy: 0, totalEmployeePay: 0 };
      }
      map[store].days += 1;
      map[store].totalMealAmount += Number(item.mealAmount) || 0;
      map[store].totalSubsidy += Number(item.subsidyAmount) || 0;
      map[store].totalEmployeePay += Number(item.employeePay) || 0;
    });
    return Object.values(map).sort((a, b) => b.totalEmployeePay - a.totalEmployeePay);
  }, [adminMonthRecords]);

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

  const downloadCsv = (filename, header, rows) => {
    const csv = [header, ...rows]
      .map((row) => row.map((cell) => `"${String(cell ?? "").replace(/"/g, '""')}"`).join(","))
      .join("\\n");

    const blob = new Blob(["\\uFEFF" + csv], {
      type: "text/csv;charset=utf-8;",
    });

    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const exportMonthlyCsv = () => {
    if (!adminMonthRecords.length) {
      alert(`${selectedMonth} 沒有資料可匯出`);
      return;
    }

    const header = ["月份", "日期", "店別", "員工", "工號", "身分", "上班", "下班", "工時", "休息", "吃的金額", "原本可補貼", "實際補貼", "超出金額", "員工自付", "審核狀態", "備註"];
    const rows = adminMonthRecords.map((item) => [
      selectedMonth,
      item.dateKey || "",
      item.store || "",
      item.name || "",
      item.empId || "",
      item.role || "",
      formatTime(item.workInAt),
      formatTime(item.workOutAt),
      item.workHours || 0,
      item.breakHours || 0,
      item.mealAmount || 0,
      item.calculatedSubsidyAmount ?? item.subsidyAmount ?? 0,
      item.subsidyAmount || 0,
      item.overAmount || 0,
      item.employeePay || 0,
      item.approvalRequired ? (APPROVAL_STATUS_TEXT[item.approvalStatus || "pending"] || item.approvalStatus || "") : "不需審核",
      item.note || "",
    ]);

    const storeText = adminStoreFilter === "全部" ? "全部店別" : adminStoreFilter;
    downloadCsv(`員工餐向員工收費月結-${selectedMonth}-${storeText}.csv`, header, rows);
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
    const approvalStore = matchedEmployee.approvalStore || matchedEmployee.store || "";
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

      rule: "未滿4小時0元；滿4小時未滿6小時60元；滿6小時以上100元；超出補貼部分打9折；需審核員工須店長通過後才計入補助",
      createdAt: existingMealRecord?.createdAt || now,
      updatedAt: now,
    });

    setMessage(approvalRequired
      ? `已儲存：${matchedEmployee.name}｜此員工需 ${approvalStore} 店長審核，通過後才會給補貼 ${mealCalc.calculatedSubsidy} 元｜目前員工自付 ${mealCalc.employeePay} 元`
      : `已儲存：${matchedEmployee.name}｜工時 ${formatHours(workInfo.workHours)} 小時｜補貼 ${mealCalc.subsidy} 元｜員工自付 ${mealCalc.employeePay} 元`
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
    await update(ref(db, `employees/${employee.id}`), {
      [field]: value,
    });
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

  if (!authReady) {
    return (
      <div style={styles.loadingPage}>
        <div style={styles.loadingCard}>
          <div style={styles.loadingTitle}>員工餐系統</div>
          <div style={styles.loadingText}>系統連線中…</div>
          {authError ? <div style={styles.errorText}>{authError}</div> : null}
          {authError ? (
            <button style={styles.retryBtn} onClick={() => window.location.reload()}>
              重新整理
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div style={styles.page}>
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

      <div style={styles.appShell}>
        <header style={styles.topHeader}>
          <div style={styles.headerLeft}>
            <div style={styles.appIcon}>🍴</div>
            <div>
              <div style={styles.appTitle}>員工餐記錄系統</div>
              <div style={styles.appSubTitle}>Staff Meal Record</div>
            </div>
          </div>

          <div style={styles.headerRight}>
            <input
              type="date"
              style={styles.headerDateInput}
              value={mealDate}
              onChange={(e) => setMealDate(e.target.value)}
            />

            {isAdmin ? (
              <button style={styles.adminBlueBtn} onClick={logout}>離開管理模式</button>
            ) : (
              <>
                <input
                  style={styles.passwordInput}
                  type="password"
                  placeholder="管理密碼"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") login();
                  }}
                />
                <button style={styles.adminBlueBtn} onClick={login}>管理模式</button>
              </>
            )}

            {isManager ? (
              <button style={styles.managerLogoutBtn} onClick={managerLogout}>{managerStore}店長登出</button>
            ) : (
              <>
                <select
                  style={styles.managerStoreSelect}
                  value={managerLoginStore}
                  onChange={(e) => setManagerLoginStore(e.target.value)}
                >
                  <option value="西螺">西螺店長</option>
                  <option value="斗南">斗南店長</option>
                </select>
                <input
                  style={styles.passwordInput}
                  type="password"
                  placeholder="店長密碼"
                  value={managerPassword}
                  onChange={(e) => setManagerPassword(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") managerLogin();
                  }}
                />
                <button style={styles.managerBtn} onClick={managerLogin}>店長審核</button>
              </>
            )}
          </div>
        </header>

        <main style={styles.contentArea}>
          <section style={styles.employeeHero}>
            <div style={styles.employeeBlock}>
              <div style={styles.avatarCircle}>👤</div>
              <div>
                <div style={styles.label}>員工工號</div>
                <input
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

          <section style={styles.overviewCard}>
            <div style={styles.metricGrid}>
              <MetricBox icon="🕘" title="今日工時" value={`${formatHours(workInfo.workHours)} hr`} sub={`${formatTime(workInfo.workInAt)} - ${formatTime(workInfo.workOutAt)}｜休息 ${formatHours(workInfo.breakHours)}hr`} color="#2563eb" />
              <MetricBox icon="💵" title="今日補貼" value={`${mealCalc.subsidy} 元`} sub={mealCalc.needApproval ? `需店長審核，通過後補貼 ${mealCalc.calculatedSubsidy} 元` : workInfo.workHours >= 6 ? "滿 6 小時以上" : workInfo.workHours >= 4 ? "滿 4 未滿 6 小時" : "未達補貼標準"} color="#16a34a" />
              <MetricBox icon="🍽️" title="今日餐費" value={`${mealCalc.actualMealAmount} 元`} sub="員工實際用餐金額" color="#ea580c" />
              <MetricBox icon="👛" title="今日自付金額" value={`${mealCalc.employeePay} 元`} sub="超出補貼金額 × 0.9" color="#dc2626" />
            </div>
          </section>

          {matchedEmployee ? (
            <section style={styles.employeeMonthCard}>
              <div style={styles.cardTitleRow}>
                <div>
                  <div style={styles.cardTitle}>員工個人月結</div>
                  <div style={styles.cardSubTitle}>{employeeMonthSummary.monthKey}｜{matchedEmployee.name} 的個人員工餐紀錄</div>
                </div>
                <div style={employeeMonthSummary.isPaid ? styles.paidBadge : styles.unpaidBadge}>
                  {employeeMonthSummary.isPaid ? "已收款" : "未收款"}
                </div>
              </div>

              <div style={styles.personalSummaryGrid}>
                <MetricSmall title="本月用餐天數" value={`${employeeMonthSummary.days} 天`} />
                <MetricSmall title="本月已吃多少" value={`${employeeMonthSummary.totalMealAmount} 元`} />
                <MetricSmall title="公司補貼" value={`${employeeMonthSummary.totalSubsidy} 元`} />
                <MetricSmall title="本月應繳多少" value={`${employeeMonthSummary.isPaid ? 0 : employeeMonthSummary.totalEmployeePay} 元`} danger />
              </div>

            </section>
          ) : null}

          <section style={styles.entryCard}>
            <div style={styles.cardTitleRow}>
              <div>
                <div style={styles.cardTitle}>今日實際用餐金額</div>
                <div style={styles.cardSubTitle}>系統會自動讀取打卡紀錄與工時</div>
              </div>
              <div style={styles.subsidyBadge}>補貼標準：{mealCalc.subsidy} 元</div>
            </div>

            <div style={styles.entryRow}>
              <input
                style={styles.mealInput}
                type="number"
                inputMode="decimal"
                value={mealAmount}
                onChange={(e) => setMealAmount(e.target.value)}
                placeholder="請輸入金額，例如 150"
              />
              <div style={styles.currencyText}>元</div>
              <button style={styles.saveButton} onClick={submitMeal}>💾 儲存今日餐費</button>
            </div>

            <div style={styles.formulaBox}>
              <b>計算方式：</b>實際餐費 - 補貼金額 = 超出金額 → 超出金額 × 0.9 = 自付金額
              <span>　範例：150 - 100 = 50 → 50 × 0.9 = 45元</span>
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

          <section style={styles.recordsCard}>
            <div style={styles.cardTitleRow}>
              <div>
                <div style={styles.cardTitle}>本月餐費紀錄</div>
                <div style={styles.cardSubTitle}>最多顯示最近 10 筆</div>
              </div>
              {isAdmin ? (
                <button style={styles.outlineBtn} onClick={exportMonthlyCsv}>📊 匯出 CSV</button>
              ) : null}
            </div>

            {todayMealList.length === 0 ? (
              <div style={styles.emptyText}>目前尚無員工餐紀錄</div>
            ) : (
              <div style={styles.tableWrap}>
                <table style={styles.cleanTable}>
                  <thead>
                    <tr>
                      <th>日期</th>
                      <th>員工</th>
                      <th>工時</th>
                      <th>補貼</th>
                      <th>餐費</th>
                      <th>自付金額</th>
                      <th>狀態</th>
                      {isAdmin ? <th>操作</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {todayMealList.map((item) => (
                      <tr key={`${item.dateKey}_${item.empId}`}>
                        <td>{item.dateKey}</td>
                        <td>{item.name}<br /><span>{item.store || "未填店名"}</span></td>
                        <td style={styles.blueText}>{item.workHours || 0} hr</td>
                        <td style={styles.greenText}>{item.subsidyAmount || 0} 元</td>
                        <td style={styles.orangeText}>{item.mealAmount || 0} 元</td>
                        <td style={styles.redText}>{item.employeePay || 0} 元</td>
                        <td><span style={(item.approvalStatus || "approved") === "pending" ? styles.pendingPill : (item.approvalStatus || "approved") === "rejected" ? styles.rejectedPill : styles.savedPill}>{item.approvalRequired ? (APPROVAL_STATUS_TEXT[item.approvalStatus || "pending"] || "待店長審核") : "已儲存"}</span></td>
                        {isAdmin ? (
                          <td>
                            <button style={styles.tableEditBtn} onClick={() => openEditMeal(item)}>修改</button>
                            <button style={styles.tableDeleteBtn} onClick={() => deleteMealRecord(item)}>刪除</button>
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {isManager ? (
            <section style={styles.recordsCard}>
              <div style={styles.cardTitleRow}>
                <div>
                  <div style={styles.cardTitle}>{managerStore}店長審核</div>
                  <div style={styles.cardSubTitle}>只顯示需要 {managerStore} 店長通過的員工餐資料</div>
                </div>
              </div>

              {managerPendingRecords.length === 0 ? (
                <div style={styles.emptyText}>目前沒有待審核資料</div>
              ) : (
                <div style={styles.tableWrap}>
                  <table style={styles.cleanTable}>
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

          <section style={styles.settleNote}>
            <div style={styles.noteIcon}>🪙</div>
            <div>
              <div style={styles.noteTitle}>月底結算說明</div>
              <div style={styles.noteText}>每月 1 號～月底為一個結算週期，月底會另行通知金額，請準備現金繳交。</div>
            </div>
          </section>

          {isAdmin ? (
            <>
              <section style={styles.recordsCard}>
                <div style={styles.cardTitleRow}>
                  <div>
                    <div style={styles.cardTitle}>員工餐審核設定</div>
                    <div style={styles.cardSubTitle}>漏 key 過的員工可改成需店長審核，之後補助須通過才會計入</div>
                  </div>
                </div>

                {employees.length === 0 ? (
                  <div style={styles.emptyText}>目前沒有員工資料</div>
                ) : (
                  <div style={styles.tableWrap}>
                    <table style={styles.cleanTable}>
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
                                value={emp.approvalStore || emp.store || "西螺"}
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
              </section>

              <section style={styles.adminCard}>
                <div style={styles.cardTitleRow}>
                  <div>
                    <div style={styles.cardTitle}>管理模式 Dashboard</div>
                    <div style={styles.cardSubTitle}>用於月底向員工收費統計</div>
                  </div>
                  <div style={styles.adminControlBar}>
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
                  </div>
                </div>

                <div style={styles.dashboardGrid}>
                  <DashBox title="今日登記" value={`${adminDashboard.todayCount} 筆`} sub={`餐費 ${adminDashboard.todayMealAmount}｜補貼 ${adminDashboard.todaySubsidy}`} />
                  <DashBox title="今日員工自付" value={`${adminDashboard.todayEmployeePay} 元`} sub={adminDashboard.todayTop ? `吃最多：${adminDashboard.todayTop.name} ${adminDashboard.todayTop.mealAmount}元` : "尚無紀錄"} />
                  <DashBox title="本月餐費" value={`${adminDashboard.monthMealAmount} 元`} sub={`共 ${adminDashboard.monthCount} 筆｜補貼 ${adminDashboard.monthSubsidy}`} />
                  <DashBox title="本月應收費" value={`${adminDashboard.monthEmployeePay} 元`} sub={adminDashboard.monthTop ? `應收最多：${adminDashboard.monthTop.name} ${adminDashboard.monthTop.employeePay}元` : "尚無紀錄"} highlight />
                </div>
              </section>

              <section style={styles.recordsCard}>
                <div style={styles.cardTitleRow}>
                  <div>
                    <div style={styles.cardTitle}>店別分帳</div>
                    <div style={styles.cardSubTitle}>{selectedMonth}｜各店員工餐補貼與應收款</div>
                  </div>
                </div>

                {storeSettlementSummary.length === 0 ? (
                  <div style={styles.emptyText}>目前尚無店別分帳資料</div>
                ) : (
                  <div style={styles.personalSummaryGrid}>
                    {storeSettlementSummary.map((store) => (
                      <div key={store.store} style={styles.storeSplitCard}>
                        <div style={styles.storeName}>{store.store}</div>
                        <div style={styles.storeLine}>用餐筆數：{store.days}</div>
                        <div style={styles.storeLine}>餐費總額：{store.totalMealAmount} 元</div>
                        <div style={styles.storeLine}>公司補貼：{store.totalSubsidy} 元</div>
                        <div style={styles.storePay}>應向員工收：{store.totalEmployeePay} 元</div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section style={styles.recordsCard}>
                <div style={styles.cardTitleRow}>
                  <div>
                    <div style={styles.cardTitle}>月底結算</div>
                    <div style={styles.cardSubTitle}>{selectedMonth}｜{adminStoreFilter}｜用於月底向員工收費統計</div>
                  </div>
                </div>

                {filteredMonthlySummary.length === 0 ? (
                  <div style={styles.emptyText}>{selectedMonth} 尚無結算資料</div>
                ) : (
                  <div style={styles.tableWrap}>
                    <table style={styles.cleanTable}>
                      <thead>
                        <tr>
                          <th>員工</th>
                          <th>店別</th>
                          <th>天數</th>
                          <th>吃的金額</th>
                          <th>公司補貼</th>
                          <th>超出金額</th>
                          <th>員工自付</th>
                          <th>審核</th>
                          <th>收款狀態</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredMonthlySummaryWithPaid.map((item) => (
                          <tr key={item.empId}>
                            <td>{item.name}<br /><span>{item.empId}</span></td>
                            <td>{item.store}</td>
                            <td>{item.days}</td>
                            <td>{item.totalMealAmount}</td>
                            <td>{item.totalSubsidy}</td>
                            <td>{item.totalOverAmount}</td>
                            <td style={styles.redText}><b>{item.paid ? 0 : item.totalEmployeePay}</b></td>
                            <td>—</td>
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

function InfoBox({ title, value, highlight = false }) {
  return (
    <div style={highlight ? styles.infoBoxHighlight : styles.infoBox}>
      <div style={styles.infoTitle}>{title}</div>
      <div style={styles.infoValue}>{value}</div>
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


if (window.innerWidth <= 900) {
  styles.topHeader.flexDirection = "column";
  styles.topHeader.alignItems = "stretch";
  styles.headerRight.justifyContent = "stretch";
  styles.headerDateInput.width = "100%";
  styles.passwordInput.width = "100%";
  styles.adminBlueBtn.width = "100%";
  styles.managerBtn.width = "100%";
  styles.managerLogoutBtn.width = "100%";
  styles.managerStoreSelect.width = "100%";
  styles.employeeHero.flexDirection = "column";
  styles.employeeHero.alignItems = "stretch";
  styles.metricGrid.gridTemplateColumns = "1fr 1fr";
  styles.entryRow.gridTemplateColumns = "1fr";
  styles.currencyText.display = "none";
  styles.dashboardGrid.gridTemplateColumns = "1fr";
  styles.personalSummaryGrid.gridTemplateColumns = "1fr";
  styles.adminControlBar.flexDirection = "column";
  styles.adminSelect.width = "100%";
  styles.monthInput.width = "100%";
}

if (window.innerWidth >= 768 && window.innerWidth <= 1180) {
  styles.metricGrid.gridTemplateColumns = "repeat(4, minmax(0, 1fr))";
  styles.dashboardGrid.gridTemplateColumns = "repeat(4, minmax(0, 1fr))";
}
