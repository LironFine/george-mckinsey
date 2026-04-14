import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { createServer as createViteServer } from "vite";
import { createServer as createHttpServer } from "http";
import { WebSocketServer } from "ws";
import { GoogleGenAI, Modality } from "@google/genai";
import { SYSTEM_PROMPT } from "./src/constants";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // Helper to get the API key safely and cleaned
  const getApiKey = () => {
    const key = process.env.GEMINI_API_KEY;
    if (!key || key === "undefined" || key === "null" || key === "") {
      return null;
    }
    return key.trim().replace(/["']/g, "");
  };

  // Health check endpoint
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

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

  // Create HTTP server (needed for WebSocket upgrade)
  const server = createHttpServer(app);

  // WebSocket proxy — connects frontend to Gemini Live API
  // API key stays on the server; browser only sends/receives audio via our WS
  const wss = new WebSocketServer({ server, path: "/api/voice-ws" });

  wss.on("connection", async (ws) => {
    console.log("Voice WebSocket connection opened");
    const apiKey = getApiKey();

    if (!apiKey) {
      ws.send(JSON.stringify({ type: "error", error: "מפתח ה-API חסר בשרת." }));
      ws.close();
      return;
    }

    let geminiSession: any = null;

    try {
      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: { apiVersion: "v1alpha" },
      });

      geminiSession = await ai.live.connect({
        model: "models/gemini-2.0-flash-exp",
        callbacks: {
          onopen: () => {
            console.log("Gemini Live session opened");
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify({ type: "ready" }));
            }
          },
          onmessage: (message: any) => {
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify({ type: "message", data: message }));
            }
          },
          onerror: (err: any) => {
            console.error("Gemini Live error:", err);
            if (ws.readyState === ws.OPEN) {
              ws.send(
                JSON.stringify({
                  type: "error",
                  error: err?.message || "שגיאה בשיחה הקולית",
                })
              );
            }
          },
          onclose: () => {
            console.log("Gemini Live session closed");
            if (ws.readyState === ws.OPEN) ws.close();
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
    } catch (err: any) {
      console.error("Failed to create Gemini Live session:", err);
      if (ws.readyState === ws.OPEN) {
        ws.send(
          JSON.stringify({
            type: "error",
            error: err?.message || "לא ניתן להפעיל שיחה קולית. אנא נסה שוב.",
          })
        );
        ws.close();
      }
      return;
    }

    // Forward messages from browser → Gemini
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (geminiSession && msg.payload) {
          geminiSession.sendRealtimeInput(msg.payload);
        }
      } catch (e) {
        console.error("Error forwarding WS message to Gemini:", e);
      }
    });

    ws.on("close", () => {
      console.log("Voice WebSocket connection closed");
      try {
        geminiSession?.close();
      } catch {}
    });

    ws.on("error", (err) => {
      console.error("Voice WebSocket error:", err);
      try {
        geminiSession?.close();
      } catch {}
    });
  });

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
