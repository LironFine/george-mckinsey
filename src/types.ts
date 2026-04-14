export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface BusinessContext {
  name?: string;
  offer?: string;
  audience?: string;
  usp?: string;
  channels?: string[];
  challenges?: string[];
  goals?: string[];
  assets?: string[];
  budget?: string;
  timeAvailable?: string;
}

export type ConsultantMode = 'deep' | 'quick' | 'general';
