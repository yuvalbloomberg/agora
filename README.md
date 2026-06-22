# Roundtable

Automated multi-model brainstorming. Claude, GPT, Gemini, and Grok discuss a
topic you set, responding to each other round after round - like a real
roundtable discussion, not separate parallel answers.

## Features
- Multi-round automated discussion between Claude, GPT, Gemini, and Grok
- Each model sees and responds directly to what the others said
- Pause / resume / stop a live discussion
- Conversation history saved (Cloudflare KV) - resume any discussion later
- Attach a file or image as shared context for all models
- Runs entirely on a single Cloudflare Worker (API + frontend)

## Requirements
- A Cloudflare account (free tier works)
- [Node.js](https://nodejs.org) and `wrangler` CLI (`npm install -g wrangler`)
- Your own API keys:
  - Anthropic: https://console.anthropic.com
  - OpenAI: https://platform.openai.com
  - Google Gemini: https://aistudio.google.com
  - xAI Grok: https://console.x.ai

Each person who deploys this runs it with their own keys and pays for their
own usage. No keys are stored in this repo or shared between users.

## Setup

1. Clone this repo and `cd` into it.
2. Log in to Cloudflare:
   ```
   wrangler login
   ```
3. Create your own KV namespace:
   ```
   wrangler kv namespace create ROUNDTABLE_KV
   ```
   Copy the returned `id` into `wrangler.toml`, replacing `YOUR_KV_ID`.
4. Set your API keys as secrets (you'll be prompted to paste each one):
   ```
   wrangler secret put ANTHROPIC_API_KEY
   wrangler secret put OPENAI_API_KEY
   wrangler secret put GEMINI_API_KEY
   wrangler secret put GROK_API_KEY
   ```
5. Deploy:
   ```
   wrangler deploy
   ```
6. Open the returned `https://roundtable.<your-subdomain>.workers.dev` URL.

## Notes
- Models used by default: `claude-sonnet-4-6`, `gpt-4.1`, `gemini-2.5-pro`, `grok-4`.
  Change these in `worker.js` (`callClaude` / `callOpenAI` / `callGemini` / `callGrok`).
- Max 10 rounds per run to limit cost/runtime.
- CORS is open (`*`) by default; restrict in `corsHeaders()` if needed.
- Attachments: images/PDF up to 8MB, text files truncated to ~20K characters.

## License
MIT - see [LICENSE](LICENSE).
