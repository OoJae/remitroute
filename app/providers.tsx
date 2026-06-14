"use client";

import type { ReactNode } from "react";
import { WagmiProvider, createConfig, http } from "wagmi";
import { celo } from "wagmi/chains";
import { injected } from "wagmi/connectors";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// MiniPay injects an EIP-1193 provider. We target it through the injected
// connector with the metaMask target, which is the MiniPay-recommended pattern.
export const wagmiConfig = createConfig({
  chains: [celo],
  connectors: [injected({ target: "metaMask" })],
  transports: {
    [celo.id]: http(),
  },
});

const queryClient = new QueryClient();

export function Providers({ children }: { children: ReactNode }) {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
