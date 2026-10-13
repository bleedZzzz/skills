#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");

// Codex counterpart to render-claude-stdout.js. Same CLI contract (flags,
// defaulting to the newest runs/ dir, reading prompt.md/metadata.json
// alongside stdout.txt) so the two renderers are interchangeable from a
// caller's point of view — only the event shapes being parsed differ.
//
// Event shapes handled below (confirmed empirically against codex-cli
// 0.160.1's `exec --json` output, not from docs):
//   {"type":"thread.started","thread_id":"..."}
//   {"type":"turn.started"}
//   {"type":"item.completed","item":{"id":...,"type":"agent_message","text":"..."}}
//   {"type":"item.completed","item":{"id":...,"type":"command_execution",
//     "command":"...","aggregated_output":"...","exit_code":0,"status":"completed"}}
//   {"type":"item.completed","item":{"id":...,"type":"error","message":"..."}}
//   {"type":"turn.completed","usage":{"input_tokens":...,"cached_input_tokens":...,
//     "cache_write_input_tokens":...,"output_tokens":...,"reasoning_output_tokens":...}}
//   {"type":"turn.failed","error":{"message":"..."}}
//   {"type":"error","message":"..."}   (transient reconnect/warning lines)
// `item.started` is intentionally not rendered on its own: the matching
// `item.completed` for the same item carries everything (including the
// command itself), so showing both would just duplicate the command line.
// An item that starts but never reaches item.completed (a genuine crash) is
// still visible via the run's overall exit code / turn.failed, and in full
// under --show-raw.

function usage() {
  console.log(`Usage: scripts/render-codex-stdout.js [RUN_DIR|STDOUT_FILE] [options]

Turns Codex stdout.txt (the \`codex exec --json\` event stream) into a readable
transcript.

Arguments:
  RUN_DIR|STDOUT_FILE        A runs/<run-id> directory or stdout.txt file.
                             Defaults to the newest directory under runs/.

Options:
  --output FILE              Write transcript to FILE instead of stdout.
  --show-tool-json           Include full item JSON for command executions.
  --show-raw                 Include unparsable raw lines, item.started
                              events, and transient top-level error/warning
                              lines (reconnect messages etc).
  -h, --help                 Show this help.

Examples:
  scripts/render-codex-stdout.js
  scripts/render-codex-stdout.js runs/20261009T140000Z-qdrant-smoke
  scripts/render-codex-stdout.js runs/20261009T140000Z-qdrant-smoke/stdout.txt --output readable.md
`);
}

function parseArgs(argv) {
  const options = {
    input: "",
    output: "",
    showToolJson: false,
    showRaw: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    }
    if (arg === "--output") {
      options.output = requireValue(arg, argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--show-tool-json") {
      options.showToolJson = true;
      continue;
    }
    if (arg === "--show-raw") {
      options.showRaw = true;
      continue;
    }
    if (arg.startsWith("-")) {
      fail(`Unknown option: ${arg}`);
    }
    if (options.input) {
      fail(`Only one input path is supported: got ${options.input} and ${arg}`);
    }
    options.input = arg;
  }

  return options;
}

function requireValue(option, value) {
  if (!value) {
    fail(`Missing value for ${option}`);
  }
  return value;
}

function fail(message) {
  console.error(message);
  process.exit(64);
}

function resolveInput(input) {
  if (input) {
    const absolute = path.resolve(input);
    return stdoutPathFor(absolute);
  }

  const runsDir = path.join(repoRoot, "runs");
  if (!fs.existsSync(runsDir)) {
    fail("No input provided and runs/ does not exist.");
  }

  const newest = fs
    .readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = path.join(runsDir, entry.name);
      return { dir, mtimeMs: fs.statSync(dir).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0];

  if (!newest) {
    fail("No input provided and runs/ has no run directories.");
  }

  return stdoutPathFor(newest.dir);
}

