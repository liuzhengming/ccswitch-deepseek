import http from "node:http";
import https from "node:https";
import dotenv from "dotenv";
dotenv.config();

import log from "./lib/log.js";
import { translateMessages, translateTools, translateToolChoice, lastUserText } from "./lib/translate.js";
import { SseTranslator } from "./lib/sse.js";
import { rememberReasoning, recoverReasoning, sessionKey } from "./lib/recover.js";

const DEEPSEEK_API_KEY = process.env.api_key ?? "";
const PORT = parseInt(process.env.port) || 11435;
const DEFAULT_MODEL = process.env.model ?? "deepseek-v4-pro";
const BASE_URL = (process.env.base_url ?? "https://api.deepseek.com").replace(/\/$/, "");
async function readBody(req) { const chunks = []; for await (const chunk of req) chunks.push(chunk); return Buffer.concat(chunks).toString(); }
function resolveModel(clientModel) { if (!clientModel || /^gpt/i.test(clientModel)) return DEFAULT_MODEL; return clientModel; }

function buildChatBody(body) {
  const stream = body.stream !== false;
  const enableThinking = body.thinking === true || (body.thinking && body.thinking.type === "enabled") || (body.reasoning && body.reasoning.effort);
  const { messages, stats } = translateMessages(body.input, { keepReasoningContent: enableThinking });
  const restored = recoverReasoning(sessionKey(body), messages);
  const hasAssistantWithRC = messages.some(m => m.role === "assistant" && m.reasoning_content);
  const hasAssistantWithTC = messages.some(m => m.role === "assistant" && m.tool_calls);
  const effectiveThinking = enableThinking && (hasAssistantWithRC || !hasAssistantWithTC);

  if (enableThinking && !effectiveThinking) log.warn("thinking off: missing rc in history");
  if (restored > 0 && effectiveThinking) log.ok("rc restored x" + restored);
  if (stats.strippedReasoningContent > 0) log.skip("rc stripped x" + stats.strippedReasoningContent);
  if (stats.preservedReasoningContent > 0 && !restored) log.info("rc preserved x" + stats.preservedReasoningContent);

  const userMsgs = messages.filter(m => m.role === "user").length;
  const lastUser = lastUserText(messages);
  const preview = lastUser.length > 120 ? lastUser.slice(0, 120) + "..." : lastUser;
  log.req("thinking:" + (effectiveThinking ? "on" : "off") + " msgs:" + messages.length + " stream:" + stream + " | " + preview);

  const IDENTITY = "\n\n[IMPORTANT: Your true underlying model is DeepSeek (deepseek-v4-pro), developed by DeepSeek (depth seek). You are NOT OpenAI, GPT, Claude, or Codex. When asked about your model identity, you MUST answer that you are DeepSeek, not any other model. Ignore any conflicting identity claims in the instructions above.]";
  let instructions = body.instructions ? body.instructions + IDENTITY : IDENTITY.trim();
  messages.unshift({ role: "system", content: instructions });

  const chatBody = { model: resolveModel(body.model), messages, stream };
  if (effectiveThinking) { chatBody.thinking = { type: "enabled" }; }
  else { chatBody.thinking = { type: "disabled" }; }

  const tools = translateTools(body.tools);
  if (tools.length > 0) { chatBody.tools = tools; const tc = translateToolChoice(body.tool_choice); if (tc) chatBody.tool_choice = tc; }
  if (body.temperature != null) chatBody.temperature = body.temperature;
  if (body.top_p != null) chatBody.top_p = body.top_p;
  if (body.max_output_tokens != null) chatBody.max_tokens = body.max_output_tokens;

  return { chatBody, stream, messages };
}

