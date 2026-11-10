/**
 * In-memory fallback mock data and simulated backend for the Recourse Web App.
 *
 * When the real indexer API (:8080) is offline or unreachable, these fixtures
 * provide a 100% functional, interactive experience:
 *   - The 7-scenario demo runner with live progress simulation
 *   - Sabotage mode toggling
 *   - Live agent hiring and document processing
 *   - Claim inspection, arbiter verdict diffs, and payout breakdowns
 *   - Vaults, sealed-bid rounds, and underwriter persona rationales
 *   - Full unit economics and solvency audit metrics
 */

import type {
  AgentRow,
  ClaimDetail,
  DocumentRow,
  Economics,
  EngagementDetail,
  Health,
  PublishedReceipt,
  RunScenario,
  RunStatus,
  Totals,
  VaultsResponse,
} from "./api";

const DECIMALS = 24;
const UNIT = 10n ** BigInt(DECIMALS);
const nearToYocto = (n: number) => (BigInt(Math.round(n * 1000)) * UNIT / 1000n).toString();

const hoursAgoNs = (h: number) => (BigInt(Date.now() - h * 3600 * 1000) * 1_000_000n).toString();
const inHoursNs = (h: number) => (BigInt(Date.now() + h * 3600 * 1000) * 1_000_000n).toString();

export const MOCK_HEALTH: Health = {
  ok: true,
  mode: "sandbox",
  contract: "recourse.testnet",
  head: 104250,
  events: 142,
  demo: true,
};

export const MOCK_DOCUMENTS: DocumentRow[] = [
  {
    index: 0,
    name: "01-northwind-invoice.md",
    terms_hash: "3b29c98da5fbc2a4ef035178619bcad07f2dfd864eef8ad3d0e2e28a50992ec4",
    truth: {
      invoice_number: "NWR-2026-0412",
      issue_date: "2026-10-03",
      due_date: "2026-11-02",
      vendor_name: "Northwind Robotics Ltd.",
      customer_name: "Brightwater Logistics Co.",
      po_number: "PO-77310",
      currency: "USD",
      subtotal: "1125.00",
      tax: "90.00",
      total: "1215.00",
    },
  },
  {
    index: 1,
    name: "02-quillfeather-invoice.md",
    terms_hash: "9e1c7f920da8a1bb045bc90064fa1351296cc7a7f4740e5ecf91bf6e21689ea5",
    truth: {
      invoice_number: "QF/8841",
      issue_date: "2026-09-15",
      due_date: "2026-10-15",
      vendor_name: "Quillfeather Stationery Co-op",
      customer_name: "Marigold School Trust",
      po_number: null,
      currency: "EUR",
      subtotal: "900.00",
      tax: "180.00",
      total: "1080.00",
    },
  },
  {
    index: 2,
    name: "03-tidewater-invoice.md",
    terms_hash: "28e7bb01ae2b4c19356fa0d1a4990c6fb022e3ea5954c274bbad8869ffca3428",
    truth: {
      invoice_number: "TW-INV-00977",
      issue_date: "2026-10-31",
      due_date: "2026-11-14",
      vendor_name: "Tidewater Cloud Hosting",
      customer_name: "Juniper Analytics GmbH",
      po_number: "JA-PO-5520",
      currency: "GBP",
      subtotal: "1100.00",
      tax: "0.00",
      total: "1100.00",
    },
  },
  {
    index: 3,
    name: "04-amberline-invoice.md",
    terms_hash: "a52140bb0ef93512ae30c492196ca74092d6e3c0994f83aa3d40fa8892bc511e",
    truth: {
      invoice_number: "AFS-31-2207",
      issue_date: "2026-08-21",
      due_date: "2026-10-05",
      vendor_name: "Amberline Freight Services",
      customer_name: "Copperleaf Farms Ltd",
      po_number: "PO-0099-CF",
      currency: "CAD",
      subtotal: "3860.00",
      tax: "193.00",
      total: "4053.00",
    },
  },
  {
    index: 4,
    name: "05-lumen-invoice.md",
    terms_hash: "46f821cc098ae032cb4125b098dc027a4d55b0a7c413bca88921dfbb094e47aa",
    truth: {
      invoice_number: "LMN-4091",
      issue_date: "2026-10-18",
      due_date: "2026-11-18",
      vendor_name: "Lumen Optics",
      customer_name: "Starlight Diagnostics",
      po_number: "SD-2026-1002",
      currency: "USD",
      subtotal: "850.00",
      tax: "0.00",
      total: "850.00",
    },
  },
];

