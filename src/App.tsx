import React, { useState, useEffect, Component, ErrorInfo, ReactNode } from 'react';
import { onAuthStateChanged, User } from 'firebase/auth';
import { auth } from './lib/firebase';
import Chat from './components/Chat';
import Sidebar from './components/Sidebar';
import AuthButton from './components/AuthButton';
import { Briefcase, X, AlertTriangle, Lock, ExternalLink } from 'lucide-react';

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

export default function App() {
  const [externalInput, setExternalInput] = React.useState<string | undefined>(undefined);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  // null = checking, true = allowed, false = blocked
  const [tokenValid, setTokenValid] = useState<boolean | null>(null);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, setUser);
    return unsub;
  }, []);

  // ── Wix token validation ──────────────────────────────────────────────────
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');

    if (token) {
      // Validate token with server, then remove it from URL
      fetch(`/api/validate-token?token=${encodeURIComponent(token)}`)
        .then((r) => r.json())
        .then((data) => {
          if (data.valid) {
            sessionStorage.setItem('wix_access', 'true');
            setTokenValid(true);
            window.history.replaceState({}, '', window.location.pathname);
          } else {
            console.warn('[Auth] Wix token invalid:', data.reason);
            setTokenValid(false);
          }
        })
        .catch(() => setTokenValid(true)); // network error → allow (fail open)
      return;
    }

    // No token in URL — check sessionStorage (same tab navigation)
    const stored = sessionStorage.getItem('wix_access');
    if (stored === 'true') { setTokenValid(true); return; }

    // Check if server has no secret configured (dev/direct access allowed)
    fetch('/api/validate-token')
      .then((r) => r.json())
      .then((data) => setTokenValid(data.dev === true ? true : false))
      .catch(() => setTokenValid(true));
  }, []);
  // ─────────────────────────────────────────────────────────────────────────

  const handleSelectModel = (modelName: string) => {
    setExternalInput(`אשמח להתייעץ איתך בנושא מודל ${modelName}`);
    setIsMobileMenuOpen(false);
    // Reset after a short delay so it can be triggered again
    setTimeout(() => setExternalInput(undefined), 100);
  };

  // Loading screen while validating token
  if (tokenValid === null) {
    return (
      <div className="h-screen flex items-center justify-center bg-slate-50">
        <div className="flex flex-col items-center gap-3 text-slate-400">
          <div className="w-8 h-8 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
          <span className="text-sm">טוען...</span>
        </div>
      </div>
    );
  }

  // Subscription required screen
  if (tokenValid === false) {
    return (
      <div className="h-screen flex items-center justify-center bg-slate-50 p-6 rtl">
        <div className="bg-white rounded-2xl shadow-xl border border-slate-100 max-w-sm w-full p-8 text-center">
          <div className="w-16 h-16 bg-blue-50 rounded-full flex items-center justify-center mx-auto mb-4">
            <Lock size={28} className="text-blue-600" />
          </div>
          <h2 className="text-xl font-bold text-slate-900 mb-2">נדרש מנוי פעיל</h2>
          <p className="text-slate-500 text-sm mb-6">
            הגישה לאסטרטג השיווקי מיועדת למנויי הפרסומאי בלבד.
          </p>
          <a
            href="https://www.pirsoomai.com"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center gap-2 w-full py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-bold transition-colors"
          >
            <span>למנוי ב-הפרסומאי</span>
            <ExternalLink size={15} />
          </a>
        </div>
      </div>
    );
  }

  const isInIframe = window.self !== window.top;

  return (
    <ErrorBoundary>
      <div className={`flex flex-col bg-slate-50 overflow-hidden ${isInIframe ? 'min-h-screen' : 'h-screen'}`}
           style={isInIframe ? { paddingTop: 'env(safe-area-inset-top, 0px)' } : {}}>
        {/* Header */}
        <header className="h-14 bg-white border-b border-slate-100 px-6 flex items-center justify-between shrink-0 z-50">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center text-white shadow-lg shadow-blue-200">
              <Briefcase size={18} />
            </div>
            <div>
              <h1 className="text-lg font-bold text-slate-900 leading-tight">יועץ אסטרטגי שיווקי</h1>
              <p className="text-[10px] text-slate-500">מומחה צמיחה לעסקים קטנים</p>
            </div>
          </div>
          
          <div className="flex items-center gap-2">
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
          <div className="flex-1 min-w-0 h-full overflow-hidden">
            <Chat externalInput={externalInput} user={user} />
          </div>
          <div className="hidden lg:block h-full shrink-0">
            <Sidebar onSelectModel={handleSelectModel} />
          </div>
        </main>
      </div>
    </ErrorBoundary>
  );
}
