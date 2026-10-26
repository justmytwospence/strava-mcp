/**
 * Generate docs/reference/tools.md from the running server: tools, resources and
 * prompts as the MCP client sees them. Starts dist/index.js over stdio with sync off, a
 * throw-away mirror and placeholder credentials, so build first:
 *
 *   npm run build && npx tsx scripts/gen-tools.ts
 *
 * CI regenerates the file and fails when it differs from the committed one.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "docs", "reference", "tools.md");

interface JsonSchema {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  default?: unknown;
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  minimum?: number;
  maximum?: number;
}

interface Tool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: JsonSchema;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

interface Resource {
  uri?: string;
  uriTemplate?: string;
  name: string;
  description?: string;
  mimeType?: string;
}

interface Prompt {
  name: string;
  title?: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

class StdioClient {
  private next = 1;
  private pending = new Map<number, (v: unknown) => void>();
  private buffer = "";
  private readonly child;

  constructor(env: NodeJS.ProcessEnv) {
    this.child = spawn(process.execPath, [join(root, "dist", "index.js")], { env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      for (let nl = this.buffer.indexOf("\n"); nl >= 0; nl = this.buffer.indexOf("\n")) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: { message: string } };
        const waiter = msg.id !== undefined ? this.pending.get(msg.id) : undefined;
        if (!waiter) continue;
        this.pending.delete(msg.id!);
        if (msg.error) throw new Error(`${msg.error.message}`);
        waiter(msg.result);
      }
    });
    this.child.stderr.on("data", (d: Buffer) => {
      const text = d.toString();
      if (!/running via stdio/.test(text)) process.stderr.write(text);
    });
  }

  request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.next++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve as (v: unknown) => void);
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  close(): void {
    this.child.kill("SIGTERM");
  }
}

const GROUPS: Array<[string, (name: string) => boolean]> = [
  ["The mirror", (n) => ["strava_query", "strava_schema", "strava_sync_status"].includes(n)],
  ["Streams", (n) => n.endsWith("_streams")],
  ["Uploads", (n) => n.includes("upload")],
  ["Routes", (n) => n.includes("route")],
  ["Clubs", (n) => n.includes("club")],
  ["Gear", (n) => n.includes("gear")],
  ["Segments", (n) => n.includes("segment")],
  ["Activities", (n) => n.includes("activit")],
  ["Athlete", (n) => n.includes("athlete")],
];

function groupOf(name: string): string {
  return GROUPS.find(([, test]) => test(name))?.[0] ?? "Other";
}

function typeOf(s: JsonSchema): string {
  if (s.enum) {
    const values = s.enum.map((v) => `\`${String(v)}\``);
    return values.length > 12
      ? `one of ${values.length} values (${values.slice(0, 6).join(", ")}, ...)`
      : values.join(", ");
  }
  if (s.anyOf) return s.anyOf.map(typeOf).join(" or ");
  const t = Array.isArray(s.type) ? s.type.join(" or ") : (s.type ?? "any");
  if (t === "array") return `array of ${s.items ? typeOf(s.items) : "any"}`;
  if (t === "number" || t === "integer") {
    // zod's int() adds the safe-integer range, which says nothing about the parameter.
    const meaningful = (b: number | undefined) =>
      b !== undefined && Math.abs(b) < Number.MAX_SAFE_INTEGER ? b : undefined;
    const min = meaningful(s.minimum);
    const max = meaningful(s.maximum);
    const bounds = [min !== undefined ? `min ${min}` : "", max !== undefined ? `max ${max}` : ""].filter(Boolean);
    return bounds.length ? `${t} (${bounds.join(", ")})` : t;
  }
  return t;
}

function cell(text: string | undefined): string {
  return (text ?? "").replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();
}

function renderTool(t: Tool): string {
  const lines = [`### \`${t.name}\``, ""];
  if (t.title) lines.push(`**${t.title}**`, "");
  if (t.description) lines.push(t.description.trim(), "");
  const a = t.annotations ?? {};
  const hints = [
    a.readOnlyHint ? (a.openWorldHint ? "cache-first/remote read" : "local read-only") : "writes to Strava",
    a.destructiveHint ? "destructive" : "",
    a.idempotentHint ? "idempotent" : "",
  ].filter(Boolean);
  lines.push(`*${hints.join(", ")}.*`, "");
  const props = t.inputSchema.properties ?? {};
  const required = new Set(t.inputSchema.required ?? []);
  if (Object.keys(props).length === 0) {
    lines.push("No parameters.", "");
  } else {
    lines.push("| Parameter | Type | Required | Description |", "|---|---|---|---|");
    for (const [name, schema] of Object.entries(props)) {
      const def = schema.default !== undefined ? ` Default \`${JSON.stringify(schema.default)}\`.` : "";
      lines.push(
        `| \`${name}\` | ${cell(typeOf(schema))} | ${required.has(name) ? "yes" : "no"} | ${cell(schema.description)}${def} |`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "strava-docs-"));
  const client = new StdioClient({
    ...process.env,
    STRAVA_CLIENT_ID: "docs",
    STRAVA_CLIENT_SECRET: "docs",
    STRAVA_REFRESH_TOKEN: "docs",
    STRAVA_TOKEN_FILE: join(dir, "tokens.json"),
    STRAVA_SYNC: "off",
    STRAVA_UNITS: "metric",
    STRAVA_DB_PATH: join(dir, "strava.duckdb"),
    MCP_TRANSPORT: "stdio",
  });
  try {
    await client.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "gen-tools", version: "0" },
    });
    client.notify("notifications/initialized");
    const { tools } = await client.request<{ tools: Tool[] }>("tools/list");
    const { resources } = await client.request<{ resources: Resource[] }>("resources/list");
    const { resourceTemplates } = await client.request<{ resourceTemplates: Resource[] }>("resources/templates/list");
    const { prompts } = await client.request<{ prompts: Prompt[] }>("prompts/list");

    const byGroup = new Map<string, Tool[]>();
    for (const [g] of GROUPS) byGroup.set(g, []);
    for (const t of tools) byGroup.get(groupOf(t.name))!.push(t);

    const md: string[] = [
      "# Tools, resources and prompts",
      "",
      "<!-- Generated by scripts/gen-tools.ts from the running server; do not edit by hand. -->",
      "",
      `The server registers ${tools.length} tools, ${resources.length + resourceTemplates.length} resources and ${prompts.length} prompts. Mirror SQL/schema/status and prompt retrieval are local-only. Other reads are cache-first except upload status, which always calls Strava. Preserve provenance/coverage notices (see [How sync works](../sync.md#freshness-and-provenance)).`,
      "",
      "Start with `strava://reference/usage`, `strava://mirror/status`, `strava://mirror/schema` and `strava://mirror/budget`: these cost zero API calls. The usage guide lists every URI template and prompt, with bounded examples, even for clients that hide template discovery or initialize instructions. Unknown/missing rate headers are not free calls. Local pagination can follow a full upstream list refresh; check budget before broad reads and reconcile ambiguous writes before retrying.",
      "",
      "Compatible text results remain available. Bounded JSON results also carry structured data; mirrored results use `{ data, _provenance }`. SQL and schema tools declare validated output schemas; provider-dependent payloads deliberately do not. Oversized generic text is explicitly truncated (and structured data omitted); SQL truncates rows to its character budget while keeping valid JSON. Resources reject oversized bodies rather than corrupting JSON/XML.",
      "",
    ];
    for (const [group, list] of byGroup) {
      if (list.length === 0) continue;
      md.push(`## ${group}`, "");
      for (const t of list) md.push(renderTool(t));
    }
    md.push(
      "## Resources",
      "",
      "Read-only context a client can pull into a conversation.",
      "",
      "| URI | Description |",
      "|---|---|",
    );
    for (const r of resources) md.push(`| \`${r.uri}\` | ${cell(r.description)} |`);
    for (const r of resourceTemplates) md.push(`| \`${r.uriTemplate}\` | ${cell(r.description)} |`);
    md.push(
      "",
      "## Prompts",
      "",
      "Local-only workflow templates: no refresh, queueing or API calls during retrieval. Refresh missing context with tools separately; the prompts preserve observation times and warn about incomplete coverage or a 200-item cap.",
      "",
      "| Prompt | Arguments | Description |",
      "|---|---|---|",
    );
    for (const p of prompts) {
      const args = (p.arguments ?? []).map((a) => `\`${a.name}\`${a.required ? "" : "?"}`).join(", ") || "none";
      md.push(`| \`${p.name}\` | ${args} | ${cell(p.description)} |`);
    }
    md.push("");
    writeFileSync(out, md.join("\n"));
    console.log(
      `wrote ${out}: ${tools.length} tools, ${resources.length + resourceTemplates.length} resources, ${prompts.length} prompts`,
    );
  } finally {
    client.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

await main();