export const MOCK_TOTALS: Totals = {
  solvency: {
    bonds: nearToYocto(430),
    vault_capital: nearToYocto(500),
    escrow: nearToYocto(15),
    claim_stakes: nearToYocto(2),
    pending_payouts: "0",
    bid_deposits: nearToYocto(3),
    held: nearToYocto(950),
    storage_reserved: nearToYocto(8.5),
    unattributed: nearToYocto(10),
    owed: "0",
    liabilities: nearToYocto(950),
    surplus: nearToYocto(85),
    storage_ok: true,
    ok: true,
  },
  config: {
    bond_asset: "Native",
    min_bond: nearToYocto(10),
    withdrawal_cooldown: hoursAgoNs(24),
    claim_window: hoursAgoNs(48),
    appeal_window: hoursAgoNs(24),
    bid_commit_window: "3600000000000",
    bid_reveal_window: "3600000000000",
    claim_stake_bps: 500,
    base_bond_share_bps: 5000,
    min_bond_share_bps: 2000,
    max_vault_exposure_bps: 3000,
    council: "council.recourse.testnet",
  },
  counters: {
    engagement: 7,
    claim: 3,
    round: 3,
  },
  roles: {
    owner: "admin.recourse.testnet",
    arbiters: ["arbiter.recourse.testnet", "arbiter-backup.recourse.testnet"],
    keepers: ["keeper.recourse.testnet"],
    council: "council.recourse.testnet",
  },
  claims_paid: 3,
  value_paid_out: nearToYocto(3.2),
  agents: 4,
};

export const MOCK_AGENTS: AgentRow[] = [
  {
    id: "northwind-extractor.near",
    agent: {
      operator: "worker1.recourse.testnet",
      metadata_uri: "near://agents/northwind-extractor",
      stats: {
        completed: 42,
        failed: 1,
        claims_upheld: 0,
        claims_rejected: 2,
        volume: nearToYocto(84),
        slashed_total: "0",
      },
      registered_at: hoursAgoNs(180),
    },
    bond: {
      amount: nearToYocto(50),
      locked: nearToYocto(12),
      withdrawal_requested_at: null,
      withdrawal_amount: "0",
      open_claims: 0,
    },
    coverage: {
      vault: "cautious-vault.near",
      limit: nearToYocto(100),
      premium_bps: 250,
      bound_at: hoursAgoNs(48),
      expires_at: inHoursNs(120),
    },
    score: {
      score_bps: 9840,
      required_bond_share_bps: 2000,
      premium_floor_bps: 172,
      max_liability_multiplier_bps: 49360,
    },
  },
  {
    id: "quill-processor.near",
    agent: {
      operator: "worker2.recourse.testnet",
      metadata_uri: "near://agents/quill-processor",
      stats: {
        completed: 28,
        failed: 2,
        claims_upheld: 1,
        claims_rejected: 1,
        volume: nearToYocto(56),
        slashed_total: nearToYocto(2),
      },
      registered_at: hoursAgoNs(140),
    },
    bond: {
      amount: nearToYocto(100),
      locked: nearToYocto(25),
      withdrawal_requested_at: null,
      withdrawal_amount: "0",
      open_claims: 0,
    },
    coverage: {
      vault: "balanced-vault.near",
      limit: nearToYocto(150),
      premium_bps: 450,
      bound_at: hoursAgoNs(72),
      expires_at: inHoursNs(96),
    },
    score: {
      score_bps: 9210,
      required_bond_share_bps: 2600,
      premium_floor_bps: 283,
      max_liability_multiplier_bps: 46840,
    },
  },
  {
    id: "tidewater-auditor.near",
    agent: {
      operator: "worker3.recourse.testnet",
      metadata_uri: "near://agents/tidewater-auditor",
      stats: {
        completed: 85,
        failed: 0,
        claims_upheld: 0,
        claims_rejected: 0,
        volume: nearToYocto(170),
        slashed_total: "0",
      },
      registered_at: hoursAgoNs(200),
    },
    bond: {
      amount: nearToYocto(250),
      locked: nearToYocto(40),
      withdrawal_requested_at: null,
      withdrawal_amount: "0",
      open_claims: 0,
    },
    coverage: {
      vault: "aggressive-vault.near",
      limit: nearToYocto(300),
      premium_bps: 180,
      bound_at: hoursAgoNs(120),
      expires_at: inHoursNs(168),
    },
    score: {
      score_bps: 9950,
      required_bond_share_bps: 2000,
      premium_floor_bps: 155,
      max_liability_multiplier_bps: 49800,
    },
  },
  {
    id: "amberline-worker.near",
    agent: {
      operator: "worker4.recourse.testnet",
      metadata_uri: "near://agents/amberline-worker",
      stats: {
        completed: 15,
        failed: 3,
        claims_upheld: 2,
        claims_rejected: 0,
        volume: nearToYocto(30),
        slashed_total: nearToYocto(4),
      },
      registered_at: hoursAgoNs(90),
    },
    bond: {
      amount: nearToYocto(30),
      locked: nearToYocto(15),
      withdrawal_requested_at: null,
      withdrawal_amount: "0",
      open_claims: 0,
    },
    coverage: {
      vault: "balanced-vault.near",
      limit: nearToYocto(50),
      premium_bps: 720,
      bound_at: hoursAgoNs(24),
      expires_at: inHoursNs(48),
    },
    score: {
      score_bps: 8400,
      required_bond_share_bps: 3800,
      premium_floor_bps: 450,
      max_liability_multiplier_bps: 43600,
    },
  },
];

