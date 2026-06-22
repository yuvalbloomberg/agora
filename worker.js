/**
 * Agora Worker v4.0.0
 * Multi-model AI brainstorming roundtable.
 *
 * Secrets: ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, GROK_API_KEY
 * KV Binding: ROUNDTABLE_KV
 */

const APP_VERSION = "4.0.0";

const MODEL_CONFIG = {
  claude: { label: "Claude", call: callClaude },
  gpt:    { label: "GPT",    call: callOpenAI },
  gemini: { label: "Gemini", call: callGemini },
  grok:   { label: "Grok",   call: callGrok },
};

const SPEAKER_DELAY_MS = 2500;
const POLL_PAUSE_MS    = 1500;

export default {
  async fetch(request, env) {
    const url  = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders() });

    if (path === "/" || path === "/index.html")
      return new Response(INDEX_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });

    // conversations list / create
    if (path === "/api/conversations" && request.method === "GET")  return listConversations(env);
    if (path === "/api/conversations" && request.method === "POST") return createConversation(request, env);

    // single conversation
    const cm = path.match(/^\/api\/conversations\/([a-zA-Z0-9_-]+)$/);
    if (cm && request.method === "GET")    return getConversation(cm[1], env);
    if (cm && request.method === "DELETE") return deleteConversation(cm[1], env);
    if (cm && request.method === "PATCH")  return patchConversation(cm[1], request, env);

    // sub-routes
    const sub = path.match(/^\/api\/conversations\/([a-zA-Z0-9_-]+)\/([a-z]+)$/);
    if (sub && request.method === "POST") {
      const [, id, action] = sub;
      if (action === "continue")  return continueConversation(id, request, env);
      if (action === "control")   return controlConversation(id, request, env);
      if (action === "intervene") return humanIntervene(id, request, env);
      if (action === "insights")  return generateInsights(id, request, env);
    }

    return new Response("Not found", { status: 404, headers: corsHeaders() });
  },
};

