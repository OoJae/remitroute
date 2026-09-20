# Wallets RemitRoute controls

Every address below is controlled by this project. We publish the full list because
the submission form caps its `otherWallets` field at 500 characters, which is not
enough room for all of them, and because an undeclared wallet that looks
project-controlled is treated as a farming signal at audit. Nothing here is hidden.

Network: Celo mainnet (chainId 42220).

## Operating wallets (3)

| Address | Role |
|---|---|
| `0x2b61FbdefEf22aBCc39645732a19842885f37F1c` | Owner / agent wallet. This is the registered `agentWalletAddress`. |
| `0x7111d20FcF6bd84E398Ab7940Ce5a97981432954` | Monitoring wallet. Also appears as a user row in our database, because it was used to exercise the onboarding flow end to end. It is ours, not a user. |
| `0x63712F0f0A8dbC11f95e31399b9C9a224eE36BEB` | Basket wallet, used by the retired FX basket loop. |

## Per-user custodial execution wallets (23)

RemitRoute is custodial by design: each user gets an execution wallet whose key we
hold, AES-256-GCM encrypted at rest, so the agent can run their rule on a heartbeat
without asking them to sign. That means **we control these keys**, and they are
declared here on that basis even though the funds in them belong to users.

```
0x913cE7AD392c49ce517060EE64e85645C686f855
0x30E6EF53593253854C2A31b3b8956174FE54a803
0x276c0439d4BcE46d91A66D18f388e14Eb685aF6d
0x35AD620349C0bB02F92326d55a6dECD6d737E938
0x35D067E04E0d4c3A07B550D42A5C87543228D1d1
0x510B4D61D09704aC64DF318411579e727106bfb0
0x2fB16D827D121Ff8de79cE15741b8c7e4BBb00F1
0x8B71e56A150F372da9e151Ad127b5f1f5e19B006
0xaf6cF267Edcc838aeF9C47004596a741FF99C3A1
0xAF385500Bd209Ad76F881ffbC0FF6575774caE74
0xd9F07d3928355B368F2F92B5E96704B064b48AC7
0x689A9A6C9c7fdb062F4117DB437C68B279afad90
0xb5BF321A9aaE703E99567ffcAF3265C759a8174C
0x5e2F7d4886aAE74F6c6bf63dCFFCa66855a773D9
0x02D204751105b51F41148749545CFDA9c5cbF6e1
0x9483bfD50E8a9Ead99B6E4706c770071f840C436
0xFC7153d22Cc30232d5BcCE0E6E1Cbbe4aC926c3E
0x503a3D996bB374B61bCa325A037fa5BF403dd3D4
0xd6e99D10B18534f608D3138D5b88512d84c57454
0x6775BdC4063C45Ef49de94202ec6fb7f17541827
0xcAC3C564Fcdff018A4Ba90A678825037901ACB9b
0x336B744765Ecd6446F7A5c5a8b2627909716F5D5
0x62237D0316abC974A2A65E71a38110467209f217
```

Twelve of these (the block created 2026-07-16) were provisioned in bulk by a fleet
script during a previous hackathon and have no human behind them. They share a
single funder, which makes them trivially clusterable, and **we exclude them from
any claim we make in any track**. The script that created them was deleted from
HEAD in commit `9ae78d9` rather than quietly left in place.

## Wallets that are not ours

People who use the Mini App send from their own MiniPay wallets. We do not hold those
keys, we cannot move funds from them, and they are not listed above. Declaring them as
wallets we control would be untrue. They do appear on-chain carrying our attribution
tag, because the app tags the calldata of transactions the user signs so that a transfer
made through RemitRoute is attributable to RemitRoute.

The first of those senders are friends and family of the team, trying the product in the
last days before the deadline. We are naming that rather than leaving it to be
discovered. They are real transfers of the sender's own money to a recipient of their
choosing, we take no fee, we never custody it, and we are not funding those wallets to
manufacture volume. Several of them hold balances in a narrow band and two share a
funder, which a clustering pass will notice; we would rather point at it than have it
found. If a judge would prefer to discount volume originating from a cluster that close
to the team, discount it. We would rather this track's number be small and clean than
large and questioned.

## What we did not deploy

We have deployed no contracts of our own. Every contract we touch is third-party:
the ERC-8004 Identity and Reputation registries (we are agent #9308), the Mento
broker, the Aave V3 pool, and the Celo stablecoin and fee-currency adapter contracts.

## What moved, and when

**From the wallets listed above: nothing.** The heartbeat engine has run continuously
through the judging window. Between 28 August and 20 September it attempted 166
scheduled actions and executed none of them: every attempt returned
`skipped_low_balance` or `skipped_dust`, and not one carries a transaction hash. The
custodial wallets are empty, so there was nothing to move. That figure is a query over
our `executions` table, which records every action our own keys signed, and it is the
complete picture for every address on this page.

**From wallets we do not control: we cannot count it, so we do not.** The Mini App also
lets a person send straight from their own MiniPay wallet. Those wallets are not ours
and are not listed above. We never touch the money, and we write nothing to our database
when it happens, so none of it is in the 166 figure. It does carry our ERC-8021 tag,
deliberately, so that a transfer a user makes through our app is attributable to us,
which also means it is visible on-chain and countable by anyone reading the tag.

We therefore quote no total for tagged volume in either direction. The number for the
Value Moved track is whatever the chain says for `celo_716fa1c99481`. It is not a number
we are in a position to assert.
