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

const { ethers } = await hre.network.connect();

// Credential types (chainlink-ace convention: common. prefix)
export const KYC = () => ethers.keccak256(ethers.toUtf8Bytes("common.kyc"));
export const AML = () => ethers.keccak256(ethers.toUtf8Bytes("common.aml"));
export const ACCREDITED = () => ethers.keccak256(ethers.toUtf8Bytes("common.accredited"));

export const sel = (sig: string) => ethers.id(sig).slice(0, 10);

// Hardhat 3 emits artifacts only for the project's own sources; @chainlink/ace
// contracts (compiled as npm dependencies) are reachable through the build-info
// output instead. Read ABIs + bytecode from there so tests can deploy them.
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

async function aceFactory(name: string) {
	const entry = npmContracts[name];
	if (!entry) throw new Error(`build-info artifact not found: ${name}`);
	if (!signer) {
		[signer] = await ethers.getSigners();
	}
	return new ethers.ContractFactory(entry.abi, entry.bytecode, signer);
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

async function deploy(name: string, ...args: any[]) {
	const factory = await aceFactory(name);
	const contract = await factory.deploy(...args);
	await contract.waitForDeployment();
	return contract;
}

export interface AceCore {
	engine: any;
	identityRegistry: any;
	credentialRegistry: any;
	writerPolicy: any;
	sanctionsList: any;
	sanctionsPolicy: any;
	factory: any;
}

/**
 * Deploys the shared ACE core: PolicyEngine, IdentityRegistry,
 * CredentialRegistry, TrustedIssuerRegistry, extractors, the registry writer
 * policy (admin authorized), the sanctions stack and the PropertyFactory.
 * Mirrors script/ace/DeployAceCore.ts.
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

	// Sanctions: list owned by the admin (a sanctions provider would own it
	// independently); shared policy referenced by every product.
	const SanctionsList = await aceFactory("SanctionsList");
	const sanctionsList = await SanctionsList.deploy();
	await sanctionsList.waitForDeployment();

	const SanctionsPolicy = await aceFactory("SanctionsPolicy");
	const sanctionsPolicy = await deployProxy(
		await SanctionsPolicy.deploy(),
		SanctionsPolicy.interface.encodeFunctionData(
			"initialize",
			[
				engine.target,
				admin.address,
				ethers.AbiCoder.defaultAbiCoder().encode(["address"], [sanctionsList.target]),
			]
		),
		"SanctionsPolicy"
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
	const GroupedIdentityValidatorPolicy = await aceFactory("GroupedIdentityValidatorPolicy");
	const groupedImplementation = await GroupedIdentityValidatorPolicy.deploy();
	await groupedImplementation.waitForDeployment();
	const SenderPolicy = await aceFactory("OnlyAuthorizedSenderPolicy");
	const senderPolicyImplementation = await SenderPolicy.deploy();
	await senderPolicyImplementation.waitForDeployment();

	const PropertyFactory = await aceFactory("PropertyFactory");
	const factory = await PropertyFactory.deploy(
		admin.address,
		engine.target,
		sanctionsPolicy.target,
		tokenImplementation.target,
		eligibilityImplementation.target,
		groupedImplementation.target,
		senderPolicyImplementation.target
	);
	await factory.waitForDeployment();
	await engine.grantRole(await engine.ADMIN_ROLE(), factory.target);

	return {
		engine,
		identityRegistry,
		credentialRegistry,
		writerPolicy,
		sanctionsList,
		sanctionsPolicy,
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
 * Creates a product and attaches its token contract.
 */
export async function createProduct(
	core: AceCore,
	admin: any,
	opts: {
		name?: string;
		symbol?: string;
		requireAccredited?: boolean;
		mintRequiresEligibility?: boolean;
		grouped?: boolean;
		productOwner?: any;
	} = {}
) {
	const { factory } = core;
	const owner = opts.productOwner ?? admin;
	const productId = await factory.nextProductId();

	if (opts.grouped) {
		await factory
			.connect(admin)
			.createGroupedProduct(
				opts.name ?? "Commertize Property",
				opts.symbol ?? "CPROP",
				18,
				opts.mintRequiresEligibility ?? true,
				owner.address,
				owner.address
			);
	} else {
		await factory
			.connect(admin)
			.createProduct(
				opts.name ?? "Commertize Property",
				opts.symbol ?? "CPROP",
				18,
				opts.requireAccredited ?? false,
				opts.mintRequiresEligibility ?? true,
				owner.address,
				owner.address
			);
	}

	const record = await factory.getProduct(productId);
	const PropertyToken = await ethers.getContractFactory("PropertyToken");
	const token = PropertyToken.attach(record.token);
	return { productId, token, record };
}
