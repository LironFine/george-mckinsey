const DAILY_LIMIT = 100;
const MONTHLY_VOICE_LIMIT = 30;

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

export async function checkAndIncrementVoiceUsage(): Promise<{
  allowed: boolean;
  remaining: number;
  resetDays: number;
}> {
  try {
    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    let visitorId = localStorage.getItem('george_visitor_id');
    if (!visitorId) {
      visitorId = Math.random().toString(36).substring(2, 15);
      localStorage.setItem('george_visitor_id', visitorId);
    }

    const key = `voice_usage_${month}_${visitorId}`;
    const count = parseInt(localStorage.getItem(key) || '0', 10);

    const firstOfNextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const msPerDay = 24 * 60 * 60 * 1000;
    const resetDays = Math.ceil((firstOfNextMonth.getTime() - now.getTime()) / msPerDay);

    if (count >= MONTHLY_VOICE_LIMIT) {
      return { allowed: false, remaining: 0, resetDays };
    }

    localStorage.setItem(key, String(count + 1));
    return { allowed: true, remaining: MONTHLY_VOICE_LIMIT - (count + 1), resetDays };
  } catch {
    return { allowed: true, remaining: MONTHLY_VOICE_LIMIT, resetDays: 30 };
  }
}
