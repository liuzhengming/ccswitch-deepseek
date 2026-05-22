import log from "./log.js";


export class SseTranslator {
  constructor(res, model = "deepseek-v4-pro") {
    this.res = res;
    this.MODEL = model;
    this.responseId = "resp_" + Math.random().toString(36).slice(2, 10);
    this.messageItemId = "item_" + Math.random().toString(36).slice(2, 10);
    this.textStarted = false;
    this.contentSoFar = "";
    this.reasoningStarted = false;
    this.reasoningSoFar = "";
    this.reasoningItemId = null;
    this.toolCalls = new Map();
    this.started = false;
    this.outputItemCount = 0;
    this.outputItems = [];
    this._lastUsage = null;
  }

  emit(event, data) {
    this.res.write("event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n");
  }

  _ensureStarted() {
    if (this.started) return;
    this.started = true;
    this.emit("response.created", {
      type: "response.created",
      response: { id: this.responseId, object: "response", status: "in_progress", model: this.MODEL, output: [] },
    });
    this.emit("response.in_progress", { type: "response.in_progress", response_id: this.responseId });
    log.info("SSE start: " + this.responseId);
  }

  feed(chunk) {
    const delta = chunk.choices?.[0]?.delta;
    if (!delta) return;
    if (chunk.usage) this._lastUsage = chunk.usage;

    if (delta.content) {
      this._ensureStarted();
      this.contentSoFar += delta.content;
      if (!this.textStarted) {
        this.textStarted = true;
        const oi = this.outputItemCount++;
        this.outputItems.push({ index: oi, type: "message", itemId: this.messageItemId });
        this.emit("response.output_item.added", { type: "response.output_item.added", response_id: this.responseId, output_index: oi, item: { id: this.messageItemId, type: "message", role: "assistant", status: "in_progress", content: [] } });
        this.emit("response.content_part.added", { type: "response.content_part.added", response_id: this.responseId, item_id: this.messageItemId, output_index: oi, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
      }
      this.emit("response.output_text.delta", { type: "response.output_text.delta", response_id: this.responseId, item_id: this.messageItemId, output_index: this._msgIndex(), content_index: 0, delta: delta.content });
    }

    if (delta.reasoning_content) {
      this._ensureStarted();
      this.reasoningSoFar += delta.reasoning_content;
      if (!this.reasoningStarted) {
        this.reasoningStarted = true;
        this.reasoningItemId = "rsn_" + Math.random().toString(36).slice(2, 10);
        const oi = this.outputItemCount++;
        this.outputItems.push({ index: oi, type: "reasoning", itemId: this.reasoningItemId });
        this.emit("response.output_item.added", { type: "response.output_item.added", response_id: this.responseId, output_index: oi, item: { id: this.reasoningItemId, type: "reasoning", status: "in_progress", summary: [] } });
        this.emit("response.content_part.added", { type: "response.content_part.added", response_id: this.responseId, item_id: this.reasoningItemId, output_index: oi, content_index: 0, part: { type: "reasoning_text", text: "" } });
      }
      const rIdx = this._rsnIndex();
      if (rIdx >= 0) this.emit("response.reasoning_text.delta", { type: "response.reasoning_text.delta", response_id: this.responseId, item_id: this.reasoningItemId, output_index: rIdx, content_index: 0, delta: delta.reasoning_content });
    }

    if (delta.tool_calls) {
      this._ensureStarted();
      for (const tc of delta.tool_calls) {
        const idx = tc.index;
        if (!this.toolCalls.has(idx)) {
          const call = { id: tc.id || "call_" + idx, name: tc.function?.name ?? "", arguments: "" };
          this.toolCalls.set(idx, call);
          const oi = this.outputItemCount++;
          this.outputItems.push({ index: oi, type: "function_call", itemId: "fc_" + call.id });
          this.emit("response.output_item.added", { type: "response.output_item.added", response_id: this.responseId, output_index: oi, item: { id: "fc_" + call.id, type: "function_call", call_id: call.id, name: call.name, status: "in_progress" } });
          log.info("tool: " + call.name + " (" + call.id + ")");
        }
        const call = this.toolCalls.get(idx);
        if (tc.function?.name) call.name = tc.function.name;
        const d = tc.function?.arguments ?? "";
        call.arguments += d;
        const oi = this._itemIndex("fc_" + call.id);
        if (oi >= 0) this.emit("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", response_id: this.responseId, item_id: "fc_" + call.id, output_index: oi, delta: d });
      }
    }
  }

  done(usageOverride) {
    this._ensureStarted();
    const usage = usageOverride || this._lastUsage || null;

    if (this.textStarted) {
      const oi = this._msgIndex();
      this.emit("response.content_part.done", { type: "response.content_part.done", response_id: this.responseId, item_id: this.messageItemId, output_index: oi, content_index: 0, part: { type: "output_text", text: this.contentSoFar, annotations: [] } });
      this.emit("response.output_text.done", { type: "response.output_text.done", response_id: this.responseId, item_id: this.messageItemId, output_index: oi, content_index: 0, text: this.contentSoFar });
      this.emit("response.output_item.done", { type: "response.output_item.done", response_id: this.responseId, output_index: oi, item: { id: this.messageItemId, type: "message", role: "assistant", content: [{ type: "output_text", text: this.contentSoFar, annotations: [] }], status: "completed" } });
      log.resp("text output: " + this.contentSoFar.length + " chars");
    }

    if (this.reasoningStarted) {
      const oi = this._rsnIndex();
      this.emit("response.content_part.done", { type: "response.content_part.done", response_id: this.responseId, item_id: this.reasoningItemId, output_index: oi, content_index: 0, part: { type: "reasoning_text", text: this.reasoningSoFar } });
      this.emit("response.reasoning_text.done", { type: "response.reasoning_text.done", response_id: this.responseId, item_id: this.reasoningItemId, output_index: oi, content_index: 0, text: this.reasoningSoFar });
      this.emit("response.output_item.done", { type: "response.output_item.done", response_id: this.responseId, output_index: oi, item: { id: this.reasoningItemId, type: "reasoning", content: [{ type: "reasoning_text", text: this.reasoningSoFar }], status: "completed" } });
      log.resp("reasoning output: " + this.reasoningSoFar.length + " chars");
    }

    for (const [idx, call] of this.toolCalls) {
      const oi = this._itemIndex("fc_" + call.id);
      const outIdx = oi >= 0 ? oi : idx + 1;
      this.emit("response.function_call_arguments.done", { type: "response.function_call_arguments.done", response_id: this.responseId, item_id: "fc_" + call.id, output_index: outIdx, arguments: call.arguments, name: call.name, call_id: call.id });
      this.emit("response.output_item.done", { type: "response.output_item.done", response_id: this.responseId, output_index: outIdx, item: { id: "fc_" + call.id, type: "function_call", call_id: call.id, name: call.name, arguments: call.arguments, status: "completed" } });
      log.resp("tool done: " + call.name);
    }

    const respUsage = usage ? { input_tokens: usage.prompt_tokens ?? 0, output_tokens: usage.completion_tokens ?? 0, total_tokens: usage.total_tokens ?? 0 } : null;

    const outSnapshot = [];
    for (const o of this.outputItems) {
      if (o.type === "message") outSnapshot.push({ id: o.itemId, type: "message", role: "assistant", content: [{ type: "output_text", text: this.contentSoFar, annotations: [] }], status: "completed" });
      else if (o.type === "reasoning") outSnapshot.push({ id: o.itemId, type: "reasoning", content: [{ type: "reasoning_text", text: this.reasoningSoFar }], status: "completed" });
      else if (o.type === "function_call") {
        for (const [, c] of this.toolCalls) {
          if ("fc_" + c.id === o.itemId) outSnapshot.push({ id: o.itemId, type: "function_call", call_id: c.id, name: c.name, arguments: c.arguments, status: "completed" });
        }
      }
    }

    this.emit("response.completed", { type: "response.completed", response: { id: this.responseId, object: "response", status: "completed", model: this.MODEL, output: outSnapshot, usage: respUsage } });

    if (usage) log.toks(usage.prompt_tokens, usage.completion_tokens, usage.total_tokens);
    log.ok("SSE done: " + this.responseId);
    this.res.end();
  }

  error(msg) {
    this.emit("error", { type: "error", code: "proxy_error", message: msg });
    log.err("SSE error: " + msg);
    this.res.end();
  }

  _msgIndex() { for (const o of this.outputItems) if (o.type === "message") return o.index; return 0; }
  _rsnIndex() { for (const o of this.outputItems) if (o.type === "reasoning") return o.index; return -1; }
  _itemIndex(id) { for (const o of this.outputItems) if (o.itemId === id) return o.index; return -1; }
}
