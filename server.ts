import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { createServer as createViteServer } from "vite";
import { SYSTEM_PROMPT } from "./src/constants";
// NOTE: No Google SDK imports — we use direct fetch() calls instead.
// The SDK has compatibility issues in this sandbox environment.
// Direct REST calls to the Gemini API work correctly.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // Health check endpoint
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Helper to get the API key safely and cleaned
  const getApiKey = () => {
    const key = process.env.GEMINI_API_KEY;
    if (!key || key === "undefined" || key === "null" || key === "") {
      return null;
    }
    return key.trim().replace(/["']/g, "");
  };

  // API endpoint for text chat — uses direct REST fetch, no SDK
  app.post("/api/chat", async (req, res) => {
    console.log(`Chat request received: ${JSON.stringify(req.body).substring(0, 100)}...`);
    try {
      const { messages } = req.body;
      
      if (!messages || !Array.isArray(messages)) {
        return res.status(400).json({ error: "פורמט הודעות לא תקין" });
      }

      const apiKey = getApiKey();

      if (!apiKey) {
        return res.status(500).json({
          error: "מפתח ה-API חסר בשרת.",
          details: "אנא וודא שהגדרת את המפתח בלשונית ה-Secrets.",
        });
      }

      // Use gemini-flash-latest — confirmed working in this environment
      const model = "gemini-flash-latest";
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

      const body = {
        system_instruction: {
          parts: [{ text: SYSTEM_PROMPT }],
        },
        contents: messages,
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 2048,
        },
      };

      const geminiResponse = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!geminiResponse.ok) {
        const errBody = await geminiResponse.json().catch(() => ({}));
        console.error("Gemini API error:", geminiResponse.status, errBody);
        const msg =
          errBody?.error?.message || "שגיאה לא ידועה מ-Gemini API";
        return res.status(geminiResponse.status).json({ error: msg });
      }

      const data = await geminiResponse.json();
      const text =
        data?.candidates?.[0]?.content?.parts?.[0]?.text ||
        "מצטער, לא הצלחתי לגבש תשובה. אנא נסה שוב.";

      return res.json({ text });
    } catch (error: any) {
      console.error("Backend chat error:", error);
      res.status(500).json({
        error: "חלה שגיאה בתקשורת עם Gemini",
        details: error.message,
      });
    }
  });

  // Voice endpoint — generates an ephemeral token for Gemini Live API.
  // The real API key stays on the server; the browser only receives a short-lived token.
  app.post("/api/voice-token", async (req, res) => {
    const apiKey = getApiKey();
    if (!apiKey) {
      return res.status(500).json({ error: "מפתח ה-API חסר בשרת." });
    }

    try {
      const expireTime = new Date(Date.now() + 30 * 60 * 1000).toISOString();

      const tokenResponse = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateEphemeralToken?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            newSessionExpireTime: expireTime,
            config: {
              responseModalities: ["AUDIO"],
              systemInstruction: {
                parts: [{ text: SYSTEM_PROMPT }],
              },
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName: "Charon" },
                },
              },
            },
          }),
        }
      );

      if (!tokenResponse.ok) {
        const errData = await tokenResponse.json().catch(() => ({}));
        console.error("Ephemeral token error:", tokenResponse.status, errData);
        return res.status(tokenResponse.status).json({
          error: errData?.error?.message || "שגיאה ביצירת token קולי",
        });
      }

      const data = await tokenResponse.json();
      return res.json({ token: data.token });
    } catch (error: any) {
      console.error("Voice token error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // NOTE: /api/config has been removed intentionally.
  // The API key must never be sent to the browser.

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    try {
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: "spa",
      });
      app.use(vite.middlewares);
      console.log("Vite middleware loaded");
    } catch (e) {
      console.error("Failed to load Vite middleware:", e);
    }
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
