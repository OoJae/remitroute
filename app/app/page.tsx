"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toHex } from "viem";
import { useAccount, useConnect } from "wagmi";
import { encodeFunctionData, erc20Abi, parseUnits } from "viem";

interface AgentInfo {
  agentId: string | null;
  reputationRegistry: `0x${string}`;
  chainId: number;
}

// cUSD on Celo mainnet. Kept in sync with shared/addresses.ts.
const CUSD = "0x765DE816845861e75A25fCA122bb6898B8B1282a" as const;

const ZERO_HASH = `0x${"0".repeat(64)}` as const;

// Tokens the user can hold in the automation wallet and withdraw.
const WITHDRAW_TOKENS = ["cUSD", "USDC", "cEUR"] as const;

// Minimal Reputation Registry ABI for client-side giveFeedback.
const reputationAbi = [
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
] as const;

interface OnboardResult {
  userId: string;
  executionWallet: string;
  city: string | null;
  displayName: string | null;
  telegramLinked?: boolean;
}

interface ExecutionItem {
  id: string;
  kind: string;
  status: string;
  amountIn: string | null;
  tokenIn: string | null;
  txHash: string | null;
  createdAt: string;
}

interface ParsedRule {
  kind: string;
  params: Record<string, unknown>;
  cadence: string;
  nextRun: string;
  summary: string;
  needsRecipientResolution: boolean;
  warnings: string[];
}

interface TokenBalance {
  symbol: string;
  address: string;
  decimals: number;
  amount: string;
  usd?: number;
}

interface YieldPosition {
  symbol: string;
  supplied: string;
  apyPct: number;
  earned: number;
  usd: number;
}

interface ScheduleItem {
  id: string;
  kind: string;
  cadence: string;
  params: Record<string, unknown>;
  nextRun: string;
  status: string;
}

interface GoalItem {
  id: string;
  name: string;
  asset: string;
  targetUsd: number;
  progressUsd: number;
  reached?: boolean;
  lockUntil: string | null;
  status: string;
}

// Poll the injected provider for a receipt so the UI only shows success once the
// transaction is actually confirmed (status 0x1), never optimistically on the
// hash. Returns null if it does not confirm within the window.
async function waitForReceipt(
  eth: { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> },
  txHash: string,
  tries = 24,
): Promise<boolean | null> {
  for (let i = 0; i < tries; i += 1) {
    try {
      const r = (await eth.request({
        method: "eth_getTransactionReceipt",
        params: [txHash],
      })) as { status?: string } | null;
      if (r) return r.status === "0x1";
    } catch {
      /* transient; retry */
    }
    await new Promise((res) => setTimeout(res, 2500));
  }
  return null;
}

