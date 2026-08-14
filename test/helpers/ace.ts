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
// Test-facing re-export of the shared ACE core deploy logic (also used by the
// deploy tooling in scripts/lib/ace-core.ts, so tests and deployment stay in
// lockstep).
export {
	ethers,
	KYC,
	AML,
	ACCREDITED,
	sel,
	ccidFor,
	deployAceCore,
	deployProxy,
	aceFactory,
	contractAt,
	onboard,
	baseEligibilityConfig,
	tokenSurface,
	escrowSurface,
	identityRegistrySurface,
	credentialRegistrySurface,
	assertPolicyCoverage,
} from "../../scripts/lib/ace-core";
export type { AceCore, Credentials } from "../../scripts/lib/ace-core";
