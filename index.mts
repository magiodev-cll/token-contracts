import { ethers } from "ethers";

// Artifact imports
import DividendVaultArtifact from "./artifacts/src/finance/DividendVault.sol/DividendVault.json";
import ListingEscrowArtifact from "./artifacts/src/finance/ListingEscrow.sol/ListingEscrow.json";
import PropertyFactoryArtifact from "./artifacts/src/tokenization/PropertyFactory.sol/PropertyFactory.json";
import PropertyTokenArtifact from "./artifacts/src/tokenization/PropertyToken.sol/PropertyToken.json";
import IdentitySyncSenderArtifact from "./artifacts/src/ccip/IdentitySyncSender.sol/IdentitySyncSender.json";
import PropertyNavConsumerArtifact from "./artifacts/src/oracle/PropertyNavConsumer.sol/PropertyNavConsumer.json";

// Network config
import { NETWORKS, DEFAULT_NETWORK } from "./networks";

// Utils imports
import {
	DeploymentConfig,
	getNetworkName,
	getDeploymentJsonEnv,
} from "@commertize/utils/onchain";

export type { DeploymentConfig };

// MARK: Deployment Loading

/**
 * Load deployment configuration for a specific network.
 * Uses dynamic imports which are bundled by tsup for both Node and Browser.
 */
async function loadDeployment(
	network: string
): Promise<DeploymentConfig | null> {
	// 1. Try from environment variable (works in both browser and Node)
	const envVar = getDeploymentJsonEnv();

	if (envVar) {
		try {
			// If it's a string starting with {, parse it.
			if (typeof envVar === "string" && envVar.trim().startsWith("{")) {
				return JSON.parse(envVar);
			}
			// If it's already an object
			if (typeof envVar === "object") {
				return envVar as DeploymentConfig;
			}
		} catch (e) {
			console.warn(
				"Failed to parse DEPLOYMENT_JSON env var, falling back to bundled file."
			);
		}
	}

	// 2. Load bundled deployment JSON based on network
	// Template literal prevents TypeScript from statically resolving the path,
	// so the DTS build won't fail when a file (e.g. deployment.localhost.json) is absent.
	// Filenames use underscores (deploy.ts writes deployment.arc_testnet.json).
	const file = network.replace(/-/g, "_");
	try {
		const mod = await import(`./deployment.${file}.json`);
		return (mod as any).default ?? (mod as any);
	} catch (err) {
		console.warn(`⚠️  Failed to load deployment for network: ${network}`, err);
		return null;
	}
}

const deploymentNetwork = getNetworkName() ?? DEFAULT_NETWORK;

const fallbackNetwork =
	NETWORKS[deploymentNetwork] ?? NETWORKS[DEFAULT_NETWORK];

// USE TOP-LEVEL AWAIT
let deploymentConfig: DeploymentConfig | null =
	await loadDeployment(deploymentNetwork);

// MARK: Configuration & Addresses

export const NETWORK = deploymentConfig?.network?.name ?? fallbackNetwork.name;
export const CHAIN_ID = Number(
	deploymentConfig?.network?.chainId ?? fallbackNetwork.chainId
);
export const CURRENCY =
	deploymentConfig?.network?.currency ?? fallbackNetwork.currency;
export const RPC_URL = deploymentConfig?.network?.rpc ?? fallbackNetwork.rpcUrl;
export const BLOCK_EXPLORER_URL =
	deploymentConfig?.network?.blockExplorerUrl ??
	fallbackNetwork.blockExplorerUrl;

export const CONTRACTS: any = deploymentConfig?.contracts || {};
export const Deployment = deploymentConfig;

// MARK: Address Configuration

export const USDC_ADDRESS =
	(CONTRACTS as any)?.USDC || fallbackNetwork.usdcAddress || "";

