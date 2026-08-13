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

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {PolicyProtected} from "@chainlink/policy-management/core/PolicyProtected.sol";
import {
	ComplianceTokenERC3643
} from "@chainlink/ace/packages/tokens/erc-3643/src/ComplianceTokenERC3643.sol";

/**
 * @title ListingEscrow
 * @notice Holds Property Tokens and Investor Funds until a funding goal is met.
 * @dev Same flow as before, with the compliance layer moved to ACE:
 *
 * 1. `deposit`/`depositFor` are policy-protected (`runPolicy`): the escrow
 *    inherits ACE `PolicyProtected` and the product's eligibility and reject
 *    policies are attached to its deposit selectors by the factory, so the
 *    engine itself gates who can invest — the same policies the token
 *    enforces on mint/transfer. No separate compliance check exists in the
 *    escrow contract.
 *
 * 2. Distribution at finalize mints tokens to investors instead of
 *    transferring a pre-funded escrow balance. The escrow is authorized as a
 *    minter on the product's mint policy (OnlyAuthorizedSenderPolicy), and
 *    each mint still runs the eligibility policy against the recipient.
 *    Investors whose credentials lapsed are parked in `pendingTokens` and
 *    minted on `claimTokens()` once compliant again — same UX as before.
 *
 * 3. Raised funds go straight to the sponsor. The old flow parked them in the
 *    PropertyToken-as-vault contract (`withdrawFunds`); the token still has
 *    the vault surface for other flows, but the escrow no longer depends on it.
 *
 * The escrow must be authorized on the product's mint policy before
 * finalize() (PropertyFactory.deployEscrow does this).
 */
