import { createFileRoute } from "@tanstack/react-router";
import { OrganizationPage } from "~/components/organization/OrganizationPage";
export const Route = createFileRoute("/_chat/organization")({ component: OrganizationPage });
