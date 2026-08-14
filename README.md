# @commertize/token-contracts

Smart contracts for Commertize — compliance-gated tokenization of commercial
real estate, with Chainlink CCIP cross-chain bridging and a Chainlink CRE oracle
for on-chain property valuation.

## Installation

```bash
pnpm add @commertize/token-contracts
```

## Quick start

Addresses, ABIs, and network metadata are resolved at import time from the
active deployment (see [Networks](#networks)):

```typescript
import { ethers } from "ethers";
import {
	CONTRACTS,
	ABIS,
	RPC_URL,
	getIdentityRegistryContract,
} from "@commertize/token-contracts";

const provider = new ethers.JsonRpcProvider(RPC_URL);

// Option A: build from the exported address map + ABI
const registry = new ethers.Contract(
	CONTRACTS.IdentityRegistry,
	ABIS.IdentityRegistry,
	provider,
);

// Option B: use a typed helper (reads the address from the active deployment)
const registry2 = getIdentityRegistryContract(provider);
```

## Architecture

The system is four layers on an EVM chain (Arbitrum One by default), tied
together by the Chainlink ACE compliance stack: the `PolicyEngine` enforces
eligibility, reject (sanctions) and admin policies on the token's and escrow's
selectors.

```mermaid
flowchart TD
    subgraph Compliance["Chainlink ACE"]
      PE[PolicyEngine]
      IR[IdentityRegistry]
      CR[CredentialRegistry]
      RP[RejectPolicy]
      WP[WriterPolicy]
      WP -.gates.-> IR
      WP -.gates.-> CR
    end
    subgraph Tokenization
      PF[PropertyFactory] --> PT[PropertyToken]
    end
    subgraph Finance
      LE[ListingEscrow]
      DV[DividendVault]
    end
    subgraph CrossChain["Cross-chain / Oracle"]
      POOL[CompliantPropertyTokenPool]
      SS[IdentitySyncSender] --> SR[IdentitySyncReceiver]
      NAV[PropertyNavConsumer]
    end
    PE -.policies.-> PT
    PE -.policies.-> LE
    PT -.eligibility.-> CR
    PF --> LE
    PT --> DV
    PT --> POOL
    SR --> IR
    SR --> CR
    NAV -.NAV feed.-> DV
```

### Compliance (Chainlink ACE)

Compliance is not implemented in this repo anymore — it is the stock
[Chainlink ACE](https://github.com/smartcontractkit/chainlink-ace) stack
(`@chainlink/ace@1.2.0`):

- **`PolicyEngine`** — the shared rule engine; policies are attached per
  selector (eligibility, reject/sanctions, admin) and can be changed without
  redeploying the protected contracts.
- **`IdentityRegistry` + `CredentialRegistry`** — wallet → CCID mapping and
  credentials (KYC/AML/accredited) with expiry. Mutations are governed by an
  `OnlyAuthorizedSenderPolicy` writer policy; issuers are authorized by adding
  their address to it.
- **Policies** — stock only: `OnlyAuthorizedSenderPolicy` (registry writes,
  token admin/mint), `CredentialRegistryIdentityValidatorPolicy` (eligibility:
  KYC + AML, optionally accredited), `RejectPolicy` (sanctions denylist).
- **Onboarding** — an authorized issuer calls the registries directly
  (the ACE advanced getting-started pattern); CCID = `bytes32(uint160(wallet))`.

### Tokenization (`src/tokenization/`)

- **PropertyToken** — stock ACE `ComplianceTokenERC3643` (UUPS, policy-protected)
  plus the snapshot mechanism used for dividend distribution and the funds
  vault (`withdrawFunds`). Compliance is enforced by ACE policies on
  mint/transfer/transferFrom, not by contract code; `burn(uint256)`/`burnFrom`
  provide the `IBurnMintERC20` surface for CCIP pools, and `getCCIPAdmin()` the
  CCT registration hook. Mint-and-freeze bridging is preserved via
  `mintRequiresEligibility=false` products: a bridge mint always delivers, but
  transfers stay eligibility-gated.
- **PropertyFactory** — deploys each listing's token plus its product policies
  (eligibility, reject, admin) and escrows; shared implementations are deployed
  once and proxied per product.

### Finance (`src/finance/`)

- **ListingEscrow** — holds property tokens and investor funds during a
  time-bound raise; finalizes to the sponsor when the target is met and
  distributes tokens, or refunds on a failed raise. `ReentrancyGuard`, `Pausable`,
  minimum-deposit and hard-cap protection, bounded investor tracking. Shares
  whose direct transfer fails at finalize park in a `pendingTokens` reserve
  that admin distribution/recovery paths cannot spend. For raises with very
  large investor counts, `finalize()`'s distribution loop can exceed block gas —
  `adminFinalize()` + chunked `adminDistributeTokens()` is the escape hatch.
- **DividendVault** — distributes property income (USDC) to holders pro-rata by
  snapshot balance, with a configurable protocol fee, batch claims, and recovery
  of unclaimed funds after a timeout. `ReentrancyGuard`, `Pausable`. Deposits
  are restricted to vetted properties (`setPropertyValid`) and to the property
  or vault owner. **Deposit only after the raise is finalized**: a dividend
  deposited while the escrow still holds unsold supply allocates that share to
  the escrow, which can never claim it (recoverable only via the one-year
  `recoverUnclaimed` sweep).

### Cross-chain (Chainlink CCIP / CCT) (`src/ccip/`)

- **CompliantPropertyTokenPool** — a CCIP `BurnMintTokenPool` that gates the
  **destination receiver** against the local `IdentityRegistry` in `lockOrBurn`,
  *before* burning. Because identity is mirrored to every chain, an
  unverified receiver can never be the target of a cross-chain transfer.
- **IdentitySyncSender** / **IdentitySyncReceiver** — broadcast KYC
  register/remove events from the home chain to every configured destination
  over CCIP, applied under `SYNC_ROLE`, so "verified anywhere ⇒ verified
  everywhere." This is what makes source-side gating sound. Every message
  carries a per-user monotonic sequence number; receivers discard anything at
  or below the last applied sequence, so CCIP's lack of cross-message ordering
  (or a manually re-executed stale message) can never resurrect a removed
  identity.

### Oracle (Chainlink CRE) (`src/oracle/`, `cre/`)

- **PropertyNavConsumer** — a Chainlink CRE report sink (built on the keystone
  `ReceiverTemplate`). A `KeystoneForwarder` calls `onReport` with a signed
  property-NAV report; the consumer accepts strictly-newer reports and exposes
  `latestNav(propertyId)` for the rest of the ecosystem to read.
- **`cre/nav-workflow/`** — the CRE workflow scaffold that produces those
  reports: cron trigger → per-node NAV/appraisal fetch → median consensus →
  on-chain write. See [`cre/README.md`](./cre/README.md). This is a scaffold —
  no production real-estate oracle is wired to a live data source yet.

## Chainlink integration

| Product | Where | What it does |
|---|---|---|
| **CCT** (Cross-Chain Token) | `PropertyToken.getCCIPAdmin()`, `burn`/`burnFrom` | Self-serve `TokenAdminRegistry` registration; `IBurnMintERC20` surface |
| **CCIP** | `CompliantPropertyTokenPool`, `IdentitySync{Sender,Receiver}` | Burn/mint bridging with source-side compliance gating + cross-chain KYC identity sync |
| **CRE** | `src/oracle/`, `cre/` | Property-NAV oracle: consensus-aggregated valuation written on-chain |

CCIP addresses (router, chain selector, RMN proxy, LINK, TokenAdminRegistry) are
configured per network in [`networks.ts`](./networks.ts).

### Control-plane configuration (ACE Coordinator API)

Everything ACE is managed through the ACE Platform, not raw onchain calls.
Surface per [`scripts/ace-api-docs/ace-coordinator-api-doc.json`](./scripts/ace-api-docs/ace-coordinator-api-doc.json).

- **Hardhat deploys only Commertize's own infra** (`scripts/deploy.ts`,
  two phases): extractor contracts (stock + `AccountExtractor`) and policy
  implementation contracts (`DEPLOY_PHASE=extractors`), then the
  `PropertyFactory` + `PropertyToken` implementation
  (`DEPLOY_PHASE=factory`, wired to the API-created engine and RejectPolicy).
- **The Coordinator API creates and wires everything ACE-owned**
  (`scripts/configure-ace.ts`, `validate | plan | apply | verify`,
  dry-run-first, apply requires `ACE_CONFIG_CONFIRM_CHAIN_SELECTOR`): deploys
  the `PolicyEngine`, deploys the identity/credential registries, registers
  extractors and policy implementations, creates policy instances (writer,
  reject), registers targets and attaches protections — each resource polled
  until onchain status is `created`. `apply` writes the created addresses back
  to [`scripts/ace-configuration.json`](./scripts/ace-configuration.json);
  `verify` reconciles API state against onchain readback (`getExtractor`,
  `getPolicies`).
- **Identity/credential issuance is the IDV partner's job** (e.g. SumSub
  creating CCIDs and attaching wallets through the Identity Manager API), not
  the deployer EOA's. In a self-managed KYC scenario your backend drives the
  Coordinator API's identity/credential endpoints directly.
- **Beta caveats:** self-deployed contracts aren't visible in the platform
  UI/API during Beta (the managed path deploys through the API via CRE
  Connect), and custom extractors (our escrow `AccountExtractor`) are beyond
  the Beta platform surface (ERC-20/ERC-3643 signatures only) — they still
  work onchain, just not platform-manageable yet.
- Product tokens and escrows are factory-created per product; their per-product
  wiring is factory-owned onchain and outside the manifest's scope (see the
  manifest `notes`).