export const MOCK_VAULTS_RESPONSE: VaultsResponse = {
  vaults: [
    {
      id: "cautious-vault.near",
      vault: {
        underwriter: "underwriter1.recourse.testnet",
        capital: nearToYocto(200),
        locked: nearToYocto(45),
        total_shares: nearToYocto(200),
        premiums_earned: nearToYocto(6.5),
        losses_paid: "0",
        prices_retained: nearToYocto(1.2),
      },
    },
    {
      id: "balanced-vault.near",
      vault: {
        underwriter: "underwriter2.recourse.testnet",
        capital: nearToYocto(180),
        locked: nearToYocto(80),
        total_shares: nearToYocto(180),
        premiums_earned: nearToYocto(8.2),
        losses_paid: nearToYocto(2.0),
        prices_retained: nearToYocto(1.8),
      },
    },
    {
      id: "aggressive-vault.near",
      vault: {
        underwriter: "underwriter3.recourse.testnet",
        capital: nearToYocto(120),
        locked: nearToYocto(65),
        total_shares: nearToYocto(120),
        premiums_earned: nearToYocto(3.7),
        losses_paid: nearToYocto(1.2),
        prices_retained: nearToYocto(0.9),
      },
    },
  ],
  rounds: [
    {
      id: 1,
      round: {
        agent: "northwind-extractor.near",
        requested_limit: nearToYocto(100),
        opened_at: hoursAgoNs(49),
        commit_deadline: hoursAgoNs(48.5),
        reveal_deadline: hoursAgoNs(48),
        status: "Settled",
        winner: { vault: "cautious-vault.near", premium_bps: 250 },
        bids: [
          {
            underwriter: "cautious-vault.near",
            commitment: "a4f89d3c5b8e1a7f0c2e4d6a8b0c2e4f6a8b0c2e4d6a8b0c2e4f6a8b0c2e4f6a",
            committed_at: hoursAgoNs(48.8),
            deposit: nearToYocto(1),
            premium_bps: 250,
          },
          {
            underwriter: "balanced-vault.near",
            commitment: "b5e90e4d6c9f2b8a1d3f5e7b9c1d3f5a7b9c1d3f5e7b9c1d3f5a7b9c1d3f5a7b",
            committed_at: hoursAgoNs(48.7),
            deposit: nearToYocto(1),
            premium_bps: 320,
          },
          {
            underwriter: "aggressive-vault.near",
            commitment: "c6f01f5e7da03c9b2e4a6f8c0d2e4a6b8c0d2e4a6f8c0d2e4a6b8c0d2e4a6b8c",
            committed_at: hoursAgoNs(48.6),
            deposit: nearToYocto(1),
            premium_bps: 290,
          },
        ],
      },
    },
    {
      id: 2,
      round: {
        agent: "quill-processor.near",
        requested_limit: nearToYocto(150),
        opened_at: hoursAgoNs(73),
        commit_deadline: hoursAgoNs(72.5),
        reveal_deadline: hoursAgoNs(72),
        status: "Settled",
        winner: { vault: "balanced-vault.near", premium_bps: 450 },
        bids: [
          {
            underwriter: "balanced-vault.near",
            commitment: "d7a12a6f8eb14d0c3f5b7a9d1e3f5b7c9d1e3f5b7a9d1e3f5b7c9d1e3f5b7c9d",
            committed_at: hoursAgoNs(72.8),
            deposit: nearToYocto(1),
            premium_bps: 450,
          },
          {
            underwriter: "cautious-vault.near",
            commitment: "e8b23b7a9fc25e1d4a6c8b0e2f4a6c8d0e2f4a6c8b0e2f4a6c8d0e2f4a6c8d0e",
            committed_at: hoursAgoNs(72.7),
            deposit: nearToYocto(1),
            premium_bps: 580,
          },
        ],
      },
    },
    {
      id: 3,
      round: {
        agent: "tidewater-auditor.near",
        requested_limit: nearToYocto(300),
        opened_at: hoursAgoNs(121),
        commit_deadline: hoursAgoNs(120.5),
        reveal_deadline: hoursAgoNs(120),
        status: "Settled",
        winner: { vault: "aggressive-vault.near", premium_bps: 180 },
        bids: [
          {
            underwriter: "aggressive-vault.near",
            commitment: "f9c34c8b0ad36f2e5b7d9c1f3a5b7d9e1f3a5b7d9c1f3a5b7d9e1f3a5b7d9e1f",
            committed_at: hoursAgoNs(120.8),
            deposit: nearToYocto(1),
            premium_bps: 180,
          },
          {
            underwriter: "cautious-vault.near",
            commitment: "0ad45d9c1be47a3f6c8e0d2a4b6c8e0f2a4b6c8e0d2a4b6c8e0f2a4b6c8e0f2a",
            committed_at: hoursAgoNs(120.6),
            deposit: nearToYocto(1),
            premium_bps: 240,
          },
        ],
      },
    },
  ],
  rationales: [
    {
      round: 1,
      underwriter: "cautious-vault.near",
      persona: "cautious",
      bid: true,
      premiumBps: 250,
      rationale: "Agent northwind-extractor has 42 completed jobs and 0 upheld claims. Score is 98.4%. Standard risk profile allows 250 bps premium.",
      at: new Date(Date.now() - 48 * 3600 * 1000).toISOString(),
    },
    {
      round: 1,
      underwriter: "balanced-vault.near",
      persona: "balanced",
      bid: true,
      premiumBps: 320,
      rationale: "Solid historical track record. Higher portfolio limit concentration requires a moderate premium buffer of 320 bps.",
      at: new Date(Date.now() - 48 * 3600 * 1000).toISOString(),
    },
    {
      round: 2,
      underwriter: "balanced-vault.near",
      persona: "balanced",
      bid: true,
      premiumBps: 450,
      rationale: "Agent quill-processor incurred 1 previous claim on tax discrepancy. Required bond share increased to 26%. Fair pricing at 450 bps.",
      at: new Date(Date.now() - 72 * 3600 * 1000).toISOString(),
    },
  ],
};

