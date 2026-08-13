// ┌───────────────────────────────────────────────────────────────────────────┐
// │  UNREVIEWED PROOF OF CONCEPT -- DO NOT USE IN PRODUCTION.                 │
// │                                                                           │
// │  THIS CODE HAS NOT BEEN AUDITED AND HAS NOT BEEN REVIEWED FOR SECURITY.   │
// │  IT IS DEPLOYED ON A TEST NETWORK FOR INTEGRATION TESTING AND DEVELOPMENT │
// │  PURPOSES ONLY. IT IS NOT SUITABLE FOR PRODUCTION USE, AND IT MUST NOT BE │
// │  USED TO HOLD OR MOVE ANY ASSET OF VALUE.                                 │
// │                                                                           │
// │  PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND. USE AT YOUR OWN RISK.    │
// └───────────────────────────────────────────────────────────────────────────┘
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import hre from "hardhat";

export const { ethers } = await hre.network.getOrCreate();

// Credential types (chainlink-ace convention: common. prefix)
export const KYC = () => ethers.keccak256(ethers.toUtf8Bytes("common.kyc"));
export const AML = () => ethers.keccak256(ethers.toUtf8Bytes("common.aml"));
export const ACCREDITED = () => ethers.keccak256(ethers.toUtf8Bytes("common.accredited"));

export const sel = (sig: string) => ethers.id(sig).slice(0, 10);

// Hardhat 3 emits artifacts only for the project's own sources; @chainlink/ace
// contracts (compiled as npm dependencies) are reachable through the build-info
// output instead. Read ABIs + bytecode from there so deploy tooling can deploy
// them.
const buildInfoDir = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"artifacts",
	"build-info"
);

const npmContracts: Record<string, { abi: any[]; bytecode: string }> = {};
for (const f of fs.readdirSync(buildInfoDir)) {
	if (!f.endsWith(".output.json")) continue;
	const output = JSON.parse(
		fs.readFileSync(path.join(buildInfoDir, f), "utf8")
	).output;
	for (const [sourceName, contracts] of Object.entries(output.contracts)) {
		for (const [name, c] of Object.entries(contracts as any)) {
			npmContracts[name] = {
				abi: c.abi,
				bytecode: c.evm.bytecode.object,
			};
		}
	}
}

let signer: any;

export async function aceFactory(name: string) {
	const entry = npmContracts[name];
	if (!entry) throw new Error(`build-info artifact not found: ${name}`);
	if (!signer) {
		[signer] = await ethers.getSigners();
	}
	return new ethers.ContractFactory(entry.abi, entry.bytecode, signer);
}

/** Attaches an @chainlink/ace contract by its build-info ABI. */
export function contractAt(name: string, address: string, runner?: any) {
	const entry = npmContracts[name];
	if (!entry) throw new Error(`build-info artifact not found: ${name}`);
	return new ethers.Contract(address, entry.abi, runner);
}

// Deterministic wallet -> CCID mapping used by the onboarding flow.
export const ccidFor = (address: string) => ethers.zeroPadValue(address, 32);

export async function deployProxy(implementation: any, initData: string, contractName: string) {
	const Proxy = await aceFactory("ERC1967Proxy");
	const proxy = await Proxy.deploy(await implementation.getAddress(), initData);
	await proxy.waitForDeployment();
	const Contract = await aceFactory(contractName);
	return Contract.attach(await proxy.getAddress());
}

export interface AceCore {
	engine: any;
	identityRegistry: any;
	credentialRegistry: any;
	writerPolicy: any;
	rejectPolicy: any;
	factory: any;
}

/**
 * Deploys the shared ACE core: PolicyEngine, IdentityRegistry,
 * CredentialRegistry, extractors, the registry writer policy (admin
 * authorized), the RejectPolicy denylist and the PropertyFactory.
 * Mirrors the target production deploy flow.
 */
