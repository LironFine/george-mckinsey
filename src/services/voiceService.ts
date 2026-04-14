import { checkAndIncrementVoiceUsage } from './usageService';

export class VoiceService {
  private recognition: any = null;
  private isActive: boolean = false;
  private isSpeaking: boolean = false;
  private history: { role: string; content: string }[] = [];
  private callbacks: {
    onTranscription?: (text: string, role: 'user' | 'model') => void;
    onError?: (error: any) => void;
    onClose?: () => void;
    onLimitReached?: (resetDays: number) => void;
  } = {};

  getHistory() {
    return this.history;
  }

  async start(callbacks: {
    history?: any[];
    onTranscription?: (text: string, role: 'user' | 'model') => void;
    onError?: (error: any) => void;
    onClose?: () => void;
    onLimitReached?: (resetDays: number) => void;
  }) {
    if (this.isActive) return;

    const SpeechRecognitionAPI =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!SpeechRecognitionAPI) {
      callbacks.onError?.(
        new Error('הדפדפן שלך אינו תומך בזיהוי קולי. אנא השתמש ב-Chrome.')
      );
      return;
    }

    this.callbacks = callbacks;
    this.history = callbacks.history ? [...callbacks.history] : [];
    this.isActive = true;

    this.startListening();
  }

  private startListening() {
    if (!this.isActive || this.isSpeaking) return;

    const SpeechRecognitionAPI =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    this.recognition = new SpeechRecognitionAPI();
    this.recognition.lang = 'he-IL';
    this.recognition.continuous = false;
    this.recognition.interimResults = false;
    this.recognition.maxAlternatives = 1;

    this.recognition.onresult = async (event: any) => {
      const transcript = event.results[0][0].transcript.trim();
      if (!transcript) return;
      this.callbacks.onTranscription?.(transcript, 'user');
      await this.sendToGemini(transcript);
    };

    this.recognition.onerror = (event: any) => {
      if (event.error === 'no-speech' || event.error === 'aborted') {
        if (this.isActive && !this.isSpeaking) {
          setTimeout(() => this.startListening(), 300);
        }
        return;
      }
      if (event.error === 'not-allowed') {
        this.callbacks.onError?.(
          new Error('הרשאת מיקרופון נדחתה. אנא אפשר גישה למיקרופון בהגדרות הדפדפן.')
        );
        this.stop();
        return;
      }
      console.error('Speech recognition error:', event.error);
      if (this.isActive && !this.isSpeaking) {
        setTimeout(() => this.startListening(), 500);
      }
    };

    this.recognition.onend = () => {
      if (this.isActive && !this.isSpeaking) {
        setTimeout(() => this.startListening(), 300);
      }
    };

    try {
      this.recognition.start();
    } catch {
      // Already started
    }
  }

  private async sendToGemini(text: string) {
    const { allowed, resetDays } = await checkAndIncrementVoiceUsage();
    if (!allowed) {
      this.callbacks.onLimitReached?.(resetDays);
      this.stop();
      return;
    }

    try {
      const messages = [
        ...this.history.map((m) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }],
        })),
        { role: 'user', parts: [{ text }] },
      ];

      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages }),
      });

      const data = await response.json();
      if (data.text) {
        this.history.push({ role: 'user', content: text });
        this.history.push({ role: 'assistant', content: data.text });
        this.callbacks.onTranscription?.(data.text, 'model');
        this.speak(data.text);
      }
    } catch (err: any) {
      console.error('Gemini error in voice:', err);
      if (this.isActive) {
        setTimeout(() => this.startListening(), 500);
      }
    }
  }

  private speak(text: string) {
    this.isSpeaking = true;

    try {
      this.recognition?.stop();
    } catch {}

    // Strip markdown symbols for cleaner speech
    const cleanText = text
      .replace(/\*\*/g, '')
      .replace(/\*/g, '')
      .replace(/#+\s/g, '')
      .replace(/\[.*?\]\(.*?\)/g, '')
      .replace(/`/g, '')
      .replace(/---/g, '')
      .trim();

    const utterance = new SpeechSynthesisUtterance(cleanText);
    utterance.lang = 'he-IL';
    utterance.rate = 1.0;
    utterance.pitch = 1.0;

    // Prefer Hebrew voice if available
    const voices = window.speechSynthesis.getVoices();
    const hebrewVoice = voices.find((v) => v.lang.startsWith('he'));
    if (hebrewVoice) utterance.voice = hebrewVoice;

    utterance.onend = () => {
      this.isSpeaking = false;
      if (this.isActive) {
        setTimeout(() => this.startListening(), 500);
      }
    };

    utterance.onerror = () => {
      this.isSpeaking = false;
      if (this.isActive) {
        setTimeout(() => this.startListening(), 500);
      }
    };

    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  }

  // Kept for API compatibility — no-op in this implementation
  async sendTextMessage(_text: string) {}

  stop() {
    this.isActive = false;
    this.isSpeaking = false;

    try {
      this.recognition?.stop();
    } catch {}
    this.recognition = null;

    window.speechSynthesis.cancel();
    this.callbacks.onClose?.();
  }
}

export const voiceService = new VoiceService();
