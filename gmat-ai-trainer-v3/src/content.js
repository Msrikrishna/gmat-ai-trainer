
// src/content.js
if (!window.__GAI_TRAINER_INSTALLED__) {
  window.__GAI_TRAINER_INSTALLED__ = true;

  const BANDS = ["505-555","555-605","605-655","655-705","705-755","755-805"];
  const textOf = (el) => (el?.innerText || "").trim();

  function parseBandLabel(t) {
    if (!t) return null;
    t = String(t).replace(/Level/i,"").trim();
    for (const b of BANDS) if (t.includes(b)) return b;
    const m = t.match(/(\d{3})\s*-\s*(\d{3})/);
    if (m) {
      const label = `${m[1]}-${m[2]}`;
      if (BANDS.includes(label)) return label;
    }
    return null;
  }

  function detectTypeFromText(t) {
    const s = (t||"").toLowerCase();
    if (/\bdata sufficiency\b|\bds\b|\bstatement\s*\(1\)/i.test(s)) return "DS";
    if (/\bproblem solving\b|\bps\b/.test(s)) return "PS";
    if (/\bcritical reasoning\b|\bcr\b/.test(s)) return "CR";
    if (/\breading comprehension\b|\brc\b/.test(s)) return "RC";
    if (/\bdata insights\b|\bdi\b/.test(s)) return "DI";
    if (/\binference\b|\bstrengthen\b|\bweaken\b|\bassumption\b/.test(s)) return "CR";
    return "UNKNOWN";
  }

  function extractMain() {
    let el = document.querySelector("div[id^='p_'] .item.text");
    if (!el) el = document.querySelector(".item.text");
    if (!el) el = document.querySelector("article .content, article .post, .post-content");
    if (!el) el = document.querySelector("[class*='post'] [class*='text'], [class*='content']");

    const questionText = textOf(el);
    const levelRaw = textOf(document.querySelector("#taglist > a:first-child"));
    const pageDifficulty = parseBandLabel(levelRaw);
    const pageTypeTag = textOf(document.querySelector("#taglist > a:nth-of-type(2)"));

    return {
      url: location.href,
      questionText: (questionText || "").slice(0,4000),
      detectedType: detectTypeFromText(questionText),
      pageDifficulty,
      pageTypeTag
    };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === "PING") { sendResponse({ ok:true }); return true; }
    if (msg?.type === "extractQuestion") {
      try { sendResponse({ ok:true, data: extractMain() }); }
      catch (e) { sendResponse({ ok:false, error: e?.message || String(e) }); }
    }
    return true;
  });
}
