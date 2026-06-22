/**
 * Roundtable Worker v3
 * Multi-model roundtable brainstorming: Claude, GPT, Gemini.
 * Features: KV-persisted conversation history, pause/resume/stop,
 * delay between speakers, file/image attachments visible to all models.
 *
 * Secrets:
 *   ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY
 * KV Binding (wrangler.toml):
 *   ROUNDTABLE_KV
 */

const APP_VERSION = "3.1.0";

const MODEL_CONFIG = {
  claude: { label: "Claude", call: callClaude },
  gpt: { label: "GPT", call: callOpenAI },
  gemini: { label: "Gemini", call: callGemini },
  grok: { label: "Grok", call: callGrok },
};

const SPEAKER_DELAY_MS = 2500;
const POLL_PAUSE_MS = 1500;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    if (path === "/" || path === "/index.html") {
      return new Response(INDEX_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (path === "/api/conversations" && request.method === "GET") {
      return listConversations(env);
    }

    if (path === "/api/conversations" && request.method === "POST") {
      return createConversation(request, env);
    }

    const convMatch = path.match(/^\/api\/conversations\/([a-zA-Z0-9_-]+)$/);
    if (convMatch && request.method === "GET") {
      return getConversation(convMatch[1], env);
    }
    if (convMatch && request.method === "DELETE") {
      return deleteConversation(convMatch[1], env);
    }

    const continueMatch = path.match(/^\/api\/conversations\/([a-zA-Z0-9_-]+)\/continue$/);
    if (continueMatch && request.method === "POST") {
      return continueConversation(continueMatch[1], request, env);
    }

    const controlMatch = path.match(/^\/api\/conversations\/([a-zA-Z0-9_-]+)\/control$/);
    if (controlMatch && request.method === "POST") {
      return controlConversation(controlMatch[1], request, env);
    }

    return new Response("Not found", { status: 404, headers: corsHeaders() });
  },
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}

function convKey(id) { return `conv:${id}`; }
function controlKey(id) { return `control:${id}`; }
function indexKey() { return `index`; }

async function loadConversation(id, env) {
  const raw = await env.ROUNDTABLE_KV.get(convKey(id));
  return raw ? JSON.parse(raw) : null;
}

async function saveConversation(conv, env) {
  await env.ROUNDTABLE_KV.put(convKey(conv.id), JSON.stringify(conv));
}

async function addToIndex(id, topic, env) {
  const raw = await env.ROUNDTABLE_KV.get(indexKey());
  const index = raw ? JSON.parse(raw) : [];
  index.unshift({ id, topic, createdAt: Date.now() });
  await env.ROUNDTABLE_KV.put(indexKey(), JSON.stringify(index));
}

async function removeFromIndex(id, env) {
  const raw = await env.ROUNDTABLE_KV.get(indexKey());
  const index = raw ? JSON.parse(raw) : [];
  const filtered = index.filter((e) => e.id !== id);
  await env.ROUNDTABLE_KV.put(indexKey(), JSON.stringify(filtered));
}

async function getControl(id, env) {
  const v = await env.ROUNDTABLE_KV.get(controlKey(id));
  return v || "running";
}

async function setControl(id, action, env) {
  await env.ROUNDTABLE_KV.put(controlKey(id), action);
}

async function listConversations(env) {
  const raw = await env.ROUNDTABLE_KV.get(indexKey());
  const index = raw ? JSON.parse(raw) : [];
  return jsonResponse(index);
}

async function getConversation(id, env) {
  const conv = await loadConversation(id, env);
  if (!conv) return jsonResponse({ error: "not found" }, 404);
  return jsonResponse(conv);
}

async function deleteConversation(id, env) {
  await env.ROUNDTABLE_KV.delete(convKey(id));
  await env.ROUNDTABLE_KV.delete(controlKey(id));
  await removeFromIndex(id, env);
  return jsonResponse({ ok: true });
}

async function controlConversation(id, request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: "invalid json" }, 400);
  }
  const action = body.action;
  if (!["pause", "resume", "stop"].includes(action)) {
    return jsonResponse({ error: "invalid action" }, 400);
  }
  await setControl(id, action, env);
  return jsonResponse({ ok: true, action });
}

