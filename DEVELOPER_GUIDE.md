# מדריך טכני — שיחה קולית עם Gemini Live API + Full-Stack Deployment

**נכתב עבור המפתח המקורי של האפליקציה**
**תאריך:** אפריל 2026

---

## רקע

האפליקציה נבנתה ב-AI Studio כ-SPA (Single Page Application) עם React + Vite.
כשניסינו להפעיל אותה מחוץ ל-AI Studio — היא לא עבדה בכלל.
שתי בעיות מרכזיות:

1. **Firebase** היה מחובר לפרויקט של AI Studio — קרש מחוץ לסביבה הזו
2. **שיחה קולית** — לא עבדה בכלל, כי היא דרשה ארכיטקטורה שונה לחלוטין

מסמך זה מסביר כיצד תוקנו שתי הבעיות, ומה בדיוק צריך לעשות באפליקציה זו ובאפליקציות דומות.

---

## חלק א' — הפיכת האפליקציה ל-Full-Stack

### הבעיה: Firebase מחוץ ל-AI Studio

AI Studio מספק Firebase אוטומטית לאפליקציות שנבנות בו. אבל כשמפיצים את האפליקציה מחוץ לסביבה זו — Firebase נשבר, כי:
- Project credentials שייכים ל-AI Studio
- אין גישה לאותה Firestore database
- האפליקציה קורסת כבר בטעינה

### הפתרון: מחיקת Firebase, החלפה ב-localStorage

**שלב 1 — רוקנו את `src/lib/firebase.ts`:**

```typescript
// src/lib/firebase.ts — stub file (Firebase removed)
export const db = null;
export const auth = null;
```

**שלב 2 — שכתבנו את `src/services/usageService.ts`:**

במקום Firestore, כל מעקב שימוש נשמר ב-localStorage של הדפדפן:

```typescript
const DAILY_LIMIT = 100;
const MONTHLY_VOICE_LIMIT = 30;

export async function checkAndIncrementUsage(): Promise<{ allowed: boolean; remaining: number }> {
  const today = new Date().toISOString().split('T')[0]; // "2026-04-15"
  
  let visitorId = localStorage.getItem('george_visitor_id');
  if (!visitorId) {
    visitorId = Math.random().toString(36).substring(2, 15);
    localStorage.setItem('george_visitor_id', visitorId);
  }

  const key = `usage_${today}_${visitorId}`;
  const count = parseInt(localStorage.getItem(key) || '0', 10);

  if (count >= DAILY_LIMIT) return { allowed: false, remaining: 0 };

  localStorage.setItem(key, String(count + 1));
  return { allowed: true, remaining: DAILY_LIMIT - (count + 1) };
}

export async function checkAndIncrementVoiceUsage(): Promise<{
  allowed: boolean;
  remaining: number;
  resetDays: number;
}> {
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  
  let visitorId = localStorage.getItem('george_visitor_id');
  if (!visitorId) {
    visitorId = Math.random().toString(36).substring(2, 15);
    localStorage.setItem('george_visitor_id', visitorId);
  }

  const key = `voice_usage_${month}_${visitorId}`;
  const count = parseInt(localStorage.getItem(key) || '0', 10);

  const firstOfNextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const resetDays = Math.ceil((firstOfNextMonth.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));

  if (count >= MONTHLY_VOICE_LIMIT) return { allowed: false, remaining: 0, resetDays };

  localStorage.setItem(key, String(count + 1));
  return { allowed: true, remaining: MONTHLY_VOICE_LIMIT - (count + 1), resetDays };
}
```

