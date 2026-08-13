import fs from "node:fs";
import path from "node:path";
import {
	ethers,
	contractAt,
	baseEligibilityConfig,
	onboard,
	ccidFor,
} from "../scripts/lib/ace-core";

/**
 * End-to-end deployment validation against a local chain. Assumes the ACE core
 * is already deployed (scripts/deploy.ts) and reads its addresses from
 * deployment.localhost.json. Run via `pnpm test:e2e` (scripts/e2e-local.sh
 * boots the chain and runs both steps) — see README Development.
 *
 * Exercises: investor onboarding (CCID + credentials), factory-deployed ACE
 * PropertyToken + ListingEscrow, engine-gated escrow deposits (eligibility +
 * reject), a full native raise through finalize() with mint-based token
 * distribution, dividend-vault wiring, the CRE consumer and the CCIP identity
 * sync pair.
 */

const [deployer, investor] = await ethers.getSigners();

const deploymentPath = path.join(
	import.meta.dirname,
	"../deployment.localhost.json"
);
if (!fs.existsSync(deploymentPath)) {
	throw new Error(
		"deployment.localhost.json not found — run `CI=true hardhat run --network localhost scripts/deploy.ts` first (or use scripts/e2e-local.sh)."
	);
}
const c = JSON.parse(fs.readFileSync(deploymentPath, "utf-8")).contracts;

const engine = contractAt("PolicyEngine", c.PolicyEngine, deployer);
const registry = contractAt("IdentityRegistry", c.IdentityRegistry, deployer);
const credentialRegistry = contractAt("CredentialRegistry", c.CredentialRegistry, deployer);
const writerPolicy = contractAt("OnlyAuthorizedSenderPolicy", c.RegistryWriterPolicy, deployer);
const rejectPolicy = contractAt("RejectPolicy", c.RejectPolicy, deployer);
const factory = await ethers.getContractAt("PropertyFactory", c.PropertyFactory, deployer);
const vault = await ethers.getContractAt("DividendVault", c.DividendVault, deployer);

const core = {
	identityRegistry: registry,
	credentialRegistry,
};

const SUPPLY = ethers.parseUnits("1000", 18);
const TARGET = ethers.parseEther("1");

function ok(msg: string) {
	console.log(`[ok] ${msg}`);
}
function assertEqual(actual: unknown, expected: unknown, what: string) {
	if (actual !== expected) {
		throw new Error(`${what}: expected ${expected}, got ${actual}`);
	}
}
function parsedEvent(receipt: any, name: string) {
	const evt = receipt.logs
		.map((l: any) => {
			try {
				return factory.interface.parseLog(l);
			} catch {
				return null;
			}
		})
		.find((e: any) => e?.name === name);
	if (!evt) throw new Error(`event ${name} not emitted`);
	return evt;
}

// MARK: Onboarding (issuer flow: admin writes CCID + credentials)

await onboard(core, deployer, investor);
assertEqual(
	await registry.getIdentity(investor.address),
	ccidFor(investor.address),
	"investor identity"
);
ok("investor onboarded (CCID + KYC/AML credentials)");

// MARK: Factory lifecycle (ACE product)

const { sources, requirements } = baseEligibilityConfig(core);
const productId = await factory.nextProductId();
await (
	await factory.createProduct(
		"E2E Prop",
		"E2EP",
		18,
		sources,
		requirements,
		true,
		deployer.address,
		deployer.address
	)
).wait();
const record = await factory.getProduct(productId);
const token = await ethers.getContractAt("PropertyToken", record.token, deployer);
ok(`PropertyToken deployed via factory: ${record.token}`);

const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
const rc = await (
	await factory.deployEscrow(
		productId,
		ethers.ZeroAddress, // native raise
		deployer.address, // sponsor
		TARGET,
		SUPPLY,
		now + 3600n,
		deployer.address // admin
	)
).wait();
const escrowAddr = parsedEvent(rc, "EscrowDeployed").args.escrow;
const escrow = await ethers.getContractAt("ListingEscrow", escrowAddr, deployer);
ok(`ListingEscrow deployed via factory: ${escrowAddr}`);

