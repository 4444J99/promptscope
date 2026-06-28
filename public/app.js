// PromptScope frontend.
// Browser -> POST /api/analyze -> Worker validates optional Lemon Squeezy key.

const $ = (id) => document.getElementById(id);
const LICENSE_STORAGE_KEY = "promptscope:license-key";
let upgradeUrl = "/api/checkout";
let latestApiExample = "";

function storedLicenseKey() {
  return localStorage.getItem(LICENSE_STORAGE_KEY) || "";
}

function setStoredLicenseKey(value) {
  if (value) {
    localStorage.setItem(LICENSE_STORAGE_KEY, value);
  } else {
    localStorage.removeItem(LICENSE_STORAGE_KEY);
  }
}

function setLoading(loading) {
  $("analyze-btn").disabled = loading;
  $("analyze-btn").textContent = loading ? "Analyzing..." : "Analyze";
}

function setUpgradeLinks(url) {
  if (!url) return;
  upgradeUrl = url;
  document.querySelectorAll("[data-upgrade-link]").forEach((el) => {
    el.href = upgradeUrl;
  });
}

function setLicenseStatus(message, tone = "") {
  const el = $("license-status");
  el.textContent = message || "";
  el.className = `license-status ${tone}`.trim();
}

function setProUi(active) {
  $("license-clear-btn").hidden = !storedLicenseKey();
  if (active) {
    $("quota").textContent = "Pro license active";
    setLicenseStatus("Pro license active", "good");
  }
}

function formatLicenseDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function buildApiExample(data = {}) {
  const endpoint = data.api?.analyze_endpoint || `${window.location.origin}/api/analyze`;
  return `curl ${endpoint} \\
  -H "Content-Type: application/json" \\
  -H "x-promptscope-license: $PROMPTSCOPE_LICENSE_KEY" \\
  -d '{"prompt":"You are a helpful assistant."}'`;
}

function renderDashboard(data = {}) {
  const isPro = data.plan === "pro" && data.valid_license === true;
  const license = data.license || {};
  const usage = data.usage || {};
  const entitlements = data.entitlements || {};

  $("dashboard-plan").textContent = isPro ? "Pro" : "Free";
  $("dashboard-license").textContent = isPro
    ? (license.variant_name || license.status || "Valid")
    : (data.license_error ? "Rejected" : "Not connected");
  $("dashboard-usage").textContent = isPro
    ? (usage.quota_label || "Unlimited")
    : `${usage.quota_remaining ?? 5} / ${usage.quota_limit ?? 5} left`;
  $("dashboard-api").textContent = entitlements.api_access ? "Enabled" : "Locked";

  const detail = [license.product_name, license.variant_name].filter(Boolean).join(" / ");
  const expires = formatLicenseDate(license.expires_at);
  const message = isPro
    ? [detail || "License validated", expires ? `Expires ${expires}` : ""].filter(Boolean).join(" - ")
    : (data.license_error || "Free plan active");
  const tone = isPro ? "good" : (data.license_error ? "bad" : "");
  $("dashboard-message").textContent = message;
  $("dashboard-message").className = `dashboard-message ${tone}`.trim();

  $("api-panel").hidden = !isPro;
  $("dashboard-upgrade").hidden = isPro;
  latestApiExample = buildApiExample(data);
  $("api-example").textContent = latestApiExample;
  if (data.upgrade_url) setUpgradeLinks(data.upgrade_url);
}

async function refreshDashboard() {
  const btn = $("dashboard-refresh-btn");
  btn.disabled = true;
  btn.textContent = "Refreshing...";
  try {
    const headers = {};
    const licenseKey = storedLicenseKey();
    if (licenseKey) headers["x-promptscope-license"] = licenseKey;

    const r = await fetch("/api/account", { headers });
    const data = await r.json();
    renderDashboard(data);
  } catch {
    $("dashboard-message").textContent = "Account status unavailable.";
    $("dashboard-message").className = "dashboard-message bad";
  } finally {
    btn.disabled = false;
    btn.textContent = "Refresh";
  }
}

async function copyApiExample() {
  const btn = $("copy-api-btn");
  const text = latestApiExample || $("api-example").textContent;
  if (!text) return;
  try {
    if (!navigator.clipboard) throw new Error("clipboard unavailable");
    await navigator.clipboard.writeText(text);
    btn.textContent = "Copied";
  } catch {
    btn.textContent = "Copy failed";
  } finally {
    setTimeout(() => { btn.textContent = "Copy cURL"; }, 1600);
  }
}

