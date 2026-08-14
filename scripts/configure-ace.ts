#!/usr/bin/env node
// ┌───────────────────────────────────────────────────────────────────────────┐
// │  UNREVIEWED PROOF OF CONCEPT -- DO NOT USE IN PRODUCTION.                 │
// │                                                                           │
// │  THIS CODE HAS NOT BEEN AUDITED AND HAS NOT BEEN REVIEWED FOR SECURITY.   │
// │  IT IS DEPLOYED ON A TEST NETWORK FOR INTEGRATION TESTING AND DEVELOPMENT │
// │  PURPOSES ONLY. IT IS NOT SUITABLE FOR PRODUCTION USE, AND IT MUST NOT BE │
// │  USED TO HOLD OR MOVE ANY ASSET OF VALUE.                                 │
// └───────────────────────────────────────────────────────────────────────────┘
// Creates and wires the whole ACE-owned surface through the Coordinator API
// (per scripts/ace-api-docs/ace-coordinator-api-doc.json):
//
//   extractors -> policy engine -> registries -> policy implementations ->
//   policy instances -> targets -> protections
//
// Everything ACE is API-managed here. Commertize's own infra contracts are
// deployed by scripts/deploy.ts (extractors/implementations/factory/tokens)
// and only registered + configured through this script.
//
// Hardhat `run` takes no positional args, so the command and confirmations
// are env-driven:
//   pnpm config-ace:validate
//   pnpm config-ace:plan -- --network sepolia
//   ACE_CONFIG_COMMAND=apply ACE_CONFIG_CONFIRM_CHAIN_SELECTOR=<sel> pnpm config-ace:apply -- --network sepolia
//   pnpm config-ace:verify -- --network sepolia
import fs from "node:fs";
import path from "node:path";
import { isAddress, zeroAddress } from "viem";
import {
	AceApi,
	DEFAULT_MANIFEST,
	invariant,
	readJson,
	verifyApiNetwork,
	waitForStatus,
} from "./lib/ace-api";
import { contractAt, sel } from "./lib/ace-core";

const command = process.env.ACE_CONFIG_COMMAND ?? "validate";
invariant(["validate", "plan", "apply", "verify"].includes(command), `Unknown ACE_CONFIG_COMMAND: ${command}`);
const flags = {
	manifest: process.env.ACE_CONFIG_MANIFEST ?? "",
	"confirm-chain-selector": process.env.ACE_CONFIG_CONFIRM_CHAIN_SELECTOR ?? "",
};
const manifestFile = path.resolve(flags.manifest || DEFAULT_MANIFEST);
const manifest: any = await readJson(manifestFile);
const CHAIN = String(manifest.coordinatorApi.chainSelector);

function resolvedAddress(reference: string) {
	const value = reference.split(".").reduce((node: any, key: string) => node?.[key], manifest);
	invariant(isAddress(value) && value !== zeroAddress, `${reference} is not filled in the manifest`);
	return value;
}

function recordByOnchain(records: any[], address: string, field: string) {
	return records.find(
		(record: any) =>
			record.archived_at == null &&
			(record[field] ?? []).some(
				(onchain: any) =>
					String(onchain.chain_selector) === CHAIN && onchain.address?.toLowerCase() === address.toLowerCase()
			)
	) ?? null;
}

function recordByName(records: any[], name: string) {
	return records.find((record: any) => record.archived_at == null && record.name === name) ?? null;
}

function applyLog(method: string, pathname: string, label: string, body?: unknown) {
	console.log(`${command === "apply" ? "APPLY" : "PLAN "} ${method} ${pathname} - ${label}`);
	if (command !== "apply" && body !== undefined) console.log(JSON.stringify(body, null, 2));
}

async function runWrite(method: string, pathname: string, body: unknown, label: string, api: AceApi) {
	applyLog(method, pathname, label, body);
	if (command !== "apply") return;
	if (method === "POST") await api.post(pathname, body);
	else await api.put(pathname, body);
}