async function createConversation(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: "invalid json" }, 400);
  }
  const topic = (body.topic || "").trim();
  const rounds = Math.min(Math.max(parseInt(body.rounds) || 3, 1), 10);
  const participants = (body.participants || ["claude", "gpt", "gemini"]).filter((p) => MODEL_CONFIG[p]);
  const attachment = body.attachment || null; // { filename, mediaType, kind: 'image'|'text', data (base64 or plain text) }

  if (!topic) return jsonResponse({ error: "missing topic" }, 400);
  if (participants.length < 2) return jsonResponse({ error: "need at least 2 participants" }, 400);

  const id = crypto.randomUUID();
  const conv = {
    id,
    topic,
    participants,
    attachment,
    transcript: [{ speaker: "Moderator (you)", model: "user", text: topic, round: 0 }],
    roundsCompleted: 0,
    createdAt: Date.now(),
  };
  await saveConversation(conv, env);
  await addToIndex(id, topic, env);
  await setControl(id, "running", env);

  return runRounds(conv, rounds, env);
}

async function continueConversation(id, request, env) {
  const conv = await loadConversation(id, env);
  if (!conv) return jsonResponse({ error: "not found" }, 404);

  let body = {};
  try {
    body = await request.json();
  } catch (e) {}
  const rounds = Math.min(Math.max(parseInt(body.rounds) || 3, 1), 10);

  await setControl(id, "running", env);
  return runRounds(conv, rounds, env);
}

