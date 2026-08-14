// ┌───────────────────────────────────────────────────────────────────────────┐
// │  UNREVIEWED PROOF OF CONCEPT -- DO NOT USE IN PRODUCTION.                 │
// │                                                                           │
// │  THIS CODE HAS NOT BEEN AUDITED AND HAS NOT BEEN REVIEWED FOR SECURITY.   │
// │  IT IS DEPLOYED ON A TEST NETWORK FOR INTEGRATION TESTING AND DEVELOPMENT │
// │  PURPOSES ONLY. IT IS NOT SUITABLE FOR PRODUCTION USE, AND IT MUST NOT BE │
// │  USED TO HOLD OR MOVE ANY ASSET OF VALUE.                                 │
// └───────────────────────────────────────────────────────────────────────────┘
// Coordinator API client for the ACE control plane (https://ace.api.chain.link).
// Surface per scripts/ace-api-docs/ace-coordinator-api-doc.json. The API owns
// everything ACE: PolicyEngine deployment, registries, policy instances and
// policy attachment. Hardhat owns only Commertize's own infra contracts
// (extractors, policy implementations, factory, tokens - scripts/deploy.ts).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_DIR = path.resolve(SCRIPT_DIR, "..", "..");
export const DEFAULT_MANIFEST = path.join(SCRIPT_DIR, "..", "ace-configuration.json");
export const COORDINATOR_API_URL = "https://ace.api.chain.link/v1";