/* ── helpers ──────────────────────────────────────────────────────────── */

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}
function jsonResp(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ── KV ───────────────────────────────────────────────────────────────── */

const K = {
  conv:    id => `conv:${id}`,
  ctrl:    id => `control:${id}`,
  index:   ()  => `index`,
};

async function kvGet(env, key)        { const r = await env.ROUNDTABLE_KV.get(key); return r ? JSON.parse(r) : null; }
async function kvSet(env, key, val)   { await env.ROUNDTABLE_KV.put(key, JSON.stringify(val)); }
async function kvDel(env, key)        { await env.ROUNDTABLE_KV.delete(key); }

async function loadConv(id, env)  { return kvGet(env, K.conv(id)); }
async function saveConv(conv, env){ await kvSet(env, K.conv(conv.id), conv); }

async function addIndex(id, topic, env) {
  const idx = (await kvGet(env, K.index())) || [];
  idx.unshift({ id, topic, createdAt: Date.now() });
  await kvSet(env, K.index(), idx);
}
async function removeIndex(id, env) {
  const idx = (await kvGet(env, K.index())) || [];
  await kvSet(env, K.index(), idx.filter(e => e.id !== id));
}
async function getCtrl(id, env)        { return (await env.ROUNDTABLE_KV.get(K.ctrl(id))) || "running"; }
async function setCtrl(id, val, env)   { await env.ROUNDTABLE_KV.put(K.ctrl(id), val); }

/* ── route handlers ───────────────────────────────────────────────────── */

async function listConversations(env) {
  return jsonResp((await kvGet(env, K.index())) || []);
}

async function getConversation(id, env) {
  const conv = await loadConv(id, env);
  return conv ? jsonResp(conv) : jsonResp({ error: "not found" }, 404);
}

async function deleteConversation(id, env) {
  await kvDel(env, K.conv(id));
  await kvDel(env, K.ctrl(id));
  await removeIndex(id, env);
  return jsonResp({ ok: true });
}

// PATCH: update participants order, roles, domain, adminToken, rating
async function patchConversation(id, request, env) {
  const conv = await loadConv(id, env);
  if (!conv) return jsonResp({ error: "not found" }, 404);
  const body = await request.json();

  // admin check (if adminToken set)
  if (conv.adminToken && body.adminToken !== conv.adminToken)
    return jsonResp({ error: "unauthorized" }, 403);

  if (body.participants !== undefined) conv.participants = body.participants;
  if (body.roles        !== undefined) conv.roles        = body.roles;
  if (body.domain       !== undefined) conv.domain       = body.domain;
  if (body.rating       !== undefined) conv.rating       = body.rating;
  if (body.insights     !== undefined) conv.insights     = body.insights;

  await saveConv(conv, env);
  return jsonResp({ ok: true });
}

async function controlConversation(id, request, env) {
  const body = await request.json();
  if (!["pause", "resume", "stop"].includes(body.action))
    return jsonResp({ error: "invalid action" }, 400);
  await setCtrl(id, body.action, env);
  return jsonResp({ ok: true });
}

async function humanIntervene(id, request, env) {
  const conv = await loadConv(id, env);
  if (!conv) return jsonResp({ error: "not found" }, 404);
  const { text } = await request.json();
  if (!text?.trim()) return jsonResp({ error: "missing text" }, 400);
  const entry = { speaker: "Human", model: "human", text: text.trim(), round: conv.roundsCompleted, ts: Date.now() };
  conv.transcript.push(entry);
  await saveConv(conv, env);
  return jsonResp({ ok: true, entry });
}

async function generateInsights(id, request, env) {
  const conv = await loadConv(id, env);
  if (!conv) return jsonResp({ error: "not found" }, 404);

  const history = conv.transcript.map(t => `${t.speaker}: ${t.text}`).join("\n\n");
  const prompt  = `You are summarizing a multi-model AI brainstorming session.\nTopic: "${conv.topic}"\n\nFull discussion:\n${history}\n\nExtract 5-8 key insights as a JSON array of strings. Return ONLY the JSON array, no other text.`;

  let insights;
  try {
    const raw = await callClaude(prompt, env, null);
    insights  = JSON.parse(raw.replace(/```json|```/g, "").trim());
  } catch (e) {
    insights = ["Could not generate insights: " + e.message];
  }
  conv.insights = insights;
  await saveConv(conv, env);
  return jsonResp({ insights });
}

async function createConversation(request, env) {
  const body  = await request.json();
  const topic = (body.topic || "").trim();
  if (!topic) return jsonResp({ error: "missing topic" }, 400);

  const participants = (body.participants || ["claude", "gpt", "gemini", "grok"]).filter(p => MODEL_CONFIG[p]);
  if (participants.length < 2) return jsonResp({ error: "need at least 2 participants" }, 400);

  const rounds     = Math.min(Math.max(parseInt(body.rounds) || 3, 1), 20);
  const roles      = body.roles   || {};   // { claude: "CEO", gpt: "Sales expert", ... }
  const domain     = body.domain  || "";
  const attachment = body.attachment || null;
  const adminToken = body.adminToken || null;

  const id   = crypto.randomUUID();
  const conv = {
    id, topic, participants, roles, domain, attachment, adminToken,
    transcript: [{ speaker: "Moderator (you)", model: "user", text: topic, round: 0, ts: Date.now() }],
    roundsCompleted: 0, insights: [], rating: {}, createdAt: Date.now(),
  };
  await saveConv(conv, env);
  await addIndex(id, topic, env);
  await setCtrl(id, "running", env);
  return runRounds(conv, rounds, env);
}

async function continueConversation(id, request, env) {
  const conv = await loadConv(id, env);
  if (!conv) return jsonResp({ error: "not found" }, 404);
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const rounds = Math.min(Math.max(parseInt(body.rounds) || 3, 1), 20);
  await setCtrl(id, "running", env);
  return runRounds(conv, rounds, env);
}

/* ── SSE run loop ─────────────────────────────────────────────────────── */

function runRounds(conv, roundsToRun, env) {
  const { readable, writable } = new TransformStream();
  const writer  = writable.getWriter();
  const enc     = new TextEncoder();
  const send    = async d => writer.write(enc.encode(`data: ${JSON.stringify(d)}\n\n`));

  (async () => {
    try {
      await send({ type: "start", id: conv.id, topic: conv.topic, participants: conv.participants });

      const startRound = conv.roundsCompleted + 1;
      const endRound   = conv.roundsCompleted + roundsToRun;

      for (let round = startRound; round <= endRound; round++) {
        const roundTs = new Date().toISOString();
        await send({ type: "round_start", round, ts: roundTs });

        for (const key of conv.participants) {
          let status = await getCtrl(conv.id, env);
          while (status === "pause") {
            await send({ type: "paused" });
            await sleep(POLL_PAUSE_MS);
            status = await getCtrl(conv.id, env);
          }
          if (status === "stop") {
            await send({ type: "stopped" });
            await saveConv(conv, env);
            return;
          }

          const model = MODEL_CONFIG[key];
          await send({ type: "thinking", model: key, label: model.label, round });
          if (conv.transcript.length > 1) await sleep(SPEAKER_DELAY_MS);

          const includeAttachment = conv.attachment && conv.transcript.length === 1;
          const prompt = buildPrompt(conv, model.label);

          let replyText;
          try {
            replyText = await model.call(prompt, env, includeAttachment ? conv.attachment : null);
          } catch (err) {
            replyText = `[Error calling ${model.label}: ${err.message}]`;
          }

          const entry = { speaker: model.label, model: key, text: replyText, round, ts: new Date().toISOString() };
          conv.transcript.push(entry);
          await saveConv(conv, env);
          await send({ type: "message", ...entry });
        }
        conv.roundsCompleted = round;
        await saveConv(conv, env);
      }
      await send({ type: "done" });
    } catch (err) {
      await send({ type: "error", message: err.message });
    } finally {
      try { await writer.close(); } catch (e) {}
    }
  })();

  return new Response(readable, {
    headers: { ...corsHeaders(), "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}

/* ── prompt builder ───────────────────────────────────────────────────── */

function buildPrompt(conv, selfLabel) {
  const { topic, transcript, participants, roles, domain } = conv;
  const others = participants.map(p => MODEL_CONFIG[p].label).filter(l => l !== selfLabel).join(", ");
  const myRole = roles?.[Object.keys(MODEL_CONFIG).find(k => MODEL_CONFIG[k].label === selfLabel)] || "";
  const history = transcript.map(t => `${t.speaker}: ${t.text}`).join("\n\n");

  return [
    `You are participating in a multi-model AI brainstorming roundtable with: ${participants.map(p => MODEL_CONFIG[p].label).join(", ")}.`,
    domain   ? `Domain/context: ${domain}` : "",
    myRole   ? `Your assigned role in this session: ${myRole}` : "",
    `\nTopic: "${topic}"`,
    `\nDiscussion so far:\n${history}`,
    `\nYour turn, ${selfLabel}. Respond directly to what was just said (by ${others}). Agree, disagree, add a new angle, push back, or suggest a direction. Write like a real live participant — concise, max ~120 words, no preamble.`,
  ].filter(Boolean).join("\n");
}

/* ── model calls ──────────────────────────────────────────────────────── */

function buildAttachmentContent(attachment, kind) {
  if (!attachment) return [];
  if (kind === "anthropic") {
    if (attachment.kind === "image")
      return [{ type: "image", source: { type: "base64", media_type: attachment.mediaType, data: attachment.data } }];
    if (attachment.kind === "pdf")
      return [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: attachment.data } }];
    return [{ type: "text", text: `[File: ${attachment.filename}]\n${attachment.data}` }];
  }
  if (kind === "openai") {
    if (attachment.kind === "image")
      return [{ type: "image_url", image_url: { url: `data:${attachment.mediaType};base64,${attachment.data}` } }];
    return [{ type: "text", text: `[File: ${attachment.filename}]\n${attachment.data}` }];
  }
  if (kind === "gemini") {
    if (attachment.kind === "image" || attachment.kind === "pdf")
      return [{ inline_data: { mime_type: attachment.mediaType, data: attachment.data } }];
    return [{ text: `[File: ${attachment.filename}]\n${attachment.data}` }];
  }
  return [];
}

async function callClaude(prompt, env, attachment) {
  const content = [...buildAttachmentContent(attachment, "anthropic"), { type: "text", text: prompt }];
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 500, messages: [{ role: "user", content }] }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  return ((await res.json()).content || []).map(c => c.text || "").join("").trim();
}

async function callOpenAI(prompt, env, attachment) {
  const content = [...buildAttachmentContent(attachment, "openai"), { type: "text", text: prompt }];
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model: "gpt-4.1", max_tokens: 500, messages: [{ role: "user", content }] }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  return (await res.json()).choices?.[0]?.message?.content?.trim() || "";
}

async function callGemini(prompt, env, attachment) {
  const parts = [...buildAttachmentContent(attachment, "gemini"), { text: prompt }];
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${env.GEMINI_API_KEY}`,
    { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts }], generationConfig: { maxOutputTokens: 500 } }) },
  );
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  return (await res.json()).candidates?.[0]?.content?.parts?.map(p => p.text).join("").trim() || "";
}

async function callGrok(prompt, env, attachment) {
  const content = [...buildAttachmentContent(attachment, "openai"), { type: "text", text: prompt }];
  const res = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.GROK_API_KEY}` },
    body: JSON.stringify({ model: "grok-4", max_tokens: 500, messages: [{ role: "user", content }] }),
  });
  if (!res.ok) throw new Error(`Grok ${res.status}: ${await res.text()}`);
  return (await res.json()).choices?.[0]?.message?.content?.trim() || "";
}

