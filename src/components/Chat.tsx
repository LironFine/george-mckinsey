import React, { useState, useRef, useEffect } from 'react';
import { User as FirebaseUser } from 'firebase/auth';
import { motion, AnimatePresence } from 'motion/react';
import { Send, User, Bot, Loader2, Paperclip, Sparkles, FileText, LayoutList, Calendar, ExternalLink, RefreshCw, ClipboardList, Mic, MicOff, Volume2, Mic2, Cloud } from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Message } from '../types';
import { sendMessageToGemini } from '../services/gemini';
import { INITIAL_MESSAGE } from '../constants';
import { voiceService } from '../services/voiceService';
import { checkAndIncrementUsage, checkVoiceMinutesAvailable, recordVoiceUsage, setVisitorId, incrementDemoTextUsage, incrementDemoVoiceUsage } from '../services/usageService';
import { saveSession, loadSession } from '../services/historyService';

export default function Chat({ externalInput, user, isDemo }: { externalInput?: string; user?: FirebaseUser | null; isDemo?: boolean }) {
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
  const [cloudStatus, setCloudStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [demoExhausted, setDemoExhausted] = useState(false);
  const [demoWarning, setDemoWarning] = useState<string | null>(null);
  const voiceStartTimeRef = useRef<number>(0);
  // Always-fresh messages ref — updated synchronously every render so voice
  // callbacks (onClose) always read the latest messages, even before React re-renders
  const messagesRef = useRef<Message[]>(messages);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  // Debounce timer for Firestore auto-save
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track whether we've already loaded history for the current user (avoid double-load)
  const loadedUidRef = useRef<string | null>(null);
  // Prevent re-triggering auto-save when an error state is set
  const saveErrorShownRef = useRef(false);
  // Prevent saving immediately after loading history from Firestore
  const justLoadedRef = useRef(false);

  // ── Load history when user signs in ────────────────────────────────────────
  useEffect(() => {
    if (!user) { loadedUidRef.current = null; return; }
    if (loadedUidRef.current === user.uid) return; // already loaded this session
    loadedUidRef.current = user.uid;

    // Tie usage limits to the Google account
    setVisitorId(user.uid);

    loadSession(user.uid).then((session) => {
      if (session && session.messages.length > 1) {
        justLoadedRef.current = true; // skip the next auto-save (it's a load, not a change)
        setMessages(session.messages);
        if (session.clientName) setClientName(session.clientName);
        console.log('[Chat] history restored from Firestore');
      } else {
        // Pre-fill client name from Google profile on first use
        if (user.displayName) setClientName(user.displayName);
      }
    });
  }, [user?.uid]); // eslint-disable-line

  // ── Auto-save to Firestore whenever messages change (2 s debounce) ─────────
  useEffect(() => {
    if (!user || messages.length <= 1) return;
    // Skip the very first trigger that fires right after loading from Firestore
    if (justLoadedRef.current) { justLoadedRef.current = false; return; }
    // Don't re-trigger the save cycle if there's already a known error
    if (saveErrorShownRef.current) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    setCloudStatus('saving');
    saveTimerRef.current = setTimeout(async () => {
      const ok = await saveSession(user.uid, messages, clientName);
      saveTimerRef.current = null;
      if (ok) {
        setCloudStatus('saved');
        // Reset to idle after 3 s so the indicator fades out
        setTimeout(() => setCloudStatus('idle'), 3000);
      } else {
        // Mark error once — don't add a chat message (that would re-trigger this effect)
        setCloudStatus('error');
        saveErrorShownRef.current = true;
        console.error('[Chat] Firestore auto-save failed — check Firebase console / rules');
      }
    }, 2000);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [messages, user?.uid, clientName]); // eslint-disable-line

  // Reset the error flag when the user signs in/out so a fresh session can retry
  useEffect(() => {
    saveErrorShownRef.current = false;
    setCloudStatus('idle');
  }, [user?.uid]);
  // ───────────────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (externalInput) {
      handleSend(externalInput);
    }
  }, [externalInput]);

  // Auto-start voice when opened via mic button from iframe (?autovoice=1)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('autovoice') !== '1') return;
    const t = setTimeout(() => { toggleVoice(); }, 800);
    return () => clearTimeout(t);
  }, []); // eslint-disable-line

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
      if (isDemo && user) {
        const { allowed, remaining } = await incrementDemoTextUsage(user.uid);
        if (!allowed) {
          triggerDemoEnd();
          return;
        }
        if (remaining <= 3 && remaining > 0) {
          setDemoWarning(`נותרו לך ${remaining} הודעות בגרסת הניסיון`);
        }
      } else {
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

        if (remaining === 10) {
          const warningMessage: Message = {
            id: 'warning-' + Date.now(),
            role: 'assistant',
            content: 'שים לב: נותרו לך 10 הודעות אחרונות למכסה היומית. אני מבצע כעת גיבוי אוטומטי של תיק הלקוח שלך.',
            timestamp: Date.now(),
          };
          setMessages((prev) => [...prev, warningMessage]);
          setTimeout(() => handleUpdateClientFile(), 1000);
        }
      }
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
    if (isDemo) {
      alert('העלאת תיק לקוח זמינה למנויים בלבד.\nהירשם כמנוי כדי ליהנות מכל הכלים.');
      return;
    }
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

  const handleUpdateClientFile = async (
    providedName?: string,
    messagesOverride?: Message[],
    voiceHistoryOverride?: { role: string; content: string }[]
  ) => {
    // Use messagesRef.current (not the closure-captured `messages`) so we always
    // get the latest messages even when called from a stale voice callback.
    const currentMessages = messagesOverride || messagesRef.current;
    const hasHistory = currentMessages.length > 1;
    // Use the snapshot taken at command-fire time when available; otherwise
    // read live (for button-click path)
    const voiceHistory = voiceHistoryOverride ?? voiceService.getHistory();
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
        // Separate voice-only user transcriptions (from Web Speech API)
        const voiceUserLines = voiceHistory
          .filter((v) => v.role === "user")
          .map((v) => `• ${v.content}`);
        const hasVoiceUserLines = voiceUserLines.length > 0;

        // Build the history to send (text messages only — voice messages
        // appear in currentMessages already if transcription was active)
        const combinedHistory = [...currentMessages];

        let summaryContent: string;

        if (hasVoiceUserLines && !hasHistory) {
          // Voice-only session: we have what the user said but not the AI's
          // responses (native audio model can't output text). Ask Gemini to
          // reconstruct both sides based on the user's questions and its role.
          summaryContent = `[בקשת API ליצירת מסמך טקסטואלי — יש לכתוב את הסיכום המלא]

ניהלתי שיחה קולית עם ${finalName}.

להלן הנושאים והשאלות שהעלה ${finalName} במהלך השיחה הקולית:
${voiceUserLines.join('\n')}

כתוב תיעוד מקצועי של הפגישה בגוף ראשון, כאילו אתה ג'ורג' מקינזי מסכם אותה.
התיעוד יכלול:
1. הנושאים המרכזיים שעלו בשיחה.
2. הייעוץ האסטרטגי שנתת בכל נושא (בהתאם לשאלות שנשאלו ולגישתך המקינזייאנית).
3. המלצות ברורות לצעדים הבאים.

אל תוסיף הקדמות. התחל ישירות בתיעוד המקצועי.`;
        } else {
          // Text session (or mixed): standard summary from full history
          if (hasVoiceUserLines) {
            // Append voice topics at the end of the prompt as extra context
            combinedHistory.push({
              id: `voice-ctx-${Date.now()}`,
              role: 'user' as const,
              content: `בנוסף לשיחה הטקסטואלית, ניהלנו גם שיחה קולית. נושאים שעלו בשיחה הקולית:\n${voiceUserLines.join('\n')}`,
              timestamp: Date.now(),
            });
          }

          summaryContent = `[בקשת API ליצירת מסמך טקסטואלי — יש לכתוב את התיעוד המלא]

ערוך תיעוד מפורט ומקצועי של השיחה שלנו עבור הארכיון של ${finalName}.

חשוב מאוד: התבסס אך ורק על המידע שנאמר בשיחה הנוכחית. אל תמציא נושאים שלא דיברנו עליהם.

התיעוד צריך לכלול:
1. פירוט נושאי השיחה העיקריים.
2. נקודות חשובות והחלטות שהתקבלו.
3. המלצות אסטרטגיות להמשך המבוססות על השיחה.

כתוב את התיעוד בצורה תמציתית אך מקיפה. אל תוסיף הקדמות, פשוט התחל בתוכן המקצועי.`;
        }

        const summaryPrompt: Message = {
          id: 'summary-request',
          role: 'user',
          content: summaryContent,
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

      // Also persist to Firestore if the user is signed in
      if (user) {
        await saveSession(user.uid, messagesRef.current, finalName);
      }

      const cloudNote = user ? ' הוא גם נשמר אוטומטית בענן.' : '';
      const assistantMessage: Message = {
        id: Date.now().toString(),
        role: 'assistant',
        content: hasHistory || hasVoiceHistory
          ? `הכנתי את העדכון לתיק הלקוח של ${finalName} (כולל סיכום של השיחה הקולית). המסמך ירד כעת למחשבך.${cloudNote}`
          : `יצרתי עבורך מסמך בסיס לתיק הלקוח של ${finalName}. תוכל להשתמש בו לתיעוד בהמשך.${cloudNote}`,
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

  // Keep messagesRef in sync every render so onClose can read latest messages
  messagesRef.current = messages;

  const handleDownloadBrief = async () => {
    if (isDemo) {
      alert('הורדת בריף לקופי זמינה למנויים בלבד.\nהירשם כמנוי כדי ליהנות מכל הכלים.');
      return;
    }
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
        content: `הבריף לקופירייטרים הוכן והורד למחשבך. אפשר להעביר להם אותו.`,
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

  const triggerDemoEnd = async () => {
    setDemoExhausted(true);
    setDemoWarning(null);
    const endMessage: Message = {
      id: 'demo-end-' + Date.now(),
      role: 'assistant',
      content: `הגעת לסוף גרסת הניסיון החינמית של ג'ורג'.\n\nכדי להמשיך ליהנות מכל הכלים — שיחות קוליות, תיקי לקוח, בריפים ועוד — הירשם כמנוי:\n\n**[הירשם כמנוי](https://www.pirsoomai.com/pricing-plans/list)**`,
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, endMessage]);

    try {
      const summaryPrompt: Message = {
        id: 'demo-summary',
        role: 'user',
        content: 'סכם את השיחה הזו בקצרה — עיקרי הנושאים שדנו בהם.',
        timestamp: Date.now(),
      };
      const summary = await sendMessageToGemini([...messages, summaryPrompt]);
      const content = `--- גרסת ניסיון חינמית של ג'ורג' ---\nהשיחה הזו נוצרה בגרסת הניסיון החינמית.\nכדי להמשיך ליהנות מכל הכלים, הירשם כמנוי:\nhttps://www.pirsoomai.com/pricing-plans/list\n---\n\n${summary}`;
      const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `סיכום שיחה - גרסת ניסיון ג'ורג'.txt`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Failed to generate demo summary:', err);
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
    // Allow a fresh load if user wants to return to their cloud history later
    loadedUidRef.current = null;
    // If signed in, immediately overwrite cloud with the empty/fresh session
    if (user) saveSession(user.uid, [{
      id: '1', role: 'assistant', content: INITIAL_MESSAGE, timestamp: Date.now()
    }], '');
  };

  const toggleVoice = async () => {
    if (isDemo) {
      alert('שיחה קולית זמינה למנויים בלבד.\nהירשם כמנוי כדי ליהנות מכל הכלים.');
      return;
    }

    if (isVoiceActive) {
      voiceService.stop();
      recordVoiceUsage(voiceStartTimeRef.current);
      setIsVoiceActive(false);
    } else {
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

      // Check monthly voice minutes limit (90 min ≈ 8 ₪)
      const { allowed, remainingMinutes, resetDays } = await checkVoiceMinutesAvailable();
      if (!allowed) {
        setMessages((prev) => [
          ...prev,
          {
            id: Date.now().toString(),
            role: 'assistant',
            content: `נגמרו לך דקות השיחה הקולית החודשיות (90 דקות). המכסה תתחדש בעוד ${resetDays} ימים. ניתן להמשיך בצ'אט הטקסטואלי ללא הגבלה.`,
            timestamp: Date.now(),
          } as Message,
        ]);
        return;
      }

      // Warn if fewer than 10 minutes remain
      if (remainingMinutes <= 10) {
        setMessages((prev) => [
          ...prev,
          {
            id: `voice-warn-${Date.now()}`,
            role: 'assistant',
            content: `שים לב: נותרו לך כ-${remainingMinutes} דקות שיחה קולית החודש.`,
            timestamp: Date.now(),
          } as Message,
        ]);
      }

      voiceStartTimeRef.current = Date.now();
      setIsVoiceActive(true);

      await voiceService.start({
        history: messages,
        onTranscription: (text, role) => {
          const voiceMsg: Message = {
            id: `voice-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            role: role === 'model' ? 'assistant' : 'user',
            content: text,
            timestamp: Date.now(),
            isVoice: true,
          };
          setMessages((prev) => [...prev, voiceMsg]);
        },
        onError: (err) => {
          console.error(err);
          recordVoiceUsage(voiceStartTimeRef.current);
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
          recordVoiceUsage(voiceStartTimeRef.current);
          setIsVoiceActive(false);
          // Immediate cloud-save when voice ends (bypass the 2 s debounce)
          if (user) saveSession(user.uid, messagesRef.current, clientName);
        },
      });
    }
  };

  // Detect if running inside an iframe (e.g. Wix embed)
  const isInIframe = window.self !== window.top;

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
                  {/* Voice indicator badge */}
                  {message.isVoice && (
                    <span className="inline-flex items-center gap-1 text-[10px] opacity-50 mb-1">
                      <Mic2 size={10} />
                      <span>קולי</span>
                    </span>
                  )}
                  <div className="markdown-body">
                    <Markdown
                      remarkPlugins={[remarkGfm]}
                      components={message.role === 'assistant' ? {
                        // Bold text in assistant messages becomes a clickable chip
                        strong({ children }) {
                          const text = String(children);
                          return (
                            <button
                              type="button"
                              onClick={() => handleSend(text)}
                              className="inline-block px-2.5 py-0.5 mx-0.5 my-0.5 bg-blue-50 hover:bg-blue-100 active:bg-blue-200 text-blue-700 border border-blue-200 rounded-full text-[0.88em] font-medium cursor-pointer transition-colors"
                              title={`לחץ לשליחה: ${text}`}
                            >
                              {text}
                            </button>
                          );
                        }
                      } : undefined}
                    >
                      {message.content}
                    </Markdown>
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
        {demoWarning && (
          <div className="max-w-4xl mx-auto mb-2 px-4 py-2 bg-amber-50 border border-amber-200 rounded-xl text-center text-xs text-amber-700 font-medium">
            {demoWarning} — <a href="https://www.pirsoomai.com/pricing-plans/list" target="_blank" rel="noopener noreferrer" className="underline font-bold">הירשם כמנוי</a>
          </div>
        )}

        {demoExhausted ? (
          <div className="max-w-4xl mx-auto text-center py-6">
            <p className="text-slate-600 mb-4 text-sm">גרסת הניסיון החינמית הסתיימה. הסיכום הורד למחשבך.</p>
            <a
              href="https://www.pirsoomai.com/pricing-plans/list"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block px-8 py-3 bg-blue-600 text-white rounded-xl font-bold hover:bg-blue-700 transition-colors shadow-lg"
            >
              הירשם כמנוי כדי להמשיך
            </a>
          </div>
        ) : (<>

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
            onClick={() => {
              // In iframe: open new window with autovoice flag instead of starting locally
              if (isInIframe && !isVoiceActive) {
                const url = new URL(window.location.href);
                url.searchParams.set('autovoice', '1');
                window.open(url.toString(), '_blank');
                return;
              }
              toggleVoice();
            }}
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
            {user ? <Cloud size={12} className="sm:w-[14px] sm:h-[14px]" /> : <LayoutList size={12} className="sm:w-[14px] sm:h-[14px]" />}
            <span className="truncate">{user ? 'שמור + הורד' : 'עדכון תיק לקוח'}</span>
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
        </>)}

        <div className="text-center mt-3 text-[10px] text-slate-400 flex items-center justify-center gap-2">
          <Sparkles size={10} />
          <span>מופעל על ידי בינה מלאכותית אסטרטגית</span>
          {user && cloudStatus !== 'idle' && (
            <span className={`flex items-center gap-1 transition-all ${
              cloudStatus === 'saving' ? 'text-slate-400' :
              cloudStatus === 'saved'  ? 'text-green-500' :
              'text-red-500'
            }`}>
              <Cloud size={10} className={cloudStatus === 'saving' ? 'animate-pulse' : ''} />
              {cloudStatus === 'saving' && 'שומר...'}
              {cloudStatus === 'saved'  && 'נשמר ✓'}
              {cloudStatus === 'error'  && 'שגיאת שמירה — בדוק F12'}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
