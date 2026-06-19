# PromptScope API

Customer-facing API and usage guide for PromptScope Pro.

Base URL:

```text
https://promptscope.ivixivi.workers.dev
```

All request and response bodies are JSON unless an endpoint says otherwise.
Send JSON requests with:

```http
Content-Type: application/json
```

## Quickstart

Use your Lemon Squeezy license key to unlock Pro analysis, unlimited daily
usage, and suggested rewrites.

```bash
curl https://promptscope.ivixivi.workers.dev/api/analyze \
  -H "Content-Type: application/json" \
  -H "x-promptscope-license: $PROMPTSCOPE_LICENSE_KEY" \
  -d '{
    "prompt": "You are a support assistant. Be helpful and concise."
  }'
```

Example Pro response:

```json
{
  "score": 6,
  "token_count": 15,
  "char_count": 62,
  "plan": "pro",
  "auth": {
    "method": "license",
    "plan": "pro"
  },
  "anti_patterns": [
    {
      "name": "Vague behavior standard",
      "fix": "Replace broad instructions with concrete handling rules."
    }
  ],
  "strengths": [
    "Clear role"
  ],
  "advanced_features": {
    "suggested_rewrite": {
      "locked": false
    }
  },
  "suggested_rewrite": "You are a support assistant for customer help requests. Answer concisely, ask one clarifying question when required, and do not invent account details.",
  "license": {
    "valid": true,
    "status": "active",
    "expires_at": null,
    "product_name": "PromptScope Pro",
    "variant_name": "Monthly",
    "source": "lemonsqueezy"
  }
}
```

## Authentication

PromptScope supports two customer authentication methods.

### Lemon Squeezy License

Use this if you purchased PromptScope Pro directly.

Preferred header:

```http
x-promptscope-license: <your-license-key>
```

Accepted alternatives:

```http
x-promptscope-key: <your-license-key>
x-promptscope-token: <your-license-key>
```

You can also send the key in the JSON body as `license_key` or `licenseKey`,
but a header is recommended so request bodies stay focused on prompt content.

### PromptScope API Key

Some customers or partners may receive a first-party API key beginning with
`psk_`. Use this if PromptScope support issued one to you.

Preferred header:

```http
x-promptscope-api-key: psk_...
```

Accepted alternatives:

```http
x-api-key: psk_...
Authorization: Bearer psk_...
```

You can also send the key in the JSON body as `api_key` or `apiKey`.

### Free and Pro Behavior

Unauthenticated requests are allowed on the free tier:

- 5 analyses per day.
- Rate limit bucket is per IP address.
- Suggested rewrites are locked.

Authenticated Pro requests:

- Have no daily analysis limit enforced by PromptScope.
- Include `suggested_rewrite` when the rewrite model succeeds.
- Omit `quota_remaining` because Pro usage is not counted against the free
  quota.

If an invalid license or API key is sent to `POST /api/analyze`, PromptScope
does not fail the request solely because of that credential. It falls back to
the free tier and, for invalid license keys, includes `license_error` in the
response. To explicitly verify a license before calling analyze, use
`POST /api/license`.

## Prompt Analysis

Analyze a system prompt and receive a structured critique.

```http
POST /api/analyze
```

### Request

```json
{
  "prompt": "You are an assistant...",
  "license_key": "optional Lemon Squeezy license key",
  "api_key": "optional PromptScope API key"
}
```

Fields:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `prompt` | string | yes | System prompt to analyze. Maximum 32,000 characters. |
| `license_key` | string | no | Lemon Squeezy license key. Prefer the `x-promptscope-license` header. |
| `licenseKey` | string | no | Camel-case alias for `license_key`. |
| `api_key` | string | no | First-party `psk_...` API key. Prefer the `x-promptscope-api-key` header. |
| `apiKey` | string | no | Camel-case alias for `api_key`. |

### Response

Common response fields:

| Field | Type | Description |
|-------|------|-------------|
| `score` | number | Prompt quality score from 0 to 10. |
| `token_count` | number | Approximate token count, estimated as characters divided by 4. |
| `char_count` | number | Exact prompt length in characters. |
| `plan` | string | `free` or `pro`. |
| `auth` | object | Authentication method used for this response. |
| `anti_patterns` | array | Up to 12 detected issues, each with `name` and `fix`. |
| `strengths` | array | Up to 8 concise strengths. |
| `advanced_features` | object | Feature lock state and upgrade URL when relevant. |
| `suggested_rewrite` | string | Pro-only rewritten prompt, when rewrite generation succeeds. |
| `quota_remaining` | number | Free-tier analyses remaining today. Omitted for Pro. |
| `license` | object | Public license validation details when a license was evaluated. |
| `license_error` | string | Reason a supplied license was not accepted. |
| `rewrite_error` | string | `rewrite unavailable` if Pro analysis succeeded but rewrite generation failed. |

Free response example:

