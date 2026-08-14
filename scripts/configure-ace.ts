#!/usr/bin/env node
// ┌───────────────────────────────────────────────────────────────────────────┐
// │  UNREVIEWED PROOF OF CONCEPT -- DO NOT USE IN PRODUCTION.                 │
// │                                                                           │
// │  THIS CODE HAS NOT BEEN AUDITED AND HAS NOT BEEN REVIEWED FOR SECURITY.   │
// │  IT IS DEPLOYED ON A TEST NETWORK FOR INTEGRATION TESTING AND DEVELOPMENT │
// │  PURPOSES ONLY. IT IS NOT SUITABLE FOR PRODUCTION USE, AND IT MUST NOT BE │
// │  USED TO HOLD OR MOVE ANY ASSET OF VALUE.                                 │
// └───────────────────────────────────────────────────────────────────────────┘
// Configures the deployed ACE stack through the Coordinator API instead of raw
// onchain calls: extractor registration + engine association, target
// registration, and policy protections. Mirrors what deployAceCore wires
// onchain for tests; in production the control plane is the system of record.
//
// Usage (after scripts/deploy.ts filled the manifest addresses; hardhat run
// takes no positional args, so the command and confirmations are env-driven):
//   pnpm config-ace:validate              # offline manifest check
//   pnpm config-ace:plan -- --network sepolia
//   ACE_CONFIG_COMMAND=apply ACE_CONFIG_CONFIRM_POLICY_ENGINE=<addr> \
//     ACE_CONFIG_CONFIRM_CHAIN_ID=<id> pnpm config-ace:apply -- --network sepolia
//   pnpm config-ace:verify -- --network sepolia
import path from "node:path";
import {
	AceApi,
	DEFAULT_MANIFEST,
	findPolicyEngine,
	invariant,
	isAddress,
	loadDotEnv,
	manifestReference,
	readJson,
	requireApplyConfirmation,
	sameStrings,
	verifyApiNetwork,
} from "./lib/ace-api";
import { contractAt, sel } from "./lib/ace-core";

const command = process.env.ACE_CONFIG_COMMAND ?? "validate";
invariant(["validate", "plan", "apply", "verify"].includes(command), `Unknown ACE_CONFIG_COMMAND: ${command}`);
const flags = {
	manifest: process.env.ACE_CONFIG_MANIFEST ?? "",
	"confirm-policy-engine": process.env.ACE_CONFIG_CONFIRM_POLICY_ENGINE ?? "",
	"confirm-chain-id": process.env.ACE_CONFIG_CONFIRM_CHAIN_ID ?? "",
};
const manifestFile = path.resolve(flags.manifest || DEFAULT_MANIFEST);
const manifest: any = await readJson(manifestFile);

function targetDefaultAllow(value: unknown) {
	if (typeof value === "boolean") return value;
	if (value === "allow") return true;
	if (value === "deny") return false;
	return null;
}

function desiredExtractors() {
	invariant(manifest.schemaVersion === 1, "Unsupported manifest schemaVersion");
	invariant(isAddress(manifest.inputs?.policyEngine), "Manifest PolicyEngine is invalid");
	invariant(Array.isArray(manifest.extractors) && manifest.extractors.length > 0, "Manifest extractors are empty");

	for (const [label, values] of [
		["ids", manifest.extractors.map((item: any) => item.id)],
		["names", manifest.extractors.map((item: any) => item.name)],
		["selectors", manifest.extractors.map((item: any) => item.selector.toLowerCase())],
	]) {
		invariant(new Set(values).size === manifest.extractors.length, `Extractor ${label} must be unique`);
	}
	const realAddresses = manifest.extractors
		.map((item: any) => item.address.toLowerCase())
		.filter((address: string) => address !== `0x${"0".repeat(40)}`);
	invariant(new Set(realAddresses).size === realAddresses.length, "Extractor addresses must be unique");
	return manifest.extractors.map((item: any) => {
		invariant(isAddress(item.address), `${item.id}: extractor address is invalid`);
		invariant(/^0x[0-9a-fA-F]{8}$/.test(item.selector), `${item.id}: selector is invalid`);
		invariant(item.signatures?.length > 0, `${item.id}: supported signatures are missing`);
		invariant(item.outputs?.length > 0, `${item.id}: extractor outputs are missing`);
		return {
			...item,
			payload: {
				name: item.name,
				supported_function_signatures: item.signatures,
				outputs: item.outputs,
				onchain_extractors: [
					{
						chain_selector: String(manifest.coordinatorApi.chainSelector),
						address: item.address,
					},
				],
			},
		};
	});
}

