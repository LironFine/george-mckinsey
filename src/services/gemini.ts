import { Message } from "../types";

export async function sendMessageToGemini(messages: Message[]): Promise<string> {
  // Prepare contents for Gemini
  const contents = messages.reduce((acc, m, index) => {
    // Ensure the conversation starts with a user message if the first message is from assistant
    if (index === 0 && m.role === 'assistant') {
      acc.push({
        role: 'user',
        parts: [{ text: 'שלום' }]
      });
    }
    
    acc.push({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    });
    return acc;
  }, [] as any[]);

  try {
    // Call our backend proxy instead of calling Gemini directly
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ messages: contents }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || "שגיאה בתקשורת עם השרת");
    }

    const data = await response.json();
    return data.text || "מצטער, לא הצלחתי לגבש תשובה. אנא נסה שוב.";
  } catch (error: any) {
    console.error("Gemini service error:", error);
    throw error;
  }
}
