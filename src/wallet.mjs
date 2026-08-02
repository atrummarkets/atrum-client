/**
 * Wallet connection and transaction submission.
 *
 * NOTHING IS HARDCODED EXCEPT THE POOL. The vault, the collateral token and the denomination
 * are all read from the chain, starting at the pool address. That is deliberate: this
 * project has already shipped a deployment whose committee key was a stale copied constant,
 * producing a market that could never settle. Addresses copied into a frontend go stale the
 * same way, and the failure is silent until someone's money is stuck.
 */

import { ethers } from "../public/vendor/ethers.min.js";

/** Monad testnet. Chain IDs were re-measured against live nodes: 143 mainnet, 10143 testnet. */
export const MONAD_TESTNET = {
  chainId: "0x279f", // 10143
  chainName: "Monad Testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: ["https://testnet-rpc.monad.xyz"],
  blockExplorerUrls: ["https://testnet.monadexplorer.com"],
};

/**
 * Deployed 2026-08-02 with EXERCISE_MODE=1 (6-minute betting window, 1-hour resolution gap)
 * and SEQUENCER pinned to the sequencer's first relayer address -- the default (deployer)
 * leaves every flushBatch reverting once a real sequencer with its own relayer mnemonic
 * runs against it. See atrum-core HANDOFF.md's "0-ter" for why both of those matter.
 *
 * PROVEN, not just deployed: the entire lifecycle ran against this pool through this exact
 * client code -- deposit, betEncrypted, resolve, publishFinalTotals, redeemPrivate, withdraw,
 * six real transactions, `Withdrawn` event confirmed from the raw log. Block numbers in
 * atrum-core HANDOFF.md "0-ter".
 *
 * Earlier pools: `0x5Ede6585...` (normal 7-day schedule, still valid, just untestable in one
 * sitting) and `0x6af21cA1...` (actually dead -- verifiers baked against a zkey circuits/
 * build/ no longer holds). Byte-verified after deploy: all four verifiers' on-chain bytecode
 * matches `forge inspect <Name> deployedBytecode` exactly, sha256 identical.
 */
export const SHIELDED_POOL = "0xa54cc8AC537E64f70e1b842A9edc4169ed22D06f";

/**
 * Monad bills the DECLARED gas limit, not the gas used -- measured, not assumed. A 21,000-gas
 * transfer declared at 2,000,000 was charged for 2,114,412.
 *
 * That makes the declared limit publicly visible metadata about which action you took, so
 * every shielded action declares the SAME limit. Deviating from it is a fingerprint, which is
 * why this is a constant rather than an estimate: letting the wallet estimate gas per action
 * would leak the action type to anyone watching the mempool.
 *
 * 2,500,000 is the envelope after `withdraw` came in at 1,804,341 on real testnet -- local
 * forge understates by 32-55%, so every local figure is a lower bound.
 */
export const ACTION_GAS_LIMIT = 2_500_000n;

const POOL_ABI = [
  "function marketVault(uint32) view returns (address)",
  "function encryptedMarket(uint32) view returns (bool)",
  "function encryptedTotals() view returns (address)",
  "function deposit(uint256[2] pA, uint256[2][2] pB, uint256[2] pC, uint256 commitment, uint32 marketId, uint256 units)",
  "function betEncrypted(uint256[2] pA, uint256[2][2] pB, uint256[2] pC, uint256 root, uint256 nullifierHash, uint256 newCommitment, uint256 betMeta, uint256[4] ciphertext)",
  "function redeemPrivate(uint256[2] pA, uint256[2][2] pB, uint256[2] pC, uint256 root, uint256 nullifierHash, uint256 newCommitment, uint256 redeemMeta)",
  "function withdraw(uint256[2] pA, uint256[2][2] pB, uint256[2] pC, uint256 root, uint256 nullifierHash, uint256 changeCommitment, uint256 withdrawData)",
];

const VAULT_ABI = [
  "function collateral() view returns (address)",
  "function denomination() view returns (uint256)",
  "function bettingCloseTime() view returns (uint256)",
  "function resolutionStartTime() view returns (uint256)",
  "function outcome() view returns (uint8)",
];

/** `Vault.Outcome`, mirrored -- 0 Unresolved, 1 YES, 2 NO, 3 Void. */
export const VAULT_OUTCOME = { UNRESOLVED: 0n, YES: 1n, NO: 2n, VOID: 3n };

