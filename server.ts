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

    // ── Hardening: require a shared secret in the IPN URL so random
    //    callers can't activate subscriptions for arbitrary emails. The
    //    secret is configured once on the IPN URL inside Cardcom's
    //    dashboard (e.g. https://.../api/cardcom-subscription-ipn?ipnSecret=XXX).
    //    Until you set CARDCOM_IPN_SECRET in Railway and update the URL on
    //    Cardcom's side, any forged or test call is rejected.
    const expectedSecret = (process.env.CARDCOM_IPN_SECRET || "").trim();
    if (expectedSecret) {
      const got = (body["ipnSecret"] || (req.query.ipnSecret as string) || "").toString();
      if (got !== expectedSecret) {
        console.warn("[SubIPN] Rejected — bad/missing ipnSecret. From IP:", req.ip);
        return res.status(401).send("FORBIDDEN");
      }
    } else {
      console.warn("[SubIPN] CARDCOM_IPN_SECRET not set — endpoint is OPEN. Set it ASAP.");
    }

    const email       = body["acc.Email"]  || "";
    const isActive    = body["IsActive"]   || "";
    const recurringId = body["RecurringId"] || body["RecordType"] || "";
    console.log("[SubIPN] Received:", { email, isActive, recurringId, ip: req.ip });

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

    // IsActive: '1' or 'True' → activate; '0' or 'False' → cancel
    const newStatus = (isActive === "1" || isActive.toLowerCase() === "true") ? "active" : "cancelled";
    try {
      const update: Record<string, any> = {
        "subscription.status": newStatus,
        "subscription.cardcomRecurringId": recurringId,
      };
      if (newStatus === "active") {
        update["subscription.currentPeriodEnd"] = Date.now() + 31 * 24 * 60 * 60 * 1000;
        update["subscription.activatedAt"] = Date.now();
        update["subscription.cancelledAt"] = null;
      } else {
        update["subscription.cancelledAt"] = Date.now();
      }
      await adminDb.doc(`users/${uid}`).update(update);
      console.log(`[SubIPN] Subscription ${newStatus} → ${uid} (${email})`);
      return res.send("OK");
    } catch (err: any) {
      // Document might not exist yet — use set with merge
      try {
        const sub: Record<string, any> = {
          status: newStatus,
          cardcomRecurringId: recurringId,
        };
        if (newStatus === "active") {
          sub.currentPeriodEnd = Date.now() + 31 * 24 * 60 * 60 * 1000;
          sub.activatedAt = Date.now();
          sub.cancelledAt = null;
        } else {
          sub.cancelledAt = Date.now();
        }
        await adminDb.doc(`users/${uid}`).set({ subscription: sub }, { merge: true });
        console.log(`[SubIPN] Subscription ${newStatus} (set) → ${uid} (${email})`);
        return res.send("OK");
      } catch (err2: any) {
        console.error("[SubIPN] Firestore error:", err2.message);
        return res.status(500).send("DB_ERROR");
      }
    }
  };

  app.post("/api/cardcom-subscription-ipn", handleSubscriptionIpn);
  app.get("/api/cardcom-subscription-ipn",  handleSubscriptionIpn);

  // POST /api/admin/cancel-recurring  body: { recurringId, secret }
  // Server-to-server cancel — used by Yael's admin dashboard so Cardcom
  // credentials stay in George only. Idempotent: if Cardcom rejects we
  // surface the response text to the caller.
  app.post("/api/admin/cancel-recurring", async (req, res) => {
    const secret = (req.query.secret as string) || (req.body?.secret as string) || "";
    const expected = (process.env.ADMIN_SECRET || "").trim();
    if (!expected || secret !== expected) return res.status(401).json({ error: "unauthorized" });
    const recurringId = (req.body?.recurringId as string) || (req.query.recurringId as string) || "";
    if (!recurringId) return res.status(400).json({ error: "missing recurringId" });
    if (recurringId === "manual" || recurringId.startsWith("manual-")) {
      // Nothing to cancel on Cardcom's side — these were grant-only
      return res.json({ ok: true, skipped: "manual provision, nothing to cancel at Cardcom" });
    }
    if (!process.env.CARDCOM_TERMINAL) {
      return res.status(500).json({ error: "CARDCOM_TERMINAL not configured" });
    }
    try {
      const params = new URLSearchParams({
        TerminalCode: process.env.CARDCOM_TERMINAL,
        RecurringId:  String(recurringId),
        APILevel:     "10",
        APIName:      process.env.CARDCOM_API_NAME     || "",
        APIPassword:  process.env.CARDCOM_API_PASSWORD || "",
      });
      const r = await fetch(`https://secure.cardcom.solutions/interface/CancelRecurring.aspx?${params}`);
      const text = await r.text();
      console.log("[admin-cancel-recurring]", recurringId, "→", text);
      // Cardcom returns "ResponseCode=0" on success (in URL-encoded form)
      const ok = /ResponseCode=0\b/.test(text) || /Success/i.test(text);
      if (!ok) return res.status(502).json({ error: "Cardcom rejected", cardcomResponse: text });
      return res.json({ ok: true, cardcomResponse: text });
    } catch (err: any) {
      console.error("[admin-cancel-recurring] failed:", err);
      return res.status(500).json({ error: err?.message || "unknown" });
    }
  });

  // GET /api/admin/activate-subscription?uid=xxx&secret=yyy
  // Temporary manual activation for testing (protected by ADMIN_SECRET env var).
  app.get("/api/admin/activate-subscription", async (req, res) => {
    const secret = (process.env.ADMIN_SECRET || "").trim();
    const { uid, secret: reqSecret } = req.query as Record<string, string>;
    if (!secret || reqSecret !== secret) return res.status(401).send("UNAUTHORIZED");
    if (!uid) return res.status(400).send("MISSING_UID");
    if (!adminDb) return res.status(500).send("DB_NOT_INITIALIZED");
    try {
      await adminDb.doc(`users/${uid}`).set({
        subscription: {
          status: "active",
          currentPeriodEnd: Date.now() + 31 * 24 * 60 * 60 * 1000,
          activatedAt: Date.now(),
          cancelledAt: null,
          cardcomRecurringId: "manual",
        }
      }, { merge: true });
      console.log(`[Admin] Manual activation → ${uid}`);
      return res.send(`OK — subscription activated for ${uid}`);
    } catch (err: any) {
      return res.status(500).send("DB_ERROR: " + err.message);
    }
  });

  // POST /api/cancel-subscription
  // Calls Cardcom cancellation API; client handles the Firestore update.
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
      }
    }
    return res.json({ ok: true });
  });

  // ── Full account cancellation — standalone page + API ────────────────────────

  // GET /cancel — standalone cancellation page (link from Wix)
  app.get("/cancel", (_req, res) => {
    const firebaseConfig = {
      apiKey:            "AIzaSyCGCQCTDNKI3SEBrwlmUUQeQfuLvM0mjJM",
      authDomain:        "gen-lang-client-0766618683.firebaseapp.com",
      projectId:         "gen-lang-client-0766618683",
      messagingSenderId: "478311515884",
      appId:             "1:478311515884:web:103fb4b7a3df9230d787c9",
    };
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`<!DOCTYPE html>
<html dir="rtl" lang="he">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ביטול מנוי</title>
  <script src="https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js"></script>
  <script src="https://www.gstatic.com/firebasejs/10.7.1/firebase-auth-compat.js"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', Arial, sans-serif; background: #f8fafc; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 24px; }
    .card { background: #fff; border-radius: 24px; box-shadow: 0 4px 32px rgba(0,0,0,0.10); padding: 40px 36px; max-width: 420px; width: 100%; text-align: center; }
    .avatar { width: 80px; height: 80px; border-radius: 50%; object-fit: cover; margin-bottom: 20px; border: 3px solid #fff; box-shadow: 0 2px 12px rgba(0,0,0,0.12); }
    h1 { font-size: 1.3rem; font-weight: 700; color: #1e293b; margin-bottom: 10px; }
    p { color: #64748b; font-size: 0.92rem; line-height: 1.6; margin-bottom: 20px; }
    .warning { background: #fef3c7; border: 1px solid #fcd34d; border-radius: 12px; padding: 16px; margin-bottom: 24px; color: #92400e; font-size: 0.88rem; line-height: 1.6; text-align: right; }
    .btn { width: 100%; padding: 14px; border-radius: 12px; font-size: 0.95rem; font-weight: 700; cursor: pointer; border: none; transition: all 0.2s; margin-bottom: 10px; }
    .btn-danger { background: #ef4444; color: #fff; }
    .btn-danger:hover { background: #dc2626; }
    .btn-secondary { background: #f1f5f9; color: #475569; }
    .btn-secondary:hover { background: #e2e8f0; }
    .btn-google { background: #fff; color: #374151; border: 1px solid #d1d5db; display: flex; align-items: center; justify-content: center; gap: 10px; }
    .btn-google:hover { background: #f9fafb; }
    .spinner { width: 36px; height: 36px; border: 3px solid #e2e8f0; border-top-color: #3b82f6; border-radius: 50%; animation: spin 0.8s linear infinite; margin: 0 auto 16px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .success-icon { font-size: 3rem; margin-bottom: 12px; }
    #screen-loading, #screen-signin, #screen-warning, #screen-confirming, #screen-done { display: none; }
  </style>
</head>
<body>
<div class="card">
  <img src="https://george-mckinsey-production.up.railway.app/george.JPG" class="avatar" alt="ג'ורג'" onerror="this.style.display='none'">

  <!-- Loading -->
  <div id="screen-loading">
    <div class="spinner"></div>
    <p>טוען...</p>
  </div>

  <!-- Sign in -->
  <div id="screen-signin">
    <h1>ביטול מנוי</h1>
    <p>כדי לבטל את המנוי, יש להתחבר תחילה עם חשבון Google שלך.</p>
    <button class="btn btn-google" onclick="signIn()">
      <svg width="18" height="18" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
      כניסה עם Google
    </button>
  </div>

  <!-- Warning -->
  <div id="screen-warning">
    <h1>ביטול מנוי</h1>
    <div class="warning">
      ⚠️ כל המידע שיש למערכת על העסק שלך יימחק מהזיכרון מיידית לצמיתות על מנת להבטיח את הפרטיות שלך, ואי אפשר יהיה לשחזר אותו או להתחיל מחדש תוכנית ניסיון.
    </div>
    <button class="btn btn-danger" onclick="confirmCancel()">בטוח, מחק אותי עכשיו</button>
    <button class="btn btn-secondary" onclick="location.href='https://www.pirsoomai.com/vpmarketing'">אני רוצה להמשיך לעבוד</button>
  </div>

  <!-- Confirming -->
  <div id="screen-confirming">
    <div class="spinner"></div>
    <p>מבטל מנוי ומוחק נתונים...</p>
  </div>

  <!-- Done -->
  <div id="screen-done">
    <div class="success-icon">✓</div>
    <h1>המנוי בוטל</h1>
    <p>הנתונים נמחקו. תודה שהשתמשת בשירות.</p>
  </div>
</div>

<script>
  firebase.initializeApp(${JSON.stringify(firebaseConfig)});
  const auth = firebase.auth();

  function show(id) {
    ['loading','signin','warning','confirming','done'].forEach(s =>
      document.getElementById('screen-' + s).style.display = 'none'
    );
    document.getElementById('screen-' + id).style.display = 'block';
  }

  show('loading');

  auth.onAuthStateChanged(user => {
    if (user) show('warning');
    else show('signin');
  });

  function signIn() {
    auth.signInWithPopup(new firebase.auth.GoogleAuthProvider()).catch(console.error);
  }

  async function confirmCancel() {
    show('confirming');
    try {
      const idToken = await auth.currentUser.getIdToken();
      const r = await fetch('/api/cancel-account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      });
      const data = await r.json();
      if (data.ok) {
        await auth.signOut();
        show('done');
      } else {
        alert('שגיאה: ' + (data.error || 'נסה שוב'));
        show('warning');
      }
    } catch (e) {
      alert('שגיאת תקשורת — נסה שוב');
      show('warning');
    }
  }
</script>
</body>
</html>`);
  });

  // POST /api/cancel-account — verifies Firebase ID token, cancels Cardcom, wipes data
  app.post("/api/cancel-account", async (req, res) => {
    const { idToken } = req.body;
    if (!idToken) return res.status(400).json({ error: "missing idToken" });
    if (!adminDb)  return res.status(500).json({ error: "DB_NOT_INITIALIZED" });

    let uid: string;
    try {
      const decoded = await admin.auth().verifyIdToken(idToken);
      uid = decoded.uid;
    } catch {
      return res.status(401).json({ error: "invalid token" });
    }

    // 1. Cancel Cardcom recurring billing
    try {
      const userDoc = await adminDb.doc(`users/${uid}`).get();
      const recurringId = userDoc.data()?.subscription?.cardcomRecurringId;
      if (recurringId && recurringId !== "manual" && process.env.CARDCOM_TERMINAL) {
        const params = new URLSearchParams({
          TerminalCode: process.env.CARDCOM_TERMINAL,
          RecurringId:  String(recurringId),
          APILevel:     "10",
          APIName:      process.env.CARDCOM_API_NAME     || "",
          APIPassword:  process.env.CARDCOM_API_PASSWORD || "",
        });
        const r = await fetch(`https://secure.cardcom.solutions/interface/CancelRecurring.aspx?${params}`);
        console.log("[CancelAccount] Cardcom:", await r.text());
      }
    } catch (err: any) {
      console.warn("[CancelAccount] Cardcom cancel failed (continuing):", err.message);
    }

    // 2. Wipe user data — keep only demo_usage with max counts (blocks future trial)
    try {
      await adminDb.doc(`users/${uid}`).delete();
      await adminDb.doc(`demo_usage/${uid}`).set({ textCount: 9999, voiceCount: 9999 }, { merge: true });
      console.log(`[CancelAccount] Account wiped → ${uid}`);
      return res.json({ ok: true });
    } catch (err: any) {
      console.error("[CancelAccount] Firestore error:", err.message);
      return res.status(500).json({ error: "DB_ERROR" });
    }
  });
  // ─────────────────────────────────────────────────────────────────────────────
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
          // Reduce end-of-speech detection delay → faster response after user stops talking
          realtimeInputConfig: {
            automaticActivityDetection: {
              endOfSpeechSensitivity: "END_SENSITIVITY_HIGH",
              silenceDurationMs: 600,
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

    // ── Keepalive ping every 20 s — prevents Railway proxy from dropping idle WS ──
    const pingInterval = setInterval(() => {
      if (ws.readyState === ws.OPEN) {
        try { ws.ping(); } catch {}
      } else {
        clearInterval(pingInterval);
      }
    }, 20000);

    ws.on("close", () => {
      console.log("Browser WebSocket closed");
      clearInterval(pingInterval);
      if (geminiWs.readyState === WsClient.OPEN) geminiWs.close();
    });

    ws.on("error", (err) => {
      console.error("Browser WS error:", err);
      clearInterval(pingInterval);
      if (geminiWs.readyState === WsClient.OPEN) geminiWs.close();
    });
  });

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