async function writeAndResolve(
	api: AceApi,
	request: { method: string; path: string; body: any; label: string; target: any },
	listPath: string,
	collectionKey: string,
	match: (record: any) => boolean
) {
	await runWrite(request.method, request.path, request.body, request.label, api);
	if (command !== "apply") return;
	const records = await api.list(listPath, collectionKey, { include_onchains: true });
	const created = records.find((record: any) => record.archived_at == null && match(record));
	invariant(created, `${request.label}: ${collectionKey} not found after write`);
	request.target.uuid = created.id;
}

// ── Manifest validation (offline) ────────────────────────────────────────────
function validateManifest() {
	invariant(manifest.schemaVersion === 2, "Unsupported manifest schemaVersion");
	invariant(isAddress(manifest.inputs?.deployer), "inputs.deployer is missing");
	invariant(manifest.coordinatorApi.baseUrl, "coordinatorApi.baseUrl is missing");
	invariant(CHAIN, "coordinatorApi.chainSelector is missing");
	invariant(manifest.extractors?.length > 0, "extractors are empty");
	invariant(manifest.policyImplementations?.length > 0, "policyImplementations are empty");
	for (const item of manifest.policyImplementations) {
		invariant(isAddress(item.address), `${item.id}: implementation address is missing (run deploy.ts first)`);
		invariant(item.configSchema?.properties, `${item.id}: configSchema is missing (fill from the platform)`);
	}
	invariant(manifest.policies?.length > 0, "policies are empty");
	for (const policy of manifest.policies) {
		const impl = manifest.policyImplementations.find((item: any) => item.id === policy.implementation);
		invariant(impl && isAddress(impl.address), `${policy.id}: implementation ${policy.implementation} is missing or not deployed`);
	}
	invariant(manifest.targets?.length > 0, "targets are empty");
	for (const target of manifest.targets) {
		invariant(manifest.registries[target.registry], `${target.id}: unknown registry ${target.registry}`);
		invariant(target.entrypoints?.length > 0, `${target.id}: entrypoints are missing`);
	}
	console.log(`VALID  ${manifest.extractors.length} extractors, ${manifest.policyImplementations.length} implementations, ${manifest.policies.length} policies, ${manifest.targets.length} targets`);
	console.log("OK     manifest is internally consistent (offline check)");
}

// ── Resource reconciliation + requests ───────────────────────────────────────
async function extractorRequests(api: AceApi) {
	const remote = await api.list("/extractors", "extractors", { include_onchains: true });
	const requests: { method: string; path: string; body: any; label: string; target: any }[] = [];
	for (const item of manifest.extractors) {
		const byAddress = recordByOnchain(remote, item.address, "onchain_extractors");
		if (byAddress) {
			item.uuid = byAddress.id;
			continue;
		}
		const byName = recordByName(remote, item.name);
		if (byName && byName.archived_at == null) {
			const onchain = [...(byName.onchain_extractors ?? [])].map((r: any) => ({
				chain_selector: String(r.chain_selector),
				address: r.address,
			}));
			onchain.push({ chain_selector: CHAIN, address: item.address });
			item.uuid = byName.id;
			requests.push({
				method: "PUT",
				path: `/extractors/${byName.id}`,
				body: { name: item.name, supported_function_signatures: item.signatures, outputs: item.outputs, onchain_extractors: onchain },
				label: `add ${manifest.network.name} address to ${item.name}`,
				target: item,
			});
			continue;
		}
		requests.push({
			method: "POST",
			path: "/extractors",
			body: { name: item.name, supported_function_signatures: item.signatures, outputs: item.outputs, onchain_extractors: [{ chain_selector: CHAIN, address: item.address }] },
			label: `register ${item.name}`,
			target: item,
		});
	}
	return requests;
}

