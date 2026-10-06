// @effect-diagnostics globalFetch:off globalConsole:off globalConsoleInEffect:off nodeBuiltinImport:off - Host-side pilot uses sanitized CLI output, an in-memory OAuth exchange and synchronous read-only checks of the project root before native Effect RPC.
import {
  pilotFailureReceipt,
  hasNewPilotFailure,
  type PilotFailureReceipt,
} from "./organizationPilotObservation.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
/** Disposable native-RPC pilot. Does not start a server and refuses model work without --authorized-run.
 * Run from the fork root with its private T3_PILOT_BOOTSTRAP_TOKEN already in the environment.
 * No token, provider settings, environment dump, prompt transcript, or credential file is logged. */
import { NodeWS } from "@effect/platform-node/NodeSocket";
import {
  AuthTokenExchangeGrantType,
  AuthEnvironmentBootstrapTokenType,
  AuthAccessTokenType,
  WsRpcGroup,
  WS_METHODS,
  ORCHESTRATION_V2_WS_METHODS,
  ORCHESTRATION_PROTOCOL_VERSION,
  ProjectId,
  ThreadId,
  CommandId,
  MessageId,
  type OrchestrationV2ThreadShell,
  type OrganizationRole,
} from "@t3tools/contracts";
import {
  type OrganizationRoleModel,
  resolveOrganizationRoleModelSelection,
} from "@t3tools/shared/serverSettings";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as Socket from "effect/unstable/socket/Socket";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";

class PilotBlocked extends Data.TaggedError("PilotBlocked")<{}> {}

const origin = "http://127.0.0.1:3783";
const token = process.env.T3_PILOT_BOOTSTRAP_TOKEN?.trim();
const probeOnly = process.argv.includes("--probe-only");
const rootIndex = process.argv.indexOf("--project-root");
const requestedRoot = rootIndex >= 0 ? process.argv[rootIndex + 1]?.trim() : undefined;
if (rootIndex >= 0 && (!requestedRoot || requestedRoot.startsWith("--")))
  throw new Error("--project-root requires an absolute directory.");
if (requestedRoot !== undefined && !NodePath.isAbsolute(requestedRoot))
  throw new Error("--project-root must be an absolute directory.");
const workspaceRoot = requestedRoot ?? `${process.cwd()}/.t3-pilot/project`;
const multiRepo = process.argv.includes("--multi-repo");
// Every other mode runs only in the disposable default root, never in a real checkout.
if (requestedRoot !== undefined && !multiRepo)
  throw new Error("--project-root is accepted only together with --multi-repo.");
const observeIndex = process.argv.indexOf("--observe-chief");
const observeChief = observeIndex >= 0 ? process.argv[observeIndex + 1]?.trim() : undefined;
if (observeIndex >= 0 && (!observeChief || observeChief.startsWith("--")))
  throw new Error("--observe-chief requires an exact existing Chief thread ID.");
const resumeIndex = process.argv.indexOf("--resume-chief");
const resumeChief = resumeIndex >= 0 ? process.argv[resumeIndex + 1]?.trim() : undefined;
if (resumeIndex >= 0 && (!resumeChief || resumeChief.startsWith("--")))
  throw new Error("--resume-chief requires an exact existing Chief thread ID.");
if (resumeChief && observeChief) throw new Error("Choose recovery or observation, not both.");
const existingChief = resumeChief ?? observeChief;
if (multiRepo && existingChief)
  throw new Error(
    "--multi-repo creates a new isolated project; it cannot resume or observe a Chief.",
  );

/** Read-only Git query in the C locale; null when Git exits non-zero. */
const gitOutput = (cwd: string, args: ReadonlyArray<string>) => {
  try {
    return NodeChildProcess.execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
      env: { ...process.env, LC_ALL: "C", LANGUAGE: "C" },
    }).trim();
  } catch {
    return null;
  }
};
const MULTI_REPO_TARGET = "repo-a";
/**
 * A multi-repo root is a plain folder of repositories: it must not be (or sit inside) a Git
 * work tree, and the repository the executor works in must be one of its children.
 */
