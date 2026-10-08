const DATABASE = 'https://work-checkin-77acf-default-rtdb.asia-southeast1.firebasedatabase.app';
// Public Firebase configuration, not a server credential. Existing permissions are unchanged.
const API_KEY = 'AIzaSyCQy8KiTnE9aN0ofMDIlUU5SEmKbBLJAZs';
let credential;
async function sourceToken() {
  if (!credential || credential.expiresAt < Date.now() + 60000) {
    const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${API_KEY}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ returnSecureToken: true }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error('SOURCE_AUTH_UNAVAILABLE');
    const data = await response.json();
    if (!data.idToken) throw new Error('SOURCE_AUTH_UNAVAILABLE');
    credential = { token: data.idToken, expiresAt: Date.now() + Number(data.expiresIn) * 1000 };
  }
  return credential.token;
}
export async function readSource(monthKey = '') {
  const token = await sourceToken();
  const paths = { employees: 'employees', records: 'records', meal_records: 'meal_records',
    snapshots: monthKey ? `monthly_attendance_snapshots/${monthKey}/days` : 'monthly_attendance_snapshots',
    adjustments: monthKey ? `meal_subsidy_adjustments/${monthKey}` : 'meal_subsidy_adjustments' };
  return Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([key, path]) => {
    const response = await fetch(`${DATABASE}/${path}.json?auth=${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('SOURCE_READ_UNAVAILABLE');
    return [key, await response.json() || {}];
  })));
}
