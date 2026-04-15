import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { createServer as createViteServer } from "vite";
import { createServer as createHttpServer } from "http";
import { WebSocketServer, WebSocket as WsClient } from "ws";
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

  // Diagnostic: list models that support Live API (bidiGenerateContent)
  app.get("/api/live-models", async (req, res) => {
    const apiKey = getApiKey();
    if (!apiKey) return res.status(500).json({ error: "No API key" });
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=100`
      );
      const data = await r.json();
      const liveModels = (data.models || [])
        .filter((m: any) => m.supportedGenerationMethods?.includes("bidiGenerateContent"))
        .map((m: any) => m.name);
      res.json({ liveModels, total: liveModels.length });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
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

  wss.on("connection", (ws) => {
    console.log("Voice WebSocket connection opened");
    const apiKey = getApiKey();

    if (!apiKey) {
      ws.send(JSON.stringify({ type: "error", error: "מפתח ה-API חסר בשרת." }));
      ws.close();
      return;
    }

    // Connect directly to Gemini Live WebSocket — no SDK, no compatibility issues
    const geminiUrl =
      `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${apiKey}`;

    const geminiWs = new WsClient(geminiUrl);

    geminiWs.on("open", () => {
      console.log("Connected to Gemini Live WebSocket");
      const setup = {
        setup: {
          model: "models/gemini-2.5-flash-native-audio-latest",
          generation_config: {
            response_modalities: ["AUDIO"],
            thinking_config: {
              thinking_budget: 1024,
            },
            speech_config: {
              voice_config: {
                prebuilt_voice_config: { voice_name: "Charon" },
              },
            },
          },
          system_instruction: {
            parts: [{ text: SYSTEM_PROMPT }],
          },
        },
      };
      geminiWs.send(JSON.stringify(setup));
    });

    geminiWs.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        // setupComplete signals Gemini is ready
        if (msg.setupComplete !== undefined) {
          console.log("Gemini Live setup complete");
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: "ready" }));
          }
          return;
        }
        // Forward all other messages to the browser
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: "message", data: msg }));
        }
      } catch (e) {
        console.error("Error processing Gemini message:", e);
      }
    });

    geminiWs.on("error", (err) => {
      console.error("Gemini Live WS error:", err.message);
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: "error", error: err.message }));
      }
    });

    geminiWs.on("close", (code, reason) => {
      console.log(`Gemini Live WS closed: ${code} ${reason}`);
      if (ws.readyState === ws.OPEN) ws.close();
    });

    // Forward messages from browser → Gemini
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (geminiWs.readyState !== WsClient.OPEN) return;

        if (msg.type === "audio" && msg.payload?.audio) {
          geminiWs.send(JSON.stringify({
            realtimeInput: {
              mediaChunks: [{
                mimeType: msg.payload.audio.mimeType,
                data: msg.payload.audio.data,
              }],
            },
          }));
        } else if (msg.type === "text" && msg.payload?.text) {
          geminiWs.send(JSON.stringify({
            clientContent: {
              turns: [{ role: "user", parts: [{ text: msg.payload.text }] }],
              turnComplete: true,
            },
          }));
        }
      } catch (e) {
        console.error("Error forwarding message to Gemini:", e);
      }
    });

    ws.on("close", () => {
      console.log("Browser WebSocket closed");
      if (geminiWs.readyState === WsClient.OPEN) geminiWs.close();
    });

    ws.on("error", (err) => {
      console.error("Browser WS error:", err);
      if (geminiWs.readyState === WsClient.OPEN) geminiWs.close();
    });
  });

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
