import hre from "hardhat";
import chalk from "chalk";
import { getNetwork } from "../networks";

/**
 * Self-serve CCT registration for a PropertyToken + pool pair on the
 * connected network (https://docs.chain.link/ccip/concepts/cross-chain-token),
 * plus the token-side wiring a working ACE lane requires:
 *   1. Authorize the pool as a minter on the product's mint policy
 *      (OnlyAuthorizedSenderPolicy) — inbound bridge deliveries mint through it
 *   2. Ensure the pool is on the token's transfer BypassPolicy (the onRamp
 *      transfers user tokens to the pool before lockOrBurn; the pool is a
 *      contract without credentials, so its receives are bypass-listed)
 *   3. RegistryModuleOwnerCustom.registerAdminViaGetCCIPAdmin(token)
 *   4. TokenAdminRegistry.acceptAdminRole(token)
 *   5. TokenAdminRegistry.setPool(token, pool)
 * Cross-chain lane wiring (applyChainUpdates) is a separate step once the
 * remote pool exists.
 *
 * The signer (EVM_PRIVATE_KEY) must be the token's CCIP admin (its owner).
 * Outbound burns are unrestricted self-burn (IBurnMintERC20.burn(uint256)),
 * so no burn authorization is needed on the ACE token.
 *
 * Usage: hardhat run --network arc-testnet scripts/ccip-register.ts
 *   env: CCIP_TOKEN=0x...  CCIP_POOL=0x...
 *        CCIP_MINT_POLICY=0x...   # product mint policy (optional)
 *        CCIP_BYPASS_POLICY=0x... # transfer BypassPolicy (optional)
 */

const CCIP_ADMIN_ABI = ["function getCCIPAdmin() view returns (address)"];
const SENDER_POLICY_ABI = [
	"function senderAuthorized(address account) view returns (bool)",
	"function authorizeSender(address account)",
];
const BYPASS_POLICY_ABI = [
	"function addressAllowed(address account) view returns (bool)",
	"function allowAddress(address account)",
];
const REGISTRY_MODULE_ABI = [
	"function registerAdminViaGetCCIPAdmin(address token) external",
];
const TOKEN_ADMIN_REGISTRY_ABI = [
	"function acceptAdminRole(address localToken) external",
	"function setPool(address localToken, address pool) external",
	"function getTokenConfig(address token) external view returns (tuple(address administrator, address pendingAdministrator, address tokenPool))",
];

const { ethers, networkName } = await hre.network.getOrCreate();
const [signer] = await ethers.getSigners();

if (!process.env.CCIP_TOKEN || !process.env.CCIP_POOL) {
	console.error("Error: CCIP_TOKEN and CCIP_POOL env vars are required.");
	process.exit(1);
}

// Normalize + checksum so later equality checks and reverts are reliable.
let token: string;
let pool: string;
try {
	token = ethers.getAddress(process.env.CCIP_TOKEN);
	pool = ethers.getAddress(process.env.CCIP_POOL);
} catch {
	console.error("Error: CCIP_TOKEN / CCIP_POOL are not valid addresses.");
	process.exit(1);
}

let net;
try {
	net = getNetwork(networkName);
} catch {
	console.error(
		`Error: no config for network '${networkName}'. Run with --network arc-testnet (Hardhat's default network is unnamed and has no CCIP config).`
	);
	process.exit(1);
}
if (!net.ccip) {
	console.error(
		`Error: no CCIP config for network '${networkName}'. Add addresses from https://docs.chain.link/ccip/directory to networks.ts first.`
	);
	process.exit(1);
}

console.log(chalk.bold.blue(`\nCCT registration on ${networkName}`));
console.log(`Signer: ${chalk.yellow(signer.address)}`);
console.log(`Token:  ${chalk.yellow(token)}  Pool: ${chalk.yellow(pool)}`);

// Preflight: the signer must be the token's CCIP admin (owner).
const ccipAdminReader = new ethers.Contract(token, CCIP_ADMIN_ABI, signer);
const tokenAdmin = ethers.getAddress(await ccipAdminReader.getCCIPAdmin());
if (tokenAdmin !== signer.address) {
	console.error(
		`Error: signer ${signer.address} is not the token's CCIP admin (${tokenAdmin}). Run with that key.`
	);
	process.exit(1);
}

