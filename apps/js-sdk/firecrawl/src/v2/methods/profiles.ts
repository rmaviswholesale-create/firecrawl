import type { LocalProfileSummary } from "../types";
import { HttpClient } from "../utils/httpClient";
import {
  normalizeAxiosError,
  throwForBadResponse,
} from "../utils/errorHandler";

export async function listProfiles(
  http: HttpClient,
): Promise<LocalProfileSummary[]> {
  try {
    const res = await http.get<{
      success: boolean;
      profiles?: LocalProfileSummary[];
      error?: string;
    }>("/v2/profiles");
    if (res.status !== 200 || !res.data?.success || !res.data.profiles) {
      throwForBadResponse(res as any, "list profiles");
    }
    return res.data.profiles;
  } catch (err: any) {
    if (err?.isAxiosError) return normalizeAxiosError(err, "list profiles");
    throw err;
  }
}

export async function getProfile(
  http: HttpClient,
  name: string,
): Promise<LocalProfileSummary> {
  try {
    const res = await http.get<{
      success: boolean;
      profile?: LocalProfileSummary;
      error?: string;
    }>(`/v2/profiles/${encodeURIComponent(name)}`);
    if (res.status !== 200 || !res.data?.success || !res.data.profile) {
      throwForBadResponse(res as any, "get profile");
    }
    return res.data.profile;
  } catch (err: any) {
    if (err?.isAxiosError) return normalizeAxiosError(err, "get profile");
    throw err;
  }
}

export async function deleteProfile(
  http: HttpClient,
  name: string,
): Promise<{ success: boolean }> {
  try {
    const res = await http.delete<{ success: boolean; error?: string }>(
      `/v2/profiles/${encodeURIComponent(name)}`,
    );
    if (res.status !== 200 || !res.data?.success) {
      throwForBadResponse(res as any, "delete profile");
    }
    return { success: true };
  } catch (err: any) {
    if (err?.isAxiosError) return normalizeAxiosError(err, "delete profile");
    throw err;
  }
}
