// The MCP tool surface, as a client actually receives it.
//
// Tool descriptions are how a host agent learns what values it may pass, and
// they are assembled from adapter data at server boot. That makes them the one
// place a change to the manifest SHAPE leaks silently into the product: model
// entries became objects, `models.join(", ")` kept type-checking, and every
// client was served "codex: [object Object], [object Object]" as the list of
// valid ids. Nothing failed, and the description was worse than useless -- it
// named no models at all while looking like it did.
//
// So this asserts against the live server rather than the strings in isolation.

import test from "node:test";
import assert from "node:assert/strict";
import path from "path";
import { fileURLToPath } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SERVER_PATH = path.join(REPO_ROOT, "src", "dialog-server.mjs");

async function listTools() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_PATH],
    // The sentinels must be cleared explicitly: a partner-role server serves an
    // empty tool list, which would make every assertion here vacuous.
    env: { ...process.env, DUALOG_ROLE: "", DUALOG_DEPTH: "", DUALOG_MAX_DEPTH: "" },
    stderr: "ignore",
  });
  const client = new Client(
    { name: "tool-description-test", version: "1.0.0" },
    { capabilities: {} }
  );
  await client.connect(transport);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
  }
}

const TOOLS = await listTools();

test("the server exposes a tool surface to assert against", () => {
  assert.ok(TOOLS.length > 0, "no tools were served");
});

test("no tool description ever renders a raw object", () => {
  // Covers descriptions and every nested parameter description, since the
  // schema is serialized to the client the same way.
  for (const tool of TOOLS) {
    const serialized = JSON.stringify(tool);
    assert.ok(
      !serialized.includes("[object Object]"),
      `tool "${tool.name}" serializes an object into its description: ${serialized.slice(0, 400)}`
    );
    assert.ok(
      !serialized.includes("undefined,") && !serialized.includes(": undefined"),
      `tool "${tool.name}" leaks an undefined into its description`
    );
  }
});

test("the model parameter names real model ids", () => {
  // The description exists to tell a host what it may pass. A list that names
  // nothing is the failure this test is here to catch.
  const withModel = TOOLS.filter(
    (tool) => tool.inputSchema?.properties?.model?.description
  );
  assert.ok(withModel.length > 0, "no tool documents its model parameter");

  for (const tool of withModel) {
    const description = tool.inputSchema.properties.model.description;
    assert.match(
      description,
      /claude-opus-5/,
      `tool "${tool.name}" does not name a known model id`
    );
    assert.match(description, /gpt-5\.6-sol/);
  }
});