// Step 1: authorize the pool as a minter on the product's mint policy.
if (process.env.CCIP_MINT_POLICY) {
	const mintPolicy = new ethers.Contract(
		ethers.getAddress(process.env.CCIP_MINT_POLICY),
		SENDER_POLICY_ABI,
		signer
	);
	if (await mintPolicy.senderAuthorized(pool)) {
		console.log("Mint policy: pool already authorized.");
	} else {
		console.log("Authorizing the pool as a minter...");
		await (await mintPolicy.authorizeSender(pool)).wait();
	}
} else {
	console.warn(
		chalk.yellow(
			"CCIP_MINT_POLICY not set — skipped. The pool must be authorized on the product's mint policy or inbound bridge mints will revert."
		)
	);
}

// Step 2: ensure the pool is on the token's transfer BypassPolicy so holders
// can fund it (the pool is a contract without credentials; its receives are
// bypass-listed, see test/CCIPCompliantPool.ts for the wiring pattern).
if (process.env.CCIP_BYPASS_POLICY) {
	const bypass = new ethers.Contract(
		ethers.getAddress(process.env.CCIP_BYPASS_POLICY),
		BYPASS_POLICY_ABI,
		signer
	);
	if (await bypass.addressAllowed(pool)) {
		console.log("Bypass policy: pool already allowed.");
	} else {
		console.log("Allowing the pool on the transfer bypass policy...");
		await (await bypass.allowAddress(pool)).wait();
	}
} else {
	console.warn(
		chalk.yellow(
			"CCIP_BYPASS_POLICY not set — skipped. Ensure the pool is on the token's transfer BypassPolicy or outbound transfers to it will revert."
		)
	);
}

// Steps 3-5: CCT admin registration + pool link.
const registryModule = new ethers.Contract(
	net.ccip.registryModuleOwner,
	REGISTRY_MODULE_ABI,
	signer
);
const adminRegistry = new ethers.Contract(
	net.ccip.tokenAdminRegistry,
	TOKEN_ADMIN_REGISTRY_ABI,
	signer
);

const config = await adminRegistry.getTokenConfig(token);
const administrator = ethers.getAddress(config.administrator);
const pendingAdministrator = ethers.getAddress(config.pendingAdministrator);
const currentPool =
	config.tokenPool === ethers.ZeroAddress
		? ethers.ZeroAddress
		: ethers.getAddress(config.tokenPool);

if (administrator === ethers.ZeroAddress) {
	if (
		pendingAdministrator !== ethers.ZeroAddress &&
		pendingAdministrator !== signer.address
	) {
		console.error(
			`Error: admin registration pending for a different wallet (${pendingAdministrator}). Run with that key to accept.`
		);
		process.exit(1);
	}
	if (pendingAdministrator === ethers.ZeroAddress) {
		console.log("Registering admin via getCCIPAdmin()...");
		await (await registryModule.registerAdminViaGetCCIPAdmin(token)).wait();
	}
	console.log("Accepting admin role...");
	await (await adminRegistry.acceptAdminRole(token)).wait();
} else if (administrator !== signer.address) {
	console.error(
		`Error: token admin is ${administrator}, not the signer. Pool linking must run from the admin key.`
	);
	process.exit(1);
} else {
	console.log(`Admin already set: ${administrator}`);
}

if (currentPool !== pool) {
	console.log("Linking pool...");
	await (await adminRegistry.setPool(token, pool)).wait();
} else {
	console.log("Pool already linked.");
}

const finalConfig = await adminRegistry.getTokenConfig(token);
console.log(chalk.bold.green("\nRegistration complete:"));
console.log(`  administrator: ${finalConfig.administrator}`);
console.log(`  tokenPool:     ${finalConfig.tokenPool}`);
console.log(
	"\nNext: deploy the remote pool + token, then wire lanes with applyChainUpdates."
);
