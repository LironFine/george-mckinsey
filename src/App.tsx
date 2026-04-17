import React, { useState, useEffect, Component, ErrorInfo, ReactNode } from 'react';
import { onAuthStateChanged, User } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from './lib/firebase';
import Chat from './components/Chat';
import Sidebar from './components/Sidebar';
import AuthButton from './components/AuthButton';
import { Briefcase, X, AlertTriangle, ExternalLink, Sparkles } from 'lucide-react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Uncaught error:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      let errorMessage = "משהו השתבש. אנא נסה לרענן את הדף.";
      
      try {
        if (this.state.error?.message) {
          const parsed = JSON.parse(this.state.error.message);
          if (parsed.error && parsed.error.includes("Missing or insufficient permissions")) {
            errorMessage = "אין הרשאות מתאימות לביצוע הפעולה. אנא וודא שאתה מחובר.";
          }
        }
      } catch (e) {
        // Not a JSON error
      }

      return (
        <div className="min-h-screen flex items-center justify-center bg-slate-50 p-4 rtl">
          <div className="bg-white p-8 rounded-2xl shadow-xl border border-red-100 max-w-md w-full text-center">
            <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center text-red-600 mx-auto mb-4">
              <AlertTriangle size={32} />
            </div>
            <h2 className="text-xl font-bold text-slate-900 mb-2">אופס! תקלה טכנית</h2>
            <p className="text-slate-600 mb-6">{errorMessage}</p>
            <button 
              onClick={() => window.location.reload()}
              className="w-full py-3 bg-blue-600 text-white rounded-xl font-bold hover:bg-blue-700 transition-colors"
            >
              רענן דף
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

type SubStatus = 'loading' | 'active' | 'trial' | 'blocked';

export default function App() {
  const [externalInput, setExternalInput] = React.useState<string | undefined>(undefined);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [subStatus, setSubStatus] = useState<SubStatus>('loading');
  const [subscription, setSubscription] = useState<any>(null);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, setUser);
    return unsub;
  }, []);

  // ── Subscription check — reads from Firestore after Google sign-in ────────
  useEffect(() => {
    if (!user) {
      setSubStatus('loading');
      return;
    }
    (async () => {
      try {
        const [userSnap, demoSnap] = await Promise.all([
          getDoc(doc(db, 'users', user.uid)),
          getDoc(doc(db, 'demo_usage', user.uid)),
        ]);
        const sub = (userSnap.data() || {}).subscription;
        const demo = demoSnap.data() || { textCount: 0, voiceCount: 0 };

        if (sub?.status === 'active' && sub.currentPeriodEnd > Date.now()) {
          setSubscription(sub);
          setSubStatus('active');
        } else if (sub?.status === 'cancelled' || sub?.status === 'expired') {
          setSubStatus('blocked');
        } else if ((demo.textCount || 0) < 20 && (demo.voiceCount || 0) < 2) {
          setSubStatus('trial');
        } else {
          setSubStatus('blocked');
        }
      } catch (err) {
        console.error('[Auth] Subscription check failed:', err);
        setSubStatus('trial'); // fail-open: allow trial if check fails
      }
    })();
  }, [user?.uid]);
  // ─────────────────────────────────────────────────────────────────────────

  const handleSelectModel = (modelName: string) => {
    setExternalInput(`אשמח להתייעץ איתך בנושא מודל ${modelName}`);
    setIsMobileMenuOpen(false);
    // Reset after a short delay so it can be triggered again
    setTimeout(() => setExternalInput(undefined), 100);
  };

  // Loading — waiting for user sign-in or subscription check
  if (!user || subStatus === 'loading') {
    if (!user) {
      // Show sign-in screen
      return (
        <div className="h-screen flex items-center justify-center bg-slate-50 p-6 rtl">
          <div className="bg-white rounded-2xl shadow-xl border border-slate-100 max-w-sm w-full p-8 text-center">
            <img
              src="/george.JPG"
              alt="האסטרטג ג'ורג' מקינזי"
              className="w-28 h-28 rounded-full object-cover object-top mx-auto mb-4 shadow-lg"
            />
            <h2 className="text-xl font-bold text-slate-900 mb-2">חינם ועכשיו</h2>
            <p className="text-slate-600 text-sm mb-6 leading-relaxed">
              שיחת ייעוץ עם האסטרטג ג'ורג' מקינזי, לשידרוג מיידי של השיווק שלך
            </p>
            <AuthButton user={null} />
            <p className="text-[10px] text-slate-400 mt-4">גרסת ניסיון — 20 הודעות + 2 שיחות קוליות</p>
          </div>
        </div>
      );
    }
    // Subscription check in progress
    return (
      <div className="h-screen flex items-center justify-center bg-slate-50">
        <div className="flex flex-col items-center gap-3 text-slate-400">
          <div className="w-8 h-8 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
          <span className="text-sm">טוען...</span>
        </div>
      </div>
    );
  }

  // Blocked — no active subscription, trial exhausted, or cancelled
  if (subStatus === 'blocked') {
    return (
      <div className="h-screen flex items-center justify-center bg-slate-50 p-6 rtl">
        <div className="bg-white rounded-2xl shadow-xl border border-slate-100 max-w-sm w-full p-8 text-center">
          <img
            src="/george.JPG"
            alt="האסטרטג ג'ורג' מקינזי"
            className="w-28 h-28 rounded-full object-cover object-top mx-auto mb-4 shadow-lg"
          />
          <h2 className="text-xl font-bold text-slate-900 mb-2">
            {subscription?.status === 'cancelled' ? 'המנוי שלך בוטל' : 'גרסת הניסיון הסתיימה'}
          </h2>
          <p className="text-slate-500 text-sm mb-1">מנוי חודשי — 99 ₪/חודש</p>
          <p className="text-xs text-slate-400 mb-6">1,000 הודעות + 120 דקות קול • ג'ורג' וג'מה יחד</p>
          <button
            onClick={async () => {
              if (!user) return;
              try {
                const r = await fetch(`/api/create-subscription?uid=${user.uid}`);
                const { url, error } = await r.json();
                if (url) window.open(url, '_blank');
                else alert('שגיאה: ' + (error || 'נסה שוב'));
              } catch { alert('שגיאת תקשורת — נסה שוב'); }
            }}
            className="flex items-center justify-center gap-2 w-full py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-bold transition-colors mb-3"
          >
            <span>רכוש מנוי — 99 ₪/חודש</span>
            <ExternalLink size={15} />
          </button>
          <p className="text-[10px] text-slate-400">לאחר התשלום — רענן את הדף</p>
        </div>
      </div>
    );
  }

  const isInIframe = window.self !== window.top;
  const isDemo = subStatus === 'trial';

  return (
    <ErrorBoundary>
      <div className="flex flex-col h-full bg-slate-50 overflow-hidden">
        {/* Header */}
        <header className="h-14 bg-white border-b border-slate-100 shrink-0 z-50">
          <div className="flex h-full max-w-7xl mx-auto w-full px-2 lg:px-4 gap-6">
            {/* Desktop RIGHT (first in RTL, w-72): title — sits above the sidebar */}
            <div className="hidden lg:flex shrink-0 w-72 items-center gap-2">
              <img
                src="/george.JPG"
                alt="האסטרטג ג'ורג'"
                className="w-9 h-9 rounded-full object-cover object-top shadow-md"
              />
              <div>
                <h1 className="text-lg font-bold text-slate-900 leading-tight">האסטרטג ג'ורג'</h1>
                <p className="text-[10px] text-slate-500">יועץ אסטרטגי שיווקי</p>
              </div>
            </div>
            {/* Desktop LEFT (second in RTL, flex-1): user name — sits above chat */}
            <div className="flex-1 flex items-center justify-between">
              {/* Mobile only: title on left */}
              <div className="flex lg:hidden items-center gap-2">
                <img
                  src="/george.JPG"
                  alt="האסטרטג ג'ורג'"
                  className="w-9 h-9 rounded-full object-cover object-top shadow-md"
                />
                <div>
                  <h1 className="text-lg font-bold text-slate-900 leading-tight">האסטרטג ג'ורג'</h1>
                  <p className="text-[10px] text-slate-500">יועץ אסטרטגי שיווקי</p>
                </div>
              </div>
              {/* User name + mobile menu (right on mobile, left on desktop) */}
              <div className="flex items-center gap-2 lg:mr-auto">
                {isDemo && (
                  <span className="text-[9px] bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full font-bold">גרסת ניסיון</span>
                )}
                <AuthButton user={user} />
                <button
                  onClick={() => setIsMobileMenuOpen(true)}
                  className="lg:hidden flex flex-col items-center gap-0.5 group"
                >
                  <div className="w-10 h-10 bg-red-500 rounded-xl flex items-center justify-center text-white shadow-md shadow-red-100 group-hover:bg-red-600 transition-all">
                    <Briefcase size={20} />
                  </div>
                  <span className="text-[9px] font-bold text-red-600 uppercase tracking-tighter">כלים</span>
                </button>

              </div>
            </div>
          </div>
        </header>

        {/* Mobile Sidebar Overlay */}
        <div className={`fixed inset-0 z-[60] lg:hidden transition-opacity duration-300 ${isMobileMenuOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}`}>
          <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" onClick={() => setIsMobileMenuOpen(false)} />
          <div className={`absolute left-0 top-0 bottom-0 w-[300px] bg-white shadow-2xl transition-transform duration-300 ease-out transform ${isMobileMenuOpen ? 'translate-x-0' : '-translate-x-full'} flex flex-col`}>
            <div className="p-5 border-b border-slate-100 flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2 text-red-600">
                <Briefcase size={20} />
                <span className="font-bold text-slate-800">ארגז הכלים האסטרטגי</span>
              </div>
              <button onClick={() => setIsMobileMenuOpen(false)} className="p-2 text-slate-400 hover:text-slate-600 bg-slate-50 rounded-full">
                <X size={20} />
              </button>
            </div>
            <div className="flex-1 overflow-hidden">
              <Sidebar onSelectModel={handleSelectModel} isMobile />
            </div>
          </div>
        </div>

        {/* Main Content */}
        <main className="flex-1 flex max-w-7xl mx-auto w-full p-2 lg:p-4 gap-6 relative overflow-hidden items-stretch">
          {/* Sidebar FIRST — in RTL flex this places it on the RIGHT */}
          <div className="hidden lg:block h-full shrink-0">
            <Sidebar onSelectModel={handleSelectModel} />
          </div>
          {/* Chat SECOND — in RTL flex this places it on the LEFT */}
          <div className="flex-1 min-w-0 h-full overflow-hidden">
            <Chat externalInput={externalInput} user={user} isDemo={isDemo} subscription={subscription} />
          </div>
        </main>
      </div>
    </ErrorBoundary>
  );
}
