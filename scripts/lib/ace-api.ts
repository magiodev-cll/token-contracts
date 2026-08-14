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
import assert from "node:assert";

export const invariant = assert;
import { isAddress } from "viem";

export const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_MANIFEST = path.join(SCRIPT_DIR, "..", "ace-configuration.json");
export const COORDINATOR_API_URL = "https://ace.api.chain.link/v1";

export async function readJson(file: string) {
	return JSON.parse(await fs.promises.readFile(file, "utf8"));
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

export async function verifyApiNetwork(api: AceApi, chainSelector: string, chainId: number) {
	const network = await api.get(`/networks/${chainSelector}`);
	invariant(String(network.chain_selector) === String(chainSelector), "ACE API chain selector mismatch");
	invariant(String(network.chain_id) === String(chainId), "ACE API chain ID mismatch");
	return network;
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
		const statuses = fields.map((field) => {
			const record = ((resource[field] as any[] | undefined) ?? []).find(
				(item: any) => String(item.chain_selector) === String(chainSelector)
			);
			return record?.status ?? "missing";
		});
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
