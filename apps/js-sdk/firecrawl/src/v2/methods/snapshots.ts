import type {
  Snapshot,
  SnapshotDiffResponse,
  SnapshotSummary,
} from "../types";
import { HttpClient } from "../utils/httpClient";
import {
  normalizeAxiosError,
  throwForBadResponse,
} from "../utils/errorHandler";

export async function listSnapshots(
  http: HttpClient,
  options: { url: string; tag?: string; limit?: number },
): Promise<SnapshotSummary[]> {
  try {
    const query = new URLSearchParams({ url: options.url });
    if (options.tag !== undefined) query.set("tag", options.tag);
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    const res = await http.get<{
      success: boolean;
      snapshots?: SnapshotSummary[];
      error?: string;
    }>(`/v2/snapshots?${query.toString()}`);
    if (res.status !== 200 || !res.data?.success || !res.data.snapshots) {
      throwForBadResponse(res as any, "list snapshots");
    }
    return res.data.snapshots;
  } catch (err: any) {
    if (err?.isAxiosError) return normalizeAxiosError(err, "list snapshots");
    throw err;
  }
}

export async function getSnapshot(
  http: HttpClient,
  snapshotId: string,
): Promise<Snapshot> {
  try {
    const res = await http.get<{
      success: boolean;
      snapshot?: Snapshot;
      error?: string;
    }>(`/v2/snapshots/${encodeURIComponent(snapshotId)}`);
    if (res.status !== 200 || !res.data?.success || !res.data.snapshot) {
      throwForBadResponse(res as any, "get snapshot");
    }
    return res.data.snapshot;
  } catch (err: any) {
    if (err?.isAxiosError) return normalizeAxiosError(err, "get snapshot");
    throw err;
  }
}

export async function diffSnapshots(
  http: HttpClient,
  from: string,
  to: string,
): Promise<SnapshotDiffResponse> {
  try {
    const query = new URLSearchParams({ from, to });
    const res = await http.get<{
      success: boolean;
      changeStatus?: "changed" | "same";
      from?: SnapshotSummary;
      to?: SnapshotSummary;
      diff?: { text: string; json?: unknown };
      diffOmitted?: boolean;
      error?: string;
    }>(`/v2/snapshots/diff?${query.toString()}`);
    if (
      res.status !== 200 ||
      !res.data?.success ||
      !res.data.changeStatus ||
      !res.data.from ||
      !res.data.to
    ) {
      throwForBadResponse(res as any, "diff snapshots");
    }
    return {
      changeStatus: res.data.changeStatus,
      from: res.data.from,
      to: res.data.to,
      ...(res.data.diff ? { diff: res.data.diff } : {}),
      ...(res.data.diffOmitted ? { diffOmitted: res.data.diffOmitted } : {}),
    };
  } catch (err: any) {
    if (err?.isAxiosError) return normalizeAxiosError(err, "diff snapshots");
    throw err;
  }
}