async function engineRequests(api: AceApi, extractorUuids: string[]) {
	const remote = await api.list("/policy-engines", "policy_engines", { include_onchains: true });
	const existing = remote.find(
		(engine: any) => engine.archived_at == null && String(engine.name) === manifest.engine.name
	);
	if (existing) {
		const chainSelectors = (existing.onchain_policy_engines ?? []).map((r: any) => String(r.chain_selector));
		const missingAssociation = extractorUuids.some((uuid) => !(existing.extractor_registrations ?? []).some((r: any) => r.id === uuid));
		const requests = missingAssociation
			? [{
				method: "PUT",
				path: `/policy-engines/${existing.id}`,
				body: {
					name: existing.name,
					onchain_policy_engines: [...new Set(chainSelectors)].map((chain_selector) => ({ chain_selector })),
					extractor_ids: [...new Set([...(existing.extractor_registrations ?? []).map((r: any) => r.id), ...extractorUuids])],
				},
				label: "associate extractors with the existing PolicyEngine",
				target: existing,
			}]
			: [];
		return { engine: existing, requests };
	}
	const body = {
		name: manifest.engine.name,
		description: manifest.engine.description,
		extractor_ids: extractorUuids,
		onchain_policy_engines: [{ chain_selector: CHAIN }],
	};
	return { engine: null, requests: [{ method: "POST", path: "/policy-engines", body, label: `deploy ${manifest.engine.name}`, target: null }] };
}

async function registryRequests(api: AceApi) {
	const remote = await api.list("/registries", "registries", { include_onchains: true });
	const requests: any[] = [];
	for (const [id, spec] of Object.entries(manifest.registries)) {
		const existing = recordByName(remote, spec.name);
		if (existing) {
			spec.uuid = existing.id;
			continue;
		}
		requests.push({
			method: "POST",
			path: "/registries",
			body: {
				name: spec.name,
				description: spec.description,
				identity_registries: id === "identityRegistry"
					? [{ name: spec.name, chain_selector: CHAIN, description: spec.description }]
					: [],
				credential_registries: id === "credentialRegistry"
					? [{ name: spec.name, chain_selector: CHAIN, description: spec.description }]
					: [],
			},
			label: `deploy ${spec.name}`,
			target: spec,
		});
	}
	return requests;
}

async function implementationRequests(api: AceApi) {
	const remote = await api.list("/policy-implementations", "policy_implementations", { include_onchains: true });
	const requests: any[] = [];
	for (const item of manifest.policyImplementations) {
		const existing = recordByOnchain(remote, item.address, "onchain_policy_implementations");
		if (existing) {
			item.uuid = existing.id;
			continue;
		}
		requests.push({
			method: "POST",
			path: "/policy-implementations",
			body: {
				name: item.name,
				description: item.description ?? `Commertize ${item.name} implementation`,
				policy_config_schema: item.configSchema,
				onchain_policy_implementations: [{ chain_selector: CHAIN, address: item.address }],
			},
			label: `register ${item.name}`,
			target: item,
		});
	}
	return requests;
}

async function policyRequests(api: AceApi, engineUuid: string) {
	const remote = await api.list("/policies", "policies", {
		include_onchains: true,
		policy_engine_id: engineUuid,
	});
	const requests: any[] = [];
	for (const policy of manifest.policies) {
		const existing = remote.find(
			(r: any) => r.archived_at == null && r.name === policy.name && r.policy_engine_id === engineUuid
		);
		if (existing) {
			policy.uuid = existing.id;
			continue;
		}
		const impl = manifest.policyImplementations.find((item: any) => item.id === policy.implementation);
		invariant(impl.uuid, `${policy.id}: implementation ${policy.implementation} has no UUID yet`);
		requests.push({
			method: "POST",
			path: "/policies",
			body: {
				name: policy.name,
				description: policy.description ?? `Commertize ${policy.id} policy`,
				policy_implementation_id: impl.uuid,
				policy_engine_id: engineUuid,
				onchain_policies: [{ chain_selector: CHAIN, initial_config: policy.initialConfig }],
			},
			label: `create ${policy.name}`,
			target: policy,
		});
	}
	return requests;
}