> **הערה:** localStorage מוגבל לדפדפן של המשתמש — אין הגנה מפני עקיפה. לאפליקציה ציבורית רצינית מומלץ להחליף זאת ב-backend database (PostgreSQL, Redis, Firestore עם credentials חדשים וכו').

---

### הפיכת האפליקציה ל-Full-Stack

האפליקציה כבר כללה `server.ts` עם Express. מה שעשינו:

**`server.ts` — ה-backbone של הכל:**
- משרת את ה-React SPA ב-production (`dist/`)
- משמש כ-Vite dev server ב-development
- מחזיק את מפתח ה-API בצד השרת (לא נחשף ל-browser)
- מספק REST endpoint לטקסט chat (`/api/chat`)
- מספק WebSocket proxy לשיחה קולית (`/api/voice-ws`)

**`package.json` — scripts קריטיים:**

```json
{
  "scripts": {
    "dev": "npx tsx server.ts",
    "start": "NODE_ENV=production npx tsx server.ts",
    "build": "vite build"
  },
  "engines": { "node": ">=18" }
}
```

**`railway.json` — קובץ deployment:**

```json
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": { "builder": "NIXPACKS" },
  "deploy": {
    "startCommand": "npm run build && npm start",
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 10
  }
}
```

---

### Deployment ל-Railway

1. Push הקוד ל-GitHub (כולל `railway.json`)
2. ב-Railway: New Project → Deploy from GitHub repo → בחר הריפו
3. הוסף Environment Variable: `GEMINI_API_KEY=<your key>`
4. **אל תמחק את `package-lock.json` אם הוא מסונכרן** — אם לא, מחק אותו מהריפו כדי ש-Railway יריץ `npm install`
5. Railway יבנה אוטומטית בכל push

**PORT:** Railway מספק env variable `PORT` (בדרך כלל 8080), אבל גם מנתב ל-3000 אם `PORT` לא מוגדר. אם יש בעיה עם port — ודא שהשרת מאזין על:
```typescript
const PORT = parseInt(process.env.PORT || "3000", 10);
server.listen(PORT, "0.0.0.0", () => console.log(`Server running on port ${PORT}`));
```

---

## חלק ב' — שיחה קולית עם Gemini Live API

זו הבעיה המרכזית שגרמה לכישלון. הנה הסיפור המלא.

---

### למה הגישה הקודמת לא עבדה

הניסיון הראשון השתמש ב-`@google/genai` SDK:

```typescript
// מה שניסינו (לא עבד):
const ai = new GoogleGenAI({ apiKey });
const session = await ai.live.connect({ model: "gemini-2.0-flash", ... });
```

**הבעיה:** ב-Node.js, ה-SDK פותח סשן שנסגר מיידית — ללא שגיאה ברורה.
הניסיון השני היה לשלוח ephemeral token ל-browser ולחבר ישירות — זה גם לא עבד כי Gemini Live לא תומך ב-CORS מ-browser.

---

### הפתרון: WebSocket Proxy

הארכיטקטורה הנכונה היחידה שעובדת:

```
[Browser] ←── WebSocket ──→ [Backend Node.js] ←── WebSocket ──→ [Gemini Live API]
              /api/voice-ws                        wss://generativelanguage...
```

- ה-browser **אף פעם** לא מתחבר ישירות ל-Gemini
- מפתח ה-API נשאר על השרת בלבד
- הגישה עובדת מכל דפדפן, ללא CORS issues

---

### שלב 1: מצא איזה models תומכים ב-Live API

**זה הדבר הראשון שצריך לעשות.** אל תנחש שם מודל.

הוסף endpoint זה לשרת שלך:

```typescript
app.get("/api/live-models", async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=100`
  );
  const data = await r.json();
  const liveModels = (data.models || [])
    .filter((m: any) => m.supportedGenerationMethods?.includes("bidiGenerateContent"))
    .map((m: any) => m.name);
  res.json({ liveModels, total: liveModels.length });
});
```

פתח בדפדפן: `https://your-app.railway.app/api/live-models`

תקבל תשובה כמו:
```json
{
  "liveModels": [
    "models/gemini-2.5-flash-native-audio-latest",
    "models/gemini-2.5-flash-native-audio-preview-09-2025",
    "models/gemini-3.1-flash-live-preview"
  ],
  "total": 3
}
```

השתמש בשם הראשון ברשימה (בדרך כלל `gemini-2.5-flash-native-audio-latest`).

> **חשוב:** שמות המודלים משתנים לפי API key ולפי חשבון. אל תסמוך על שמות קשועים מתיעוד — בדוק תמיד.

---

### שלב 2: בנה את WebSocket Proxy בשרת

הוסף לקובץ `server.ts` שלך (אחרי יצירת `server = createHttpServer(app)`):

