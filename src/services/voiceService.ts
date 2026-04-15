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

  constructor() {}

  getHistory() {
    return this.history;
  }

  async start(callbacks: {
    history?: any[];
    onTranscription?: (text: string, role: "user" | "model") => void;
    onError?: (error: any) => void;
    onClose?: () => void;
  }) {
    if (this.isConnected) return;
    this.history = [];

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

        // Interrupt AI speech when user starts talking
        if (rms > 0.01) {
          this.stopPlayback();
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

      // Send greeting
      setTimeout(() => {
        if (this.isConnected && this.ws) {
          this.ws.send(
            JSON.stringify({
              type: "text",
              payload: {
                text: "תפתח את השיחה עכשיו במשפט הבא בדיוק ואז תעצור ותקשיב: 'שלום, רצית לדבר איתי? אני כאן.'",
              },
            })
          );
        }
      }, 800);

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
    // Handle text content
    if (message.serverContent?.modelTurn?.parts?.[0]?.text) {
      const text = message.serverContent.modelTurn.parts[0].text;
      this.history.push({ role: "assistant", content: text });
      callbacks.onTranscription?.(text, "model");
    }

    // Handle audio content
    const audioData =
      message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
    if (audioData) {
      this.playAudioChunk(audioData);
    }

    // Handle interruptions
    if (message.serverContent?.interrupted) {
      this.stopPlayback();
    }
  }

  private playAudioChunk(base64Data: string) {
    if (!this.audioContext) return;

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