function metadataMatches(remote: any, desired: any) {
	const signatures = remote.supported_function_signatures ?? [];
	const outputs = (remote.outputs ?? []).map(({ name, type }: any) => ({ name, type }));
	return (
		remote.name === desired.name &&
		sameStrings(signatures, desired.signatures) &&
		JSON.stringify(outputs) === JSON.stringify(desired.outputs)
	);
}

function classifyExtractors(remoteExtractors: any[], desired: any[]) {
	const matches = new Map();
	const missing: any[] = [];
	const updates: any[] = [];
	for (const item of desired) {
		const active = remoteExtractors.filter((remote) => remote.archived_at == null);
		const addressMatches = active.filter((remote) =>
			(remote.onchain_extractors ?? []).some(
				(onchain: any) =>
					String(onchain.chain_selector) === String(manifest.coordinatorApi.chainSelector) &&
					onchain.address?.toLowerCase() === item.address.toLowerCase()
			)
		);
		invariant(addressMatches.length <= 1, `${item.id}: multiple extractor records use ${item.address}`);
		if (addressMatches.length === 1) {
			invariant(metadataMatches(addressMatches[0], item), `${item.id}: existing extractor metadata does not match`);
			matches.set(item.id, addressMatches[0]);
			continue;
		}
		const nameMatches = active.filter((remote) => remote.name === item.name);
		invariant(nameMatches.length <= 1, `${item.id}: multiple extractor records use the same name`);
		if (nameMatches.length === 1) {
			const remote = nameMatches[0];
			invariant(metadataMatches(remote, item), `${item.id}: existing extractor metadata does not match`);
			const currentChain = (remote.onchain_extractors ?? []).filter(
				(onchain: any) => String(onchain.chain_selector) === String(manifest.coordinatorApi.chainSelector)
			);
			invariant(currentChain.length === 0, `${item.id}: this chain is already registered with a different address`);
			const signatureConflicts = active.filter(
				(candidate) => candidate.id !== remote.id && (candidate.supported_function_signatures ?? []).some((s: string) => item.signatures.includes(s))
			);
			invariant(signatureConflicts.length === 0, `${item.id}: extractor signature exists on another record`);
			updates.push({ remote, desired: item });
			continue;
		}
		const signatureConflicts = active.filter((remote) =>
			(remote.supported_function_signatures ?? []).some((s: string) => item.signatures.includes(s))
		);
		invariant(signatureConflicts.length === 0, `${item.id}: extractor signature already exists under another name`);
		missing.push(item);
	}
	return { matches, missing, updates };
}

function desiredTargets() {
	const defaultAllow = targetDefaultAllow(manifest.inputs.finalTargetBehavior);
	invariant(defaultAllow !== null, "inputs.finalTargetBehavior must be true/false or allow/deny");
	const targets: any[] = [];
	for (const target of manifest.targets ?? []) {
		const validatorAddress = manifestReference(manifest, target.validatorAddress);
		invariant(isAddress(validatorAddress), `${target.id}: validatorAddress is missing`);
		for (const policy of target.policyChain ?? []) {
			const policyAddress = manifestReference(manifest, policy.policyReference);
			invariant(isAddress(policyAddress), `${target.id}: ${policy.policyReference} is missing`);
		}
		targets.push({
			...target,
			validatorAddress,
			payload: {
				title: target.id,
				description: `Commertize ACE target for ${target.entrypoints.join(", ")}`,
				policy_engine_id: null,
				protected_methods: target.entrypoints,
				onchain_targets: [
					{
						chain_selector: String(manifest.coordinatorApi.chainSelector),
						address: validatorAddress,
					},
				],
				desired_default_allow: defaultAllow,
			},
		});
	}
	return { defaultAllow, targets };
}

function findOnchainRecord(records: any[], chainSelector: string, address: string, field: string) {
	const matches = records.filter(
		(record) =>
			record.archived_at == null &&
			(record[field] ?? []).some(
				(onchain: any) =>
					String(onchain.chain_selector) === chainSelector &&
					onchain.address?.toLowerCase() === address.toLowerCase()
			)
	);
	invariant(matches.length <= 1, `Multiple API records found for ${address}`);
	return matches[0] ?? null;
}

async function resolvePolicies(api: AceApi, engine: any, addresses: string[]) {
	const policies = await api.list("/policies", "policies", {
		include_onchains: true,
		policy_engine_id: engine.id,
	});
	return new Map(
		addresses.map((address) => {
			const policy = findOnchainRecord(
				policies,
				String(manifest.coordinatorApi.chainSelector),
				address,
				"onchain_policies"
			);
			invariant(policy, `Policy instance ${address} is not registered in the ACE API`);
			invariant(policy.policy_engine_id === engine.id, `Policy instance ${address} uses another PolicyEngine`);
			const onchain = (policy.onchain_policies ?? []).find(
				(record: any) => String(record.chain_selector) === String(manifest.coordinatorApi.chainSelector)
			);
			invariant(onchain?.status === "created", `Policy instance ${address} is not created onchain`);
			invariant(onchain.out_of_sync !== true, `Policy instance ${address} is out of sync`);
			return [address.toLowerCase(), policy];
		})
	);
}

