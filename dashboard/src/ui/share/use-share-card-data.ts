import { useMemo } from "react";
import {
  buildShareCardData,
  type ShareCardData,
  type ShareCardModel,
  type ShareCardPeriod,
} from "./build-share-card-data";

interface UseShareCardDataParams {
  enabled: boolean;
  handle: string;
  startDate: string | null;
  activeDays: number;
  summary: any;
  topModels: ShareCardModel[] | null | undefined;
  period: ShareCardPeriod;
  periodFrom: string | null;
  periodTo: string | null;
  heatmap: any;
  currency?: string;
  exchangeRate?: number;
}

export function useShareCardData(params: UseShareCardDataParams): ShareCardData {
  const {
    handle,
    startDate,
    activeDays,
    summary,
    topModels,
    period,
    periodFrom,
    periodTo,
    heatmap,
    currency,
    exchangeRate,
  } = params;

  // Local-only build: there is no leaderboard, so the card never carries a rank.
  const rank = null;

  return useMemo(
    () =>
      buildShareCardData({
        handle,
        startDate,
        activeDays,
        summary,
        topModels,
        rank,
        period,
        periodFrom,
        periodTo,
        heatmap,
        currency,
        exchangeRate: typeof exchangeRate === "number" ? exchangeRate : undefined,
      }),
    [
      handle,
      startDate,
      activeDays,
      summary,
      topModels,
      period,
      periodFrom,
      periodTo,
      heatmap,
      currency,
      exchangeRate,
    ],
  );
}
