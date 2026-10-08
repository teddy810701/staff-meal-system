import { buildMonthRecords, summarizeMonthlyRows, attachMonthlyPayment } from '../src/monthSettlement.js';

const empKey = value => String(value || '').trim().toUpperCase();

// No second calculator: both the staff-meal screen and this API call the same ledger.
export function sourceSettlements(data, { empIds, monthKey = '', cutoffDate = '' }) {
  const employees = Object.entries(data.employees || {}).map(([id, value]) => ({ id, ...value }));
  const records = Object.values(data.records || {});
  const meals = data.meal_records || {};
  const snapshots = monthKey ? { [monthKey]: { days: data.snapshots || {} } } : data.snapshots || {};
  const adjustments = monthKey ? { [monthKey]: data.adjustments || {} } : data.adjustments || {};
  const knownIds = new Set([
    ...employees.map(e => empKey(e.empId || e.id)),
    ...records.map(e => empKey(e?.empId)),
    ...Object.values(meals).map(e => empKey(e?.empId)),
    ...Object.values(snapshots).flatMap(root => Object.values(root?.days || {}).map(e => empKey(e?.empId))),
  ].filter(Boolean));
  if (empIds.some(id => !knownIds.has(empKey(id)))) throw new Error('EMPLOYEE_NOT_FOUND');
  const months = monthKey ? [monthKey] : [...new Set([
    ...Object.keys(snapshots),
    ...records.map(e => e?.dateKey || (e?.createdAt ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date(e.createdAt)) : '')).map(d => d.slice(0, 7)),
    ...Object.values(meals).map(e => String(e?.dateKey || '').slice(0, 7)),
  ])].filter(m => /^\d{4}-\d{2}$/.test(m) && (!cutoffDate || m <= cutoffDate.slice(0, 7))).sort();
  const ledgers = months.map(selectedMonth => {
    const rows = buildMonthRecords({ employees: employees.filter(e => !e.archived), records, mealRecords: meals,
      attendanceSnapshots: snapshots[selectedMonth]?.days || {}, subsidyAdjustments: adjustments, selectedMonth, cutoffDate });
    const summaries = summarizeMonthlyRows(rows).map(s => attachMonthlyPayment(s, selectedMonth, meals.payments));
    return { selectedMonth, rows, summaries };
  });
  return { source: 'staff-meal-system', schemaVersion: 1, generatedAt: new Date().toISOString(), employees: empIds.map(id => ({
    empId: empKey(id),
    months: ledgers.map(({ selectedMonth, rows, summaries }) => {
      const ownRows = rows.filter(r => empKey(r.empId) === empKey(id));
      const summary = summaries.find(s => empKey(s.empId) === empKey(id)) || attachMonthlyPayment({
        empId: id, days: 0, mealDays: 0, totalMealAmount: 0, totalEarnedSubsidy: 0, totalUsedSubsidy: 0,
        totalSubsidy: 0, totalOverAmount: 0, totalEmployeePay: 0, endingBalance: 0, pendingCount: 0,
      }, selectedMonth, meals.payments);
      return { summary, rows: ownRows };
    }),
  })) };
}