function renderResult(data) {
  $("results").hidden = false;
  $("score-num").textContent = data.score?.toFixed(1) ?? "--";
  $("token-count").textContent = data.token_count ?? "--";
  $("char-count").textContent = data.char_count ?? "--";

  $("anti-patterns").innerHTML = (data.anti_patterns ?? [])
    .map(ap => `<li>
      <div class="name">${escapeHtml(ap.name)}</div>
      <div class="fix">${escapeHtml(ap.fix)}</div>
    </li>`).join("") || `<li>None detected.</li>`;

  $("strengths").innerHTML = (data.strengths ?? [])
    .map(s => `<li><div class="name">${escapeHtml(s)}</div></li>`).join("")
    || `<li>None notable.</li>`;

  const rewriteUpsell = $("rewrite-upsell");
  if (data.suggested_rewrite) {
    $("rewrite-block").textContent = data.suggested_rewrite;
    $("rewrite-lock").hidden = true;
    rewriteUpsell.hidden = true;
  } else if (data.plan === "pro" && data.rewrite_error) {
    $("rewrite-block").textContent = "Rewrite is temporarily unavailable. Your basic analysis completed.";
    $("rewrite-lock").hidden = true;
    rewriteUpsell.hidden = true;
  } else {
    $("rewrite-block").textContent = "Pro unlocks a structured rewrite that preserves your intent and removes the detected anti-patterns.";
    $("rewrite-lock").hidden = false;
    rewriteUpsell.hidden = false;
  }

  if (data.plan === "pro") setProUi(true);
  if (data.license_error) setLicenseStatus(`License not accepted: ${data.license_error}`, "bad");
  if (data.advanced_features?.suggested_rewrite?.upgrade_url) {
    setUpgradeLinks(data.advanced_features.suggested_rewrite.upgrade_url);
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
    const headers = { "Content-Type": "application/json" };
    const licenseKey = storedLicenseKey();
    if (licenseKey) headers["x-promptscope-license"] = licenseKey;

    const r = await fetch("/api/analyze", {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: text }),
    });
    const data = await r.json();
    if (data.upgrade_url) setUpgradeLinks(data.upgrade_url);
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

async function saveLicense() {
  const key = $("license-key").value.trim();
  if (!key) {
    setLicenseStatus("Paste a Lemon Squeezy license key first.", "bad");
    return;
  }

  const btn = $("license-save-btn");
  btn.disabled = true;
  btn.textContent = "Checking...";
  setLicenseStatus("Checking license...");

  try {
    const r = await fetch("/api/license", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ license_key: key }),
    });
    const data = await r.json();
    if (data.upgrade_url) setUpgradeLinks(data.upgrade_url);
    if (!r.ok || !data.valid) {
      throw new Error(data.license?.error || "license is not valid");
    }

    setStoredLicenseKey(key);
    setProUi(true);
    await refreshDashboard();
  } catch (err) {
    const message = err.message ?? "License is not valid.";
    setStoredLicenseKey("");
    $("license-clear-btn").hidden = true;
    setLicenseStatus(message, "bad");
    await refreshDashboard();
    $("dashboard-message").textContent = message;
    $("dashboard-message").className = "dashboard-message bad";
  } finally {
    btn.disabled = false;
    btn.textContent = "Save license";
  }
}

function clearLicense() {
  setStoredLicenseKey("");
  $("license-key").value = "";
  $("license-clear-btn").hidden = true;
  $("quota").textContent = "5 free analyses / day";
  setLicenseStatus("License cleared.");
  refreshDashboard();
}

async function hydrateLicense() {
  const key = storedLicenseKey();
  if (!key) return;
  $("license-key").value = key;
  $("license-clear-btn").hidden = false;
  setLicenseStatus("Checking saved license...");
  try {
    const r = await fetch("/api/license", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ license_key: key }),
    });
    const data = await r.json();
    if (data.upgrade_url) setUpgradeLinks(data.upgrade_url);
    if (r.ok && data.valid) {
      setProUi(true);
    } else {
      setLicenseStatus(`Saved license not accepted: ${data.license?.error || "invalid"}`, "bad");
    }
  } catch {
    setLicenseStatus("Could not check saved license yet.");
  }
}

async function loadLicenseConfig() {
  try {
    const r = await fetch("/api/license");
    if (!r.ok) return;
    const data = await r.json();
    setUpgradeLinks(data.upgrade_url);
  } catch {}
}

async function getShareLink() {
  const text = $("prompt-input").value.trim();
  if (!text) return;
  const btn = $("share-btn");
  btn.disabled = true;
  btn.textContent = "Saving...";
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

document.addEventListener("DOMContentLoaded", () => {
  $("analyze-btn").addEventListener("click", analyze);
  $("share-btn").addEventListener("click", getShareLink);
  $("license-save-btn").addEventListener("click", saveLicense);
  $("license-clear-btn").addEventListener("click", clearLicense);
  $("dashboard-refresh-btn").addEventListener("click", refreshDashboard);
  $("copy-api-btn").addEventListener("click", copyApiExample);
  $("license-key").addEventListener("keydown", (event) => {
    if (event.key === "Enter") saveLicense();
  });

  loadLicenseConfig().finally(() => {
    hydrateLicense().finally(refreshDashboard);
  });

  // Hydrate from /s/<id> path if shared.
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
