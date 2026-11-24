import {
  type ChargedState,
  type CircuitContext,
  createCircuitContext,
  createConstructorContext,
  sampleContractAddress,
} from "@midnight-ntwrk/compact-runtime";
import {
  Contract,
  type Ledger,
  TenderPhase,
  type Witnesses,
  ledger,
  pureCircuits,
} from "../managed/veil_tender/contract/index.js";
import {
  type VeilTenderPrivateState,
  createInitialPrivateState,
  veilTenderWitnesses,
} from "../witnesses.js";

export { TenderPhase, pureCircuits };

export interface ActorSession {
  readonly label: string;
  privateState: VeilTenderPrivateState;
  readonly coinPublicKey: string;
}

/**
 * Multi-party Midnight dual-ledger simulator for VeilTender.
 * Runs the compiled Compact circuits directly via `@midnight-ntwrk/compact-runtime`,
 * preserving strict separation between shared public ledger state and per-actor private state.
 */
export class VeilTenderSimulator {
  private readonly contract: Contract<VeilTenderPrivateState>;
  private readonly contractAddress: string;
  private sharedState!: ChargedState;
  public readonly issuer: ActorSession;
  private readonly actors = new Map<string, ActorSession>();

  private constructor(
    issuerKey: Uint8Array,
    issuerCoinPk: string,
  ) {
    this.contract = new Contract<VeilTenderPrivateState>(
      veilTenderWitnesses as unknown as Witnesses<VeilTenderPrivateState>,
    );
    this.contractAddress = sampleContractAddress();
    this.issuer = {
      label: "issuer",
      privateState: createInitialPrivateState(issuerKey),
      coinPublicKey: issuerCoinPk,
    };
    this.actors.set("issuer", this.issuer);
  }

  static async create(
    tenderId: Uint8Array,
    reserveCap: bigint,
    issuerKey: Uint8Array = new Uint8Array(32).fill(0x01),
  ): Promise<VeilTenderSimulator> {
    const sim = new VeilTenderSimulator(issuerKey, "0".repeat(64));
    const init = await sim.contract.initialState(
      createConstructorContext(sim.issuer.privateState, sim.issuer.coinPublicKey),
      tenderId,
      reserveCap,
    );
    sim.issuer.privateState = init.currentPrivateState;
    sim.sharedState = init.currentContractState.data;
    return sim;
  }

  registerBidder(label: string, secretKey: Uint8Array): ActorSession {
    const idx = this.actors.size.toString(16).padStart(64, "0");
    const actor: ActorSession = {
      label,
      privateState: createInitialPrivateState(secretKey),
      coinPublicKey: idx,
    };
    this.actors.set(label, actor);
    return actor;
  }

  getLedger(): Ledger {
    return ledger(this.sharedState);
  }

  private ctxFor(
    circuitId: string,
    actor: ActorSession,
  ): CircuitContext<VeilTenderPrivateState> {
    return createCircuitContext({
      circuitId,
      contractAddress: this.contractAddress,
      coinPublicKeyOrZswapState: actor.coinPublicKey,
      contractState: this.sharedState,
      privateState: actor.privateState,
    });
  }

  private applyResult(
    actor: ActorSession,
    res: { context: CircuitContext<VeilTenderPrivateState> },
  ): Ledger {
    if (res.context.callContext.currentPrivateState !== undefined) {
      actor.privateState = res.context.callContext.currentPrivateState;
    }
    this.sharedState = res.context.callContext.currentQueryContext.state;
    return this.getLedger();
  }

  async submitSealedBid(
    actor: ActorSession,
    amount: bigint,
    salt: Uint8Array,
  ): Promise<Ledger> {
    actor.privateState = {
      ...actor.privateState,
      bidAmount: amount,
      bidSalt: new Uint8Array(salt),
    };
    const res = await this.contract.impureCircuits.submit_sealed_bid(
      this.ctxFor("submit_sealed_bid", actor),
    );
    return this.applyResult(actor, res);
  }

  async closeBidding(actor: ActorSession = this.issuer): Promise<Ledger> {
    const res = await this.contract.impureCircuits.close_bidding(
      this.ctxFor("close_bidding", actor),
    );
    return this.applyResult(actor, res);
  }

  async revealBid(
    actor: ActorSession,
    overrideAmount?: bigint,
    overrideSalt?: Uint8Array,
  ): Promise<Ledger> {
    if (overrideAmount !== undefined || overrideSalt !== undefined) {
      actor.privateState = {
        ...actor.privateState,
        bidAmount: overrideAmount ?? actor.privateState.bidAmount,
        bidSalt: overrideSalt ? new Uint8Array(overrideSalt) : actor.privateState.bidSalt,
      };
    }
    const res = await this.contract.impureCircuits.reveal_bid(
      this.ctxFor("reveal_bid", actor),
    );
    return this.applyResult(actor, res);
  }

  async finalizeAward(actor: ActorSession = this.issuer): Promise<Ledger> {
    const res = await this.contract.impureCircuits.finalize_award(
      this.ctxFor("finalize_award", actor),
    );
    return this.applyResult(actor, res);
  }

  async proveComplianceBand(
    actor: ActorSession,
    minBand: bigint,
    maxBand: bigint,
  ): Promise<Ledger> {
    actor.privateState = {
      ...actor.privateState,
      auditMinBand: minBand,
      auditMaxBand: maxBand,
    };
    const res = await this.contract.impureCircuits.prove_compliance_band(
      this.ctxFor("prove_compliance_band", actor),
    );
    return this.applyResult(actor, res);
  }

  async settleTender(actor: ActorSession = this.issuer): Promise<Ledger> {
    const res = await this.contract.impureCircuits.settle_tender(
      this.ctxFor("settle_tender", actor),
    );
    return this.applyResult(actor, res);
  }

  async cancelTender(actor: ActorSession = this.issuer): Promise<Ledger> {
    const res = await this.contract.impureCircuits.cancel_tender(
      this.ctxFor("cancel_tender", actor),
    );
    return this.applyResult(actor, res);
  }
}