async function targetState(api: AceApi, engine: any, desired: any) {
	const targets = await api.list("/targets", "targets", {
		include_onchains: true,
		policy_engine_id: engine.id,
		chain_selector: String(manifest.coordinatorApi.chainSelector),
	});
	const matches = new Map();
	const missing: any[] = [];
	for (const item of desired.targets) {
		const target = findOnchainRecord(
			targets,
			String(manifest.coordinatorApi.chainSelector),
			item.validatorAddress,
			"onchain_targets"
		);
		if (!target) {
			missing.push(item);
			continue;
		}
		invariant(target.policy_engine_id === engine.id, `${item.id}: target uses another PolicyEngine`);
		invariant(
			sameStrings(target.protected_methods ?? [], item.entrypoints),
			`${item.id}: protected methods mismatch`
		);
		invariant(target.desired_default_allow === desired.defaultAllow, `${item.id}: target default mismatch`);
		matches.set(item.id, target);
	}
	return { matches, missing };
}

async function protectionRequests(api: AceApi, desired: any, targets: Map<string, any>, policies: Map<string, any>) {
	const requests: any[] = [];
	for (const item of desired.targets) {
		const target = targets.get(item.id);
		invariant(target, `${item.id}: target registration did not converge`);
		const existing = await api.list(`/targets/${target.id}/protections`, "target_protections", {
			include_onchains: true,
		});
		for (const [position, policyConfig] of (item.policyChain ?? []).entries()) {
			const policyAddress = manifestReference(manifest, policyConfig.policyReference).toLowerCase();
			const policy = policies.get(policyAddress);
			const match = existing.find(
				(record: any) =>
					record.archived_at == null &&
					record.policy_instance_id === policy.id &&
					item.entrypoints.includes(record.function_signature)
			);
			if (match) {
				invariant(match.desired_position === position, `${item.id}: protection position mismatch`);
				continue;
			}
			for (const entrypoint of item.entrypoints) {
				requests.push({
					method: "POST",
					path: `/targets/${target.id}/protections`,
					label: `${item.id} ${entrypoint} -> ${policyConfig.policyReference} at position ${position}`,
					body: {
						function_signature: entrypoint,
						policy_instance_id: policy.id,
						desired_position: position,
						onchain_target_protections: [
							{ chain_selector: String(manifest.coordinatorApi.chainSelector) },
						],
						extractor_output_ids: [],
					},
				});
			}
		}
	}
	return requests;
}

const desiredExtractorsResult = desiredExtractors();
const desiredTargetsResult = desiredTargets();

if (command === "validate") {
	console.log(`VALID  ${desiredExtractorsResult.length} extractors, ${desiredTargetsResult.targets.length} targets`);
	console.log("OK     manifest is internally consistent (offline check)");
	process.exit(0);
}

await loadDotEnv();
const apiKeyName = manifest.coordinatorApi.authorizationEnvironmentVariable ?? "ACE_API_KEY";
const api = new AceApi(manifest.coordinatorApi.baseUrl, process.env[apiKeyName]);
requireApplyConfirmation(command, flags, manifest.inputs.policyEngine, manifest.network.chainId);
if (command === "apply") {
	invariant(manifest.coordinatorApi.tenantAuthenticationConfirmed === true, "Tenant authentication is not confirmed");
}

await verifyApiNetwork(api, String(manifest.coordinatorApi.chainSelector), manifest.network.chainId);
const engine = await findPolicyEngine(api, String(manifest.coordinatorApi.chainSelector), manifest.inputs.policyEngine);
if (manifest.coordinatorApi.policyEngineId) {
	invariant(engine.id === manifest.coordinatorApi.policyEngineId, "Manifest PolicyEngine UUID mismatch");
}

// ── Extractors: register records, then associate with the engine ────────────
const allExtractors = await api.list("/extractors", "extractors", { include_onchains: true });
const classified = classifyExtractors(allExtractors, desiredExtractorsResult);
const associated = await api.list("/extractors", "extractors", {
	include_onchains: true,
	policy_engine_id: engine.id,
});
const associatedIds = new Set(associated.map((extractor: any) => extractor.id));

