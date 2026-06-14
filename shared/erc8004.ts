// ERC-8004 registries: network-aware viem clients (Celo mainnet or Sepolia),
// the registry addresses per network, and the minimal Identity + Reputation
// ABIs. This is separate from the mainnet money clients in shared/viem.ts so the
// money engine stays on mainnet while registration is validated on Sepolia.
import {
  createPublicClient,
  createWalletClient,
  fallback,
  http,
} from "viem";
import { celo, celoSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "./config.js";
import { feeCurrencyAdapter } from "./feeCurrency.js";
import type { Hex } from "./addresses.js";

export type Erc8004Network = "mainnet" | "sepolia";

// Verified registry addresses. Source: hackathon docs + erc-8004 contracts.
const REGISTRIES = {
  mainnet: {
    identity: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" as Hex,
    reputation: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63" as Hex,
  },
  sepolia: {
    identity: "0x8004A818BFB912233c491871b3d84c89A494BD9e" as Hex,
    reputation: "0x8004B663056A597Dffe9eCcC1965A193B7388713" as Hex,
  },
} as const;

const network: Erc8004Network = config.ERC8004_NETWORK;
const chain = network === "mainnet" ? celo : celoSepolia;
const rpc = network === "mainnet" ? config.ERC8004_RPC : config.ERC8004_RPC_SEPOLIA;

export const erc8004Network = network;
export const erc8004Chain = chain;
export const registries = REGISTRIES[network];

// Gas: pay in stablecoin on mainnet, native CELO on the testnet (fee-currency
// adapters are mainnet addresses). Scripts spread this into writeContract.
export function erc8004FeeOpts(): { feeCurrency?: Hex } {
  return network === "mainnet" ? { feeCurrency: feeCurrencyAdapter() } : {};
}

const transport = fallback([http(rpc), http()]);

export const erc8004PublicClient = createPublicClient({ chain, transport });

export function erc8004WalletFor(privateKey: Hex) {
  const account = privateKeyToAccount(privateKey);
  return createWalletClient({ account, chain, transport });
}

// Minimal Identity Registry ABI: register, read-backs, and the Registered event.
export const identityRegistryAbi = [
  {
    type: "function",
    name: "register",
    stateMutability: "nonpayable",
    inputs: [{ name: "agentURI", type: "string" }],
    outputs: [{ name: "agentId", type: "uint256" }],
  },
  {
    type: "function",
    name: "tokenURI",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ type: "string" }],
  },
  {
    type: "function",
    name: "setAgentURI",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "newURI", type: "string" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getAgentWallet",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ type: "address" }],
  },
  {
    type: "event",
    name: "Registered",
    inputs: [
      { name: "agentId", type: "uint256", indexed: true },
      { name: "agentURI", type: "string", indexed: false },
      { name: "owner", type: "address", indexed: true },
    ],
  },
] as const;

// Minimal Reputation Registry ABI: giveFeedback, getSummary, NewFeedback event.
export const reputationRegistryAbi = [
  {
    type: "function",
    name: "giveFeedback",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "value", type: "int128" },
      { name: "valueDecimals", type: "uint8" },
      { name: "tag1", type: "string" },
      { name: "tag2", type: "string" },
      { name: "endpoint", type: "string" },
      { name: "feedbackURI", type: "string" },
      { name: "feedbackHash", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getSummary",
    stateMutability: "view",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "clientAddresses", type: "address[]" },
      { name: "tag1", type: "string" },
      { name: "tag2", type: "string" },
    ],
    outputs: [
      { name: "count", type: "uint64" },
      { name: "summaryValue", type: "int128" },
      { name: "summaryValueDecimals", type: "uint8" },
    ],
  },
] as const;

export const ZERO_HASH = ("0x" + "0".repeat(64)) as Hex;
