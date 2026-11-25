import type * as __compactRuntime from '@midnight-ntwrk/compact-runtime';

export enum TenderPhase { open = 0,
                          revealing = 1,
                          awarded = 2,
                          settled = 3,
                          cancelled = 4
}

export type Witnesses<PS> = {
  local_secret_key(context: __compactRuntime.WitnessContext<Ledger, PS>): [PS, Uint8Array];
  get_bid_amount(context: __compactRuntime.WitnessContext<Ledger, PS>): [PS, bigint];
  get_bid_salt(context: __compactRuntime.WitnessContext<Ledger, PS>): [PS, Uint8Array];
  get_audit_band(context: __compactRuntime.WitnessContext<Ledger, PS>): [PS, bigint[]];
  get_policy_salt(context: __compactRuntime.WitnessContext<Ledger, PS>): [PS, Uint8Array];
  store_bid_receipt(context: __compactRuntime.WitnessContext<Ledger, PS>,
                    amt_0: bigint,
                    salt_0: Uint8Array): [PS, []];
}

export type ImpureCircuits<PS> = {
  lock_compliance_policy(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, []>>;
  submit_sealed_bid(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, []>>;
  close_bidding(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, []>>;
  reveal_bid(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, []>>;
  finalize_award(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, []>>;
  prove_compliance_band(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, []>>;
  settle_tender(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, []>>;
  cancel_tender(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, []>>;
}

export type ProvableCircuits<PS> = {
  lock_compliance_policy(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, []>>;
  submit_sealed_bid(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, []>>;
  close_bidding(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, []>>;
  reveal_bid(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, []>>;
  finalize_award(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, []>>;
  prove_compliance_band(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, []>>;
  settle_tender(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, []>>;
  cancel_tender(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, []>>;
}

export type PureCircuits = {
  derive_pk(sk_0: Uint8Array): Uint8Array;
  make_bid_commitment(tid_0: Uint8Array,
                      bidder_pk_0: Uint8Array,
                      amount_0: bigint,
                      salt_0: Uint8Array): Uint8Array;
  make_policy_commitment(tid_0: Uint8Array,
                         min_band_0: bigint,
                         max_band_0: bigint,
                         policy_salt_0: Uint8Array): Uint8Array;
}

export type Circuits<PS> = {
  derive_pk(context: __compactRuntime.CircuitContext<PS>, sk_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, Uint8Array>>;
  make_bid_commitment(context: __compactRuntime.CircuitContext<PS>,
                      tid_0: Uint8Array,
                      bidder_pk_0: Uint8Array,
                      amount_0: bigint,
                      salt_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, Uint8Array>>;
  make_policy_commitment(context: __compactRuntime.CircuitContext<PS>,
                         tid_0: Uint8Array,
                         min_band_0: bigint,
                         max_band_0: bigint,
                         policy_salt_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, Uint8Array>>;
  lock_compliance_policy(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, []>>;
  submit_sealed_bid(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, []>>;
  close_bidding(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, []>>;
  reveal_bid(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, []>>;
  finalize_award(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, []>>;
  prove_compliance_band(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, []>>;
  settle_tender(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, []>>;
  cancel_tender(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, []>>;
}

export type Ledger = {
  readonly phase: TenderPhase;
  readonly tender_id: Uint8Array;
  readonly issuer_pk: Uint8Array;
  readonly reserve_cap: bigint;
  readonly bid_count: bigint;
  readonly reveal_count: bigint;
  readonly slot0_used: boolean;
  readonly slot1_used: boolean;
  readonly slot2_used: boolean;
  readonly slot0_bidder: Uint8Array;
  readonly slot1_bidder: Uint8Array;
  readonly slot2_bidder: Uint8Array;
  readonly slot0_commit: Uint8Array;
  readonly slot1_commit: Uint8Array;
  readonly slot2_commit: Uint8Array;
  readonly slot0_revealed: boolean;
  readonly slot1_revealed: boolean;
  readonly slot2_revealed: boolean;
  readonly has_winner: boolean;
  readonly winner_pk: Uint8Array;
  readonly winning_bid: bigint;
  readonly policy_locked: boolean;
  readonly policy_commitment: Uint8Array;
  readonly compliance_hash: Uint8Array;
  readonly compliance_ok: boolean;
}

export declare class Contract<PS = any, W extends Witnesses<PS> = Witnesses<PS>> {
  witnesses: W;
  circuits: Circuits<PS>;
  impureCircuits: ImpureCircuits<PS>;
  provableCircuits: ProvableCircuits<PS>;
  constructor(witnesses: W);
  initialState(context: __compactRuntime.ConstructorContext<PS>,
               tid_0: Uint8Array,
               cap_0: bigint): Promise<__compactRuntime.ConstructorResult<PS>>;
}

export declare function ledger(state: __compactRuntime.StateValue | __compactRuntime.ChargedState): Ledger;
export declare const pureCircuits: PureCircuits;
export declare const expectedVk: Record<string, string>;
export declare const circuitSignatures: __compactRuntime.CircuitSignatures;
export declare const declaredInterfaces: __compactRuntime.DeclaredInterfaces;
