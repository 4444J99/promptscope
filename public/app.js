// PromptScope — frontend
//
// Frontend is intentionally tiny. All real work happens in /functions/api/*.
// Browser → POST /api/analyze → render result.

const $ = (id) => document.getElementById(id);

function approxTokens(s) {
  // Cheap fallback estimate; the real count comes from the API.
  return Math.ceil(s.length / 4);
}

function setLoading(loading) {
  $("analyze-btn").disabled = loading;
  $("analyze-btn").textContent = loading ? "Analyzing…" : "Analyze";
}

function renderResult(data) {
  $("results").hidden = false;
  $("score-num").textContent = data.score?.toFixed(1) ?? "—";
  $("token-count").textContent = data.token_count ?? "—";
  $("char-count").textContent = data.char_count ?? "—";

  $("anti-patterns").innerHTML = (data.anti_patterns ?? [])
    .map(ap => `<li>
      <div class="name">${escapeHtml(ap.name)}</div>
      <div class="fix">${escapeHtml(ap.fix)}</div>
    </li>`).join("") || `<li>None detected.</li>`;

  $("strengths").innerHTML = (data.strengths ?? [])
    .map(s => `<li><div class="name">${escapeHtml(s)}</div></li>`).join("")
    || `<li>None notable.</li>`;

  if (data.suggested_rewrite) {
    $("rewrite-block").textContent = data.suggested_rewrite;
    $("rewrite-lock").hidden = true;
  } else {
    $("rewrite-block").textContent = "Upgrade to Pro to see a structured rewrite of your prompt.";
    $("rewrite-lock").hidden = false;
  }

  $("results").scrollIntoView({ behavior: "smooth", block: "start" });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));
}

async function analyze() {
  const text = $("prompt-input").value.trim();
  if (!text) return;
  if (text.length > 32000) {
    alert("Prompt is over 32k characters; trim it first.");
    return;
  }
  setLoading(true);
  try {
    const r = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: text }),
    });
    const data = await r.json();
    if (!r.ok) {
      throw new Error(data.error ?? `HTTP ${r.status}`);
    }
    if (data.quota_remaining !== undefined) {
      $("quota").textContent = `${data.quota_remaining} free analyses remaining today`;
    }
    renderResult(data);
  } catch (err) {
    alert(err.message ?? String(err));
  } finally {
    setLoading(false);
  }
}

async function getShareLink() {
  const text = $("prompt-input").value.trim();
  if (!text) return;
  const btn = $("share-btn");
  btn.disabled = true;
  btn.textContent = "Saving…";
  try {
    const r = await fetch("/api/share", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: text }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error ?? "share failed");
    const url = `${window.location.origin}/s/${data.id}`;
    const inp = $("share-link");
    inp.value = url;
    inp.hidden = false;
    inp.select();
    btn.textContent = "Copied!";
    navigator.clipboard?.writeText(url).catch(()=>{});
  } catch (err) {
    btn.textContent = "Get shareable link";
    alert(err.message);
  } finally {
    setTimeout(() => { btn.disabled = false; btn.textContent = "Get shareable link"; }, 2000);
  }
}

async function startCheckout() {
  const btn = $("upgrade-btn");
  btn.disabled = true;
  btn.textContent = "Loading…";
  try {
    const r = await fetch("/api/checkout", { method: "POST" });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error ?? "checkout unavailable");
    if (data.checkout_url) {
      window.location = data.checkout_url;
    } else if (data.message) {
      alert(data.message);
    }
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Get Pro";
  }
}

async function loadCryptoAddress() {
  try {
    const r = await fetch("/api/payment-info");
    if (!r.ok) return;
    const data = await r.json();
    if (data.crypto_address) {
      $("crypto-addr").textContent = data.crypto_address;
    } else {
      $("crypto-addr").textContent = "(generating soon)";
    }
  } catch {}
}

document.addEventListener("DOMContentLoaded", () => {
  $("analyze-btn").addEventListener("click", analyze);
  $("share-btn").addEventListener("click", getShareLink);
  $("upgrade-btn").addEventListener("click", startCheckout);
  loadCryptoAddress();

  // Hydrate from /s/<id> path if shared
  const m = window.location.pathname.match(/^\/s\/([a-zA-Z0-9_-]+)$/);
  if (m) {
    fetch(`/api/share?id=${m[1]}`)
      .then(r => r.json())
      .then(data => {
        if (data.prompt) {
          $("prompt-input").value = data.prompt;
          analyze();
        }
      });
  }
});
