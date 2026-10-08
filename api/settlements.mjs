import { createHmac, timingSafeEqual } from 'node:crypto';
import { readSource } from '../server/read-source.js';
import { sourceSettlements } from '../server/settlement-source.js';

const headers = { 'cache-control': 'no-store' };
export function validSignature(body, timestamp, signature, secret, now = Date.now()) {
  if (!secret || !/^\d{13}$/.test(timestamp || '') || Math.abs(now - Number(timestamp)) > 60000 || !/^[a-f0-9]{64}$/.test(signature || '')) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}\n${body}`).digest();
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}
export function validInput(input) {
  const month = input?.monthKey || '';
  const cutoff = input?.cutoffDate || '';
  return input && Array.isArray(input.empIds) && input.empIds.length > 0 && input.empIds.length <= 100
    && input.empIds.every(id => typeof id === 'string' && /^[a-zA-Z0-9-]{1,64}$/.test(id))
    && (!month || /^\d{4}-(0[1-9]|1[0-2])$/.test(month))
    && (!cutoff || /^\d{4}-(0[1-9]|1[0-2])-\d{2}$/.test(cutoff)) && (month || cutoff);
}
export async function POST(request) {
  const body = await request.text();
  if (body.length > 16384) return Response.json({ error: 'INVALID_REQUEST' }, { status: 400, headers });
  if (!validSignature(body, request.headers.get('x-meal-time'), request.headers.get('x-meal-signature'), process.env.STAFF_MEAL_SOURCE_SECRET)) {
    return Response.json({ error: 'UNAUTHORIZED' }, { status: 401, headers });
  }
  let input;
  try { input = JSON.parse(body); } catch { return Response.json({ error: 'INVALID_REQUEST' }, { status: 400, headers }); }
  if (!validInput(input)) return Response.json({ error: 'INVALID_REQUEST' }, { status: 400, headers });
  try {
    const result = sourceSettlements(await readSource(input.monthKey), input);
    return Response.json(result, { headers });
  } catch (error) {
    const missing = error.message === 'EMPLOYEE_NOT_FOUND';
    console.error('Staff-meal source unavailable:', missing ? 'employee-not-found' : 'source-read-failed');
    return Response.json({ error: missing ? 'EMPLOYEE_NOT_FOUND' : 'SOURCE_UNAVAILABLE' }, { status: missing ? 404 : 503, headers });
  }
}
