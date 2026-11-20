// Għerf knowledge service: keeps the API key on the server and streams answers to the app.
// Set the environment variable AI_API_KEY in Netlify → Site configuration → Environment variables.
const hits = new Map(); // simple per-visitor limit (per edge instance)
const LIMIT = 60, WINDOW_MS = 10 * 60 * 1000;

async function diagnose() {
  const key = (Netlify.env.get("AI_API_KEY") || "").trim();
  const out = (status, msg, fix) => new Response(
    `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:system-ui;background:#070b1a;color:#eef2ff;padding:28px;line-height:1.5"><h2>Għerf service check</h2><p style="font-size:20px">${status}</p><p>${msg}</p>${fix ? `<p style="color:#fbbf24"><b>Fix:</b> ${fix}</p>` : ""}</body>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  if (!key) return out("❌ Key missing", "The environment variable AI_API_KEY is not set for this site (or the site wasn't redeployed after adding it).", "Netlify → Site configuration → Environment variables → add AI_API_KEY → then Deploys → Trigger deploy → Deploy site.");
  if (!key.startsWith("sk-ant-")) return out("❌ Key looks wrong", "The saved key doesn't start with sk-ant-. It may have been pasted incompletely.", "Copy the key again and replace the value, then redeploy.");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-haiku-5-5", max_tokens: 5, messages: [{ role: "user", content: "Say OK" }] }),
  });
  if (r.ok) return out("✅ Working", "The knowledge service is connected and answering.", "");
  let m = ""; try { m = (await r.json()).error?.message || ""; } catch {}
  if (r.status === 401) return out("❌ Key rejected", "The key was refused (it may be deleted, mistyped or from a different account).", "Create a new key in the console, paste it into AI_API_KEY, then redeploy.");
  if (/credit|balance|billing/i.test(m)) return out("❌ No credit", "The account has no credit left.", "console.anthropic.com → Billing → add credit. No redeploy needed.");
  if (r.status === 404 || /model/i.test(m)) return out("❌ Model not available", "The account can't use the requested model: " + m, "Send this screen to your developer.");
  if (r.status === 429) return out("⚠️ Rate limited", "Too many requests right now, or the spend limit was reached.", "Wait a minute, or raise the limit in console → Settings → Limits.");
  return out("❌ Error " + r.status, m || "Unknown error.", "Send this screen to your developer.");
}

export default async (req, context) => {
  if (req.method === "GET") return diagnose();
  if (req.method !== "POST") return new Response("Not found", { status: 404 });

  const origin = req.headers.get("origin");
  const host = new URL(req.url).host;
  if (origin) { try { if (new URL(origin).host !== host) return new Response("Forbidden", { status: 403 }); } catch { return new Response("Forbidden", { status: 403 }); } }

  const ip = context.ip || "anon", now = Date.now();
  const h = (hits.get(ip) || []).filter(t => now - t < WINDOW_MS);
  if (h.length >= LIMIT) return new Response("Slow down", { status: 429 });
  h.push(now); hits.set(ip, h);

  const key = (Netlify.env.get("AI_API_KEY") || "").trim();
  if (!key) return new Response("Service not configured", { status: 503 });

  let body;
  try { body = await req.json(); } catch { return new Response("Bad request", { status: 400 }); }
  const messages = (Array.isArray(body.messages) ? body.messages : []).slice(-12)
    .filter(m => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map(m => ({ role: m.role, content: m.content.slice(0, 30000) }));
  if (!messages.length || messages[messages.length - 1].role !== "user") return new Response("Bad request", { status: 400 });

  const model = body.tier === "quick" ? "claude-haiku-5-5" : "claude-sonnet-5-5";
  const upstream = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: 8000, stream: true, messages }),
  });
  if (!upstream.ok) {
    let detail = ""; try { detail = await upstream.text(); } catch {}
    console.log("upstream error", upstream.status, detail.slice(0, 300));
    return new Response("Service error", { status: upstream.status === 429 ? 429 : 502 });
  }

  return new Response(upstream.body, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
};

export const config = { path: "/api/ai" };