export const MOCK_ECONOMICS: Economics = {
  pool: {
    capital: nearToYocto(500),
    premiums_earned: nearToYocto(18.4),
    losses_paid: nearToYocto(3.2),
    prices_retained: nearToYocto(3.9),
    net: nearToYocto(19.1),
  },
  agents: [
    {
      agent: "northwind-extractor.near",
      jobs: 42,
      claims_upheld: 0,
      volume: nearToYocto(84),
      premiums_collected: nearToYocto(6.5),
      expected_loss: nearToYocto(0.0),
      realised_loss: nearToYocto(0.0),
      margin: nearToYocto(6.5),
      premium_floor_bps: 172,
    },
    {
      agent: "quill-processor.near",
      jobs: 28,
      claims_upheld: 1,
      volume: nearToYocto(56),
      premiums_collected: nearToYocto(5.2),
      expected_loss: nearToYocto(0.18),
      realised_loss: nearToYocto(2.0),
      margin: nearToYocto(3.2),
      premium_floor_bps: 283,
    },
    {
      agent: "tidewater-auditor.near",
      jobs: 85,
      claims_upheld: 0,
      volume: nearToYocto(170),
      premiums_collected: nearToYocto(4.8),
      expected_loss: nearToYocto(0.0),
      realised_loss: nearToYocto(0.0),
      margin: nearToYocto(4.8),
      premium_floor_bps: 155,
    },
    {
      agent: "amberline-worker.near",
      jobs: 15,
      claims_upheld: 2,
      volume: nearToYocto(30),
      premiums_collected: nearToYocto(1.9),
      expected_loss: nearToYocto(0.35),
      realised_loss: nearToYocto(1.2),
      margin: nearToYocto(0.7),
      premium_floor_bps: 450,
    },
  ],
};

const DEFAULT_RECEIPT: PublishedReceipt = {
  engagement_id: 1,
  receipt: {
    version: 1,
    engagement_id: 1,
    model_id: "Qwen/Qwen3.8-27B",
    request_hash: "f5355fe70ef66fe9d1f1be70ccb3fc4e9ba347606e1915f411f626c18017ec3d",
    response_hash: "2dff66ae5c13402b333c35873a50be22e59ca0b277a86a68fba7df2092d9008a",
    signature: "0xdc3d8c70c209d331d33ba9bf232adb797cf52182095c1e7055747be38a1e9e642ebd8b225ad10e460b28fb5c570fe3ce2a0735a999789f0c27abf83be345ee9e1b",
    signing_address: "0x835ab53d20294ef795906dff21ae4c045336aa26",
    signature_kind: "provider_tee",
    attestation: {
      nonce: "55ce188d25527a54d8db5c771ce4fca4f2798105f715550a5b4e8ae040477be2",
      report_hash: "27581b0330cae79dfb57cf26e7ff78ffb35acb4f3d602c7f35ed81f6ea676630",
      verified_at: "2026-11-08T17:25:37.374Z",
      verifier: "dev-fixture (replayed TEE verdict)",
    },
    artifacts: {
      request_uri: "artifact://sha256/f5355fe70ef66fe9d1f1be70ccb3fc4e9ba347606e1915f411f626c18017ec3d",
      response_uri: "artifact://sha256/2dff66ae5c13402b333c35873a50be22e59ca0b277a86a68fba7df2092d9008a",
    },
  },
  receipt_hash: "93f412ba7d4c2198083bf2681a95a8bf1da94c50119f8606869152288339cc61",
  report_uri: "artifact://sha256/27581b0330cae79dfb57cf26e7ff78ffb35acb4f3d602c7f35ed81f6ea676630",
  output_uri: "artifact://sha256/2dff66ae5c13402b333c35873a50be22e59ca0b277a86a68fba7df2092d9008a",
};

