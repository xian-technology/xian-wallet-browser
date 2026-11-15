import { fixedText, fixedUnits } from "@xian-tech/dex";

// Execution reserves a transaction's fee (chi_supplied / chi rate XIAN) from
// the sender's XIAN balance before it runs, and the call spends from what is
// left. The simulator does not reserve, so a XIAN spend that only fits
// without the fee simulates fine: CheckTx rejects such a currency transfer,
// but any other call (a swap from XIAN) executes, fails and pays its fee.

/** The native token's contract: its balance pays every fee. */
export const NATIVE_TOKEN_CONTRACT = "currency";

const UNITS_PER_XIAN = 10n ** 30n;
/** The suggested maximum is floored to 8 decimals, as balances are shown. */
const SUGGESTED_STEP = 10n ** 22n;

export interface NativeSpendShortfall {
  /** The fee of the estimated chi, in XIAN. */
  fee: string;
  /** The most the call can spend, in XIAN ("0" when the fee does not fit). */
  max: string;
}

export interface NativeSpendInput {
  balance: string | null | undefined;
  amount: string;
  chi: number;
  chiRate: number | null | undefined;
}

/** The XIAN units (10^-30 XIAN) `chi` costs at `chiRate` chi per XIAN, rounded up. */
function feeUnits(chi: bigint, chiRate: bigint): bigint {
  return (chi * UNITS_PER_XIAN + chiRate - 1n) / chiRate;
}

function unitsOf(value: string | null | undefined): bigint | null {
  try {
    return value == null ? null : fixedUnits(value);
  } catch {
    return null;
  }
}

function isCount(value: number | null | undefined): value is number {
  return value != null && Number.isSafeInteger(value) && value >= 0;
}

/** The spend in exact units, or null when an input is unknown or unreadable. */
function exactSpend(input: NativeSpendInput): { balance: bigint; amount: bigint; chi: bigint; rate: bigint } | null {
  const balance = unitsOf(input.balance);
  const amount = unitsOf(input.amount);
  if (balance == null || amount == null || !isCount(input.chi) || !isCount(input.chiRate) || input.chiRate === 0) {
    return null;
  }
  return { balance, amount, chi: BigInt(input.chi), rate: BigInt(input.chiRate) };
}

/**
 * Null when spending `amount` XIAN with `chi` supplied fits the balance (or
 * the inputs are unknown); otherwise the fee and the most the call can spend.
 * The maximum keeps one more chi of fee, since a longer amount can cost one
 * chi more.
 */
export function nativeSpendShortfall(input: NativeSpendInput): NativeSpendShortfall | null {
  const spend = exactSpend(input);
  if (spend == null || spend.amount * spend.rate + spend.chi * UNITS_PER_XIAN <= spend.balance * spend.rate) {
    return null;
  }
  const spendable = spend.balance - feeUnits(spend.chi + 1n, spend.rate);
  const max = spendable > 0n ? spendable - (spendable % SUGGESTED_STEP) : 0n;
  return { fee: fixedText(feeUnits(spend.chi, spend.rate)), max: fixedText(max) };
}

export function nativeShortfallMessage(shortfall: NativeSpendShortfall): string {
  return shortfall.max === "0"
    ? `Your XIAN balance does not cover the network fee (${shortfall.fee} XIAN).`
    : `The amount plus the network fee (${shortfall.fee} XIAN) exceeds your XIAN balance. You can spend at most ${shortfall.max} XIAN.`;
}