## Deployment strategy — Arbitrum first, CRE before CCIP

Arbitrum One is the target home chain for production; Arbitrum Sepolia is its
staging mirror. Both Chainlink integrations are code-complete and tested, but
they activate in phases:

1. **Core protocol on Arbitrum** — own infra via
   `pnpm deploy:extractors` then `pnpm deploy:factory` (factory + token
   implementation), with the ACE-owned surface (`PolicyEngine`, registries,
   policy instances, protections) created through the Coordinator API
   (`pnpm config-ace:plan` → `config-ace:apply` → `config-ace:verify`).
   Finance contracts (`ListingEscrow`, `DividendVault`) deploy with the
   factory phase. USDC is Circle-native on both networks.
2. **Pricing oracles via CRE (current focus).** The platform has no on-chain
   pricing oracles today; the first Chainlink integration to go live is the
   property-NAV oracle: deploy `PropertyNavConsumer` with the chain's
   `KeystoneForwarder`, then run the [`cre/nav-workflow`](./cre/README.md)
   against the Arbitrum target. Downstream pricing (dividends, escrow,
   dashboards) reads `latestNav`.
3. **CCIP / CCT cross-chain (next phase).** Identity sync
   (`IdentitySyncSender/Receiver`) and the compliant token pool are wired per
   lane with `scripts/setup-identity-sync.ts` and `scripts/ccip-register.ts`
   once a second chain is in play. Not part of the initial Arbitrum rollout.

