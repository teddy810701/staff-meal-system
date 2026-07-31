const COLORS = {
  navy: "173653",
  lightBlue: "DBE8F5",
  paleBlue: "EFF6FF",
  yellow: "FFF2CC",
  white: "FFFFFF",
  border: "94A3B8",
  red: "B91C1C",
  green: "166534",
};

const thinBorder = {
  top: { style: "thin", color: { argb: COLORS.border } },
  left: { style: "thin", color: { argb: COLORS.border } },
  bottom: { style: "thin", color: { argb: COLORS.border } },
  right: { style: "thin", color: { argb: COLORS.border } },
};

const applyHeader = (row) => {
  row.height = 24;
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: COLORS.white } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.navy } };
    cell.alignment = { horizontal: "center", vertical: "middle" };
    cell.border = thinBorder;
  });
};

const applyTable = (sheet, startRow, endRow, startCol, endCol) => {
  for (let rowIndex = startRow; rowIndex <= endRow; rowIndex += 1) {
    for (let colIndex = startCol; colIndex <= endCol; colIndex += 1) {
      const cell = sheet.getCell(rowIndex, colIndex);
      cell.border = thinBorder;
      cell.alignment = { vertical: "middle", horizontal: colIndex <= 3 ? "left" : "right" };
      if (typeof cell.value === "number") cell.numFmt = "#,##0";
    }
  }
};

const downloadBuffer = (buffer, filename) => {
  const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
};

