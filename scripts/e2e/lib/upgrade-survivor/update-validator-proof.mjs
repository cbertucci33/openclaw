#!/usr/bin/env node
// Disposable installed-package proof. No product source or package bytes change.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMainThread } from "node:worker_threads";

const sourceSha = "913c3a49df8c89503d1ebbe0d2d1718d345f113d";
const sourceTree = "2308b16a24f1e9cecab802f6cb2770fc2f445e65";
const injectedError = "validator proof: installed child startup failure";
const executionReason = "post-plugin-config-validation-execution-failed";
const containerArtifacts = "/tmp/openclaw-update-first-hop-artifacts";
const leaseFile = "/tmp/openclaw/managed-update-handoffs.sqlite";
const sentinelRoot = "/tmp/openclaw-validator-unrelated-install";
const sha = (value) => createHash("sha256").update(value).digest("hex");
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const write = (file, value) =>
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
const tar = (file, member) => execFileSync("tar", ["-xOf", file, `package/${member}`]);
const build = (file) => JSON.parse(tar(file, "dist/build-info.json"));

function identity(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = raw
      .slice(raw.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/);
    return { pid, parentPid: Number(fields[1]), startIdentity: fields[19] };
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ESRCH") return null;
    throw error;
  }
}

function inspectDatabase(file, action, writable = false) {
  assert(fs.existsSync(file), "required existing database is absent");
  const database = new DatabaseSync(file, { readOnly: !writable });
  try {
    return action(database);
  } finally {
    database.close();
  }
}

function rows(database, table, order) {
  // Identifiers are fixed in this proof; no operator input is interpolated.
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
    return [];
  }
  return database.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all();
}

function leases() {
  const parent = fs.lstatSync(path.dirname(leaseFile));
  assert(parent.isDirectory() && !parent.isSymbolicLink());
  assert.equal(parent.uid, process.getuid());
  assert.equal(parent.mode & 0o777, 0o700);
  return inspectDatabase(leaseFile, (db) => rows(db, "managed_update_handoffs", "install_root"));
}

function owned(row, root) {
  return (
    row.install_root === root || row.install_root.startsWith(`${root}/.openclaw-update-child-`)
  );
}

function stateSnapshot(file) {
  return inspectDatabase(file, (db) => ({
    runs: rows(db, "update_runs", "run_id"),
    leases: rows(db, "state_leases", "scope, lease_key"),
    schema: rows(db, "schema_meta", "meta_key"),
    recovery: rows(db, "config_machine_state", "state_key").filter((row) =>
      row.state_key.startsWith("update.recovery"),
    ),
  }));
}

function schemaInventory(stateFile) {
  const stateDir = path.dirname(path.dirname(stateFile));
  const files = new Set([
    stateFile,
    path.join(stateDir, "agents/main/agent/openclaw-agent.sqlite"),
  ]);
  for (const row of inspectDatabase(stateFile, (db) => rows(db, "agent_databases", "path"))) {
    files.add(path.resolve(stateDir, row.path));
  }
  return [...files].sort().map((file) => {
    const relative = path.relative(stateDir, file);
    assert(
      !relative.startsWith("..") && !path.isAbsolute(relative),
      "unexpected external fixture database",
    );
    const role = file === stateFile ? "state" : "agent";
    if (!fs.existsSync(file)) return { path: relative, role, published: null, content: null };
    return inspectDatabase(file, (db) => {
      const published = db.prepare("PRAGMA user_version").get().user_version;
      const marker =
        role === "state"
          ? rows(db, "config_machine_state", "state_key").find(
              (row) => row.state_key === "state.schema.contentVersion",
            )
          : undefined;
      const content = marker ? JSON.parse(marker.value_json) : published;
      assert(Number.isSafeInteger(published) && Number.isSafeInteger(content) && content >= 0);
      return { path: relative, role, published, content: Math.max(published, content) };
    });
  });
}

