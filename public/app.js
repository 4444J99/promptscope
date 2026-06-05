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

// ── USDC checkout (x402-style quote → pay → confirm) ──────────────────────
let CO = { tier: null, quote_id: null, address: null, confirm_url: "/api/confirm" };

function upgrade(tier) {
  CO.tier = tier || "pro";
  $("checkout-title").textContent = "Upgrade to Pro — $19";
  const sec = $("checkout");
  sec.style.display = "";
  $("co-quote").style.display = "none";
  $("co-msg").textContent = "";
  sec.scrollIntoView({ behavior: "smooth", block: "start" });
  startCheckout();
}

async function startCheckout() {
  const btn = $("upgrade-usdc-btn");
  const msg = $("co-msg");
  if (btn) { btn.disabled = true; btn.textContent = "Getting quote…"; }
  msg.style.color = "var(--muted)";
  msg.textContent = "Fetching payment details…";
  try {
    const r = await fetch("/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const d = await r.json();
    if (r.status === 402 && d.pay_to) {
      CO.quote_id = d.quote_id;
      CO.address = d.pay_to.address;
      CO.confirm_url = d.confirm_url || "/api/confirm";
      $("q-amount").textContent = `${d.pay_to.amount} ${d.pay_to.asset}`;
      $("q-asset").textContent = `${d.pay_to.asset} on ${d.pay_to.chain}`;
      $("q-address").textContent = d.pay_to.address;
      $("q-quote").textContent = d.quote_id;
      $("q-instructions").textContent = d.instructions || "";
      $("co-quote").style.display = "";
      msg.style.color = "var(--muted)";
      msg.textContent = "Send the exact amount, then paste your transaction hash below.";
    } else if (r.ok && d.checkout_url) {
      window.location = d.checkout_url;
    } else if (r.ok) {
      msg.style.color = "var(--good)";
      msg.textContent = d.message || "checkout ready";
    } else {
      msg.style.color = "var(--bad)";
      msg.textContent = d.error || "could not start checkout";
    }
  } catch (err) {
    msg.style.color = "var(--bad)";
    msg.textContent = "network error — try again";
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Upgrade to Pro — pay with USDC ($19)"; }
  }
}

async function copyAddr() {
  try {
    await navigator.clipboard.writeText(CO.address || "");
    const b = $("q-copy");
    b.textContent = "copied";
    setTimeout(() => { b.textContent = "copy"; }, 1500);
  } catch (e) {}
}

async function confirmTx() {
  const btn = $("co-confirm-btn");
  const tx = $("co-tx").value.trim();
  const msg = $("co-msg");
  if (!/^0x[0-9a-fA-F]{6,}$/.test(tx)) {
    msg.style.color = "var(--bad)";
    msg.textContent = "paste a valid 0x… transaction hash";
    return;
  }
  if (!CO.quote_id) {
    msg.style.color = "var(--bad)";
    msg.textContent = "get a payment quote first";
    return;
  }
  btn.disabled = true;
  btn.textContent = "verifying…";
  try {
    const r = await fetch(CO.confirm_url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quote_id: CO.quote_id, tx_hash: tx }),
    });
    const d = await r.json();
    if (r.ok) {
      msg.style.color = "var(--good)";
      msg.textContent = "✓ Pro unlocked — receipt recorded. We'll email your access details.";
    } else {
      msg.style.color = "var(--bad)";
      msg.textContent = d.error || "payment not verified yet — on-chain confirmation can take a moment, try again shortly";
    }
  } catch (err) {
    msg.style.color = "var(--bad)";
    msg.textContent = "network error — try again";
  } finally {
    btn.disabled = false;
    btn.textContent = "I've sent it — unlock";
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
  $("upgrade-btn").addEventListener("click", () => upgrade("pro"));
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