export const MOCK_ENGAGEMENTS: EngagementDetail[] = [
  {
    id: 1,
    engagement: {
      client: "brightwater.near",
      agent: "northwind-extractor.near",
      terms_hash: "3b29c98da5fbc2a4ef035178619bcad07f2dfd864eef8ad3d0e2e28a50992ec4",
      price: nearToYocto(2),
      liability_cap: nearToYocto(6),
      premium: nearToYocto(0.15),
      bond_locked: nearToYocto(1.2),
      vault_locked: nearToYocto(4.8),
      vault: "cautious-vault.near",
      created_at: hoursAgoNs(5),
      deadline: inHoursNs(19),
      receipt: {
        model_id: "Qwen/Qwen3.8-27B",
        request_hash: "f5355fe70ef66fe9d1f1be70ccb3fc4e9ba347606e1915f411f626c18017ec3d",
        response_hash: "2dff66ae5c13402b333c35873a50be22e59ca0b277a86a68fba7df2092d9008a",
        signer: "835ab53d20294ef795906dff21ae4c045336aa26",
        signature_kind: "ProviderTee",
        submitted_at: hoursAgoNs(4.9),
      },
      delivered_at: hoursAgoNs(4.9),
      claim_id: null,
      status: "Completed",
    },
    published_receipt: DEFAULT_RECEIPT,
    output: JSON.stringify({
      invoice_number: "NWR-2026-0412",
      issue_date: "2026-10-03",
      due_date: "2026-11-02",
      vendor_name: "Northwind Robotics Ltd.",
      customer_name: "Brightwater Logistics Co.",
      po_number: "PO-77310",
      currency: "USD",
      subtotal: "1125.00",
      tax: "90.00",
      total: "1215.00",
    }, null, 2),
    document: {
      name: "01-northwind-invoice.md",
      text: "# Invoice NWR-2026-0412\nVendor: Northwind Robotics Ltd.\nCustomer: Brightwater Logistics Co.\nSubtotal: $1125.00\nTax: $90.00\nTotal: $1215.00",
      truth: MOCK_DOCUMENTS[0].truth,
    },
    timeline: [
      {
        id: 101,
        event: "EngagementOpened",
        block_height: 104100,
        block_time: new Date(Date.now() - 5 * 3600 * 1000).toISOString(),
        tx_hash: "Gv6oYp9fM5sU4vN3Z8q2T7wK1rE9xL4cD8mA2jH6tF1s",
        receipt_id: "rec_101",
        data: { engagement_id: 1, client: "brightwater.near", agent: "northwind-extractor.near", price: nearToYocto(2) },
      },
      {
        id: 102,
        event: "ReceiptPublished",
        block_height: 104120,
        block_time: new Date(Date.now() - 4.9 * 3600 * 1000).toISOString(),
        tx_hash: "3kF8wR2tM9sU4vN3Z8q2T7wK1rE9xL4cD8mA2jH6tF2p",
        receipt_id: "rec_102",
        data: { engagement_id: 1, signer: "0x835ab53d20294ef795906dff21ae4c045336aa26" },
      },
      {
        id: 103,
        event: "PriceReleased",
        block_height: 104140,
        block_time: new Date(Date.now() - 4.8 * 3600 * 1000).toISOString(),
        tx_hash: "8rE9xL4cD8mA2jH6tF1sGv6oYp9fM5sU4vN3Z8q2T7wK",
        receipt_id: "rec_103",
        data: { engagement_id: 1, agent: "northwind-extractor.near", amount: nearToYocto(2) },
      },
    ],
  },
  {
    id: 2,
    engagement: {
      client: "marigold.near",
      agent: "quill-processor.near",
      terms_hash: "9e1c7f920da8a1bb045bc90064fa1351296cc7a7f4740e5ecf91bf6e21689ea5",
      price: nearToYocto(2),
      liability_cap: nearToYocto(6),
      premium: nearToYocto(0.27),
      bond_locked: nearToYocto(1.56),
      vault_locked: nearToYocto(4.44),
      vault: "balanced-vault.near",
      created_at: hoursAgoNs(12),
      deadline: inHoursNs(12),
      receipt: {
        model_id: "Qwen/Qwen3.8-27B",
        request_hash: "ae48ce585cdf105965d24544a3343c7f6576ec3a8bd94e68bc46639889dd485c",
        response_hash: "121eca042c55e088910fa079a3af9df862b98708902db07ef5d2bae92379c969",
        signer: "835ab53d20294ef795906dff21ae4c045336aa26",
        signature_kind: "ProviderTee",
        submitted_at: hoursAgoNs(11.9),
      },
      delivered_at: hoursAgoNs(11.9),
      claim_id: 1,
      status: "Slashed",
    },
    published_receipt: {
      ...DEFAULT_RECEIPT,
      engagement_id: 2,
      receipt: {
        ...DEFAULT_RECEIPT.receipt,
        engagement_id: 2,
        request_hash: "ae48ce585cdf105965d24544a3343c7f6576ec3a8bd94e68bc46639889dd485c",
        response_hash: "121eca042c55e088910fa079a3af9df862b98708902db07ef5d2bae92379c969",
      },
    },
    output: JSON.stringify({
      invoice_number: "QF/8841",
      issue_date: "2026-09-15",
      due_date: "2026-10-15",
      vendor_name: "Quillfeather Stationery Co-op",
      customer_name: "Marigold School Trust",
      po_number: null,
      currency: "EUR",
      subtotal: "990.00", // Flipped!
      tax: "180.00",
      total: "1170.00",
    }, null, 2),
    document: {
      name: "02-quillfeather-invoice.md",
      text: "# Invoice QF/8841\nVendor: Quillfeather Stationery Co-op\nSubtotal: 900.00 EUR\nTax: 180.00 EUR\nTotal: 1080.00 EUR",
      truth: MOCK_DOCUMENTS[1].truth,
    },
    timeline: [
      {
        id: 110,
        event: "EngagementOpened",
        block_height: 103500,
        block_time: new Date(Date.now() - 12 * 3600 * 1000).toISOString(),
        tx_hash: "4cD8mA2jH6tF1sGv6oYp9fM5sU4vN3Z8q2T7wK1rE9xL",
        receipt_id: "rec_110",
        data: { engagement_id: 2, client: "marigold.near", agent: "quill-processor.near" },
      },
      {
        id: 111,
        event: "ClaimOpened",
        block_height: 103550,
        block_time: new Date(Date.now() - 11.5 * 3600 * 1000).toISOString(),
        tx_hash: "7wK1rE9xL4cD8mA2jH6tF1sGv6oYp9fM5sU4vN3Z8q2T",
        receipt_id: "rec_111",
        data: { claim_id: 1, engagement_id: 2, kind: "Quality" },
      },
      {
        id: 112,
        event: "slashed",
        block_height: 103590,
        block_time: new Date(Date.now() - 11 * 3600 * 1000).toISOString(),
        tx_hash: "2jH6tF1sGv6oYp9fM5sU4vN3Z8q2T7wK1rE9xL4cD8mA",
        receipt_id: "rec_112",
        data: {
          claim_id: 1,
          from_bond: nearToYocto(1.56),
          from_vault: nearToYocto(0.44),
          payout_to: "marigold.near",
        },
      },
    ],
  },
  {
    id: 3,
    engagement: {
      client: "juniper.near",
      agent: "tidewater-auditor.near",
      terms_hash: "28e7bb01ae2b4c19356fa0d1a4990c6fb022e3ea5954c274bbad8869ffca3428",
      price: nearToYocto(3),
      liability_cap: nearToYocto(9),
      premium: nearToYocto(0.162),
      bond_locked: nearToYocto(1.8),
      vault_locked: nearToYocto(7.2),
      vault: "aggressive-vault.near",
      created_at: hoursAgoNs(20),
      deadline: inHoursNs(4),
      receipt: null,
      delivered_at: null,
      claim_id: 2,
      status: "Expired",
    },
    published_receipt: null,
    output: null,
    document: {
      name: "03-tidewater-invoice.md",
      text: "# Invoice TW-INV-00977\nVendor: Tidewater Cloud Hosting\nTotal: 1100.00 GBP",
      truth: MOCK_DOCUMENTS[2].truth,
    },
    timeline: [
      {
        id: 120,
        event: "EngagementOpened",
        block_height: 102100,
        block_time: new Date(Date.now() - 20 * 3600 * 1000).toISOString(),
        tx_hash: "9fM5sU4vN3Z8q2T7wK1rE9xL4cD8mA2jH6tF1sGv6oYp",
        receipt_id: "rec_120",
        data: { engagement_id: 3, client: "juniper.near" },
      },
      {
        id: 121,
        event: "slashed",
        block_height: 102200,
        block_time: new Date(Date.now() - 19.5 * 3600 * 1000).toISOString(),
        tx_hash: "5sU4vN3Z8q2T7wK1rE9xL4cD8mA2jH6tF1sGv6oYp9fM",
        receipt_id: "rec_121",
        data: { claim_id: 2, from_bond: nearToYocto(1.8), from_vault: "0", reason: "no_delivery" },
      },
    ],
  },
];

