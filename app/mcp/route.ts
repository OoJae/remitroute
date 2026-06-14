// Minimal Model Context Protocol endpoint for RemitRoute. Declared in the
// ERC-8004 registration as the "MCP" service, so it must answer a plain GET
// (health/descriptor) with 200 and speak enough JSON-RPC 2.0 (initialize,
// tools/list, tools/call) for an agent or a health checker to discover the
// agent's read-only capabilities. The actual FX quote is the paid x402 endpoint
// at /api/fx-route; tools/call here returns a pointer to it rather than
// executing a paid action.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "RemitRoute", version: "1.0.0" };

const TOOLS = [
  {
    name: "fx_route_quote",
    description:
      "Get an optimal Mento FX route and live rate between two Celo stablecoins (e.g. cUSD to cKES). This is a paid (x402) action settled on Celo; call the x402 endpoint at /api/fx-route to execute.",
    inputSchema: {
      type: "object",
      properties: {
        tokenIn: { type: "string", description: "Input token symbol, e.g. cUSD" },
        tokenOut: { type: "string", description: "Output token symbol, e.g. cKES" },
        amountIn: { type: "string", description: "Input amount, e.g. 1" },
      },
      required: ["tokenIn", "tokenOut"],
    },
  },
];

function baseUrl(request: Request): string {
  const origin = new URL(request.url).origin;
  return origin.replace(/\/$/, "");
}

// GET: human/health descriptor. A bare GET must return 200 so 8004scan's
// endpoint health check passes.
export async function GET(request: Request) {
  return Response.json(
    {
      protocol: "mcp",
      protocolVersion: PROTOCOL_VERSION,
      serverInfo: SERVER_INFO,
      capabilities: { tools: {} },
      tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
      transport: "https",
      endpoint: `${baseUrl(request)}/mcp`,
    },
    { headers: { "content-type": "application/json" } },
  );
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

// POST: minimal JSON-RPC 2.0 for initialize / tools/list / tools/call.
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as JsonRpcRequest | null;
  const id = body?.id ?? null;
  const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string) =>
    Response.json({ jsonrpc: "2.0", id, error: { code, message } });

  switch (body?.method) {
    case "initialize":
      return reply({
        protocolVersion: PROTOCOL_VERSION,
        serverInfo: SERVER_INFO,
        capabilities: { tools: {} },
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      const name = (body?.params?.name as string) ?? "";
      if (name !== "fx_route_quote") return fail(-32602, `unknown tool: ${name}`);
      return reply({
        content: [
          {
            type: "text",
            text: `fx_route_quote is a paid (x402) action. Call GET ${baseUrl(
              request,
            )}/api/fx-route?tokenIn=cUSD&tokenOut=cKES&amountIn=1 with an x402 payment to receive the live Mento route and rate.`,
          },
        ],
      });
    }
    default:
      return fail(-32601, `method not found: ${body?.method ?? "(none)"}`);
  }
}
