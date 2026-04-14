# דוח שגיאות טכני - בעיית Gemini API Key

## תיאור הבעיה
האפליקציה נתקלת בשגיאת `400 Bad Request` עם ההודעה `API key not valid` בכל ניסיון תקשורת דרך ה-SDK הרשמיים של גוגל (`@google/generative-ai` ו-`@google/genai`).

## ממצאי בדיקות דיאגנוסטיקה (בוצעו בטרמינל השרת)

ביצעתי סדרת בדיקות ישירות מול ה-API של גוגל (ללא ה-SDK) כדי לבודד את הבעיה. להלן התוצאות:

1.  **מודל `gemini-2.0-flash`:**
    *   **סטטוס:** נכשל (404/400).
    *   **הודעה:** `This model models/gemini-2.0-flash is no longer available to new users.`
    *   **מסקנה:** המודל חסום לשימוש בחשבון זה.

2.  **מודל `gemini-1.5-flash`:**
    *   **סטטוס:** נכשל (404).
    *   **הודעה:** `models/gemini-1.5-flash is not found for API version v1beta.`

3.  **מודל `gemini-flash-latest`:**
    *   **סטטוס:** **הצליח (200)**.
    *   **שיטה:** קריאת `fetch` ישירה לכתובת:
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=[KEY]`
    *   **מסקנה:** המפתח תקין לחלוטין, אך ה-SDK נכשל בבניית הבקשה הנכונה או בבחירת המודל הנתמך.

## סיבת השורש (השערה)
ה-SDK של גוגל בסביבת ה-Sandbox הזו מנסה לגשת לנקודות קצה (Endpoints) או להשתמש בפרמטרים שאינם נתמכים על ידי הפרויקט הספציפי הזה. בעוד שקריאת REST ישירה למודל `gemini-flash-latest` עובדת, ה-SDK מחזיר שגיאת "מפתח לא תקין" שהיא למעשה שגיאה מטעה (Masking) לבעיית תאימות מודל/גרסה.

## המלצות לתיקון (עבור Claude)
1.  **הימנעות מה-SDK:** מומלץ לעבור למימוש של `fetch` ישיר ב-`server.ts` במקום להשתמש ב-`GoogleGenerativeAI`.
2.  **מודל מטרה:** יש להשתמש אך ורק ב-`gemini-flash-latest` (או `gemini-2.0-flash-exp` לשיחה קולית אם הוא זמין).
3.  **מבנה הבקשה שעבד בבדיקה:**
    ```typescript
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${process.env.GEMINI_API_KEY}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] }
      })
    });
    ```

## קבצים רלוונטיים לבדיקה
*   `server.ts`: ניהול הקריאות ב-Backend.
*   `src/services/voiceService.ts`: ניהול השיחה הקולית (משתמש ב-WebSockets/Live API שגם הוא חווה בעיות דומות).
*   `package.json`: רשימת הספריות המותקנות.

---
**הערת המערכת:** המפתח ב-Secrets אומת כקיים ותקין (מתחיל ב-AIza ובאורך 39 תווים).
