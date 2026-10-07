import type { OperatorOverview, OperatorOverviewView } from "@paperclipai/shared";
import { api } from "./client";

export const operatorOverviewApi = {
  get: (companyId: string, view: OperatorOverviewView, offset: number, signal?: AbortSignal) =>
    api.get<OperatorOverview>(`/companies/${encodeURIComponent(companyId)}/operator-overview?view=${view}&limit=50&offset=${offset}`, {
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    }),
};
