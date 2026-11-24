export const VeilTenderPrivateStateId = "veilTenderPrivateState" as const;

export interface VeilTenderPrivateState {
  readonly secretKey: Uint8Array;
  readonly bidAmount: bigint | null;
  readonly bidSalt: Uint8Array | null;
  readonly auditMinBand: bigint | null;
  readonly auditMaxBand: bigint | null;
  readonly storedReceipt: {
    readonly amount: bigint;
    readonly salt: Uint8Array;
  } | null;
}

export function createInitialPrivateState(
  secretKey: Uint8Array,
): VeilTenderPrivateState {
  if (secretKey.length !== 32) {
    throw new Error("secretKey must be exactly 32 bytes");
  }
  return {
    secretKey: new Uint8Array(secretKey),
    bidAmount: null,
    bidSalt: null,
    auditMinBand: null,
    auditMaxBand: null,
    storedReceipt: null,
  };
}

type WitnessCtx = { readonly privateState: VeilTenderPrivateState };

export const veilTenderWitnesses = {
  local_secret_key: (ctx: WitnessCtx): [VeilTenderPrivateState, Uint8Array] => [
    ctx.privateState,
    ctx.privateState.secretKey,
  ],

  get_bid_amount: (ctx: WitnessCtx): [VeilTenderPrivateState, bigint] => {
    if (ctx.privateState.bidAmount === null) {
      throw new Error("Bid amount is not set in local private state");
    }
    return [ctx.privateState, ctx.privateState.bidAmount];
  },

  get_bid_salt: (ctx: WitnessCtx): [VeilTenderPrivateState, Uint8Array] => {
    if (ctx.privateState.bidSalt === null) {
      throw new Error("Bid salt is not set in local private state");
    }
    return [ctx.privateState, ctx.privateState.bidSalt];
  },

  get_audit_band: (
    ctx: WitnessCtx,
  ): [VeilTenderPrivateState, [bigint, bigint]] => {
    const { auditMinBand, auditMaxBand } = ctx.privateState;
    if (auditMinBand === null || auditMaxBand === null) {
      throw new Error("Compliance audit band is not set in private state");
    }
    return [ctx.privateState, [auditMinBand, auditMaxBand]];
  },

  store_bid_receipt: (
    ctx: WitnessCtx,
    amt: bigint,
    salt: Uint8Array,
  ): [VeilTenderPrivateState, []] => [
    {
      ...ctx.privateState,
      bidAmount: amt,
      bidSalt: new Uint8Array(salt),
      storedReceipt: {
        amount: amt,
        salt: new Uint8Array(salt),
      },
    },
    [],
  ],
};
