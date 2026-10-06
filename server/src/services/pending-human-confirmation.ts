import { and, eq, inArray } from "drizzle-orm";
import { issueThreadInteractions, type Db } from "@paperclipai/db";

export async function hasPendingHumanConfirmation(db: Db, companyId: string, issueId: string) {
  const [interaction] = await db.select({ id: issueThreadInteractions.id })
    .from(issueThreadInteractions)
    .where(and(
      eq(issueThreadInteractions.companyId, companyId),
      eq(issueThreadInteractions.issueId, issueId),
      eq(issueThreadInteractions.status, "pending"),
      inArray(issueThreadInteractions.kind, ["request_confirmation", "request_checkbox_confirmation"]),
      eq(issueThreadInteractions.effectiveResolverPolicy, "human_only"),
    ))
    .limit(1);
  return Boolean(interaction);
}