```typescript
import { WebSocketServer, WebSocket as WsClient } from "ws";

// ← חשוב: server חייב להיות createHttpServer(app), לא app ישירות
const wss = new WebSocketServer({ server, path: "/api/voice-ws" });

wss.on("connection", (ws) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    ws.send(JSON.stringify({ type: "error", error: "API key missing" }));
    ws.close();
    return;
  }

  // ← זהו ה-URL הנכון — שים לב לפורמט המדויק
  const geminiUrl =
    `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${apiKey}`;

  const geminiWs = new WsClient(geminiUrl);

  geminiWs.on("open", () => {
    // ← setup message — כל השדות חייבים להיות snake_case
    const setup = {
      setup: {
        model: "models/gemini-2.5-flash-native-audio-latest", // ← מה שקיבלת מ-/api/live-models
        generation_config: {
          response_modalities: ["AUDIO"],           // ← AUDIO בלבד, לא TEXT
          thinking_config: {
            thinking_budget: 0,                     // ← חובה ב-Gemini 2.5! בלי זה הוא "חושב בקול"
          },
          speech_config: {                          // ← חייב להיות בתוך generation_config, לא מחוצה לו
            voice_config: {
              prebuilt_voice_config: {
                voice_name: "Charon",               // ← קולות זמינים: Puck, Charon, Kore, Fenrir, Aoede
              },
            },
          },
        },
        system_instruction: {                       // ← חייב להיות אובייקט, לא string
          parts: [{ text: YOUR_SYSTEM_PROMPT }],
        },
      },
    };
    geminiWs.send(JSON.stringify(setup));
  });

  geminiWs.on("message", (data) => {
    const msg = JSON.parse(data.toString());

    // Gemini שולח setupComplete כשמוכן — מעביר "ready" ל-browser
    if (msg.setupComplete !== undefined) {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: "ready" }));
      }
      return;
    }

    // שאר ההודעות (אודיו, טקסט) — מעביר ישירות ל-browser
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "message", data: msg }));
    }
  });

  geminiWs.on("error", (err) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "error", error: err.message }));
    }
  });

  geminiWs.on("close", (code, reason) => {
    if (ws.readyState === ws.OPEN) ws.close();
  });

  // הודעות מה-browser → Gemini
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    if (geminiWs.readyState !== WsClient.OPEN) return;

    if (msg.type === "audio" && msg.payload?.audio) {
      // אודיו מהמיקרופון → Gemini
      geminiWs.send(JSON.stringify({
        realtimeInput: {
          mediaChunks: [{
            mimeType: msg.payload.audio.mimeType,  // "audio/pcm;rate=16000"
            data: msg.payload.audio.data,           // base64
          }],
        },
      }));
    } else if (msg.type === "text" && msg.payload?.text) {
      // טקסט → Gemini (לשליחת הקשר / היסטוריה)
      geminiWs.send(JSON.stringify({
        clientContent: {
          turns: [{ role: "user", parts: [{ text: msg.payload.text }] }],
          turnComplete: true,
        },
      }));
    }
  });

  ws.on("close", () => {
    if (geminiWs.readyState === WsClient.OPEN) geminiWs.close();
  });
});
```

**הוסף ל-`package.json`:**
```json
{
  "dependencies": {
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@types/ws": "^8.5.14"
  }
}
```

---

### שלב 3: צד הלקוח (Browser)

צור `src/services/voiceService.ts`:

