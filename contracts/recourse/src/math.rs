//! Checked arithmetic for every money path.
//!
//! The release profile already sets `overflow-checks = true`, but a bare
//! overflow panic says nothing about which balance broke. These helpers fail
//! with a message naming the quantity, and make rounding direction explicit:
//! the contract always rounds in the direction that protects the party that
//! did not choose the number (the vault, the client, the agent's counterparty).

use near_sdk::env;

/// `a + b`, or panic naming `what`.
pub fn add(a: u128, b: u128, what: &str) -> u128 {
    a.checked_add(b)
        .unwrap_or_else(|| env::panic_str(&format!("overflow: {what}")))
}

/// `a - b`, or panic naming `what`. Underflow here always means an accounting
/// bug or an attempt to take more than exists, so it must never wrap.
pub fn sub(a: u128, b: u128, what: &str) -> u128 {
    a.checked_sub(b)
        .unwrap_or_else(|| env::panic_str(&format!("underflow: {what}")))
}

/// `floor(a * b / d)`. Panics on overflow of `a * b`; amounts this contract
/// handles are far below 2^100 and multipliers below 2^28.
pub fn mul_div_floor(a: u128, b: u128, d: u128) -> u128 {
    if d == 0 {
        env::panic_str("division by zero");
    }
    a.checked_mul(b)
        .map(|p| p / d)
        .unwrap_or_else(|| env::panic_str("overflow: mul_div"))
}

/// `ceil(a * b / d)`.
pub fn mul_div_ceil(a: u128, b: u128, d: u128) -> u128 {
    if d == 0 {
        env::panic_str("division by zero");
    }
    let p = a
        .checked_mul(b)
        .unwrap_or_else(|| env::panic_str("overflow: mul_div"));
    p / d + u128::from(!p.is_multiple_of(d))
}

/// `amount * bps / 10_000`, rounded down.
pub fn bps_floor(amount: u128, bps: u32) -> u128 {
    mul_div_floor(amount, u128::from(bps), u128::from(crate::types::BPS_DENOM))
}

/// `amount * bps / 10_000`, rounded up.
pub fn bps_ceil(amount: u128, bps: u32) -> u128 {
    mul_div_ceil(amount, u128::from(bps), u128::from(crate::types::BPS_DENOM))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounding_directions_differ_only_on_remainders() {
        assert_eq!(mul_div_floor(10, 1, 3), 3);
        assert_eq!(mul_div_ceil(10, 1, 3), 4);
        assert_eq!(mul_div_floor(9, 1, 3), 3);
        assert_eq!(mul_div_ceil(9, 1, 3), 3);
        assert_eq!(bps_ceil(1, 500), 1, "5% of 1 yocto rounds up to 1");
        assert_eq!(bps_floor(1, 500), 0);
    }

    #[test]
    #[should_panic(expected = "underflow: bond")]
    fn sub_names_the_quantity_on_underflow() {
        sub(1, 2, "bond");
    }

    #[test]
    #[should_panic(expected = "overflow: escrow")]
    fn add_names_the_quantity_on_overflow() {
        add(u128::MAX, 1, "escrow");
    }
}