contract ListingEscrow is PolicyProtected, ReentrancyGuard, Pausable {
	using SafeERC20 for IERC20;
	using EnumerableSet for EnumerableSet.AddressSet;

	// Minimum deposit to prevent dust spam
	uint256 public constant MIN_DEPOSIT = 1000;

	// Configuration
	ComplianceTokenERC3643 public propertyToken;
	IERC20 public paymentToken; // If address(0), uses Native Token
	address public sponsor;
	uint256 public targetRaise;
	uint256 public tokenSupply; // Tokens distributed when the raise is fully subscribed
	uint256 public deadline;
	address public admin; // Admin address (separate from owner)

	mapping(address => uint256) public deposits; // How much each user deposited
	EnumerableSet.AddressSet private _investors; // Deduplicated investor set
	uint256 public totalRaised;

	// Token shares whose mint failed during finalize (e.g. the investor's KYC
	// lapsed between deposit and finalize). Claimable via claimTokens() once
	// the investor is compliant again.
	mapping(address => uint256) public pendingTokens;
	// Sum of all pendingTokens: balance reserved for claimants that admin
	// distribution paths must never spend.
	uint256 public totalPendingTokens;

	// State
	bool public finalized;
	bool public refunded;

	// Events
	event Deposited(address indexed investor, uint256 amount);
	event Finalized(uint256 totalRaised, uint256 timestamp);
	event Refunded(address indexed investor, uint256 amount);
	event AdminFinalized(
		uint256 totalRaised,
		uint256 timestamp,
		address indexed admin
	);
	event AdminTokensDistributed(
		address indexed investor,
		uint256 amount,
		address indexed admin
	);
	event AdminUpdated(address indexed oldAdmin, address indexed newAdmin);
	event RefundsEnabled(address indexed by);
	event TokensPending(address indexed investor, uint256 amount);
	event TokensClaimed(address indexed investor, uint256 amount);

	error EscrowClosed();
	error DeadlinePassed();
	error BelowMinimumDeposit();
	error ExceedsTargetRaise();
	error InvalidInvestor();
	error InvalidAddress();
	error NoDeposit();
	error RefundsNotOpen();
	error NothingToClaim();
	error AlreadyFinalized();
	error ArrayLengthMismatch();
	error InvalidAmount();
	error NativeDepositForNotAllowed();

	constructor(
		address _propertyToken,
		address _policyEngine,
		address _paymentToken,
		address _sponsor,
		uint256 _targetRaise,
		uint256 _tokenSupply,
		uint256 _deadline,
		address _admin
	) PolicyProtected(_admin, _policyEngine) {
		require(_propertyToken != address(0), "Invalid property token");
		require(_sponsor != address(0), "Invalid sponsor");
		require(_targetRaise > 0, "Invalid target raise");
		require(_deadline > block.timestamp, "Invalid deadline");
		require(_admin != address(0), "Invalid admin");
		// Note: _paymentToken can be address(0) for native token

		propertyToken = ComplianceTokenERC3643(_propertyToken);
		paymentToken = IERC20(_paymentToken);
		sponsor = _sponsor;
		targetRaise = _targetRaise;
		tokenSupply = _tokenSupply;
		deadline = _deadline;
		admin = _admin; // Set admin (can be same as owner or different)
	}

	/**
	 * @dev Modifier to check if caller is admin or owner
	 */
	modifier onlyAdminOrOwner() {
		require(msg.sender == admin || msg.sender == owner(), "Not admin or owner");
		_;
	}

	/**
	 * @notice Invest in the listing.
	 * @param amount Amount of payment tokens (ignored if Native).
	 */
	function deposit(uint256 amount) public payable runPolicy nonReentrant whenNotPaused {
		require(!finalized && !refunded, "Escrow closed");
		require(block.timestamp < deadline, "Deadline passed");

		uint256 depositAmount;

		if (address(paymentToken) == address(0)) {
			// Native
			require(msg.value >= MIN_DEPOSIT, "Below minimum deposit");
			depositAmount = msg.value;
		} else {
			// ERC20
			require(amount >= MIN_DEPOSIT, "Below minimum deposit");
			depositAmount = amount;
			paymentToken.safeTransferFrom(msg.sender, address(this), amount);
		}


		require(totalRaised + depositAmount <= targetRaise, "Exceeds target raise");

		_investors.add(msg.sender);
		deposits[msg.sender] += depositAmount;
		totalRaised += depositAmount;

		emit Deposited(msg.sender, depositAmount);
	}

	/**
	 * @notice Allow admin/backend to deposit on behalf of a user (using transferFrom).
	 * @param investor Address of the investor.
	 * @param amount Amount to pull from the investor.
	 */
	function depositFor(
		address investor,
		uint256 amount
	) external runPolicy nonReentrant whenNotPaused {
		require(!finalized && !refunded, "Escrow closed");
		require(block.timestamp < deadline, "Deadline passed");
		require(amount >= MIN_DEPOSIT, "Below minimum deposit");
		require(
			address(paymentToken) != address(0),
			"Cannot call depositFor with Native Asset"
		);
		require(investor != address(0), "Invalid investor");

		// Enforce Hard Cap
		require(totalRaised + amount <= targetRaise, "Exceeds target raise");

		// Pull funds from Investor (Investor must have approved Escrow)
		paymentToken.safeTransferFrom(investor, address(this), amount);

		_investors.add(investor);
		deposits[investor] += amount;
		totalRaised += amount;

		emit Deposited(investor, amount);
	}

	/**
	 * @notice Finalize the raise if target is met.
	 * @dev Moves funds to the sponsor and mints tokens to investors. The
	 * escrow must be authorized as a minter on the product's mint policy.
	 */
	function finalize() external nonReentrant whenNotPaused {
		require(!finalized && !refunded, "Already closed");
		require(totalRaised >= targetRaise, "Target not met");
		require(block.timestamp >= deadline, "Deadline not passed");

		finalized = true;

		// Send funds to the sponsor (see contract header for the vault change).
		if (address(paymentToken) == address(0)) {
			Address.sendValue(payable(sponsor), totalRaised);
		} else {
			paymentToken.safeTransfer(sponsor, totalRaised);
		}

		// Mint tokens to investors pro-rata. A failing mint (e.g. an investor
		// whose KYC lapsed since depositing) must not revert the whole
		// distribution, so failed shares park in pendingTokens for a later
		// claimTokens() pull instead.
		uint256 investorCount = _investors.length();
		for (uint256 i = 0; i < investorCount; i++) {
			address investor = _investors.at(i);
			uint256 investorDeposit = deposits[investor];

			if (investorDeposit > 0) {
				// Calculate proportional token amount
				// tokenShare = (investorDeposit / totalRaised) * tokenSupply
				uint256 tokenShare = (investorDeposit * tokenSupply) / totalRaised;

				if (tokenShare > 0) {
					try propertyToken.mint(investor, tokenShare) {
						emit AdminTokensDistributed(
							investor,
							tokenShare,
							address(this)
						);
					} catch {
						pendingTokens[investor] += tokenShare;
						totalPendingTokens += tokenShare;
						emit TokensPending(investor, tokenShare);
					}
				}
			}
		}

		emit Finalized(totalRaised, block.timestamp);
	}

	/**
	 * @notice Pull tokens whose mint failed during finalize().
	 * @dev Succeeds once the caller passes the product's eligibility again.
	 */
	function claimTokens() external nonReentrant {
		require(finalized, "Not finalized");
		uint256 amount = pendingTokens[msg.sender];
		require(amount > 0, "Nothing to claim");

		// Mint first, then clear: a failed mint leaves the pending record intact.
		propertyToken.mint(msg.sender, amount);

		pendingTokens[msg.sender] = 0;
		totalPendingTokens -= amount;
		emit TokensClaimed(msg.sender, amount);
	}

	/**
	 * @notice Admin can finalize the raise (even before target) and send funds to sponsor.
	 * @dev Unsold tokens are never minted (mint on demand), which is
	 * equivalent to burning unsold supply in the pre-funded model.
	 */
	function adminFinalize() external onlyAdminOrOwner nonReentrant {
		require(!finalized, "Already finalized");
		require(!refunded, "Refund mode active");

		finalized = true;

		// Transfer payment to the sponsor.
		if (address(paymentToken) == address(0)) {
			Address.sendValue(payable(sponsor), totalRaised);
		} else {
			paymentToken.safeTransfer(sponsor, totalRaised);
		}

		emit AdminFinalized(totalRaised, block.timestamp, msg.sender);
	}

	/**
	 * @notice Admin-only function to distribute property tokens to investors.
	 * @param investorList Array of investor addresses to receive tokens.
	 * @param amounts Array of token amounts corresponding to each investor.
	 * @dev This allows admin to manually distribute tokens based on investment records.
	 */
	function adminDistributeTokens(
		address[] calldata investorList,
		uint256[] calldata amounts
	) external onlyAdminOrOwner nonReentrant {
		require(investorList.length == amounts.length, "Array length mismatch");
		require(finalized, "Must finalize first");

		for (uint256 i = 0; i < investorList.length; i++) {
			require(investorList[i] != address(0), "Invalid investor address");
			require(amounts[i] > 0, "Invalid amount");

			propertyToken.mint(investorList[i], amounts[i]);
			emit AdminTokensDistributed(investorList[i], amounts[i], msg.sender);
		}
	}

	/**
	 * @notice Admin/owner opens refund mode deliberately (e.g. a regulatory
	 * halt) before the deadline or on a met target. This is the ONLY way to
	 * refund a raise that reached its target; the permissionless refund() path
	 * is restricted to genuinely failed raises so a single investor cannot brick
	 * finalize() on a successful raise.
	 */
	function enableRefunds() external onlyAdminOrOwner {
		require(!finalized, "Already finalized");
		refunded = true;
		emit RefundsEnabled(msg.sender);
	}

	/**
	 * @notice Claim refund if the raise failed (deadline passed without meeting
	 * the target) or an admin has opened refunds via enableRefunds().
	 * @dev Must NOT be callable on a successful raise: refunded flips a global
	 * flag that finalize()/adminFinalize() block on, so allowing it after a met
	 * target lets any investor permanently brick the sponsor's finalize.
	 */
	function refund() external nonReentrant {
		require(!finalized, "Raise successful");
		require(
			refunded || (block.timestamp >= deadline && totalRaised < targetRaise),
			"Refunds not open"
		);

		// Lock in refund mode for the rest of the escrow's life.
		refunded = true;

		uint256 userDeposit = deposits[msg.sender];
		require(userDeposit > 0, "No deposit");

		deposits[msg.sender] = 0; // Prevent re-entrancy

		if (address(paymentToken) == address(0)) {
			Address.sendValue(payable(msg.sender), userDeposit);
		} else {
			paymentToken.safeTransfer(msg.sender, userDeposit);
		}

		emit Refunded(msg.sender, userDeposit);
	}

	/**
	 * @notice Admin-only function to batch refund investors.
	 * @param investorList Array of investor addresses to refund.
	 * @dev This allows admin to process refunds on behalf of investors.
	 *      Can only be called if not finalized and after deadline or refunded flag is set.
	 */
	function adminBatchRefund(
		address[] calldata investorList
	) external onlyAdminOrOwner nonReentrant {
		require(!finalized, "Raise successful");
		require(
			refunded || (block.timestamp >= deadline && totalRaised < targetRaise),
			"Refunds not open"
		);

		// Mark as refunded state
		refunded = true;

		for (uint256 i = 0; i < investorList.length; i++) {
			address investor = investorList[i];
			uint256 userDeposit = deposits[investor];

			if (userDeposit == 0) {
				continue; // Skip if no deposit
			}

			deposits[investor] = 0; // Clear deposit to prevent re-entrancy

			if (address(paymentToken) == address(0)) {
				Address.sendValue(payable(investor), userDeposit);
			} else {
				paymentToken.safeTransfer(investor, userDeposit);
			}

			emit Refunded(investor, userDeposit);
		}
	}

	/**
	 * @notice Update admin address (owner only)
	 * @param _newAdmin New admin address
	 */
	function setAdmin(address _newAdmin) external onlyOwner {
		require(_newAdmin != address(0), "Invalid admin address");
		address oldAdmin = admin;
		admin = _newAdmin;
		emit AdminUpdated(oldAdmin, _newAdmin);
	}

	/**
	 * @notice Get total number of investors
	 */
	function getInvestorCount() external view returns (uint256) {
		return _investors.length();
	}

	/**
	 * @notice Get investor address by index
	 * @param index Index in the investor set
	 */
	function getInvestor(uint256 index) external view returns (address) {
		require(index < _investors.length(), "Index out of bounds");
		return _investors.at(index);
	}

	/**
	 * @notice Get all investors (use with caution for large sets)
	 */
	function getAllInvestors() external view returns (address[] memory) {
		return _investors.values();
	}

	/**
	 * @notice Pause contract (owner only)
	 */
	function pause() external onlyOwner {
		_pause();
	}

	/**
	 * @notice Unpause contract (owner only)
	 */
	function unpause() external onlyOwner {
		_unpause();
	}
}
