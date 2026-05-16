import { test } from "node:test";
import assert from "node:assert/strict";
import { extractText, translateMessages, translateTools, translateToolChoice, lastUserText } from "./lib/translate.js";

test("extractText - string", () => { assert.equal(extractText("hello"), "hello"); });
test("extractText - non-array", () => { assert.equal(extractText({a:1}), ""); assert.equal(extractText(123), ""); });
test("extractText - content array", () => { assert.equal(extractText([{type:"input_text",text:"a"},{type:"output_text",text:"b"}]), "ab"); });
test("extractText - ignore non-text", () => { assert.equal(extractText([{type:"input_image"},{type:"input_text",text:"t"}]), "t"); });
test("extractText - single object", () => { assert.equal(extractText({type:"text",text:"ok"}), "ok"); });

test("translateMessages - string input", () => { const r = translateMessages("hello"); assert.equal(r.messages.length, 1); assert.equal(r.messages[0].role, "user"); });
test("translateMessages - empty string", () => { assert.equal(translateMessages("   ").messages.length, 0); });
test("translateMessages - message items", () => { const r = translateMessages([{role:"user",content:[{type:"input_text",text:"hi"}]},{role:"assistant",content:[{type:"output_text",text:"hi!"}]}]); assert.equal(r.messages.length, 2); assert.equal(r.messages[0].content, "hi"); });
test("translateMessages - developer -> system", () => { assert.equal(translateMessages([{role:"developer",content:"sys"}]).messages[0].role, "system"); });
test("translateMessages - function_call merge", () => { const r = translateMessages([{role:"assistant",content:[]},{type:"function_call",call_id:"c1",name:"f",arguments:"{}"},{type:"function_call",call_id:"c2",name:"g",arguments:"{}"}]); assert.equal(r.messages.length, 1); assert.equal(r.messages[0].tool_calls.length, 2); });
test("translateMessages - function_call_output", () => { const r = translateMessages([{type:"function_call_output",call_id:"c1",output:{type:"text",text:"ok"}}]); assert.equal(r.messages[0].role, "tool"); assert.equal(r.messages[0].content, "ok"); });
test("translateMessages - reasoning skipped", () => { const r = translateMessages([{role:"user",content:"q"},{type:"reasoning",reasoning_content:"t"}]); assert.equal(r.messages.length, 1); assert.equal(r.stats.skipped.reasoning, 1); });
test("translateMessages - rc stripped (default)", () => { const r = translateMessages([{role:"assistant",content:"a",reasoning_content:"t"}]); assert.equal(r.messages[0].reasoning_content, undefined); assert.equal(r.stats.strippedReasoningContent, 1); });
test("translateMessages - rc kept", () => { const r = translateMessages([{role:"assistant",content:"a",reasoning_content:"t"}], {keepReasoningContent:true}); assert.equal(r.messages[0].reasoning_content, "t"); assert.equal(r.stats.preservedReasoningContent, 1); assert.equal(r.stats.strippedReasoningContent, 0); });
test("translateMessages - file+audio stats", () => { const r = translateMessages([{role:"user",content:[{type:"input_text",text:"hi"},{type:"input_file"},{type:"input_audio"}]}]); assert.equal(r.stats.skipped.file, 1); assert.equal(r.stats.skipped.audio, 1); });
test("translateMessages - status incomplete", () => { const r = translateMessages([{type:"function_call",call_id:"c1",name:"f",arguments:"{}",status:"incomplete"}]); assert.equal(r.messages.length, 1); assert.equal(r.messages[0].role, "assistant"); });
test("translateMessages - empty array", () => { assert.equal(translateMessages([]).messages.length, 0); });
test("translateMessages - null", () => { assert.equal(translateMessages(null).messages.length, 0); });
test("translateMessages - undefined", () => { assert.equal(translateMessages(undefined).messages.length, 0); });
test("translateMessages - full conversation", () => { const r = translateMessages([{role:"user",id:"1",content:[{type:"input_text",text:"w?"}]},{id:"2",type:"function_call",call_id:"abc",name:"f",arguments:"{}",status:"completed"},{id:"3",type:"function_call_output",call_id:"abc",output:{type:"text",text:"ok"},status:"completed"},{role:"assistant",id:"4",content:[{type:"output_text",text:"ok!"}]}]); assert.equal(r.messages.length, 4); assert.equal(r.messages[0].role, "user"); assert.equal(r.messages[1].role, "assistant"); assert.equal(r.messages[2].role, "tool"); assert.equal(r.messages[3].role, "assistant"); });

test("translateTools - empty", () => { assert.deepEqual(translateTools(null), []); assert.deepEqual(translateTools([]), []); });
test("translateTools - normal", () => { const r = translateTools([{type:"function",name:"s",description:"d",parameters:{}}]); assert.equal(r.length, 1); assert.equal(r[0].function.name, "s"); });
test("translateTools - function wrapper", () => { const r = translateTools([{function:{name:"c",description:"d"}}]); assert.equal(r[0].function.name, "c"); });
test("translateTools - filter nameless", () => { const r = translateTools([{type:"function"},{type:"function",name:"v"}]); assert.equal(r.length, 1); });

test("translateToolChoice - null", () => { assert.equal(translateToolChoice(null), null); });
test("translateToolChoice - string passthrough", () => { assert.equal(translateToolChoice("auto"), "auto"); });
test("translateToolChoice - object", () => { const r = translateToolChoice({type:"function",name:"c"}); assert.equal(r.function.name, "c"); });

test("lastUserText - found", () => { assert.equal(lastUserText([{role:"user",content:"q1"},{role:"assistant",content:"a"},{role:"user",content:"q2"}]), "q2"); });
test("lastUserText - not found", () => { assert.equal(lastUserText([]), ""); });

console.log("\nall tests passed!");