async function targetRequests(api: AceApi, engineUuid: string) {
	const remote = await api.list("/targets", "targets", {
		include_onchains: true,
		policy_engine_id: engineUuid,
		chain_selector: CHAIN,
	});
	const requests: any[] = [];
	for (const target of manifest.targets) {
		const address = resolvedAddress(`outputs.registries.${target.registry}.address`);
		const existing = recordByOnchain(remote, address, "onchain_targets");
		if (existing) {
			target.uuid = existing.id;
			target.address = address;
			continue;
		}
		target.address = address;
		requests.push({
			method: "POST",
			path: "/targets",
			body: {
				title: target.id,
				description: `Commertize ${target.registry} target`,
				policy_engine_id: engineUuid,
				protected_methods: target.entrypoints,
				onchain_targets: [{ chain_selector: CHAIN, address }],
				desired_default_allow: target.desiredDefaultAllow,
			},
			label: `register ${target.id}`,
			target,
		});
	}
	return requests;
}

async function protectionRequests(api: AceApi) {
	const requests: any[] = [];
	for (const target of manifest.targets) {
		invariant(target.uuid, `${target.id}: target has no UUID yet`);
		invariant(target.address, `${target.id}: target address is missing`);
		const existing = await api.list(`/targets/${target.uuid}/protections`, "target_protections", {
			include_onchains: true,
		});
		for (const [position, step] of (target.policyChain ?? []).entries()) {
			const policy = manifest.policies.find((item: any) => item.id === step.policy);
			invariant(policy?.uuid, `${target.id}: policy ${step.policy} has no UUID yet`);
			for (const entrypoint of target.entrypoints) {
				const match = existing.find(
					(r: any) =>
						r.archived_at == null &&
						r.function_signature === entrypoint &&
						r.policy_instance_id === policy.uuid
				);
				if (match) continue;
				requests.push({
					method: "POST",
					path: `/targets/${target.uuid}/protections`,
					body: {
						function_signature: entrypoint,
						policy_instance_id: policy.uuid,
						desired_position: position,
						onchain_target_protections: [{ chain_selector: CHAIN }],
						extractor_output_ids: [],
					},
					label: `${target.id} ${entrypoint} -> ${policy.id} at position ${position}`,
					target: null,
				});
			}
		}
	}
	return requests;
}

// ── Write-back / readback ────────────────────────────────────────────────────
function writeBack() {
	// called only on apply after polling; persists the created resources so
	// deploy.ts and verify can reference them.
	const outputs = manifest.outputs;
	for (const item of manifest.extractors) {
		if (item.uuid) {
			outputs.extractors[item.id].uuid = item.uuid;
			outputs.extractors[item.id].address = item.address;
		}
	}
	if (manifest.engine?.uuid && manifest.engine.onchainAddress) {
		outputs.engine.uuid = manifest.engine.uuid;
		outputs.engine.address = manifest.engine.onchainAddress;
	}
	for (const [id, spec] of Object.entries<any>(manifest.registries)) {
		if (spec.uuid && spec.onchainAddress) {
			outputs.registries[id].uuid = spec.uuid;
			outputs.registries[id].address = spec.onchainAddress;
		}
	}
	for (const policy of manifest.policies) {
		if (policy.uuid && policy.onchainAddress) {
			outputs.policies[policy.id].uuid = policy.uuid;
			outputs.policies[policy.id].address = policy.onchainAddress;
		}
	}
	console.log(`NEXT  manifest ${manifestFile} updated; run scripts/deploy.ts (factory phase) and re-run plan/verify`);
}

