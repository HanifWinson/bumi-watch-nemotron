// agent/nemotron.js
// NVIDIA Nemotron client via Nebius Token Factory (OpenAI-compatible API).
// Runs the tool-calling loop: model asks for data → we query SQLite →
// results go back to the model → repeat until it writes a final answer.

import dotenv from "dotenv";
import { TOOLS, TOOL_SOURCES, executeTool } from "./toolDefinitions.js";
dotenv.config();

const BASE_URL  = process.env.NEBIUS_BASE_URL || "https://api.tokenfactory.nebius.com/v1";
const MODEL     = process.env.NEMOTRON_MODEL  || "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B";
const MAX_STEPS = parseInt(process.env.AGENT_MAX_STEPS, 10) || 5;
const TIMEOUT_MS = parseInt(process.env.NEBIUS_TIMEOUT_MS, 10) || 60000;
// Nemotron reasons before answering and the reasoning counts toward this limit;
// at 2048 it sometimes ran out before writing the answer.
const MAX_TOKENS = parseInt(process.env.NEMOTRON_MAX_TOKENS, 10) || 4096;

// ─── Single chat completion call ──────────────────────────────────────────────
async function chatCompletion({ messages, tools, toolChoice = "auto" }) {
  const apiKey = process.env.NEBIUS_API_KEY;
  if (!apiKey) throw new Error("NEBIUS_API_KEY not set in .env");

  const body = {
    model: MODEL,
    messages,
    temperature: 0.3,
    top_p: 0.8,
    max_tokens: MAX_TOKENS,
  };
  if (tools) {
    body.tools = tools;
    body.tool_choice = toolChoice;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res;
  try {
    res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === "AbortError") throw new Error(`Nebius request timed out after ${TIMEOUT_MS}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Nebius API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  const choice = data.choices?.[0];
  if (!choice?.message) throw new Error("Nemotron returned no message");
  return { ...choice.message, finish_reason: choice.finish_reason };
}

// Reasoning models may inline their thinking. Keep only the answer.
function cleanAnswer(text) {
  return (text ?? "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

// ─── Agent loop ───────────────────────────────────────────────────────────────
export async function runAgent({ systemPrompt, question, history = [] }) {
  const messages = [
    { role: "system", content: systemPrompt },
    ...formatHistory(history),
    { role: "user", content: question },
  ];

  const toolLog = [];      // every tool call made, for metadata + debugging
  const sources = new Set();

  for (let step = 0; step < MAX_STEPS; step++) {
    const message = await chatCompletion({ messages, tools: TOOLS });
    const toolCalls = message.tool_calls || [];

    // No tool calls → this is the final answer
    if (toolCalls.length === 0) {
      const answer = cleanAnswer(message.content);
      if (!answer) {
        throw new Error(message.finish_reason === "length"
          ? `Nemotron used all ${MAX_TOKENS} tokens reasoning before answering (raise NEMOTRON_MAX_TOKENS)`
          : "Nemotron returned an empty answer");
      }
      return { answer, toolCalls: toolLog, sources: [...sources], steps: step + 1 };
    }

    // Keep the assistant turn (with its tool_calls) in the conversation
    messages.push({
      role: "assistant",
      content: message.content || "",
      tool_calls: toolCalls,
    });

    // Run all requested tools in parallel
    const results = await Promise.all(
      toolCalls.map(async (call) => {
        const name = call.function?.name;
        let args = {};
        try {
          args = JSON.parse(call.function?.arguments || "{}");
        } catch {
          return { call, name, args, output: { error: "Invalid JSON arguments" } };
        }
        try {
          const output = await executeTool(name, args);
          (TOOL_SOURCES[name] || []).forEach((s) => sources.add(s));
          return { call, name, args, output };
        } catch (err) {
          return { call, name, args, output: { error: err.message } };
        }
      })
    );

    for (const { call, name, args, output } of results) {
      console.log(`🔧 ${name}(${JSON.stringify(args)})${output?.error ? ` ❌ ${output.error}` : ""}`);
      toolLog.push({ name, args, ok: !output?.error });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        name,
        content: JSON.stringify(output),
      });
    }
  }

  // Hit the step limit: force a final answer with what we have
  messages.push({
    role: "user",
    content: "Answer now using only the data already retrieved. Do not call more tools.",
  });
  const final = await chatCompletion({ messages });
  return {
    answer: cleanAnswer(final.content) || "Maaf, saya tidak dapat menyelesaikan permintaan ini.",
    toolCalls: toolLog,
    sources: [...sources],
    steps: MAX_STEPS + 1,
  };
}

// Frontend sends history as {role, content} (or Gemini-style {role, parts}).
// Normalise to OpenAI format and drop anything malformed.
function formatHistory(history) {
  return history
    .filter((m) => m && m.role && (m.content || m.parts))
    .map((m) => ({
      role: m.role === "model" || m.role === "assistant" ? "assistant" : "user",
      content: m.content || m.parts?.map((p) => p.text).join("") || "",
    }))
    .slice(-10); // keep context short
}
