import type { Response } from "express";
import type { RequestWithAuth } from "./types";
import { browserProfileNameSchema } from "../../lib/browser-profiles";
import {
  deleteLocalProfile,
  getLocalProfileSummary,
  listLocalProfiles,
  localProfileStoreEnabled,
} from "../../lib/local-profile-store";

const UNAVAILABLE =
  "Local browser profiles are not enabled on this deployment. They are on by default for self-hosted instances without DB authentication or Hangar.";

function fail(res: Response, status: number, error: string) {
  return res.status(status).json({ success: false, error });
}

/** GET /v2/profiles */
export async function profileListController(
  req: RequestWithAuth<{}, any, undefined>,
  res: Response,
) {
  if (!localProfileStoreEnabled) return fail(res, 501, UNAVAILABLE);
  const profiles = await listLocalProfiles(req.auth.team_id);
  return res.status(200).json({ success: true, profiles });
}

/** GET /v2/profiles/:name */
export async function profileGetController(
  req: RequestWithAuth<{ name: string }, any, undefined>,
  res: Response,
) {
  if (!localProfileStoreEnabled) return fail(res, 501, UNAVAILABLE);
  const parsed = browserProfileNameSchema.safeParse(req.params.name);
  if (!parsed.success) {
    return fail(res, 400, "Profile name must be between 1 and 128 UTF-8 bytes.");
  }
  const profile = await getLocalProfileSummary(req.auth.team_id, parsed.data);
  if (!profile) return fail(res, 404, "Profile not found.");
  return res.status(200).json({ success: true, profile });
}

/** DELETE /v2/profiles/:name */
export async function profileDeleteController(
  req: RequestWithAuth<{ name: string }, any, undefined>,
  res: Response,
) {
  if (!localProfileStoreEnabled) return fail(res, 501, UNAVAILABLE);
  const parsed = browserProfileNameSchema.safeParse(req.params.name);
  if (!parsed.success) {
    return fail(res, 400, "Profile name must be between 1 and 128 UTF-8 bytes.");
  }
  await deleteLocalProfile(req.auth.team_id, parsed.data);
  return res.status(200).json({ success: true });
}