function runRounds(conv, roundsToRun, env) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const sendEvent = async (data) => {
    await writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
  };

  (async () => {
    try {
      await sendEvent({ type: "start", id: conv.id, topic: conv.topic, participants: conv.participants });

      const startRound = conv.roundsCompleted + 1;
      const endRound = conv.roundsCompleted + roundsToRun;

      for (let round = startRound; round <= endRound; round++) {
        for (const key of conv.participants) {
          let status = await getControl(conv.id, env);
          while (status === "pause") {
            await sendEvent({ type: "paused" });
            await sleep(POLL_PAUSE_MS);
            status = await getControl(conv.id, env);
          }
          if (status === "stop") {
            await sendEvent({ type: "stopped" });
            await saveConversation(conv, env);
            await writer.close();
            return;
          }

          const model = MODEL_CONFIG[key];
          await sendEvent({ type: "thinking", model: key, label: model.label, round });

          if (conv.transcript.length > 1) {
            await sleep(SPEAKER_DELAY_MS);
          }

          const promptText = buildPrompt(conv.topic, conv.transcript, model.label, conv.participants);
          // Attachment only needs to be sent on the very first message of the whole conversation
          const includeAttachment = conv.attachment && conv.transcript.length === 1;

          let replyText;
          try {
            replyText = await model.call(promptText, env, includeAttachment ? conv.attachment : null);
          } catch (err) {
            replyText = `[Error calling ${model.label}: ${err.message}]`;
          }

          const entry = { speaker: model.label, model: key, text: replyText, round };
          conv.transcript.push(entry);
          await saveConversation(conv, env);

          await sendEvent({ type: "message", ...entry });
        }
        conv.roundsCompleted = round;
        await saveConversation(conv, env);
      }

      await sendEvent({ type: "done" });
    } catch (err) {
      await sendEvent({ type: "error", message: err.message });
    } finally {
      try {
        await writer.close();
      } catch (e) {}
    }
  })();

  return new Response(readable, {
    headers: {
      ...corsHeaders(),
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildPrompt(topic, transcript, selfLabel, participants) {
  const otherLabels = participants
    .map((p) => MODEL_CONFIG[p].label)
    .filter((l) => l !== selfLabel)
    .join(" and ");

  const history = transcript.map((t) => `${t.speaker}: ${t.text}`).join("\n\n");

  return `You are participating in a free-form brainstorming "roundtable" discussion between several AI models: ${participants
    .map((p) => MODEL_CONFIG[p].label)
    .join(", ")}.

The topic raised by the user:
"${topic}"

Discussion so far:
${history}

It's your turn now, ${selfLabel}. Respond directly to what was just said in the discussion (by ${otherLabels} and others) - agree, disagree, add a new angle, push back, or suggest a different direction. Write like a real participant in a live discussion, not like a summary. Keep it concise - up to about 120 words, no unnecessary preamble.`;
}

/* ---------- Anthropic ---------- */
async function callClaude(prompt, env, attachment) {
  const content = [];
  if (attachment) {
    if (attachment.kind === "image") {
      content.push({
        type: "image",
        source: { type: "base64", media_type: attachment.mediaType, data: attachment.data },
      });
    } else if (attachment.kind === "pdf") {
      content.push({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: attachment.data },
      });
    } else if (attachment.kind === "text") {
      content.push({ type: "text", text: `[Attached file: ${attachment.filename}]\n${attachment.data}` });
    }
  }
  content.push({ type: "text", text: prompt });

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 500,
      messages: [{ role: "user", content }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.content || []).map((c) => c.text || "").join("").trim();
}

/* ---------- OpenAI ---------- */
async function callOpenAI(prompt, env, attachment) {
  const content = [];
  if (attachment) {
    if (attachment.kind === "image") {
      content.push({
        type: "image_url",
        image_url: { url: `data:${attachment.mediaType};base64,${attachment.data}` },
      });
    } else if (attachment.kind === "text" || attachment.kind === "pdf") {
      content.push({ type: "text", text: `[Attached file: ${attachment.filename}]\n${attachment.data}` });
    }
  }
  content.push({ type: "text", text: prompt });

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4.1",
      max_tokens: 500,
      messages: [{ role: "user", content }],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || "";
}

/* ---------- xAI Grok ---------- */
async function callGrok(prompt, env, attachment) {
  const content = [];
  if (attachment) {
    if (attachment.kind === "image") {
      content.push({
        type: "image_url",
        image_url: { url: `data:${attachment.mediaType};base64,${attachment.data}` },
      });
    } else if (attachment.kind === "text" || attachment.kind === "pdf") {
      content.push({ type: "text", text: `[Attached file: ${attachment.filename}]\n${attachment.data}` });
    }
  }
  content.push({ type: "text", text: prompt });

  const res = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.GROK_API_KEY}`,
    },
    body: JSON.stringify({
      model: "grok-4",
      max_tokens: 500,
      messages: [{ role: "user", content }],
    }),
  });
  if (!res.ok) throw new Error(`Grok ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || "";
}

/* ---------- Gemini ---------- */
async function callGemini(prompt, env, attachment) {
  const parts = [];
  if (attachment) {
    if (attachment.kind === "image" || attachment.kind === "pdf") {
      parts.push({ inline_data: { mime_type: attachment.mediaType, data: attachment.data } });
    } else if (attachment.kind === "text") {
      parts.push({ text: `[Attached file: ${attachment.filename}]\n${attachment.data}` });
    }
  }
  parts.push({ text: prompt });

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { maxOutputTokens: 500 },
      }),
    }
  );
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("").trim()) || "";
}