function readbackState() {
	const output = manifest.outputs;
	invariant(output.engine?.address && output.engine.address !== zeroAddress, "outputs.engine.address is empty (run apply first)");
	invariant(
		output.registries.identityRegistry?.address !== zeroAddress && output.registries.credentialRegistry?.address !== zeroAddress,
		"registry addresses are empty (run apply first)"
	);
	return {
		engine: output.engine.address,
		identityRegistry: output.registries.identityRegistry.address,
		credentialRegistry: output.registries.credentialRegistry.address,
	};
}

// ── Pipeline ─────────────────────────────────────────────────────────────────
validateManifest();
if (command === "validate") process.exit(0);

try {
	process.loadEnvFile(path.join(import.meta.dirname, "..", ".env"));
} catch (error: any) {
	if (error?.code !== "ENOENT") throw error;
}
const apiKeyName = manifest.coordinatorApi.authorizationEnvironmentVariable ?? "ACE_API_KEY";
const api = new AceApi(manifest.coordinatorApi.baseUrl, process.env[apiKeyName]);
if (command === "apply") {
	invariant(manifest.coordinatorApi.tenantAuthenticationConfirmed === true, "Tenant authentication is not confirmed");
	invariant(
		flags["confirm-chain-selector"] === CHAIN,
		`apply requires --confirm-chain-selector ${CHAIN}`
	);
}
await verifyApiNetwork(api, CHAIN, manifest.network.chainId);

// 1. extractors
let requests = await extractorRequests(api);
for (const request of requests) {
	await writeAndResolve(api, request, "/extractors", "extractors", (record) =>
		record.name === request.body.name &&
		(record.onchain_extractors ?? []).some(
			(o: any) =>
				String(o.chain_selector) === CHAIN &&
				o.address?.toLowerCase() === request.target.address.toLowerCase()
		)
	);
}

// 2. engine (needs extractor UUIDs)
const extractorUuids = manifest.extractors
	.filter((item: any) => item.uuid)
	.map((item: any) => item.uuid);
invariant(extractorUuids.length === manifest.extractors.length, "extractor UUIDs are incomplete (rerun plan after extractors converge)");
const { engine, requests: engineReqs } = await engineRequests(api, extractorUuids);
for (const request of engineReqs) {
	await runWrite(request.method, request.path, request.body, request.label, api);
}
if (command === "apply") {
	manifest.engine = { ...manifest.engine, ...(engine ?? {}) };
	if (!manifest.engine.uuid) {
		const created = (await api.list("/policy-engines", "policy_engines", { include_onchains: true })).find(
			(r: any) => r.archived_at == null && r.name === manifest.engine.name
		);
		manifest.engine.uuid = created?.id;
	}
	invariant(manifest.engine.uuid, "engine UUID missing after apply");
	const ready = await waitForStatus(api, `/policy-engines/${manifest.engine.uuid}`, CHAIN, ["onchain_policy_engines"]);
	const onchain = (ready.onchain_policy_engines ?? []).find((r: any) => String(r.chain_selector) === CHAIN);
	manifest.engine.onchainAddress = onchain?.address;
	console.log(`OK    engine deployed: ${manifest.engine.onchainAddress}`);
} else {
	invariant(engine || engineReqs.length === 0, "engine is pending (rerun plan after the engine converges)");
}

// 3. registries
requests = await registryRequests(api);
for (const request of requests) {
	await writeAndResolve(api, request, "/registries", "registries", (record) => record.name === request.body.name);
}
if (command === "apply") {
	for (const [id, spec] of Object.entries<any>(manifest.registries)) {
		invariant(spec.uuid, `${id}: registry UUID missing after apply`);
		const fields = id === "identityRegistry" ? ["identity_registries"] : ["credential_registries"];
		const ready = await waitForStatus(api, `/registries/${spec.uuid}`, CHAIN, fields);
		spec.onchainAddress = (ready[fields[0]] ?? []).find((r: any) => String(r.chain_selector) === CHAIN)?.address;
		console.log(`OK    ${id} deployed: ${spec.onchainAddress}`);
	}
} else {
	invariant(requests.length === 0 || manifest.registries[Object.keys(manifest.registries)[0]].uuid, "registries are pending (rerun plan after they converge)");
}

