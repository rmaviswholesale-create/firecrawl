import type {
  CreateWatchRequest,
  UpdateWatchRequest,
  Watch,
  WatchRun,
} from "../types";
import { HttpClient } from "../utils/httpClient";
import {
  normalizeAxiosError,
  throwForBadResponse,
} from "../utils/errorHandler";

export async function createWatch(
  http: HttpClient,
  request: CreateWatchRequest,
): Promise<Watch> {
  try {
    const res = await http.post<{ success: boolean; watch?: Watch; error?: string }>(
      "/v2/watch",
      request as any,
    );
    if (res.status !== 200 || !res.data?.success || !res.data.watch) {
      throwForBadResponse(res as any, "create watch");
    }
    return res.data.watch;
  } catch (err: any) {
    if (err?.isAxiosError) return normalizeAxiosError(err, "create watch");
    throw err;
  }
}

export async function listWatches(http: HttpClient): Promise<Watch[]> {
  try {
    const res = await http.get<{ success: boolean; watches?: Watch[]; error?: string }>(
      "/v2/watch",
    );
    if (res.status !== 200 || !res.data?.success || !res.data.watches) {
      throwForBadResponse(res as any, "list watches");
    }
    return res.data.watches;
  } catch (err: any) {
    if (err?.isAxiosError) return normalizeAxiosError(err, "list watches");
    throw err;
  }
}

export async function getWatch(
  http: HttpClient,
  watchId: string,
): Promise<Watch> {
  try {
    const res = await http.get<{ success: boolean; watch?: Watch; error?: string }>(
      `/v2/watch/${encodeURIComponent(watchId)}`,
    );
    if (res.status !== 200 || !res.data?.success || !res.data.watch) {
      throwForBadResponse(res as any, "get watch");
    }
    return res.data.watch;
  } catch (err: any) {
    if (err?.isAxiosError) return normalizeAxiosError(err, "get watch");
    throw err;
  }
}

export async function updateWatch(
  http: HttpClient,
  watchId: string,
  request: UpdateWatchRequest,
): Promise<Watch> {
  try {
    const res = await http.patch<{ success: boolean; watch?: Watch; error?: string }>(
      `/v2/watch/${encodeURIComponent(watchId)}`,
      request as any,
    );
    if (res.status !== 200 || !res.data?.success || !res.data.watch) {
      throwForBadResponse(res as any, "update watch");
    }
    return res.data.watch;
  } catch (err: any) {
    if (err?.isAxiosError) return normalizeAxiosError(err, "update watch");
    throw err;
  }
}

export async function deleteWatch(
  http: HttpClient,
  watchId: string,
): Promise<{ success: boolean }> {
  try {
    const res = await http.delete<{ success: boolean; error?: string }>(
      `/v2/watch/${encodeURIComponent(watchId)}`,
    );
    if (res.status !== 200 || !res.data?.success) {
      throwForBadResponse(res as any, "delete watch");
    }
    return { success: true };
  } catch (err: any) {
    if (err?.isAxiosError) return normalizeAxiosError(err, "delete watch");
    throw err;
  }
}

export async function runWatch(
  http: HttpClient,
  watchId: string,
): Promise<WatchRun> {
  try {
    const res = await http.post<{ success: boolean; run?: WatchRun; error?: string }>(
      `/v2/watch/${encodeURIComponent(watchId)}/run`,
      {},
    );
    if (res.status !== 200 || !res.data?.success || !res.data.run) {
      throwForBadResponse(res as any, "run watch");
    }
    return res.data.run;
  } catch (err: any) {
    if (err?.isAxiosError) return normalizeAxiosError(err, "run watch");
    throw err;
  }
}

export async function listWatchRuns(
  http: HttpClient,
  watchId: string,
  limit?: number,
): Promise<WatchRun[]> {
  try {
    const query = limit !== undefined ? `?limit=${encodeURIComponent(String(limit))}` : "";
    const res = await http.get<{ success: boolean; runs?: WatchRun[]; error?: string }>(
      `/v2/watch/${encodeURIComponent(watchId)}/runs${query}`,
    );
    if (res.status !== 200 || !res.data?.success || !res.data.runs) {
      throwForBadResponse(res as any, "list watch runs");
    }
    return res.data.runs;
  } catch (err: any) {
    if (err?.isAxiosError) return normalizeAxiosError(err, "list watch runs");
    throw err;
  }
}