/** ABI to interact with the existing USDC (or compatible) payment token on Arc. No token is implemented or deployed by this package. */
const ERC20_PERMIT_ABI = [
	{
		inputs: [
			{ name: "owner", type: "address" },
			{ name: "spender", type: "address" },
		],
		name: "allowance",
		outputs: [{ type: "uint256" }],
		stateMutability: "view",
		type: "function",
	},
	{
		inputs: [
			{ name: "spender", type: "address" },
			{ name: "value", type: "uint256" },
		],
		name: "approve",
		outputs: [{ type: "bool" }],
		stateMutability: "nonpayable",
		type: "function",
	},
	{
		inputs: [{ name: "account", type: "address" }],
		name: "balanceOf",
		outputs: [{ type: "uint256" }],
		stateMutability: "view",
		type: "function",
	},
	{
		inputs: [],
		name: "decimals",
		outputs: [{ type: "uint8" }],
		stateMutability: "view",
		type: "function",
	},
	{
		inputs: [],
		name: "DOMAIN_SEPARATOR",
		outputs: [{ type: "bytes32" }],
		stateMutability: "view",
		type: "function",
	},
	{
		inputs: [],
		name: "eip712Domain",
		outputs: [
			{ name: "fields", type: "bytes1" },
			{ name: "name", type: "string" },
			{ name: "version", type: "string" },
			{ name: "chainId", type: "uint256" },
			{ name: "verifyingContract", type: "address" },
			{ name: "salt", type: "bytes32" },
			{ name: "extensions", type: "uint256[]" },
		],
		stateMutability: "view",
		type: "function",
	},
	{
		inputs: [],
		name: "name",
		outputs: [{ type: "string" }],
		stateMutability: "view",
		type: "function",
	},
	{
		inputs: [{ name: "owner", type: "address" }],
		name: "nonces",
		outputs: [{ type: "uint256" }],
		stateMutability: "view",
		type: "function",
	},
	{
		inputs: [
			{ name: "owner", type: "address" },
			{ name: "spender", type: "address" },
			{ name: "value", type: "uint256" },
			{ name: "deadline", type: "uint256" },
			{ name: "v", type: "uint8" },
			{ name: "r", type: "bytes32" },
			{ name: "s", type: "bytes32" },
		],
		name: "permit",
		outputs: [],
		stateMutability: "nonpayable",
		type: "function",
	},
	{
		inputs: [],
		name: "symbol",
		outputs: [{ type: "string" }],
		stateMutability: "view",
		type: "function",
	},
	{
		inputs: [],
		name: "totalSupply",
		outputs: [{ type: "uint256" }],
		stateMutability: "view",
		type: "function",
	},
	{
		inputs: [
			{ name: "to", type: "address" },
			{ name: "value", type: "uint256" },
		],
		name: "transfer",
		outputs: [{ type: "bool" }],
		stateMutability: "nonpayable",
		type: "function",
	},
	{
		inputs: [
			{ name: "from", type: "address" },
			{ name: "to", type: "address" },
			{ name: "value", type: "uint256" },
		],
		name: "transferFrom",
		outputs: [{ type: "bool" }],
		stateMutability: "nonpayable",
		type: "function",
	},
	{
		inputs: [
			{ indexed: true, name: "owner", type: "address" },
			{ indexed: true, name: "spender", type: "address" },
			{ indexed: false, name: "value", type: "uint256" },
		],
		name: "Approval",
		type: "event",
		anonymous: false,
	},
	{
		inputs: [
			{ indexed: true, name: "from", type: "address" },
			{ indexed: true, name: "to", type: "address" },
			{ indexed: false, name: "value", type: "uint256" },
		],
		name: "Transfer",
		type: "event",
		anonymous: false,
	},
] as const;