// 4. policy implementations
requests = await implementationRequests(api);
for (const request of requests) {
	await writeAndResolve(api, request, "/policy-implementations", "policy_implementations", (record) => record.name === request.body.name);
}

// 5. policy instances (need engine UUID + implementation UUIDs)
invariant(manifest.engine.uuid, "engine UUID missing");
requests = await policyRequests(api, manifest.engine.uuid);
for (const request of requests) {
	await writeAndResolve(api, request, "/policies", "policies", (record) => record.name === request.body.name);
}
if (command === "apply") {
	for (const policy of manifest.policies) {
		invariant(policy.uuid, `${policy.id}: policy UUID missing after apply`);
		const ready = await waitForStatus(api, `/policies/${policy.uuid}`, CHAIN, ["onchain_policies"]);
		policy.onchainAddress = (ready.onchain_policies ?? []).find((r: any) => String(r.chain_selector) === CHAIN)?.address;
		console.log(`OK    policy ${policy.id} created: ${policy.onchainAddress}`);
	}
} else {
	invariant(requests.length === 0 || manifest.policies[0].uuid, "policies are pending (rerun plan after they converge)");
}

// 6. targets (need registry addresses)
requests = await targetRequests(api, manifest.engine.uuid);
for (const request of requests) {
	await writeAndResolve(api, request, "/targets", "targets", (record) => record.title === request.body.title);
}
if (command === "apply") {
	for (const target of manifest.targets) {
		invariant(target.uuid, `${target.id}: target UUID missing after apply`);
		await waitForStatus(api, `/targets/${target.uuid}`, CHAIN, ["onchain_targets"]);
	}
}

// 7. protections (need target UUIDs + policy UUIDs)
requests = await protectionRequests(api);
for (const request of requests) {
	await runWrite(request.method, request.path, request.body, request.label, api);
}
if (command === "apply" && requests.length > 0) {
	for (const target of manifest.targets) {
		const protections = await api.list(`/targets/${target.uuid}/protections`, "target_protections", { include_onchains: true });
		for (const entrypoint of target.entrypoints) {
			const records = protections.filter(
				(r: any) => r.archived_at == null && r.function_signature === entrypoint
			);
			for (const record of records) {
				await waitForStatus(api, `/targets/${target.uuid}/protections/${record.id}`, CHAIN, ["onchain_target_protections"]);
			}
			invariant(records.length > 0, `${target.id} ${entrypoint}: no protection found after apply`);
		}
	}
	console.log(`OK    ${manifest.targets.reduce((n: number, t: any) => n + t.entrypoints.length, 0)} protections created`);
}

// 8. write-back (apply) or onchain readback (verify)
if (command === "apply") {
	writeBack();
	await fs.promises.writeFile(manifestFile, JSON.stringify(manifest, null, "\t") + "\n");
}
if (command === "verify") {
	const state = readbackState();
	const engineContract = contractAt("PolicyEngine", state.engine);
	for (const item of manifest.extractors) {
		const actual = await engineContract.getExtractor(item.selector);
		invariant(actual.toLowerCase() === item.address.toLowerCase(), `${item.id}: onchain extractor mismatch (${actual})`);
		console.log(`OK    onchain ${item.selector} -> ${actual}`);
	}
	for (const target of manifest.targets) {
		const registryAddress = target.registry === "identityRegistry" ? state.identityRegistry : state.credentialRegistry;
		for (const entrypoint of target.entrypoints) {
			const policies = await engineContract.getPolicies(registryAddress, sel(entrypoint));
			invariant(policies.length > 0, `${target.id} ${entrypoint}: no onchain policies`);
			console.log(`OK    onchain ${target.id} ${entrypoint}: ${policies.length} policy(ies)`);
		}
	}
	console.log("OK    API state and onchain readback are converged");
}
