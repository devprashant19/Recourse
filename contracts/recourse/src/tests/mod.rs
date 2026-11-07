//! Contract unit tests, one module per contract module.
//!
//! Spec: phases/phase-01-contract-core.md section 11.
//!
//! Every test drives the contract through `VMContextBuilder`, so each call sees
//! the predecessor, attached deposit and block timestamp it would see on-chain.
//! `require!` failures are asserted with `#[should_panic(expected = "...")]`,
//! which pins the exact error message a client would receive.

mod agents;
mod bonds;
mod claims;
mod common;
mod engagements;
mod events;
mod init;
mod lifecycle;
mod pool;
mod pricing;
mod roles;
mod slashing;
mod tee;
mod types;
mod views;
