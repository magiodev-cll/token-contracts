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
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {PolicyEngine} from "@chainlink/policy-management/core/PolicyEngine.sol";
import {Policy} from "@chainlink/policy-management/core/Policy.sol";
import {
	OnlyAuthorizedSenderPolicy
} from "@chainlink/policy-management/policies/OnlyAuthorizedSenderPolicy.sol";
import {RejectPolicy} from "@chainlink/policy-management/policies/RejectPolicy.sol";
import {
	CredentialRegistryIdentityValidatorPolicy
} from "@chainlink/cross-chain-identity/CredentialRegistryIdentityValidatorPolicy.sol";
import {
	ICredentialRequirements
} from "@chainlink/cross-chain-identity/interfaces/ICredentialRequirements.sol";
import {
	ComplianceTokenERC3643
} from "@chainlink/ace/packages/tokens/erc-3643/src/ComplianceTokenERC3643.sol";

import "./PropertyToken.sol";
import "../finance/ListingEscrow.sol";
import "../finance/AccountExtractor.sol";

/**
 * @title PropertyFactory
 * @notice Deploys ACE-backed property listings: each product gets its own
 * `PropertyToken` (stock `ComplianceTokenERC3643`) plus product-specific ACE
 * policies, all attached to the shared `PolicyEngine`.
 * @dev This replaces the previous factory, which deployed bespoke tokens with a
 * hardcoded `TokenCompliance`. Compliance is now the ACE policy graph:
 *
 * - transfer/transferFrom: [eligibility(from,to), reject(to)]
 * - mint:                 [mintPolicy(sender), eligibility(account)]
 * - burn, pause, unpause, setName, setSymbol, forcedTransfer,
 *   setAddressFrozen, freezePartialTokens, unfreezePartialTokens:
 *                          [adminPolicy(sender)]
 *
 * The factory owns the mint policies so it can authorize escrows (and CCIP
 * pools) as minters after deployment.
 */