/* ---------- Frontend ---------- */
const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Roundtable - Multi-Model Brainstorming</title>
<style>
  :root {
    --bg: #f7f7f5;
    --panel: #ffffff;
    --border: #e4e2dd;
    --text: #2b2b28;
    --muted: #8a8780;
    --claude: #b5651d;
    --gpt: #2f7a63;
    --gemini: #3b5fa4;
    --grok: #5c5c5c;
    --accent: #4a5b8c;
    --accent-soft: #eef0f7;
    --danger: #b3504a;
    --warn: #c79a45;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, "Segoe UI", Arial, sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; }
  .layout { display: flex; min-height: 100vh; }
  .sidebar { width: 260px; border-right: 1px solid var(--border); padding: 16px; flex-shrink: 0; background: var(--panel); }
  .sidebar h2 { font-size: 13px; margin: 0 0 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
  .conv-item { padding: 10px; border-radius: 8px; cursor: pointer; margin-bottom: 6px; font-size: 13px; border: 1px solid transparent; }
  .conv-item:hover { background: var(--accent-soft); }
  .conv-item.active { background: var(--accent-soft); border-color: var(--accent); }
  .conv-item .date { color: var(--muted); font-size: 11px; margin-top: 2px; }
  #newBtn { width: 100%; padding: 9px; margin-bottom: 14px; background: var(--accent); border: none; color: #fff; border-radius: 8px; cursor: pointer; font-size: 14px; }
  .main { flex: 1; max-width: 760px; margin: 0 auto; padding: 24px 16px 60px; }
  .header-row { display: flex; align-items: baseline; gap: 10px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .version { font-size: 11px; color: var(--muted); border: 1px solid var(--border); border-radius: 10px; padding: 1px 8px; }
  .sub { color: var(--muted); margin-bottom: 20px; font-size: 14px; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 16px; margin-bottom: 16px; }
  textarea { width: 100%; min-height: 80px; background: #fff; color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 10px; font-size: 15px; resize: vertical; }
  .row { display: flex; gap: 12px; align-items: center; margin-top: 12px; flex-wrap: wrap; }
  .chips { display: flex; gap: 8px; flex-wrap: wrap; }
  .chip { border: 1px solid var(--border); border-radius: 20px; padding: 6px 14px; cursor: pointer; font-size: 13px; user-select: none; transition: 0.15s; background: #fff; }
  .chip.claude { color: var(--claude); } .chip.gpt { color: var(--gpt); } .chip.gemini { color: var(--gemini); } .chip.grok { color: var(--grok); }
  .chip.active { background: var(--accent-soft); } .chip.inactive { opacity: 0.4; }
  label { font-size: 13px; color: var(--muted); }
  select, input[type=number] { background: #fff; color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; }
  .btn { border: none; border-radius: 8px; padding: 10px 18px; font-size: 14px; cursor: pointer; }
  .btn-primary { background: var(--accent); color: #fff; }
  .btn-secondary { background: #fff; color: var(--text); border: 1px solid var(--border); }
  .btn-warn { background: #fff; color: var(--warn); border: 1px solid var(--warn); }
  .btn-danger { background: #fff; color: var(--danger); border: 1px solid var(--danger); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .controls { display: flex; gap: 8px; margin-top: 14px; flex-wrap: wrap; }
  .attach-row { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
  .attach-btn { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--border); background: #fff; border-radius: 8px; padding: 6px 12px; cursor: pointer; font-size: 13px; color: var(--muted); }
  .attach-preview { font-size: 12px; color: var(--muted); }
  .attach-preview .remove { color: var(--danger); cursor: pointer; margin-left: 6px; }
  .msg { border-radius: 10px; padding: 12px 14px; margin-bottom: 10px; border-left: 4px solid var(--border); background: var(--panel); border: 1px solid var(--border); border-left-width: 4px; animation: fadeIn 0.25s ease; }
  .msg.claude { border-left-color: var(--claude); } .msg.gpt { border-left-color: var(--gpt); } .msg.gemini { border-left-color: var(--gemini); } .msg.grok { border-left-color: var(--grok); }
  .msg .who { font-weight: 600; font-size: 13px; margin-bottom: 4px; }
  .msg.claude .who { color: var(--claude); } .msg.gpt .who { color: var(--gpt); } .msg.gemini .who { color: var(--gemini); } .msg.grok .who { color: var(--grok); }
  .msg .body { white-space: pre-wrap; font-size: 15px; line-height: 1.5; }
  .thinking, .status { color: var(--muted); font-size: 13px; font-style: italic; margin-bottom: 10px; }
  @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
</style>
</head>
<body>
<div class="layout">
  <div class="sidebar">
    <button id="newBtn">+ New discussion</button>
    <h2>History</h2>
    <div id="convList"></div>
  </div>

  <div class="main">
    <div class="header-row">
      <h1>Roundtable</h1>
      <span class="version">v${APP_VERSION}</span>
    </div>
    <div class="sub">Automated brainstorming between Claude, GPT and Gemini</div>

    <div class="card" id="setupCard">
      <textarea id="topic" placeholder="Type the topic or question for discussion..."></textarea>

      <div class="attach-row">
        <label class="attach-btn" for="fileInput">📎 Attach file or image</label>
        <input type="file" id="fileInput" accept="image/*,.pdf,.txt,.md" style="display:none" />
        <span class="attach-preview" id="attachPreview"></span>
      </div>

      <div class="row">
        <span class="chips" id="chips">
          <span class="chip claude active" data-model="claude">Claude</span>
          <span class="chip gpt active" data-model="gpt">GPT</span>
          <span class="chip gemini active" data-model="gemini">Gemini</span>
          <span class="chip grok active" data-model="grok">Grok</span>
        </span>
      </div>
      <div class="row">
        <label for="rounds">Number of rounds:</label>
        <input type="number" id="rounds" value="3" min="1" max="10" style="width:60px" />
      </div>
      <button class="btn btn-primary" id="start">Start discussion</button>
    </div>

    <div class="controls" id="liveControls" style="display:none;">
      <button class="btn btn-warn" id="pauseBtn">Pause</button>
      <button class="btn btn-primary" id="resumeBtn" style="display:none;">Resume</button>
      <button class="btn btn-danger" id="stopBtn">Stop</button>
    </div>

    <div class="controls" id="continueControls" style="display:none;">
      <input type="number" id="moreRounds" value="3" min="1" max="10" style="width:60px" />
      <button class="btn btn-secondary" id="continueBtn">Continue this discussion (more rounds)</button>
    </div>

    <div id="transcript"></div>
  </div>
</div>

<script>
let currentId = null;
let currentAttachment = null;

const chips = document.querySelectorAll('.chip');
chips.forEach(chip => chip.addEventListener('click', () => {
  chip.classList.toggle('active'); chip.classList.toggle('inactive');
}));

document.getElementById('newBtn').addEventListener('click', resetToSetup);
document.getElementById('start').addEventListener('click', startNewConversation);
document.getElementById('pauseBtn').addEventListener('click', () => sendControl('pause'));
document.getElementById('resumeBtn').addEventListener('click', () => sendControl('resume'));
document.getElementById('stopBtn').addEventListener('click', () => sendControl('stop'));
document.getElementById('continueBtn').addEventListener('click', continueConversation);
document.getElementById('fileInput').addEventListener('change', handleFile);

async function handleFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  const preview = document.getElementById('attachPreview');

  if (file.size > 8 * 1024 * 1024) {
    alert('File too large (max 8MB)');
    e.target.value = '';
    return;
  }

  const isImage = file.type.startsWith('image/');
  const isPdf = file.type === 'application/pdf';

  if (isImage || isPdf) {
    const base64 = await fileToBase64(file);
    currentAttachment = { filename: file.name, mediaType: file.type, kind: isImage ? 'image' : 'pdf', data: base64 };
  } else {
    const text = await file.text();
    currentAttachment = { filename: file.name, mediaType: 'text/plain', kind: 'text', data: text.slice(0, 20000) };
  }

  preview.innerHTML = file.name + ' <span class="remove" id="removeAttach">remove</span>';
  document.getElementById('removeAttach').addEventListener('click', () => {
    currentAttachment = null;
    preview.innerHTML = '';
    document.getElementById('fileInput').value = '';
  });
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function resetToSetup() {
  currentId = null;
  currentAttachment = null;
  document.getElementById('attachPreview').innerHTML = '';
  document.getElementById('fileInput').value = '';
  document.getElementById('setupCard').style.display = 'block';
  document.getElementById('liveControls').style.display = 'none';
  document.getElementById('continueControls').style.display = 'none';
  document.getElementById('transcript').innerHTML = '';
  document.getElementById('topic').value = '';
  highlightActiveConv(null);
}

async function loadConvList() {
  const res = await fetch('/api/conversations');
  const list = await res.json();
  const el = document.getElementById('convList');
  el.innerHTML = '';
  list.forEach(c => {
    const div = document.createElement('div');
    div.className = 'conv-item';
    div.dataset.id = c.id;
    const date = new Date(c.createdAt).toLocaleDateString();
    div.innerHTML = '<div>' + c.topic.slice(0, 40) + '</div><div class="date">' + date + '</div>';
    div.addEventListener('click', () => openConversation(c.id));
    el.appendChild(div);
  });
}

function highlightActiveConv(id) {
  document.querySelectorAll('.conv-item').forEach(el => {
    el.classList.toggle('active', el.dataset.id === id);
  });
}

async function openConversation(id) {
  const res = await fetch('/api/conversations/' + id);
  const conv = await res.json();
  currentId = id;
  highlightActiveConv(id);

  document.getElementById('setupCard').style.display = 'none';
  document.getElementById('liveControls').style.display = 'none';
  document.getElementById('continueControls').style.display = 'flex';

  const transcriptEl = document.getElementById('transcript');
  transcriptEl.innerHTML = '';
  conv.transcript.forEach(t => {
    if (t.model === 'user') return;
    appendMessage(t.model, t.speaker, t.round, t.text);
  });
}

function appendMessage(model, label, round, text) {
  const transcriptEl = document.getElementById('transcript');
  const div = document.createElement('div');
  div.className = 'msg ' + model;
  div.innerHTML = '<div class="who">' + label + ' &middot; round ' + round + '</div><div class="body"></div>';
  div.querySelector('.body').textContent = text;
  transcriptEl.appendChild(div);
  window.scrollTo(0, document.body.scrollHeight);
}

async function sendControl(action) {
  if (!currentId) return;
  await fetch('/api/conversations/' + currentId + '/control', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action })
  });
  document.getElementById('pauseBtn').style.display = action === 'pause' ? 'none' : 'inline-block';
  document.getElementById('resumeBtn').style.display = action === 'pause' ? 'inline-block' : 'none';
}

async function startNewConversation() {
  const topic = document.getElementById('topic').value.trim();
  const rounds = parseInt(document.getElementById('rounds').value) || 3;
  const participants = Array.from(chips).filter(c => c.classList.contains('active')).map(c => c.dataset.model);

  if (!topic) { alert('Please enter a topic'); return; }
  if (participants.length < 2) { alert('Select at least two models'); return; }

  document.getElementById('setupCard').style.display = 'none';
  document.getElementById('liveControls').style.display = 'flex';
  document.getElementById('transcript').innerHTML = '';

  const res = await fetch('/api/conversations', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic, rounds, participants, attachment: currentAttachment })
  });
  await streamResponse(res);
  await loadConvList();
}

async function continueConversation() {
  if (!currentId) return;
  const rounds = parseInt(document.getElementById('moreRounds').value) || 3;
  document.getElementById('liveControls').style.display = 'flex';
  document.getElementById('pauseBtn').style.display = 'inline-block';
  document.getElementById('resumeBtn').style.display = 'none';

  const res = await fetch('/api/conversations/' + currentId + '/continue', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rounds })
  });
  await streamResponse(res);
}

async function streamResponse(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let thinkingEl = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\\n\\n');
    buffer = parts.pop();

    for (const part of parts) {
      if (!part.startsWith('data: ')) continue;
      const data = JSON.parse(part.slice(6));

      if (data.type === 'start') { currentId = data.id; }

      if (data.type === 'thinking') {
        if (thinkingEl) thinkingEl.remove();
        thinkingEl = document.createElement('div');
        thinkingEl.className = 'thinking';
        thinkingEl.textContent = data.label + ' is thinking... (round ' + data.round + ')';
        document.getElementById('transcript').appendChild(thinkingEl);
      }

      if (data.type === 'paused') {
        if (thinkingEl) thinkingEl.remove();
        thinkingEl = document.createElement('div');
        thinkingEl.className = 'status';
        thinkingEl.textContent = 'Discussion paused...';
        document.getElementById('transcript').appendChild(thinkingEl);
      }

      if (data.type === 'message') {
        if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
        appendMessage(data.model, data.speaker, data.round, data.text);
      }

      if (data.type === 'stopped') {
        document.getElementById('liveControls').style.display = 'none';
        document.getElementById('continueControls').style.display = 'flex';
      }

      if (data.type === 'done') {
        document.getElementById('liveControls').style.display = 'none';
        document.getElementById('continueControls').style.display = 'flex';
      }

      if (data.type === 'error') {
        if (thinkingEl) thinkingEl.remove();
        const div = document.createElement('div');
        div.className = 'thinking';
        div.textContent = 'Error: ' + data.message;
        document.getElementById('transcript').appendChild(div);
      }
    }
  }
}

loadConvList();
</script>
</body>
</html>`;
