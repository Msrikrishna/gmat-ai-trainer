
// src/background.js

// Hardened system prompt
const SYSTEM_PROMPT = `You are a GMAT item writer. Create original GMAT Focus Edition questions that would plausibly appear on the exam.
Requirements:
- SAME TYPE and SAME SUBTYPE as provided (e.g., CR: Inference stays Inference; DS stays DS).
- Match the abstract logic/skills the source item tests. For low bands (505–605), prefer a single core skill. For higher bands, allow a controlled mix mirroring the source.
- Calibrate difficulty to a single GMAT Focus band: 505-555, 555-605, 605-655, 655-705, 705-755, or 755-805.
- Exam-caliber style consistent with the last decade but with fresh content.

Return ONLY JSON (no markdown) with keys:
{
  "question": "string",
  "options": ["A) ...","B) ...","C) ...","D) ...","E) ..."],
  "correct_answer": "A|B|C|D|E",
  "explanation": "Start with: Abstract logic(s): <list>. Then explain clearly.",
  "type": "PS|DS|CR|RC|DI",
  "subtype": "e.g., CR: Inference/Assumption/etc; Quant/DI topic; RC type",
  "difficulty_band": "505-555|555-605|605-655|655-705|705-755|755-805"
}
Rules:
- The JSON output must be perfectly formatted. Do not include comments or trailing commas.
- Exactly 5 options A–E. Distractors must be plausible.
- DS: include statements (1) and (2). RC: include a short passage. DI: include compact data (ASCII allowed).
- Clear, concise English.`;

// Timeout & cancellation: 3 minutes
const API_TIMEOUT_MS = 180000;
let activeJobController = null;
let activeJobId = null;

// === Settings ===
async function getSettings() {
  return new Promise((resolve)=>{
    chrome.storage.local.get(["provider","openai_key","openai_model","gemini_key","gemini_model"], s => {
      resolve({
        provider: s.provider || "openai",
        openai_key: s.openai_key || "",
        openai_model: s.openai_model || "gpt-4o-mini",
        gemini_key: s.gemini_key || "",
        gemini_model: s.gemini_model || "gemini-2.5-pro"
      });
    });
  });
}

// === OpenAI helpers ===
async function listOpenAIModels(key) {
  if (!key) throw new Error("OpenAI key is required to list models.");
  const res = await fetch("https://api.openai.com/v1/models", {
    headers: { "Authorization": `Bearer ${key}` }
  });
  if (!res.ok) throw new Error(`OpenAI list models failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  // Filter out embeddings/whisper/tts/image/audio/tools
  const bad = /(embedding|whisper|tts|speech|audio|image|vision|moderation|omni\-moderation|clip|dall\-e|tool|realtime)/i;
  const ids = (data?.data || []).map(m => m.id).filter(id => id && !bad.test(id));
  // Deduplicate and sort, keep known favorites first
  const uniq = [...new Set(ids)];
  const preferred = ["gpt-5","gpt-4.1","gpt-4o","gpt-4o-mini","o3-mini","o1","gpt-3.5-turbo"];
  return [...preferred.filter(p=>uniq.includes(p)), ...uniq.filter(n=>!preferred.includes(n))];
}

async function callOpenAI({ key, model, userPrompt, systemPrompt = SYSTEM_PROMPT, signal }) {
  if (!key)   throw new Error("Missing OpenAI API key.");
  if (!model) throw new Error("Missing OpenAI model.");

  // Preflight model (best-effort)
  const chk = await fetch(`https://api.openai.com/v1/models/${encodeURIComponent(model)}`, {
    headers: { "Authorization": `Bearer ${key}` },
    signal
  });
  if (!chk.ok) {
    const details = await chk.text();
    throw new Error(`OpenAI model check failed (${chk.status}). Details: ${details}`);
  }

  const parseJSONFromText = (text) => {
    const i = text.indexOf("{");
    const j = text.lastIndexOf("}");
    if (i >= 0 && j > i) return JSON.parse(text.slice(i, j+1));
    throw new Error("No valid JSON object found in the response.");
  };

  // Attempt 1: Chat Completions with JSON mode
  const chatBody = {
    model,
    messages: [
      { role:"system", content: systemPrompt },
      { role:"user",   content: userPrompt }
    ],
    response_format: { type: "json_object" }
  };

  let res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type":"application/json", "Authorization": `Bearer ${key}` },
    body: JSON.stringify(chatBody),
    signal
  });
  let raw = await res.text();

  if (res.ok) {
    const data = JSON.parse(raw);
    const text = data?.choices?.[0]?.message?.content || "";
    const parsed = parseJSONFromText(text);
    return { parsed, requestDump: JSON.stringify(chatBody, null, 2) };
  }

  const lower = raw.toLowerCase();
  const needsNoJSONMode = (res.status === 400) && (lower.includes("response_format") || lower.includes("json mode") || lower.includes("invalid type"));
  const needsResponsesAPI = (res.status === 400 || res.status === 404) && (lower.includes("responses endpoint") || lower.includes("not compatible with the chat.completions endpoint"));

  // Attempt 2: Chat Completions w/o response_format
  if (needsNoJSONMode) {
    const chatBody2 = {
      model,
      messages: [
        { role:"system", content: systemPrompt },
        { role:"user",   content: `${userPrompt}\n\nReturn ONLY JSON, no markdown.` }
      ]
    };
    res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type":"application/json", "Authorization": `Bearer ${key}` },
      body: JSON.stringify(chatBody2),
      signal
    });
    raw = await res.text();
    if (res.ok) {
      const data = JSON.parse(raw);
      const text = data?.choices?.[0]?.message?.content || "";
      const parsed = parseJSONFromText(text);
      return { parsed, requestDump: JSON.stringify(chatBody2, null, 2) };
    }
  }

  // Attempt 3: Responses API
  if (needsResponsesAPI || res.status === 404) {
    const respBody = {
      model,
      input: `${systemPrompt}\n\nUSER:\n${userPrompt}\n\nReturn ONLY JSON, no markdown.`
    };
    const res2 = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "Content-Type":"application/json", "Authorization": `Bearer ${key}` },
      body: JSON.stringify(respBody),
      signal
    });
    const raw2 = await res2.text();
    if (!res2.ok) throw new Error(`OpenAI responses error ${res2.status}: ${raw2}`);
    const data2 = JSON.parse(raw2);
    let text2 = "";
    if (typeof data2.output_text === "string") text2 = data2.output_text;
    else if (Array.isArray(data2.choices)) text2 = data2.choices?.[0]?.message?.content || "";
    else if (Array.isArray(data2.output) && data2.output.length) text2 = (data2.output[0].content && data2.output[0].content[0]?.text) || "";
    const parsed2 = parseJSONFromText(String(text2||""));
    return { parsed: parsed2, requestDump: JSON.stringify(respBody, null, 2) };
  }

  throw new Error(`OpenAI error ${res.status}: ${raw}`);
}

