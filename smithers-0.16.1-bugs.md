# Smithers v0.16.1 — Three Bugs and Fixes

Tested on Linux x86_64, Node 22, inside a Phala CVM (TEE) environment. All three bugs block workflow execution on a fresh install. Fixes are minimal patches — no forking required.

---

## Bug 1: react-reconciler 0.33.0 Requires Unimplemented Host Method

**Symptom:** Workflow crashes immediately with:
```
TypeError: resolveEventTimeStamp is not a function
```

**Root cause:** `@smithers-orchestrator/react-reconciler` bundles `react-reconciler@^0.33.0`, which added `resolveEventTimeStamp` as a required method on the host config. Smithers' custom reconciler host config doesn't implement it.

**Fix:** Downgrade the nested react-reconciler copy to 0.31.0:
```bash
cd node_modules/@smithers-orchestrator/react-reconciler/node_modules/react-reconciler/
# Replace contents with 0.31.0
npm pack react-reconciler@0.31.0
tar xzf react-reconciler-0.31.0.tgz
cp -r package/* .
rm -rf package react-reconciler-0.31.0.tgz
```

**Why this works:** 0.31.0 is the last version before `resolveEventTimeStamp` was added. Smithers' host config is compatible with it.

---

## Bug 2: ClaudeCodeAgent Clears ANTHROPIC_API_KEY

**Symptom:** Agent spawns `claude` CLI process, which immediately fails with an authentication error. No `ANTHROPIC_API_KEY` in the child process environment.

**Root cause:** The `ClaudeCodeAgent` constructor (or its parent class) strips `ANTHROPIC_API_KEY` from the environment — likely to avoid leaking it when using Claude's OAuth/subscription login instead. But if you're using an API key directly (e.g., through a proxy like ZAI), this kills auth.

**Fix:** Pass the key explicitly in the agent's `env` option:
```javascript
const claude = new ClaudeCodeAgent({
  env: {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
  },
});
```

This overrides the constructor's clearing — `env` in the spawn options takes precedence.

---

## Bug 3: Tasks Require Explicit `agent` Prop (Undocumented Breaking Change)

**Symptom:** Workflow renders without errors but tasks never execute. No agent process spawns. Workflow hangs at `in-progress` indefinitely.

**Root cause:** In v0.16.1, `<Task>` components require an explicit `agent` prop to specify which agent handles them. This is either a breaking change from 0.15.x (where agents were auto-assigned) or an undocumented requirement in the 0.16.x API.

**Fix:** Create an agent instance and pass it to every Task:
```javascript
import { ClaudeCodeAgent, Task, Workflow, createSmithers } from '@smithers-orchestrator/core';

const claude = new ClaudeCodeAgent({
  env: { /* ... see Bug 2 ... */ },
});

const { Workflow, smithers, outputs } = createSmithers({ schemaMap });

// Each Task needs agent={claude}
<Workflow>
  <Task name="build" agent={claude}>
    Run cargo check on the Continuwuity source.
  </Task>
  <Task name="test" agent={claude} dependsOn="build">
    Run the test suite.
  </Task>
</Workflow>
```

Without `agent={claude}`, the reconciler has no executor to dispatch to.

---

## Applying All Three Fixes

```bash
# 1. Downgrade react-reconciler
cd node_modules/@smithers-orchestrator/react-reconciler/node_modules/react-reconciler/
npm pack react-reconciler@0.31.0
tar xzf react-reconciler-0.31.0.tgz
cp -r package/* .
rm -rf package react-reconciler-0.31.0.tgz
cd -

# 2 & 3. In your workflow code, create the agent with env overrides
# and pass agent={claude} to every Task (see Bug 2 and Bug 3 snippets above)
```

No rebuild needed — these are runtime patches. After applying, workflows execute normally: agent spawns, tasks run sequentially, outputs appear in the smithers store.