function stdoutPathFor(inputPath) {
  if (!fs.existsSync(inputPath)) {
    fail(`Input path not found: ${inputPath}`);
  }

  const stats = fs.statSync(inputPath);
  if (stats.isDirectory()) {
    const stdoutPath = path.join(inputPath, "stdout.txt");
    if (!fs.existsSync(stdoutPath)) {
      fail(`Run directory has no stdout.txt: ${inputPath}`);
    }
    return stdoutPath;
  }

  return inputPath;
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function oneLine(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function indent(text, spaces = 2) {
  const prefix = " ".repeat(spaces);
  return String(text)
    .split("\n")
    .map((line) => (line ? `${prefix}${line}` : ""))
    .join("\n");
}

function prettyJson(value) {
  return JSON.stringify(value, null, 2);
}

function truncate(text, max = 1800) {
  const value = String(text ?? "");
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}\n... [truncated ${value.length - max} chars]`;
}

function renderAgentMessage(item, lines) {
  lines.push("");
  lines.push("## Assistant");
  lines.push("");
  lines.push(String(item.text ?? "").trim());
}

function renderCommandExecution(item, lines, options) {
  lines.push("");
  lines.push("## Command Execution");
  if (item.id) {
    lines.push(`- ID: ${item.id}`);
  }
  if (item.status) {
    lines.push(`- Status: ${item.status}`);
  }
  if (item.exit_code !== null && item.exit_code !== undefined) {
    lines.push(`- Exit code: ${item.exit_code}`);
  }
  if (item.command) {
    lines.push("");
    lines.push("```bash");
    lines.push(item.command);
    lines.push("```");
  }
  if (item.aggregated_output) {
    lines.push("");
    lines.push(indent(truncate(item.aggregated_output)));
  }
  if (options.showToolJson) {
    lines.push("");
    lines.push("```json");
    lines.push(prettyJson(item));
    lines.push("```");
  }
}

function renderItemError(item, lines) {
  lines.push("");
  lines.push("## Item Error");
  if (item.id) {
    lines.push(`- ID: ${item.id}`);
  }
  lines.push(`- Message: ${oneLine(item.message)}`);
}

function renderUnknownItem(item, lines, options) {
  lines.push("");
  lines.push(`## Item: ${item.type || "unknown"}`);
  if (item.id) {
    lines.push(`- ID: ${item.id}`);
  }
  if (options.showToolJson || options.showRaw) {
    lines.push("");
    lines.push("```json");
    lines.push(prettyJson(item));
    lines.push("```");
  }
}

function renderItemCompleted(event, lines, options) {
  const item = event.item;
  if (!item || typeof item !== "object") {
    return;
  }

  if (item.type === "agent_message") {
    renderAgentMessage(item, lines);
  } else if (item.type === "command_execution") {
    renderCommandExecution(item, lines, options);
  } else if (item.type === "error") {
    renderItemError(item, lines);
  } else {
    renderUnknownItem(item, lines, options);
  }
}

function renderTurnCompleted(event, lines) {
  lines.push("");
  lines.push("## Turn Complete");
  const usage = event.usage;
  if (usage && typeof usage === "object") {
    const parts = [];
    if (usage.input_tokens !== undefined) {
      parts.push(`input=${usage.input_tokens}`);
    }
    if (usage.cached_input_tokens !== undefined) {
      parts.push(`cached=${usage.cached_input_tokens}`);
    }
    if (usage.cache_write_input_tokens !== undefined) {
      parts.push(`cache_write=${usage.cache_write_input_tokens}`);
    }
    if (usage.output_tokens !== undefined) {
      parts.push(`output=${usage.output_tokens}`);
    }
    if (usage.reasoning_output_tokens !== undefined) {
      parts.push(`reasoning_output=${usage.reasoning_output_tokens}`);
    }
    if (parts.length > 0) {
      lines.push(`- Tokens: ${parts.join(", ")}`);
    }
  }
}

