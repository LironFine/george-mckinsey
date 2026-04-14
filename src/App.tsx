import React, { useState, Component, ErrorInfo, ReactNode } from 'react';
import Chat from './components/Chat';
import Sidebar from './components/Sidebar';
import { Briefcase, Menu, X, AlertTriangle } from 'lucide-react';

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

  const handleSelectModel = (modelName: string) => {
    setExternalInput(`אשמח להתייעץ איתך בנושא מודל ${modelName}`);
    setIsMobileMenuOpen(false);
    // Reset after a short delay so it can be triggered again
    setTimeout(() => setExternalInput(undefined), 100);
  };

  return (
    <ErrorBoundary>
      <div className="h-screen flex flex-col bg-slate-50 overflow-hidden">
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
          
          <button 
            onClick={() => setIsMobileMenuOpen(true)}
            className="lg:hidden flex flex-col items-center gap-0.5 group"
          >
            <div className="w-10 h-10 bg-red-500 rounded-xl flex items-center justify-center text-white shadow-md shadow-red-100 group-hover:bg-red-600 transition-all">
              <Briefcase size={20} />
            </div>
            <span className="text-[9px] font-bold text-red-600 uppercase tracking-tighter">כלים</span>
          </button>
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
            <Chat externalInput={externalInput} />
          </div>
          <div className="hidden lg:block h-full shrink-0">
            <Sidebar onSelectModel={handleSelectModel} />
          </div>
        </main>
      </div>
    </ErrorBoundary>
  );
}
