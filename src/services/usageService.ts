const DAILY_LIMIT = 100;

export async function checkAndIncrementUsage(): Promise<{ allowed: boolean; remaining: number }> {
  try {
    const today = new Date().toISOString().split('T')[0];

    let visitorId = localStorage.getItem('george_visitor_id');
    if (!visitorId) {
      visitorId = Math.random().toString(36).substring(2, 15);
      localStorage.setItem('george_visitor_id', visitorId);
    }

    const key = `usage_${today}_${visitorId}`;
    const count = parseInt(localStorage.getItem(key) || '0', 10);

    if (count >= DAILY_LIMIT) {
      return { allowed: false, remaining: 0 };
    }

    localStorage.setItem(key, String(count + 1));
    return { allowed: true, remaining: DAILY_LIMIT - (count + 1) };
  } catch {
    return { allowed: true, remaining: DAILY_LIMIT };
  }
}
