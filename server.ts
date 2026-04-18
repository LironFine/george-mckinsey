import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { createServer as createViteServer } from "vite";
import { createServer as createHttpServer } from "http";
import { WebSocketServer, WebSocket as WsClient } from "ws";
import crypto from "crypto";
import { SYSTEM_PROMPT } from "./src/constants";
import admin from "firebase-admin";

// ── Firebase Admin SDK (server-side, bypasses Firestore Rules) ───────────────
let adminDb: admin.firestore.Firestore | null = null;
try {
  const saJson = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (saJson && !admin.apps.length) {
    const sa = JSON.parse(Buffer.from(saJson, "base64").toString("utf8"));
    admin.initializeApp({ credential: admin.credential.cert(sa) });
    adminDb = admin.firestore();
    console.log("[Admin] Firebase Admin SDK initialized");
  }
} catch (e: any) {
  console.warn("[Admin] Firebase Admin SDK init failed:", e.message);
}
// ─────────────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());
  app.use(express.urlencoded({ extended: true })); // Cardcom IPN sends form-encoded POST body

  // Helper to get the API key safely and cleaned
  const getApiKey = () => {
    const key = process.env.GEMINI_API_KEY;
    if (!key || key === "undefined" || key === "null" || key === "") {
      return null;
    }
    return key.trim().replace(/["']/g, "");
  };

  // ── Wix token validation ─────────────────────────────────────────────────────
  // Token format: base64url(JSON payload) + "." + HMAC-SHA256 hex signature
  // If WIX_TOKEN_SECRET is not set the endpoint returns valid:true (dev mode).
  app.get("/api/validate-token", (req, res) => {
    const secret = (process.env.WIX_TOKEN_SECRET || "").trim();
    if (!secret) return res.json({ valid: true, dev: true });

    const token = (req.query.token as string) || "";
    if (!token) {
      const demoMode = (process.env.DEMO_MODE || "").trim().toLowerCase() === "true";
      if (demoMode) return res.json({ valid: true, demo: true });
      return res.json({ valid: false, reason: "no_token" });
    }

    try {
      const dotIndex = token.lastIndexOf(".");
      if (dotIndex === -1) return res.json({ valid: false, reason: "malformed" });

      const payloadB64 = token.substring(0, dotIndex);
      const signature  = token.substring(dotIndex + 1);

      const expected = crypto
        .createHmac("sha256", secret)
        .update(payloadB64)
        .digest("hex");

      if (signature !== expected) return res.json({ valid: false, reason: "invalid_signature" });

      const data = JSON.parse(Buffer.from(payloadB64, "base64").toString("utf8"));
      if (Date.now() > data.exp) return res.json({ valid: false, reason: "expired" });

      return res.json({ valid: true, email: data.email });
    } catch {
      return res.json({ valid: false, reason: "error" });
    }
  });
  // ─────────────────────────────────────────────────────────────────────────────

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

  // ── Voice/Text pack purchase — Cardcom ──────────────────────────────────────

  // GET /api/create-pack?uid=xxx  → returns { url: "https://secure.cardcom.solutions/..." }
  // Uses a static Cardcom payment link (CARDCOM_PACK_URL) with ReturnValue=uid appended.
  // Create the static link once in Cardcom UI → paste as CARDCOM_PACK_URL in Railway.
  app.get("/api/create-pack", async (req, res) => {
    const uid = (req.query.uid as string) || "";
    if (!uid) return res.status(400).json({ error: "missing uid" });

    const packUrl = (process.env.CARDCOM_PACK_URL || "").trim();
    const appUrl  = (process.env.APP_URL || "").trim();

    if (!packUrl) {
      return res.status(500).json({ error: "CARDCOM_PACK_URL not configured" });
    }

    try {
      // Append uid so Cardcom echoes it back in the IPN as ReturnValue
      const url = new URL(packUrl);
      url.searchParams.set("ReturnValue", uid);
      if (appUrl) {
        url.searchParams.set("SuccessRedirectUrl", `${appUrl}/?purchase=success`);
        url.searchParams.set("ErrorRedirectUrl",   `${appUrl}/?purchase=failed`);
      }
      console.log("[Pack] Redirecting to Cardcom:", url.toString());
      return res.json({ url: url.toString() });
    } catch (err: any) {
      console.error("[Pack] create-pack error:", err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  // POST/GET /api/cardcom-ipn  — Cardcom calls this after successful payment
  const handleCardcomIpn = async (req: express.Request, res: express.Response) => {
    const body = { ...req.query, ...req.body } as Record<string, string>;
    const { RetCode, ReturnValue, SumToBill, TerminalCode } = body;
    const uid = ReturnValue || body.DocumentId || ""; // support both field names

    console.log("[IPN] Cardcom IPN received:", { RetCode, uid, SumToBill });

    if (String(RetCode) !== "0")  return res.send("FAILED");
    if (!uid)                     return res.send("NO_UID");
    if (Number(SumToBill) < 50)   return res.send("AMOUNT_TOO_LOW");
    if (TerminalCode !== (process.env.CARDCOM_TERMINAL || "").trim())
                                  return res.send("WRONG_TERMINAL");
    if (!adminDb)                 return res.status(500).send("DB_NOT_INITIALIZED");

    try {
      await adminDb.doc(`users/${uid}`).set(
        {
          purchasedTextMessages: admin.firestore.FieldValue.increment(300),
          purchasedVoiceMinutes: admin.firestore.FieldValue.increment(90),
        },
        { merge: true }
      );
      console.log(`[IPN] Pack added → ${uid}: +300 text, +90 voice-min`);
      return res.send("OK");
    } catch (err: any) {
      console.error("[IPN] Firestore error:", err.message);
      return res.status(500).send("DB_ERROR");
    }
  };

  app.post("/api/cardcom-ipn", handleCardcomIpn);
  app.get("/api/cardcom-ipn", handleCardcomIpn);
  // ─────────────────────────────────────────────────────────────────────────────

  // ── Monthly subscription — Cardcom recurring (הוראת קבע) ────────────────────

  // GET /api/create-subscription?uid=xxx
  // Generates Cardcom recurring payment URL from CARDCOM_SUBSCRIPTION_URL env var.
  // Cardcom IPN should point to /api/cardcom-subscription-ipn on THIS server.
  app.get("/api/create-subscription", async (req, res) => {
    const uid = (req.query.uid as string) || "";
    if (!uid) return res.status(400).json({ error: "missing uid" });
    const subUrl = (process.env.CARDCOM_SUBSCRIPTION_URL || "").trim();
    const appUrl = (process.env.APP_URL || "").trim();
    if (!subUrl) return res.status(500).json({ error: "CARDCOM_SUBSCRIPTION_URL not configured" });
    try {
      const url = new URL(subUrl);
      url.searchParams.set("ReturnValue", `sub_${uid}`);
      if (appUrl) {
        url.searchParams.set("SuccessRedirectUrl", `${appUrl}/?purchase=success`);
        url.searchParams.set("ErrorRedirectUrl",   `${appUrl}/?purchase=failed`);
      }
      return res.json({ url: url.toString() });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // POST/GET /api/cardcom-subscription-ipn
  // Cardcom הוראת קבע sends a subscription-status IPN (not a payment IPN).
  // Fields: RecurringId, IsActive, acc.Email, acc.CompanyName — no ReturnValue.
  // We identify the user by email via Firebase Admin Auth.
  const handleSubscriptionIpn = async (req: express.Request, res: express.Response) => {
    const body = { ...req.query, ...req.body } as Record<string, string>;
    const email       = body["acc.Email"]  || "";
    const isActive    = body["IsActive"]   || "";
    const recurringId = body["RecurringId"] || body["RecordType"] || "";
    console.log("[SubIPN] Received:", { email, isActive, recurringId });

    if (!email) {
      console.warn("[SubIPN] No email in body — unknown user");
      return res.send("NO_EMAIL");
    }
    if (!adminDb) return res.status(500).send("DB_NOT_INITIALIZED");

    // Look up Firebase UID by email
    let uid: string;
    try {
      const userRecord = await admin.auth().getUserByEmail(email);
      uid = userRecord.uid;
    } catch (err: any) {
      console.error("[SubIPN] User not found for email:", email, err.message);
      return res.send("USER_NOT_FOUND");
    }

    // IsActive='1' → activate; IsActive='0' → cancel
    const newStatus = isActive === "1" ? "active" : "cancelled";
    try {
      await adminDb.doc(`users/${uid}`).set({
        subscription: {
          status: newStatus,
          cardcomRecurringId: recurringId,
          currentPeriodEnd: newStatus === "active"
            ? Date.now() + 31 * 24 * 60 * 60 * 1000
            : (await adminDb.doc(`users/${uid}`).get()).data()?.subscription?.currentPeriodEnd ?? Date.now(),
          activatedAt: newStatus === "active" ? Date.now() : undefined,
          cancelledAt: newStatus === "cancelled" ? Date.now() : null,
        }
      }, { merge: true });
      console.log(`[SubIPN] Subscription ${newStatus} → ${uid} (${email})`);
      return res.send("OK");
    } catch (err: any) {
      console.error("[SubIPN] Firestore error:", err.message);
      return res.status(500).send("DB_ERROR");
    }
  };

  app.post("/api/cardcom-subscription-ipn", handleSubscriptionIpn);
  app.get("/api/cardcom-subscription-ipn",  handleSubscriptionIpn);

  // POST /api/cancel-subscription
  // Calls Cardcom cancellation API; client handles the Firestore update.
  // ⚠️ Verify exact Cardcom CancelDeal endpoint before going live.
  app.post("/api/cancel-subscription", async (req, res) => {
    const { uid, dealNumber } = req.body;
    if (!uid) return res.status(400).json({ error: "missing uid" });

    if (dealNumber && process.env.CARDCOM_TERMINAL) {
      try {
        const params = new URLSearchParams({
          TerminalCode: process.env.CARDCOM_TERMINAL,
          DealNumber:   String(dealNumber),
          APILevel:     "10",
          APIName:      process.env.CARDCOM_API_NAME     || "",
          APIPassword:  process.env.CARDCOM_API_PASSWORD || "",
        });
        const r = await fetch(`https://secure.cardcom.solutions/interface/CancelDeal.aspx?${params}`);
        const text = await r.text();
        console.log("[Cancel] Cardcom response:", text);
      } catch (err: any) {
        console.error("[Cancel] Cardcom API error:", err.message);
        // Don't fail the request — let client update Firestore
      }
    }
    return res.json({ ok: true });
  });
  // ─────────────────────────────────────────────────────────────────────────────

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
            speech_config: {
              voice_config: {
                prebuilt_voice_config: { voice_name: "Orus" },
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
