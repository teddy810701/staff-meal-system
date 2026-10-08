import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { buildMonthRecords, summarizeMonthlyRows } from '../src/monthSettlement.js';
import { sourceSettlements } from '../server/settlement-source.js';
import { validSignature, validInput, POST } from '../api/settlements.mjs';

test('September regression: five summaries use the staff-meal ledger without changing records', () => {
  const examples = [ ['0326',22,22,2435,2200,212], ['0531',12,12,1200,1200,0],
    ['0819',18,17,2105,1500,545], ['1120',25,23,2345,2300,41], ['0213',20,20,1685,1620,59] ];
  const data = { employees: {}, records: {}, meal_records: {}, snapshots: {}, adjustments: {} };
  for (const [id,days,mealDays,total,subsidy] of examples) {
    data.employees[id] = { empId:id, name:id, store:'西螺' };
    let remaining = subsidy;
    for (let i=0;i<days;i++) {
      const dateKey = `2026-09-${String(i+1).padStart(2,'0')}`;
      const earned = Math.min(100, remaining); remaining -= earned;
      data.snapshots[`${id}_${dateKey}`] = { empId:id,dateKey,recordCount:2,canCalculate:true,workHours:6,subsidyAmount:earned };
      if (i < mealDays) data.meal_records[`${dateKey}_${id}`] = { empId:id,dateKey,mealAmount:i===mealDays-1 ? total - Math.floor(total/mealDays)*(mealDays-1) : Math.floor(total/mealDays) };
    }
  }
  const before = JSON.stringify(data);
  const result = sourceSettlements(data,{ empIds:examples.map(e=>e[0]),monthKey:'2026-09' });
  assert.deepEqual(result.employees.map(e=>e.months[0].summary.amountDue),examples.map(e=>e[5]));
  assert.equal(JSON.stringify(data),before);
  for (const employee of result.employees) assert.ok(employee.months[0].rows.every(r=>r.empId===employee.empId));
});

test('paid state, missing employees, duplicate daily records, and cutoff follow source semantics', () => {
  const data={ employees:{'0123':{empId:'0123'}},records:{},adjustments:{},snapshots:{},meal_records:{
    first:{empId:'0123',dateKey:'2026-09-01',mealAmount:99,baseSubsidyAmount:0},
    last:{empId:'0123',dateKey:'2026-09-01',mealAmount:200,baseSubsidyAmount:100},
    future:{empId:'0123',dateKey:'2026-09-02',mealAmount:300,baseSubsidyAmount:100},
    payments:{'2026-09_0123':{paid:true,amount:270,paidAt:123}},
  }};
  const one=sourceSettlements(data,{empIds:['0123'],monthKey:'2026-09',cutoffDate:'2026-09-01'}).employees[0].months[0];
  assert.equal(one.rows.length,1); assert.equal(one.summary.totalMealAmount,200);
  assert.equal(one.summary.totalEmployeePay,90); assert.equal(one.summary.amountDue,0); assert.equal(one.summary.paid,true);
  assert.throws(()=>sourceSettlements(data,{empIds:['9999'],monthKey:'2026-09'}),/EMPLOYEE_NOT_FOUND/);
  assert.equal(sourceSettlements({...data,meal_records:{}},{empIds:['0123'],monthKey:'2026-10'}).employees[0].months[0].summary.amountDue,0);
});

test('complete punches precede stale saved values; multiplier is applied once and hours are not rounded', () => {
  const dateKey='2026-09-01',createdAt=1000;
  const rows=buildMonthRecords({selectedMonth:'2026-09', employees:[{empId:'0123'}],records:[
    {empId:'0123',dateKey,type:'上班',createdAt},
    {empId:'0123',dateKey,type:'下班',createdAt:createdAt+21585000},
  ],mealRecords:{one:{empId:'0123',dateKey,mealAmount:100,baseSubsidyAmount:100}},subsidyAdjustments:{'2026-09':{'0123':{multiplier:0.5}}}});
  assert.equal(rows[0].earnedSubsidyAmount,30); assert.equal(summarizeMonthlyRows(rows)[0].totalEmployeePay,63);
});

test('pending and rejected meals follow source approval behavior', () => {
  for (const approvalStatus of ['pending','rejected']) {
    const rows=buildMonthRecords({selectedMonth:'2026-09',mealRecords:{one:{empId:'0123',dateKey:'2026-09-01',mealAmount:100,baseSubsidyAmount:100,approvalRequired:true,approvalStatus}}});
    assert.equal(rows[0].earnedSubsidyAmount,0); assert.equal(rows[0].subsidyAmount,0);
    assert.equal(summarizeMonthlyRows(rows)[0].totalEmployeePay,90);
  }
});

test('source endpoint denies unsigned, expired or altered requests before reading data', async () => {
  const body=JSON.stringify({empIds:['0123'],monthKey:'2026-09'}),time=String(Date.now()),secret='test-only';
  const sig=createHmac('sha256',secret).update(`${time}\n${body}`).digest('hex');
  assert.equal(validSignature(body,time,sig,secret),true);
  assert.equal(validSignature(body+' ',time,sig,secret),false);
  assert.equal(validSignature(body,time,sig,secret,Number(time)+60001),false);
  assert.equal(validInput({empIds:['0123'],monthKey:'2026-13'}),false);
  assert.equal(validInput({empIds:['../other'],monthKey:'2026-09'}),false);
  const response=await POST(new Request('https://test/api/settlements',{method:'POST',body}));
  assert.equal(response.status,401);assert.equal(response.headers.get('cache-control'),'no-store');
});