export async function deployAceCore(admin: any): Promise<AceCore> {
	const PolicyEngine = await aceFactory("PolicyEngine");
	const engine = await deployProxy(
		await PolicyEngine.deploy(),
		PolicyEngine.interface.encodeFunctionData("initialize", [true, admin.address]),
		"PolicyEngine"
	);

	const IdentityRegistry = await aceFactory("IdentityRegistry");
	const identityRegistry = await deployProxy(
		await IdentityRegistry.deploy(),
		IdentityRegistry.interface.encodeFunctionData("initialize", [engine.target, admin.address]),
		"IdentityRegistry"
	);

	const CredentialRegistry = await aceFactory("CredentialRegistry");
	const credentialRegistry = await deployProxy(
		await CredentialRegistry.deploy(),
		CredentialRegistry.interface.encodeFunctionData("initialize", [engine.target, admin.address]),
		"CredentialRegistry"
	);

	// Extractors for the selectors that preserve investor-eligibility checks.
	const ERC20TransferExtractor = await aceFactory("ERC20TransferExtractor");
	const transferExtractor = await ERC20TransferExtractor.deploy();
	await transferExtractor.waitForDeployment();
	const ERC3643MintBurnExtractor = await aceFactory("ERC3643MintBurnExtractor");
	const mintBurnExtractor = await ERC3643MintBurnExtractor.deploy();
	await mintBurnExtractor.waitForDeployment();

	await engine.setExtractor(sel("transfer(address,uint256)"), transferExtractor.target);
	await engine.setExtractor(sel("transferFrom(address,address,uint256)"), transferExtractor.target);
	await engine.setExtractor(sel("mint(address,uint256)"), mintBurnExtractor.target);

	// Writer policy: only authorized senders can mutate the registries.
	const OnlyAuthorizedSenderPolicy = await aceFactory("OnlyAuthorizedSenderPolicy");
	const writerPolicy = await deployProxy(
		await OnlyAuthorizedSenderPolicy.deploy(),
		OnlyAuthorizedSenderPolicy.interface.encodeFunctionData("initialize", [engine.target, admin.address, "0x"]),
		"OnlyAuthorizedSenderPolicy"
	);
	await writerPolicy.authorizeSender(admin.address);

	const emptyParams: string[] = [];
	const registryWrites: [string, string][] = [
		[identityRegistry.target, "registerIdentity(bytes32,address,bytes)"],
		[identityRegistry.target, "registerIdentities(bytes32[],address[],bytes)"],
		[identityRegistry.target, "removeIdentity(bytes32,address,bytes)"],
		[credentialRegistry.target, "registerCredential(bytes32,bytes32,uint40,bytes,bytes)"],
		[credentialRegistry.target, "registerCredentials(bytes32,bytes32[],uint40,bytes[],bytes)"],
		[credentialRegistry.target, "renewCredential(bytes32,bytes32,uint40,bytes)"],
		[credentialRegistry.target, "removeCredential(bytes32,bytes32,bytes)"],
	];
	for (const [target, sig] of registryWrites) {
		await engine.addPolicy(target, sel(sig), writerPolicy.target, emptyParams);
	}

	// Sanctions screening: stock RejectPolicy (denylist managed by its owner,
	// the admin in this PoC — a sanctions provider would hold ownership).
	const RejectPolicy = await aceFactory("RejectPolicy");
	const rejectPolicy = await deployProxy(
		await RejectPolicy.deploy(),
		RejectPolicy.interface.encodeFunctionData("initialize", [engine.target, admin.address, "0x"]),
		"RejectPolicy"
	);

	// Implementations are deployed once and shared by every product proxy.
	const PropertyToken = await aceFactory("PropertyToken");
	const tokenImplementation = await PropertyToken.deploy();
	await tokenImplementation.waitForDeployment();
	const CredentialRegistryIdentityValidatorPolicy = await aceFactory(
		"CredentialRegistryIdentityValidatorPolicy"
	);
	const eligibilityImplementation = await CredentialRegistryIdentityValidatorPolicy.deploy();
	await eligibilityImplementation.waitForDeployment();
	const SenderPolicy = await aceFactory("OnlyAuthorizedSenderPolicy");
	const senderPolicyImplementation = await SenderPolicy.deploy();
	await senderPolicyImplementation.waitForDeployment();

	const PropertyFactory = await aceFactory("PropertyFactory");
	const factory = await PropertyFactory.deploy(
		admin.address,
		engine.target,
		rejectPolicy.target,
		tokenImplementation.target,
		eligibilityImplementation.target,
		senderPolicyImplementation.target
	);
	await factory.waitForDeployment();
	await engine.grantRole(await engine.ADMIN_ROLE(), factory.target);

	return {
		engine,
		identityRegistry,
		credentialRegistry,
		writerPolicy,
		rejectPolicy,
		factory,
	};
}

export interface Credentials {
	kyc?: boolean;
	aml?: boolean;
	accredited?: boolean;
	expiresAt?: bigint; // 0 = never expires
}

/**
 * Onboards an investor: registers the wallet -> CCID mapping and issues the
 * requested credentials. Mirrors the issuer flow (admin as the authorized
 * writer in tests; in production the credential issuer EOA/backend holds that
 * authorization).
 */
export async function onboard(
	core: AceCore,
	admin: any,
	investor: any,
	creds: Credentials = {}
) {
	const ccid = ccidFor(investor.address);
	await core.identityRegistry
		.connect(admin)
		.registerIdentity(ccid, investor.address, "0x");

	if (creds.kyc ?? true) {
		await core.credentialRegistry
			.connect(admin)
			.registerCredential(ccid, KYC(), creds.expiresAt ?? 0n, "0x", "0x");
	}
	if (creds.aml ?? true) {
		await core.credentialRegistry
			.connect(admin)
			.registerCredential(ccid, AML(), creds.expiresAt ?? 0n, "0x", "0x");
	}
	if (creds.accredited ?? false) {
		await core.credentialRegistry
			.connect(admin)
			.registerCredential(ccid, ACCREDITED(), creds.expiresAt ?? 0n, "0x", "0x");
	}
}

/**
 * Eligibility configuration for a base product: KYC + AML sources and
 * requirements against the shared registries.
 */
export function baseEligibilityConfig(
	core: { identityRegistry: any; credentialRegistry: any },
	requireAccredited = false
) {
	const source = (type: string) => ({
		credentialTypeId: type,
		identityRegistry: core.identityRegistry.target,
		credentialRegistry: core.credentialRegistry.target,
		dataValidator: ethers.ZeroAddress,
	});
	const sources = [source(KYC()), source(AML())];
	if (requireAccredited) sources.push(source(ACCREDITED()));

	const requirement = (id: string, type: string) => ({
		requirementId: ethers.keccak256(ethers.toUtf8Bytes(id)),
		credentialTypeIds: [type],
		minValidations: 1n,
		invert: false,
	});
	const requirements = [requirement("commertize.requirement.kyc", KYC()), requirement("commertize.requirement.aml", AML())];
	if (requireAccredited) requirements.push(requirement("commertize.requirement.accredited", ACCREDITED()));

	return { sources, requirements };
}