/** Minimal ABI for the ACE IdentityRegistry (full ABI ships with @chainlink/ace). */
const IDENTITY_REGISTRY_ABI = [
	{
		inputs: [
			{ name: "ccid", type: "bytes32" },
			{ name: "account", type: "address" },
			{ name: "context", type: "bytes" },
		],
		name: "registerIdentity",
		outputs: [],
		stateMutability: "nonpayable",
		type: "function",
	},
	{
		inputs: [
			{ name: "ccid", type: "bytes32" },
			{ name: "account", type: "address" },
			{ name: "context", type: "bytes" },
		],
		name: "removeIdentity",
		outputs: [],
		stateMutability: "nonpayable",
		type: "function",
	},
	{
		inputs: [{ name: "account", type: "address" }],
		name: "getIdentity",
		outputs: [{ name: "", type: "bytes32" }],
		stateMutability: "view",
		type: "function",
	},
] as const;

/** Contract ABIs (ethers/viem compatible). */
export const ABIS = {
	IdentityRegistry: [...IDENTITY_REGISTRY_ABI],
	USDC: [...ERC20_PERMIT_ABI],
	DividendVault: DividendVaultArtifact.abi,
	PropertyFactory: PropertyFactoryArtifact.abi,
	PropertyToken: PropertyTokenArtifact.abi,
	ListingEscrow: ListingEscrowArtifact.abi,
	IdentitySyncSender: IdentitySyncSenderArtifact.abi,
	PropertyNavConsumer: PropertyNavConsumerArtifact.abi,
};

/** ListingEscrow ABI for deposit/decode (includes SafeERC20FailedOperation and other errors). */
export const ListingEscrowAbi = ListingEscrowArtifact.abi;

/** Full artifacts (ABI + bytecode) for backend deployment via ContractFactory. */
export { default as IdentitySyncSenderArtifact } from "./artifacts/src/ccip/IdentitySyncSender.sol/IdentitySyncSender.json";
export { default as PropertyNavConsumerArtifact } from "./artifacts/src/oracle/PropertyNavConsumer.sol/PropertyNavConsumer.json";

/** Standard Solidity Error(string) ABI for decoding require()/revert() messages. */
export const ErrorStringAbi = [
	{
		type: "error",
		name: "Error",
		inputs: [{ name: "message", type: "string" }],
	},
] as const;

// MARK: Contract Helpers
export const getIdentityRegistryContract = (runner: ethers.ContractRunner) =>
	new ethers.Contract(
		CONTRACTS.IdentityRegistry,
		ABIS.IdentityRegistry,
		runner
	);
/**
 * IdentitySyncSender lives on the home chain and its address is optional
 * (absent until deployed), so it is passed explicitly rather than read from
 * CONTRACTS.
 */
export const getIdentitySyncSenderContract = (
	address: string,
	runner: ethers.ContractRunner
) => new ethers.Contract(address, ABIS.IdentitySyncSender, runner);
/**
 * PropertyNavConsumer is the CRE oracle sink (see cre/). Its address is
 * per-chain and absent until deployed, so it is passed explicitly.
 */
export const getPropertyNavConsumerContract = (
	address: string,
	runner: ethers.ContractRunner
) => new ethers.Contract(address, ABIS.PropertyNavConsumer, runner);
export const getUSDCContract = (runner: ethers.ContractRunner) =>
	new ethers.Contract(CONTRACTS.USDC || USDC_ADDRESS, ABIS.USDC, runner);
export const getDividendVaultContract = (runner: ethers.ContractRunner) =>
	new ethers.Contract(CONTRACTS.DividendVault, ABIS.DividendVault, runner);
export const getPropertyFactoryContract = (runner: ethers.ContractRunner) =>
	new ethers.Contract(CONTRACTS.PropertyFactory, ABIS.PropertyFactory, runner);
export const getTokenContract = (
	address: string,
	runner: ethers.ContractRunner
) => new ethers.Contract(address, ABIS.PropertyToken, runner);
export const getPropertyTokenContract = getTokenContract; // Alias
export const getEscrowContract = (
	address: string,
	runner: ethers.ContractRunner
) => new ethers.Contract(address, ABIS.ListingEscrow, runner);