/* ── frontend ─────────────────────────────────────────────────────────── */

const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>Agora - Multi-Model Brainstorming</title>
<style>
:root{
  --bg:#f7f7f5;--panel:#fff;--border:#e4e2dd;--text:#2b2b28;--muted:#8a8780;
  --claude:#b5651d;--gpt:#2f7a63;--gemini:#3b5fa4;--grok:#5c5c5c;--human:#7b4fa6;
  --accent:#4a5b8c;--accent-soft:#eef0f7;--danger:#b3504a;--warn:#c79a45;--green:#2f7a63;
}
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:-apple-system,"Segoe UI",Arial,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;}
.layout{display:flex;min-height:100vh;}

/* sidebar */
.sidebar{width:270px;border-right:1px solid var(--border);padding:14px;background:var(--panel);display:flex;flex-direction:column;gap:4px;}
.sidebar-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;}
.sidebar-header h2{font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;}
#newBtn{padding:8px 12px;background:var(--accent);border:none;color:#fff;border-radius:8px;cursor:pointer;font-size:13px;}
.conv-item{padding:9px 10px;border-radius:8px;cursor:pointer;font-size:13px;border:1px solid transparent;position:relative;}
.conv-item:hover{background:var(--accent-soft);}
.conv-item.active{background:var(--accent-soft);border-color:var(--accent);}
.conv-item .ci-topic{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:200px;}
.conv-item .ci-meta{color:var(--muted);font-size:11px;margin-top:2px;}
.conv-item .ci-del{position:absolute;right:8px;top:8px;color:var(--danger);cursor:pointer;display:none;font-size:12px;}
.conv-item:hover .ci-del{display:block;}

/* main */
.main{flex:1;max-width:820px;margin:0 auto;padding:24px 20px 80px;}
.header-row{display:flex;align-items:baseline;gap:8px;margin-bottom:4px;}
h1{font-size:22px;}
.version{font-size:11px;color:var(--muted);border:1px solid var(--border);border-radius:10px;padding:1px 8px;}
.sub{color:var(--muted);font-size:14px;margin-bottom:20px;}

