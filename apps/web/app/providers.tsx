"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { refetchInterval: 3000, retry: 1, staleTime: 1000 } } }));
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
