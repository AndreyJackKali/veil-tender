import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MANAGED_DIR = path.resolve(__dirname, "../contract/src/managed/veil_tender");

const EXPECTED_CIRCUITS = [
  "lock_compliance_policy",
  "submit_sealed_bid",
  "close_bidding",
  "reveal_bid",
  "finalize_award",
  "prove_compliance_band",
  "settle_tender",
  "cancel_tender",
];

const fileSha256 = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

function readReceiptInput(argPath) {
  if (argPath && argPath !== "-") {
    return fs.readFileSync(argPath, "utf8");
  }
  return fs.readFileSync(0, "utf8");
}

function main() {
  const inputPath = process.argv[2];
  const raw = readReceiptInput(inputPath);
  const receipt = JSON.parse(raw);

  const checks = [];
  const check = (name, ok, detail) => {
    checks.push({ name, ok: Boolean(ok), detail });
  };

  check(
    "schema_version",
    receipt.schema === "veiltender.auditor_receipt.v2" || receipt.schema === "veiltender.auditor_receipt.v1",
    `schema=${receipt.schema}`,
  );

  // 1. Recompute canonical SHA-256 digest over receipt body (excluding receiptSha256)
  const { receiptSha256, ...body } = receipt;
  const recomputed = "0x" + crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex");
  check(
    "receipt_sha256_integrity",
    typeof receiptSha256 === "string" && receiptSha256.toLowerCase() === recomputed.toLowerCase(),
    `expected=${recomputed.slice(0, 18)}... got=${String(receiptSha256).slice(0, 18)}...`,
  );

  // 2. Lifecycle & privacy invariants
  check("phase_settled", receipt.phase === "settled", `phase=${receipt.phase}`);
  check("compliance_attested", receipt.complianceOk === true, `complianceOk=${receipt.complianceOk}`);
  check(
    "policy_commitment_locked",
    receipt.policyLocked === true && typeof receipt.policyCommitment === "string" && receipt.policyCommitment.length === 66,
    `policyLocked=${receipt.policyLocked} commit=${String(receipt.policyCommitment).slice(0, 18)}...`,
  );

  const inv = receipt.privacyInvariants || {};
  check(
    "privacy_invariants",
    inv.zeroLeakageDuringSealedPhase === true &&
      inv.privatePolicyBoundsDisclosedOnChain === false &&
      inv.bidderSaltsDisclosedOnChain === false &&
      inv.policySaltDisclosedOnChain === false,
    JSON.stringify(inv),
  );

  // 3. Cross-check compiled Compact 0.36.1 ZKIR/BZKIR artifacts on disk
  const byName = new Map((receipt.compiledCircuits || []).map((c) => [c.circuit, c]));
  check(
    "all_8_circuits_present",
    EXPECTED_CIRCUITS.every((c) => byName.has(c)),
    `found=${byName.size}/${EXPECTED_CIRCUITS.length}`,
  );

  for (const name of EXPECTED_CIRCUITS) {
    const entry = byName.get(name);
    const zkirPath = path.join(MANAGED_DIR, "zkir", `${name}.zkir`);
    const bzkirPath = path.join(MANAGED_DIR, "zkir", `${name}.bzkir`);
    if (!entry || !fs.existsSync(zkirPath) || !fs.existsSync(bzkirPath)) {
      check(`circuit_${name}`, false, "missing entry or compiled artifact");
      continue;
    }
    const zkirActual = fileSha256(zkirPath);
    const bzkirActual = fileSha256(bzkirPath);
    const matches =
      entry.zkirSha256 === zkirActual &&
      entry.bzkirSha256 === bzkirActual &&
      entry.zkirBytes === fs.statSync(zkirPath).size &&
      entry.bzkirBytes === fs.statSync(bzkirPath).size;
    check(`circuit_${name}`, matches, `zkir=${zkirActual.slice(0, 12)}... bzkir=${bzkirActual.slice(0, 12)}...`);
  }

  const failed = checks.filter((c) => !c.ok);
  const summary = {
    verified: failed.length === 0,
    passed: checks.length - failed.length,
    total: checks.length,
    receiptSha256: recomputed,
    checks,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (failed.length > 0) {
    process.exit(1);
  }
}

main();