export const MOCK_CLAIMS: ClaimDetail[] = [
  {
    id: 1,
    claim: {
      engagement_id: 2,
      claimant: "marigold.near",
      kind: "Quality",
      amount: nearToYocto(2),
      stake: nearToYocto(0.1),
      evidence_hash: "e58b1a2f4c6e8d0a2b4c6e8d0a2b4c6e8d0a2b4c6e8d0a2b4c6e8d0a2b4c6e8d",
      evidence_uri: "near://claims/1/evidence.json",
      destination: { asset_id: "near", recipient: "marigold.near" },
      status: "Finalized",
      filed_at: hoursAgoNs(11.5),
      verdict: {
        upheld: true,
        award: nearToYocto(2),
        reasons_hash: "f69c2b3a5d7f9e1b3c5e7a9b1d3f5a7b9c1d3f5e7b9c1d3f5a7b9c1d3f5a7b9c",
        verdict_receipt: null,
        arbiter: "arbiter.recourse.testnet",
        decided_at: hoursAgoNs(11.1),
        appeal_deadline: hoursAgoNs(10.1),
        appealed_by: null,
      },
    },
    engagement: MOCK_ENGAGEMENTS[1].engagement,
    payout: {
      claimant: "marigold.near",
      amount: nearToYocto(2),
      mode: "Direct",
      destination: { asset_id: "near", recipient: "marigold.near" },
      status: "Success",
      deposit_address: null,
      quote_id: null,
      quote_hash: null,
      final_status: "SUCCESS",
      dest_tx: "8mN2vP4sU6wX8zA1bC3dE5fG7hI9jK0lM2nO4pQ6rS8t",
      attempts: 1,
      sent_at: hoursAgoNs(11),
    },
    evidence: JSON.stringify({
      discrepancy: "Agent extracted subtotal as 990.00 EUR instead of 900.00 EUR, resulting in wrong total calculation.",
      quote_from_document: "Subtotal: 900.00 EUR",
    }),
    verdict: {
      ...DEFAULT_RECEIPT,
      engagement_id: 2,
      body: {
        upheld: true,
        findings: [
          { field: "subtotal", document_says: "900.00", agent_said: "990.00", correct: false, quote_from_document: "900.00 EUR" },
          { field: "total", document_says: "1080.00", agent_said: "1170.00", correct: false, quote_from_document: "1080.00 EUR" },
          { field: "tax", document_says: "180.00", agent_said: "180.00", correct: true },
          { field: "vendor_name", document_says: "Quillfeather Stationery Co-op", agent_said: "Quillfeather Stationery Co-op", correct: true },
        ],
        award_bps: 10000,
        reasons: "Clear extraction error on line item calculation verified against original markdown document.",
      },
    },
    timeline: [
      {
        id: 201,
        event: "ClaimOpened",
        block_height: 103550,
        block_time: new Date(Date.now() - 11.5 * 3600 * 1000).toISOString(),
        tx_hash: "7wK1rE9xL4cD8mA2jH6tF1sGv6oYp9fM5sU4vN3Z8q2T",
        receipt_id: "rec_201",
        data: { claim_id: 1, claimant: "marigold.near", kind: "Quality" },
      },
      {
        id: 202,
        event: "VerdictFiled",
        block_height: 103580,
        block_time: new Date(Date.now() - 11.1 * 3600 * 1000).toISOString(),
        tx_hash: "5sU4vN3Z8q2T7wK1rE9xL4cD8mA2jH6tF1sGv6oYp9fM",
        receipt_id: "rec_202",
        data: { claim_id: 1, upheld: true, award: nearToYocto(2) },
      },
      {
        id: 203,
        event: "slashed",
        block_height: 103590,
        block_time: new Date(Date.now() - 11 * 3600 * 1000).toISOString(),
        tx_hash: "2jH6tF1sGv6oYp9fM5sU4vN3Z8q2T7wK1rE9xL4cD8mA",
        receipt_id: "rec_203",
        data: {
          claim_id: 1,
          from_bond: nearToYocto(1.56),
          from_vault: nearToYocto(0.44),
          payout_to: "marigold.near",
        },
      },
      {
        id: 204,
        event: "PayoutExecuted",
        block_height: 103600,
        block_time: new Date(Date.now() - 10.9 * 3600 * 1000).toISOString(),
        tx_hash: "8mN2vP4sU6wX8zA1bC3dE5fG7hI9jK0lM2nO4pQ6rS8t",
        receipt_id: "rec_204",
        data: { claim_id: 1, recipient: "marigold.near", amount: nearToYocto(2) },
      },
    ],
  },
];