```json
{
  "score": 5,
  "token_count": 8,
  "char_count": 32,
  "plan": "free",
  "auth": {
    "method": "none",
    "plan": "free"
  },
  "anti_patterns": [
    {
      "name": "Vague instructions",
      "fix": "Name the specific behaviors expected from the assistant."
    }
  ],
  "strengths": [
    "Short and easy to scan"
  ],
  "advanced_features": {
    "suggested_rewrite": {
      "locked": true,
      "upgrade_url": "/api/checkout"
    }
  },
  "quota_remaining": 4
}
```

Response with an issued API key:

```json
{
  "score": 8,
  "token_count": 42,
  "char_count": 168,
  "plan": "pro",
  "auth": {
    "method": "api_key",
    "key_id": "8d3f1c2a9b0e7a64",
    "plan": "pro"
  },
  "anti_patterns": [],
  "strengths": [
    "Clear output schema",
    "Specific refusal boundaries"
  ],
  "advanced_features": {
    "suggested_rewrite": {
      "locked": false
    }
  },
  "suggested_rewrite": "..."
}
```

### Status Codes

| Status | Meaning |
|--------|---------|
| `200` | Analysis completed. |
| `400` | Invalid JSON, missing `prompt`, or prompt exceeds 32,000 characters. |
| `405` | HTTP method is not allowed. |
| `429` | Free daily quota exhausted. Upgrade or authenticate with Pro. |
| `500` | Model inference failed before analysis completed. |
| `502` | Model returned malformed analysis output. |

### Endpoint Manifest

```http
GET /api/analyze
```

Returns a small self-describing JSON manifest for the analyze endpoint,
including accepted auth headers, the free limit, and the upgrade URL.

## License Validation

Validate a Lemon Squeezy license key before making Pro calls.

```http
POST /api/license
```

### Request

```json
{
  "license_key": "your-license-key"
}
```

`licenseKey` is also accepted.

### Valid License Response

Status: `200`

```json
{
  "valid": true,
  "plan": "pro",
  "upgrade_url": "https://your-store.lemonsqueezy.com/buy/...",
  "license": {
    "valid": true,
    "status": "active",
    "expires_at": null,
    "product_name": "PromptScope Pro",
    "variant_name": "Monthly",
    "source": "lemonsqueezy"
  }
}
```

### Invalid License Response

Status: `401`

```json
{
  "valid": false,
  "plan": "free",
  "upgrade_url": "https://your-store.lemonsqueezy.com/buy/...",
  "license": {
    "valid": false,
    "error": "license is not valid"
  }
}
```

License validation is cached for up to 10 minutes. A cached valid response may
show `"source": "cache"` instead of `"lemonsqueezy"`.

### Endpoint Manifest

```http
GET /api/license
```

Returns the accepted license header, accepted request body field, upgrade URL,
and license cache TTL.

## Share Links

Create or retrieve a prompt share link.

Prompt content is stored only when you call this endpoint. Shared prompts expire
after 30 days.

### Create Share

```http
POST /api/share
```

Request:

```json
{
  "prompt": "You are an assistant..."
}
```

Response:

```json
{
  "id": "uIFhXwIwkT4R",
  "expires_in_seconds": 2592000
}
```

Status codes:

| Status | Meaning |
|--------|---------|
| `200` | Share created. |
| `400` | Invalid JSON, missing `prompt`, or prompt exceeds 32,000 characters. |
| `405` | HTTP method is not allowed. |

### Retrieve Share

```http
GET /api/share?id=uIFhXwIwkT4R
```

Response:

```json
{
  "id": "uIFhXwIwkT4R",
  "prompt": "You are an assistant..."
}
```

Status codes:

| Status | Meaning |
|--------|---------|
| `200` | Share found. |
| `400` | Missing or invalid `id`. IDs may contain only letters, numbers, `_`, and `-`. |
| `404` | Share was not found or has expired. |
| `405` | HTTP method is not allowed. |

## Checkout

Open or retrieve the configured PromptScope Pro checkout URL.

### Browser Redirect

```http
GET /api/checkout
```

Returns a `303` redirect to the Lemon Squeezy checkout URL.

### JSON Checkout URL

```http
POST /api/checkout
```

Response:

```json
{
  "checkout_url": "https://your-store.lemonsqueezy.com/buy/...",
  "upgrade_url": "https://your-store.lemonsqueezy.com/buy/..."
}
```

Status codes:

| Status | Meaning |
|--------|---------|
| `200` | JSON checkout URL returned. |
| `303` | Browser redirect returned for `GET`. |
| `405` | HTTP method is not allowed. |
| `503` | Checkout URL is not configured. |

## API Index

```http
GET /api
```

Returns a top-level API manifest:

```json
{
  "name": "PromptScope API",
  "endpoints": {
    "analyze": "POST /api/analyze",
    "license": "POST /api/license",
    "keys": "GET|POST|DELETE /api/keys (admin)",
    "share": "POST /api/share",
    "checkout": "GET /api/checkout",
    "stats": "GET /api/stats"
  },
  "dashboard": "/dashboard",
  "free_limit": "5 / day (per API key, else per IP)",
  "auth": {
    "api_key_header": "x-promptscope-api-key",
    "license_header": "x-promptscope-license",
    "admin": "Authorization: Bearer <ADMIN_TOKEN> on /api/keys"
  },
  "upgrade_url": "/api/checkout"
}
```

