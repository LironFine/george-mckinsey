export class VoiceService {
  private ws: WebSocket | null = null;
  private inputContext: AudioContext | null = null;  // 16kHz — mic capture
  private audioContext: AudioContext | null = null;  // 24kHz — playback only
  private workletNode: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private stream: MediaStream | null = null;
  private nextStartTime: number = 0;
  private isConnected: boolean = false;
  private activeSources: AudioBufferSourceNode[] = [];
  private history: { role: string; content: string }[] = [];
  private inputTranscriptBuffer: string = "";   // accumulates user speech (Web Speech API)
  private outputTranscriptBuffer: string = "";  // accumulates model speech (Gemini TEXT modality)
  private recognition: any = null;             // Web Speech API instance
  private isBargingIn: boolean = false;        // true while user is interrupting — block incoming audio
  private bargingInTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {}

  getHistory() {
    return this.history;
  }

  async start(callbacks: {
    history?: any[];
    onTranscription?: (text: string, role: "user" | "model") => void;
    onVoiceCommand?: (command: "updateClientFile") => void;
    onError?: (error: any) => void;
    onClose?: () => void;
  }) {
    if (this.isConnected) return;
    this.history = [];
    this.inputTranscriptBuffer = "";
    this.outputTranscriptBuffer = "";

    try {
      // Connect to our backend WebSocket proxy
      // The backend holds the API key and proxies to Gemini Live
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${protocol}//${window.location.host}/api/voice-ws`;

      this.ws = new WebSocket(wsUrl);

      // Wait for "ready" signal — means Gemini session is open on the backend
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("פסק זמן בהתחברות לשרת הקולי")),
          20000
        );

        this.ws!.onmessage = (event) => {
          try {
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
          } catch {}
        };

        this.ws!.onerror = () => {
          clearTimeout(timeout);
          reject(new Error("שגיאה בחיבור לשרת הקולי"));
        };

        this.ws!.onclose = () => {
          clearTimeout(timeout);
          if (!this.isConnected) {
            reject(new Error("החיבור נסגר לפני שנפתח"));
          } else {
            this.isConnected = false;
            callbacks.onClose?.();
          }
        };
      });

      // Switch to normal message handler once connected
      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "message") {
            this.handleGeminiMessage(msg.data, callbacks);
          } else if (msg.type === "error") {
            console.error("Gemini error:", msg.error);
          }
        } catch {}
      };

      this.ws.onclose = () => {
        const wasConnected = this.isConnected;
        this.isConnected = false;
        if (wasConnected) {
          callbacks.onError?.(new Error("השיחה הקולית הסתיימה באופן בלתי צפוי. אנא נסה שוב."));
        } else {
          callbacks.onClose?.();
        }
      };

      this.isConnected = true;

      // 24kHz context — playback only (matches Gemini's output format)
      this.audioContext = new (window.AudioContext ||
        (window as any).webkitAudioContext)({ sampleRate: 24000 });

      // 16kHz context — mic capture only (matches Gemini's expected input format)
      // Using a separate context ensures the PCM we send is actually 16kHz,
      // matching the mimeType "audio/pcm;rate=16000" we declare to Gemini.
      this.inputContext = new (window.AudioContext ||
        (window as any).webkitAudioContext)({ sampleRate: 16000 });

      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.source = this.inputContext.createMediaStreamSource(this.stream);

      await this.inputContext.audioWorklet.addModule("/audio-processor.js");
      this.workletNode = new AudioWorkletNode(
        this.inputContext,
        "microphone-processor"
      );

      this.workletNode.port.onmessage = (event) => {
        if (!this.isConnected || !this.ws) return;
        const { rms, channelData } = event.data;

        // Interrupt AI speech when user starts talking.
        // Threshold 0.05 (was 0.01) — avoids false triggers from background noise.
        // isBargingIn flag blocks new audio chunks until Gemini confirms the interruption.
        if (rms > 0.05 && !this.isBargingIn) {
          this.stopPlayback();
          this.startBargingIn();
        }

        const pcmData = this.float32ToInt16(new Float32Array(channelData));
        const base64Data = this.arrayBufferToBase64(pcmData.buffer);

        try {
          this.ws!.send(
            JSON.stringify({
              type: "audio",
              payload: {
                audio: { data: base64Data, mimeType: "audio/pcm;rate=16000" },
              },
            })
          );
        } catch (err) {
          console.error("Error sending audio chunk:", err);
        }
      };

      // Connect mic → worklet (no need to connect to destination — capture only)
      this.source.connect(this.workletNode);

      // ── Web Speech API for user speech transcription ─────────────────────
      // Runs in parallel with audio streaming; Chrome transcribes what the
      // user says and we save it to history / surface in the chat UI.
      const SpeechRecognition =
        (window as any).SpeechRecognition ||
        (window as any).webkitSpeechRecognition;

      if (SpeechRecognition) {
        this.recognition = new SpeechRecognition();
        this.recognition.lang = "he-IL";
        this.recognition.continuous = true;
        this.recognition.interimResults = false;

        this.recognition.onresult = (event: any) => {
          for (let i = event.resultIndex; i < event.results.length; i++) {
            if (event.results[i].isFinal) {
              const text = event.results[i][0].transcript.trim();
              if (!text || !this.isConnected) continue;

              // ── Detect voice commands ──────────────────────────────────
              // Strip punctuation AND the Hebrew direct-object marker "את"
              // so "תוריד לי את תיק הלקוח" → "תוריד לי תיק הלקוח"
              const lower = text
                .replace(/[.,!?'"]/g, "")
                .replace(/\bאת\b/g, "")
                .replace(/\s+/g, " ")
                .trim();

              const hasAction =
                lower.includes("עדכן") || lower.includes("תעדכן") ||
                lower.includes("עדכון") || lower.includes("הכן") ||
                lower.includes("תכין") || lower.includes("הכינו") ||
                lower.includes("הורד") || lower.includes("תוריד") ||
                lower.includes("להוריד") || lower.includes("צור") ||
                lower.includes("תצור") || lower.includes("שלח") ||
                lower.includes("תשלח") || lower.includes("תעשה") ||
                lower.includes("תעשי");

              const hasSubject =
                lower.includes("תיק לקוח") || lower.includes("תיק") ||
                lower.includes("סיכום") || lower.includes("לסכם") ||
                lower.includes("לסכום");

              const isUpdateCommand = hasAction && hasSubject;

              if (isUpdateCommand) {
                // Let Chat.tsx decide what to tell Gemini (depends on whether
                // the client name is already known or needs to be asked)
                callbacks.onVoiceCommand?.("updateClientFile");
                // Don't add to transcription — it's a command, not content
                continue;
              }
              // ─────────────────────────────────────────────────────────

              this.inputTranscriptBuffer = text;
              this.flushInputTranscript(callbacks);
            }
          }
        };

        // Auto-restart recognition if it stops (happens periodically in Chrome)
        this.recognition.onend = () => {
          if (this.isConnected) {
            try { this.recognition?.start(); } catch {}
          }
        };

        this.recognition.onerror = (e: any) => {
          // "aborted" = we stopped it ourselves; "no-speech" = normal silence
          if (e.error !== "aborted" && e.error !== "no-speech" && this.isConnected) {
            try { this.recognition?.start(); } catch {}
          }
        };

        try { this.recognition.start(); } catch {}
      }
      // ─────────────────────────────────────────────────────────────────────

      // Send immediate greeting — fire as soon as session is ready
      setTimeout(() => {
        if (this.isConnected && this.ws) {
          this.ws.send(
            JSON.stringify({
              type: "text",
              payload: {
                text: "אמור עכשיו בדיוק את המשפט הזה ולא יותר: 'אני כאן, אפשר לדבר איתי.' ואז השתתק ותקשיב.",
              },
            })
          );
        }
      }, 200);

      // Send prior chat history as context
      const history = callbacks.history || [];
      if (history.length > 0) {
        setTimeout(() => {
          if (!this.isConnected || !this.ws) return;
          let historyText = history
            .map(
              (m: any) =>
                `${m.role === "assistant" ? "ג'ורג' מקינזי" : "משתמש"}: ${m.content}`
            )
            .join("\n");
          if (historyText.length > 10000) {
            historyText =
              historyText.substring(historyText.length - 10000) +
              "... (היסטוריה מקוצרת)";
          }
          this.ws!.send(
            JSON.stringify({
              type: "text",
              payload: {
                text: `להלן היסטוריית השיחה עד כה. אנא המשך מהנקודה הזו:\n${historyText}`,
              },
            })
          );
        }, 1200);
      }
    } catch (err) {
      console.error("Failed to start voice session:", err);
      callbacks.onError?.(err);
    }
  }

  private handleGeminiMessage(
    message: any,
    callbacks: { onTranscription?: (text: string, role: "user" | "model") => void }
  ) {
    // ── Model turn: play audio chunks ───────────────────────────────────────
    // (Native audio model — no TEXT modality available; user transcription
    //  is handled separately via Web Speech API)
    const parts = message.serverContent?.modelTurn?.parts || [];
    for (const part of parts) {
      if (part?.inlineData?.data) {
        this.playAudioChunk(part.inlineData.data);
      }
    }

    // ── Turn complete — George finished speaking, ready for next exchange ───
    if (message.serverContent?.turnComplete) {
      this.stopBargingIn();
    }

    // ── Interruption confirmed by Gemini — stop playback, allow new audio ───
    if (message.serverContent?.interrupted) {
      this.stopPlayback();
      this.stopBargingIn();
    }
  }

  private flushOutputTranscript(
    callbacks: { onTranscription?: (text: string, role: "user" | "model") => void }
  ) {
    const text = this.outputTranscriptBuffer.trim();
    if (text) {
      this.history.push({ role: "assistant", content: text });
      callbacks.onTranscription?.(text, "model");
    }
    this.outputTranscriptBuffer = "";
  }

  private flushInputTranscript(
    callbacks: { onTranscription?: (text: string, role: "user" | "model") => void }
  ) {
    const text = this.inputTranscriptBuffer.trim();
    if (text) {
      this.history.push({ role: "user", content: text });
      callbacks.onTranscription?.(text, "user");
    }
    this.inputTranscriptBuffer = "";
  }

  private startBargingIn() {
    this.isBargingIn = true;
    // Safety reset: if Gemini doesn't send interrupted/turnComplete within
    // 1.5s (e.g. user spoke between George's turns), unblock automatically
    if (this.bargingInTimer) clearTimeout(this.bargingInTimer);
    this.bargingInTimer = setTimeout(() => {
      this.isBargingIn = false;
      this.bargingInTimer = null;
    }, 1500);
  }

  private stopBargingIn() {
    this.isBargingIn = false;
    if (this.bargingInTimer) {
      clearTimeout(this.bargingInTimer);
      this.bargingInTimer = null;
    }
  }

  private playAudioChunk(base64Data: string) {
    // Don't queue audio while the user is interrupting —
    // prevents mid-sentence restarts after barge-in
    if (!this.audioContext || this.isBargingIn) return;

    const binaryString = atob(base64Data);
    const len = binaryString.length;
    const bytes = new Int16Array(len / 2);
    for (let i = 0; i < len; i += 2) {
      bytes[i / 2] =
        (binaryString.charCodeAt(i + 1) << 8) | binaryString.charCodeAt(i);
    }

    const float32Data = new Float32Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) {
      float32Data[i] = bytes[i] / 32768.0;
    }

    const audioBuffer = this.audioContext.createBuffer(
      1,
      float32Data.length,
      24000
    );
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
    if (this.nextStartTime < currentTime) {
      this.nextStartTime = currentTime + 0.1;
    }
    source.start(this.nextStartTime);
    this.nextStartTime += audioBuffer.duration;
  }

  private stopPlayback() {
    this.activeSources.forEach((source) => {
      try {
        source.stop();
      } catch {}
    });
    this.activeSources = [];
    this.nextStartTime = 0;
  }

  async sendTextMessage(text: string) {
    if (!this.isConnected || !this.ws) return;
    try {
      this.ws.send(JSON.stringify({ type: "text", payload: { text } }));
    } catch (err) {
      console.error("Failed to send text to voice session:", err);
    }
  }

  stop() {
    this.isConnected = false;
    this.inputTranscriptBuffer = "";
    this.outputTranscriptBuffer = "";
    this.stopBargingIn();
    try { this.recognition?.stop(); } catch {}
    this.recognition = null;

    try {
      this.ws?.close();
    } catch {}
    this.ws = null;

    if (this.workletNode) {
      this.workletNode.disconnect();
      this.workletNode = null;
    }
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }
    if (this.inputContext) {
      this.inputContext.close();
      this.inputContext = null;
    }
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
  }

  private float32ToInt16(buffer: Float32Array): Int16Array {
    let l = buffer.length;
    const buf = new Int16Array(l);
    while (l--) {
      buf[l] = Math.min(1, buffer[l]) * 0x7fff;
    }
    return buf;
  }

  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    let binary = "";
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }
}

export const voiceService = new VoiceService();
