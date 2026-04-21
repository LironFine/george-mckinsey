import { useState, useEffect } from 'react';
import { X, Monitor } from 'lucide-react';

const STORAGE_KEY = 'pirsoomai_desktop_hint_dismissed';

/**
 * One-time, mobile-only notice recommending the desktop version.
 * Shared across the three Pirsoomai apps (Yael / George / Gemma) — each
 * app keeps its own copy so the component can live inside each repo
 * without a shared package.
 */
export default function MobileDesktopHint() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const isMobile = window.matchMedia('(max-width: 767px)').matches;
    const dismissed = (() => {
      try {
        return localStorage.getItem(STORAGE_KEY) === '1';
      } catch {
        return false;
      }
    })();
    if (isMobile && !dismissed) setVisible(true);
  }, []);

  if (!visible) return null;

  function dismiss() {
    try {
      localStorage.setItem(STORAGE_KEY, '1');
    } catch {
      // ignore quota / private-mode errors
    }
    setVisible(false);
  }

  return (
    <div
      className="fixed inset-0 z-[100] bg-slate-900/70 backdrop-blur-sm flex items-center justify-center p-4"
      dir="rtl"
      onClick={dismiss}
    >
      <div
        className="bg-white rounded-3xl max-w-sm w-full p-6 shadow-2xl relative"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={dismiss}
          aria-label="כן, הבנתי"
          className="absolute top-3 left-3 p-2 rounded-full hover:bg-slate-100 transition"
        >
          <X className="w-5 h-5 text-slate-600" />
        </button>
        <div className="w-14 h-14 rounded-2xl bg-amber-100 flex items-center justify-center mx-auto mb-4">
          <Monitor className="w-7 h-7 text-amber-700" />
        </div>
        <h2 className="text-xl font-extrabold text-slate-900 text-center mb-2 italic">
          עדיף להשתמש במחשב
        </h2>
        <p className="text-slate-600 text-center leading-relaxed mb-5">
          האפליקציה מיועדת לעבודה מקצועית בדסקטופ. במובייל התצוגה מצומצמת —
          לחוויה מלאה אנחנו ממליצים לפתוח מהמחשב.
        </p>
        <button
          onClick={dismiss}
          className="w-full py-3 bg-slate-900 text-white rounded-xl font-bold hover:bg-slate-800 transition"
        >
          כן, הבנתי
        </button>
      </div>
    </div>
  );
}