```typescript
export class VoiceService {
  private ws: WebSocket | null = null;
  private audioContext: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private stream: MediaStream | null = null;
  private nextStartTime: number = 0;
  private isConnected: boolean = false;
  private activeSources: AudioBufferSourceNode[] = [];

  async start(callbacks: {
    history?: { role: string; content: string }[];
    onError?: (error: any) => void;
    onClose?: () => void;
  }) {
    if (this.isConnected) return;

    // ← מתחבר לשרת שלנו, לא ישירות ל-Gemini
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/api/voice-ws`;
    this.ws = new WebSocket(wsUrl);

    // ← ממתין ל-"ready" לפני שמתחיל לשלוח אודיו
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Connection timeout")),
        20000
      );

      this.ws!.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === "ready") {
          clearTimeout(timeout);
          resolve();
        } else if (msg.type === "error") {
          clearTimeout(timeout);
          reject(new Error(msg.error));
        } else if (msg.type === "message") {
          this.handleGeminiMessage(msg.data, callbacks);
        }
      };

      this.ws!.onerror = () => {
        clearTimeout(timeout);
        reject(new Error("WebSocket connection failed"));
      };

      this.ws!.onclose = () => {
        clearTimeout(timeout);
        if (!this.isConnected) {
          reject(new Error("Connection closed before ready"));
        } else {
          this.isConnected = false;
          callbacks.onClose?.();
        }
      };
    });

    // Switch to normal message handler
    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === "message") {
        this.handleGeminiMessage(msg.data, callbacks);
      }
    };

    this.ws.onclose = () => {
      const wasConnected = this.isConnected;
      this.isConnected = false;
      if (wasConnected) {
        callbacks.onError?.(new Error("Voice session ended unexpectedly"));
      } else {
        callbacks.onClose?.();
      }
    };

    this.isConnected = true;

    // ← AudioContext ב-24kHz (פורמט הפלט של Gemini)
    this.audioContext = new (window.AudioContext ||
      (window as any).webkitAudioContext)({ sampleRate: 24000 });

    // ← מיקרופון
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.source = this.audioContext.createMediaStreamSource(this.stream);

    // ← AudioWorklet לצילום PCM — קובץ זה חייב להיות ב-public/audio-processor.js
    await this.audioContext.audioWorklet.addModule("/audio-processor.js");
    this.workletNode = new AudioWorkletNode(this.audioContext, "microphone-processor");

    this.workletNode.port.onmessage = (event) => {
      if (!this.isConnected || !this.ws) return;
      const { rms, channelData } = event.data;

      // הפסקת אודיו כשהמשתמש מתחיל לדבר
      if (rms > 0.01) this.stopPlayback();

      const pcmData = this.float32ToInt16(new Float32Array(channelData));
      const base64Data = this.arrayBufferToBase64(pcmData.buffer);

      this.ws!.send(JSON.stringify({
        type: "audio",
        payload: {
          audio: { data: base64Data, mimeType: "audio/pcm;rate=16000" },
        },
      }));
    };

    this.source.connect(this.workletNode);
    this.workletNode.connect(this.audioContext.destination);

    // ← שליחת הקשר ראשוני (היסטוריה מצ'אט טקסט אם יש)
    const history = callbacks.history || [];
    if (history.length > 0) {
      setTimeout(() => {
        if (!this.isConnected || !this.ws) return;
        let historyText = history
          .map((m) => `${m.role === "assistant" ? "AI" : "User"}: ${m.content}`)
          .join("\n");
        if (historyText.length > 10000) {
          historyText = historyText.substring(historyText.length - 10000);
        }
        this.ws!.send(JSON.stringify({
          type: "text",
          payload: { text: `Here is the conversation history so far:\n${historyText}` },
        }));
      }, 1200);
    }
  }

  private handleGeminiMessage(message: any, callbacks: any) {
    // אודיו מגמיני → ניגון
    const audioData = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
    if (audioData) this.playAudioChunk(audioData);

    // Gemini ביקש להפסיק אודיו (הפרעה)
    if (message.serverContent?.interrupted) this.stopPlayback();
  }

  private playAudioChunk(base64Data: string) {
    if (!this.audioContext) return;

    // decode PCM int16 → float32
    const binaryString = atob(base64Data);
    const bytes = new Int16Array(binaryString.length / 2);
    for (let i = 0; i < binaryString.length; i += 2) {
      bytes[i / 2] = (binaryString.charCodeAt(i + 1) << 8) | binaryString.charCodeAt(i);
    }
    const float32Data = new Float32Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) float32Data[i] = bytes[i] / 32768.0;

    const audioBuffer = this.audioContext.createBuffer(1, float32Data.length, 24000);
    audioBuffer.getChannelData(0).set(float32Data);

    const source = this.audioContext.createBufferSource();
    source.buffer = audioBuffer;

    const gainNode = this.audioContext.createGain();
    gainNode.gain.value = 0.95;
    source.connect(gainNode);
    gainNode.connect(this.audioContext.destination);

    source.onended = () => {
      this.activeSources = this.activeSources.filter((s) => s !== source);
    };
    this.activeSources.push(source);

    const currentTime = this.audioContext.currentTime;
    if (this.nextStartTime < currentTime) this.nextStartTime = currentTime + 0.1;
    source.start(this.nextStartTime);
    this.nextStartTime += audioBuffer.duration;
  }

  private stopPlayback() {
    this.activeSources.forEach((source) => { try { source.stop(); } catch {} });
    this.activeSources = [];
    this.nextStartTime = 0;
  }

  stop() {
    this.isConnected = false;
    try { this.ws?.close(); } catch {}
    this.ws = null;
    this.workletNode?.disconnect();
    this.workletNode = null;
    this.source?.disconnect();
    this.source = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.audioContext?.close();
    this.audioContext = null;
  }

  private float32ToInt16(buffer: Float32Array): Int16Array {
    const buf = new Int16Array(buffer.length);
    for (let i = 0; i < buffer.length; i++) {
      buf[i] = Math.min(1, buffer[i]) * 0x7fff;
    }
    return buf;
  }

  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    let binary = "";
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }
}

export const voiceService = new VoiceService();
```

---

### שלב 4: AudioWorklet Processor

צור `public/audio-processor.js`:

```javascript
class MicrophoneProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const channelData = input[0];
    
    // חישוב RMS לזיהוי דיבור
    let sum = 0;
    for (let i = 0; i < channelData.length; i++) sum += channelData[i] ** 2;
    const rms = Math.sqrt(sum / channelData.length);

    // שליחת PCM data ל-main thread
    this.port.postMessage({
      rms,
      channelData: channelData.buffer,
    }, [channelData.buffer]);

    return true;
  }
}

