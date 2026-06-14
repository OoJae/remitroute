// MiMo client via the Anthropic SDK pointed at MiMo's Anthropic-compatible
// endpoint. Used by the natural-language rule parser. The model only proposes a
// structured rule; zod validates it and the user confirms before anything saves.
import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { log } from "./log.js";

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!config.MIMO_API_KEY) {
    throw new Error("MIMO_API_KEY is not set; the rule parser is unavailable");
  }
  if (!client) {
    client = new Anthropic({ apiKey: config.MIMO_API_KEY, baseURL: config.MIMO_BASE_URL });
  }
  return client;
}

// Strip markdown code fences and pull out the first JSON object in a string.
function extractJson(text: string): unknown {
  const fenced = text.replace(/```(?:json)?/gi, "").trim();
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("no JSON object found in model output");
  }
  return JSON.parse(fenced.slice(start, end + 1));
}

// Ask the model to produce a JSON object for the given system + user prompt.
// Retries once if the first response is not parseable JSON.
export async function parseStructured(system: string, user: string): Promise<unknown> {
  const c = getClient();
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: user }];

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const res = await c.messages.create({
      model: config.MIMO_MODEL,
      max_tokens: 1024,
      system,
      messages,
    });
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    try {
      return extractJson(text);
    } catch (err) {
      log.warn({ err, attempt, text: text.slice(0, 200) }, "rule parse JSON failed");
      if (attempt === 2) throw new Error(`model did not return valid JSON: ${text.slice(0, 120)}`);
      messages.push({ role: "assistant", content: text });
      messages.push({
        role: "user",
        content: "That was not valid JSON. Reply with ONLY the JSON object, no prose, no code fences.",
      });
    }
  }
  throw new Error("unreachable");
}
