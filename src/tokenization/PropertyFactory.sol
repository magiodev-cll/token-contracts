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
import {
	CredentialRegistryIdentityValidatorPolicy
} from "@chainlink/cross-chain-identity/CredentialRegistryIdentityValidatorPolicy.sol";
import {
	GroupedIdentityValidatorPolicy
} from "@chainlink/cross-chain-identity/GroupedIdentityValidatorPolicy.sol";
import {
	IGroupedCredentialRequirements
} from "@chainlink/cross-chain-identity/interfaces/IGroupedCredentialRequirements.sol";
import {
	ICredentialRequirements
} from "@chainlink/cross-chain-identity/interfaces/ICredentialRequirements.sol";
import {
	ComplianceTokenERC3643
} from "@chainlink/ace/packages/tokens/erc-3643/src/ComplianceTokenERC3643.sol";

import "./PropertyToken.sol";
import "../finance/ListingEscrow.sol";
import "../policies/SanctionsPolicy.sol";

/**
 * @title PropertyFactory
 * @notice Deploys ACE-backed property listings: each product gets its own
 * `PropertyToken` (stock `ComplianceTokenERC3643`) plus product-specific ACE
 * policies, all attached to the shared `PolicyEngine`.
 * @dev This replaces the previous factory, which deployed bespoke tokens with a
 * hardcoded `TokenCompliance`. Compliance is now the ACE policy graph:
 *
 * - transfer/transferFrom: [eligibility(from,to), sanctions(to)]
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
		address productOwner;
		address tokenAdmin;
		string name;
		string symbol;
		uint8 decimals;
		bool grouped;
	}

	PolicyEngine public immutable policyEngine;
	address public immutable identityRegistry;
	address public immutable credentialRegistry;
	address public immutable sanctionsPolicy;
	address public immutable tokenImplementation;
	address public immutable eligibilityPolicyImplementation;
	address public immutable groupedPolicyImplementation;
	address public immutable senderPolicyImplementation;

	bytes32 public immutable kycCredentialType;
	bytes32 public immutable amlCredentialType;
	bytes32 public immutable accreditedCredentialType;

	uint256 public nextProductId = 1;

	// Deployment registry for tracking
	address[] public deployedProperties;
	address[] public deployedEscrows;
	mapping(address => bool) public isPropertyToken;
	mapping(address => bool) public isEscrow;
	mapping(uint256 => ProductRecord) private productsById;
	mapping(address => uint256) public escrowProduct;

	event PropertyDeployed(address indexed property, string name, string symbol, uint256 indexed index);
	event EscrowDeployed(address indexed escrow, address indexed property, address paymentToken, uint256 indexed index);
	event ProductCreated(
		uint256 indexed productId,
		address indexed token,
		address indexed eligibilityPolicy,
		bool grouped,
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
		address sanctionsPolicy_,
		address tokenImplementation_,
		address eligibilityPolicyImplementation_,
		address groupedPolicyImplementation_,
		address senderPolicyImplementation_
	) Ownable(initialOwner) {
		if (policyEngine_ == address(0)) revert InvalidAddress();

		policyEngine = PolicyEngine(policyEngine_);
		sanctionsPolicy = sanctionsPolicy_;
		tokenImplementation = tokenImplementation_;
		eligibilityPolicyImplementation = eligibilityPolicyImplementation_;
		groupedPolicyImplementation = groupedPolicyImplementation_;
		senderPolicyImplementation = senderPolicyImplementation_;
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
			name, symbol, decimals, false, eligibilityPolicy, resolvedOwner, resolvedAdmin,
			mintRequiresEligibility
		);
		token = productsById[productId].token;
	}

	/**
	 * @notice Creates a product with segmented eligibility: accredited
	 * investors route to the accredited group (KYC + AML + accredited), all
	 * other investors to the retail group (KYC + AML). First-match routing.
	 * @param mintRequiresEligibility See createProduct.
	 */
	function createGroupedProduct(
		string calldata name,
		string calldata symbol,
		uint8 decimals,
		IGroupedCredentialRequirements.GroupInput[] calldata groups,
		IGroupedCredentialRequirements.GroupRequirementInput[] calldata groupRequirements,
		IGroupedCredentialRequirements.GroupSourceInput[] calldata groupSources,
		bool mintRequiresEligibility,
		address productOwner,
		address tokenAdmin
	) external onlyOwner returns (uint256 productId, address token, address eligibilityPolicy) {
		if (bytes(name).length == 0 || bytes(name).length > 100) revert InvalidName();
		if (bytes(symbol).length == 0 || bytes(symbol).length > 20) revert InvalidSymbol();

		address resolvedOwner = productOwner == address(0) ? owner() : productOwner;
		address resolvedAdmin = tokenAdmin == address(0) ? resolvedOwner : tokenAdmin;

		eligibilityPolicy = address(_deployGroupedPolicy(groups, groupRequirements, groupSources));
		productId = _deployProduct(
			name, symbol, decimals, true, eligibilityPolicy, resolvedOwner, resolvedAdmin,
			mintRequiresEligibility
		);
		token = productsById[productId].token;
	}

	/**
	 * @notice Authorizes an operator (escrow, CCIP pool) as a minter on a
	 * product's mint policy.
	 */
	function authorizeMinter(uint256 productId, address minter) external onlyOwner {
		ProductRecord storage product = productsById[productId];
		if (product.token == address(0)) revert ProductNotFound(productId);
		OnlyAuthorizedSenderPolicy(product.mintPolicy).authorizeSender(minter);
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
			product.eligibilityPolicy,
			paymentToken,
			sponsor,
			targetRaise,
			tokenSupply,
			deadline,
			admin
		);
		address escrowAddress = address(escrow);

		// The escrow mints shares to investors at finalize.
		OnlyAuthorizedSenderPolicy(product.mintPolicy).authorizeSender(escrowAddress);

		deployedEscrows.push(escrowAddress);
		isEscrow[escrowAddress] = true;
		escrowProduct[escrowAddress] = productId;

		emit EscrowDeployed(escrowAddress, product.token, paymentToken, deployedEscrows.length - 1);
		return escrowAddress;
	}

	/**
	 * @notice Get all deployed property tokens
	 */
	function getDeployedProperties() external view returns (address[] memory) {
		return deployedProperties;
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
		bool grouped,
		address eligibilityPolicy,
		address productOwner,
		address tokenAdmin,
		bool mintRequiresEligibility
	) internal returns (uint256 productId) {
		// The factory keeps ownership of the mint policy so it can authorize
		// escrows and CCIP pools as minters after deployment.
		OnlyAuthorizedSenderPolicy mintPolicy = _deploySenderPolicy(owner());
		OnlyAuthorizedSenderPolicy adminPolicy = _deploySenderPolicy(productOwner);
		adminPolicy.authorizeSender(tokenAdmin);
		adminPolicy.transferOwnership(productOwner);

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
			adminPolicy: address(adminPolicy),
			productOwner: productOwner,
			tokenAdmin: tokenAdmin,
			name: name,
			symbol: symbol,
			decimals: decimals,
			grouped: grouped
		});

		deployedProperties.push(token);
		isPropertyToken[token] = true;

		emit PropertyDeployed(token, name, symbol, deployedProperties.length - 1);
		emit ProductCreated(productId, token, eligibilityPolicy, grouped, productOwner, tokenAdmin);
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

	function _deployGroupedPolicy(
		IGroupedCredentialRequirements.GroupInput[] calldata groups,
		IGroupedCredentialRequirements.GroupRequirementInput[] calldata groupRequirements,
		IGroupedCredentialRequirements.GroupSourceInput[] calldata groupSources
	) internal returns (GroupedIdentityValidatorPolicy) {
		bytes memory initData = abi.encodeCall(
			Policy.initialize, (address(policyEngine), owner(), abi.encode(groups, groupRequirements, groupSources))
		);
		return GroupedIdentityValidatorPolicy(
			address(new ERC1967Proxy(groupedPolicyImplementation, initData))
		);
	}

	function _deploySenderPolicy(address policyOwner) internal returns (OnlyAuthorizedSenderPolicy) {
		bytes memory initData =
			abi.encodeCall(Policy.initialize, (address(policyEngine), policyOwner, ""));
		OnlyAuthorizedSenderPolicy policy =
			OnlyAuthorizedSenderPolicy(address(new ERC1967Proxy(senderPolicyImplementation, initData)));
		policy.authorizeSender(policyOwner);
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
		policyEngine.addPolicy(token, ComplianceTokenERC3643.transfer.selector, sanctionsPolicy, toParam);
		policyEngine.addPolicy(
			token, ComplianceTokenERC3643.transferFrom.selector, eligibilityPolicy, transferParams
		);
		policyEngine.addPolicy(
			token, ComplianceTokenERC3643.transferFrom.selector, sanctionsPolicy, toParam
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
