
function $(s){ return document.querySelector(s); }

const FALLBACK_OPENAI = ["gpt-5","gpt-4.1","gpt-4o","gpt-4o-mini","o3-mini","o1","gpt-3.5-turbo"];
const FALLBACK_GEMINI = ["gemini-2.5-pro","gemini-2.0-pro","gemini-2.0-flash","gemini-1.5-pro","gemini-1.5-flash"];

function populate(sel, items){
  sel.innerHTML = "";
  items.forEach(m => { const o=document.createElement("option"); o.value=m; o.textContent=m; sel.appendChild(o); });
}

document.addEventListener("DOMContentLoaded", () => {
  populate($("#openai_model"), FALLBACK_OPENAI);
  populate($("#gemini_model"), FALLBACK_GEMINI);

  chrome.runtime.sendMessage({ type:"settings.get" }, (resp)=>{
    if (!resp?.ok) return;
    const s = resp.data;
    $("#provider").value = s.provider || "openai";
    $("#openai_key").value = s.openai_key || "";
    $("#gemini_key").value = s.gemini_key || "";
    $("#openai_model").value = s.openai_model || FALLBACK_OPENAI[0];
    $("#gemini_model").value = s.gemini_model || FALLBACK_GEMINI[0];
    $("#openai_model_custom").value = "";
    $("#gemini_model_custom").value = "";
  });

  $("#openai_refresh").addEventListener("click", ()=>{
    $("#status").textContent="Listing OpenAI models...";
    chrome.runtime.sendMessage({ type:"models.list", payload:{ provider:"openai", key: $("#openai_key").value }}, (r)=>{
      $("#status").textContent = r?.ok ? "OpenAI models loaded." : ("Error: " + (r?.error||""));
      if (r?.ok) populate($("#openai_model"), r.models);
    });
  });

  $("#gemini_refresh").addEventListener("click", ()=>{
    $("#status").textContent="Listing Gemini models...";
    chrome.runtime.sendMessage({ type:"models.list", payload:{ provider:"gemini", key: $("#gemini_key").value }}, (r)=>{
      $("#status").textContent = r?.ok ? "Gemini models loaded." : ("Error: " + (r?.error||""));
      if (r?.ok) populate($("#gemini_model"), r.models);
    });
  });

  $("#test").addEventListener("click", ()=>{
    const statusEl = $("#status");
    statusEl.textContent = "Testing...";
    chrome.runtime.sendMessage({ type:"ai.testKey" }, (resp)=>{
      statusEl.textContent = resp?.ok ? "✅ API OK." : `❌ Error: ${resp?.error || "Unknown"}`;
      // Persistent output: do not auto-clear
    });
  });

  // Auto-save on any change
  const saveNow = ()=>{
    const payload = {
      provider: $("#provider").value,
      openai_model: ($("#openai_model_custom").value.trim() || $("#openai_model").value),
      openai_key: $("#openai_key").value,
      gemini_model: ($("#gemini_model_custom").value.trim() || $("#gemini_model").value),
      gemini_key: $("#gemini_key").value
    };
    chrome.runtime.sendMessage({ type:"settings.set", payload });
  };

  ["#provider","#openai_model","#openai_model_custom","#openai_key","#gemini_model","#gemini_model_custom","#gemini_key"].forEach(sel=>{
    const el = $(sel); if (!el) return;
    el.addEventListener("change", saveNow);
    if (!sel.endsWith("_key")) el.addEventListener("input", saveNow); // keys saved on change
  });
});
