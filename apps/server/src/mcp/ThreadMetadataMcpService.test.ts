import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { OrchestratorProjectionError } from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import type * as McpInvocationContext from "./McpInvocationContext.ts";
import * as ThreadMetadataMcp from "./ThreadMetadataMcpService.ts";

const threadId = ThreadId.make("thread:metadata-caller");
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:metadata-test"),
  threadId,
  providerSessionId: "provider-session:metadata-test",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

function serviceLayer(
  getThreadShell: ThreadManagement.ThreadManagementService["Service"]["getThreadShell"],
) {
  return ThreadMetadataMcp.layer.pipe(
    Layer.provide(
      Layer.merge(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell,
          getThreadRecords: () => Effect.die("projection must not load after shell failure"),
        } satisfies Partial<ThreadManagement.ThreadManagementService["Service"]>),
        NodeCrypto.layer,
      ),
    ),
  );
}

const updateCallingThread = Effect.gen(function* () {
  const service = yield* ThreadMetadataMcp.ThreadMetadataMcpService;
  return yield* service.update(scope, {
    action: "rename",
    title: "Renamed thread",
    clientRequestId: "metadata-caller-classification",
  });
});

it.effect("reports an absent calling thread as thread_not_found", () =>
  Effect.gen(function* () {
    const error = yield* updateCallingThread.pipe(
      Effect.provide(serviceLayer(() => Effect.succeed(null))),
      Effect.flip,
    );

    expect(error.code).toBe("thread_not_found");
  }),
);

it.effect("keeps calling-thread storage failures as orchestration errors", () =>
  Effect.gen(function* () {
    const error = yield* updateCallingThread.pipe(
      Effect.provide(
        serviceLayer(() =>
          Effect.fail(
            new OrchestratorProjectionError({
              threadId,
              cause: new Error("storage unavailable"),
            }),
          ),
        ),
      ),
      Effect.flip,
    );

    expect(error.code).toBe("orchestration_error");
  }),
);

it.effect("refuses to drop an organization conversation's pull request link", () =>
  Effect.gen(function* () {
    const dispatched: Array<unknown> = [];
    const thread = {
      id: threadId,
      projectId: "project",
      organization: { role: "lead", parentThreadId: "chief" },
      linkedPullRequest: {
        projectId: "project",
        repository: "acme/app",
        number: 12,
        url: "https://github.com/acme/app/pull/12",
      },
    };
    const layer = ThreadMetadataMcp.layer.pipe(
      Layer.provide(
        Layer.merge(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: () => Effect.succeed(thread as never),
            getThreadRecords: () => Effect.succeed({ thread } as never),
            dispatch: (command) =>
              Effect.sync(() => {
                dispatched.push(command);
                return { sequence: 1, storedEvents: [] };
              }),
          } satisfies Partial<ThreadManagement.ThreadManagementService["Service"]>),
          NodeCrypto.layer,
        ),
      ),
    );
    const update = (
      input: Parameters<ThreadMetadataMcp.ThreadMetadataMcpService["Service"]["update"]>[1],
    ) =>
      ThreadMetadataMcp.ThreadMetadataMcpService.pipe(
        Effect.flatMap((metadata) => metadata.update(scope, input)),
        Effect.provide(layer),
        Effect.flip,
      );
    expect((yield* update({ action: "unlink_pull_request" })).code).toBe("capability_denied");
    const replace = yield* update({
      action: "link_pull_request",
      pullRequest: {
        repository: "acme/app",
        number: 13,
        url: "https://github.com/acme/app/pull/13",
      },
    });
    expect(replace.code).toBe("capability_denied");
    expect(dispatched).toEqual([]);
  }),
);
