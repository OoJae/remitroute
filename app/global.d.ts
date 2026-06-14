// MiniPay injects an EIP-1193 provider flagged with isMiniPay.
interface MiniPayEthereumProvider {
  isMiniPay?: boolean;
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
}

interface Window {
  ethereum?: MiniPayEthereumProvider;
}
