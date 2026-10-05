import { createFileRoute } from "@tanstack/react-router";
import { OrganizationPage } from "~/components/organization/OrganizationPage";

/** `project` is "<environmentId>:<projectId>", set by the organization panel's "Open full view". */
export const Route = createFileRoute("/_chat/organization")({
  validateSearch: (search: Record<string, unknown>): { project?: string } =>
    typeof search.project === "string" ? { project: search.project } : {},
  component: OrganizationPage,
});