const ENCRYPTED_TOTALS_ABI = [
  "function finalYesTotal(uint32) view returns (uint256)",
  "function finalNoTotal(uint32) view returns (uint256)",
  "function settled(uint32) view returns (bool)",
  "function committeeKeyX() view returns (uint256)",
  "function committeeKeyY() view returns (uint256)",
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

export async function connect() {
  if (!window.ethereum) throw new Error("no injected wallet found — install MetaMask");

  const provider = new ethers.BrowserProvider(window.ethereum);
  await provider.send("eth_requestAccounts", []);

  const network = await provider.getNetwork();
  if (network.chainId !== 10143n) {
    try {
      await provider.send("wallet_switchEthereumChain", [{ chainId: MONAD_TESTNET.chainId }]);
    } catch (e) {
      // 4902 = chain unknown to the wallet, so offer to add it rather than dead-ending.
      if (e.error?.code === 4902 || e.code === 4902) {
        await provider.send("wallet_addEthereumChain", [MONAD_TESTNET]);
      } else {
        throw e;
      }
    }
  }

  const signer = await new ethers.BrowserProvider(window.ethereum).getSigner();
  return { provider, signer, address: await signer.getAddress() };
}

/**
 * Everything about a market, read from the chain rather than assumed.
 * Returns null for `vault` if the market is not registered on this deployment.
 */
export async function marketInfo(signer, marketId, poolAddress = SHIELDED_POOL) {
  const pool = new ethers.Contract(poolAddress, POOL_ABI, signer);
  const vaultAddress = await pool.marketVault(marketId);

  if (vaultAddress === ethers.ZeroAddress) {
    return { vault: null, reason: `market ${marketId} is not registered on ${poolAddress}` };
  }

  const vault = new ethers.Contract(vaultAddress, VAULT_ABI, signer);
  const [collateralAddress, denomination, bettingCloseTime, encrypted] = await Promise.all([
    vault.collateral(),
    vault.denomination(),
    vault.bettingCloseTime(),
    pool.encryptedMarket(marketId),
  ]);

  const collateral = new ethers.Contract(collateralAddress, ERC20_ABI, signer);
  const [symbol, decimals] = await Promise.all([
    collateral.symbol().catch(() => "?"),
    collateral.decimals().catch(() => 18),
  ]);

  return {
    pool,
    vault,
    vaultAddress,
    collateral,
    collateralAddress,
    denomination,
    bettingCloseTime,
    encrypted,
    symbol,
    decimals,
    closed: BigInt(Math.floor(Date.now() / 1000)) >= bettingCloseTime,
  };
}

/**
 * `marketInfo` plus resolution/settlement state -- what `redeemPrivate` needs to check
 * before it is worth building a proof at all.
 *
 * `settled` follows the contract's own rule (`ShieldedPool._checkRedeemMeta`), not an
 * approximation of it: a Void market skips the settlement requirement entirely (the refund
 * path needs no published totals), everything else needs `encryptedTotals.settled(marketId)`
 * to be true. Getting this wrong here just means a wasted proof, not a wrong redemption --
 * the contract enforces the real rule regardless -- but there is no reason to make someone
 * pay to prove something that was always going to revert.
 */
export async function settlementInfo(signer, marketId, poolAddress = SHIELDED_POOL) {
  const info = await marketInfo(signer, marketId, poolAddress);
  if (!info.vault) return info;

  const outcome = await info.vault.outcome();
  const base = { ...info, outcome };

  if (outcome === VAULT_OUTCOME.UNRESOLVED) return { ...base, settled: false };
  if (outcome === VAULT_OUTCOME.VOID) return { ...base, settled: true }; // needs no published totals

  const totalsAddress = await info.pool.encryptedTotals();
  if (totalsAddress === ethers.ZeroAddress) {
    return { ...base, settled: false, reason: "encryptedTotals is not bound on this pool yet" };
  }

  const totals = new ethers.Contract(totalsAddress, ENCRYPTED_TOTALS_ABI, signer);
  const settled = await totals.settled(marketId);
  if (!settled) return { ...base, settled: false };

  const [finalYesTotal, finalNoTotal] = await Promise.all([
    totals.finalYesTotal(marketId),
    totals.finalNoTotal(marketId),
  ]);
  return { ...base, settled: true, finalYesTotal, finalNoTotal, totalsAddress };
}

/**
 * The committee public key this deployment encrypts against -- read from chain, not
 * hardcoded, for the same reason nothing else here is. Public only; encrypting a bet needs
 * no secret, which is the whole point of ElGamal.
 *
 * THIS DEPLOYMENT'S COMMITTEE SECRET IS PUBLISHED (see the banner in app.html). Reading the
 * public key here does not change that -- it is stated so nobody mistakes "the client never
 * touches the secret" for "this is private," which it is not until the ceremony runs.
 */
export async function committeeKey(signer, marketId, poolAddress = SHIELDED_POOL) {
  const pool = new ethers.Contract(poolAddress, POOL_ABI, signer);
  const totalsAddress = await pool.encryptedTotals();
  if (totalsAddress === ethers.ZeroAddress) {
    throw new Error("encryptedTotals is not bound on this pool yet");
  }
  const totals = new ethers.Contract(totalsAddress, ENCRYPTED_TOTALS_ABI, signer);
  const [x, y] = await Promise.all([totals.committeeKeyX(), totals.committeeKeyY()]);
  return [x, y];
}

/**
 * snarkjs hands calldata back as a string of Solidity array literals, not as values.
 *
 * It must come from `exportSolidityCallData`, NOT from the raw proof object: snarkjs swaps
 * each G2 coordinate pair between the two, so calldata assembled from `proof` directly is a
 * well-formed proof that reverts on chain. The worker already calls the right one; this only
 * parses what it returned.
 */
export function parseCalldata(calldata) {
  const flat = JSON.parse(`[${calldata}]`);
  return {
    pA: flat[0],
    pB: flat[1],
    pC: flat[2],
    publicSignals: flat[3],
  };
}

/** Approve the pool to move collateral, if it is not already approved for enough. */
export async function ensureAllowance({ collateral, owner, spender, amount, onStatus }) {
  const current = await collateral.allowance(owner, spender);
  if (current >= amount) return null;

  onStatus?.("approving collateral…");
  const tx = await collateral.approve(spender, amount);
  onStatus?.(`approval sent (${tx.hash}), waiting…`);
  await tx.wait();
  return tx.hash;
}

/**
 * Submit a deposit.
 *
 * The proof's public signals are re-checked against the note before broadcasting. The
 * contract would reject a mismatch anyway, but it would do so after the user paid for
 * 2,500,000 declared gas -- and on Monad the declared limit is billed whether the call
 * succeeds or reverts.
 */
export async function submitDeposit({ signer, note, calldata, marketId, poolAddress = SHIELDED_POOL, onStatus }) {
  const { pA, pB, pC, publicSignals } = parseCalldata(calldata);

  if (BigInt(publicSignals[0]) !== note.commitment) {
    throw new Error("proof commitment does not match the note — refusing to submit");
  }
  if (BigInt(publicSignals[2]) !== note.units) {
    throw new Error("proof units do not match the note — refusing to submit");
  }

  const info = await marketInfo(signer, marketId, poolAddress);
  if (!info.vault) throw new Error(info.reason);
  if (info.closed) throw new Error(`betting closed for market ${marketId}`);

  const owner = await signer.getAddress();
  const amount = note.units * info.denomination;

  const balance = await info.collateral.balanceOf(owner);
  if (balance < amount) {
    throw new Error(
      `insufficient ${info.symbol}: need ${amount}, hold ${balance}. ` +
        `The collateral is a MockERC20 on testnet — it has to be minted to you.`,
    );
  }

  const approvalTx = await ensureAllowance({
    collateral: info.collateral,
    owner,
    spender: poolAddress,
    amount,
    onStatus,
  });

  onStatus?.("submitting deposit…");
  const tx = await info.pool.deposit(pA, pB, pC, note.commitment, marketId, note.units, {
    gasLimit: ACTION_GAS_LIMIT,
  });

  onStatus?.(`deposit sent (${tx.hash}), waiting for inclusion…`);
  const receipt = await tx.wait();

  return {
    approvalTx,
    hash: tx.hash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed,
    explorer: `${MONAD_TESTNET.blockExplorerUrls[0]}/tx/${tx.hash}`,
  };
}

/**
 * Submit an encrypted bet.
 *
 * Unlike deposit, this spends a note as well as producing one, and the spend needs a
 * Merkle path -- but that path has to exist BEFORE the proof is built (`betInput` takes it
 * as an argument), so fetching it belongs to the proving step in app.js, not here. By
 * submission time the path is already baked into `calldata`'s `root`; this function only
 * checks what remains checkable without re-deriving it.
 */
export async function submitBet({
  signer,
  positionNote,
  calldata,
  marketId,
  poolAddress = SHIELDED_POOL,
  onStatus,
}) {
  const { pA, pB, pC, publicSignals } = parseCalldata(calldata);
  const [root, nullifierHash, newCommitment, betMeta, c1x, c1y, c2x, c2y] = publicSignals;

  if (BigInt(newCommitment) !== positionNote.commitment) {
    throw new Error("proof's new commitment does not match the position note — refusing to submit");
  }

  const info = await marketInfo(signer, marketId, poolAddress);
  if (!info.vault) throw new Error(info.reason);
  if (!info.encrypted) throw new Error(`market ${marketId} is not an encrypted market`);
  if (info.closed) throw new Error(`betting closed for market ${marketId}`);

  onStatus?.("submitting bet…");
  const tx = await info.pool.betEncrypted(
    pA,
    pB,
    pC,
    root,
    nullifierHash,
    newCommitment,
    betMeta,
    [c1x, c1y, c2x, c2y],
    { gasLimit: ACTION_GAS_LIMIT },
  );

  onStatus?.(`bet sent (${tx.hash}), waiting for inclusion…`);
  const receipt = await tx.wait();

  return {
    hash: tx.hash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed,
    explorer: `${MONAD_TESTNET.blockExplorerUrls[0]}/tx/${tx.hash}`,
  };
}

/**
 * Submit a private redemption: burn a position note, receive a SETTLED payout note.
 *
 * Checked against `settlementInfo`'s rule, not a copy of it -- see that function's
 * docstring for why Void skips the settlement requirement and everything else does not.
 */
export async function submitRedeem({
  signer,
  payoutNote,
  calldata,
  marketId,
  poolAddress = SHIELDED_POOL,
  onStatus,
}) {
  const { pA, pB, pC, publicSignals } = parseCalldata(calldata);
  const [root, nullifierHash, newCommitment, redeemMeta] = publicSignals;

  if (BigInt(newCommitment) !== payoutNote.commitment) {
    throw new Error("proof's new commitment does not match the payout note — refusing to submit");
  }

  const info = await settlementInfo(signer, marketId, poolAddress);
  if (!info.vault) throw new Error(info.reason);
  if (info.outcome === VAULT_OUTCOME.UNRESOLVED) {
    throw new Error(`market ${marketId} has not been resolved yet`);
  }
  if (info.outcome !== VAULT_OUTCOME.VOID && !info.settled) {
    throw new Error(`market ${marketId} resolved but totals are not published yet — settle it first`);
  }

  onStatus?.("submitting redeem…");
  const tx = await info.pool.redeemPrivate(pA, pB, pC, root, nullifierHash, newCommitment, redeemMeta, {
    gasLimit: ACTION_GAS_LIMIT,
  });

  onStatus?.(`redeem sent (${tx.hash}), waiting for inclusion…`);
  const receipt = await tx.wait();

  return {
    hash: tx.hash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed,
    explorer: `${MONAD_TESTNET.blockExplorerUrls[0]}/tx/${tx.hash}`,
  };
}

/**
 * Submit a withdrawal: burn a SETTLED note, move `amount` to `recipient` publicly, keep
 * `change` as a new SETTLED note.
 */
export async function submitWithdraw({
  signer,
  changeNote,
  calldata,
  marketId,
  poolAddress = SHIELDED_POOL,
  onStatus,
}) {
  const { pA, pB, pC, publicSignals } = parseCalldata(calldata);
  const [root, nullifierHash, changeCommitment, withdrawData] = publicSignals;

  if (BigInt(changeCommitment) !== changeNote.commitment) {
    throw new Error("proof's change commitment does not match the change note — refusing to submit");
  }

  const info = await marketInfo(signer, marketId, poolAddress);
  if (!info.vault) throw new Error(info.reason);

  onStatus?.("submitting withdraw…");
  const tx = await info.pool.withdraw(pA, pB, pC, root, nullifierHash, changeCommitment, withdrawData, {
    gasLimit: ACTION_GAS_LIMIT,
  });

  onStatus?.(`withdraw sent (${tx.hash}), waiting for inclusion…`);
  const receipt = await tx.wait();

  return {
    hash: tx.hash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed,
    explorer: `${MONAD_TESTNET.blockExplorerUrls[0]}/tx/${tx.hash}`,
  };
}
