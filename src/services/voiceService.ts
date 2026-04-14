import { GoogleGenAI, Modality, LiveServerMessage } from "@google/genai";
import { SYSTEM_PROMPT } from "../constants";

export class VoiceService {
  private ai: any;
  private session: any;
  private audioContext: AudioContext | null = null;
  // AudioWorklet node replaces the deprecated ScriptProcessorNode
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
      // 1. Request an ephemeral token from the backend.
      //    The actual API key stays on the server and is never exposed to the browser.
      const tokenResponse = await fetch("/api/voice-token", { method: "POST" });
      if (!tokenResponse.ok) {
        const errData = await tokenResponse.json().catch(() => ({}));
        throw new Error(
          errData.error ||
            "שירות השיחה הקולית אינו זמין כרגע. אנא השתמש בצ'אט הטקסטואלי."
        );
      }
      const { token } = await tokenResponse.json();
      if (!token) {
        throw new Error("לא התקבל token תקין מהשרת.");
      }

      this.ai = new GoogleGenAI({
        apiKey: token,
        httpOptions: { apiVersion: "v1alpha" },
      });

      // Use 24000Hz for output as it's the standard for Gemini Live/TTS
      this.audioContext = new (window.AudioContext ||
        (window as any).webkitAudioContext)({ sampleRate: 24000 });
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.source = this.audioContext.createMediaStreamSource(this.stream);

      // Load the AudioWorklet module (replaces deprecated ScriptProcessorNode)
      await this.audioContext.audioWorklet.addModule("/audio-processor.js");
      this.workletNode = new AudioWorkletNode(
        this.audioContext,
        "microphone-processor"
      );

      // Convert message history to Gemini format if provided
      const initialContents = callbacks.history
        ? callbacks.history.map((m) => ({
            role: m.role === "assistant" ? "model" : "user",
            parts: [{ text: m.content }],
          }))
        : [];

      this.session = await this.ai.live.connect({
        model: "models/gemini-2.0-flash",
        callbacks: {
          onopen: () => {
            this.isConnected = true;
            console.log("Live session opened");

            // Wire up the AudioWorklet message handler now that the session is open
            this.workletNode!.port.onmessage = (event) => {
              if (!this.isConnected || !this.session) return;
              const { rms, channelData } = event.data;

              // Interruption detection
              if (rms > 0.01) {
                this.stopPlayback();
              }

              const pcmData = this.float32ToInt16(new Float32Array(channelData));
              const base64Data = this.arrayBufferToBase64(pcmData.buffer);
              try {
                this.session.sendRealtimeInput({
                  audio: { data: base64Data, mimeType: "audio/pcm;rate=16000" },
                });
              } catch (err) {
                console.error("Error sending audio:", err);
              }
            };

            this.source!.connect(this.workletNode!);
            // AudioWorklet does not need to connect to destination for mic capture
            // but we connect to keep the node graph alive in some browsers
            this.workletNode!.connect(this.audioContext!.destination);

            // Greeting after connection is stable
            setTimeout(() => {
              if (this.isConnected && this.session) {
                try {
                  this.session.sendRealtimeInput({
                    text: "תפתח את השיחה עכשיו במשפט הבא בדיוק ואז תעצור ותקשיב: 'שלום, רצית לדבר איתי? אני כאן.'",
                  });
                } catch (e) {
                  console.error("Error sending greeting:", e);
                }
              }
            }, 800);

            // Send initial context if history exists
            if (initialContents.length > 0 && this.session) {
              setTimeout(() => {
                if (!this.isConnected || !this.session) return;

                let historyText = initialContents
                  .map(
                    (c) =>
                      `${c.role === "model" ? "ג'ורג' מקינזי" : "משתמש"}: ${c.parts[0].text}`
                  )
                  .join("\n");

                if (historyText.length > 10000) {
                  historyText =
                    historyText.substring(historyText.length - 10000) +
                    "... (היסטוריה מקוצרת)";
                }

                try {
                  this.session.sendRealtimeInput({
                    text: `להלן היסטוריית השיחה עד כה. אנא המשך מהנקודה הזו:\n${historyText}`,
                  });
                } catch (e) {
                  console.error("Error sending initial context:", e);
                }
              }, 500);
            }
          },
          onmessage: async (message: LiveServerMessage) => {
            if (message.serverContent?.modelTurn?.parts?.[0]?.text) {
              const text = message.serverContent.modelTurn.parts[0].text;
              this.history.push({ role: "assistant", content: text });
            }

            const audioData =
              message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (audioData) {
              this.playAudioChunk(audioData);
            }

            if (message.serverContent?.interrupted) {
              this.stopPlayback();
            }
          },
          onerror: (err: any) => {
            console.error("Live session error:", err);
            callbacks.onError?.(err);
          },
          onclose: () => {
            this.isConnected = false;
            console.log("Live session closed");
            callbacks.onClose?.();
          },
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Charon" } },
          },
          systemInstruction: SYSTEM_PROMPT,
        },
      });
    } catch (err) {
      console.error("Failed to start voice session:", err);
      callbacks.onError?.(err);
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
      } catch (e) {
        // Source might have already stopped
      }
    });
    this.activeSources = [];
    this.nextStartTime = 0;
  }

  async sendTextMessage(text: string) {
    if (!this.isConnected || !this.session) return;
    try {
      await this.session.sendRealtimeInput({ text });
    } catch (err) {
      console.error("Failed to send text message to voice session:", err);
    }
  }

  stop() {
    this.isConnected = false;
    if (this.session) {
      this.session.close();
    }
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
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }
}

export const voiceService = new VoiceService();