const validateMultiRepoRoot = (root: string) => {
  const stat = NodeFS.statSync(root, { throwIfNoEntry: false });
  if (!stat?.isDirectory()) throw new Error("--multi-repo: the project root is not a directory.");
  const real = NodeFS.realpathSync(root);
  // The owner's real repositories live under ~/git; a full-access pilot must never run there.
  const ownerGit = NodePath.join(NodeOS.homedir(), "git");
  const ownerGitReal = NodeFS.existsSync(ownerGit) ? NodeFS.realpathSync(ownerGit) : ownerGit;
  if (real === ownerGitReal || real.startsWith(`${ownerGitReal}${NodePath.sep}`))
    throw new Error(`--multi-repo: the project root must not be under ${ownerGitReal}.`);
  if (gitOutput(real, ["rev-parse", "--is-inside-work-tree"]) === "true")
    throw new Error(
      "--multi-repo: the project root is inside a Git work tree; use a plain folder.",
    );
  const repositories = NodeFS.readdirSync(real, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => {
      const child = NodePath.join(real, name);
      const top = gitOutput(child, ["rev-parse", "--show-toplevel"]);
      return (
        top !== null &&
        NodeFS.realpathSync(top) === NodeFS.realpathSync(child) &&
        gitOutput(child, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]) !== null
      );
    })
    .toSorted();
  if (!repositories.includes(MULTI_REPO_TARGET))
    throw new Error(
      `--multi-repo: the project root must contain a Git repository "${MULTI_REPO_TARGET}" with a commit; found ${repositories.length ? repositories.join(", ") : "none"}.`,
    );
  return repositories;
};
if (multiRepo) {
  const repositories = validateMultiRepoRoot(workspaceRoot);
  console.log(`Pilot multi-repo root validated: repositories=${repositories.join(",")}`);
}
if (!process.argv.includes("--authorized-run") && !probeOnly && !observeChief) {
  console.log(
    "Prepared only: isolated native pilot, loopback 3783, no server or model calls. Root readiness approval is required before --authorized-run.",
  );
  process.exit(0);
}
if (!token) throw new Error("Private pilot bootstrap token is missing.");
let stage = "oauth exchange";
const mark = (next: string) => {
  stage = next;
  console.log(`Pilot stage: ${next}`);
};
mark("oauth exchange");
const Token = Schema.Struct({ access_token: Schema.String });
const exchange = await fetch(`${origin}/oauth/token`, {
  method: "POST",
  signal: AbortSignal.timeout(15000),
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: AuthTokenExchangeGrantType,
    subject_token: token,
    subject_token_type: AuthEnvironmentBootstrapTokenType,
    requested_token_type: AuthAccessTokenType,
    client_label: "isolated-organization-pilot",
  }),
});
if (!exchange.ok)
  throw new Error(`Pilot bootstrap rejected (${exchange.status}); no response details logged.`);