function renderTurnFailed(event, lines) {
  lines.push("");
  lines.push("## Turn Failed");
  const message = event.error && event.error.message;
  lines.push(`- Error: ${oneLine(message)}`);
}

function renderTopLevelError(event, lines) {
  lines.push(`- ${oneLine(event.message)}`);
}

function renderPlainText(raw, lines) {
  const text = raw.trim();
  if (!text) {
    return;
  }
  lines.push("");
  lines.push("## Output");
  lines.push("");
  lines.push(text);
}

function renderTranscript(stdoutPath, options) {
  const runDir = path.dirname(stdoutPath);
  const metadata = readJsonIfExists(path.join(runDir, "metadata.json"));
  const prompt = fs.existsSync(path.join(runDir, "prompt.md"))
    ? fs.readFileSync(path.join(runDir, "prompt.md"), "utf8").trim()
    : "";

  const lines = [];
  lines.push(`# Codex Transcript`);
  lines.push("");
  lines.push(`- Source: ${stdoutPath}`);
  if (metadata) {
    lines.push(`- Run ID: ${metadata.run_id || path.basename(runDir)}`);
    lines.push(`- Exit code: ${metadata.exit_code}`);
    lines.push(`- Model: ${metadata.model || "unknown"}`);
    lines.push(`- Permission mode: ${metadata.permission_mode || "unknown"}`);
    lines.push(`- Login status: ${metadata.login_status || "unknown"}`);
    if (metadata.timed_out) {
      lines.push(`- Timed out: yes (after ${metadata.timeout_secs}s)`);
    }
  }
  if (prompt) {
    lines.push("");
    lines.push("## Prompt");
    lines.push("");
    lines.push(prompt);
  }

  const raw = fs.readFileSync(stdoutPath, "utf8");
  const rawLines = raw.split(/\r?\n/).filter((line) => line.trim());
  let parsedAny = false;
  const warnings = [];

  for (const line of rawLines) {
    let event;
    try {
      event = JSON.parse(line);
      parsedAny = true;
    } catch {
      if (options.showRaw) {
        renderPlainText(line, lines);
      } else if (!parsedAny && rawLines.length === 1) {
        renderPlainText(line, lines);
      }
      continue;
    }

    if (event.type === "item.completed") {
      renderItemCompleted(event, lines, options);
    } else if (event.type === "item.started") {
      if (options.showRaw) {
        lines.push("");
        lines.push(`## Item Started: ${(event.item && event.item.type) || "unknown"}`);
        lines.push("");
        lines.push("```json");
        lines.push(prettyJson(event.item));
        lines.push("```");
      }
    } else if (event.type === "turn.completed") {
      renderTurnCompleted(event, lines);
    } else if (event.type === "turn.failed") {
      renderTurnFailed(event, lines);
    } else if (event.type === "error") {
      // Transient reconnect/warning lines, not part of the substantive
      // transcript — collected and shown compactly at the end, in full only
      // under --show-raw.
      warnings.push(event);
    } else if (options.showRaw) {
      lines.push("");
      lines.push(`## Raw Event: ${event.type || "unknown"}`);
      lines.push("");
      lines.push("```json");
      lines.push(prettyJson(event));
      lines.push("```");
    }
  }

  if (warnings.length > 0) {
    lines.push("");
    lines.push(`## Warnings (${warnings.length})`);
    const shown = options.showRaw ? warnings : warnings.slice(0, 5);
    for (const event of shown) {
      renderTopLevelError(event, lines);
    }
    if (!options.showRaw && warnings.length > shown.length) {
      lines.push(`- ... ${warnings.length - shown.length} more (pass --show-raw to see all)`);
    }
  }

  return `${lines.join("\n")}\n`;
}

const options = parseArgs(process.argv.slice(2));
const stdoutPath = resolveInput(options.input);
const transcript = renderTranscript(stdoutPath, options);

if (options.output) {
  fs.writeFileSync(path.resolve(options.output), transcript);
} else {
  process.stdout.write(transcript);
}
