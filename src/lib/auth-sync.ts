/**
 * Cross-app logout sync — shared with Yael & Gemma.
 *
 * All three Pirsoomai apps share `users/{uid}` in Firestore. When the user
 * clicks "logout" in any one of them we stamp `globalSignedOutAt` on the user
 * doc; the other apps see the bump on next load and sign out too.
 *
 * Each app keeps a per-uid acknowledgement timestamp in localStorage so a
 * fresh sign-in here doesn't immediately re-trigger logout from a stale
 * marker.
 */
import {
  signInWithPopup,
  signOut as fbSignOut,
  onAuthStateChanged,
  GoogleAuthProvider,
  type User,
} from 'firebase/auth';
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { auth, db } from './firebase';

const SYNC_KEY_PREFIX = 'george_auth_sync_';

function ackKey(uid: string): string {
  return SYNC_KEY_PREFIX + uid;
}

async function readGlobalSignOutMillis(uid: string): Promise<number> {
  const snap = await getDoc(doc(db, 'users', uid));
  const ts = (snap.data() || {}).globalSignedOutAt;
  return typeof ts?.toMillis === 'function' ? ts.toMillis() : 0;
}

export async function signInWithGoogleSync(): Promise<User> {
  const provider = new GoogleAuthProvider();
  const result = await signInWithPopup(auth, provider);
  // Snapshot the current sign-out marker so this fresh login isn't
  // immediately undone by an older logout from another app.
  try {
    const t = await readGlobalSignOutMillis(result.user.uid);
    localStorage.setItem(ackKey(result.user.uid), String(t));
  } catch (err) {
    console.error('[auth-sync] failed to seed ack on sign-in:', err);
  }
  return result.user;
}

export async function signOutSync(): Promise<void> {
  // Broadcast first — write the sign-out marker BEFORE killing the auth
  // session, otherwise we lose the credentials needed to write Firestore.
  const uid = auth.currentUser?.uid;
  if (uid) {
    try {
      await setDoc(
        doc(db, 'users', uid),
        { globalSignedOutAt: serverTimestamp() },
        { merge: true },
      );
    } catch (err) {
      console.error('[auth-sync] failed to broadcast sign-out:', err);
    }
  }
  await fbSignOut(auth);
}

export function subscribeAuthSync(callback: (user: User | null) => void): () => void {
  return onAuthStateChanged(auth, async (user) => {
    if (!user) {
      callback(null);
      return;
    }
    try {
      const serverT = await readGlobalSignOutMillis(user.uid);
      const localT = Number(localStorage.getItem(ackKey(user.uid)) || '0');
      if (serverT > localT) {
        localStorage.setItem(ackKey(user.uid), String(serverT));
        await fbSignOut(auth);
        return; // listener will re-fire with null
      }
    } catch (err) {
      console.error('[auth-sync] cross-app check failed:', err);
    }
    callback(user);
  });
}
