/**
 * Wix Velo Page Code — קוד עמוד של עמוד האסטרטג
 *
 * הוראות:
 * 1. פתח ב-Wix Editor את עמוד האסטרטג (שבו ה-iframe של ג'ורג')
 * 2. לחץ על אלמנט ה-HTML (ה-iframe) ושנה את ה-ID שלו ל: georgeFrame
 * 3. פתח את Page Code (התחתית) והדבק את הקוד הבא
 */

import { generateGeorgeToken } from 'backend/georgeToken.jsw';

const GEORGE_URL = 'https://george-mckinsey-production.up.railway.app/';

$w.onReady(async function () {
  // התאם גובה ל-viewport המלא (מונע חיתוך במובייל)
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  $w('#georgeFrame').style.height = `${Math.max(vh, 700)}px`;

  try {
    const token = await generateGeorgeToken();
    $w('#georgeFrame').src = `${GEORGE_URL}?token=${encodeURIComponent(token)}`;
  } catch (err) {
    // המשתמש לא מחובר או אין לו מנוי — הצג הודעה
    console.log('Token generation failed:', err.message);
    $w('#georgeFrame').src = `${GEORGE_URL}`; // יציג מסך "נדרש מנוי"
  }
});