function compatibleSchemas(before, after, supported) {
  const previous = new Map(before.map((entry) => [entry.path, entry.content]));
  const current = new Map(after.map((entry) => [entry.path, entry.content]));
  // Match the canonical rollback fence: existing contents must retain their
  // version; a newly created store is allowed only at a supported version.
  return (
    before.every((entry) => entry.content === null || current.get(entry.path) === entry.content) &&
    after.every(
      (entry) =>
        entry.content === null ||
        entry.content === previous.get(entry.path) ||
        (previous.get(entry.path) == null && entry.content === supported[entry.role]),
    )
  );
}

function prepareService(directory) {
  const unit = path.join(process.env.HOME, ".config/systemd/user/openclaw-gateway.service");
  const original = fs.readFileSync(unit, "utf8");
  assert.equal((original.match(/^Environment=NODE_OPTIONS=$/gm) ?? []).length, 1);
  assert.equal((original.match(/^Environment=.*\bNODE_OPTIONS=/gm) ?? []).length, 1);
  for (const match of original.matchAll(/^EnvironmentFile=(-?)([^\r\n]+)$/gm)) {
    const file = match[2].replaceAll("%h", process.env.HOME);
    assert(/^\/[A-Za-z0-9_./-]+$/.test(file), "unexpected fixture environment-file spelling");
    if (!fs.existsSync(file)) {
      assert.equal(match[1], "-");
      continue;
    }
    assert(
      !/^\s*(?:export\s+)?NODE_OPTIONS\s*=/m.test(fs.readFileSync(file, "utf8")),
      "environment file shadows fixture preload",
    );
  }
  const helper = fileURLToPath(import.meta.url);
  assert(/^\/[A-Za-z0-9_./-]+$/.test(helper));
  const assignment = `Environment=NODE_OPTIONS=--import=${helper}`;
  const injected = original.replace(/^Environment=NODE_OPTIONS=$/m, assignment);
  write(path.join(directory, "validator-unit.json"), {
    unit,
    original,
    originalSha256: sha(original),
    injectedSha256: sha(injected),
    assignment,
  });
  fs.writeFileSync(unit, injected);
}

function restoreService(directory, verifyOnly = false) {
  const saved = read(path.join(directory, "validator-unit.json"));
  const current = sha(fs.readFileSync(saved.unit));
  if (!verifyOnly) {
    assert(
      current === saved.injectedSha256 || current === saved.originalSha256,
      "fixture unit drifted; preserve it instead of overwriting",
    );
    if (current === saved.injectedSha256) fs.writeFileSync(saved.unit, saved.original);
    return;
  }
  assert.equal(current, saved.originalSha256);
  assert.equal(sha(fs.readFileSync(`${saved.unit}.loaded-unit`)), saved.originalSha256);
  write(path.join(directory, "validator-unit-restored.json"), {
    restored: true,
    originalSha256: saved.originalSha256,
    injectedSha256: saved.injectedSha256,
  });
}

function packageBackups(root) {
  return fs
    .readdirSync(path.dirname(root), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(".openclaw.package-backup-"))
    .map((entry) => ({
      name: entry.name,
      build: read(path.join(path.dirname(root), entry.name, "dist/build-info.json")),
    }));
}

