import React, { useState } from 'react';
import { signInWithPopup, signOut, GoogleAuthProvider, User } from 'firebase/auth';
import { auth } from '../lib/firebase';
import { LogIn, LogOut, Loader2 } from 'lucide-react';

interface AuthButtonProps {
  user: User | null;
}

export default function AuthButton({ user }: AuthButtonProps) {
  const [loading, setLoading] = useState(false);

  const handleSignIn = async () => {
    setLoading(true);
    try {
      await signInWithPopup(auth, new GoogleAuthProvider());
    } catch (err: any) {
      // user closed popup or blocked — not a crash
      if (err?.code !== 'auth/popup-closed-by-user' &&
          err?.code !== 'auth/cancelled-popup-request') {
        console.error('Sign-in error:', err);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleSignOut = async () => {
    setLoading(true);
    try {
      await signOut(auth);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-1.5 px-3 py-1.5 text-slate-500 text-xs">
        <Loader2 size={14} className="animate-spin" />
        <span>מתחבר…</span>
      </div>
    );
  }

  if (user) {
    return (
      <div className="flex items-center gap-2">
        {user.photoURL && (
          <img
            src={user.photoURL}
            alt={user.displayName ?? ''}
            className="w-7 h-7 rounded-full border border-slate-200"
            referrerPolicy="no-referrer"
          />
        )}
        <span className="hidden sm:block text-xs text-slate-600 max-w-[120px] truncate">
          {user.displayName}
        </span>
        <button
          onClick={handleSignOut}
          title="יציאה"
          className="flex items-center gap-1 px-2 py-1 text-xs text-slate-500 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
        >
          <LogOut size={13} />
          <span className="hidden sm:inline">יציאה</span>
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={handleSignIn}
      className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-200 rounded-lg text-xs font-medium transition-colors"
    >
      <LogIn size={13} />
      <span>כניסה עם Google</span>
    </button>
  );
}