export async function exportMealWorkbook({ month, storeFilter, summaries, detailRows }) {
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "員工餐記錄系統";
  workbook.created = new Date();

  const storeText = storeFilter === "全部" ? "全部店別" : storeFilter;
  const summarySheet = workbook.addWorksheet("收款總表", { views: [{ showGridLines: false, state: "frozen", ySplit: 5 }] });
  summarySheet.mergeCells("A1:M1");
  summarySheet.getCell("A1").value = `${month} 員工餐收款總表｜${storeText}`;
  summarySheet.getCell("A1").font = { bold: true, size: 18, color: { argb: COLORS.white } };
  summarySheet.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.navy } };
  summarySheet.getCell("A1").alignment = { horizontal: "left", vertical: "middle" };
  summarySheet.getRow(1).height = 30;

  const totalDue = summaries.reduce((sum, item) => sum + (Number(item.totalEmployeePay) || 0), 0);
  const collected = summaries.filter((item) => item.paid).reduce((sum, item) => sum + (Number(item.totalEmployeePay) || 0), 0);
  summarySheet.addRow(["月份", month, "店別", storeText, "本月應收", totalDue, "已收款", collected, "尚待收款", totalDue - collected]);
  summarySheet.addRow(["結算說明", "整月餐費－整月補助，超額部分打九折；月底剩餘補助歸零。"]);
  summarySheet.mergeCells("B3:M3");
  summarySheet.getRow(3).height = 24;

  const summaryHeaders = ["店別", "員工", "工號", "上班天數", "用餐筆數", "餐費總額", "累積補助", "使用補助", "剩餘補助", "整月超額", "九折應繳", "收款狀態", "收款時間"];
  applyHeader(summarySheet.addRow(summaryHeaders));
  summaries.forEach((item) => {
    const row = summarySheet.addRow([
      item.store, item.name, item.empId, item.days, item.mealDays, item.totalMealAmount,
      item.totalEarnedSubsidy, item.totalUsedSubsidy, item.endingBalance, item.totalOverAmount,
      item.totalEmployeePay, item.paid ? "已收款" : "未收款",
      item.paidAt ? new Date(item.paidAt).toLocaleString("zh-TW", { hour12: false }) : "",
    ]);
    row.getCell(11).font = { bold: true, color: { argb: item.totalEmployeePay > 0 ? COLORS.red : COLORS.green } };
    row.getCell(12).font = { bold: true, color: { argb: item.paid ? COLORS.green : COLORS.red } };
  });
  applyTable(summarySheet, 5, summarySheet.rowCount, 1, 13);
  summarySheet.columns = [14, 13, 12, 11, 11, 12, 12, 12, 12, 12, 12, 12, 20].map((width) => ({ width }));
  summarySheet.autoFilter = { from: "A5", to: `M${summarySheet.rowCount}` };

  const detailSheet = workbook.addWorksheet("全月明細", { views: [{ showGridLines: false, state: "frozen", ySplit: 2 }] });
  detailSheet.mergeCells("A1:N1");
  detailSheet.getCell("A1").value = `${month} 全月逐日明細｜${storeText}`;
  detailSheet.getCell("A1").font = { bold: true, size: 17, color: { argb: COLORS.white } };
  detailSheet.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.navy } };
  const detailHeaders = ["日期", "店別", "員工", "工號", "工時", "休息", "餐費", "當日新增補助", "使用補助", "補助餘額", "月底超額", "九折應繳", "狀態", "備註"];
  applyHeader(detailSheet.addRow(detailHeaders));
  detailRows.forEach((item) => detailSheet.addRow([
    item.dateKey, item.store, item.name, item.empId, item.workHours, item.breakHours, item.mealAmount,
    item.earnedSubsidyAmount, item.usedSubsidyAmount, item.balanceAfter, item.overAmount, item.employeePay,
    item.status, item.note,
  ]));
  applyTable(detailSheet, 3, detailSheet.rowCount, 1, 14);
  detailSheet.columns = [13, 14, 13, 12, 9, 9, 11, 13, 11, 11, 11, 11, 13, 20].map((width) => ({ width }));
  detailSheet.autoFilter = { from: "A2", to: `N${detailSheet.rowCount}` };

  const personalSheet = workbook.addWorksheet("個人明細", { views: [{ showGridLines: false }] });
  personalSheet.columns = [13, 10, 13, 13, 13, 13, 13, 13, 15, 20].map((width) => ({ width }));
  let personalRow = 1;
  summaries.forEach((summary, index) => {
    if (index > 0) personalSheet.getRow(personalRow).addPageBreak();
    personalSheet.mergeCells(personalRow, 1, personalRow, 10);
    const title = personalSheet.getCell(personalRow, 1);
    title.value = `${summary.name}｜${month} 員工餐個人明細`;
    title.font = { bold: true, size: 16, color: { argb: COLORS.white } };
    title.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.navy } };
    personalRow += 1;
    personalSheet.addRow(["店別", summary.store, "工號", summary.empId, "餐費總額", summary.totalMealAmount, "累積補助", summary.totalEarnedSubsidy, "九折應繳", summary.totalEmployeePay]);
    personalRow += 1;
    applyHeader(personalSheet.addRow(["日期", "工時", "當日補助", "當日餐費", "累積補助", "累積餐費", "剩餘補助", "整月超額", "狀態", "備註"]));
    personalRow += 1;
    const employeeDetails = detailRows.filter((item) => String(item.empId).trim().toUpperCase() === String(summary.empId).trim().toUpperCase());
    let accumulatedMeal = 0;
    let accumulatedSubsidy = 0;
    employeeDetails.forEach((item) => {
      accumulatedMeal += Number(item.mealAmount) || 0;
      accumulatedSubsidy += Number(item.earnedSubsidyAmount) || 0;
      const used = Math.min(accumulatedMeal, accumulatedSubsidy);
      personalSheet.addRow([item.dateKey, item.workHours, item.earnedSubsidyAmount, item.mealAmount, accumulatedSubsidy, accumulatedMeal, Math.max(0, accumulatedSubsidy - accumulatedMeal), Math.max(0, accumulatedMeal - accumulatedSubsidy), item.status, item.note]);
      personalRow += 1;
      void used;
    });
    applyTable(personalSheet, personalRow - employeeDetails.length, personalRow - 1, 1, 10);
    const totalRow = personalSheet.addRow(["月底統一結算", "", summary.totalEarnedSubsidy, summary.totalMealAmount, "", "", summary.endingBalance, summary.totalOverAmount, `應繳 ${summary.totalEmployeePay} 元`, summary.paid ? "已收款" : "未收款"]);
    totalRow.eachCell((cell) => { cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.yellow } }; cell.font = { bold: true }; cell.border = thinBorder; });
    personalRow += 3;
  });
  personalSheet.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 };

  const receiptSheet = workbook.addWorksheet("個人收款單", { views: [{ showGridLines: false }] });
  receiptSheet.columns = [12, 15, 15, 12, 15, 15, 3, 12, 15, 15, 12, 15, 15].map((width) => ({ width }));
  const buildReceipt = (summary, startRow, startCol) => {
    const endCol = startCol + 5;
    receiptSheet.mergeCells(startRow, startCol, startRow, endCol);
    const title = receiptSheet.getCell(startRow, startCol);
    title.value = "員工餐月結收款單";
    title.font = { bold: true, size: 14, color: { argb: COLORS.white } };
    title.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.navy } };
    title.alignment = { horizontal: "center", vertical: "middle" };
    const pairs = [
      ["月份", month, "店別", summary.store],
      ["員工", summary.name, "工號", summary.empId],
      ["餐費總額", summary.totalMealAmount, "累積補助", summary.totalEarnedSubsidy],
      ["使用補助", summary.totalUsedSubsidy, "剩餘補助", summary.endingBalance],
      ["整月超額", summary.totalOverAmount, "九折應繳", summary.totalEmployeePay],
      ["收款狀態", summary.paid ? "已收款" : "未收款", "收款時間", summary.paidAt ? new Date(summary.paidAt).toLocaleString("zh-TW", { hour12: false }) : ""],
    ];
    pairs.forEach((values, offset) => {
      const row = startRow + offset + 1;
      receiptSheet.getCell(row, startCol).value = values[0];
      receiptSheet.mergeCells(row, startCol + 1, row, startCol + 2);
      receiptSheet.getCell(row, startCol + 1).value = values[1];
      receiptSheet.getCell(row, startCol + 3).value = values[2];
      receiptSheet.mergeCells(row, startCol + 4, row, startCol + 5);
      receiptSheet.getCell(row, startCol + 4).value = values[3];
      [startCol, startCol + 3].forEach((col) => {
        const label = receiptSheet.getCell(row, col);
        label.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.lightBlue } };
        label.font = { color: { argb: "334155" } };
      });
    });
    const signRow = startRow + 7;
    receiptSheet.mergeCells(signRow, startCol, signRow, endCol);
    receiptSheet.getCell(signRow, startCol).value = "員工簽收：____________________　日期：____________";
    receiptSheet.getCell(signRow, startCol).fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.yellow } };
    const noteRow = startRow + 8;
    receiptSheet.mergeCells(noteRow, startCol, noteRow, endCol);
    receiptSheet.getCell(noteRow, startCol).value = "說明：補助當月累計；整月超額差額打九折後收款，月底剩餘補助歸零。";
    receiptSheet.getCell(noteRow, startCol).alignment = { wrapText: true, vertical: "middle" };
    for (let row = startRow; row <= noteRow; row += 1) {
      for (let col = startCol; col <= endCol; col += 1) receiptSheet.getCell(row, col).border = thinBorder;
    }
    receiptSheet.getRow(noteRow).height = 30;
  };
  summaries.forEach((summary, index) => {
    const block = Math.floor(index / 2);
    const startRow = block * 11 + 1;
    const startCol = index % 2 === 0 ? 1 : 8;
    buildReceipt(summary, startRow, startCol);
    if (index > 0 && index % 8 === 0) receiptSheet.getRow(startRow).addPageBreak();
  });
  receiptSheet.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9, margins: { left: 0.25, right: 0.25, top: 0.3, bottom: 0.3, header: 0, footer: 0 } };

  const buffer = await workbook.xlsx.writeBuffer();
  downloadBuffer(buffer, `員工餐收款核對簿-${month}-${storeText}.xlsx`);
}