const access = Schema.decodeUnknownSync(Token)(await exchange.json()).access_token;
mark("oauth exchange complete");
const socket = Socket.layerWebSocket(
  `ws://127.0.0.1:3783/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}`,
).pipe(
  Layer.provide(
    Layer.succeed(
      Socket.WebSocketConstructor,
      (url) => new NodeWS.WebSocket(url, { headers: { Authorization: `Bearer ${access}` } }),
    ),
  ),
);
const protocol = Layer.effect(
  RpcClient.Protocol,
  RpcClient.makeProtocolSocket({ retryTransientErrors: false }),
).pipe(Layer.provide(Layer.mergeAll(socket, RpcSerialization.layerJson)));
const program = Effect.gen(function* () {
  mark("native RPC client initialization");
  const crypto = yield* Crypto.Crypto;
  const uuid = () => crypto.randomUUIDv4.pipe(Effect.orDie);
  const client = yield* RpcClient.make(WsRpcGroup);
  mark("native server config RPC");
  const config = yield* client[WS_METHODS.serverGetConfig]({});
  mark("organization capability check");
  if (!config.environment.capabilities.organizationV1)
    return yield* Effect.die("Pilot server lacks organization capability.");
  mark("required provider catalog readiness");
  // The same role models delegate_task uses, from the pilot server's settings.
  const roleModel = (role: OrganizationRole) =>
    resolveOrganizationRoleModelSelection(config.settings, role);
  const slugOf = (model: OrganizationRoleModel) =>
    model.source === "default" ? model.model : model.selection.model;
  const describe = (model: OrganizationRoleModel) =>
    model.source === "default"
      ? `${model.driverKind} ${model.model}`
      : `${model.selection.instanceId} ${model.selection.model}`;
  const readyProvider = (model: OrganizationRoleModel) =>
    config.providers.find(
      (p) =>
        (model.source === "default"
          ? p.driver === model.driverKind
          : p.instanceId === model.selection.instanceId) &&
        p.enabled &&
        p.status === "ready" &&
        p.models.some((m) => m.slug === slugOf(model)),
    );
  const chiefModel = roleModel("chief");
  const executorModel = roleModel("executor");
  const requiredModels = new Set([chiefModel, executorModel].map(slugOf));
  const chiefProvider = readyProvider(chiefModel);
  const executorProvider = readyProvider(executorModel);
  if (probeOnly || !chiefProvider || !executorProvider) {
    for (const provider of config.providers) {
      const matched = provider.models
        .filter((m) => requiredModels.has(m.slug))
        .map((m) => m.slug)
        .join(",");
      const clean = (value: string) => value.replace(/[^a-zA-Z0-9_./:-]/g, "_").slice(0, 160);
      const message = provider.message ?? "";
      const category = /auth|login|sign.?in|credential|token|unauthorized|\b401\b|\b403\b/i.test(
        message,
      )
        ? "auth"
        : /timeout|timed.?out|deadline/i.test(message)
          ? "timeout"
          : /binary|executable|not.found|enoent|not.installed/i.test(message)
            ? "binary"
            : /probe|app.server|initializ|handshake/i.test(message)
              ? "probe"
              : message
                ? "other"
                : "none";
      console.log(
        `Pilot provider id=${clean(provider.instanceId)} driver=${clean(provider.driver)} status=${provider.status} auth=${provider.auth.status} installed=${provider.installed} version=${clean(provider.version ?? "none")} healthCategory=${category} requiredModels=${matched || "none"}`,
      );
    }
    if (probeOnly) {
      mark("read-only provider probe complete; no mutations or model calls");
      return;
    }
    if (!observeChief)
      return yield* Effect.die(
        "Required pilot provider/model is unavailable; no fallback or model call performed.",
      );
  }
  let projectId: ProjectId;
  let threadId: ThreadId;
  let queueBehindActive = false;
  const priorFailures = new Map<string, PilotFailureReceipt>();
  if (existingChief) {
    mark("validate existing isolated Chief");
    const existing = yield* client[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
      threadId: ThreadId.make(existingChief),
    });
    const snapshots = yield* client[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({}).pipe(
      Stream.filter((item) => item.kind === "snapshot"),
      Stream.take(1),
      Stream.runCollect,
    );
    const snapshot = snapshots[0]?.snapshot;
    const project = snapshot?.projects.find((project) => project.id === existing.thread.projectId);
    if (
      existing.thread.organization?.role !== "chief" ||
      existing.thread.deletedAt ||
      existing.thread.archivedAt ||
      project?.workspaceRoot !== workspaceRoot
    )
      return yield* Effect.die(
        "Resume target is not the active Chief of this exact isolated pilot project.",
      );
    projectId = existing.thread.projectId;
    threadId = existing.thread.id;
    queueBehindActive = snapshot!.threads.some(
      (thread) => thread.id === threadId && thread.activeRunId !== null,
    );
    for (const thread of snapshot!.threads)
      if (thread.projectId === projectId) priorFailures.set(thread.id, pilotFailureReceipt(thread));
    mark("validated existing Chief; no project or role creation");
  } else {
    projectId = ProjectId.make(yield* uuid());
    threadId = ThreadId.make(yield* uuid());
    const modelSelection =
      chiefModel.source === "configured"
        ? chiefModel.selection
        : { instanceId: chiefProvider!.instanceId, model: chiefModel.model };
    mark("native project create RPC");
    yield* client[WS_METHODS.projectsMutate]({
      type: "project.create",
      commandId: CommandId.make(yield* uuid()),
      projectId,
      title: multiRepo ? "Isolated multi-repo organization smoke" : "Isolated organization smoke",
      workspaceRoot,
      defaultModelSelection: modelSelection,
    });
    mark("native Chief create RPC");
    yield* client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
      type: "thread.create",
      commandId: CommandId.make(yield* uuid()),
      createdBy: "user",
      creationSource: "web",
      threadId,
      projectId,
      title: multiRepo
        ? "Chief of staff · isolated multi-repo smoke"
        : "Chief of staff · isolated smoke",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      organization: { role: "chief", parentThreadId: null },
    });
    console.log("Native pilot Chief created; task submission is confined to the isolated project.");
  }
  if (!observeChief) {
    mark("native user task dispatch RPC");
    yield* client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
      type: "message.dispatch",
      commandId: CommandId.make(yield* uuid()),
      createdBy: "user",
      creationSource: "web",
      threadId,
      messageId: MessageId.make(yield* uuid()),
      text: multiRepo
        ? `Run the isolated multi-repo organization smoke. The project root is a plain folder of Git repositories, not a repository itself. Delegate exactly one project lead. The lead must delegate exactly one executor with delegate_task repository="${MULTI_REPO_TARGET}" to create only smoke-test.txt in ${MULTI_REPO_TARGET} with exactly organization works followed by one newline (19 UTF-8 bytes; SHA256 a74f3d39459e0245fe64e6360b24c033930204d115611ad5f5083c4fcb600707), then an independent review of that submission. Use the configured role models: lead ${describe(roleModel("lead"))}, executor ${describe(executorModel)}, reviewer ${describe(roleModel("reviewer"))}. No other files or repositories, no research, installation, external source access or credentials. Open no pull request: the server accepts the outcome after its independent outcome review. Never accept it yourself.`
        : resumeChief
          ? "The organization review lookup defect has been repaired and independently reviewed. Recover this existing isolated smoke workstream: ask the same project lead to resume its same assigned reviewer on the existing smoke-test.txt artifact. Do not create another Chief, outcome or executor task. Do not redo executor work unless independent review establishes a real artifact correction is necessary. Use the existing native task IDs and review assignment; no orgctl or duplicate coordinator. Finish the existing lead outcome through its independent outcome review; open no pull request, so the server accepts it after that review. Never accept it yourself. The only permitted artifact remains smoke-test.txt with exactly organization works followed by a newline, 19 bytes and SHA256 a74f3d39459e0245fe64e6360b24c033930204d115611ad5f5083c4fcb600707. No assets/research/credentials/production."
          : `Run the isolated organization smoke described in AGENTS.md. Coordinate through a project lead, an executor and an independent reviewer using native T3 tools. Change only smoke-test.txt to exactly organization works followed by one newline (19 UTF-8 bytes; SHA256 a74f3d39459e0245fe64e6360b24c033930204d115611ad5f5083c4fcb600707). Use the configured role models: lead ${describe(roleModel("lead"))}, executor ${describe(executorModel)}, reviewer ${describe(roleModel("reviewer"))}. No research, installation, external source access, or other files. Open no pull request: the server accepts the outcome after its independent outcome review. Never accept it yourself.`,
      attachments: [],
      dispatchMode: { type: queueBehindActive ? "queue_after_active" : "start_immediately" },
    });
  }
  mark(
    observeChief ? "read-only existing Chief observation; no dispatch" : "native task observation",
  );
  let reviewedOutcome = false;
  let failedThreadId: string | null = null;
  const show = (thread: OrchestrationV2ThreadShell) => {
    if (thread.projectId !== projectId || !thread.organization) return;
    const task = thread.organization.task;
    if (
      hasNewPilotFailure(
        pilotFailureReceipt(thread),
        existingChief ? priorFailures.get(thread.id) : undefined,
      )
    ) {
      failedThreadId = thread.id;
      console.log(
        `Pilot requires owner attention: thread=${thread.id}, status=${thread.status}, task=${task?.state ?? "none"}, request=${thread.pendingRuntimeRequest?.kind ?? "none"}`,
      );
    }
    console.log(
      `Pilot role=${thread.organization.role} thread=${thread.id} provider=${thread.providerInstanceId} activity=${thread.activityRunStatus ?? "idle"} task=${task?.state ?? "none"} owner=${task?.ownerThreadId ?? "none"}`,
    );
    if (
      thread.organization.role === "lead" &&
      (task?.state === "awaiting_review" || task?.state === "accepted") &&
      task.revision &&
      task.reviewedRevision === task.revision
    ) {
      reviewedOutcome = true;
      console.log(
        `Pilot reviewed outcome ${task.state === "accepted" ? "accepted by the server" : "awaiting server acceptance"}: ${thread.id}, revision=${task.revision}, files=${task.files?.length ?? 0}`,
      );
    }
  };
  yield* client[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({}).pipe(
    Stream.tap((item) =>
      Effect.sync(() => {
        if (item.kind === "snapshot") item.snapshot.threads.forEach(show);
        else if (item.kind === "thread.updated") show(item.thread);
      }),
    ),
    Stream.takeUntil(() => reviewedOutcome || failedThreadId !== null),
    Stream.runDrain,
    Effect.timeout("10 minutes"),
  );
  if (failedThreadId) return yield* Effect.fail(new PilotBlocked());
});
mark("native protocol connection");
try {
  await Effect.runPromise(
    program.pipe(
      Effect.provide(Layer.mergeAll(protocol, NodeCrypto.layer)),
      Effect.onError((cause) =>
        Effect.sync(() => {
          const failure = Cause.squash(cause);
          const tag =
            typeof failure === "object" &&
            failure !== null &&
            "_tag" in failure &&
            typeof failure._tag === "string" &&
            /^[a-zA-Z0-9_]+$/.test(failure._tag)
              ? failure._tag
              : "untagged";
          console.error(`Pilot failure stage=${stage} errorTag=${tag}; private payload omitted.`);
        }),
      ),
      Effect.timeout("10 minutes"),
      Effect.scoped,
    ),
  );
} catch (failure) {
  const errorClass =
    failure instanceof TypeError
      ? "TypeError"
      : failure instanceof ReferenceError
        ? "ReferenceError"
        : failure instanceof SyntaxError
          ? "SyntaxError"
          : "EffectFailure";
  console.error(
    `Pilot stopped at ${stage} (${errorClass}) or reached its observation deadline. Inspect its native organization view; error payloads intentionally omitted.`,
  );
  process.exitCode = 1;
}