// === Gemini helpers ===
async function listGeminiModels(apiKey) {
  if (!apiKey) throw new Error("Gemini API key is required to list models.");
  const baseUrl = new URL("https://generativelanguage.googleapis.com/v1beta/models");
  baseUrl.searchParams.set("pageSize", "1000");
  const headers = { "x-goog-api-key": apiKey };
  const out = [];
  let nextPageToken = null;
  let guard = 0;
  do {
    const currentUrl = new URL(baseUrl);
    if (nextPageToken) currentUrl.searchParams.set("pageToken", nextPageToken);
    const res = await fetch(currentUrl.toString(), { headers });
    const text = await res.text();
    if (!res.ok) {
      let detail = "";
      try { const j = JSON.parse(text); detail = j?.error?.message || text; } catch { detail = text || res.statusText; }
      throw new Error(`Failed to list Gemini models (${res.status}): ${detail}`);
    }
    let data;
    try { data = JSON.parse(text); } catch { throw new Error("Gemini list models: invalid JSON response."); }
    const page = (data.models || [])
      .filter(m => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes("generateContent"))
      .map(m => String(m.name || "").replace(/^models\//, ""))
      .filter(Boolean);
    out.push(...page);
    nextPageToken = data.nextPageToken || null;
  } while (nextPageToken && ++guard < 10);
  const preferred = ["gemini-2.5-pro","gemini-1.5-pro","gemini-1.5-flash","gemini-2.0-pro","gemini-2.0-flash"];
  const uniq = [...new Set(out)];
  return [...preferred.filter(p=>uniq.includes(p)), ...uniq.filter(n=>!preferred.includes(n))];
}

async function getGeminiModel(apiKey, modelId, signal) {
  const id = modelId.startsWith("models/") ? modelId : `models/${modelId}`;
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/${id}`, {
    headers: { "x-goog-api-key": apiKey },
    signal
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Gemini models.get failed (${res.status}): ${text}`);
  return JSON.parse(text);
}

async function validateGeminiModel(apiKey, modelId, signal) {
  const meta = await getGeminiModel(apiKey, modelId, signal);
  const methods = meta?.supportedGenerationMethods || [];
  if (!methods.includes("generateContent")) {
    throw new Error(`Selected Gemini model "${modelId}" does not support generateContent.`);
  }
  return true;
}

async function callGemini({
  key,
  model,
  userPrompt,
  systemPrompt = SYSTEM_PROMPT,
  signal,
  responseSchema = null,
  temperature = 0.7,
  maxAttempts = 3
}) {
  if (!key)   throw new Error("Missing Gemini API key.");
  if (!model) throw new Error("Missing Gemini model.");

  const modelName = model.startsWith("models/") ? model : `models/${model}`;
  const headers = { "Content-Type": "application/json", "x-goog-api-key": key };

  const makeBody = (sys, usr) => ({
    systemInstruction: sys ? { parts: [{ text: sys }] } : undefined,
    contents: [{ role: "user", parts: [{ text: `${usr}\n\nReturn ONLY JSON, no markdown.` }] }],
    generationConfig: {
      temperature,
      responseMimeType: "application/json",
      ...(responseSchema ? { responseSchema: responseSchema } : {})
    }
  });

  const joinText = (resp) => {
    const c = resp?.candidates?.[0];
    const parts = c?.content?.parts || [];
    return parts.map(p => p.text).filter(Boolean).join("");
  };

  const parseRetryDelayMs = (retryDelayStr) => {
    const m = /(\d+)(?:\.(\d+))?s/.exec(String(retryDelayStr || ""));
    if (!m) return 4000;
    const sec = parseInt(m[1], 10);
    const frac = m[2] ? parseInt(m[2], 10) : 0;
    return sec * 1000 + frac;
  };

  const versions = [
    (m) => `https://generativelanguage.googleapis.com/v1beta/${m}:generateContent`,
    (m) => `https://generativelanguage.googleapis.com/v1/${m}:generateContent`
  ];

  for (const makeUrl of versions) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const body = makeBody(systemPrompt, userPrompt);
      const res  = await fetch(makeUrl(modelName), { method: "POST", headers, body: JSON.stringify(body), signal });
      const text = await res.text();

      if (res.ok) {
        let json;
        try { json = JSON.parse(text); }
        catch { throw new Error("Gemini returned a non-JSON payload (unexpected for JSON Mode)."); }

        const joined = joinText(json);
        let parsed;
        try { parsed = JSON.parse(joined); }
        catch (e) { throw new Error(`Failed to parse the model's JSON response.\nRaw text:\n${joined}`); }

        return { parsed, requestDump: JSON.stringify(body, null, 2) };
      }

      if (res.status === 404) break;

      if (res.status === 429 && attempt < maxAttempts) {
        try {
          const err = JSON.parse(text);
          const retryInfo = err?.error?.details?.find(d => d['@type']?.includes('RetryInfo'));
          if (retryInfo?.retryDelay) {
            await new Promise(r => setTimeout(r, parseRetryDelayMs(retryInfo.retryDelay)));
            continue;
          }
        } catch {}
        await new Promise(r => setTimeout(r, 4000));
        continue;
      }

      if (res.status >= 500 && res.status < 600 && attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, attempt * 2000));
        continue;
      }

      throw new Error(`Gemini error ${res.status}: ${text}`);
    }
  }

  throw new Error("Gemini request failed on both v1beta and v1 after all retries.");
}