export default function Home() {
  const { connect, connectors } = useConnect();
  const { address, isConnected } = useAccount();
  const [isMiniPay, setIsMiniPay] = useState(false);
  const [onboard, setOnboard] = useState<OnboardResult | null>(null);
  const [fundAmount, setFundAmount] = useState("1");
  const [status, setStatus] = useState<string>("");
  const [activity, setActivity] = useState<ExecutionItem[]>([]);
  const [ruleText, setRuleText] = useState("");
  const [parsedRule, setParsedRule] = useState<ParsedRule | null>(null);
  const [recipientAddr, setRecipientAddr] = useState("");
  const [ruleStatus, setRuleStatus] = useState("");
  const [agentInfo, setAgentInfo] = useState<AgentInfo | null>(null);
  const [rateStatus, setRateStatus] = useState("");

  // Phase 9 state.
  const [balances, setBalances] = useState<TokenBalance[]>([]);
  const [yieldPositions, setYieldPositions] = useState<YieldPosition[]>([]);
  const [totalUsd, setTotalUsd] = useState<number | null>(null);
  const [tgLinked, setTgLinked] = useState(false);
  const [tgStatus, setTgStatus] = useState("");
  const [goalsList, setGoalsList] = useState<GoalItem[]>([]);
  const [goalName, setGoalName] = useState("");
  const [goalTarget, setGoalTarget] = useState("");
  const [goalLockDays, setGoalLockDays] = useState("");
  const [goalStatus, setGoalStatus] = useState("");
  const [recipientPhone, setRecipientPhone] = useState("");
  const [resolvedAddr, setResolvedAddr] = useState("");
  const [resolveStatus, setResolveStatus] = useState("");
  const [withdrawToken, setWithdrawToken] = useState<string>("cUSD");
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [withdrawStatus, setWithdrawStatus] = useState("");
  const [city, setCity] = useState("");
  const [country, setCountry] = useState("");
  const [profileSaved, setProfileSaved] = useState(false);
  const [profileStatus, setProfileStatus] = useState("");
  const [rules, setRules] = useState<ScheduleItem[]>([]);
  const [rulesStatus, setRulesStatus] = useState("");
  const [now, setNow] = useState(() => Date.now());

  // Detect MiniPay and auto-connect with no connect button.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.ethereum?.isMiniPay) {
      setIsMiniPay(true);
      const injectedConnector = connectors.find((c) => c.type === "injected");
      if (injectedConnector) connect({ connector: injectedConnector });
    }
  }, [connect, connectors]);

  // Once connected, sign in: fetch a nonce, sign it in MiniPay (personal_sign,
  // no gas), and exchange it for an HttpOnly session cookie. The same call
  // creates the user + execution wallet on first sign-in. After this the cookie
  // authenticates every request, so no userId is ever sent by the client.
  // The in-flight ref stops the effect double-firing from opening two
  // concurrent sign prompts (MiniPay rejects both); the message is sent to
  // personal_sign hex-encoded, the canonical EIP-191 param form (same signed
  // bytes, so server verification is unchanged).
  const signingRef = useRef(false);
  const signIn = useCallback(async () => {
    if (typeof window === "undefined" || !window.ethereum || !address) return;
    if (signingRef.current) return;
    signingRef.current = true;
    const eth = window.ethereum;
    try {
      setStatus("Signing you in...");
      const nonceRes = await fetch("/api/auth/nonce", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ minipayAddress: address }),
      });
      if (!nonceRes.ok) {
        setStatus("Could not start sign-in. Please try again.");
        return;
      }
      const { nonce, message } = (await nonceRes.json()) as { nonce: string; message: string };
      const signature = (await eth.request({
        method: "personal_sign",
        params: [toHex(message), address],
      })) as string;
      const verifyRes = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ minipayAddress: address, nonce, signature }),
      });
      if (verifyRes.ok) {
        setOnboard((await verifyRes.json()) as OnboardResult);
        setStatus("");
      } else {
        setStatus("Sign-in failed. Please try again.");
      }
    } catch (err) {
      const m = ((err as Error)?.message ?? "").toLowerCase();
      setStatus(m.includes("denied") || m.includes("rejected") ? "Sign-in cancelled." : "Could not sign in.");
    } finally {
      signingRef.current = false;
    }
  }, [address]);

  useEffect(() => {
    if (!isConnected || !address || onboard) return;
    void signIn();
  }, [isConnected, address, onboard, signIn]);

  // When the connected MiniPay wallet changes (the user switches accounts),
  // drop all per-user state so nothing from the previous account leaks into the
  // new one. Clearing onboard re-triggers the onboard effect above for the new
  // address, which reloads that account's own rules, activity, and balances.
  useEffect(() => {
    setOnboard(null);
    setActivity([]);
    setRules([]);
    setBalances([]);
    setYieldPositions([]);
    setTotalUsd(null);
    setTgLinked(false);
    setTgStatus("");
    setGoalsList([]);
    setGoalName("");
    setGoalTarget("");
    setGoalLockDays("");
    setGoalStatus("");
    setCity("");
    setCountry("");
    setProfileSaved(false);
    setRuleText("");
    setParsedRule(null);
    setRecipientAddr("");
    setRecipientPhone("");
    setResolvedAddr("");
    setResolveStatus("");
    setStatus("");
    setRuleStatus("");
    setWithdrawStatus("");
    setProfileStatus("");
    setRulesStatus("");
  }, [address]);

  // The session cookie identifies the user; no userId is put in the URL. The
  // optional AbortSignal lets a load be cancelled when the account switches, so a
  // slow response for the previous account can never overwrite the new one.
  const loadActivity = useCallback(async (signal?: AbortSignal) => {
    const res = await fetch("/api/executions", { signal });
    if (res.ok) setActivity(((await res.json()) as { items: ExecutionItem[] }).items);
  }, []);

  const loadBalances = useCallback(async (signal?: AbortSignal) => {
    const res = await fetch("/api/balance", { signal });
    if (res.ok) {
      const json = (await res.json()) as {
        balances: TokenBalance[];
        yield?: YieldPosition[];
        totalUsd?: number;
      };
      setBalances(json.balances);
      setYieldPositions(json.yield ?? []);
      setTotalUsd(typeof json.totalUsd === "number" ? json.totalUsd : null);
    }
  }, []);

  const loadRules = useCallback(async (signal?: AbortSignal) => {
    const res = await fetch("/api/schedules", { signal });
    if (res.ok) setRules(((await res.json()) as { items: ScheduleItem[] }).items);
  }, []);

  const loadGoals = useCallback(async (signal?: AbortSignal) => {
    const res = await fetch("/api/goals", { signal });
    if (res.ok) setGoalsList(((await res.json()) as { items: GoalItem[] }).items);
  }, []);

  useEffect(() => {
    if (!onboard) return;
    const ctrl = new AbortController();
    void loadActivity(ctrl.signal).catch(() => {});
    void loadBalances(ctrl.signal).catch(() => {});
    void loadRules(ctrl.signal).catch(() => {});
    void loadGoals(ctrl.signal).catch(() => {});
    return () => ctrl.abort();
  }, [onboard, loadActivity, loadBalances, loadRules, loadGoals]);

  // Tick once a second so the Next Execution countdown stays live.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Load the registered agent id (if any) so the Rate control can appear.
  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/agent-info");
      if (res.ok) setAgentInfo((await res.json()) as AgentInfo);
    })();
  }, []);

  // One-time funding transfer. The user signs a cUSD transfer in MiniPay native
  // UI. Legacy transaction with feeCurrency set so gas is paid in cUSD.
  const fund = useCallback(async () => {
    if (!onboard || !address || typeof window === "undefined" || !window.ethereum) return;
    const eth = window.ethereum;
    // Validate the amount before prompting a signature (no NaN/<=0; cUSD is 18dp).
    const amt = Number(fundAmount);
    if (!Number.isFinite(amt) || amt <= 0) {
      setStatus("Enter a positive amount to fund.");
      return;
    }
    if ((fundAmount.split(".")[1] ?? "").length > 18) {
      setStatus("Too many decimal places.");
      return;
    }
    try {
      setStatus("Requesting signature in MiniPay...");
      const data = encodeFunctionData({
        abi: erc20Abi,
        functionName: "transfer",
        args: [onboard.executionWallet as `0x${string}`, parseUnits(fundAmount, 18)],
      });
      const txHash = (await eth.request({
        method: "eth_sendTransaction",
        params: [
          {
            from: address,
            to: CUSD,
            data,
            // Gas paid in cUSD via fee abstraction.
            feeCurrency: CUSD,
          },
        ],
      })) as string;
      // Only report success once the receipt confirms, never on the hash alone.
      setStatus("Confirming your funding transaction...");
      const ok = await waitForReceipt(eth, txHash);
      setStatus(
        ok === true
          ? `Funded. Transaction ${txHash.slice(0, 10)}...`
          : ok === false
            ? "The funding transaction reverted. Please try again."
            : `Submitted ${txHash.slice(0, 10)}... It is taking a while to confirm; your balance will update shortly.`,
      );
      void loadBalances();
    } catch (err) {
      const m = ((err as Error)?.message ?? "").toLowerCase();
      if (m.includes("exceeds balance") || m.includes("insufficient")) {
        setStatus("You do not have enough cUSD in your MiniPay wallet. Add cUSD, then try again.");
      } else if (m.includes("denied") || m.includes("rejected")) {
        setStatus("Funding cancelled.");
      } else {
        setStatus("Could not fund the wallet. Please try again.");
      }
    }
  }, [onboard, address, fundAmount, loadBalances]);

  // Withdraw everything. Sends the "max" sentinel so the server computes the
  // exact gas reserve (gas for a cUSD withdraw is pre-debited from the balance).
  const setMax = useCallback(() => {
    setWithdrawAmount("max");
  }, []);

  // Withdraw funds from the automation wallet back to the connected MiniPay
  // address. The server forces the destination to the user's own address.
  const doWithdraw = useCallback(async () => {
    if (!onboard) return;
    if (withdrawAmount !== "max" && !(Number(withdrawAmount) > 0)) {
      setWithdrawStatus("Enter an amount to withdraw.");
      return;
    }
    setWithdrawStatus("Sending funds back to your MiniPay wallet...");
    const res = await fetch("/api/withdraw", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: withdrawToken, amount: withdrawAmount }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      status?: string;
      txHash?: string;
      error?: string;
    };
    if (res.ok && (body.status === "confirmed" || body.status === "dry_run")) {
      setWithdrawStatus(
        body.status === "dry_run"
          ? "Withdraw simulated (WITHDRAW_LIVE is off)."
          : `Withdrawn. Transaction ${body.txHash?.slice(0, 10)}...`,
      );
      setWithdrawAmount("");
      void loadBalances();
      void loadActivity();
    } else if (body.status === "skipped_empty") {
      setWithdrawStatus("Your automation wallet is empty, nothing to withdraw.");
    } else if (body.status === "reverted") {
      setWithdrawStatus("The withdrawal reverted onchain. Please try again.");
    } else if (body.status === "broadcast_unknown") {
      // The tx was submitted but not yet confirmed. It may still land, so do NOT
      // prompt a resubmit (that would risk a double withdrawal).
      setWithdrawStatus("Your withdrawal was submitted and is still confirming. Please do not resubmit; check Activity in a moment.");
      void loadBalances();
      void loadActivity();
    } else {
      setWithdrawStatus(body.error ?? "Could not withdraw. Please try again.");
    }
  }, [onboard, withdrawToken, withdrawAmount, loadBalances, loadActivity]);

  // Save the user's city/country once during onboarding.
  const saveProfile = useCallback(async () => {
    if (!onboard || city.trim().length < 2) {
      setProfileStatus("Enter your city to continue.");
      return;
    }
    setProfileStatus("Saving...");
    const res = await fetch("/api/profile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ city: city.trim(), country: country.trim() }),
    });
    if (res.ok) {
      setProfileSaved(true);
      setProfileStatus("");
    } else {
      setProfileStatus("Could not save your location.");
    }
  }, [onboard, city, country]);

  // Open the Telegram deep link that binds this account to the user's chat.
  // The bot confirms inside Telegram; we poll the link endpoint briefly so the
  // card can flip to Connected without a re-login.
  const connectTelegram = useCallback(async () => {
    setTgStatus("Preparing your link...");
    try {
      const res = await fetch("/api/telegram/link", { method: "POST" });
      const json = (await res.json()) as { deepLink?: string; linked?: boolean; error?: string };
      if (!res.ok || !json.deepLink) {
        setTgStatus(json.error ?? "Telegram receipts are not available right now.");
        return;
      }
      window.open(json.deepLink, "_blank", "noopener");
      setTgStatus("Tap Start in Telegram to finish connecting.");
      for (const delayMs of [8000, 15000, 30000]) {
        await new Promise((r) => setTimeout(r, delayMs));
        const check = await fetch("/api/telegram/link", { method: "POST" });
        if (check.ok && ((await check.json()) as { linked?: boolean }).linked) {
          setTgLinked(true);
          setTgStatus("");
          return;
        }
      }
    } catch {
      setTgStatus("Could not reach the server. Try again.");
    }
  }, []);

  const createGoal = useCallback(async () => {
    if (goalName.trim().length < 2 || !(Number(goalTarget) > 0)) {
      setGoalStatus("Give the goal a name and a target amount.");
      return;
    }
    setGoalStatus("Starting your goal...");
    const res = await fetch("/api/goals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: goalName,
        targetUsd: Number(goalTarget),
        ...(goalLockDays ? { lockDays: Number(goalLockDays) } : {}),
      }),
    });
    if (res.ok) {
      setGoalName("");
      setGoalTarget("");
      setGoalLockDays("");
      setGoalStatus("");
      void loadGoals();
      void loadRules();
    } else {
      const e = (await res.json()) as { error?: string };
      setGoalStatus(e.error ?? "Could not start the goal.");
    }
  }, [goalName, goalTarget, goalLockDays, loadGoals, loadRules]);

  const cancelGoal = useCallback(
    async (id: string) => {
      if (!window.confirm("Cancel this goal? Saved funds stay in Aave until you withdraw them.")) return;
      const res = await fetch(`/api/goals/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "cancel" }),
      });
      if (res.ok) {
        void loadGoals();
        void loadRules();
      }
    },
    [loadGoals, loadRules],
  );

  const unlockGoal = useCallback(
    async (id: string) => {
      if (!window.confirm("Unlock early? The whole point of the lock was to protect this goal from moments like this.")) return;
      const res = await fetch(`/api/goals/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "unlock", confirm: true }),
      });
      if (res.ok) void loadGoals();
    },
    [loadGoals],
  );

  // Preview a plain-language rule. Shows the parsed rule for confirmation; does
  // not save until the user confirms.
  const previewRule = useCallback(async () => {
    if (!onboard || ruleText.trim().length < 3) return;
    setRuleStatus("Reading your rule...");
    setParsedRule(null);
    const res = await fetch("/api/parse-rule", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user: onboard.userId, text: ruleText }),
    });
    if (res.ok) {
      setParsedRule((await res.json()) as ParsedRule);
      setRuleStatus("");
    } else {
      const e = (await res.json()) as { error?: string };
      setRuleStatus(e.error ?? "Could not understand that rule. Try rephrasing.");
    }
  }, [onboard, ruleText]);

  // Confirm and save the parsed rule. Fills in the recipient address first when
  // the rule needs one.
  const confirmRule = useCallback(async () => {
    if (!onboard || !parsedRule) return;
    const params = { ...parsedRule.params };
    if (parsedRule.needsRecipientResolution) {
      if (!recipientAddr.startsWith("0x") || recipientAddr.length !== 42) {
        setRuleStatus("Find the recipient by phone number, or paste their wallet address.");
        return;
      }
      (params as { to?: string }).to = recipientAddr;
    }
    setRuleStatus("Saving rule...");
    const res = await fetch("/api/schedules", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: parsedRule.kind,
        params,
        cadence: parsedRule.cadence,
        nextRun: parsedRule.nextRun,
        // When the address came from a phone lookup, keep only the last 4 digits
        // as a recognizable label. Storing the full number would rebuild the
        // phone->wallet map that the SocialConnect lookup keeps private.
        ...(resolvedAddr && resolvedAddr === recipientAddr && recipientPhone
          ? { recipientLabel: "phone •••" + recipientPhone.replace(/[^0-9]/g, "").slice(-4) }
          : {}),
      }),
    });
    if (res.ok) {
      setRuleStatus("Rule saved. The agent will run it automatically.");
      setParsedRule(null);
      setRuleText("");
      setRecipientAddr("");
      setRecipientPhone("");
      setResolvedAddr("");
      setResolveStatus("");
      void loadActivity();
      void loadRules();
    } else {
      const e = (await res.json()) as { error?: string };
      setRuleStatus(e.error ?? "Could not save the rule.");
    }
  }, [onboard, parsedRule, recipientAddr, recipientPhone, resolvedAddr, loadActivity, loadRules]);

  // Look a recipient up by phone number (Celo SocialConnect via MiniPay's
  // attestations) and fill the address on success.
  const resolveRecipient = useCallback(async () => {
    if (recipientPhone.trim().length < 8) {
      setResolveStatus("Enter the number in international format, e.g. +2348012345678.");
      return;
    }
    setResolveStatus("Looking up on MiniPay...");
    const res = await fetch("/api/resolve-recipient", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: recipientPhone.trim() }),
    });
    const json = (await res.json()) as { address?: string; error?: string };
    if (res.ok && json.address) {
      setRecipientAddr(json.address);
      setResolvedAddr(json.address);
      setResolveStatus(`Found: ${json.address.slice(0, 6)}...${json.address.slice(-4)} on MiniPay.`);
    } else {
      setResolveStatus(json.error ?? "Could not look that number up.");
    }
  }, [recipientPhone]);

  // Pause/resume or delete a saved rule.
  const pauseResume = useCallback(
    async (id: string, action: "pause" | "resume") => {
      if (!onboard) return;
      setRulesStatus("");
      const res = await fetch(`/api/schedules/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (res.ok) void loadRules();
      else setRulesStatus("Could not update that rule.");
    },
    [onboard, loadRules],
  );

  const deleteRule = useCallback(
    async (id: string) => {
      if (!onboard) return;
      setRulesStatus("");
      const res = await fetch(`/api/schedules/${id}`, { method: "DELETE" });
      if (res.ok) void loadRules();
      else setRulesStatus("Could not delete that rule.");
    },
    [onboard, loadRules],
  );

  // Rate the agent on ERC-8004. The user signs giveFeedback from their MiniPay
  // wallet (a client, not the owner), then we log it.
  const rate = useCallback(
    async (score: number) => {
      if (!onboard || !address || !window.ethereum || !agentInfo?.agentId) return;
      try {
        setRateStatus("Submitting your rating in MiniPay...");
        const data = encodeFunctionData({
          abi: reputationAbi,
          functionName: "giveFeedback",
          args: [BigInt(agentInfo.agentId), BigInt(score), 0, "starred", "", "", "", ZERO_HASH],
        });
        const txHash = (await window.ethereum.request({
          method: "eth_sendTransaction",
          params: [{ from: address, to: agentInfo.reputationRegistry, data, feeCurrency: CUSD }],
        })) as string;
        await fetch("/api/feedback", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ score, tag: "starred", txHash }),
        });
        setRateStatus(`Thanks. Rating submitted: ${txHash.slice(0, 10)}...`);
      } catch (err) {
        {
          const m = ((err as Error)?.message ?? "").toLowerCase();
          setRateStatus(
            m.includes("denied") || m.includes("rejected")
              ? "Rating cancelled."
              : "Could not submit your rating. Please try again.",
          );
        }
      }
    },
    [onboard, address, agentInfo],
  );

  const needsProfile = onboard !== null && !onboard.city && !profileSaved;
  const activeRules = rules.filter((r) => r.status === "active");
  const soonest = nextDueRule(activeRules);

  return (
    <main style={{ maxWidth: 540, margin: "0 auto", padding: "20px 18px 60px" }}>
      {/* Brand header */}
      <header style={{ marginBottom: 6 }}>
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            fontFamily: MONO,
            fontSize: 12,
            color: FAINT,
            letterSpacing: "0.06em",
          }}
        >
          <span
            style={{
              width: 9,
              height: 9,
              borderRadius: "50%",
              background: GREEN,
              boxShadow: `0 0 8px ${GREEN}`,
            }}
          />
          MiniPay <span style={{ opacity: 0.4 }}>/</span> remitroute
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 14 }}>
          <RouteGlyph size={34} />
          <div
            style={{
              fontWeight: 900,
              fontSize: 30,
              letterSpacing: "-0.02em",
              textTransform: "uppercase",
            }}
          >
            REMIT<span style={{ color: GOLD }}>ROUTE</span>
          </div>
        </div>
        <p style={{ color: MUTED, marginTop: 12, lineHeight: 1.5 }}>
          Set simple money rules once. We run your savings, FX, and remittances on
          Celo automatically.
        </p>
        <a
          href="/dashboard"
          style={{ color: GOLD, fontSize: 13, fontFamily: MONO, letterSpacing: "0.06em" }}
        >
          VIEW PUBLIC DASHBOARD &#8599;
        </a>
      </header>

      {!isMiniPay && !isConnected && (
        <section
          style={{
            ...card,
            border: "1px solid rgba(233,165,60,0.4)",
            background: "rgba(233,165,60,0.06)",
          }}
        >
          <p style={{ color: GOLD, margin: 0, fontFamily: MONO, fontSize: 13, lineHeight: 1.6 }}>
            Open this app inside MiniPay to connect automatically.
          </p>
        </section>
      )}

      {isConnected && address && (
        <section style={card}>
          <div style={label}>YOUR MINIPAY WALLET</div>
          <code style={mono}>{address}</code>
          {!onboard && (
            <div style={{ marginTop: 12 }}>
              {status ? <p style={{ ...statusText, marginTop: 0 }}>{status}</p> : null}
              {status && !status.includes("Signing") && (
                <button onClick={() => void signIn()} style={{ ...buttonGhost, marginTop: 8 }}>
                  Try sign-in again
                </button>
              )}
            </div>
          )}
        </section>
      )}

      {needsProfile && (
        <section style={card}>
          <h2 style={h2}>Where are you?</h2>
          <p style={{ color: MUTED, marginTop: 0 }}>
            We use your city to show a live map of remittances. This is optional
            and never shared with anyone.
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <input
              value={city}
              onChange={(e) => setCity(e.target.value)}
              placeholder="City"
              style={input}
              aria-label="City"
            />
            <input
              value={country}
              onChange={(e) => setCountry(e.target.value)}
              placeholder="Country"
              style={input}
              aria-label="Country"
            />
          </div>
          <button onClick={saveProfile} style={{ ...button, marginTop: 10 }}>
            Save
          </button>
          {profileStatus && <p style={statusText}>{profileStatus}</p>}
        </section>
      )}

      {onboard && (
        <section style={card}>
          <h2 style={h2}>Your automation wallet</h2>
          <p style={{ color: MUTED, marginTop: 0 }}>
            Funds here are automation funds. They run your rules and you can
            withdraw them back to MiniPay anytime.
          </p>
          <code style={mono}>{onboard.executionWallet}</code>

          {balances.length > 0 && (
            <div style={{ marginTop: 14 }}>
              {balances.map((b) => (
                <div key={b.symbol} style={row}>
                  <span style={{ color: FAINT }}>{b.symbol}</span>
                  <span style={{ color: CREAM }}>
                    {trimAmount(b.amount)}
                    {typeof b.usd === "number" && b.usd > 0 && (
                      <span style={{ color: FAINT, marginLeft: 8, fontSize: 12 }}>
                        ${b.usd.toFixed(2)}
                      </span>
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}

          {yieldPositions.length > 0 && (
            <div style={{ marginTop: 14, borderTop: BORDER_LINE, paddingTop: 12 }}>
              <div style={{ ...label, marginBottom: 8 }}>GROWING &middot; AAVE SAVINGS</div>
              {yieldPositions.map((p) => (
                <div key={p.symbol}>
                  <div style={row}>
                    <span style={{ color: FAINT }}>{p.symbol}</span>
                    <span style={{ color: CREAM }}>
                      {trimAmount(p.supplied)}
                      <span style={{ color: GREEN, marginLeft: 8, fontSize: 12 }}>
                        {p.apyPct.toFixed(2)}% APY
                      </span>
                    </span>
                  </div>
                  {p.earned > 0.000001 && (
                    <div style={{ ...row, borderBottom: "none", paddingTop: 0 }}>
                      <span style={{ color: FAINT, fontSize: 12 }}>earned so far</span>
                      <span style={{ color: GREEN, fontSize: 12 }}>
                        +{trimAmount(p.earned.toFixed(6))} {p.symbol}
                      </span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {totalUsd !== null && totalUsd > 0 && (
            <div style={{ ...row, marginTop: 8, borderBottom: "none" }}>
              <span style={{ ...label, marginBottom: 0 }}>TOTAL</span>
              <span style={{ color: GOLD, fontFamily: MONO }}>${totalUsd.toFixed(2)}</span>
            </div>
          )}

          <div style={{ ...label, margin: "18px 0 8px" }}>FUND WITH cUSD</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <input
              value={fundAmount}
              onChange={(e) => setFundAmount(e.target.value)}
              inputMode="decimal"
              style={input}
              aria-label="Amount of cUSD to fund"
            />
            <button onClick={fund} style={button}>
              Fund
            </button>
          </div>
          {status && <p style={statusText}>{status}</p>}

          <div style={{ marginTop: 18, borderTop: BORDER_LINE, paddingTop: 14 }}>
            <div style={{ ...label, marginBottom: 8 }}>WITHDRAW BACK TO MINIPAY</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              <select
                value={withdrawToken}
                onChange={(e) => setWithdrawToken(e.target.value)}
                style={{ ...input, flex: "0 0 90px" }}
                aria-label="Token to withdraw"
              >
                {WITHDRAW_TOKENS.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <input
                value={withdrawAmount}
                onChange={(e) => setWithdrawAmount(e.target.value)}
                inputMode="decimal"
                placeholder="0.0"
                style={input}
                aria-label="Amount to withdraw"
              />
              <button onClick={setMax} style={buttonGhost}>
                Max
              </button>
            </div>
            <button onClick={doWithdraw} style={{ ...buttonGhost, marginTop: 8, width: "100%" }}>
              Withdraw to MiniPay
            </button>
            {withdrawStatus && <p style={statusText}>{withdrawStatus}</p>}
          </div>
        </section>
      )}

      {onboard && !onboard.telegramLinked && !tgLinked && (
        <section style={card}>
          <h2 style={h2}>Receipts on Telegram</h2>
          <p style={{ color: MUTED, marginTop: 0 }}>
            Your agent acts while this app is closed. Connect Telegram and it
            sends you a receipt every time it moves money: what moved, the
            transaction link, and the proof hash.
          </p>
          <button onClick={connectTelegram} style={button}>
            Connect Telegram
          </button>
          {tgStatus && <p style={statusText}>{tgStatus}</p>}
        </section>
      )}

      {onboard && soonest && (
        <section
          style={{
            ...card,
            border: "1px solid rgba(233,165,60,0.35)",
            background: "rgba(233,165,60,0.05)",
          }}
        >
          <div style={{ ...label, color: GOLD }}>NEXT EXECUTION TICK</div>
          <p style={{ color: MUTED, marginTop: 8 }}>
            {ruleLabel(soonest)} runs next at {formatLocal(soonest.nextRun)}.
          </p>
          <div
            style={{
              fontFamily: MONO,
              fontSize: 34,
              fontWeight: 700,
              color: GREEN,
              letterSpacing: "0.04em",
            }}
          >
            {formatCountdown(new Date(soonest.nextRun).getTime() - now)}
          </div>
          <p style={{ color: FAINT, fontSize: 12, marginTop: 8, fontFamily: MONO, lineHeight: 1.6 }}>
            The agent evaluates rules on a ~20-minute heartbeat, so it runs at the
            first tick on or after this time.
          </p>
        </section>
      )}

      {onboard && (
        <section style={card}>
          <h2 style={h2}>Set a rule</h2>
          <p style={{ color: MUTED, marginTop: 0 }}>
            Describe it in plain language. For example: save 10 percent every Friday,
            stack 2 dollars of CELO daily, or keep 40 percent in cKES rebalance weekly.
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "4px 0 12px" }}>
            {["SAVINGS", "FX", "DCA", "REMIT"].map((c) => (
              <span key={c} style={chip}>
                {c}
              </span>
            ))}
          </div>
          <textarea
            value={ruleText}
            onChange={(e) => setRuleText(e.target.value)}
            rows={2}
            placeholder="Save 10 percent every Friday"
            style={{ ...input, width: "100%", resize: "vertical" }}
            aria-label="Describe your rule"
          />
          <button onClick={previewRule} style={{ ...button, marginTop: 10 }}>
            Preview
          </button>

          {parsedRule && (
            <div style={readback}>
              <div style={readbackHead}>
                <span>&#10003;</span> PARSED &middot; READS BACK BEFORE ANYTHING MOVES
              </div>
              <div style={{ fontFamily: MONO, fontSize: 12.5 }}>
                <div style={kv}>
                  <span style={{ opacity: 0.5 }}>SUMMARY</span>
                  <span style={{ textAlign: "right" }}>{parsedRule.summary}</span>
                </div>
                <div style={kv}>
                  <span style={{ opacity: 0.5 }}>KIND</span>
                  <span style={{ color: GREEN }}>{parsedRule.kind.replace(/_/g, " ")}</span>
                </div>
                <div style={kv}>
                  <span style={{ opacity: 0.5 }}>CADENCE</span>
                  <span>{parsedRule.cadence}</span>
                </div>
                <div style={kv}>
                  <span style={{ opacity: 0.5 }}>PARAMS</span>
                  <span style={{ textAlign: "right", wordBreak: "break-word" }}>
                    {JSON.stringify(parsedRule.params)}
                  </span>
                </div>
              </div>
              {parsedRule.needsRecipientResolution && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    <input
                      value={recipientPhone}
                      onChange={(e) => setRecipientPhone(e.target.value)}
                      inputMode="tel"
                      placeholder="Recipient phone +234..."
                      style={{ ...input, flex: "1 1 150px" }}
                      aria-label="Recipient phone number"
                    />
                    <button onClick={resolveRecipient} style={buttonGhost}>
                      Find on MiniPay
                    </button>
                  </div>
                  {resolveStatus && <p style={statusText}>{resolveStatus}</p>}
                  <input
                    value={recipientAddr}
                    onChange={(e) => setRecipientAddr(e.target.value)}
                    placeholder="or paste a wallet address 0x..."
                    style={{ ...input, width: "100%", marginTop: 8 }}
                    aria-label="Recipient address"
                  />
                </div>
              )}
              <button onClick={confirmRule} style={{ ...button, marginTop: 12, width: "100%" }}>
                Looks right, activate
              </button>
            </div>
          )}
          {ruleStatus && <p style={statusText}>{ruleStatus}</p>}
        </section>
      )}

      {onboard && (
        <section style={card}>
          <h2 style={h2}>Savings goals</h2>
          <p style={{ color: MUTED, marginTop: 0 }}>
            Name a goal and the agent saves toward it automatically. Lock it and
            not even a scheduled withdrawal can touch it until the date.
          </p>
          {goalsList.map((g) => {
            const pctDone = Math.min(100, (g.progressUsd / g.targetUsd) * 100);
            const locked = g.lockUntil && new Date(g.lockUntil).getTime() > now;
            return (
              <div key={g.id} style={{ borderTop: BORDER_LINE, padding: "12px 0", fontSize: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontWeight: 700 }}>
                    {g.name}
                    {g.reached && (
                      <span style={{ color: GREEN, fontFamily: MONO, fontSize: 11, marginLeft: 8 }}>
                        REACHED
                      </span>
                    )}
                  </span>
                  <span style={{ fontFamily: MONO, fontSize: 12, color: g.reached ? GREEN : CREAM }}>
                    ${g.progressUsd.toFixed(2)} / ${g.targetUsd.toFixed(0)}
                  </span>
                </div>
                <div
                  style={{
                    marginTop: 8,
                    height: 6,
                    background: "rgba(242,237,227,0.08)",
                    borderRadius: 3,
                    overflow: "hidden",
                  }}
                  role="progressbar"
                  aria-valuenow={Math.round(pctDone)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <div
                    style={{
                      width: `${pctDone}%`,
                      height: "100%",
                      background: pctDone >= 100 ? GREEN : GOLD,
                    }}
                  />
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8 }}>
                  <span style={{ color: FAINT, fontSize: 12, fontFamily: MONO }}>
                    {locked ? `LOCKED UNTIL ${formatLocal(g.lockUntil!)}` : g.asset}
                  </span>
                  <span style={{ display: "flex", gap: 8 }}>
                    {locked && (
                      <button onClick={() => unlockGoal(g.id)} style={{ ...smallButton, ...ghostSmall }}>
                        UNLOCK
                      </button>
                    )}
                    <button onClick={() => cancelGoal(g.id)} style={{ ...smallButton, ...ghostSmall }}>
                      CANCEL
                    </button>
                  </span>
                </div>
              </div>
            );
          })}
          <div style={{ borderTop: goalsList.length > 0 ? BORDER_LINE : "none", paddingTop: 12, marginTop: goalsList.length > 0 ? 4 : 0 }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              <input
                value={goalName}
                onChange={(e) => setGoalName(e.target.value)}
                placeholder="Goal name (e.g. School fees)"
                style={{ ...input, flex: "1 1 160px" }}
                aria-label="Goal name"
              />
              <input
                value={goalTarget}
                onChange={(e) => setGoalTarget(e.target.value)}
                inputMode="decimal"
                placeholder="Target $"
                style={{ ...input, flex: "0 1 90px" }}
                aria-label="Goal target in USD"
              />
              <select
                value={goalLockDays}
                onChange={(e) => setGoalLockDays(e.target.value)}
                style={{ ...input, flex: "0 1 130px" }}
                aria-label="Lock period"
              >
                <option value="">No lock</option>
                <option value="30">Lock 30 days</option>
                <option value="90">Lock 90 days</option>
                <option value="180">Lock 180 days</option>
              </select>
            </div>
            <button onClick={createGoal} style={{ ...button, marginTop: 10, width: "100%" }}>
              Start this goal
            </button>
            <p style={{ color: FAINT, fontSize: 12, marginTop: 8 }}>
              The agent sweeps 20 percent of your idle {"cUSD"} into Aave savings
              daily until the target is reached. Cancel anytime.
            </p>
            {goalStatus && <p style={statusText}>{goalStatus}</p>}
          </div>
        </section>
      )}

      {onboard && rules.length > 0 && (
        <section style={card}>
          <h2 style={h2}>Your rules</h2>
          {rules.map((r) => (
            <div key={r.id} style={{ borderTop: BORDER_LINE, padding: "12px 0", fontSize: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ textTransform: "uppercase", fontWeight: 700, letterSpacing: "-0.01em" }}>
                  {ruleLabel(r)}
                </span>
                <span
                  style={{
                    fontFamily: MONO,
                    fontSize: 11,
                    letterSpacing: "0.08em",
                    color: r.status === "paused" ? GOLD : GREEN,
                  }}
                >
                  {r.status.toUpperCase()}
                </span>
              </div>
              <div style={{ color: FAINT, fontSize: 12, marginTop: 4, fontFamily: MONO }}>
                NEXT: {formatLocal(r.nextRun)}
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                {r.status === "active" ? (
                  <button
                    onClick={() => pauseResume(r.id, "pause")}
                    style={{ ...smallButton, ...ghostSmall }}
                  >
                    PAUSE
                  </button>
                ) : (
                  <button
                    onClick={() => pauseResume(r.id, "resume")}
                    style={{ ...smallButton, background: GREEN, color: "#062a1c" }}
                  >
                    RESUME
                  </button>
                )}
                <button
                  onClick={() => deleteRule(r.id)}
                  style={{
                    ...smallButton,
                    background: "transparent",
                    border: "1px solid rgba(224,99,94,0.5)",
                    color: "#e0635e",
                  }}
                >
                  DELETE
                </button>
              </div>
            </div>
          ))}
          {rulesStatus && <p style={statusText}>{rulesStatus}</p>}
        </section>
      )}

      {onboard && (
        <section style={card}>
          <h2 style={h2}>Activity</h2>
          {activity.length === 0 && (
            <p style={{ color: MUTED, marginTop: 0 }}>No actions yet.</p>
          )}
          {activity.map((a) => (
            <div key={a.id} style={row}>
              <span style={{ color: GOLD }}>{a.kind.replace(/_/g, " ").toUpperCase()}</span>
              <span style={{ color: FAINT }}>
                {a.amountIn ?? ""} {a.tokenIn ?? ""}
              </span>
              <span style={{ color: statusColor(a.status) }}>{a.status.toUpperCase()}</span>
            </div>
          ))}
        </section>
      )}

      {onboard && agentInfo?.agentId && (
        <section style={card}>
          <h2 style={h2}>Rate RemitRoute</h2>
          <p style={{ color: MUTED, marginTop: 0 }}>
            If the agent served you well, leave onchain feedback. You sign from your
            own wallet, gas in cUSD.
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <button onClick={() => rate(100)} style={button}>
              Great
            </button>
            <button onClick={() => rate(70)} style={buttonGhost}>
              Good
            </button>
            <button onClick={() => rate(40)} style={buttonGhost}>
              Okay
            </button>
          </div>
          {rateStatus && <p style={statusText}>{rateStatus}</p>}
        </section>
      )}
    </main>
  );
}

// The route glyph from the brand board: origin node, curved route, value dot,
// settled destination. Gold to green, money that finds its way home.
function RouteGlyph({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" style={{ flex: "none" }}>
      <circle cx="6" cy="25" r="3.4" stroke={GOLD} strokeWidth="2" />
      <circle cx="26" cy="7" r="3.4" stroke={GOLD} strokeWidth="2" />
      <path d="M7.6 22.6 C 16 16, 12 9, 24.2 9.2" stroke={GOLD} strokeWidth="2" strokeLinecap="round" />
      <circle cx="16.2" cy="13.4" r="2.6" fill={GREEN} />
    </svg>
  );
}

// Brand palette (Brand Board v1).
const INK = "#0B0A09";
const SURFACE = "#0E0C0A";
const CREAM = "#F2EDE3";
const GOLD = "#E9A53C";
const GREEN = "#34B27B";
const MUTED = "rgba(242,237,227,0.62)";
const FAINT = "rgba(242,237,227,0.45)";
const MONO = "var(--font-space-mono), ui-monospace, monospace";
const BORDER_LINE = "1px solid rgba(242,237,227,0.1)";

const card: React.CSSProperties = {
  background: SURFACE,
  border: "1px solid rgba(242,237,227,0.14)",
  borderRadius: 6,
  padding: 18,
  marginTop: 16,
};
const h2: React.CSSProperties = {
  fontSize: 22,
  fontWeight: 900,
  textTransform: "uppercase",
  letterSpacing: "-0.02em",
  marginTop: 0,
  marginBottom: 10,
};
const label: React.CSSProperties = {
  fontFamily: MONO,
  fontSize: 11,
  letterSpacing: "0.1em",
  color: FAINT,
  textTransform: "uppercase",
};
const mono: React.CSSProperties = {
  display: "block",
  wordBreak: "break-all",
  fontSize: 13,
  fontFamily: MONO,
  color: CREAM,
};
const input: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: "11px 13px",
  borderRadius: 6,
  border: "1px solid rgba(242,237,227,0.18)",
  background: INK,
  color: CREAM,
  fontFamily: "inherit",
  fontSize: 15,
};
const button: React.CSSProperties = {
  padding: "12px 18px",
  borderRadius: 6,
  border: "none",
  background: GOLD,
  color: INK,
  fontWeight: 800,
  cursor: "pointer",
  fontFamily: "inherit",
  fontSize: 15,
};
const buttonGhost: React.CSSProperties = {
  padding: "12px 18px",
  borderRadius: 6,
  border: "1px solid rgba(242,237,227,0.28)",
  background: "transparent",
  color: CREAM,
  fontWeight: 700,
  cursor: "pointer",
  fontFamily: "inherit",
  fontSize: 15,
};
const smallButton: React.CSSProperties = {
  padding: "7px 14px",
  borderRadius: 6,
  border: "none",
  fontWeight: 700,
  cursor: "pointer",
  fontSize: 11,
  fontFamily: MONO,
  letterSpacing: "0.06em",
};
const ghostSmall: React.CSSProperties = {
  background: "transparent",
  border: "1px solid rgba(242,237,227,0.24)",
  color: CREAM,
};
const row: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  padding: "10px 0",
  borderTop: "1px solid rgba(242,237,227,0.08)",
  fontSize: 12.5,
  fontFamily: MONO,
};
const chip: React.CSSProperties = {
  fontFamily: MONO,
  fontSize: 11,
  letterSpacing: "0.04em",
  border: "1px solid rgba(242,237,227,0.16)",
  borderRadius: 100,
  padding: "6px 11px",
  color: FAINT,
};
const readback: React.CSSProperties = {
  border: "1px solid rgba(242,237,227,0.14)",
  borderRadius: 6,
  overflow: "hidden",
  marginTop: 12,
};
const readbackHead: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 7,
  padding: "11px 14px",
  background: "rgba(52,178,123,0.08)",
  color: GREEN,
  fontFamily: MONO,
  fontSize: 11,
  letterSpacing: "0.06em",
};
const kv: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 12,
  padding: "11px 14px",
  borderTop: "1px solid rgba(242,237,227,0.08)",
  color: "rgba(242,237,227,0.8)",
};
const statusText: React.CSSProperties = {
  color: MUTED,
  fontFamily: MONO,
  fontSize: 12.5,
  lineHeight: 1.6,
};

function statusColor(status: string): string {
  if (status === "confirmed" || status === "success") return GREEN;
  if (status === "failed" || status === "reverted") return "#e0635e";
  return GOLD;
}

// A short label for a rule, derived from its kind and cadence.
function ruleLabel(r: ScheduleItem): string {
  return `${r.kind.replace(/_/g, " ")} (${r.cadence})`;
}

// The active rule with the soonest next run, or null.
function nextDueRule(active: ScheduleItem[]): ScheduleItem | null {
  if (active.length === 0) return null;
  return active.reduce((a, b) =>
    new Date(a.nextRun).getTime() <= new Date(b.nextRun).getTime() ? a : b,
  );
}

// Trim a formatted balance to at most 6 decimals for display.
function trimAmount(amount: string): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return amount;
  return n.toFixed(6).replace(/\.?0+$/, "");
}

// Format a millisecond delta as HH:MM:SS, or a due label when non-positive.
function formatCountdown(ms: number): string {
  if (ms <= 0) return "due now";
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

// Format an ISO timestamp in the viewer's local time.
function formatLocal(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