registerProcessor("microphone-processor", MicrophoneProcessor);
```

---

### שלב 5: שימוש ב-Component

```typescript
// בתוך ה-React component שלך:
import { voiceService } from "../services/voiceService";

// בדיקת תמיכת דפדפן לפני הפעלה:
const isSupported = typeof WebSocket !== "undefined" &&
                    typeof AudioContext !== "undefined" &&
                    typeof AudioWorkletNode !== "undefined";

if (!isSupported) {
  alert("שיחה קולית זמינה רק ב-Chrome / Edge. אנא השתמש בדפדפן תואם.");
  return;
}

// הפעלה:
await voiceService.start({
  history: chatHistory, // מערך { role: "user" | "assistant", content: string }[]
  onError: (err) => {
    console.error("Voice error:", err);
    setIsVoiceActive(false);
  },
  onClose: () => {
    setIsVoiceActive(false);
  },
});

// עצירה:
voiceService.stop();
```

---

## ריכוז הטעויות הנפוצות (Gotchas)

| בעיה | סימפטום | פתרון |
|------|----------|--------|
| שם מודל לא נכון | "model not found" | קרא `/api/live-models` וקבל שם מדויק |
| `speech_config` במקום הלא נכון | "Unknown name speech_config at setup" | העבר לתוך `generation_config` |
| camelCase ב-setup | שדות מתעלמים / שגיאות | השתמש ב-snake_case בלבד |
| `systemInstruction` כ-string | סשן נסגר מיידית | שנה לאובייקט `{ parts: [{ text: "..." }] }` |
| Gemini 2.5 מדבר בקול | טקסט thinking מגיע כאודיו | הוסף `thinking_config: { thinking_budget: 0 }` |
| SDK `ai.live.connect()` ב-Node.js | סשן נפתח ומיד נסגר | אל תשתמש ב-SDK — השתמש ב-`ws` package ישירות |
| חיבור ישיר מ-browser ל-Gemini | CORS error | חובה proxy דרך השרת |
| `package-lock.json` לא מסונכרן ב-Railway | `npm ci` נכשל | מחק `package-lock.json` מהריפו |

---

## קולות זמינים ב-Gemini Live

```
Puck    — צעיר, שנון
Charon  — עמוק, סמכותי
Kore    — נשי, רגוע
Fenrir  — גברי, חזק
Aoede   — נשי, מלודי
```

לשינוי קול — שנה `voice_name` ב-`setup` ב-`server.ts`.

---

## תרשים ארכיטקטורה מלא

```
┌─────────────────────────────────────────────────────────┐
│                      Browser                             │
│                                                         │
│  React Component                                        │
│       │                                                 │
│  voiceService.ts ──── WebSocket ws://host/api/voice-ws  │
│       │                                                 │
│  AudioContext (24kHz)                                   │
│  AudioWorklet ──── captures mic at 16kHz PCM            │
└────────────────────────────────┬────────────────────────┘
                                 │
                    WebSocket (our server)
                                 │
┌────────────────────────────────▼────────────────────────┐
│                   Node.js Server (Railway)               │
│                                                         │
│  Express                                                │
│    /api/chat     ──── REST → Gemini generateContent     │
│    /api/live-models ── REST → Gemini models list        │
│                                                         │
│  WebSocketServer (/api/voice-ws)                        │
│    WS Proxy ──────── WebSocket → Gemini Live API        │
│    API key stored here only                             │
└─────────────────────────────────────────────────────────┘
                                 │
              wss://generativelanguage.googleapis.com/ws/...
                                 │
┌────────────────────────────────▼────────────────────────┐
│                    Gemini Live API                       │
│  model: gemini-2.5-flash-native-audio-latest            │
│  voice: Charon                                          │
└─────────────────────────────────────────────────────────┘
```

---

## רשימת קבצים שיצרנו / שינינו

```
mckinsey-deploy/
├── server.ts                          ← הוסף WebSocket proxy
├── railway.json                       ← חדש
├── package.json                       ← הוסף ws + @types/ws
├── public/
│   └── audio-processor.js             ← חדש
├── src/
│   ├── lib/
│   │   └── firebase.ts                ← stub בלבד (export const db = null)
│   ├── services/
│   │   ├── voiceService.ts            ← שכתוב מלא
│   │   └── usageService.ts            ← Firebase → localStorage
│   └── components/
│       └── Chat.tsx                   ← הוסף browser check + voice limit UI
```

---

*מסמך זה כולל את כל מה שנדרש לשחזר שיחה קולית עובדת עם Gemini Live API בכל אפליקציה React+Express דומה.*
