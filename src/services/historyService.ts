import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { Message } from '../types';

// Maximum messages to persist — keeps documents well under Firestore's 1 MB limit
const MAX_STORED_MESSAGES = 300;

/**
 * Save the current conversation to Firestore under users/{uid}.
 * Silently swallows errors so UI is never blocked by a failed save.
 */
export async function saveSession(
  uid: string,
  messages: Message[],
  clientName: string
): Promise<void> {
  if (!db || !uid) return;
  try {
    const ref = doc(db, 'users', uid);
    // Trim to the most-recent messages if the conversation is very long
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
  } catch (err) {
    console.warn('historyService: save failed', err);
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
    if (!snap.exists()) return null;
    const session = snap.data()?.lastSession;
    if (!session || !Array.isArray(session.messages)) return null;
    return {
      messages:   session.messages as Message[],
      clientName: session.clientName ?? '',
    };
  } catch (err) {
    console.warn('historyService: load failed', err);
    return null;
  }
}
