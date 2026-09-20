// Every wallet this project controls, in one place, so code can refuse to treat
// one as an arm's-length counterparty.
//
// This exists because of a specific hazard in the Mini App: the automation
// wallet address is rendered as a copyable block directly above a send box
// whose placeholder invites you to paste a wallet address. Sending there is not
// a payment, it is a transfer to ourselves, and the leaderboard excludes it.
// Without this list the UI would report that transfer as a complete success.
//
// Client-safe on purpose: no config, no dotenv, no database. It is duplicated
// from WALLETS.md, which is the human-readable declaration, and test coverage
// keeps the two in step.
export type Hex = `0x${string}`;

// The three standing operating wallets.
const OPERATING: Hex[] = [
  "0x2b61FbdefEf22aBCc39645732a19842885f37F1c", // owner / agent, the registered agentWalletAddress
  "0x7111d20FcF6bd84E398Ab7940Ce5a97981432954", // monitoring
  "0x63712F0f0A8dbC11f95e31399b9C9a224eE36BEB", // basket loop (retired)
];

// Per-user custodial execution wallets. We hold these keys, so they are ours
// for counterparty purposes even though the funds in them belong to users.
const CUSTODIAL: Hex[] = [
  "0x913cE7AD392c49ce517060EE64e85645C686f855",
  "0x30E6EF53593253854C2A31b3b8956174FE54a803",
  "0x276c0439d4BcE46d91A66D18f388e14Eb685aF6d",
  "0x35AD620349C0bB02F92326d55a6dECD6d737E938",
  "0x35D067E04E0d4c3A07B550D42A5C87543228D1d1",
  "0x510B4D61D09704aC64DF318411579e727106bfb0",
  "0x2fB16D827D121Ff8de79cE15741b8c7e4BBb00F1",
  "0x8B71e56A150F372da9e151Ad127b5f1f5e19B006",
  "0xaf6cF267Edcc838aeF9C47004596a741FF99C3A1",
  "0xAF385500Bd209Ad76F881ffbC0FF6575774caE74",
  "0xd9F07d3928355B368F2F92B5E96704B064b48AC7",
  "0x689A9A6C9c7fdb062F4117DB437C68B279afad90",
  "0xb5BF321A9aaE703E99567ffcAF3265C759a8174C",
  "0x5e2F7d4886aAE74F6c6bf63dCFFCa66855a773D9",
  "0x02D204751105b51F41148749545CFDA9c5cbF6e1",
  "0x9483bfD50E8a9Ead99B6E4706c770071f840C436",
  "0xFC7153d22Cc30232d5BcCE0E6E1Cbbe4aC926c3E",
  "0x503a3D996bB374B61bCa325A037fa5BF403dd3D4",
  "0xd6e99D10B18534f608D3138D5b88512d84c57454",
  "0x6775BdC4063C45Ef49de94202ec6fb7f17541827",
  "0xcAC3C564Fcdff018A4Ba90A678825037901ACB9b",
  "0x336B744765Ecd6446F7A5c5a8b2627909716F5D5",
  "0x62237D0316abC974A2A65E71a38110467209f217",
];

export const PROJECT_WALLETS: readonly Hex[] = [...OPERATING, ...CUSTODIAL];

const LOOKUP = new Set(PROJECT_WALLETS.map((a) => a.toLowerCase()));

// True when this address is one of ours. Case-insensitive, because addresses
// arrive from pasted text, phone lookups and RPC responses in mixed casing.
export function isProjectWallet(address: string): boolean {
  return LOOKUP.has(address.trim().toLowerCase());
}
