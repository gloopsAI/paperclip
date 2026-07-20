import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvals } from "@paperclipai/db";
import type { AttentionFeed, SidebarBadges } from "@paperclipai/shared";

const ACTIONABLE_APPROVAL_STATUSES = ["pending", "revision_requested"];

function isDismissedByAnyKey(
  dismissedAtByKey: ReadonlyMap<string, number>,
  itemKeys: readonly string[],
  activityAt: Date | string | null | undefined,
) {
  return itemKeys.some((itemKey) => isDismissed(dismissedAtByKey, itemKey, activityAt));
}

function normalizeTimestamp(value: Date | string | null | undefined): number {
  if (!value) return 0;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function isDismissed(
  dismissedAtByKey: ReadonlyMap<string, number>,
  itemKey: string,
  activityAt: Date | string | null | undefined,
) {
  const dismissedAt = dismissedAtByKey.get(itemKey);
  if (dismissedAt == null) return false;
  return dismissedAt >= normalizeTimestamp(activityAt);
}

export function sidebarBadgeService(db: Db) {
  return {
    get: async (
      companyId: string,
      extra?: {
        attentionFeed?: AttentionFeed;
        dismissals?: ReadonlyMap<string, number>;
        joinRequests?: Array<{ id: string; updatedAt: Date | string | null; createdAt: Date | string }>;
      },
    ): Promise<SidebarBadges> => {
      if (extra?.attentionFeed) {
        const feedJoinRequests = extra.attentionFeed.countsBySourceKind.join_request ?? 0;
        const visibleJoinRequests = extra.joinRequests
          ? extra.joinRequests.filter((row) =>
            !isDismissedByAnyKey(
              extra.dismissals ?? new Map(),
              [
                `attention:join:${row.id}`,
                `attention:join_request:${row.id}`,
                `join:${row.id}`,
              ],
              row.updatedAt ?? row.createdAt,
            )
          ).length
          : feedJoinRequests;
        const approvals = extra.attentionFeed.countsBySourceKind.approval ?? 0;
        const failedRuns = extra.attentionFeed.countsBySourceKind.failed_run ?? 0;

        return {
          inbox: extra.attentionFeed.totalCount - feedJoinRequests + visibleJoinRequests,
          approvals,
          failedRuns,
          joinRequests: visibleJoinRequests,
        };
      }

      const actionableApprovals = await db
        .select({ id: approvals.id, updatedAt: approvals.updatedAt })
        .from(approvals)
        .where(
          and(
            eq(approvals.companyId, companyId),
            inArray(approvals.status, ACTIONABLE_APPROVAL_STATUSES),
          ),
        )
        .then((rows) =>
          rows.filter((row) =>
            !isDismissedByAnyKey(
              extra?.dismissals ?? new Map(),
              [`approval:${row.id}`, `attention:approval:${row.id}`],
              row.updatedAt,
            )
          ).length
        );

      const joinRequests = (extra?.joinRequests ?? []).filter((row) =>
        !isDismissedByAnyKey(
          extra?.dismissals ?? new Map(),
          [
            `attention:join:${row.id}`,
            `attention:join_request:${row.id}`,
            `join:${row.id}`,
          ],
          row.updatedAt ?? row.createdAt,
        )
      ).length;
      return {
        inbox: actionableApprovals + joinRequests,
        approvals: actionableApprovals,
        failedRuns: 0,
        joinRequests,
      };
    },
  };
}
