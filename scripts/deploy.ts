import hre from "hardhat";
import fs from "node:fs";
import path from "node:path";
import prompts from "prompts";
import chalk from "chalk";
import { getNetworkMeta } from "../hardhat.config";
import {
	ethers,
	deployAceCore,
	onboard,
	ccidFor,
} from "../scripts/lib/ace-core";

interface DeploymentConfig {
	contracts: Record<string, string>;
	timestamp?: string;
	network?: {
		name: string;
		chainId: number;
		rpc: string;
		currency: string;
		blockExplorerUrl: string;
	};
}

interface DeployContext {
	deployer: any;
	deploymentConfig: DeploymentConfig;
	deployedAddresses: Record<string, string>;
}

const { networkName } = await hre.network.getOrCreate();

console.log(chalk.bold.blue("\nCommertize Interactive Deployment CLI (MVP)\n"));

const [deployer] = await ethers.getSigners();
console.log(`Deploying from account: ${chalk.yellow(deployer.address)}`);

const balance = await deployer.provider.getBalance(deployer.address);
console.log(`Balance: ${chalk.yellow(ethers.formatEther(balance))} ETH\n`);

const chainId = Number((await deployer.provider.getNetwork()).chainId);

const meta = getNetworkMeta(networkName);

console.log(`Network: ${chalk.magenta(networkName)} (ChainID: ${chainId})`);

// Convert network name to filename (replace hyphens with underscores)
const deploymentFile = `deployment.${networkName.replace(/-/g, "_")}.json`;
const mainDeploymentPath = path.join(
	import.meta.dirname,
	`../${deploymentFile}`
);

let deploymentConfig: DeploymentConfig = { contracts: {} };

// Try to load existing config
if (fs.existsSync(mainDeploymentPath)) {
	try {
		const raw = fs.readFileSync(mainDeploymentPath, "utf-8");
		deploymentConfig = JSON.parse(raw);
		console.log(
			chalk.green(`Loaded existing config from ${mainDeploymentPath}`)
		);
	} catch (e: any) {
		console.warn(
			chalk.red(`Could not parse ${mainDeploymentPath}: ${e.message}`)
		);
		console.warn(chalk.red(`Starting fresh.`));
	}
}

const context: DeployContext = {
	deployer,
	deploymentConfig,
	deployedAddresses: { ...deploymentConfig.contracts },
};

// USDC is not deployed here; pull the address from network metadata
const usdcAddress = meta.usdcAddress;
if (usdcAddress) {
	context.deployedAddresses.USDC = usdcAddress;
	context.deploymentConfig.contracts = context.deploymentConfig.contracts || {};
	context.deploymentConfig.contracts.USDC = usdcAddress;
	console.log(`USDC Address (from config): ${chalk.green(usdcAddress)}`);
} else {
	console.error(
		chalk.red(`Warning: No USDC_ADDRESS configured for network: ${networkName}`)
	);
}

const contracts = [
	{
		name: "AceCore",
		title: "1. ACE Core (engine, registries, policies, factory)",
		value: "AceCore",
	},
	{
		name: "DividendVault",
		title: "2. Dividend Vault (Requires USDC from fork)",
		value: "DividendVault",
	},
];

let selectedContracts = new Set<string>();

// Check for --all or CI
const args = process.argv.slice(2);
if (args.includes("--all") || process.env.CI) {
	console.log(chalk.cyan("Running in CI/All mode. Selected ALL contracts."));
	contracts.forEach((c) => selectedContracts.add(c.value));
} else {
	const response = await prompts({
		type: "multiselect",
		name: "selected",
		message: "Select contracts to deploy (Space to select, Enter to deploy)",
		choices: contracts,
		hint: "- Space to select. Return to submit",
		instructions: false,
		min: 1,
	});

	if (!response.selected || response.selected.length === 0) {
		console.log(chalk.yellow("No contracts selected. Exiting."));
		process.exit(0);
	}
	selectedContracts = new Set(response.selected);
}

console.log(chalk.bold("\n⚡ Starting Deployment...\n"));

// 1. ACE Core (shared: engine, registries, extractors, policies, factory)
if (selectedContracts.has("AceCore")) {
	console.log("Deploying ACE core...");
	const core = await deployAceCore(deployer);

	const coreAddresses = {
		PolicyEngine: core.engine.target,
		IdentityRegistry: core.identityRegistry.target,
		CredentialRegistry: core.credentialRegistry.target,
		RegistryWriterPolicy: core.writerPolicy.target,
		RejectPolicy: core.rejectPolicy.target,
		PropertyFactory: core.factory.target,
	};
	for (const [key, address] of Object.entries(coreAddresses)) {
		context.deployedAddresses[key] = address;
		context.deploymentConfig.contracts[key] = address;
	}

	// Authenticate the deployer as an eligible operator (KYC + AML) so they can
	// act as product owner and receive mints.
	try {
		console.log("  Authenticating Deployer...");
		await onboard(core, deployer, deployer);
		console.log(
			`  [OK] Deployer ${chalk.green(deployer.address)} onboarded (CCID: ${ccidFor(deployer.address)})`
		);
	} catch (err: any) {
		console.warn(
			chalk.yellow(`  Warning: Failed to authenticate deployer: ${err.message}`)
		);
	}

	console.log(`  └─ Addresses:
    PolicyEngine:        ${chalk.green(core.engine.target)}
    IdentityRegistry:    ${chalk.green(core.identityRegistry.target)}
    CredentialRegistry:  ${chalk.green(core.credentialRegistry.target)}
    RegistryWriterPolicy:${chalk.green(core.writerPolicy.target)}
    RejectPolicy:        ${chalk.green(core.rejectPolicy.target)}
    PropertyFactory:     ${chalk.green(core.factory.target)}`);
}

// 2. Dividend Vault
if (selectedContracts.has("DividendVault")) {
	const usdc = context.deployedAddresses.USDC;
	if (!usdc) {
		console.error(chalk.red("Error: DividendVault requires USDC."));
	} else {
		// Protocol Wallet = Deployer for now
		await deployContract(
			"DividendVault",
			[usdc, deployer.address, deployer.address],
			context
		);
	}
}

// Save to deployment.json (Single Source of Truth)
context.deploymentConfig.timestamp = new Date().toISOString();
context.deploymentConfig.network = {
	name: networkName,
	chainId: meta.chainId,
	rpc: meta.rpcUrl,
	currency: meta.currency,
	blockExplorerUrl: meta.blockExplorerUrl,
};

fs.writeFileSync(
	mainDeploymentPath,
	JSON.stringify(context.deploymentConfig, null, 2)
);

console.log(chalk.bold.green("\nDeployment Config Updated!"));
console.log(`Updated:  ${chalk.underline(deploymentFile)}`);

async function deployContract(
	infoName: string,
	args: any[],
	ctx: DeployContext,
	aliasKey?: string
) {
	const key = aliasKey || infoName;
	console.log(`Deploying ${chalk.cyan(key)}...`);

	try {
		const Factory = await ethers.getContractFactory(infoName);
		const contract = await Factory.deploy(...args);
		await contract.waitForDeployment();

		const address = await contract.getAddress();
		console.log(`  └─ Address: ${chalk.green(address)}`);

		// Update context
		ctx.deployedAddresses[key] = address;
		ctx.deploymentConfig.contracts[key] = address;
	} catch (err: any) {
		console.error(chalk.red(`  Failed to deploy ${key}: ${err.message}`));
		process.exitCode = 1;
	}
}