**Topology invariant (bridged lanes).** Source-side gating is only sound if
every chain a token bridges to is mint-and-freeze. Every listing uses the same
ACE `PropertyToken`; bridged products are created with
`mintRequiresEligibility=false` so the pool's inbound mints always deliver
(CCIP's OffRamp needs the exact receiver balance delta), while transfers stay
eligibility-gated — an unverified receiver holds but cannot move tokens. The
CCIP pool is authorized as a minter on the product's mint policy
(`authorizeMinter`); source-side gating checks the product's eligibility policy
in `lockOrBurn`. `scripts/ccip-register.ts` verifies the policy/pool linkage
per lane and warns when a token is not bridge-capable.

## Security model

- **Single compliance chokepoint.** Every balance change flows through
  `PropertyToken._update → _checkCompliance`. There is no separate transfer path;
  approvals/permit set allowance only and never move balances.
- **Mint-and-freeze on bridged tokens.** Delivery can't be blocked without
  stranding burned tokens, so an unverified bridge recipient holds frozen tokens
  until KYC completes rather than being rejected.
- **Source-side bridge gating.** The pool checks the destination receiver before
  burning, backed by cross-chain identity mirroring.
- **Least privilege.** KYC mirroring runs under a dedicated `SYNC_ROLE` that can
  only register/remove identities — not grant roles or move tokens.
- **Single verification path.** `VERIFIED_ROLE` cannot be granted, revoked, or
  renounced directly; it only moves through `registerIdentity`/`removeIdentity`
  (or their `SYNC_ROLE` mirrors), so country validation and the identity map
  can never be skipped or left inconsistent.
- **Ordered identity sync.** Register/remove broadcasts embed a per-user
  monotonic sequence number enforced by every receiver; sync messages are sent
  with out-of-order execution allowed, so a stuck message can't head-of-line
  block later removals and a stale replay is a no-op. Each receiver accepts
  exactly one active source chain (sequence spaces must not mix); registry
  updates and broadcasts are separate admin calls — pair them operationally so
  chains don't drift.
- **Fail-closed wiring.** The policy engine runs allow-by-default — the
  documented pattern: no stock policy except `BypassPolicy` returns `Allowed`,
  so a reject-by-default engine would block even the issuer's own writes.
  Fail-closed is therefore enforced by coverage: `deployAceCore` and the smoke
  suite assert that every protected selector (token transfer/mint/admin
  operations, registry writes, escrow deposits) has policies attached, and the
  deployment refuses to proceed otherwise.
- **Fault-tolerant distribution.** `ListingEscrow.finalize()` cannot be bricked
  by a single non-compliant investor: failed transfers park in `pendingTokens`
  for a later `claimTokens()` pull once the investor is verified again.
- **Closed dividend recovery.** `recoverUnclaimed` permanently closes a
  distribution, so late claimants cannot draw the recovered amount out of other
  distributions' funds. Claims themselves are compliance-gated: an unverified
  holder's share waits until they re-verify.
- **Reentrancy & pausability.** `ListingEscrow` and `DividendVault` use
  OpenZeppelin `ReentrancyGuard` and `Pausable`; all token movements use
  `SafeERC20`.
- **Snapshot-based dividends** capture holder balances at distribution time.
  Snapshots are taken by the owner or an explicitly authorized snapshotter
  (`setSnapshotter`) — the vault no longer needs to own the token.

The compliance and cross-chain contracts have undergone an internal security
review.

## Networks

Configured in [`networks.ts`](./networks.ts). The active network is selected by
the `EVM_NETWORK` env var (also `VITE_EVM_NETWORK` / `NEXT_PUBLIC_EVM_NETWORK`),
defaulting to `arc-testnet`.

| Network | Chain ID | Native | Notes |
|---|---|---|---|
| `arbitrum-one` | 42161 | ETH | Production home chain (target); CCIP-configured |
| `arbitrum-sepolia` | 421614 | ETH | Staging for the Arbitrum rollout; CCIP-configured |
| `arc-testnet` | 5042002 | USDC | Current default; CCIP-configured |
| `ethereum-sepolia` | 11155111 | ETH | CCIP destination / oracle target |
| `localhost` | 5042002 | USDC | Local Anvil node (see `pnpm test:e2e`) |

`EVM_NETWORK` still defaults to `arc-testnet`; the default flips to Arbitrum
with the deployment cutover, not before.

USDC is **not** deployed by this package — it is assumed to already exist on the
target chain and is read from the deployment config or `USDC_ADDRESS`.

Deployment loading precedence:

1. `DEPLOYMENT_JSON` env var (raw JSON or object) — for CI/CD.
2. Bundled `deployment.<network>.json` (underscored, e.g. `deployment.arc_testnet.json`).
3. Fallback to the `networks.ts` entry for the selected network.

## Development

```bash
pnpm install
pnpm compile           # hardhat build
pnpm test              # hardhat test
pnpm config-ace:validate
pnpm deploy:extractors # own infra, phase 1: extractor + policy implementation contracts
pnpm config-ace:plan   # ACE API dry run (needs ACE_API_KEY + org access)
pnpm config-ace:apply  # creates the PolicyEngine, registries, policies, protections
pnpm deploy:factory    # own infra, phase 2: factory + token implementation
pnpm config-ace:verify # API state vs onchain readback
```

Hardhat tests exercise the full stack on a local node through the shared
harness (`scripts/lib/ace-core.ts`), which simulates the Coordinator API's end
state; production configuration is API-driven (`scripts/configure-ace.ts`).
CI runs the unit suites on every push/PR
([.github/workflows/e2e.yaml](./.github/workflows/e2e.yaml)).

> Note: `test/TestnetValidation.ts` self-skips (via `process.exit(0)`) when no
> `deployment.default.json` is present, which ends the whole `hardhat test` run
> early. Run the unit suites explicitly, e.g.
> `hardhat test test/SmokeTest.ts test/PropertyTokenSnapshot.ts test/ListingEscrowRefund.ts test/ListingEscrowDistribution.ts test/DividendVault.ts test/PropertyNavOracle.ts`.
> `IdentitySync` and `CCIPCompliantPool` are being ported to the ACE stack and
> are re-enabled as they land.

## Exports

**Config (resolved at import):** `NETWORK`, `CHAIN_ID`, `CURRENCY`, `RPC_URL`,
`BLOCK_EXPLORER_URL`, `CONTRACTS`, `Deployment`, `USDC_ADDRESS`.

**ABIs:** `ABIS` (`IdentityRegistry`, `USDC`, `DividendVault`,
`PropertyFactory`, `PropertyToken`, `ListingEscrow`, `IdentitySyncSender`,
`PropertyNavConsumer`), plus `ListingEscrowAbi` and `ErrorStringAbi`.

**Contract helpers.** Singletons read their address from the active deployment
and take just a runner: `getIdentityRegistryContract`,
`getUSDCContract`, `getDividendVaultContract`, `getPropertyFactoryContract`.
Per-listing / per-chain contracts take an explicit address:
`getPropertyTokenContract(address, runner)` (alias `getTokenContract`),
`getEscrowContract(address, runner)`,
`getIdentitySyncSenderContract(address, runner)`,
`getPropertyNavConsumerContract(address, runner)`.

Full artifacts (ABI + bytecode) for backend deployment are exported as
`IdentitySyncSenderArtifact` and `PropertyNavConsumerArtifact`. ACE core
contracts deploy through the build-info based tooling in
`scripts/lib/ace-core.ts`.

## License

MIT, except `src/ccip/CompliantPropertyTokenPool.sol` (BUSL-1.1). Vendored
Chainlink keystone interfaces under `src/oracle/keystone/` are MIT.
