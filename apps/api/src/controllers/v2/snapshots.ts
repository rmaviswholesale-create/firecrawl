import type { Response } from "express";
import { z } from "zod";
import type { RequestWithAuth } from "./types";
import { createMarkdownChangeDiff } from "../../lib/change-tracking-diff";
import {
  getSnapshot,
  listSnapshots,
  snapshotStoreEnabled,
} from "../../lib/snapshot-store";

const UNAVAILABLE =
  "The snapshot store is not enabled on this deployment. It is on by default for self-hosted instances without DB authentication; set SNAPSHOT_STORE_ENABLED=true to force it.";

const listQuerySchema = z.object({
  url: z.url(),
  tag: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

const diffQuerySchema = z.object({
  from: z.uuid(),
  to: z.uuid(),
});

function badRequest(res: Response, error: z.ZodError) {
  return res.status(400).json({
    success: false,
    error: error.issues
      .map(issue => `${issue.path.join(".")}: ${issue.message}`)
      .join("; "),
  });
}

/** GET /v2/snapshots?url=&tag=&limit= — a page's saved versions, newest first. */
export async function snapshotListController(
  req: RequestWithAuth<{}, any, undefined>,
  res: Response,
) {
  if (!snapshotStoreEnabled) {
    return res.status(501).json({ success: false, error: UNAVAILABLE });
  }
  const query = listQuerySchema.safeParse(req.query);
  if (!query.success) return badRequest(res, query.error);

  const snapshots = await listSnapshots(
    {
      teamId: req.auth.team_id,
      url: query.data.url,
      tag: query.data.tag ?? null,
    },
    query.data.limit,
  );
  return res.status(200).json({ success: true, snapshots });
}

/** GET /v2/snapshots/diff?from=&to= — what changed between two versions. */
export async function snapshotDiffController(
  req: RequestWithAuth<{}, any, undefined>,
  res: Response,
) {
  if (!snapshotStoreEnabled) {
    return res.status(501).json({ success: false, error: UNAVAILABLE });
  }
  const query = diffQuerySchema.safeParse(req.query);
  if (!query.success) return badRequest(res, query.error);

  const [from, to] = await Promise.all([
    getSnapshot(req.auth.team_id, query.data.from),
    getSnapshot(req.auth.team_id, query.data.to),
  ]);
  if (!from || !to) {
    return res
      .status(404)
      .json({ success: false, error: "Snapshot not found." });
  }

  const changed = from.contentHash !== to.contentHash;
  const diff = changed
    ? createMarkdownChangeDiff(from.markdown, to.markdown)
    : undefined;
  const { markdown: _from, ...fromSummary } = from;
  const { markdown: _to, ...toSummary } = to;
  return res.status(200).json({
    success: true,
    changeStatus: changed ? "changed" : "same",
    from: fromSummary,
    to: toSummary,
    ...(diff ? { diff } : {}),
    // The versions differ but the diff was too large to compute.
    ...(changed && !diff ? { diffOmitted: true } : {}),
  });
}

/** GET /v2/snapshots/:snapshotId — one saved version, with its markdown. */
export async function snapshotGetController(
  req: RequestWithAuth<{ snapshotId: string }, any, undefined>,
  res: Response,
) {
  if (!snapshotStoreEnabled) {
    return res.status(501).json({ success: false, error: UNAVAILABLE });
  }
  if (!z.uuid().safeParse(req.params.snapshotId).success) {
    return res
      .status(400)
      .json({ success: false, error: "Invalid snapshot ID." });
  }
  const snapshot = await getSnapshot(req.auth.team_id, req.params.snapshotId);
  if (!snapshot) {
    return res
      .status(404)
      .json({ success: false, error: "Snapshot not found." });
  }
  return res.status(200).json({ success: true, snapshot });
}