## Usage Stats

```http
GET /api/stats
```

Returns aggregate usage and operational counters. Prompt text is not included.
The response is cacheable for up to 60 seconds.

Example response:

```json
{
  "generated_at": "2026-06-19T20:00:00.000Z",
  "since": "2026-06-01",
  "window_days": 14,
  "metrics": [
    "analyze",
    "analyze_free",
    "analyze_pro",
    "rewrite",
    "tokens",
    "share_created",
    "rate_limited",
    "license_valid",
    "license_invalid"
  ],
  "totals": {
    "analyze": 120,
    "analyze_pro": 82,
    "tokens": 31450
  },
  "today": {
    "date": "2026-06-19",
    "analyze": 12
  },
  "daily": [
    {
      "date": "2026-06-06",
      "analyze": 4
    }
  ],
  "config": {
    "free_daily_limit": 5,
    "pro_checkout_configured": true
  }
}
```

## Admin API Keys

This section is for PromptScope operators, not normal Pro customers.

API-key administration is protected by `ADMIN_TOKEN`. The token is accepted as:

```http
Authorization: Bearer <ADMIN_TOKEN>
```

or:

```http
x-promptscope-admin: <ADMIN_TOKEN>
```

If `ADMIN_TOKEN` is not configured, `/api/keys` returns `503` and key
administration is disabled.

### Issue Key

```http
POST /api/keys
```

Request:

```json
{
  "label": "customer-name-or-integration",
  "plan": "pro"
}
```

`plan` may be `pro` or `free`; it defaults to `pro`.

Response status: `201`

```json
{
  "api_key": "psk_...",
  "note": "Store this now - it is shown only once and cannot be recovered.",
  "id": "8d3f1c2a9b0e7a64",
  "label": "customer-name-or-integration",
  "plan": "pro",
  "createdAt": "2026-06-19T20:00:00.000Z"
}
```

Plaintext API keys are shown only once. PromptScope stores only a SHA-256 hash
of each key.

### List Keys

```http
GET /api/keys
```

Response:

```json
{
  "keys": [
    {
      "id": "8d3f1c2a9b0e7a64",
      "label": "customer-name-or-integration",
      "plan": "pro",
      "createdAt": "2026-06-19T20:00:00.000Z"
    }
  ]
}
```

The plaintext key is never returned by list responses.

### Revoke Key

```http
DELETE /api/keys
```

Request:

```json
{
  "id": "8d3f1c2a9b0e7a64"
}
```

Response:

```json
{
  "revoked": true,
  "id": "8d3f1c2a9b0e7a64"
}
```

Revoked keys fail verification immediately and callers fall back to the free
tier on `POST /api/analyze`.

## Client Examples

### JavaScript

```js
async function analyzePrompt(prompt, licenseKey) {
  const response = await fetch("https://promptscope.ivixivi.workers.dev/api/analyze", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-promptscope-license": licenseKey,
    },
    body: JSON.stringify({ prompt }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || `PromptScope API error ${response.status}`);
  }
  return data;
}
```

### Python

```python
import os
import requests

response = requests.post(
    "https://promptscope.ivixivi.workers.dev/api/analyze",
    headers={
        "Content-Type": "application/json",
        "x-promptscope-license": os.environ["PROMPTSCOPE_LICENSE_KEY"],
    },
    json={
        "prompt": "You are a support assistant. Be concise and cite policy IDs."
    },
    timeout=60,
)
response.raise_for_status()
print(response.json())
```

### Validate Then Analyze

```bash
curl https://promptscope.ivixivi.workers.dev/api/license \
  -H "Content-Type: application/json" \
  -d '{"license_key":"'"$PROMPTSCOPE_LICENSE_KEY"'"}'

curl https://promptscope.ivixivi.workers.dev/api/analyze \
  -H "Content-Type: application/json" \
  -H "x-promptscope-license: $PROMPTSCOPE_LICENSE_KEY" \
  -d '{"prompt":"You are an assistant for refund policy questions."}'
```

## Privacy and Retention

PromptScope processes submitted prompt text to generate an analysis response.
Prompt text is not stored by PromptScope during `POST /api/analyze`.

Prompt text is stored only when you explicitly call `POST /api/share`; those
share records expire after 30 days.

Operational metrics in `/api/stats` are counters only. They do not include
prompt content.

## Integration Checklist

- Store your license key or API key in server-side secrets, not browser-visible
  JavaScript, unless the call is intentionally made from an end-user browser.
- Prefer auth headers over body fields.
- Treat `429` as a signal to authenticate with Pro or retry after the daily
  free quota resets.
- Handle `rewrite_error` separately from analysis failure. A Pro response can
  contain a complete analysis even if the suggested rewrite is temporarily
  unavailable.
- Do not call `/api/share` unless you want PromptScope to persist the prompt for
  a share link.
