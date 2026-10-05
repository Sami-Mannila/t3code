import * as Schema from "effect/Schema";

/** Durable preparation remains pending; this is not a failed task or provider retry. */
export class OrganizationAdmissionDeferred extends Schema.TaggedError<OrganizationAdmissionDeferred>()(
  "OrganizationAdmissionDeferred",
  { reason: Schema.String },
) {
  override get message() {
    return this.reason;
  }
}
const isDeferred = Schema.is(OrganizationAdmissionDeferred);
export function isOrganizationAdmissionDeferred(error: unknown): boolean {
  let value = error;
  for (let depth = 0; depth < 6 && value && typeof value === "object"; depth++) {
    if (isDeferred(value)) return true;
    value = "cause" in value ? value.cause : undefined;
  }
  return false;
}