export function invariant(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

export function isAddress(value: unknown): value is string {
	return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

export function sameStrings(left: string[], right: string[]) {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

export async function readJson(file: string) {
	return JSON.parse(await fs.promises.readFile(file, "utf8"));
}

export async function loadDotEnv(file = path.join(REPO_DIR, ".env")) {
	let source: string;
	try {
		source = await fs.promises.readFile(file, "utf8");
	} catch (error: any) {
		if (error?.code === "ENOENT") return;
		throw error;
	}
	for (const [index, rawLine] of source.split(/\r?\n/).entries()) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const separator = line.indexOf("=");
		invariant(separator > 0, `Invalid .env syntax on line ${index + 1}`);
		const key = line.slice(0, separator).trim();
		let value = line.slice(separator + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		if (!(key in process.env)) process.env[key] = value;
	}
}

export function requireApplyConfirmation(
	command: string,
	flags: Record<string, string>,
	policyEngine: string,
	chainId: number
) {
	if (command !== "apply") return;
	invariant(
		flags["confirm-policy-engine"]?.toLowerCase() === policyEngine.toLowerCase(),
		`apply requires --confirm-policy-engine ${policyEngine}`
	);
	invariant(String(flags["confirm-chain-id"]) === String(chainId), `apply requires --confirm-chain-id ${chainId}`);
}

function safeApiError(method: string, url: URL, response: Response, payload: any) {
	const detail = payload?.message ?? payload?.error ?? response.statusText;
	return new Error(`${method} ${url.pathname}: ${response.status} ${detail}`);
}

export class AceApi {
	readonly baseUrl: URL;
	private readonly apiKey: string;
	private readonly timeoutMs: number;

	constructor(baseUrl: string, apiKey: string, timeoutMs = Number(process.env.ACE_HTTP_TIMEOUT_MS ?? 30_000)) {
		invariant(apiKey, "ACE_API_KEY is required for plan, apply, and verify");
		this.baseUrl = new URL(baseUrl);
		const expected = new URL(COORDINATOR_API_URL);
		invariant(
			this.baseUrl.origin === expected.origin &&
				this.baseUrl.pathname.replace(/\/$/, "") === expected.pathname &&
				!this.baseUrl.username &&
				!this.baseUrl.password &&
				!this.baseUrl.search &&
				!this.baseUrl.hash,
			`ACE API base URL must be ${COORDINATOR_API_URL}`
		);
		this.apiKey = apiKey;
		this.timeoutMs = timeoutMs;
	}

	async request(
		method: string,
		pathname: string,
		{ query, body }: { query?: Record<string, unknown>; body?: unknown } = {}
	) {
		const url = new URL(pathname.replace(/^\//, ""), `${this.baseUrl.toString().replace(/\/$/, "")}/`);
		for (const [key, value] of Object.entries(query ?? {})) {
			if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
		}
		const response = await fetch(url, {
			method,
			redirect: "error",
			signal: AbortSignal.timeout(this.timeoutMs),
			headers: {
				Accept: "application/json",
				Authorization: `Apikey ${this.apiKey}`,
				...(body === undefined ? {} : { "Content-Type": "application/json" }),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const text = await response.text();
		let payload: any = null;
		if (text) {
			try {
				payload = JSON.parse(text);
			} catch {
				payload = { message: "non-JSON response" };
			}
		}
		if (!response.ok) throw safeApiError(method, url, response, payload);
		return payload;
	}

	get(pathname: string, options?: { query?: Record<string, unknown> }) {
		return this.request("GET", pathname, options);
	}

	post(pathname: string, body: unknown) {
		return this.request("POST", pathname, { body });
	}

	put(pathname: string, body: unknown) {
		return this.request("PUT", pathname, { body });
	}

	patch(pathname: string, body: unknown) {
		return this.request("PATCH", pathname, { body });
	}

	async list(pathname: string, collectionKey: string, query: Record<string, unknown> = {}) {
		const items: any[] = [];
		for (let page = 1; ; page++) {
			const payload = await this.get(pathname, { query: { ...query, page, page_size: 100 } });
			invariant(Array.isArray(payload?.[collectionKey]), `${pathname} response is missing ${collectionKey}`);
			items.push(...payload[collectionKey]);
			const totalPages = Number(payload.total_pages ?? 1);
			if (page >= totalPages) return items;
		}
	}
}

export async function findPolicyEngine(api: AceApi, chainSelector: string, address: string) {
	const engines = await api.list("/policy-engines", "policy_engines", { include_onchains: true });
	const matches = engines.filter(
		(engine: any) =>
			engine.archived_at == null &&
			(engine.onchain_policy_engines ?? []).some(
				(onchain: any) =>
					String(onchain.chain_selector) === chainSelector &&
					onchain.address?.toLowerCase() === address.toLowerCase() &&
					onchain.status === "created"
			)
	);
	invariant(matches.length === 1, `Expected one existing PolicyEngine at ${address}, found ${matches.length}`);
	return matches[0];
}

export async function verifyApiNetwork(api: AceApi, chainSelector: string, chainId: number) {
	const network = await api.get(`/networks/${chainSelector}`);
	invariant(String(network.chain_selector) === String(chainSelector), "ACE API chain selector mismatch");
	invariant(String(network.chain_id) === String(chainId), "ACE API chain ID mismatch");
	return network;
}

export function statusOf(onchain: unknown[] | undefined, chainSelector: string) {
	const record = (onchain ?? []).find(
		(item: any) => String(item.chain_selector) === String(chainSelector)
	);
	return record?.status ?? "missing";
}

/** Polls a resource until every requested onchain sub-resource reports "created". */
export async function waitForStatus(
	api: AceApi,
	pathname: string,
	chainSelector: string,
	fields: string[],
	timeoutMs = 120_000
) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const resource = await api.get(pathname, { query: { include_onchains: true } });
		const statuses = fields.map((field) => statusOf(resource[field], chainSelector));
		if (statuses.every((status) => status === "created")) return resource;
		if (statuses.some((status) => status === "creation_failed" || status === "failed")) {
			throw new Error(`${pathname}: creation failed on ${chainSelector}`);
		}
		if (Date.now() > deadline) {
			throw new Error(`${pathname}: not created on ${chainSelector} after ${timeoutMs}ms (${statuses.join(", ")})`);
		}
		await new Promise((resolve) => setTimeout(resolve, 5_000));
	}
}
