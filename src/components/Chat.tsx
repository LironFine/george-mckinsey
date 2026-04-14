import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Send, User, Bot, Loader2, Paperclip, Sparkles, FileText, LayoutList, Calendar, ExternalLink, RefreshCw, ClipboardList, Mic, MicOff, Volume2 } from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Message } from '../types';
import { sendMessageToGemini } from '../services/gemini';
import { INITIAL_MESSAGE } from '../constants';
import { voiceService } from '../services/voiceService';
import { checkAndIncrementUsage, checkAndIncrementVoiceUsage } from '../services/usageService';

export default function Chat({ externalInput }: { externalInput?: string }) {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: '1',
      role: 'assistant',
      content: INITIAL_MESSAGE,
      timestamp: Date.now(),
    },
  ]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [clientFileContent, setClientFileContent] = useState<string>('');
  const [clientFileName, setClientFileName] = useState<string>('');
  const [clientName, setClientName] = useState<string>('');
  const [isWaitingForName, setIsWaitingForName] = useState(false);
  const [isVoiceActive, setIsVoiceActive] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (externalInput) {
      handleSend(externalInput);
    }
  }, [externalInput]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSend = async (contentOverride?: string) => {
    const messageContent = contentOverride || input;
    if (!messageContent.trim() || isLoading) return;

    // Check usage limit before sending to Gemini
    if (!contentOverride) {
      const { allowed, remaining } = await checkAndIncrementUsage();
      if (!allowed) {
        const limitMessage: Message = {
          id: Date.now().toString(),
          role: 'assistant',
          content: 'הגעת למכסת ההודעות היומית שלך (100 הודעות). ג\'ורג\' צריך לנוח קצת כדי להישאר חד. נחזור לדבר מחר!',
          timestamp: Date.now(),
        };
        setMessages((prev) => [...prev, limitMessage]);
        return;
      }

      // Auto-download at 90 messages (10 remaining)
      if (remaining === 10) {
        const warningMessage: Message = {
          id: 'warning-' + Date.now(),
          role: 'assistant',
          content: 'שים לב: נותרו לך 10 הודעות אחרונות למכסה היומית. אני מבצע כעת גיבוי אוטומטי של תיק הלקוח שלך כדי שלא תאבד שום דבר.',
          timestamp: Date.now(),
        };
        setMessages((prev) => [...prev, warningMessage]);
        // Delay slightly to ensure the message is seen
        setTimeout(() => handleUpdateClientFile(), 1000);
      }

      console.log(`Usage allowed. Remaining messages: ${remaining}`);
    }

    if (isWaitingForName && !contentOverride) {
      setClientName(messageContent);
      setIsWaitingForName(false);
      setInput('');
      
      const userMsg: Message = {
        id: Date.now().toString(),
        role: 'user',
        content: messageContent,
        timestamp: Date.now(),
      };
      const updatedMessages = [...messages, userMsg];
      setMessages(updatedMessages);
      
      // Update voice session with the name if active
      if (isVoiceActive) {
        voiceService.sendTextMessage(`המשתמש ציין ששמו הוא: ${messageContent}. אנא זכור זאת והמשך בשיחה בהתאם.`);
      }
      
      handleUpdateClientFile(messageContent, updatedMessages);
      return;
    }

    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: messageContent,
      timestamp: Date.now(),
    };

    setMessages((prev) => [...prev, userMessage]);
    if (!contentOverride) setInput('');
    setIsLoading(true);

    try {
      const response = await sendMessageToGemini([...messages, userMessage]);
      const assistantMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: response,
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, assistantMessage]);
    } catch (error: any) {
      console.error('Error sending message:', error);
      
      let errorText = 'מצטער, חלה שגיאה בתקשורת. אנא נסה שוב.';
      if (error.message && error.message.includes('מפתח ה-API חסר')) {
        errorText = 'מפתח ה-API (GEMINI_API_KEY) חסר. אנא הגדר אותו בלשונית ה-Secrets או בהגדרות האפליקציה.';
      } else if (error.message && error.message.includes('quota')) {
        errorText = 'חרגת ממכסת השימוש ב-Gemini. אנא נסה שוב מאוחר יותר.';
      }

      const errorMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: errorText,
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, errorMessage]);
    } finally {
      setIsLoading(false);
    }
  };

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Warn the user if the file is very large (over 100KB may exceed Gemini context)
    const MAX_FILE_BYTES = 100 * 1024;
    if (file.size > MAX_FILE_BYTES) {
      const warningMsg: Message = {
        id: Date.now().toString(),
        role: 'assistant',
        content: `הקובץ שנבחר (${(file.size / 1024).toFixed(0)} KB) גדול במיוחד. ייתכן שחלקים ממנו יקוצצו בגלל מגבלות ה-AI. מומלץ להעלות קובץ קצר יותר.`,
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, warningMsg]);
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      setClientFileContent(content);
      setClientFileName(file.name);

      let extractedName = '';
      const cleanName = file.name.replace('.txt', '').replace('.md', '').replace('תיק לקוח', '').trim();
      if (cleanName && cleanName.length > 1) {
        extractedName = cleanName;
        setClientName(extractedName);
      }

      const greeting = extractedName ? `שלום ${extractedName}!` : 'שלום!';
      handleSend(`[תיק לקוח הועלה: ${file.name}]\n\n${greeting} זהו תיק הלקוח המעודכן שלי. אנא למד אותו והשתמש בו כבסיס לייעוץ שלנו:\n\n${content}`);
    };
    reader.readAsText(file);
  };

  const handleUpdateClientFile = async (providedName?: string, messagesOverride?: Message[]) => {
    // Allow update if there are messages OR if voice session was active (even if no text messages yet)
    const currentMessages = messagesOverride || messages;
    const hasHistory = currentMessages.length > 1;
    const voiceHistory = voiceService.getHistory();
    const hasVoiceHistory = voiceHistory.length > 0;

    if (isLoading) return;

    const finalName = providedName || clientName;

    if (!finalName) {
      setIsWaitingForName(true);
      const assistantMessage: Message = {
        id: Date.now().toString(),
        role: 'assistant',
        content: 'כדי שאוכל להכין את תיק הלקוח, אני צריך לדעת איך קוראים לך (או ללקוח). איך תרצה שהשם יופיע במסמך?',
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, assistantMessage]);
      return;
    }

    setIsLoading(true);
    try {
      let summary = "";
      
      if (hasHistory || hasVoiceHistory) {
        // Combine text and voice history for a complete summary
        const combinedHistory = [...currentMessages];
        if (hasVoiceHistory) {
          voiceHistory.forEach((v, i) => {
            combinedHistory.push({
              id: `voice-${i}-${Date.now()}`,
              role: v.role as 'user' | 'assistant',
              content: v.content,
              timestamp: Date.now()
            });
          });
        }

        const summaryPrompt: Message = {
          id: 'summary-request',
          role: 'user',
          content: `אנא הכן סיכום מפורט ומקצועי של השיחה שלנו (כולל השיחה הקולית) עבור תיק הלקוח של ${finalName}. 
          
          חשוב מאוד: התבסס אך ורק על המידע שנאמר בשיחה הנוכחית. אל תמציא נושאים שלא דיברנו עליהם.
          
          הסיכום צריך לכלול:
          1. פירוט נושאי השיחה העיקריים.
          2. נקודות חשובות והחלטות שהתקבלו.
          3. המלצות אסטרטגיות להמשך המבוססות על השיחה.
          
          כתוב את הסיכום בצורה תמציתית אך מקיפה. אל תוסיף הקדמות, פשוט התחל בתוכן המקצועי.`,
          timestamp: Date.now()
        };
        
        summary = await sendMessageToGemini([...combinedHistory, summaryPrompt]);
      } else {
        summary = "טרם בוצעה שיחה מהותית בסשן זה. תיק הלקוח נוצר כבסיס לעבודה עתידית.";
      }
      
      const now = new Date();
      const dateStr = now.toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric' }).replace(/\//g, '.');
      const timeStr = now.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
      
      const header = `========================================\nתיק לקוח: ${finalName}\nתאריך עדכון: ${dateStr} | שעה: ${timeStr}\n========================================\n\n`;
      const newEntry = `${header}${summary}\n\n`;
      
      const updatedContent = clientFileContent ? `${newEntry}\n${clientFileContent}` : newEntry;
      setClientFileContent(updatedContent);

      const downloadName = `תיק לקוח - ${finalName} - ${dateStr} ${timeStr.replace(':', '-')}.txt`;

      const blob = new Blob([updatedContent], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = downloadName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      const assistantMessage: Message = {
        id: Date.now().toString(),
        role: 'assistant',
        content: hasHistory || hasVoiceHistory 
          ? `הכנתי את העדכון לתיק הלקוח של ${finalName} (כולל סיכום של השיחה הקולית). המסמך ירד כעת למחשבך.`
          : `יצרתי עבורך מסמך בסיס לתיק הלקוח של ${finalName}. תוכל להשתמש בו לתיעוד בהמשך.`,
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, assistantMessage]);
    } catch (error) {
      console.error('Error updating client file:', error);
      setIsWaitingForName(false); // ensure state is never stuck
      const errorMessage: Message = {
        id: Date.now().toString(),
        role: 'assistant',
        content: 'מצטער, הייתה בעיה ביצירת תיק הלקוח. אנא נסה שוב בעוד רגע.',
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, errorMessage]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleDownloadBrief = async () => {
    if (messages.length <= 1 || isLoading) return;

    setIsLoading(true);
    try {
      const briefPrompt: Message = {
        id: 'brief-request',
        role: 'user',
        content: 'אנא כתוב בריף מקצועי לקופירייטר (עבור גמה או קלודין) המבוסס על האסטרטגיה שגיבשנו בשיחה זו. הבריף צריך לכלול: מטרת המהלך, קהל יעד, הצעת ערך, טון וסגנון, ומסרים מרכזיים. כתוב זאת בצורה שתאפשר לקופירייטר להתחיל לעבוד מיד. אל תוסיף הקדמות או סיומות, רק את הבריף עצמו.',
        timestamp: Date.now()
      };
      
      const brief = await sendMessageToGemini([...messages, briefPrompt]);
      
      const dateStr = new Date().toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric' }).replace(/\//g, '.');
      const downloadName = `בריף לקופירייטר - ${clientName || 'לקוח'} - ${dateStr}.txt`;

      const blob = new Blob([brief], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = downloadName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      const assistantMessage: Message = {
        id: Date.now().toString(),
        role: 'assistant',
        content: `הבריף לקופירייטר הוכן והורד למחשבך. תוכל להעביר אותו כעת לג'מה או קלודין לביצוע הקופי.`,
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, assistantMessage]);
    } catch (error) {
      console.error('Error creating brief:', error);
      const errorMessage: Message = {
        id: Date.now().toString(),
        role: 'assistant',
        content: 'מצטער, הייתה בעיה ביצירת הבריף. אנא נסה שוב.',
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, errorMessage]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleNewChat = () => {
    setMessages([
      {
        id: '1',
        role: 'assistant',
        content: INITIAL_MESSAGE,
        timestamp: Date.now(),
      },
    ]);
    setInput('');
    // Reset client file state so old data doesn't bleed into a new session
    setClientFileContent('');
    setClientFileName('');
    setClientName('');
    setIsWaitingForName(false);
  };

  const toggleVoice = async () => {
    if (isVoiceActive) {
      voiceService.stop();
      setIsVoiceActive(false);
    } else {
      // Check browser WebSocket support (all modern browsers support it, but just in case)
      if (!window.WebSocket) {
        setMessages((prev) => [
          ...prev,
          {
            id: Date.now().toString(),
            role: 'assistant',
            content: 'הדפדפן שלך אינו תומך בשיחה קולית. אנא השתמש ב-Chrome.',
            timestamp: Date.now(),
          } as Message,
        ]);
        return;
      }

      // Check monthly voice usage limit before starting
      const { allowed, resetDays } = await checkAndIncrementVoiceUsage();
      if (!allowed) {
        setMessages((prev) => [
          ...prev,
          {
            id: Date.now().toString(),
            role: 'assistant',
            content: `הגעת למכסת השיחות הקוליות החודשית שלך (30 שיחות). המכסה תתחדש בעוד ${resetDays} ימים. ניתן להמשיך בצ'אט הטקסטואלי ללא הגבלה.`,
            timestamp: Date.now(),
          } as Message,
        ]);
        return;
      }

      setIsVoiceActive(true);
      await voiceService.start({
        history: messages,
        onTranscription: (text, role) => {
          const msg: Message = {
            id: Date.now().toString() + Math.random(),
            role: role === 'model' ? 'assistant' : 'user',
            content: text,
            timestamp: Date.now(),
          };
          setMessages((prev) => [...prev, msg]);
        },
        onError: (err) => {
          console.error(err);
          setIsVoiceActive(false);
          const errMsg: Message = {
            id: Date.now().toString(),
            role: 'assistant',
            content: err?.message || 'לא ניתן היה להפעיל את השיחה הקולית. אנא המשך בצ\'אט הטקסטואלי.',
            timestamp: Date.now(),
          };
          setMessages((prev) => [...prev, errMsg]);
        },
        onClose: () => {
          setIsVoiceActive(false);
        },
      });
    }
  };

  return (
    <div className="flex flex-col h-full glass-panel rounded-3xl overflow-hidden">
      {/* Voice Status Overlay */}
      {isVoiceActive && (
        <div 
          role="status"
          aria-live="polite"
          className="absolute top-20 left-1/2 -translate-x-1/2 z-50 bg-white/90 backdrop-blur-sm border border-blue-100 px-6 py-3 rounded-full shadow-xl flex items-center gap-3"
        >
          <div className="flex gap-1" aria-hidden="true">
            {[1, 2, 3].map((i) => (
              <motion.div
                key={i}
                animate={{ height: [8, 16, 8] }}
                transition={{ repeat: Infinity, duration: 0.6, delay: i * 0.2 }}
                className="w-1 bg-blue-500 rounded-full"
              />
            ))}
          </div>
          <span className="text-blue-700 font-medium text-sm">שיחה קולית פעילה...</span>
          <Volume2 size={18} className="text-blue-500 animate-bounce" aria-hidden="true" />
        </div>
      )}

      {/* Messages Area - Increased height by making it flex-1 and ensuring parent is h-full */}
      <div 
        className="flex-1 overflow-y-auto p-3 sm:p-6 scrollbar-thin scrollbar-thumb-slate-200"
        role="log"
        aria-label="היסטוריית צ'אט"
        aria-live="polite"
      >
        <div className="min-h-full flex flex-col justify-end space-y-2 sm:space-y-6">
          <AnimatePresence initial={false}>
            {messages.map((message) => (
              <motion.div
                key={message.id}
                initial={{ opacity: 0, y: 10, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                className={`flex ${message.role === 'user' ? 'justify-start' : 'justify-end'} items-start gap-3`}
              >
                {message.role === 'user' && (
                  <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center text-blue-600 shrink-0">
                    <User size={18} />
                  </div>
                )}
                <div
                  className={`${message.role === 'user' ? 'chat-bubble-user' : 'chat-bubble-assistant'} text-[13px] sm:text-sm flex-1`}
                >
                  <div className="markdown-body">
                    <Markdown remarkPlugins={[remarkGfm]}>{message.content}</Markdown>
                  </div>
                </div>
                {message.role === 'assistant' && (
                  <div className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center text-slate-600 shrink-0">
                    <Bot size={18} />
                  </div>
                )}
              </motion.div>
            ))}
          </AnimatePresence>
          {isLoading && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="flex justify-end items-center gap-3"
            >
              <div className="chat-bubble-assistant flex items-center gap-2 text-[13px] sm:text-sm">
                <Loader2 className="animate-spin" size={16} />
                <span>חושב על האסטרטגיה המנצחת...</span>
              </div>
              <div className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center text-slate-600 shrink-0">
                <Bot size={18} />
              </div>
            </motion.div>
          )}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input and Actions Area */}
      <div className="p-2 sm:p-4 bg-white border-t border-slate-100">
        <div className="relative flex items-center gap-2 max-w-4xl mx-auto mb-2 sm:mb-4">
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileUpload}
            className="hidden"
            accept=".txt,.md"
          />
          <button 
            onClick={() => fileInputRef.current?.click()}
            className="p-2 text-slate-400 hover:text-blue-600 transition-colors"
            title="העלאת סיכום פגישה"
          >
            <Paperclip size={20} />
          </button>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder="מה בפיך?"
            className="flex-1 bg-slate-50 border-none rounded-2xl px-4 py-2 focus:ring-2 focus:ring-blue-500 resize-none min-h-[60px] max-h-[150px] text-xs sm:text-sm"
            rows={2}
          />
          <button
            onClick={toggleVoice}
            className={`p-3 rounded-xl transition-all shadow-lg ${
              isVoiceActive 
                ? 'bg-red-500 text-white shadow-red-200 animate-pulse' 
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200 shadow-slate-200'
            }`}
            title={isVoiceActive ? "עצור שיחה קולית" : "התחל שיחה קולית"}
          >
            {isVoiceActive ? <MicOff size={20} /> : <Mic size={20} />}
          </button>
          <button
            onClick={() => handleSend()}
            disabled={!input.trim() || isLoading}
            className="p-3 bg-blue-600 text-white rounded-xl hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-lg shadow-blue-200"
          >
            <Send size={20} />
          </button>
        </div>

        {/* Action Buttons - Moved below input */}
        <div className="grid grid-cols-2 sm:flex sm:flex-wrap gap-1.5 sm:gap-2 max-w-4xl mx-auto" role="group" aria-label="פעולות מהירות">
          <button
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center justify-center gap-1.5 px-2 py-1.5 sm:px-4 sm:py-2 bg-blue-50 text-blue-700 rounded-full text-[9px] sm:text-[11px] font-medium hover:bg-blue-100 transition-colors border border-blue-100"
            aria-label="העלאת תיק לקוח"
          >
            <FileText size={12} className="sm:w-[14px] sm:h-[14px]" />
            <span className="truncate">העלאת תיק לקוח</span>
          </button>
          <button
            onClick={() => handleUpdateClientFile()}
            className="flex items-center justify-center gap-1.5 px-2 py-1.5 sm:px-4 sm:py-2 bg-slate-50 text-slate-700 rounded-full text-[9px] sm:text-[11px] font-medium hover:bg-slate-100 transition-colors border border-slate-200"
            aria-label="עדכון תיק לקוח"
          >
            <LayoutList size={12} className="sm:w-[14px] sm:h-[14px]" />
            <span className="truncate">עדכון תיק לקוח</span>
          </button>
          <button
            onClick={() => handleDownloadBrief()}
            className="flex items-center justify-center gap-1.5 px-2 py-1.5 sm:px-4 sm:py-2 bg-indigo-50 text-indigo-700 rounded-full text-[9px] sm:text-[11px] font-medium hover:bg-indigo-100 transition-colors border border-indigo-100"
            aria-label="הורדת בריף לקופירייטר"
          >
            <ClipboardList size={12} className="sm:w-[14px] sm:h-[14px]" />
            <span className="truncate">הורדת בריף לקופי</span>
          </button>
          <button
            onClick={handleNewChat}
            className="flex items-center justify-center gap-1.5 px-2 py-1.5 sm:px-4 sm:py-2 bg-red-50 text-red-700 rounded-full text-[9px] sm:text-[11px] font-medium hover:bg-red-100 transition-colors border border-red-100"
            aria-label="התחלת שיחה חדשה"
          >
            <RefreshCw size={12} className="sm:w-[14px] sm:h-[14px]" />
            <span className="truncate">שיחה חדשה</span>
          </button>
          <a
            href="https://secure.cardcom.solutions/e/e0aOwzLUH0CdpZ9hf0Rd8w"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center gap-1.5 px-2 py-1.5 sm:px-4 sm:py-2 bg-gradient-to-r from-blue-600 to-indigo-600 text-white rounded-full text-[9px] sm:text-[11px] font-medium hover:from-blue-700 hover:to-indigo-700 transition-all shadow-md shadow-blue-100"
          >
            <Calendar size={12} className="sm:w-[14px] sm:h-[14px]" />
            <span className="truncate">פגישה עם לירון פיין</span>
            <ExternalLink size={8} className="opacity-70 sm:w-[10px] sm:h-[10px]" />
          </a>
        </div>

        <div className="text-center mt-3 text-[10px] text-slate-400 flex items-center justify-center gap-1">
          <Sparkles size={10} />
          <span>מופעל על ידי בינה מלאכותית אסטרטגית</span>
        </div>
      </div>
    </div>
  );
}
