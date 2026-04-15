const DAILY_LIMIT = 100;
const MONTHLY_VOICE_MINUTES_LIMIT = 90; // ~8 NIS worth of Gemini Live API

// ── Text chat usage ──────────────────────────────────────────────────────────

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

// ── Voice usage — tracked in minutes, not sessions ──────────────────────────

function getVisitorId(): string {
  let visitorId = localStorage.getItem('george_visitor_id');
  if (!visitorId) {
    visitorId = Math.random().toString(36).substring(2, 15);
    localStorage.setItem('george_visitor_id', visitorId);
  }
  return visitorId;
}

function getMonthKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function getDaysUntilReset(): number {
  const now = new Date();
  const firstOfNextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return Math.ceil((firstOfNextMonth.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
}

/** Check if the user has remaining voice minutes before starting a session. */
export async function checkVoiceMinutesAvailable(): Promise<{
  allowed: boolean;
  remainingMinutes: number;
  resetDays: number;
}> {
  try {
    const key = `voice_minutes_${getMonthKey()}_${getVisitorId()}`;
    const usedMinutes = parseFloat(localStorage.getItem(key) || '0');
    const remainingMinutes = Math.max(0, MONTHLY_VOICE_MINUTES_LIMIT - usedMinutes);
    const resetDays = getDaysUntilReset();

    if (remainingMinutes <= 0) {
      return { allowed: false, remainingMinutes: 0, resetDays };
    }

    return { allowed: true, remainingMinutes: Math.floor(remainingMinutes), resetDays };
  } catch {
    return { allowed: true, remainingMinutes: MONTHLY_VOICE_MINUTES_LIMIT, resetDays: 30 };
  }
}

/** Call when a voice session ends — adds the actual duration to the monthly counter. */
export async function recordVoiceUsage(startTime: number): Promise<void> {
  try {
    const elapsedMs = Date.now() - startTime;
    const elapsedMinutes = elapsedMs / 60000;

    // Ignore extremely short sessions (under 5 seconds) — likely errors or accidental taps
    if (elapsedMinutes < 5 / 60) return;

    const key = `voice_minutes_${getMonthKey()}_${getVisitorId()}`;
    const usedMinutes = parseFloat(localStorage.getItem(key) || '0');
    localStorage.setItem(key, String(usedMinutes + elapsedMinutes));
  } catch {
    // Fail silently — don't block the user
  }
}

/** @deprecated Use checkVoiceMinutesAvailable instead */
export async function checkAndIncrementVoiceUsage(): Promise<{
  allowed: boolean;
  remaining: number;
  resetDays: number;
}> {
  const result = await checkVoiceMinutesAvailable();
  return { allowed: result.allowed, remaining: result.remainingMinutes, resetDays: result.resetDays };
}