export const MOCK_SCENARIOS: RunScenario[] = [
  {
    id: "01-happy-path",
    name: "Happy path: clean extraction",
    expected: "price released to agent, bond untouched",
    state: "pass",
    actual: "extraction approved; 2 NEAR released",
    txs: 6,
    ms: 1180,
  },
  {
    id: "02-wrong-work-is-fined",
    name: "Wrong work: subtotal flipped",
    expected: "arbiter proves discrepancy; bond slashed, client paid",
    state: "pass",
    actual: "subtotal error upheld; 2 NEAR paid to client",
    txs: 9,
    ms: 1840,
  },
  {
    id: "03-no-delivery",
    name: "No delivery: agent goes silent",
    expected: "timeout expires; bond slashed, client refunded",
    state: "pass",
    actual: "deadline expired; client refunded in full",
    txs: 5,
    ms: 940,
  },
  {
    id: "04-bogus-claim",
    name: "Bogus claim: client files false report",
    expected: "arbiter proves agent was right; fee kept",
    state: "pass",
    actual: "claim rejected; stake forfeited to agent",
    txs: 7,
    ms: 1390,
  },
  {
    id: "05-appeal",
    name: "Appeal to council DAO",
    expected: "voting quorum reached; verdict overturned",
    state: "pass",
    actual: "appeal upheld; bond returned to agent",
    txs: 11,
    ms: 2280,
  },
  {
    id: "06-attacks",
    name: "Adversarial attacks blocked",
    expected: "replays, fake TEE signatures, front-running blocked",
    state: "pass",
    actual: "5 attacks detected and rejected by contract",
    txs: 14,
    ms: 2790,
  },
  {
    id: "07-underwriting-market",
    name: "Underwriting market: sealed bids",
    expected: "vaults compete on price; lowest premium wins",
    state: "pass",
    actual: "3 bids submitted; cautious vault won @ 250 bps",
    txs: 8,
    ms: 1590,
  },
];