contract PropertyFactory is Ownable {
	struct ProductRecord {
		uint256 productId;
		address token;
		address eligibilityPolicy;
		address mintPolicy;
		address adminPolicy;
	}

	PolicyEngine public immutable policyEngine;
	address public immutable identityRegistry;
	address public immutable credentialRegistry;
	address public immutable rejectPolicy;
	address public immutable tokenImplementation;
	address public immutable eligibilityPolicyImplementation;
	address public immutable senderPolicyImplementation;
	address public immutable accountExtractor;

	uint256 public nextProductId = 1;

	// Deployment registry for tracking
	address[] public deployedEscrows;
	mapping(address => bool) public isEscrow;
	mapping(uint256 => ProductRecord) private productsById;

	event EscrowDeployed(address indexed escrow, address indexed property, address paymentToken, uint256 indexed index);
	event ProductCreated(
		uint256 indexed productId,
		address indexed token,
		address indexed eligibilityPolicy,
		address productOwner,
		address tokenAdmin
	);

	error InvalidAddress();
	error InvalidName();
	error InvalidSymbol();
	error ProductNotFound(uint256 productId);

	constructor(
		address initialOwner,
		address policyEngine_,
		address rejectPolicy_,
		address tokenImplementation_,
		address eligibilityPolicyImplementation_,
		address senderPolicyImplementation_
	) Ownable(initialOwner) {
		if (policyEngine_ == address(0)) revert InvalidAddress();

		policyEngine = PolicyEngine(policyEngine_);
		rejectPolicy = rejectPolicy_;
		tokenImplementation = tokenImplementation_;
		eligibilityPolicyImplementation = eligibilityPolicyImplementation_;
		senderPolicyImplementation = senderPolicyImplementation_;
		accountExtractor = address(new AccountExtractor());
	}

	/**
	 * @notice Creates a product with a single eligibility requirement set
	 * (KYC + AML, optionally + accredited).
	 * @param mintRequiresEligibility When true, mint checks the recipient's
	 * eligibility (issuance); when false, mint is authorization-only so a CCIP
	 * pool can deliver bridged tokens unconditionally (mint-and-freeze:
	 * transfers stay eligibility-gated).
	 */
	function createProduct(
		string calldata name,
		string calldata symbol,
		uint8 decimals,
		ICredentialRequirements.CredentialSourceInput[] calldata sources,
		ICredentialRequirements.CredentialRequirementInput[] calldata requirements,
		bool mintRequiresEligibility,
		address productOwner,
		address tokenAdmin
	) external onlyOwner returns (uint256 productId, address token, address eligibilityPolicy) {
		if (bytes(name).length == 0 || bytes(name).length > 100) revert InvalidName();
		if (bytes(symbol).length == 0 || bytes(symbol).length > 20) revert InvalidSymbol();

		address resolvedOwner = productOwner == address(0) ? owner() : productOwner;
		address resolvedAdmin = tokenAdmin == address(0) ? resolvedOwner : tokenAdmin;

		eligibilityPolicy = address(_deployEligibilityPolicy(sources, requirements));
		productId = _deployProduct(
			name, symbol, decimals, eligibilityPolicy, resolvedOwner, resolvedAdmin,
			mintRequiresEligibility
		);
		token = productsById[productId].token;
	}

	/**
	 * @notice Deploys a listing escrow for a product and authorizes it as a
	 * minter on the product's mint policy (so finalize() can mint shares).
	 */
	function deployEscrow(
		uint256 productId,
		address paymentToken,
		address sponsor,
		uint256 targetRaise,
		uint256 tokenSupply,
		uint256 deadline,
		address admin
	) external onlyOwner returns (address) {
		ProductRecord storage product = productsById[productId];
		if (product.token == address(0)) revert ProductNotFound(productId);

		ListingEscrow escrow = new ListingEscrow(
			product.token,
			address(policyEngine),
			paymentToken,
			sponsor,
			targetRaise,
			tokenSupply,
			deadline,
			admin
		);
		address escrowAddress = address(escrow);

		// Deposit selectors carry the investor as calldata/sender, so they
		// need the escrow extractor and the product's eligibility + reject
		// policies attached through the engine (the escrow itself holds no
		// compliance logic — `runPolicy` gates deposit/depositFor).
		policyEngine.setExtractor(ListingEscrow.deposit.selector, accountExtractor);
		policyEngine.setExtractor(ListingEscrow.depositFor.selector, accountExtractor);

		bytes32[] memory fromParam = new bytes32[](1);
		fromParam[0] = keccak256("from");
		bytes32[] memory accountParam = new bytes32[](1);
		accountParam[0] = keccak256("account");

		policyEngine.addPolicy(escrowAddress, ListingEscrow.deposit.selector, product.eligibilityPolicy, fromParam);
		policyEngine.addPolicy(escrowAddress, ListingEscrow.deposit.selector, rejectPolicy, fromParam);
		policyEngine.addPolicy(
			escrowAddress, ListingEscrow.depositFor.selector, product.eligibilityPolicy, accountParam
		);
		policyEngine.addPolicy(escrowAddress, ListingEscrow.depositFor.selector, rejectPolicy, accountParam);

		// The escrow mints shares to investors at finalize.
		OnlyAuthorizedSenderPolicy(product.mintPolicy).authorizeSender(escrowAddress);

		deployedEscrows.push(escrowAddress);
		isEscrow[escrowAddress] = true;

		emit EscrowDeployed(escrowAddress, product.token, paymentToken, deployedEscrows.length - 1);
		return escrowAddress;
	}

	/**
	 * @notice Get all deployed escrows
	 */
	function getDeployedEscrows() external view returns (address[] memory) {
		return deployedEscrows;
	}

	function getProduct(uint256 productId) external view returns (ProductRecord memory) {
		ProductRecord memory product = productsById[productId];
		if (product.token == address(0)) revert ProductNotFound(productId);
		return product;
	}

	function _deployProduct(
		string calldata name,
		string calldata symbol,
		uint8 decimals,
		address eligibilityPolicy,
		address productOwner,
		address tokenAdmin,
		bool mintRequiresEligibility
	) internal returns (uint256 productId) {
		// The factory keeps ownership of the mint policy so it can authorize
		// escrows and CCIP pools as minters after deployment; the admin policy
		// is transferred to the product owner.
		OnlyAuthorizedSenderPolicy mintPolicy = _deploySenderPolicy(productOwner, tokenAdmin, address(this));
		OnlyAuthorizedSenderPolicy adminPolicy = _deploySenderPolicy(productOwner, tokenAdmin, productOwner);

		address token = _deployToken(name, symbol, decimals, productOwner);
		_attachTokenPolicies(
			token, eligibilityPolicy, address(mintPolicy), address(adminPolicy), mintRequiresEligibility
		);

		productId = nextProductId++;
		productsById[productId] = ProductRecord({
			productId: productId,
			token: token,
			eligibilityPolicy: eligibilityPolicy,
			mintPolicy: address(mintPolicy),
			adminPolicy: address(adminPolicy)
		});

		emit ProductCreated(productId, token, eligibilityPolicy, productOwner, tokenAdmin);
	}

	function _deployEligibilityPolicy(
		ICredentialRequirements.CredentialSourceInput[] calldata sources,
		ICredentialRequirements.CredentialRequirementInput[] calldata requirements
	) internal returns (CredentialRegistryIdentityValidatorPolicy) {
		bytes memory initData = abi.encodeCall(
			Policy.initialize, (address(policyEngine), owner(), abi.encode(sources, requirements))
		);
		return CredentialRegistryIdentityValidatorPolicy(
			address(new ERC1967Proxy(eligibilityPolicyImplementation, initData))
		);
	}

	/// @dev Creates a sender policy owned by the factory, authorizes the
	/// listed accounts, then transfers ownership to `finalOwner` (the factory
	/// itself when it must keep authorizing new minters).
	function _deploySenderPolicy(
		address authorize1,
		address authorize2,
		address finalOwner
	) internal returns (OnlyAuthorizedSenderPolicy) {
		bytes memory initData =
			abi.encodeCall(Policy.initialize, (address(policyEngine), address(this), ""));
		OnlyAuthorizedSenderPolicy policy =
			OnlyAuthorizedSenderPolicy(address(new ERC1967Proxy(senderPolicyImplementation, initData)));
		policy.authorizeSender(authorize1);
		if (authorize2 != authorize1) {
			policy.authorizeSender(authorize2);
		}
		if (finalOwner != address(this)) {
			policy.transferOwnership(finalOwner);
		}
		return policy;
	}

	function _deployToken(string calldata name, string calldata symbol, uint8 decimals, address productOwner)
		internal
		returns (address)
	{
		bytes memory initData = abi.encodeCall(
			ComplianceTokenERC3643.initialize,
			(name, symbol, decimals, address(policyEngine))
		);
		ComplianceTokenERC3643 token =
			ComplianceTokenERC3643(payable(address(new ERC1967Proxy(tokenImplementation, initData))));
		token.transferOwnership(productOwner);
		return address(token);
	}

	/// @dev Stock-only policy graph. Batch helpers run per-item policies on the
	/// single-call selectors, so no policies are attached to batch selectors.
	function _attachTokenPolicies(
		address token,
		address eligibilityPolicy,
		address mintPolicy,
		address adminPolicy,
		bool mintRequiresEligibility
	) internal {
		bytes32[] memory emptyParams = new bytes32[](0);
		bytes32[] memory transferParams = new bytes32[](2);
		transferParams[0] = keccak256("from");
		transferParams[1] = keccak256("to");

		bytes32[] memory toParam = new bytes32[](1);
		toParam[0] = keccak256("to");

		bytes32[] memory accountParams = new bytes32[](1);
		accountParams[0] = keccak256("account");

		policyEngine.addPolicy(
			token, ComplianceTokenERC3643.transfer.selector, eligibilityPolicy, transferParams
		);
		policyEngine.addPolicy(token, ComplianceTokenERC3643.transfer.selector, rejectPolicy, toParam);
		policyEngine.addPolicy(
			token, ComplianceTokenERC3643.transferFrom.selector, eligibilityPolicy, transferParams
		);
		policyEngine.addPolicy(
			token, ComplianceTokenERC3643.transferFrom.selector, rejectPolicy, toParam
		);

		policyEngine.addPolicy(token, ComplianceTokenERC3643.mint.selector, mintPolicy, emptyParams);
		if (mintRequiresEligibility) {
			policyEngine.addPolicy(token, ComplianceTokenERC3643.mint.selector, eligibilityPolicy, accountParams);
		}

		policyEngine.addPolicy(token, ComplianceTokenERC3643.burn.selector, adminPolicy, emptyParams);
		policyEngine.addPolicy(token, ComplianceTokenERC3643.pause.selector, adminPolicy, emptyParams);
		policyEngine.addPolicy(token, ComplianceTokenERC3643.unpause.selector, adminPolicy, emptyParams);
		policyEngine.addPolicy(token, ComplianceTokenERC3643.setName.selector, adminPolicy, emptyParams);
		policyEngine.addPolicy(token, ComplianceTokenERC3643.setSymbol.selector, adminPolicy, emptyParams);
		policyEngine.addPolicy(
			token, ComplianceTokenERC3643.forcedTransfer.selector, adminPolicy, emptyParams
		);
		policyEngine.addPolicy(
			token, ComplianceTokenERC3643.setAddressFrozen.selector, adminPolicy, emptyParams
		);
		policyEngine.addPolicy(
			token, ComplianceTokenERC3643.freezePartialTokens.selector, adminPolicy, emptyParams
		);
		policyEngine.addPolicy(
			token, ComplianceTokenERC3643.unfreezePartialTokens.selector, adminPolicy, emptyParams
		);
	}



	/// @dev Two groups, first-match routing: accredited (KYC+AML+accredited)
	/// before retail (KYC+AML). Every requirement's credential type needs a
	/// source entry in its group (the retail group also needs an accredited
	/// source for its inverted requirement).


}