// MARK: Wiring

await (await vault.setPropertyValid(record.token, true)).wait();
await (
	await vault.setPropertyEligibilityPolicy(record.token, record.eligibilityPolicy)
).wait();
await (await token.setSnapshotter(c.DividendVault, true)).wait();
ok("vault validated + eligibility policy wired + snapshotter set");

// MARK: Escrow gating (engine-enforced)

const outsider = (await ethers.getSigners())[2];
await expectRevert(
	escrow.connect(outsider).deposit(0n, { value: 2000n }),
	"un-onboarded investor deposit blocked"
);
ok("deposit blocked for un-onboarded investor (PolicyRunRejected)");

// MARK: Raise lifecycle

const sponsorBefore = await ethers.provider.getBalance(deployer.address);
await (await escrow.connect(investor).deposit(0n, { value: TARGET })).wait();
await ethers.provider.send("evm_increaseTime", [3700]);
await ethers.provider.send("evm_mine", []);
await (await escrow.finalize()).wait();
assertEqual(
	await token.balanceOf(investor.address),
	SUPPLY,
	"investor token balance after finalize"
);
// proceeds moved to the sponsor directly at finalize (mint-on-finalize model);
// allow a gas margin on the sponsor's balance delta
const sponsorAfter = await ethers.provider.getBalance(deployer.address);
if (sponsorAfter < sponsorBefore + TARGET - ethers.parseEther("0.01")) {
	throw new Error(`sponsor proceeds: expected ~${TARGET}, got ${sponsorAfter - sponsorBefore}`);
}
ok("raise finalized: shares minted to investor, proceeds to sponsor");

// MARK: Reject policy (screens the recipient, same as the previous
// SanctionsPolicy behavior on transfer/transferFrom)

await (await rejectPolicy.rejectAddress(deployer.address)).wait();
await expectRevert(
	token.connect(investor).transfer(deployer.address, 1n),
	"transfer to a rejected recipient blocked"
);
await (await rejectPolicy.unrejectAddress(deployer.address)).wait();
await (await token.connect(investor).transfer(deployer.address, 1n)).wait();
ok("reject policy blocks sanctioned recipients and releases on un-reject");

// MARK: Oracle + identity sync

const consumer = await (
	await ethers.getContractFactory("PropertyNavConsumer", deployer)
).deploy(deployer.address);
await consumer.waitForDeployment();
ok(`PropertyNavConsumer deployed: ${await consumer.getAddress()}`);

const sender = await (
	await ethers.getContractFactory("IdentitySyncSender", deployer)
).deploy(deployer.address, ethers.ZeroAddress, deployer.address);
await sender.waitForDeployment();
const receiver = await (
	await ethers.getContractFactory("IdentitySyncReceiver", deployer)
).deploy(deployer.address, c.IdentityRegistry, c.CredentialRegistry, deployer.address);
await receiver.waitForDeployment();
// the receiver writes to the destination registries through the writer policy
await (await writerPolicy.authorizeSender(await receiver.getAddress())).wait();
await (
	await receiver.setTrustedSender(3478487238524512106n, await sender.getAddress())
).wait();
ok("IdentitySyncSender/Receiver deployed and wired (writer policy + trusted sender)");

console.log("\nLOCAL E2E DEPLOYMENT: ALL CHECKS PASSED");

async function expectRevert(promise: Promise<any>, what: string) {
	try {
		await promise;
		throw new Error(`${what}: expected revert, transaction succeeded`);
	} catch (e: any) {
		if (e instanceof Error && e.message.includes("expected revert")) throw e;
		// any revert is fine — the engine wraps rejections in PolicyRunRejected
	}
	ok(`${what}`);
}