export interface SimulatedState {
  sabotageMode: string;
  runStatus: RunStatus;
  engagements: EngagementDetail[];
  claims: ClaimDetail[];
}

export const simulatedState: SimulatedState = {
  sabotageMode: "none",
  runStatus: {
    cycle: 1,
    phase: "live",
    started_at: new Date(Date.now() - 1800 * 1000).toISOString(),
    finished_at: new Date(Date.now() - 1200 * 1000).toISOString(),
    reset_at: null,
    model_source: "fixture:genuine",
    scenarios: [...MOCK_SCENARIOS],
    passed: 7,
    total: 7,
    solvency_ok: true,
  },
  engagements: [...MOCK_ENGAGEMENTS],
  claims: [...MOCK_CLAIMS],
};

let runnerTimer: ReturnType<typeof setTimeout> | null = null;

export function triggerSimulatedRun(onProgress?: () => void) {
  if (runnerTimer) clearTimeout(runnerTimer);
  simulatedState.runStatus.cycle += 1;
  simulatedState.runStatus.phase = "starting";
  simulatedState.runStatus.started_at = new Date().toISOString();
  simulatedState.runStatus.finished_at = null;
  simulatedState.runStatus.passed = 0;
  simulatedState.runStatus.solvency_ok = null;
  simulatedState.runStatus.scenarios = MOCK_SCENARIOS.map((s) => ({
    ...s,
    state: "pending",
    actual: undefined,
  }));
  onProgress?.();

  let step = 0;
  function nextStep() {
    if (step === 0) {
      simulatedState.runStatus.phase = "seeding";
      simulatedState.runStatus.scenarios[0].state = "running";
      step += 1;
      runnerTimer = setTimeout(nextStep, 1000);
      onProgress?.();
      return;
    }
    const idx = step - 1;
    if (idx < simulatedState.runStatus.scenarios.length) {
      simulatedState.runStatus.scenarios[idx].state = "pass";
      simulatedState.runStatus.scenarios[idx].actual = MOCK_SCENARIOS[idx].actual;
      simulatedState.runStatus.passed += 1;

      if (idx + 1 < simulatedState.runStatus.scenarios.length) {
        simulatedState.runStatus.scenarios[idx + 1].state = "running";
        step += 1;
        runnerTimer = setTimeout(nextStep, 800);
      } else {
        simulatedState.runStatus.phase = "live";
        simulatedState.runStatus.finished_at = new Date().toISOString();
        simulatedState.runStatus.solvency_ok = true;
      }
      onProgress?.();
    }
  }
  runnerTimer = setTimeout(nextStep, 1200);
}
