
// src/popup.js
const BANDS = ["505-555","555-605","605-655","655-705","705-755","755-805"];
const $ = (s)=>document.querySelector(s);

let loadingTimeout=null;
function startLoadingTimeout(){ clearTimeout(loadingTimeout); loadingTimeout=setTimeout(()=>setLoading(false),190000); }
function stopLoadingTimeout(){ clearTimeout(loadingTimeout); loadingTimeout=null; }

function showError(msg){
  const p=$("#errorPanel"); if(!p) return;
  p.classList.remove("hidden");
  p.innerHTML = (msg||"") + '<br><br><button id="openSettingsBtn" style="margin-top:6px;">Open Settings</button>';
  $("#openSettingsBtn").onclick = () => chrome.runtime.openOptionsPage();
}
function clearError(){ const p=$("#errorPanel"); if(!p) return; p.classList.add("hidden"); p.textContent=""; }

function escapeHtml(s){return String(s).replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[m]));}
function renderMarkdown(s){
  if(!s) return "";
  let h=escapeHtml(String(s));
  h=h.replace(/\*\*(.+?)\*\*/g,"<strong>$1</strong>");
  h=h.replace(/\*(.+?)\*/g,"<em>$1</em>");
  h=h.replace(/`([^`]+)`/g,"<code>$1</code>");
  h=h.replace(/^(?:-|\*)\s+(.+)$/gm,"• $1");
  h=h.replace(/\n/g,"<br>");
  return h;
}

// In-memory state loaded once
const state = {
  extracted:null,
  currentBand:"605-655",
  typeTag:"Unknown",
  lastPrompt:"",
  correctLetter:null,
  history:[],
  bandOverride:"-",
  pendingJobId: null
};

function renderHistory(){
  const list=$("#historyList"); if(!list) return;
  list.innerHTML = "";
  (state.history||[]).forEach(h=>{
    const li=document.createElement("li");
    const top=document.createElement("div"); top.className="row";
    const left=document.createElement("div");
    left.innerHTML = `<span class="badge">${h.band||h.data?.difficulty_band||""}</span> <span class="badge">${h.type||h.data?.type||""}${(h.subtype||h.data?.subtype)?(" • "+(h.subtype||h.data?.subtype)):""}</span> <span class="meta">${new Date(h.ts||Date.now()).toLocaleString()}</span>`;
    const right=document.createElement("div");
    const loadBtn=document.createElement("button"); loadBtn.textContent="Load";
    const copyBtn=document.createElement("button"); copyBtn.textContent="Copy Prompt";
    loadBtn.onclick = ()=>{ renderGenerated(h.data, {provider:h.provider, model:h.model}); state.currentBand = h.band || h.data?.difficulty_band || state.currentBand; renderExtracted(); };
    copyBtn.onclick = async ()=>{ try { await navigator.clipboard.writeText(h.prompt||""); } catch(e){} };
    right.appendChild(loadBtn); right.appendChild(copyBtn);
    top.appendChild(left); top.appendChild(right);
    const stem=document.createElement("div"); stem.className="meta"; stem.textContent = (h.data?.question||"").slice(0,140);
    li.appendChild(top); li.appendChild(stem);
    list.appendChild(li);
  });
}

function setLoading(on, message = "Generating…"){
  clearError();
  const loading=$("#loadingState"); const gen=$("#generated");
  if(on){
    gen.classList.remove("hidden");
    loading.classList.remove("hidden");
    const meta = loading.querySelector(".meta"); if (meta) meta.textContent = message;
    $("#genStem").textContent="";
    $("#genMeta").innerHTML="";
    $("#genOptions").innerHTML="";
    $("#feedback").textContent="";
    $("#showExplanation").classList.add("hidden");
    $("#showExplanation").textContent = "Show explanation";
    $("#explanation").classList.add("hidden"); $("#explanation").innerHTML="";
  } else {
    loading.classList.add("hidden");
  }
}

function optionLetterFromItem(text){ const m=String(text).match(/^\s*([A-E])\)\s*/i); return m?m[1].toUpperCase():null; }

function renderGenerated(payload, meta){
  $("#generated").classList.remove("hidden");
  $("#genStem").textContent = payload.question || "";
  $("#genMeta").innerHTML = `Difficulty: <span class="badge">${payload.difficulty_band || ""}</span>  Type/Subtype: <span class="badge">${payload.type || ""} ${payload.subtype ? "• "+payload.subtype : ""}</span>`;
  const ul=$("#genOptions"); ul.innerHTML="";
  state.correctLetter = String(payload.correct_answer||"").trim().toUpperCase();
  (payload.options||[]).forEach((opt, idx)=>{
    const li=document.createElement("li"); li.textContent=opt;
    li.addEventListener("click",()=>{
      ul.querySelectorAll("li").forEach(x=>x.classList.remove("selected","correct","incorrect"));
      li.classList.add("selected");
      const letter = optionLetterFromItem(opt) || ["A","B","C","D","E"][idx];
      const ok = letter===state.correctLetter;
      li.classList.add(ok?"correct":"incorrect");
      $("#feedback").textContent = ok ? "✅ Correct" : `❌ Incorrect — correct is ${state.correctLetter}`;
    });
    ul.appendChild(li);
  });
  $("#showExplanation").classList.remove("hidden");
  $("#showExplanation").textContent = "Show explanation";
  $("#explanation").classList.add("hidden");
  $("#explanation").innerHTML = renderMarkdown(payload.explanation || "No explanation provided.");
  $("#modelInfo").textContent = (meta?.provider||"") + (meta?.model?` • ${meta.model}`:"");
  $("#copyPromptTop").onclick = async () => {
    try { await navigator.clipboard.writeText(state.lastPrompt || ""); $("#feedback").textContent="Prompt copied."; setTimeout(()=>$("#feedback").textContent="",1200); }
    catch { $("#feedback").textContent="Copy failed."; setTimeout(()=>$("#feedback").textContent="",1200); }
  };
}

function renderExtracted(){
  $("#questionEditor").value = state.extracted?.questionText || "";
  const bandSel = document.getElementById("bandSelect");
  const band = (state.extracted?.pageDifficulty && BANDS.includes(state.extracted.pageDifficulty)) ? state.extracted.pageDifficulty : (state.currentBand||"605-655");
  state.currentBand = band;
  state.typeTag = state.extracted?.pageTypeTag || state.typeTag;
  $("#detectedBadges").innerHTML = `<span class="badge">${band}</span><span class="badge">${state.typeTag||"Unknown"}</span>`;
  if (bandSel) bandSel.value = "-";

  if (!($("#questionEditor").value||"").trim()) {
    showError("This extension extracts context only on GMATClub pages. Paste a GMAT-style question into the editor if auto-detect fails.");
  } else {
    clearError();
  }
}

function toggleHistory(){
  const panel = document.getElementById("historyPanel");
  const btn = document.getElementById("toggleHistoryBtn");
  const willShow = panel.classList.contains("hidden");
  panel.classList.toggle("hidden");
  if (btn) btn.textContent = willShow ? "Hide history" : "Show history";
  if (willShow) renderHistory();
}

async function ensureContentScript(tabId){
  return new Promise(res=>{
    chrome.tabs.sendMessage(tabId, {type:"PING"}, (r)=>{
      if (chrome.runtime.lastError) {
        chrome.scripting.executeScript({ target:{tabId}, files:["src/content.js"] }, ()=>res(true));
      } else res(true);
    });
  });
}

function requestExtraction(tabId, tries=0){
  chrome.tabs.sendMessage(tabId, { type:"extractQuestion" }, (resp)=>{
    if (chrome.runtime.lastError || !resp?.ok) {
      if (tries<2) return setTimeout(()=>requestExtraction(tabId, tries+1), 400);
      state.extracted = { questionText:"", pageDifficulty:"605-655", pageTypeTag:"Unknown", detectedType:"UNKNOWN" };
      renderExtracted();
      return;
    }
    state.extracted = resp.data || {};
    renderExtracted();
  });
}

// Listen for background job updates
chrome.storage.onChanged.addListener((changes, area)=>{
  if (area !== "local") return;
  if (changes.jobs) {
    chrome.storage.local.get(["pendingJobId","jobs","lastGenerated","history"], (out)=>{
      state.pendingJobId = out?.pendingJobId || state.pendingJobId;
      const jobId = state.pendingJobId;
      if (!jobId) return;
      const job = (out.jobs||{})[jobId];
      if (!job) return;
      if (job.status === "done") {
        setLoading(false);
        const lg = out?.lastGenerated;
        if (lg?.data) {
          state.lastPrompt = lg.prompt || job.prompt || "";
          const tb = job?.params?.targetBand;
          if (tb && BANDS.includes(tb)) state.currentBand = tb;
          const entry = {
            ts: Date.now(),
            provider: job?.provider,
            model: job?.model,
            band: lg?.data?.difficulty_band || tb,
            type: lg?.data?.type,
            subtype: lg?.data?.subtype,
            data: lg?.data,
            prompt: state.lastPrompt
          };
          state.history = out?.history || [];
          state.history.unshift(entry);
          state.history = state.history.slice(0,30);
          renderGenerated(lg.data, lg.meta || {});
          renderHistory();
          chrome.storage.local.remove(["pendingJobId"]);
          state.pendingJobId = null;
        }
      } else if (job.status === "error") {
        setLoading(false);
        const errMsg = (job.error||"").toLowerCase();
        if (errMsg.includes("timed out")) {
          showError("⏱️ Stopped due to timeout.");
        } else if (errMsg.includes("cancelled")) {
          showError("⏹️ Previous generation cancelled. Starting new one…");
        } else {
          showError(job.error || "Generation failed.");
        }
        chrome.storage.local.remove(["pendingJobId"]);
        state.pendingJobId = null;
      }
    });
  }
});

async function adoptPendingJob(){
  chrome.storage.local.get(["pendingJobId","jobs","lastGenerated","history"], (out)=>{
    state.history = out?.history || state.history;
    const jobId = out?.pendingJobId;
    state.pendingJobId = jobId || null;
    if (!jobId) return;
    const job = (out.jobs||{})[jobId];
    if (!job) { chrome.storage.local.remove(["pendingJobId"]); state.pendingJobId=null; return; }
    if (job.status === "pending") {
      setLoading(true, "Generating…");
    } else if (job.status === "done") {
      const lg = out?.lastGenerated;
      if (lg?.data) {
        state.lastPrompt = lg.prompt || "";
        const tb = job?.params?.targetBand;
        if (tb && BANDS.includes(tb)) state.currentBand = tb;
        renderGenerated(lg.data, lg.meta || {});
      }
      chrome.storage.local.remove(["pendingJobId"]);
      state.pendingJobId = null;
    } else if (job.status === "error") {
      showError(job.error || "Generation failed.");
      chrome.storage.local.remove(["pendingJobId"]);
      state.pendingJobId = null;
    }
  });
}

async function init(){
  $("#openOptions").addEventListener("click",(e)=>{ e.preventDefault(); chrome.runtime.openOptionsPage(); });
  $("#showExplanation").textContent = "Show explanation";
  $("#showExplanation").addEventListener("click", ()=> $("#explanation").classList.toggle("hidden") );

  chrome.storage.local.get(["history","lastGenerated","pendingJobId","jobs"], (out)=>{
    state.history = out?.history || [];
    state.pendingJobId = out?.pendingJobId || null;
    const jobs = out?.jobs || {};
    if (state.pendingJobId && jobs[state.pendingJobId]?.status === "pending") {
      setLoading(true, "Generating…");
    } else if (out.lastGenerated?.data) {
      state.lastPrompt = out.lastGenerated.prompt || "";
      renderGenerated(out.lastGenerated.data, out.lastGenerated.meta || {});
    }
  });

  await adoptPendingJob();

  const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
  const isGMAT = !!(tab && tab.url && /https?:\/\/([^\/]+\.)?gmatclub\.com\//i.test(tab.url));
  if (isGMAT) {
    await ensureContentScript(tab.id);
    requestExtraction(tab.id);
  } else {
    showError("This extension extracts context only on GMATClub pages. You can still paste a question into the editor and generate.");
    const ed = document.getElementById("questionEditor");
    if (ed && !ed.value) ed.placeholder = "Paste a GMAT-style question here, then click Easier/Same/Harder or select a band and Generate.";
  }

  document.querySelectorAll("button.diff").forEach(btn => btn.addEventListener("click", () => generate(btn.dataset.d)));
  const bandSel = document.getElementById("bandSelect");
  if (bandSel) bandSel.addEventListener("change", ()=>{ state.bandOverride = bandSel.value || "-"; });
  const genBtn = document.getElementById("generateExact");
  if (genBtn) genBtn.addEventListener("click", ()=> generate("Exact"));

  const tbtn = document.getElementById("toggleHistoryBtn");
  if (tbtn) tbtn.addEventListener("click", ()=>{ toggleHistory(); });
}

async function generate(which){
  const wasPending = !!state.pendingJobId;
  setLoading(true, wasPending ? "Cancelling and restarting…" : "Generating…"); startLoadingTimeout();
  const originalQuestion = ($("#questionEditor").value || state.extracted?.questionText || "").slice(0,4000);
  const originalType = (state.extracted?.detectedType || "UNKNOWN");
  let idx = Math.max(0, BANDS.indexOf(state.currentBand || "605-655"));
  let targetBand;
  if (which === "Exact") {
    targetBand = (state.bandOverride && BANDS.includes(state.bandOverride)) ? state.bandOverride : (state.currentBand || "605-655");
  } else if (which === "Easier") {
    idx = Math.max(0, idx-1);
    targetBand = BANDS[idx];
  } else if (which === "Harder") {
    idx = Math.min(BANDS.length-1, idx+1);
    targetBand = BANDS[idx];
  } else { // Same
    targetBand = (state.currentBand || "605-655");
  }

  chrome.runtime.sendMessage({ type:"ai.generateQuestion", payload: {
      originalQuestion, originalType, pageBand: state.currentBand, pageTypeTag: state.typeTag, targetBand
  }}, (resp)=>{
    if (resp?.queued && resp.jobId) {
      chrome.storage.local.set({ pendingJobId: resp.jobId });
      state.pendingJobId = resp.jobId;
      return;
    }
    setLoading(false); stopLoadingTimeout();
    if (!resp?.ok) {
      const err = resp?.error || "Generation failed.";
      let hint="";
      if (/Missing OpenAI API key|Missing Gemini API key/i.test(err)) hint="Open Settings → choose provider & model → paste your API key.";
      else if (/model not selected|model.*not found|model.*does not exist|model check failed|does not support generateContent/i.test(err)) hint="Settings → Refresh models, or type the exact model you have access to (e.g., gemini-2.5-pro).";
      else if (/429|rate limit/i.test(err)) hint="Rate limit reached. Wait a minute and try again.";
      else if (/403|access|not allowed/i.test(err)) hint="Key may not have access to this model. Choose another model or check your account.";
      else if (/5\d\d|server/i.test(err)) hint="Provider server issue. Try again shortly.";
      showError(err + (hint?`\n\n${hint}`:""));
      return;
    }
  });
}

document.addEventListener("DOMContentLoaded", init);