function arm(directory, root, candidate, published) {
  const seal = read(path.join(directory, "validator-proof-input.json"));
  assert.equal(seal.sourceSha, sourceSha);
  assert.equal(seal.sourceTree, sourceTree);
  assert.equal(
    sha(fs.readFileSync("/tmp/openclaw-update-first-hop-original.tgz")),
    seal.candidateSha256,
  );
  const candidateBuild = build(candidate);
  assert.equal(candidateBuild.commit, sourceSha);
  assert.equal(candidateBuild.buildId, seal.build.buildId);
  assert.equal(sha(tar(candidate, "dist/index.js")), seal.entrySha256);
  const installedBuild = read(path.join(root, "dist/build-info.json"));
  assert.deepEqual(installedBuild, build(published));
  assert.equal(installedBuild.version, "2026.9.4");
  assert.deepEqual(packageBackups(root), []);
  const shell = identity(process.ppid);
  assert(shell?.startIdentity);
  const beforeLeases = leases();
  assert(!beforeLeases.some((row) => owned(row, root)));
  assert(!beforeLeases.some((row) => row.install_root === sentinelRoot));
  // A valid unrelated executor row must survive byte-for-byte, including its
  // live identity. It is outside this installation's update ownership.
  const processIdentity = { pid: shell.pid, startIdentity: shell.startIdentity };
  inspectDatabase(
    leaseFile,
    (db) => {
      db.prepare("INSERT INTO managed_update_handoffs VALUES (?, ?, ?, ?)").run(
        sentinelRoot,
        "validator-proof-unrelated-owner",
        JSON.stringify({
          version: 2,
          executor: processIdentity,
          helper: processIdentity,
          action: { kind: "update" },
        }),
        Date.now(),
      );
    },
    true,
  );
  const stateFile = path.join(process.env.OPENCLAW_STATE_DIR, "state/openclaw.sqlite");
  const unit = path.join(process.env.HOME, ".config/systemd/user/openclaw-gateway.service");
  const configured = read(path.join(directory, "validator-unit.json"));
  assert.equal(sha(fs.readFileSync(unit)), configured.injectedSha256);
  assert.equal(sha(fs.readFileSync(`${unit}.loaded-unit`)), configured.injectedSha256);
  assert(
    fs.readFileSync(`${unit}.loaded-unit`, "utf8").split("\n").includes(configured.assignment),
  );
  const sourceSchemas = JSON.parse(tar(published, "package.json")).openclaw.schemaVersions;
  const candidateSchemas = JSON.parse(tar(candidate, "package.json")).openclaw.schemaVersions;
  write(path.join(directory, "validator-arm.json"), {
    root: fs.realpathSync(root),
    shell,
    candidateBuild,
    publishedBuild: installedBuild,
    entrySha256: seal.entrySha256,
    publishedEntrySha256: sha(fs.readFileSync(path.join(root, "dist/index.js"))),
    stateFile,
    unit,
    unitSha256: sha(fs.readFileSync(unit)),
    serviceLog: process.env.OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_LOG,
    serviceLogBytes: fs.statSync(process.env.OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_LOG).size,
    leases: leases(),
    state: stateSnapshot(stateFile),
    schemas: schemaInventory(stateFile),
    sourceSchemas,
    candidateSchemas,
  });
}

function inject() {
  // Node --import propagates to workers/forks; only this main-thread final
  // installed CLI invocation may fail. Staging/Doctor/npm stay untouched.
  if (!isMainThread || JSON.stringify(process.argv.slice(2)) !== '["config","validate","--json"]')
    return;
  const armed = read(path.join(containerArtifacts, "validator-arm.json"));
  const entry = fs.realpathSync(process.argv[1]);
  if (entry !== path.join(armed.root, "dist/index.js")) return;
  const installed = read(path.join(armed.root, "dist/build-info.json"));
  if (installed.commit !== sourceSha || installed.buildId !== armed.candidateBuild.buildId) return;
  assert.deepEqual(installed, armed.candidateBuild);
  assert.equal(sha(fs.readFileSync(entry)), armed.entrySha256);
  const ancestors = [];
  let current = identity(process.pid);
  while (current && current.pid !== armed.shell.pid && ancestors.length < 16) {
    ancestors.push(current);
    current = identity(current.parentPid);
  }
  assert.deepEqual(current, armed.shell, "validator child must belong to the original proof shell");
  const hit = path.join(containerArtifacts, "validator-hit.json");
  try {
    write(hit, {
      sourceSha,
      buildId: installed.buildId,
      entrySha256: armed.entrySha256,
      argvClass: "config-validate-json",
      ancestors,
    });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    fs.writeFileSync(
      path.join(containerArtifacts, "validator-duplicate.json"),
      '{"duplicate":true}\n',
      { mode: 0o600 },
    );
    throw new Error("validator proof: duplicate target invocation");
  }
  // Emit the actual fixed failure before Node's source excerpt/stack so the
  // unchanged bounded diagnostic owner can retain the cause, not just frames.
  process.stderr.write(`${injectedError}\n`);
  throw new Error(injectedError);
}

