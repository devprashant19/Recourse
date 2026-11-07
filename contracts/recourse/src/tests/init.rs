//! Initialisation smoke tests: the harness itself works and `new()` stores
//! exactly the config it was given.

use super::common::*;

#[test]
fn new_stores_config_and_starts_unpaused() {
    let c = new_contract();
    let cfg = c.get_config();
    assert_eq!(cfg.min_bond.0, 5 * ONE_NEAR);
    assert_eq!(cfg.claim_stake_bps, 500);
    assert!(!c.is_paused());
}