/* card */
.card{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:16px;margin-bottom:14px;}
.card-title{font-size:13px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin-bottom:10px;}
textarea{width:100%;min-height:80px;background:#fff;color:var(--text);border:1px solid var(--border);border-radius:8px;padding:10px;font-size:15px;resize:vertical;}
.row{display:flex;gap:10px;align-items:center;margin-top:10px;flex-wrap:wrap;}
label.lbl{font-size:13px;color:var(--muted);}
input[type=number],input[type=text],select{background:#fff;color:var(--text);border:1px solid var(--border);border-radius:6px;padding:6px 8px;font-size:13px;}

/* chips / model pills */
.chips{display:flex;gap:6px;flex-wrap:wrap;}
.chip{border:1px solid var(--border);border-radius:20px;padding:5px 13px;cursor:pointer;font-size:13px;user-select:none;background:#fff;transition:.15s;}
.chip.claude{color:var(--claude);} .chip.gpt{color:var(--gpt);} .chip.gemini{color:var(--gemini);} .chip.grok{color:var(--grok);}
.chip.active{background:var(--accent-soft);} .chip.inactive{opacity:.35;}

/* order list */
#orderList{display:flex;flex-direction:column;gap:6px;margin-top:8px;}
.order-item{display:flex;align-items:center;gap:8px;background:#fff;border:1px solid var(--border);border-radius:8px;padding:7px 10px;cursor:grab;font-size:13px;}
.order-item .drag-handle{color:var(--muted);font-size:16px;cursor:grab;}
.order-item .order-num{width:18px;font-weight:600;color:var(--muted);font-size:12px;}
.order-item .order-label{}
.order-item .order-role{flex:1;border:none;outline:none;background:transparent;font-size:13px;color:var(--muted);min-width:80px;}
.order-item.dragging{opacity:.4;}

/* buttons */
.btn{border:none;border-radius:8px;padding:8px 16px;font-size:13px;cursor:pointer;}
.btn-primary{background:var(--accent);color:#fff;}
.btn-secondary{background:#fff;color:var(--text);border:1px solid var(--border);}
.btn-warn{background:#fff;color:var(--warn);border:1px solid var(--warn);}
.btn-danger{background:#fff;color:var(--danger);border:1px solid var(--danger);}
.btn-green{background:#fff;color:var(--green);border:1px solid var(--green);}
.btn:disabled{opacity:.45;cursor:not-allowed;}

/* controls bar */
.controls{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;align-items:center;}

/* attach */
.attach-row{display:flex;align-items:center;gap:8px;margin-top:10px;}
.attach-btn{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--border);background:#fff;border-radius:8px;padding:5px 11px;cursor:pointer;font-size:13px;color:var(--muted);}
.attach-preview{font-size:12px;color:var(--muted);}
.remove-att{color:var(--danger);cursor:pointer;margin-left:4px;}

/* messages */
.msg{border-radius:10px;padding:12px 14px;margin-bottom:8px;border:1px solid var(--border);border-left-width:4px;background:var(--panel);animation:fadeIn .2s ease;}
.msg.claude{border-left-color:var(--claude);} .msg.gpt{border-left-color:var(--gpt);} .msg.gemini{border-left-color:var(--gemini);} .msg.grok{border-left-color:var(--grok);} .msg.human{border-left-color:var(--human);}
.msg-who{font-weight:600;font-size:12px;margin-bottom:3px;display:flex;align-items:center;gap:6px;}
.msg.claude .msg-who{color:var(--claude);} .msg.gpt .msg-who{color:var(--gpt);} .msg.gemini .msg-who{color:var(--gemini);} .msg.grok .msg-who{color:var(--grok);} .msg.human .msg-who{color:var(--human);}
.msg-ts{font-size:11px;color:var(--muted);font-weight:400;}
.msg-body{white-space:pre-wrap;font-size:15px;line-height:1.55;}
.round-divider{text-align:center;font-size:11px;color:var(--muted);margin:10px 0;display:flex;align-items:center;gap:8px;}
.round-divider::before,.round-divider::after{content:'';flex:1;height:1px;background:var(--border);}
.thinking,.status-msg{color:var(--muted);font-size:13px;font-style:italic;margin-bottom:8px;}

/* intervene */
.intervene-row{display:flex;gap:8px;margin-bottom:10px;}
.intervene-row input{flex:1;border:1px solid var(--border);border-radius:8px;padding:8px 10px;font-size:14px;background:#fff;}

/* insights */
.insights-list{list-style:none;padding:0;}
.insights-list li{padding:8px 0;border-bottom:1px solid var(--border);font-size:14px;display:flex;gap:8px;align-items:flex-start;}
.insights-list li:last-child{border-bottom:none;}
.insight-num{color:var(--muted);font-size:12px;min-width:18px;padding-top:1px;}
.insight-text{flex:1;outline:none;}

/* rating */
.rating-row{display:flex;gap:8px;flex-wrap:wrap;margin-top:6px;}
.rating-chip{border:1px solid var(--border);border-radius:20px;padding:4px 12px;cursor:pointer;font-size:12px;background:#fff;}
.rating-chip.selected{background:var(--accent-soft);border-color:var(--accent);font-weight:600;}

/* export buttons */
.export-row{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;}

/* share */
.share-box{background:var(--accent-soft);border:1px solid var(--accent);border-radius:8px;padding:10px 12px;font-size:13px;margin-top:8px;display:flex;gap:8px;align-items:center;}
.share-box input{flex:1;border:1px solid var(--border);border-radius:6px;padding:5px 8px;font-size:12px;background:#fff;}

@keyframes fadeIn{from{opacity:0;transform:translateY(3px);}to{opacity:1;transform:translateY(0);}}
</style>
</head>
<body>
<div class="layout">

<!-- SIDEBAR -->
<div class="sidebar">
  <div class="sidebar-header">
    <h2>Discussions</h2>
    <button id="newBtn">+ New</button>
  </div>
  <div id="convList"></div>
</div>

<!-- MAIN -->
<div class="main">
  <div class="header-row">
    <h1>Agora</h1>
    <span class="version">v${APP_VERSION}</span>
  </div>
  <div class="sub">Multi-model AI brainstorming roundtable</div>

  <!-- SETUP CARD -->
  <div id="setupCard">
    <div class="card">
      <div class="card-title">Topic</div>
      <textarea id="topic" placeholder="Enter the topic or question for discussion..."></textarea>
      <div class="row">
        <label class="lbl">Domain / context (optional):</label>
        <input type="text" id="domain" placeholder="e.g. B2B SaaS, healthcare, strategy..." style="flex:1"/>
      </div>
      <div class="attach-row">
        <label class="attach-btn" for="fileInput">📎 Attach file or image</label>
        <input type="file" id="fileInput" accept="image/*,.pdf,.txt,.md" style="display:none"/>
        <span class="attach-preview" id="attachPreview"></span>
      </div>
    </div>

    <div class="card">
      <div class="card-title">Participants &amp; Order</div>
      <div class="chips" id="modelChips">
        <span class="chip claude active" data-model="claude">Claude</span>
        <span class="chip gpt active" data-model="gpt">GPT</span>
        <span class="chip gemini active" data-model="gemini">Gemini</span>
        <span class="chip grok active" data-model="grok">Grok</span>
      </div>
      <div id="orderList"></div>
    </div>

    <div class="card">
      <div class="card-title">Session settings</div>
      <div class="row">
        <label class="lbl">Rounds:</label>
        <input type="number" id="rounds" value="3" min="1" max="20" style="width:60px"/>
        <label class="lbl" style="margin-left:12px">Admin token (optional):</label>
        <input type="text" id="adminToken" placeholder="secret phrase" style="width:140px"/>
      </div>
    </div>

    <button class="btn btn-primary" id="startBtn" style="margin-top:4px">Start discussion</button>
  </div>

  <!-- LIVE CONTROLS -->
  <div class="controls" id="liveControls" style="display:none">
    <button class="btn btn-warn"    id="pauseBtn">Pause</button>
    <button class="btn btn-primary" id="resumeBtn" style="display:none">Resume</button>
    <button class="btn btn-danger"  id="stopBtn">Stop</button>
  </div>

  <!-- TRANSCRIPT -->
  <div id="transcript"></div>

  <!-- INTERVENE -->
  <div id="interveneArea" style="display:none">
    <div class="intervene-row">
      <input type="text" id="interveneText" placeholder="Add your own message to the discussion..."/>
      <button class="btn btn-primary" id="interveneBtn">Send</button>
    </div>
  </div>

  <!-- POST-SESSION PANEL -->
  <div id="postPanel" style="display:none">

    <div class="card">
      <div class="card-title">Continue discussion</div>
      <div class="row">
        <label class="lbl">More rounds:</label>
        <input type="number" id="moreRounds" value="3" min="1" max="20" style="width:60px"/>
        <button class="btn btn-secondary" id="continueBtn">Continue</button>
      </div>
    </div>

    <div class="card">
      <div class="card-title">Participants (live edit)</div>
      <div class="chips" id="liveModelChips">
        <span class="chip claude active" data-model="claude">Claude</span>
        <span class="chip gpt active" data-model="gpt">GPT</span>
        <span class="chip gemini active" data-model="gemini">Gemini</span>
        <span class="chip grok active" data-model="grok">Grok</span>
      </div>
      <div id="liveOrderList" style="margin-top:8px"></div>
      <button class="btn btn-secondary" id="saveParticipantsBtn" style="margin-top:10px">Save changes</button>
    </div>

    <div class="card">
      <div class="card-title">Key insights</div>
      <button class="btn btn-secondary" id="genInsightsBtn">Generate insights</button>
      <ul class="insights-list" id="insightsList" style="margin-top:10px"></ul>
      <div class="row" style="margin-top:8px">
        <button class="btn btn-secondary" id="saveInsightsBtn" style="display:none">Save edits</button>
      </div>
    </div>

    <div class="card">
      <div class="card-title">Rate this session</div>
      <p style="font-size:13px;color:var(--muted);margin-bottom:6px">Who contributed most?</p>
      <div class="rating-row" id="ratingRow"></div>
    </div>

    <div class="card">
      <div class="card-title">Export</div>
      <div class="row">
        <label class="lbl">Export:</label>
        <select id="exportScope">
          <option value="full">Full discussion</option>
          <option value="insights">Key insights only</option>
        </select>
        <label class="lbl" style="margin-left:12px">Format:</label>
      </div>
      <div class="export-row">
        <button class="btn btn-secondary" id="exportDocx">📄 Word (.docx)</button>
        <button class="btn btn-secondary" id="exportPptx">📊 PowerPoint (.pptx)</button>
        <button class="btn btn-secondary" id="exportXlsx">📋 Excel (.xlsx)</button>
        <button class="btn btn-secondary" id="exportTxt">📝 Text (.txt)</button>
      </div>
    </div>

    <div class="card">
      <div class="card-title">Share this session</div>
      <p style="font-size:13px;color:var(--muted);margin-bottom:6px">Anyone with the link can view and participate in this session.</p>
      <div class="share-box">
        <input type="text" id="shareUrl" readonly/>
        <button class="btn btn-secondary" id="copyLinkBtn">Copy</button>
      </div>
    </div>

  </div><!-- /postPanel -->
</div><!-- /main -->
</div><!-- /layout -->

<script>
/* ─── state ─────────────────────────────────────────────────────────── */
let currentId   = null;
let currentConv = null;
let currentAttachment = null;
const BASE = '';

/* ─── init ───────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  loadConvList();
  initChips('modelChips', buildOrderList);
  initChips('liveModelChips', buildLiveOrderList);
  buildOrderList();
  buildLiveOrderList();

  document.getElementById('newBtn').addEventListener('click', resetToSetup);
  document.getElementById('startBtn').addEventListener('click', startNew);
  document.getElementById('pauseBtn').addEventListener('click', () => sendControl('pause'));
  document.getElementById('resumeBtn').addEventListener('click', () => sendControl('resume'));
  document.getElementById('stopBtn').addEventListener('click', () => sendControl('stop'));
  document.getElementById('interveneBtn').addEventListener('click', sendIntervention);
  document.getElementById('continueBtn').addEventListener('click', doContinue);
  document.getElementById('saveParticipantsBtn').addEventListener('click', saveParticipants);
  document.getElementById('genInsightsBtn').addEventListener('click', doGenInsights);
  document.getElementById('saveInsightsBtn').addEventListener('click', saveInsights);
  document.getElementById('copyLinkBtn').addEventListener('click', copyShareLink);
  document.getElementById('fileInput').addEventListener('change', handleFile);
  document.getElementById('exportDocx').addEventListener('click', () => exportSession('docx'));
  document.getElementById('exportPptx').addEventListener('click', () => exportSession('pptx'));
  document.getElementById('exportXlsx').addEventListener('click', () => exportSession('xlsx'));
  document.getElementById('exportTxt').addEventListener('click',  () => exportSession('txt'));

  // check if URL has ?session=id (shared link)
  const sp = new URLSearchParams(location.search);
  if (sp.has('session')) openConversation(sp.get('session'));
});

/* ─── chips & order ──────────────────────────────────────────────────── */
function initChips(containerId, onChange) {
  document.querySelectorAll('#'+containerId+' .chip').forEach(chip => {
    chip.addEventListener('click', () => {
      chip.classList.toggle('active');
      chip.classList.toggle('inactive');
      onChange();
    });
  });
}

function getActiveModels(containerId) {
  return Array.from(document.querySelectorAll('#'+containerId+' .chip.active')).map(c => c.dataset.model);
}

function buildOrderList() { _buildOrder('modelChips', 'orderList'); }
function buildLiveOrderList() { _buildOrder('liveModelChips', 'liveOrderList'); }

function _buildOrder(chipsId, listId) {
  const models  = getActiveModels(chipsId);
  const listEl  = document.getElementById(listId);
  const existing = Array.from(listEl.querySelectorAll('.order-item')).map(el => el.dataset.model);
  // keep existing order, add new, remove deselected
  const ordered = [...existing.filter(m => models.includes(m)), ...models.filter(m => !existing.includes(m))];
  listEl.innerHTML = '';
  ordered.forEach((m, i) => {
    const div = document.createElement('div');
    div.className = 'order-item'; div.dataset.model = m;
    div.draggable = true;
    div.innerHTML = '<span class="drag-handle">⠿</span><span class="order-num">'+(i+1)+'</span>'
      +'<span class="order-label" style="color:var(--'+m+');font-weight:600">'+cap(m)+'</span>'
      +'<input class="order-role" placeholder="Role (optional)..." />';
    listEl.appendChild(div);
  });
  initDrag(listId);
  renumber(listId);
}

function initDrag(listId) {
  const list = document.getElementById(listId);
  let dragged = null;
  list.querySelectorAll('.order-item').forEach(item => {
    item.addEventListener('dragstart', e => { dragged = item; item.classList.add('dragging'); });
    item.addEventListener('dragend',   e => { item.classList.remove('dragging'); renumber(listId); });
    item.addEventListener('dragover',  e => { e.preventDefault(); const r = item.getBoundingClientRect(); if (e.clientY < r.top+r.height/2) list.insertBefore(dragged,item); else list.insertBefore(dragged,item.nextSibling); });
  });
}

function renumber(listId) {
  document.querySelectorAll('#'+listId+' .order-item').forEach((el,i) => {
    el.querySelector('.order-num').textContent = i+1;
  });
}

function getOrderedParticipants(listId) {
  return Array.from(document.querySelectorAll('#'+listId+' .order-item')).map(el => el.dataset.model);
}
function getRoles(listId) {
  const roles = {};
  document.querySelectorAll('#'+listId+' .order-item').forEach(el => {
    const v = el.querySelector('.order-role').value.trim();
    if (v) roles[el.dataset.model] = v;
  });
  return roles;
}

/* ─── attachment ─────────────────────────────────────────────────────── */
async function handleFile(e) {
  const file = e.target.files[0]; if (!file) return;
  if (file.size > 8*1024*1024) { alert('File too large (max 8MB)'); e.target.value=''; return; }
  const isImage = file.type.startsWith('image/'), isPdf = file.type === 'application/pdf';
  if (isImage || isPdf) {
    const b64 = await fileToBase64(file);
    currentAttachment = { filename:file.name, mediaType:file.type, kind:isImage?'image':'pdf', data:b64 };
  } else {
    const text = await file.text();
    currentAttachment = { filename:file.name, mediaType:'text/plain', kind:'text', data:text.slice(0,20000) };
  }
  document.getElementById('attachPreview').innerHTML = file.name+' <span class="remove-att" id="removeAtt">✕</span>';
  document.getElementById('removeAtt').addEventListener('click', ()=>{ currentAttachment=null; document.getElementById('attachPreview').innerHTML=''; e.target.value=''; });
}
function fileToBase64(file){ return new Promise((res,rej)=>{ const r=new FileReader(); r.onload=()=>res(r.result.split(',')[1]); r.onerror=rej; r.readAsDataURL(file); }); }

/* ─── sidebar ────────────────────────────────────────────────────────── */
async function loadConvList() {
  const list = await (await fetch(BASE+'/api/conversations')).json();
  const el   = document.getElementById('convList');
  el.innerHTML = '';
  list.forEach(c => {
    const div = document.createElement('div');
    div.className = 'conv-item'; div.dataset.id = c.id;
    div.innerHTML = '<div class="ci-topic">'+esc(c.topic.slice(0,38))+'</div>'
      +'<div class="ci-meta">'+new Date(c.createdAt).toLocaleDateString()+'</div>'
      +'<span class="ci-del" title="Delete">✕</span>';
    div.querySelector('.ci-del').addEventListener('click', e => { e.stopPropagation(); delConv(c.id); });
    div.addEventListener('click', () => openConversation(c.id));
    el.appendChild(div);
  });
}
function hlConv(id){ document.querySelectorAll('.conv-item').forEach(el=>el.classList.toggle('active',el.dataset.id===id)); }
async function delConv(id){ if(!confirm('Delete this discussion?')) return; await fetch(BASE+'/api/conversations/'+id,{method:'DELETE'}); if(currentId===id) resetToSetup(); else loadConvList(); }

/* ─── setup / reset ──────────────────────────────────────────────────── */
function resetToSetup(){
  currentId=null; currentConv=null; currentAttachment=null;
  show('setupCard'); hide('liveControls'); hide('interveneArea'); hide('postPanel');
  document.getElementById('transcript').innerHTML='';
  document.getElementById('topic').value='';
  document.getElementById('domain').value='';
  document.getElementById('attachPreview').innerHTML='';
  document.getElementById('fileInput').value='';
  hlConv(null);
}

/* ─── open existing ──────────────────────────────────────────────────── */
async function openConversation(id){
  const res = await fetch(BASE+'/api/conversations/'+id);
  if(!res.ok) return;
  currentConv = await res.json(); currentId = id;
  hlConv(id);
  hide('setupCard'); hide('liveControls');
  show('interveneArea'); show('postPanel');

  // render transcript
  const te = document.getElementById('transcript');
  te.innerHTML = '';
  let lastRound = 0;
  currentConv.transcript.forEach(t => {
    if(t.model==='user') return;
    if(t.round > lastRound){ addRoundDivider(t.round, t.ts); lastRound=t.round; }
    appendMessage(t.model, t.speaker, t.round, t.text, t.ts);
  });

  // sync live chips to saved participants
  syncLiveChips(currentConv.participants);
  buildLiveOrderList();
  restoreRoles(currentConv.roles || {});

  // insights
  renderInsights(currentConv.insights || []);

  // rating
  buildRating(currentConv.participants, currentConv.rating || {});

  // share link
  document.getElementById('shareUrl').value = location.origin + '/?session='+id;
}

function syncLiveChips(participants){
  document.querySelectorAll('#liveModelChips .chip').forEach(c=>{
    const on = participants.includes(c.dataset.model);
    c.classList.toggle('active', on);
    c.classList.toggle('inactive', !on);
  });
}
function restoreRoles(roles){
  document.querySelectorAll('#liveOrderList .order-item').forEach(el=>{
    if(roles[el.dataset.model]) el.querySelector('.order-role').value = roles[el.dataset.model];
  });
}

/* ─── start new ──────────────────────────────────────────────────────── */
async function startNew(){
  const topic = document.getElementById('topic').value.trim();
  if(!topic){ alert('Please enter a topic'); return; }
  const participants = getOrderedParticipants('orderList');
  if(participants.length < 2){ alert('Select at least 2 models'); return; }
  const rounds     = parseInt(document.getElementById('rounds').value)||3;
  const domain     = document.getElementById('domain').value.trim();
  const adminToken = document.getElementById('adminToken').value.trim() || null;
  const roles      = getRoles('orderList');

  hide('setupCard');
  show('liveControls');
  document.getElementById('transcript').innerHTML='';

  const res = await fetch(BASE+'/api/conversations', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ topic, rounds, participants, domain, roles, adminToken, attachment:currentAttachment })
  });
  await streamResponse(res);
  await loadConvList();
  if(currentId) openConversation(currentId);
}

/* ─── controls ───────────────────────────────────────────────────────── */
async function sendControl(action){
  if(!currentId) return;
  await fetch(BASE+'/api/conversations/'+currentId+'/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action})});
  document.getElementById('pauseBtn').style.display  = action==='pause' ? 'none' : '';
  document.getElementById('resumeBtn').style.display = action==='pause' ? ''     : 'none';
}

/* ─── intervene ──────────────────────────────────────────────────────── */
async function sendIntervention(){
  const text = document.getElementById('interveneText').value.trim();
  if(!text||!currentId) return;
  const res = await fetch(BASE+'/api/conversations/'+currentId+'/intervene',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text})});
  const {entry} = await res.json();
  appendMessage('human','Human (you)', entry.round, entry.text, entry.ts);
  document.getElementById('interveneText').value='';
}

/* ─── continue ───────────────────────────────────────────────────────── */
async function doContinue(){
  if(!currentId) return;
  const rounds = parseInt(document.getElementById('moreRounds').value)||3;
  show('liveControls'); hide('postPanel'); hide('interveneArea');
  document.getElementById('pauseBtn').style.display=''; document.getElementById('resumeBtn').style.display='none';
  const res = await fetch(BASE+'/api/conversations/'+currentId+'/continue',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({rounds})});
  await streamResponse(res);
  if(currentId) openConversation(currentId);
}

/* ─── live edit participants ─────────────────────────────────────────── */
async function saveParticipants(){
  if(!currentId) return;
  const participants = getOrderedParticipants('liveOrderList');
  const roles        = getRoles('liveOrderList');
  await fetch(BASE+'/api/conversations/'+currentId,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({participants,roles})});
  alert('Saved. Changes apply to the next continue.');
}

/* ─── insights ───────────────────────────────────────────────────────── */
async function doGenInsights(){
  if(!currentId) return;
  document.getElementById('genInsightsBtn').textContent='Generating...';
  const res = await fetch(BASE+'/api/conversations/'+currentId+'/insights',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  const {insights} = await res.json();
  renderInsights(insights);
  document.getElementById('genInsightsBtn').textContent='Regenerate';
}
function renderInsights(insights){
  const ul = document.getElementById('insightsList');
  ul.innerHTML = '';
  if(!insights||!insights.length) return;
  insights.forEach((ins,i) => {
    const li = document.createElement('li');
    li.innerHTML = '<span class="insight-num">'+(i+1)+'.</span><span class="insight-text" contenteditable="true">'+esc(ins)+'</span>';
    ul.appendChild(li);
  });
  document.getElementById('saveInsightsBtn').style.display='';
}
async function saveInsights(){
  if(!currentId) return;
  const insights = Array.from(document.querySelectorAll('.insight-text')).map(el=>el.textContent.trim());
  await fetch(BASE+'/api/conversations/'+currentId,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({insights})});
  alert('Insights saved.');
}

/* ─── rating ─────────────────────────────────────────────────────────── */
function buildRating(participants, existing){
  const row = document.getElementById('ratingRow');
  row.innerHTML = '';
  participants.forEach(m => {
    const chip = document.createElement('div');
    chip.className = 'rating-chip' + (existing[m] ? ' selected' : '');
    chip.dataset.model = m; chip.textContent = cap(m);
    chip.addEventListener('click', async ()=>{
      row.querySelectorAll('.rating-chip').forEach(c=>c.classList.remove('selected'));
      chip.classList.add('selected');
      const rating = {}; rating[m] = true;
      await fetch(BASE+'/api/conversations/'+currentId,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({rating})});
    });
    row.appendChild(chip);
  });
}

/* ─── export ─────────────────────────────────────────────────────────── */
function exportSession(fmt){
  if(!currentConv) return;
  const scope    = document.getElementById('exportScope').value;
  const insights = Array.from(document.querySelectorAll('.insight-text')).map(el=>el.textContent.trim());
  const lines    = [];

  if(fmt==='txt'){
    lines.push('Agora - '+currentConv.topic);
    lines.push('Date: '+new Date(currentConv.createdAt).toLocaleString());
    lines.push('');
    if(scope==='insights'){
      lines.push('KEY INSIGHTS');
      insights.forEach((ins,i)=>lines.push((i+1)+'. '+ins));
    } else {
      currentConv.transcript.forEach(t=>{
        if(t.model==='user') return;
        lines.push('['+t.speaker+' - Round '+t.round+']');
        lines.push(t.text); lines.push('');
      });
      if(insights.length){ lines.push('KEY INSIGHTS'); insights.forEach((ins,i)=>lines.push((i+1)+'. '+ins)); }
    }
    downloadText(lines.join('\\n'), 'agora-session.txt', 'text/plain');
    return;
  }

  if(fmt==='docx'||fmt==='pptx'||fmt==='xlsx'){
    // Build a simple HTML representation and instruct user to copy-paste,
    // or generate a proper file via a small helper
    if(fmt==='docx') exportDocx(scope, insights);
    if(fmt==='pptx') exportPptx(scope, insights);
    if(fmt==='xlsx') exportXlsx(scope, insights);
  }
}

function exportDocx(scope, insights){
  const conv = currentConv;
  let html = '<html><head><meta charset="UTF-8"></head><body>';
  html += '<h1>'+esc(conv.topic)+'</h1>';
  html += '<p>Date: '+new Date(conv.createdAt).toLocaleString()+'</p>';
  if(scope==='full'){
    let lastRound=0;
    conv.transcript.forEach(t=>{
      if(t.model==='user') return;
      if(t.round>lastRound){ html+='<h2>Round '+t.round+'</h2>'; lastRound=t.round; }
      html+='<h3>'+esc(t.speaker)+'</h3><p>'+esc(t.text)+'</p>';
    });
  }
  if(insights.length){ html+='<h2>Key Insights</h2><ol>'; insights.forEach(i=>html+='<li>'+esc(i)+'</li>'); html+='</ol>'; }
  html+='</body></html>';
  downloadText(html,'agora-session.doc','application/msword');
}

function exportPptx(scope, insights){
  // Generate an HTML file styled as slides for easy import
  const conv = currentConv;
  let html = '<html><head><meta charset="UTF-8"><style>body{font-family:Arial;} .slide{page-break-after:always;padding:40px;min-height:400px;border:1px solid #ccc;margin:20px;} h1{font-size:28px;} h2{font-size:22px;color:#4a5b8c;} p{font-size:16px;} li{font-size:15px;margin:8px 0;}</style></head><body>';
  html += '<div class="slide"><h1>'+esc(conv.topic)+'</h1><p>Agora Brainstorming Session</p><p>'+new Date(conv.createdAt).toLocaleString()+'</p></div>';
  if(scope==='full'){
    let lastRound=0;
    conv.transcript.forEach(t=>{
      if(t.model==='user') return;
      if(t.round>lastRound){ html+='<div class="slide"><h2>Round '+t.round+'</h2>'; lastRound=t.round; }
      html+='<p><b>'+esc(t.speaker)+':</b> '+esc(t.text)+'</p>';
    });
    html+='</div>';
  }
  if(insights.length){ html+='<div class="slide"><h2>Key Insights</h2><ol>'; insights.forEach(i=>html+='<li>'+esc(i)+'</li>'); html+='</ol></div>'; }
  html+='</body></html>';
  downloadText(html,'agora-session-slides.html','text/html');
}

function exportXlsx(scope, insights){
  const rows = [['Speaker','Round','Text','Timestamp']];
  if(scope==='full'){
    currentConv.transcript.forEach(t=>{ if(t.model!=='user') rows.push([t.speaker,t.round,t.text,t.ts||'']); });
  }
  if(insights.length){ rows.push([]); rows.push(['#','Insight','','']); insights.forEach((ins,i)=>rows.push([i+1,ins,'',''])); }
  let csv = rows.map(r=>r.map(c=>'"'+String(c||'').replace(/"/g,'""')+'"').join(',')).join('\\n');
  downloadText(csv,'agora-session.csv','text/csv');
}

function downloadText(content, filename, type){
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content],{type}));
  a.download = filename; a.click();
}

/* ─── share ──────────────────────────────────────────────────────────── */
function copyShareLink(){
  const inp = document.getElementById('shareUrl');
  inp.select(); document.execCommand('copy');
  document.getElementById('copyLinkBtn').textContent='Copied!';
  setTimeout(()=>document.getElementById('copyLinkBtn').textContent='Copy',2000);
}

/* ─── streaming ──────────────────────────────────────────────────────── */
async function streamResponse(res){
  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer='', thinkingEl=null;

  while(true){
    const {value,done} = await reader.read(); if(done) break;
    buffer += decoder.decode(value,{stream:true});
    const parts = buffer.split('\\n\\n'); buffer=parts.pop();
    for(const part of parts){
      if(!part.startsWith('data: ')) continue;
      const d = JSON.parse(part.slice(6));
      if(d.type==='start'){ currentId=d.id; }
      if(d.type==='round_start'){ addRoundDivider(d.round, d.ts); }
      if(d.type==='thinking'){
        if(thinkingEl) thinkingEl.remove();
        thinkingEl = mkEl('div','thinking',d.label+' is thinking... (round '+d.round+')');
        document.getElementById('transcript').appendChild(thinkingEl);
      }
      if(d.type==='paused'){
        if(thinkingEl) thinkingEl.remove();
        thinkingEl = mkEl('div','status-msg','Discussion paused...');
        document.getElementById('transcript').appendChild(thinkingEl);
      }
      if(d.type==='message'){
        if(thinkingEl){thinkingEl.remove();thinkingEl=null;}
        appendMessage(d.model, d.speaker, d.round, d.text, d.ts);
      }
      if(d.type==='stopped'||d.type==='done'){
        hide('liveControls'); show('interveneArea'); show('postPanel');
        document.getElementById('shareUrl').value = location.origin+'/?session='+currentId;
        if(currentId){ const c=await(await fetch(BASE+'/api/conversations/'+currentId)).json(); currentConv=c; buildRating(c.participants,c.rating||{}); }
      }
      if(d.type==='error'){
        if(thinkingEl) thinkingEl.remove();
        document.getElementById('transcript').appendChild(mkEl('div','thinking','Error: '+d.message));
      }
    }
  }
}

/* ─── DOM helpers ────────────────────────────────────────────────────── */
function appendMessage(model, label, round, text, ts){
  const div = document.createElement('div');
  div.className = 'msg '+(model||'human');
  const time = ts ? new Date(ts).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}) : '';
  div.innerHTML = '<div class="msg-who">'+esc(label)+' <span class="msg-ts">'+time+'</span></div>'
    +'<div class="msg-body"></div>';
  div.querySelector('.msg-body').textContent = text;
  document.getElementById('transcript').appendChild(div);
  window.scrollTo(0, document.body.scrollHeight);
}
function addRoundDivider(round, ts){
  const date = ts ? new Date(ts).toLocaleDateString([],{weekday:'short',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '';
  document.getElementById('transcript').appendChild(mkEl('div','round-divider','Round '+round+(date?' — '+date:'')));
}
function mkEl(tag,cls,text){ const el=document.createElement(tag); el.className=cls; el.textContent=text; return el; }
function show(id){ document.getElementById(id).style.display=''; }
function hide(id){ document.getElementById(id).style.display='none'; }
function esc(s){ const d=document.createElement('div'); d.textContent=s; return d.innerHTML; }
function cap(s){ return s.charAt(0).toUpperCase()+s.slice(1); }
</script>
</body>
</html>`;
