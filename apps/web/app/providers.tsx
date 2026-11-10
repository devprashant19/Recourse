"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            refetchInterval: 3000,
            retry: 1,
            staleTime: 1000,
          },
        },
      })
  );

  useEffect(() => {
    // Mode switch isolation: clearing the query client cache prevents
    // synthetic demo fixtures from leaking into live mode or vice-versa.
    const handleModeChange = () => {
      client.clear();
    };

    window.addEventListener("recourse-data-mode-change", handleModeChange);
    return () => {
      window.removeEventListener("recourse-data-mode-change", handleModeChange);
    };
  }, [client]);

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
