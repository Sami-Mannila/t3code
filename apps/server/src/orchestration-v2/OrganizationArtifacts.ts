import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export class OrganizationArtifactError extends Schema.TaggedError<OrganizationArtifactError>()(
  "OrganizationArtifactError",
  { detail: Schema.String },
) {
  override get message() {
    return this.detail;
  }
}

/** Hash actual bounded files, not an executor's claim or a conversation summary. */
export const snapshot = Effect.fn("OrganizationArtifacts.snapshot")(function* (
  workspace: string,
  manifest: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!manifest.length || manifest.length > 256 || new Set(manifest).size !== manifest.length)
    return yield* new OrganizationArtifactError({
      detail: "An artifact manifest must contain 1–256 unique relative file paths.",
    });
  const root = yield* fs.realPath(workspace);
  const digest = NodeCrypto.createHash("sha256");
  const files: Array<{ path: string; sha256: string; bytes: number }> = [];
  for (const name of [...manifest].sort()) {
    if (
      path.isAbsolute(name) ||
      name.split(/[\\/]/).some((part) => part === ".." || part === ".git") ||
      name.includes("\0")
    )
      return yield* new OrganizationArtifactError({
        detail: "Artifact paths must stay inside the task worktree and outside Git metadata.",
      });
    const target = yield* fs.realPath(path.join(root, name));
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
      return yield* new OrganizationArtifactError({
        detail: "Artifact path escapes the task worktree.",
      });
    const info = yield* fs.stat(target);
    if (info.type !== "File" || Number(info.size) > 16 * 1024 * 1024)
      return yield* new OrganizationArtifactError({
        detail: "Each artifact must be a regular file no larger than 16 MiB.",
      });
    const bytes = yield* fs.readFile(target);
    const sha256 = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
    digest.update(name).update("\0").update(sha256).update("\0");
    files.push({ path: name, sha256, bytes: bytes.length });
  }
  return { revision: digest.digest("hex"), files };
});