function verify(directory, exitCode) {
  assert.equal(Number(exitCode), 1, "published updater must return its actual failure");
  const armed = read(path.join(directory, "validator-arm.json"));
  const hit = read(path.join(directory, "validator-hit.json"));
  assert(!fs.existsSync(path.join(directory, "validator-duplicate.json")));
  assert.equal(hit.sourceSha, sourceSha);
  assert.equal(hit.entrySha256, armed.entrySha256);
  assert.equal(hit.buildId, armed.candidateBuild.buildId);
  assert(hit.ancestors.length > 0);
  for (const processIdentity of hit.ancestors) {
    assert.notEqual(
      identity(processIdentity.pid)?.startIdentity,
      processIdentity.startIdentity,
      "owned child remains present after updater completion",
    );
  }
  const output = read(path.join(directory, "validator-update.stdout"));
  assert.equal(output.status, "error");
  const plugin = output.postUpdate?.plugins;
  assert.equal(plugin?.status, "error");
  assert.equal(plugin.reason, executionReason);
  const warning = plugin.warnings.at(-1);
  assert(
    warning.reason.includes(injectedError),
    "released parent must retain the real child's bounded cause",
  );
  assert(warning.reason.length <= 602);
  if (plugin.failureFacts) {
    assert(plugin.failureFacts.length <= 5);
    assert(plugin.failureFacts.every((fact) => !fact.message || fact.message.length <= 200));
  }
  assert.equal(warning.message, "Config validation could not complete; refusing to restart.");
  assert(warning.guidance.some((line) => line.includes("update repair")));
  assert(!/invalid.config|doctor\s+--fix/i.test(JSON.stringify(plugin.warnings)));
  const allOutput = JSON.stringify(output);
  assert(!allOutput.includes("post-plugin-doctor-invalid-config"));
  assert(!/cleanup=uncertain|child-cleanup-unconfirmed/.test(allOutput));
  const after = stateSnapshot(armed.stateFile);
  const selected = after.runs.find((row) => row.run_id === output.runId);
  assert(selected && !armed.state.runs.some((row) => row.run_id === selected.run_id));
  assert.equal(selected.status, "failed");
  assert(Number.isFinite(selected.finished_at_ms));
  assert.equal(selected.reason, output.reason);
  assert.deepEqual(
    after.leases.filter((row) => row.scope !== "core:plugin-lifecycle"),
    armed.state.leases.filter((row) => row.scope !== "core:plugin-lifecycle"),
  );
  assert(
    !after.leases.some(
      (row) => row.scope === "core:plugin-lifecycle" && row.lease_key === "global",
    ),
  );
  const afterLeases = leases();
  assert(!afterLeases.some((row) => owned(row, armed.root)));
  assert.deepEqual(afterLeases, armed.leases, "unrelated complete executor rows changed");
  const serviceDelta = fs.readFileSync(armed.serviceLog).subarray(armed.serviceLogBytes).toString();
  assert(
    !/(?:^|\s)(?:start|restart)(?:\s|$)/m.test(serviceDelta),
    "inactive service was activated",
  );
  assert.equal(sha(fs.readFileSync(armed.unit)), armed.unitSha256, "service definition changed");
  const installed = read(path.join(armed.root, "dist/build-info.json"));
  const retainedPackages = packageBackups(armed.root);
  const schemas = schemaInventory(armed.stateFile);
  const candidateCompatible = compatibleSchemas(armed.schemas, schemas, armed.candidateSchemas);
  if (
    output.recovery?.packageRollbackVerified === true ||
    output.rollbackOutcome?.status === "succeeded"
  ) {
    assert.deepEqual(installed, armed.publishedBuild);
    assert.equal(
      sha(fs.readFileSync(path.join(armed.root, "dist/index.js"))),
      armed.publishedEntrySha256,
    );
    assert(
      compatibleSchemas(armed.schemas, schemas, armed.sourceSchemas),
      "reported rollback left incompatible schema content",
    );
  } else {
    assert.equal(output.reason, "state-migrated-no-rollback");
    assert.equal(output.recovery?.serviceRestartSafe, false);
    assert.deepEqual(installed, armed.candidateBuild);
    assert.equal(sha(fs.readFileSync(path.join(armed.root, "dist/index.js"))), armed.entrySha256);
    assert.equal(retainedPackages.length, 1, "migration refusal must retain the previous package");
    assert.deepEqual(retainedPackages[0].build, armed.publishedBuild);
    assert(
      !candidateCompatible,
      "migration refusal requires an observed incompatible content-version change",
    );
  }
  // The original public JSON is the released updater's own projection. Keep it
  // intact; the current artifact's reportPath is optional for that old reader.
  if (output.reportPath) {
    const report = fs.readFileSync(output.reportPath, "utf8");
    assert(report.includes("validation"));
    fs.writeFileSync(path.join(directory, "validator-report.md"), report, { mode: 0o600 });
  }
  write(path.join(directory, "validator-proof-receipt.json"), {
    sourceSha,
    sourceTree,
    node: process.versions.node,
    platform: process.platform,
    publishedBuild: armed.publishedBuild,
    candidateBuild: armed.candidateBuild,
    installedBuild: installed,
    targetHitCount: 1,
    entrySha256: hit.entrySha256,
    parentExit: Number(exitCode),
    nestedReason: plugin.reason,
    warning,
    outerReason: output.reason,
    run: {
      id: selected.run_id,
      status: selected.status,
      reason: selected.reason,
      finishedAt: selected.finished_at_ms,
    },
    recovery: output.recovery,
    rollbackOutcome: output.rollbackOutcome,
    schemaBefore: armed.state.schema,
    schemaAfter: after.schema,
    databaseSchemasBefore: armed.schemas,
    databaseSchemasAfter: schemas,
    sourceSchemas: armed.sourceSchemas,
    candidateSchemas: armed.candidateSchemas,
    retainedPackages,
    retainedRecoveryCount: after.recovery.length,
    retainedRecoverySha256: sha(JSON.stringify(after.recovery)),
    ownedProcessesAbsent: true,
    ownedExecutorLeasesAbsent: true,
    unrelatedExecutorRowsUnchanged: true,
    inactiveServicePreserved: true,
    unitUnchanged: true,
  });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === "seal") {
      const [candidate, output] = args;
      const info = build(candidate);
      assert.equal(info.commit, sourceSha);
      assert(info.buildId);
      write(output, {
        sourceSha,
        sourceTree,
        candidateSha256: sha(fs.readFileSync(candidate)),
        candidateBytes: fs.statSync(candidate).size,
        build: info,
        entrySha256: sha(tar(candidate, "dist/index.js")),
      });
    } else if (command === "prepare-service") prepareService(...args);
    else if (command === "restore-service") restoreService(...args);
    else if (command === "verify-service-restored") restoreService(args[0], true);
    else if (command === "arm") arm(...args);
    else if (command === "verify") verify(...args);
    else throw new Error("unknown validator proof command");
  } catch (error) {
    console.error(error);
    console.error("[update-validator-proof] FAILED (exit 1)");
    process.exitCode = 1;
  }
} else {
  inject();
}
