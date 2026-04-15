import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { Message } from '../types';

// Maximum messages to persist — keeps documents well under Firestore's 1 MB limit
const MAX_STORED_MESSAGES = 300;

/**
 * Save the current conversation to Firestore under users/{uid}.
 * Returns true on success, false on failure.
 */
export async function saveSession(
  uid: string,
  messages: Message[],
  clientName: string
): Promise<boolean> {
  if (!db || !uid) return false;
  try {
    const ref = doc(db, 'users', uid);
    const trimmed = messages.slice(-MAX_STORED_MESSAGES);
    await setDoc(
      ref,
      {
        displayName: clientName || '',
        lastSession: {
          messages: trimmed.map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            timestamp: m.timestamp,
            isVoice: m.isVoice ?? false,
          })),
          clientName: clientName || '',
          updatedAt: serverTimestamp(),
        },
      },
      { merge: true }
    );
    console.log(`[Firestore] session saved — ${trimmed.length} messages`);
    return true;
  } catch (err: any) {
    console.error('[Firestore] saveSession FAILED:', err?.code, err?.message);
    return false;
  }
}

/**
 * Load the last saved conversation for this user.
 * Returns null if there is no prior session or if the read fails.
 */
export async function loadSession(
  uid: string
): Promise<{ messages: Message[]; clientName: string } | null> {
  if (!db || !uid) return null;
  try {
    const ref  = doc(db, 'users', uid);
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      console.log('[Firestore] no prior session found for user');
      return null;
    }
    const session = snap.data()?.lastSession;
    if (!session || !Array.isArray(session.messages)) return null;
    console.log(`[Firestore] session loaded — ${session.messages.length} messages`);
    return {
      messages:   session.messages as Message[],
      clientName: session.clientName ?? '',
    };
  } catch (err: any) {
    console.error('[Firestore] loadSession FAILED:', err?.code, err?.message);
    return null;
  }
}
