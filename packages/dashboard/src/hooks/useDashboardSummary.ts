import { useCallback, useEffect, useState } from "react";
import { getDashboardSummary, type DashboardSummaryResponse } from "../api/dashboard.js";

export function useDashboardSummary() {
  const [summary, setSummary] = useState<DashboardSummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const payload = await getDashboardSummary();
      setSummary(payload);
      return payload;
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to load workspace summary");
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    summary,
    loading,
    error,
    refresh,
    setSummary
  };
}
