import { doc, getDoc, setDoc, updateDoc, increment } from 'firebase/firestore';
import { db } from '../lib/firebase';

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

/**
 * Call this when a Firebase user signs in so usage limits are tied to
 * their Google account (survives browser-cache clears).
 */
export function setVisitorId(uid: string): void {
  localStorage.setItem('george_visitor_id', uid);
}

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

// ── Demo usage (Firestore — lifetime per user) ──────────────────────

const DEMO_TEXT_LIMIT = 20;
const DEMO_VOICE_LIMIT = 2;

interface DemoUsage {
  textCount: number;
  voiceCount: number;
}

async function getDemoUsage(uid: string): Promise<DemoUsage> {
  if (!db || !uid) return { textCount: 0, voiceCount: 0 };
  try {
    const ref = doc(db, 'demo_usage', uid);
    const snap = await getDoc(ref);
    if (!snap.exists()) return { textCount: 0, voiceCount: 0 };
    const data = snap.data();
    return { textCount: data.textCount || 0, voiceCount: data.voiceCount || 0 };
  } catch (err) {
    console.error('[Demo] Failed to get usage:', err);
    return { textCount: 0, voiceCount: 0 };
  }
}

async function saveDemoUsage(uid: string, usage: DemoUsage): Promise<void> {
  if (!db || !uid) return;
  try {
    const ref = doc(db, 'demo_usage', uid);
    await setDoc(ref, usage, { merge: true });
  } catch (err) {
    console.error('[Demo] Failed to save usage:', err);
  }
}

export async function incrementDemoTextUsage(uid: string): Promise<{ allowed: boolean; remaining: number }> {
  const usage = await getDemoUsage(uid);
  if (usage.textCount >= DEMO_TEXT_LIMIT) return { allowed: false, remaining: 0 };
  usage.textCount += 1;
  await saveDemoUsage(uid, usage);
  return { allowed: true, remaining: DEMO_TEXT_LIMIT - usage.textCount };
}

export async function incrementDemoVoiceUsage(uid: string): Promise<{ allowed: boolean; remaining: number }> {
  const usage = await getDemoUsage(uid);
  if (usage.voiceCount >= DEMO_VOICE_LIMIT) return { allowed: false, remaining: 0 };
  usage.voiceCount += 1;
  await saveDemoUsage(uid, usage);
  return { allowed: true, remaining: DEMO_VOICE_LIMIT - usage.voiceCount };
}

// ── Purchased credits (Firestore — set by server after Cardcom payment) ───────
// Pack: 300 text messages + 90 voice minutes for 50 ₪
// Server adds credits; client can only decrease them (enforced by Firestore Rules).

export async function getPurchasedCredits(uid: string): Promise<{ textMessages: number; voiceMinutes: number }> {
  if (!db || !uid) return { textMessages: 0, voiceMinutes: 0 };
  try {
    const snap = await getDoc(doc(db, 'users', uid));
    const data = snap.data() || {};
    return {
      textMessages: Math.max(0, Number(data.purchasedTextMessages) || 0),
      voiceMinutes: Math.max(0, Number(data.purchasedVoiceMinutes) || 0),
    };
  } catch {
    return { textMessages: 0, voiceMinutes: 0 };
  }
}

/** Deduct 1 purchased text message. Returns true if credit was available. */
export async function deductPurchasedText(uid: string): Promise<boolean> {
  if (!db || !uid) return false;
  try {
    const credits = await getPurchasedCredits(uid);
    if (credits.textMessages <= 0) return false;
    await updateDoc(doc(db, 'users', uid), {
      purchasedTextMessages: increment(-1),
    });
    return true;
  } catch (err) {
    console.error('[Credits] deductPurchasedText failed:', err);
    return false;
  }
}

/** Deduct voice minutes from purchased credits. */
export async function deductPurchasedVoice(uid: string, minutesUsed: number): Promise<void> {
  if (!db || !uid || minutesUsed <= 0) return;
  try {
    await updateDoc(doc(db, 'users', uid), {
      purchasedVoiceMinutes: increment(-minutesUsed),
    });
  } catch (err) {
    console.error('[Credits] deductPurchasedVoice failed:', err);
  }
}
