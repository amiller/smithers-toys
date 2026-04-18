# Smithers Orchestrator — Session Notes for Maintainers

**Date range:** April 1–18, 2026  
**Environment:** Phala Cloud TEE (Trusted Execution Environment), Linux x86_64  
**Use case:** Autonomous code generation with ClaudeCodeAgent + ZAI Anthropic-compatible proxy

---

## Stack Versions

| Component | Version |
|-----------|---------|
| smithers-orchestrator | 0.15.1 |
| Bun | 1.3.12 (1.2.19 also tested) |
| Claude Code CLI | 2.1.114 |
| @ai-sdk/anthropic | 3.0.71 |
| @ai-sdk/openai | 3.0.53 |
| ai (Vercel AI SDK) | 6.0.168 |
| zod | 4.3.6 |

---

## Workflows Built

### 1. WebGL Baseball Game (`claude-code-baseball`)
- **Architecture:** ClaudeCodeAgent → code task → Playwright screenshots → judge task → publish to GitHub Pages
- **Ralph loop:** max 3 iterations, judge evaluates screenshots + source code
- **Result:** Successfully generated a 3D baseball game and published to `amiller.github.io/smithers-toys/demos/003-baseball/`

### 2. Advanced Mandelbrot Viewer (`mandelbrot-viewer`)
- **Architecture:** Same ClaudeCodeAgent → code → screenshots → judge → publish pipeline
- **Features requested:** Progressive precision (Float64 → BigInt), mobile touch with gesture state machine, smooth coloring
- **Status:** In progress

---

## Bugs Found & Patches Applied

### Patch 1: Conditional `shell: true` in child-process.ts (CRITICAL)

**File:** `node_modules/smithers-orchestrator/src/effect/child-process.ts` ~line 76

**Problem:** `spawn()` called without `shell: true`, so bash tool commands like `mkdir -p /tmp/dir` fail with ENOENT (tries to find a binary literally named `"mkdir -p /tmp/dir"`).

**First fix:** Unconditional `shell: true` — worked for bash tool but broke agent CLIs because `/bin/sh -c` mangles multi-line prompt args with quotes/newlines → `Syntax error: Unterminated quoted string`.

**Current fix:** Conditional based on command name:

```typescript
const isAgentCommand = command === "claude" || command === "codex" || command === "gemini" || command === "kimi" || command === "amp" || command === "forge" || command === "pi";
const child = spawn(command, args, {
  cwd,
  env,
  detached,
  stdio: ["pipe", "pipe", "pipe"],
  shell: !isAgentCommand,
});
```

**Root cause:** Agent CLIs pass prompts as args containing single quotes and newlines. `/bin/sh -c` splits/mangles these. The bash tool needs `shell: true` for compound commands. These two requirements conflict.

**Suggested upstream fix:** Make `shell` configurable per-tool-type in the engine, or auto-detect based on whether args contain spaces/special characters.

---

### Patch 2: Fence stripping in JSON extraction (CRITICAL)

**File:** `node_modules/smithers-orchestrator/src/engine/index.ts` ~line 3405

**Problem:** Models (especially through proxies like ZAI) wrap JSON responses in markdown code fences (`` ```json\n{...}\n``` ``). Smithers' built-in brace-counting JSON extraction fails when the JSON content itself contains many `{`/`}` characters (e.g., GLSL shader code, nested objects).

**Fix:** Strip fences before extraction:

```typescript
const rawText = (result as any).text ?? "";
let text = rawText;
const trimmedText = text.trim();
if (trimmedText.startsWith("```")) {
  let withoutOpen = trimmedText.replace(/^```(?:json)?\s*\n?/, "");
  const closeIdx = withoutOpen.lastIndexOf("```");
  if (closeIdx > 0) {
    withoutOpen = withoutOpen.substring(0, closeIdx).trimEnd();
  }
  text = withoutOpen;
}
```

**Note:** This patch improves success rate but is still flaky. Smithers' built-in schema repair (re-prompting with Zod errors) eventually gets through after 2-7 attempts. The `lastIndexOf` approach handles nested fences better than first-match.

**Suggested upstream fix:** Strip fences as a preprocessing step before any JSON extraction attempt. Make this the default behavior, not a patch.

---

### Patch 3: Keep ANTHROPIC_API_KEY in ClaudeCodeAgent.ts

**File:** `node_modules/smithers-orchestrator/src/agents/ClaudeCodeAgent.ts` ~line 231

**Problem:** ClaudeCodeAgent unsets `ANTHROPIC_API_KEY` by default so Claude CLI uses subscription billing. When using a third-party API proxy (ZAI), the key must be preserved.

**Fix:** Remove/comment the block that clears the env var.

**Suggested upstream fix:** Make this configurable via agent options, e.g., `preserveApiKey: true` or `billingMode: "api" | "subscription"`.

---

## Key Discoveries

### Bun 1.3.x React Context Bug
Bun 1.3.11-12 has a bug where React context propagation fails in Smithers' JSX runtime. `dispatcher.useContext` evaluates to `null`. Smithers is completely non-functional on these versions. Bun 1.2.19 works reliably. Bun 1.3.12 works for simple workflows but may still have edge cases.

**Recommendation:** Pin Bun to 1.2.19 in smithers docs until this is resolved upstream in Bun.

### Output.object() vs Output.text() with @ai-sdk/anthropic
When using `@ai-sdk/anthropic` with `Output.object()`, the SDK internally sets `usesJsonResponseTool=true`. This causes it to skip extracting text content from responses entirely (line 3460 in `@ai-sdk/anthropic/dist/index.mjs`). With ZAI's proxy returning JSON as plain text in `response.body.content[0].text`, this means the output is always empty.

**Workaround:** Use `Output.text()` for all agents and let Smithers handle JSON extraction from raw text.

**Impact:** This affects anyone using a non-Anthropic endpoint through `@ai-sdk/anthropic`, including self-hosted proxies and gateway services.

### Schema Retry Loops
Claude often outputs the JSON schema template (with `$schema`, `type`, `properties`) instead of filling in actual values. Smithers retries with validation errors. Usually resolves on attempt 2-3. The file is already written to disk before schema validation happens (for ClaudeCodeAgent), so the actual work is done even if the schema response is wrong.

### maxOutputBytes Truncation
Default `--max-output-bytes 200000` (200KB) truncates Claude Code agent output. This causes:
- Silent data loss in judge/evaluation tasks
- Infinite retry loops when truncated JSON can't parse
- The CLI flag `--max-output-bytes` doesn't propagate to child process spawns

**Recommendation:** Use `--max-output-bytes 1000000` (1MB) for code generation workflows.

### SQLite Table Schema Conflicts
If a Zod schema changes between runs, the SQLite table for that task retains old columns. This causes silent data loss or "column not found" errors. Must `DROP TABLE IF EXISTS taskName` before relaunching.

### Non-Root User Required
Claude CLI refuses `--dangerously-skip-permissions` when run as root. Must create a dedicated user (e.g., `smithers`) with:
- `~/.claude/settings.json` with permissions allow list
- `~/.claude.json` with `{"hasCompletedOnboarding": true}`
- Access to project directory, bun binary, and env file

### Generated Code Patterns (for prompt engineering)
AI-generated WebGL code has recurring bugs:
- Missing function definitions (especially `mat4RotZ` — LLMs define `mat4RotX` and `mat4RotY` but skip Z)
- No touch input (only mouse/keyboard events) — must explicitly request
- Per-frame geometry allocation (memory leaks) — must explicitly warn against
- Unbounded `devicePixelRatio` on phones — must explicitly clamp

---

## Chronological Session History

### April 1 — Initial Setup
- Installed smithers-orchestrator v0.13.0 with Bun 1.3.11
- React context bug blocked all workflows
- No viable workaround found

### April 2 — Bun Downgrade + Deep Dive
- Downgraded Bun to 1.2.19 → workflows became functional
- Read entire Smithers source code (50 files)
- Documented all components, agents, tools, execution model
- Built kanban workflow with 6-step pipeline
- Discovered maxOutputBytes truncation issue
- Fixed scheduler CLI path bug (hardcoded relative path)
- Environment wiped on TEE restart (April 3)

### April 16-17 — Major Session (v0.15.1)
- Reinstalled at `/root/installing/smithers-npm/` with v0.15.1
- Discovered shell:true missing → applied patch
- Discovered fence stripping issue → applied patch
- Discovered ANTHROPIC_API_KEY clearing → applied patch
- Built WebGL baseball workflow with ClaudeCodeAgent
- Successful end-to-end: generate → screenshot → judge → publish
- Published to GitHub Pages

### April 18 — Mandelbrot Viewer
- Advanced Mandelbrot viewer workflow with progressive precision
- Touch gesture state machine for mobile (fixing double-tap reset bug)
- Claude binary PATH issue (npx cache vs global install)
- Reinstalled claude CLI globally (`npm install -g @anthropic-ai/claude-code`)

---

## Suggested Upstream Improvements

1. **Fence stripping should be default** — Every proxy and many direct API calls wrap JSON in fences. This shouldn't require patching.

2. **Shell option should be per-tool-type** — Agent CLIs and bash commands have fundamentally different spawn requirements. A hardcoded list of agent binary names is fragile.

3. **Output.text() should be the documented default** — `Output.object()` has edge cases with non-standard endpoints. Text + extraction is more universal.

4. **Schema migration for SQLite** — Auto-detect column mismatches and ALTER TABLE, or warn and require manual intervention.

5. **maxOutputBytes should propagate** — CLI flag should override the internal default in all child process spawns.

6. **Document Bun version requirements** — Pin to 1.2.x in docs until React context propagation is fixed in Bun 1.3.x.

7. **Document non-root requirement** — Claude Code's `--dangerously-skip-permissions` is incompatible with root. This should be in setup docs.

8. **Preserve API key option** — Add a config option for `billingMode` or `preserveApiKey` in ClaudeCodeAgent.

---

## Workflow Pattern That Works

The most reliable pattern we found for code generation workflows:

```tsx
// ClaudeCodeAgent writes files to disk, returns summary + path
const coder = new ClaudeCodeAgent({
  model: "claude-sonnet-4-20250514",
  dangerouslySkipPermissions: true,
  allowDangerouslySkipPermissions: true,
});

// Schema: small summary + file path (NOT file content)
const codeSchema = z.object({
  summary: z.string(),
  file: z.string(),
});

// Side effects (screenshots, publish) in JSX render function
// NOT in agents — agents only think and produce text
export default smithers((ctx) => {
  const prevCode = ctx.outputs.code?.at(-1);
  if (prevCode?.file) { /* screenshot, publish */ }
  
  return (
    <Workflow name="my-workflow">
      <Ralph until={approved} maxIterations={3} onMaxReached="return-last">
        <Sequence>
          <Task id="code" output={outputs.code} agent={coder}>
            {/* Detailed prompt with anti-bug instructions */}
          </Task>
          <Task id="judge" output={outputs.judge} agent={coder}>
            {/* Evaluate screenshots + source */}
          </Task>
        </Sequence>
      </Ralph>
    </Workflow>
  );
});
```

Key points:
- Agent writes files via tools, returns only metadata
- Screenshots happen in JSX render (side effects, not agent tasks)
- Judge reads the file from disk, doesn't receive content via prompt wiring
- Ralph loop retries until quality threshold met