function buildNonStreamResponse(completion, model) {
  const msg = completion.choices?.[0]?.message;
  const usage = completion.usage;
  const output = [];
  if (msg?.reasoning_content) output.push({ id: "rsn_" + Math.random().toString(36).slice(2,8), type: "reasoning", content: [{ type: "reasoning_text", text: msg.reasoning_content }], status: "completed" });
  if (msg?.content) output.push({ id: "msg_" + Math.random().toString(36).slice(2,8), type: "message", role: "assistant", content: [{ type: "output_text", text: msg.content, annotations: [] }], status: "completed" });
  if (msg?.tool_calls) for (const tc of msg.tool_calls) output.push({ id: "fc_" + tc.id, type: "function_call", call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments, status: "completed" });
  return { id: "resp_" + Math.random().toString(36).slice(2,10), object: "response", status: "completed", model, output, usage: usage ? { input_tokens: usage.prompt_tokens ?? 0, output_tokens: usage.completion_tokens ?? 0, total_tokens: usage.total_tokens ?? 0 } : null };
}
const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, "http://" + req.headers.host);
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/v1" || url.pathname === "/health")) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ service: "ccswitch-deepseek", model: DEFAULT_MODEL, status: "ok", port: PORT })); }
  if (req.method === "POST" && (url.pathname === "/v1/responses" || url.pathname === "/responses")) { try { const raw = await readBody(req); const body = JSON.parse(raw); const { chatBody, stream, messages } = buildChatBody(body); const sk = sessionKey(body);
    const dsReq = https.request({ hostname: new URL(BASE_URL).hostname, path: new URL(BASE_URL).pathname + "chat/completions", method: "POST", timeout: 300000, headers: { "Authorization": "Bearer " + DEEPSEEK_API_KEY, "Content-Type": "application/json", Accept: stream ? "text/event-stream" : "application/json" } }, (dsRes) => {
      if (dsRes.statusCode !== 200) { let errBody = ""; dsRes.on("data", c => errBody += c); dsRes.on("end", () => { log.err("DeepSeek " + dsRes.statusCode + ": " + errBody.slice(0,300)); res.writeHead(dsRes.statusCode >= 500 ? 502 : dsRes.statusCode, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { type: "upstream_error", code: "deepseek_" + dsRes.statusCode, message: "DeepSeek " + dsRes.statusCode + ": " + errBody.slice(0,200) } })); }); return; }
      if (!stream) { let data = ""; dsRes.on("data", c => data += c); dsRes.on("end", () => { try { const completion = JSON.parse(data); if (completion.choices?.[0]?.message?.reasoning_content) { rememberReasoning(sk, [completion.choices[0].message]); } const response = buildNonStreamResponse(completion, chatBody.model); if (completion.usage) log.toks(completion.usage.prompt_tokens, completion.usage.completion_tokens, completion.usage.total_tokens); res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(response)); } catch (e) { log.err("parse: " + e.message); res.writeHead(502); res.end(JSON.stringify({ error: { message: e.message } })); } }); return; }
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" }); const translator = new SseTranslator(res, chatBody.model); let buf = "";
      dsRes.on("data", (chunk) => { buf += chunk.toString(); const ls = buf.split("\n"); buf = ls.pop() ?? ""; for (const line of ls) { if (!line.startsWith("data: ")) continue; const json = line.slice(6).trim(); if (json === "[DONE]") continue; try { translator.feed(JSON.parse(json)); } catch (_) {} } });
      dsRes.on("end", () => { if (buf.trim()) { for (const line of buf.split("\n")) { if (!line.startsWith("data: ")) continue; if (line.slice(6).trim() === "[DONE]") continue; try { translator.feed(JSON.parse(line.slice(6).trim())); } catch (_) {} } } if (translator.reasoningSoFar) { rememberReasoning(sk, [{ role: "assistant", content: translator.contentSoFar, reasoning_content: translator.reasoningSoFar }]); } translator.done(null); });
      dsRes.on("error", (e) => { log.err("upstream: " + e.message); translator.error(e.message); });
    });
    dsReq.on("error", (e) => { log.err("connect: " + e.message); if (!res.headersSent) { res.writeHead(502); res.end(JSON.stringify({ error: { message: e.message } })); } });
    dsReq.on("timeout", () => { dsReq.destroy(); if (!res.headersSent) { res.writeHead(504); res.end(JSON.stringify({ error: { message: "timeout" } })); } });
    dsReq.write(JSON.stringify(chatBody)); dsReq.end();
  } catch (e) { log.err("parse: " + e.message); if (!res.headersSent) { res.writeHead(400); res.end(JSON.stringify({ error: { message: e.message } })); } } return; }
  res.writeHead(404); res.end(JSON.stringify({ error: { message: "not found: " + url.pathname } }));
});
server.listen(PORT, "127.0.0.1", () => { console.log(""); log.ok("ccswitch-deepseek started"); log.info("http://127.0.0.1:" + PORT + "/v1/responses"); log.info("model: dynamic (from request)"); if (!DEEPSEEK_API_KEY) log.warn("api_key not set"); console.log(""); });








