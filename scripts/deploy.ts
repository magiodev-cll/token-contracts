// ┌───────────────────────────────────────────────────────────────────────────┐
// │  UNREVIEWED PROOF OF CONCEPT -- DO NOT USE IN PRODUCTION.                 │
// │                                                                           │
// │  THIS CODE HAS NOT BEEN AUDITED AND HAS NOT BEEN REVIEWED FOR SECURITY.   │
// │  IT IS DEPLOYED ON A TEST NETWORK FOR INTEGRATION TESTING AND DEVELOPMENT │
// │  PURPOSES ONLY. IT IS NOT SUITABLE FOR PRODUCTION USE, AND IT MUST NOT BE │
// │  USED TO HOLD OR MOVE ANY ASSET OF VALUE.                                 │
// └───────────────────────────────────────────────────────────────────────────┘
// Own-infra deployment. Commertize ships only its own contracts via hardhat:
// extractor contracts, policy implementation contracts, the PropertyFactory
// and the PropertyToken implementation. Everything ACE-owned (PolicyEngine,
// registries, policy instances, policy attachment) is created through the ACE
// Coordinator API by scripts/configure-ace.ts — see scripts/ace-configuration.json.
//
// Two phases, driven by DEPLOY_PHASE (hardhat `run` takes no positional args):
//   DEPLOY_PHASE=extractors   deploy the extractor + policy implementation
//                             contracts and record their addresses in the
//                             manifest (required before configure-ace apply)
//   DEPLOY_PHASE=factory      deploy the PropertyToken implementation and
//                             PropertyFactory, wired to the engine and
//                             RejectPolicy instance the API created
import fs from "node:fs";
import path from "node:path";
import hre from "hardhat";
import { aceFactory } from "./lib/ace-core";

const ZERO = `0x${"0".repeat(40)}`;

function invariant(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const phase = process.env.DEPLOY_PHASE ?? "";
invariant(["extractors", "factory"].includes(phase), "DEPLOY_PHASE must be 'extractors' or 'factory'");

const { ethers } = await hre.network.getOrCreate();
const manifestFile = path.join(import.meta.dirname, "ace-configuration.json");
const manifest: any = JSON.parse(await fs.promises.readFile(manifestFile, "utf8"));

async function writeManifest() {
	await fs.promises.writeFile(manifestFile, JSON.stringify(manifest, null, "\t") + "\n");
	console.log(`NEXT  manifest updated: ${manifestFile}`);
}

const [deployer] = await ethers.getSigners();
console.log(`Deploying from ${deployer.address}`);

if (phase === "extractors") {
	// Extractor contracts (stock + custom escrow extractor)
	const [transferExtractor, mintBurnExtractor, accountExtractor] = await Promise.all([
		(await aceFactory("ERC20TransferExtractor")).deploy(),
		(await aceFactory("ERC3643MintBurnExtractor")).deploy(),
		(await ethers.getContractFactory("AccountExtractor")).deploy(),
	]);
	await Promise.all([
		transferExtractor.waitForDeployment(),
		mintBurnExtractor.waitForDeployment(),
		accountExtractor.waitForDeployment(),
	]);
	console.log(`OK    ERC20TransferExtractor        ${transferExtractor.target}`);
	console.log(`OK    ERC3643MintBurnExtractor      ${mintBurnExtractor.target}`);
	console.log(`OK    AccountExtractor              ${accountExtractor.target}`);

	// Policy implementation contracts (recorded in the API, instantiated per policy)
	const [eligibilityImpl, senderImpl, rejectImpl] = await Promise.all([
		(await aceFactory("CredentialRegistryIdentityValidatorPolicy")).deploy(),
		(await aceFactory("OnlyAuthorizedSenderPolicy")).deploy(),
		(await aceFactory("RejectPolicy")).deploy(),
	]);
	await Promise.all([
		eligibilityImpl.waitForDeployment(),
		senderImpl.waitForDeployment(),
		rejectImpl.waitForDeployment(),
	]);
	console.log(`OK    CredentialRegistryIdentityValidatorPolicy impl ${eligibilityImpl.target}`);
	console.log(`OK    OnlyAuthorizedSenderPolicy impl                ${senderImpl.target}`);
	console.log(`OK    RejectPolicy impl                              ${rejectImpl.target}`);

	manifest.extractors.find((item: any) => item.id === "erc20-transfer").address = transferExtractor.target;
	manifest.extractors.find((item: any) => item.id === "erc3643-mint-burn").address = mintBurnExtractor.target;
	manifest.extractors.find((item: any) => item.id === "escrow-account").address = accountExtractor.target;
	manifest.policyImplementations.find((item: any) => item.id === "credential-registry-identity-validator").address = eligibilityImpl.target;
	manifest.policyImplementations.find((item: any) => item.id === "only-authorized-sender").address = senderImpl.target;
	manifest.policyImplementations.find((item: any) => item.id === "reject").address = rejectImpl.target;
	await writeManifest();
	return;
}

// Phase: factory — requires the API-created engine and RejectPolicy instance
const engineAddress = manifest.outputs?.engine?.address ?? ZERO;
const rejectPolicyAddress = manifest.outputs?.policies?.["reject-list"]?.address ?? ZERO;
invariant(engineAddress !== ZERO, "outputs.engine.address is empty — run configure-ace apply first (the API deploys the PolicyEngine)");
invariant(rejectPolicyAddress !== ZERO, "outputs.policies['reject-list'].address is empty — run configure-ace apply first");
const eligibilityImpl = manifest.policyImplementations.find((item: any) => item.id === "credential-registry-identity-validator");
const senderImpl = manifest.policyImplementations.find((item: any) => item.id === "only-authorized-sender");
invariant(eligibilityImpl?.address && eligibilityImpl.address !== ZERO, "eligibility implementation not deployed (run DEPLOY_PHASE=extractors first)");
invariant(senderImpl?.address && senderImpl.address !== ZERO, "sender policy implementation not deployed (run DEPLOY_PHASE=extractors first)");

const tokenImplementation = await (await ethers.getContractFactory("PropertyToken")).deploy();
await tokenImplementation.waitForDeployment();
console.log(`OK    PropertyToken implementation   ${tokenImplementation.target}`);

const factory = await (
	await ethers.getContractFactory("PropertyFactory")
).deploy(
	deployer.address,
	engineAddress,
	rejectPolicyAddress,
	tokenImplementation.target,
	eligibilityImpl.address,
	senderImpl.address
);
await factory.waitForDeployment();
console.log(`OK    PropertyFactory               ${factory.target}`);

manifest.outputs.factory = factory.target;
manifest.outputs.tokenImplementation = tokenImplementation.target;
await writeManifest();