// === Router with background job queue, cancellation & timeout ===
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg?.type === "models.list") {
      try {
        const { provider, key } = msg.payload || {};
        if (provider === "openai") return sendResponse({ ok:true, models: await listOpenAIModels(key) });
        if (provider === "gemini") return sendResponse({ ok:true, models: await listGeminiModels(key) });
        return sendResponse({ ok:false, error: "Unknown provider" });
      } catch (e) { return sendResponse({ ok:false, error: e?.message || String(e) }); }
    }

    if (msg?.type === "ai.generateQuestion") {
      // Cancel previous
      try {
        if (activeJobController) {
          activeJobController.abort("New generation request started.");
          if (activeJobId) {
            chrome.storage.local.get(["jobs"], (o) => {
              const jobs = o?.jobs || {};
              if (jobs[activeJobId] && jobs[activeJobId].status === "pending") {
                jobs[activeJobId] = { ...jobs[activeJobId], status: "error", error: "Cancelled by new request.", finished: Date.now() };
                chrome.storage.local.set({ jobs });
              }
            });
          }
        }
      } catch {}

      const controller = new AbortController();
      activeJobController = controller;
      const timeoutId = setTimeout(() => controller.abort("API call timed out."), API_TIMEOUT_MS);

      const { originalQuestion, originalType, pageBand, pageTypeTag, targetBand } = msg.payload || {};
      const s = await getSettings();
      const provider = s.provider;
      const model = provider==="openai" ? (s.openai_model||"gpt-4o-mini") : (s.gemini_model||"gemini-2.5-pro");
      const key = provider==="openai" ? s.openai_key : s.gemini_key;
      if (!key) { sendResponse({ ok:false, error: `Missing ${provider==="openai"?"OpenAI":"Gemini"} API key. Open Settings → paste your key.` }); clearTimeout(timeoutId); activeJobController=null; return; }

      const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
      activeJobId = jobId;

      const baseJob = {
        id: jobId, status: "pending", created: Date.now(),
        provider, model, params: { originalQuestion, originalType, pageBand, pageTypeTag, targetBand }
      };
      chrome.storage.local.get(["jobs"], (o)=>{
        const jobs = o?.jobs || {}; jobs[jobId] = baseJob; chrome.storage.local.set({ jobs });
      });
      sendResponse({ ok:true, queued:true, jobId });

      (async () => {
        let jobResult = null, jobError = null;
        try {
          if (provider === "gemini") { await validateGeminiModel(key, model, controller.signal); }
          const userPrompt = JSON.stringify({
            original_question_text: originalQuestion,
            source_type: originalType,
            source_subtype: pageTypeTag || "",
            source_difficulty_band: pageBand || "",
            target_difficulty_band: targetBand || "",
            exam_style_constraint: "Plausible GMAT Focus item, last ~10 years style.",
            abstract_logic_policy: "Identify logic(s) in the source; single skill at low bands, controlled mix at higher bands mirroring source."
          }, null, 2);
          const call = provider==="openai" ? callOpenAI : callGemini;
          const out = await call({ key, model, userPrompt, signal: controller.signal });
          const parsed = out.parsed;
          if (!parsed || !Array.isArray(parsed.options) || parsed.options.length !== 5) throw new Error("Model response missing 5 options.");
          const letters = ["A","B","C","D","E"];
          if (!letters.includes(String(parsed.correct_answer).trim().toUpperCase())) throw new Error("Model response missing valid correct_answer (A–E).");
          jobResult = { parsed, requestDump: out.requestDump };
        } catch (e) {
          if (e?.name === "AbortError") jobError = `Request was cancelled: ${e?.message || ""}`;
          else jobError = e?.message || String(e);
        } finally {
          try { clearTimeout(timeoutId); } catch {}
          activeJobController = null; activeJobId = null;
        }

        chrome.storage.local.get(["jobs","history"], (st)=>{
          const jobs = st?.jobs || {};
          const history = st?.history || [];
          const existing = jobs[jobId];
          if (jobError) {
            jobs[jobId] = { ...existing, status:"error", error: jobError, finished: Date.now() };
            chrome.storage.local.set({ jobs });
          } else {
            const entry = {
              ts: Date.now(), provider, model,
              band: jobResult.parsed?.difficulty_band || targetBand,
              type: jobResult.parsed?.type, subtype: jobResult.parsed?.subtype,
              data: jobResult.parsed, prompt: jobResult.requestDump
            };
            history.unshift(entry);
            jobs[jobId] = { ...existing, status:"done", finished: Date.now(), data: jobResult.parsed, meta: { provider, model, targetBand }, prompt: jobResult.requestDump };
            chrome.storage.local.set({
              jobs, history: history.slice(0,30),
              lastGenerated: { ts: Date.now(), data: jobResult.parsed, meta: { provider, model, targetBand }, prompt: jobResult.requestDump }
            });
          }
        });
      })();
      return;
    }

    if (msg?.type === "settings.get") { return sendResponse({ ok:true, data: await getSettings() }); }
    if (msg?.type === "settings.set") { chrome.storage.local.set(msg.payload || {}, () => sendResponse({ ok:true })); return; }

    if (msg?.type === "ai.testKey") {
      try {
        const s = await getSettings();
        const ping = JSON.stringify({ ping:"ok" });
        if (s.provider === "openai") await callOpenAI({ key: s.openai_key, model: s.openai_model || "gpt-4o-mini", userPrompt: ping });
        else await callGemini({ key: s.gemini_key, model: s.gemini_model || "gemini-2.5-pro", userPrompt: ping });
        sendResponse({ ok:true });
      } catch (e) { sendResponse({ ok:false, error: e?.message || String(e) }); }
      return;
    }

    if (msg?.type === "PING") { sendResponse({ ok:true }); return; }
    sendResponse({ ok:false, error: "Unknown message" });
  })().catch(err => { console.error(err); sendResponse({ ok:false, error: err.message || String(err) }); });
  return true;
});