const recordRequests = [
	...classified.missing.map((item: any) => ({
		method: "POST",
		path: "/extractors",
		label: `register ${item.name}`,
		body: item.payload,
	})),
	...classified.updates.map(({ remote, desired }: any) => ({
		method: "PUT",
		path: `/extractors/${remote.id}`,
		label: `add ${manifest.network.name} address to ${desired.name}`,
		body: {
			...desired.payload,
			onchain_extractors: [
				...(remote.onchain_extractors ?? []).map(({ chain_selector, address }: any) => ({
					chain_selector: String(chain_selector),
					address,
				})),
				{
					chain_selector: String(manifest.coordinatorApi.chainSelector),
					address: desired.address,
				},
			],
		},
	})),
];

for (const request of recordRequests) {
	console.log(`${command === "apply" ? "APPLY" : "PLAN "} ${request.method} ${request.path} - ${request.label}`);
	if (command === "apply") {
		if (request.method === "POST") await api.post(request.path, request.body);
		else if (request.method === "PUT") await api.put(request.path, request.body);
	}
}
if (command === "verify") {
	invariant(recordRequests.length === 0, `${recordRequests.length} extractor records are not converged`);
}

if (recordRequests.length > 0 && command === "apply") {
	console.log("NEXT  rerun plan after extractor records converge");
	process.exit(0);
}

const desiredIds = desiredExtractorsResult.map((item: any) => {
	invariant(classified.matches.get(item.id), `${item.id}: extractor record did not converge`);
	return classified.matches.get(item.id).id;
});
const missingAssociations = desiredIds.filter((id: string) => !associatedIds.has(id));
if (missingAssociations.length > 0) {
	const chainSelectors = (engine.onchain_policy_engines ?? []).map((item: any) => String(item.chain_selector));
	const body: any = {
		name: engine.name,
		onchain_policy_engines: [...new Set(chainSelectors)].map((chain_selector) => ({ chain_selector })),
		extractor_ids: [...new Set([...associatedIds, ...desiredIds])],
	};
	if (engine.description) body.description = engine.description;
	console.log(`${command === "apply" ? "APPLY" : "PLAN "} PUT /policy-engines/${engine.id} - associate extractor UUIDs`);
	if (command === "apply") await api.put(`/policy-engines/${engine.id}`, body);
}
if (command === "verify") {
	invariant(missingAssociations.length === 0, "Extractor associations are incomplete");
}

// ── Targets and protections ─────────────────────────────────────────────────
let targetStateResult = await targetState(api, engine, desiredTargetsResult);
for (const target of desiredTargetsResult.targets) target.payload.policy_engine_id = engine.id;
const targetRequests = targetStateResult.missing.map((target: any) => ({
	method: "POST",
	path: "/targets",
	label: `register ${target.id}`,
	body: target.payload,
}));
for (const request of targetRequests) {
	console.log(`${command === "apply" ? "APPLY" : "PLAN "} ${request.method} ${request.path} - ${request.label}`);
	if (command === "apply") await api.post(request.path, request.body);
}
if (command === "verify") {
	invariant(targetRequests.length === 0, "Target registrations are incomplete");
}
if (targetRequests.length > 0 && command === "apply") {
	console.log("NEXT  rerun plan after target registrations converge");
	process.exit(0);
}

const policyAddresses = [
	...new Set(
		desiredTargetsResult.targets.flatMap((target: any) =>
			target.policyChain.map((policy: any) => manifestReference(manifest, policy.policyReference).toLowerCase())
		)
	),
];
const policies = await resolvePolicies(api, engine, policyAddresses);
const requests = await protectionRequests(api, desiredTargetsResult, targetStateResult.matches, policies);
for (const request of requests) {
	console.log(`${command === "apply" ? "APPLY" : "PLAN "} ${request.method} ${request.path} - ${request.label}`);
	if (command === "apply") await api.post(request.path, request.body);
}
if (command === "verify") {
	invariant(requests.length === 0, "Policy protections are incomplete");
}

// ── Onchain readback (verify only) ───────────────────────────────────────────
if (command === "verify") {
	const engineContract = contractAt("PolicyEngine", manifest.inputs.policyEngine);
	for (const item of desiredExtractorsResult) {
		const actual = await engineContract.getExtractor(item.selector);
		invariant(
			actual.toLowerCase() === item.address.toLowerCase(),
			`${item.id}: onchain extractor mismatch (${actual})`
		);
		console.log(`OK    onchain ${item.selector} -> ${actual}`);
	}
	for (const target of desiredTargetsResult.targets) {
		for (const entrypoint of target.entrypoints) {
			const policies_ = await engineContract.getPolicies(target.validatorAddress, sel(entrypoint));
			invariant(policies_.length > 0, `${target.id} ${entrypoint}: no onchain policies`);
			console.log(`OK    onchain ${target.id} ${entrypoint}: ${policies_.length} policy(ies)`);
		}
	}
	console.log("OK    API state and onchain readback are converged");
}
